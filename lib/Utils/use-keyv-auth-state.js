import { Keyv, detectKeyvStorage } from 'keyv'
import { DEFAULT_PREKEY_RETENTION, DEFAULT_CLEANUP_THRESHOLD, CLEANUP_INTERVAL_MS, DEFAULT_COLLECTION_NAME } from '../Defaults/index.js'
import { bootstrapCreds, patchAppStateKey, ser, deser } from './auth-utils.js'
import { PROTOCOL_ADAPTERS } from '../WABinary/index.js'
import logger from './logger.js'

// ── Adapter resolution ────────────────────────────────────────────────────────

// Only these adapters accept a named collection/table — redis, valkey, etcd etc do not
const COLLECTION_KEY = { '@keyv/mongo': 'collection', '@keyv/postgres': 'table', '@keyv/mysql': 'table', '@keyv/sqlite': 'table' }

// Cached per conn::col::namespace — each session gets its own adapter instance so
// clear() never bleeds across sessions. Underlying drivers manage their own connection
// pools so multiple adapters on the same URI still share one real connection.
const _adapterCache = new Map()
export const clearAdapterCache = () => _adapterCache.clear()

const resolveAdapter = async (conn, col, namespace) => {
    const ck = `${conn}::${col ?? ''}::${namespace ?? ''}`
    if (_adapterCache.has(ck)) return _adapterCache.get(ck)
    let protocol
    try { protocol = new URL(conn).protocol } catch { throw new Error(`[Auth] Invalid connection string: "${conn}"`) }
    const pkg = PROTOCOL_ADAPTERS[protocol]
    if (!pkg) throw new Error(`[Auth] Unsupported protocol "${protocol}" — supported: ${Object.keys(PROTOCOL_ADAPTERS).map(p => p.replace(':', '')).join(', ')}`)
    let mod
    try { mod = await import(pkg) } catch (e) {
        if (e.code === 'ERR_MODULE_NOT_FOUND') throw new Error(`[Auth] "${pkg}" required — npm i ${pkg}`)
        throw e
    }
    const Adapter = mod.default ?? mod[Object.keys(mod)[0]]
    const optKey = COLLECTION_KEY[pkg]
    const adapter = col && optKey ? new Adapter({ url: conn, uri: conn, [optKey]: col }) : new Adapter(conn)
    adapter.setMaxListeners?.(0)
    if (namespace) adapter.namespace = namespace
    _adapterCache.set(ck, adapter)
    return adapter
}

const resolveStore = async (backend, col, namespace) => {
    if (backend == null) return null
    if (typeof backend === 'string') return resolveAdapter(backend, col, namespace)
    if (backend instanceof Keyv) return backend.opts?.store ?? backend.store ?? null
    const { compatible } = detectKeyvStorage(backend)
    if (!compatible) throw new Error('[Auth] backend must be a connection string, Keyv instance, or KeyvStoreAdapter')
    // scope namespace via prototype so we don't mutate the original store instance
    const scoped = Object.create(backend)
    if (namespace) scoped.namespace = namespace
    return scoped
}

const makeKeyv = (store, namespace) => {
    const keyv = store ? new Keyv({ store, namespace }) : new Keyv({ namespace })
    keyv.setMaxListeners?.(0)
    return keyv
}

// ── Multi-backend support ─────────────────────────────────────────────────────

// Multi-backend map: { 'creds': pgBackend, 'pre-key': mongoBackend, ... }
// Anything else (string, Keyv, raw store adapter) is treated as single backend
const isMultiBackend = backend =>
    backend !== null
    && typeof backend === 'object'
    && !Array.isArray(backend)
    && !(backend instanceof Keyv)
    && !detectKeyvStorage(backend).compatible

// Returns { get(type) → Keyv, all → Keyv[] }
// get(type) falls back to first entry if type not in map
// all is deduplicated — shared backends only clear once
const resolveBackendMap = async (backend, sessionId, collectionName) => {
    if (!isMultiBackend(backend)) {
        const store = await resolveStore(backend, collectionName, sessionId)
        const keyv = makeKeyv(store, sessionId)
        return { get: () => keyv, all: [keyv] }
    }
    const entries = Object.entries(backend)
    if (!entries.length) throw new Error('[Auth] backend map must have at least one entry')
    const resolved = new Map()
    for (const [, b] of entries) {
        if (!resolved.has(b)) {
            const store = await resolveStore(b, collectionName, sessionId)
            resolved.set(b, makeKeyv(store, sessionId))
        }
    }
    const typeMap = Object.fromEntries(entries.map(([type, b]) => [type, resolved.get(b)]))
    const defaultKeyv = resolved.get(entries[0][1])
    return { get: type => typeMap[type] ?? defaultKeyv, all: [...new Set(resolved.values())] }
}

