import { mkdir, readFile, rename, stat, unlink, writeFile, readdir } from 'fs/promises'
import { join } from 'path'
import { Keyv } from 'keyv'
import { proto } from '../../WAProto/index.js'
import { initAuthCreds } from './auth-utils.js'
import { BufferJSON } from './generics.js'
import { PROTOCOL_ADAPTERS } from '../WABinary/index.js'
import logger from './logger.js'

const DEFAULT_PREKEY_RETENTION = 150
const DEFAULT_CLEANUP_THRESHOLD = 50
const CLEANUP_INTERVAL_MS = 10 * 60 * 1000

// ── Shared helpers ────────────────────────────────────────────────────────────

const bootstrapCreds = raw => raw ?? initAuthCreds()

const patchAppStateKey = (type, v) =>
    type === 'app-state-sync-key' && v ? proto.Message.AppStateSyncKeyData.fromObject(v) : v

const ser = v => v == null ? null : JSON.parse(JSON.stringify(v, BufferJSON.replacer))

const deser = raw => {
    if (raw == null) return null
    let p = typeof raw === 'string'
        ? (() => { try { return JSON.parse(raw) } catch (e) { logger.warn({ err: e.message }, '[Auth] failed to parse stored value — treating as missing'); return null } })()
        : raw
    // unwrap adapter double-wrapping e.g. { value: { value: actual } }
    while (p && typeof p === 'object' && !Array.isArray(p) && Object.keys(p).length === 1 && 'value' in p) p = p.value
    if (p == null) return null
    if (typeof p === 'object' && '__checksum' in p && 'data' in p) p = p.data
    return JSON.parse(JSON.stringify(p), BufferJSON.reviver)
}

// ── Adapter resolution ────────────────────────────────────────────────────────

const COLLECTION_KEY = { '@keyv/mongo': 'collection', '@keyv/postgres': 'table', '@keyv/mysql': 'table', '@keyv/sqlite': 'table' }
const _adapterCache = new Map()
export const clearAdapterCache = () => _adapterCache.clear()

const resolveAdapter = async (conn, col) => {
    const ck = col ? `${conn}::${col}` : conn
    if (_adapterCache.has(ck)) return _adapterCache.get(ck)
    let protocol
    try { protocol = new URL(conn).protocol } catch { throw new Error(`[Auth] Invalid connection string: "${conn}"`) }
    const pkg = PROTOCOL_ADAPTERS[protocol]
    if (!pkg) throw new Error(`[Auth] Unsupported protocol "${protocol}" — supported: redis, mongodb, postgresql, mysql, sqlite`)
    let mod
    try { mod = await import(pkg) } catch (e) {
        if (e.code === 'ERR_MODULE_NOT_FOUND') throw new Error(`[Auth] "${pkg}" required — npm i ${pkg}`)
        throw e
    }
    const Adapter = mod.default ?? mod[Object.keys(mod)[0]]
    const optKey = COLLECTION_KEY[pkg]
    const adapter = col && optKey ? new Adapter({ url: conn, uri: conn, [optKey]: col }) : new Adapter(conn)
    adapter.setMaxListeners?.(0)
    _adapterCache.set(ck, adapter)
    return adapter
}

const resolveStore = async (backend, col) => {
    if (backend == null) return null
    if (typeof backend === 'string') return resolveAdapter(backend, col)
    if (backend instanceof Keyv) return backend.opts?.store ?? backend.store ?? null
    if (backend != null && typeof backend === 'object' && ['get', 'set', 'delete', 'clear'].every(m => typeof backend[m] === 'function')) return backend
    throw new Error('[Auth] backend must be a connection string, Keyv instance, or KeyvStoreAdapter')
}

// ── File-based auth state ─────────────────────────────────────────────────────

