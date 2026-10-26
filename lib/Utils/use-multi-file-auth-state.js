import { mkdir, readFile, rename, stat, unlink, writeFile, readdir } from 'fs/promises'
import { join } from 'path'
import { Keyv, detectKeyvStorage } from 'keyv'
import { proto } from '../../WAProto/index.js'
import { initAuthCreds } from './auth-utils.js'
import { BufferJSON } from './generics.js'
import { PROTOCOL_ADAPTERS } from '../WABinary/index.js'
import logger from './logger.js'

const DEFAULT_PREKEY_RETENTION = 150
const DEFAULT_CLEANUP_THRESHOLD = 50
const CLEANUP_INTERVAL_MS = 10 * 60 * 1000
const DEFAULT_COLLECTION_NAME = 'zervonex'

// ── Helpers ───────────────────────────────────────────────────────────────────

const bootstrapCreds = raw => raw ?? initAuthCreds()
const patchAppStateKey = (type, v) => type === 'app-state-sync-key' && v ? proto.Message.AppStateSyncKeyData.fromObject(v) : v
const ser = v => v == null ? null : JSON.parse(JSON.stringify(v, BufferJSON.replacer))
const deser = raw => {
    if (raw == null) return null
    let p = typeof raw === 'string'
        ? (() => { try { return JSON.parse(raw) } catch { return raw } })()  // ← return raw string on parse fail, don't warn
        : raw
    // some adapters double-wrap in { value: { value: ... } } — unwrap up to 3 levels
    let depth = 0
    while (depth++ < 3 && p && typeof p === 'object' && !Array.isArray(p) && Object.keys(p).length === 1 && 'value' in p) p = p.value
    if (p == null) return null
    if (typeof p === 'object' && '__checksum' in p && 'data' in p) p = p.data
    return JSON.parse(JSON.stringify(p), BufferJSON.reviver)
}

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

// ── File-based auth state ─────────────────────────────────────────────────────

export const useMultiFileAuthState = async (folder, opts = {}) => {
    const { preKeyRetention = DEFAULT_PREKEY_RETENTION, cleanupThreshold = DEFAULT_CLEANUP_THRESHOLD } = opts
    const fix = f => f?.replace(/\//g, '__')?.replace(/:/g, '-')
    const fp = f => join(folder, fix(f))

    const info = await stat(folder).catch(() => null)
    if (info) { if (!info.isDirectory()) throw new Error(`Not a directory: ${folder}`) }
    else await mkdir(folder, { recursive: true })

    const write = async (data, file) => {
        const [p, t, payload] = [fp(file), fp(file) + '.tmp', JSON.stringify(data, BufferJSON.replacer)]
        await writeFile(t, payload)
        try { await rename(t, p) } catch { await writeFile(p, payload); await unlink(t).catch(() => { }) }
    }
    const read = async file => {
        const raw = await readFile(fp(file), 'utf-8').catch(() => null)
        if (!raw) return null
        try {
            const p = JSON.parse(raw, BufferJSON.reviver)
            return p && typeof p === 'object' && '__checksum' in p && 'data' in p ? p.data : p
        } catch (e) {
            logger.warn({ err: e.message, file }, 'auth file corrupt — reinitializing')
            await unlink(fp(file)).catch(() => { })
            return null
        }
    }
    const remove = f => unlink(fp(f)).catch(() => { })

    let creds = bootstrapCreds(await read('creds.json'))
    let cleanupPromise = null, lastCleanupAt = 0, lastCleanedId = creds.nextPreKeyId

    const cleanOldPreKeys = async () => {
        if (cleanupPromise || Date.now() - lastCleanupAt < CLEANUP_INTERVAL_MS) return
        cleanupPromise = (async () => {
            try {
                const minId = creds.nextPreKeyId - preKeyRetention
                if (minId <= 0) return
                const targets = (await readdir(folder))
                    .map(f => f.match(/^pre-key-(\d+)\.json(\.tmp)?$/))
                    .filter(m => m && parseInt(m[1], 10) < minId)
                    .map(m => join(folder, m[0]))
                if (targets.length) await Promise.all(targets.map(f => unlink(f).catch(() => { })))
                lastCleanupAt = Date.now(); lastCleanedId = creds.nextPreKeyId
            } catch (e) { logger.warn({ err: e.message }, 'prekey cleanup failed') }
            finally { cleanupPromise = null }
        })()
        await cleanupPromise
    }
    cleanOldPreKeys().catch(() => { })

    return {
        state: {
            creds,
            keys: {
                get: async (type, ids) => {
                    const data = {}
                    await Promise.all(ids.map(async id => { const v = await read(`${type}-${id}.json`); data[id] = patchAppStateKey(type, v) }))
                    return data
                },
                set: async data => {
                    const tasks = []
                    for (const cat in data)
                        for (const id in data[cat]) { const v = data[cat][id]; tasks.push(v ? write(v, `${cat}-${id}.json`) : remove(`${cat}-${id}.json`)) }
                    await Promise.all(tasks)
                }
            }
        },
        saveCreds: async () => {
            if (creds.nextPreKeyId - lastCleanedId >= cleanupThreshold) cleanOldPreKeys().catch(() => { })
            return write(creds, 'creds.json')
        },
        getStats: async () => {
            const files = await readdir(folder).catch(() => [])
            return { totalFiles: files.length, preKeyCount: files.filter(f => /^pre-key-\d+\.json$/.test(f)).length, nextPreKeyId: creds.nextPreKeyId, lastCleanupAt: lastCleanupAt ? new Date(lastCleanupAt).toISOString() : null }
        }
    }
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