// ── Keyv-backed auth state ────────────────────────────────────────────────────

export const useKeyvAuthState = async (sessionId, backend, opts = {}) => {
    const { preKeyRetention = DEFAULT_PREKEY_RETENTION, cleanupThreshold = DEFAULT_CLEANUP_THRESHOLD, collectionName = DEFAULT_COLLECTION_NAME } = opts
    const bmap = await resolveBackendMap(backend, sessionId, collectionName)
    const credsKeyv = bmap.get('creds')
    credsKeyv.on('error', err => logger.warn({ err: err?.message, sessionId }, '[Auth] store error'))

    const kn = (type, id) => `${type}-${id}`
    const credsKey = 'creds'
    let creds = bootstrapCreds(deser(await credsKeyv.get(credsKey)))
    let cleanupRunning = false, lastCleanupAt = 0, lastCleanedId = creds.nextPreKeyId

    const cleanOldPreKeys = async () => {
        if (cleanupRunning || Date.now() - lastCleanupAt < CLEANUP_INTERVAL_MS) return
        cleanupRunning = true
        try {
            const minId = creds.nextPreKeyId - preKeyRetention
            if (minId <= 0) return
            const ids = []
            for (let id = Math.max(0, lastCleanedId - preKeyRetention); id < minId; id++) ids.push(kn('pre-key', id))
            if (ids.length) await bmap.get('pre-key').deleteMany(ids)
            lastCleanupAt = Date.now(); lastCleanedId = creds.nextPreKeyId
        } catch (e) { logger.warn({ err: e.message, sessionId }, '[Auth] prekey cleanup failed') }
        finally { cleanupRunning = false }
    }
    cleanOldPreKeys().catch(() => { })

    const keys = {
        get: async (type, ids) => {
            if (!ids.length) return {}
            const keyv = bmap.get(type)
            const raws = await keyv.getMany(ids.map(id => kn(type, id)))
            return Object.fromEntries(ids.map((id, i) => [id, patchAppStateKey(type, deser(raws[i]))]))
        },
        set: async data => {
            // group by Keyv instance to batch writes per backend
            const byKeyv = new Map()
            for (const type in data) {
                const keyv = bmap.get(type)
                if (!byKeyv.has(keyv)) byKeyv.set(keyv, { sets: [], dels: [] })
                const bucket = byKeyv.get(keyv)
                for (const id in data[type]) {
                    const v = data[type][id], k = kn(type, id)
                    if (v != null) bucket.sets.push({ key: k, value: ser(v) })
                    else bucket.dels.push(k)
                }
            }
            await Promise.all([...byKeyv.entries()].map(([keyv, { sets, dels }]) =>
                Promise.all([sets.length ? keyv.setMany(sets) : null, dels.length ? keyv.deleteMany(dels) : null])
            ))
        }
    }

    const saveCreds = async () => {
        if (creds.nextPreKeyId - lastCleanedId >= cleanupThreshold) cleanOldPreKeys().catch(() => { })
        await credsKeyv.set(credsKey, ser(creds))
    }

    const clearSession = async () => {
        try { await Promise.all(bmap.all.map(keyv => keyv.clear())) }
        catch (e) { logger.warn({ err: e.message, sessionId }, '[Auth] clearSession failed') }
        bmap.all.forEach(keyv => keyv.removeAllListeners?.())
    }

    return { state: { creds, keys }, saveCreds, clearSession }
}

// Lightweight check — reads only the creds key without full state init
export const hasKeyvAuth = async (sessionId, backend, opts = {}) => {
    try {
        const b = isMultiBackend(backend) ? Object.values(backend)[0] : backend
        const bmap = await resolveBackendMap(b, sessionId, opts.collectionName ?? DEFAULT_COLLECTION_NAME)
        const parsed = deser(await bmap.get('creds').get('creds'))
        return !!(parsed?.noiseKey && parsed?.signedIdentityKey)
    } catch { return false }
}

export { Keyv }