export const useMultiFileAuthState = async (folder, opts = {}) => {
    const { preKeyRetention = DEFAULT_PREKEY_RETENTION, cleanupThreshold = DEFAULT_CLEANUP_THRESHOLD } = opts
    const fix = f => f?.replace(/\//g, '__')?.replace(/:/g, '-')
    const fp = f => join(folder, fix(f))

    const info = await stat(folder).catch(() => null)
    if (info) { if (!info.isDirectory()) throw new Error(`Not a directory: ${folder}`) }
    else await mkdir(folder, { recursive: true })

    // atomic write: tmp → rename, fallback to direct write
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
    let cleanupRunning = false, lastCleanupAt = 0, lastCleanedId = creds.nextPreKeyId

    const cleanOldPreKeys = async () => {
        if (cleanupRunning || Date.now() - lastCleanupAt < CLEANUP_INTERVAL_MS) return
        cleanupRunning = true
        try {
            const minId = creds.nextPreKeyId - preKeyRetention
            if (minId <= 0) return
            const targets = (await readdir(folder))
                .map(f => f.match(/^pre-key-(\d+)\.json(\.tmp)?$/))
                .filter(m => m && parseInt(m[1], 10) < minId)
                .map(m => join(folder, m[0]))
            if (targets.length) await Promise.all(targets.map(f => unlink(f).catch(() => { })))
            lastCleanupAt = Date.now(); lastCleanedId = creds.nextPreKeyId
        } catch (e) {
            logger.warn({ err: e.message }, 'prekey cleanup failed')
        } finally { cleanupRunning = false }
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
    const { preKeyRetention = DEFAULT_PREKEY_RETENTION, cleanupThreshold = DEFAULT_CLEANUP_THRESHOLD, collectionName } = opts

    const store = await resolveStore(backend, collectionName)
    const keyv = store ? new Keyv({ store }) : new Keyv()
    keyv.setMaxListeners?.(0)
    keyv.on('error', err => logger.warn({ err: err?.message, sessionId }, '[Auth] store error'))

    // all keys prefixed sessionId:: to isolate sessions on a shared store
    const kn = (type, id) => `${sessionId}::${type}-${id}`
    const credsKey = `${sessionId}::creds`

    let creds = bootstrapCreds(deser(await keyv.get(credsKey)))
    let cleanupRunning = false, lastCleanupAt = 0, lastCleanedId = creds.nextPreKeyId
    // tracks every key ever written — fallback clearSession uses this to wipe all types including JID-based IDs
    const _writtenKeys = new Set([credsKey])

    const cleanOldPreKeys = async () => {
        if (cleanupRunning || Date.now() - lastCleanupAt < CLEANUP_INTERVAL_MS) return
        cleanupRunning = true
        try {
            const minId = creds.nextPreKeyId - preKeyRetention
            if (minId <= 0) return
            const ids = []
            for (let id = Math.max(0, lastCleanedId - preKeyRetention); id < minId; id++) ids.push(kn('pre-key', id))
            if (ids.length) await Promise.all(ids.map(k => keyv.delete(k).catch(() => { })))
            lastCleanupAt = Date.now(); lastCleanedId = creds.nextPreKeyId
        } catch (e) {
            logger.warn({ err: e.message, sessionId }, '[Auth] prekey cleanup failed')
        } finally { cleanupRunning = false }
    }

    cleanOldPreKeys().catch(() => { })

    const keys = {
        get: async (type, ids) => {
            if (!ids.length) return {}
            const raws = await keyv.getMany(ids.map(id => kn(type, id)))
            return Object.fromEntries(ids.map((id, i) => [id, patchAppStateKey(type, deser(raws[i]))]))
        },
        set: async data => {
            const sets = [], dels = []
            for (const type in data)
                for (const id in data[type]) {
                    const v = data[type][id], k = kn(type, id)
                    if (v != null) { sets.push({ key: k, value: ser(v) }); _writtenKeys.add(k) }
                    else { dels.push(k); _writtenKeys.delete(k) }
                }
            await Promise.all([
                sets.length ? keyv.setMany(sets) : null,
                dels.length ? keyv.deleteMany(dels) : null
            ])
        }
    }

    const saveCreds = async () => {
        if (creds.nextPreKeyId - lastCleanedId >= cleanupThreshold) cleanOldPreKeys().catch(() => { })
        _writtenKeys.add(credsKey)
        await keyv.set(credsKey, ser(creds))
    }

    const clearSession = async () => {
        const prefix = `${sessionId}::`
        let done = false
        if (store) {
            // Redis: KEYS pattern scan
            const rc = store.client
            if (rc && typeof rc.keys === 'function') {
                try { await store.set('__probe__', 1); const m = await rc.keys(`${prefix}*`); if (m.length) await rc.del(m); done = true } catch { }
            }
            // Mongo/Postgres/SQLite: iterator scan
            if (!done && typeof store.iterator === 'function') {
                try {
                    const targets = []
                    for await (const [k] of store.iterator(prefix)) if (k.startsWith(prefix)) targets.push(k)
                    if (targets.length) await store.deleteMany(targets)
                    done = true
                } catch { }
            }
        }
        if (!done) {
            // fallback (in-memory): delete every key ever written — covers all types + JID-based IDs
            await Promise.all([..._writtenKeys].map(k => keyv.delete(k).catch(() => { })))
            _writtenKeys.clear()
        }
        keyv.removeAllListeners?.()
    }

    return { state: { creds, keys }, saveCreds, clearSession }
}

// check if valid creds exist for a session without fully loading it
export const hasKeyvAuth = async (sessionId, backend, opts = {}) => {
    try {
        const store = await resolveStore(backend, opts.collectionName)
        const keyv = store ? new Keyv({ store }) : new Keyv()
        const parsed = deser(await keyv.get(`${sessionId}::creds`))
        return !!(parsed?.noiseKey && parsed?.signedIdentityKey)
    } catch { return false }
}

export { Keyv }