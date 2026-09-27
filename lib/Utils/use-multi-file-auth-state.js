import { mkdir, readFile, rename, stat, unlink, writeFile, readdir } from 'fs/promises'
import { join } from 'path'
import { Keyv } from 'keyv'
import { proto } from '../../WAProto/index.js'
import { initAuthCreds } from './auth-utils.js'
import { BufferJSON } from './generics.js'
import { PROTOCOL_ADAPTERS } from '../WABinary/index.js'

const CURRENT_VERSION = 1
const DEFAULT_PREKEY_RETENTION = 150
const DEFAULT_CLEANUP_THRESHOLD = 50
const CLEANUP_INTERVAL_MS = 10 * 60 * 1000

const bootstrapCreds = (raw) => {
    const c = raw ?? initAuthCreds()
    if (!c.__version || c.__version < CURRENT_VERSION) c.__version = CURRENT_VERSION
    return c
}

const patchAppStateKey = (type, v) =>
    type === 'app-state-sync-key' && v ? proto.Message.AppStateSyncKeyData.fromObject(v) : v

// ── File-based ────────────────────────────────────────────────────────────────

export const useMultiFileAuthState = async (folder, options = {}) => {
    const { preKeyRetention = DEFAULT_PREKEY_RETENTION, cleanupThreshold = DEFAULT_CLEANUP_THRESHOLD, logger } = options

    const fixFileName = (file) => file?.replace(/\//g, '__')?.replace(/:/g, '-')
    const filePath = (file) => join(folder, fixFileName(file))
    const tmpPath = (file) => filePath(file) + '.tmp'

    const folderInfo = await stat(folder).catch(() => null)
    if (folderInfo) {
        if (!folderInfo.isDirectory()) throw new Error(`Path exists but is not a directory: ${folder}`)
    } else {
        await mkdir(folder, { recursive: true })
    }

    const writeData = async (data, file) => {
        const fp = filePath(file)
        const tp = tmpPath(file)
        const payload = JSON.stringify(data, BufferJSON.replacer)
        await writeFile(tp, payload)
        try {
            await rename(tp, fp)
        } catch {
            await writeFile(fp, payload)
            await unlink(tp).catch(() => { })
        }
    }

    const readData = async (file) => {
        const raw = await readFile(filePath(file), { encoding: 'utf-8' }).catch(() => null)
        if (!raw) return null
        try {
            const parsed = JSON.parse(raw, BufferJSON.reviver)
            if (parsed && typeof parsed === 'object' && '__checksum' in parsed && 'data' in parsed) return parsed.data
            return parsed
        } catch (err) {
            logger?.warn({ file, err: err.message }, 'failed to read auth file — reinitializing')
            await unlink(filePath(file)).catch(() => { })
            return null
        }
    }

    const removeData = (file) => unlink(filePath(file)).catch(() => { })

    let creds = bootstrapCreds(await readData('creds.json'))
    let cleanupRunning = false
    let lastCleanupAt = 0
    let lastCleanedPreKeyId = creds.nextPreKeyId

    const cleanOldPreKeys = async () => {
        const now = Date.now()
        if (cleanupRunning || now - lastCleanupAt < CLEANUP_INTERVAL_MS) return
        cleanupRunning = true
        try {
            const minId = creds.nextPreKeyId - preKeyRetention
            if (minId <= 0) return
            const targets = (await readdir(folder))
                .map(f => f.match(/^pre-key-(\d+)\.json(\.tmp)?$/))
                .filter(m => m && parseInt(m[1], 10) < minId)
                .map(m => join(folder, m[0]))
            if (!targets.length) return
            await Promise.all(targets.map(f => unlink(f).catch(() => { })))
            lastCleanupAt = Date.now()
            lastCleanedPreKeyId = creds.nextPreKeyId
        } catch (err) {
            logger?.warn({ err }, 'prekey cleanup failed')
        } finally {
            cleanupRunning = false
        }
    }

    cleanOldPreKeys().catch(() => { })

    const getStats = async () => {
        const files = await readdir(folder).catch(() => [])
        const preKeyFiles = files.filter(f => /^pre-key-\d+\.json$/.test(f))
        return {
            totalFiles: files.length,
            preKeyCount: preKeyFiles.length,
            nextPreKeyId: creds.nextPreKeyId,
            lastCleanupAt: lastCleanupAt ? new Date(lastCleanupAt).toISOString() : null,
        }
    }

    return {
        state: {
            creds,
            keys: {
                get: async (type, ids) => {
                    const data = {}
                    await Promise.all(ids.map(async id => {
                        let value = await readData(`${type}-${id}.json`)
                        if (type === 'app-state-sync-key' && value) value = proto.Message.AppStateSyncKeyData.fromObject(value)
                        data[id] = value
                    }))
                    return data
                },
                set: async (data) => {
                    const tasks = []
                    for (const category in data) {
                        for (const id in data[category]) {
                            const value = data[category][id]
                            tasks.push(value ? writeData(value, `${category}-${id}.json`) : removeData(`${category}-${id}.json`))
                        }
                    }
                    await Promise.all(tasks)
                },
            },
        },
        saveCreds: async () => {
            if (creds.nextPreKeyId - lastCleanedPreKeyId >= cleanupThreshold) cleanOldPreKeys().catch(() => { })
            return writeData(creds, 'creds.json')
        },
        getStats,
    }
}

// ── Keyv-backed ───────────────────────────────────────────────────────────────

const ser = (v) => v == null ? null : JSON.parse(JSON.stringify(v, BufferJSON.replacer))

const unwrapNestedValue = (obj) => {
    let cur = obj
    while (cur && typeof cur === 'object' && !Array.isArray(cur) && Object.keys(cur).length === 1 && 'value' in cur) cur = cur.value
    return cur
}

const deser = (raw, logger) => {
    if (raw == null) return null
    let parsed
    if (typeof raw === 'string') {
        try { parsed = JSON.parse(raw) } catch (err) {
            logger?.warn?.({ err: err.message }, '[Auth] failed to parse stored value — treating as missing')
            return null
        }
    } else {
        parsed = raw
    }
    parsed = unwrapNestedValue(parsed)
    if (parsed == null) return null
    if (typeof parsed === 'object' && '__checksum' in parsed && 'data' in parsed) parsed = parsed.data
    return JSON.parse(JSON.stringify(parsed), BufferJSON.reviver)
}

const COLLECTION_OPTION_KEY = {
    '@keyv/mongo': 'collection',
    '@keyv/postgres': 'table',
    '@keyv/mysql': 'table',
    '@keyv/sqlite': 'table',
}

const _adapterCache = new Map()
export const clearAdapterCache = () => _adapterCache.clear()

const resolveAdapter = async (connectionString, collectionName) => {
    const cacheKey = collectionName ? `${connectionString}::${collectionName}` : connectionString
    if (_adapterCache.has(cacheKey)) return _adapterCache.get(cacheKey)

    let protocol
    try { protocol = new URL(connectionString).protocol } catch { throw new Error(`[Auth] Invalid connection string: "${connectionString}"`) }

    const pkg = PROTOCOL_ADAPTERS[protocol]
    if (!pkg) throw new Error(`[Auth] Unsupported protocol "${protocol}" — supported: redis, mongodb, postgresql, mysql, sqlite, etcd, memcache. Pass a pre-built KeyvStoreAdapter instance for anything else.`)

    let mod
    try { mod = await import(pkg) } catch (e) {
        if (e.code === 'ERR_MODULE_NOT_FOUND') throw new Error(`[Auth] "${pkg}" is required for this backend — install it: npm i ${pkg}`)
        throw e
    }

    const Adapter = mod.default ?? mod[Object.keys(mod)[0]]
    const optionKey = COLLECTION_OPTION_KEY[pkg]
    const adapter = (collectionName && optionKey)
        ? new Adapter({ url: connectionString, uri: connectionString, [optionKey]: collectionName })
        : new Adapter(connectionString)
    adapter.setMaxListeners?.(0)
    _adapterCache.set(cacheKey, adapter)
    return adapter
}

const isAdapterLike = (v) =>
    v != null &&
    typeof v === 'object' &&
    typeof v.get === 'function' &&
    typeof v.set === 'function' &&
    typeof v.delete === 'function' &&
    typeof v.clear === 'function'

const resolveStore = async (backend, collectionName) => {
    if (backend == null) return null
    if (typeof backend === 'string') return resolveAdapter(backend, collectionName)
    if (backend instanceof Keyv) return backend.opts?.store ?? backend.store ?? null
    if (isAdapterLike(backend)) return backend
    throw new Error('[Auth] backend must be a connection string, Keyv instance, or KeyvStoreAdapter')
}

export const useKeyvAuthState = async (sessionId, backend, opts = {}) => {
    const { preKeyRetention = DEFAULT_PREKEY_RETENTION, cleanupThreshold = DEFAULT_CLEANUP_THRESHOLD, logger, collectionName } = opts

    const store = await resolveStore(backend, collectionName)
    const keyv = store ? new Keyv({ store, namespace: sessionId }) : new Keyv({ namespace: sessionId })
    keyv.on('error', (err) => logger?.warn?.({ err: err?.message }, '[Auth] store error'))

    const keyName = (type, id) => `${type}-${id}`

    let creds = bootstrapCreds(deser(await keyv.get('creds'), logger))
    let cleanupRunning = false
    let lastCleanupAt = 0
    let lastCleanedPreKeyId = creds.nextPreKeyId

    const cleanOldPreKeys = async () => {
        const now = Date.now()
        if (cleanupRunning || now - lastCleanupAt < CLEANUP_INTERVAL_MS) return
        cleanupRunning = true
        try {
            const minId = creds.nextPreKeyId - preKeyRetention
            if (minId <= 0) return
            const ids = []
            for (let id = Math.max(0, lastCleanedPreKeyId - preKeyRetention); id < minId; id++) ids.push(keyName('pre-key', id))
            if (!ids.length) return
            await Promise.all(ids.map(k => keyv.delete(k).catch(() => { })))
            lastCleanupAt = Date.now()
            lastCleanedPreKeyId = creds.nextPreKeyId
        } catch (e) {
            logger?.warn?.({ err: e.message }, '[Auth] prekey cleanup failed')
        } finally {
            cleanupRunning = false
        }
    }

    cleanOldPreKeys().catch(() => { })

    const keys = {
        get: async (type, ids) => {
            const data = {}
            if (!ids.length) return data
            const rawKeys = ids.map(id => keyName(type, id))
            const rawValues = await keyv.getMany(rawKeys)
            const rewrites = []
            ids.forEach((id, i) => {
                data[id] = patchAppStateKey(type, deser(rawValues[i], logger))
            })
            if (rewrites.length) await Promise.all(rewrites).catch(() => { })
            return data
        },
        set: async (data) => {
            const setEntries = []
            const delKeys = []
            for (const type in data) {
                for (const id in data[type]) {
                    const value = data[type][id]
                    const key = keyName(type, id)
                    if (value != null) setEntries.push({ key, value: ser(value) })
                    else delKeys.push(key)
                }
            }
            await Promise.all([
                setEntries.length ? keyv.setMany(setEntries) : null,
                delKeys.length ? keyv.deleteMany(delKeys) : null,
            ])
        },
    }

    const saveCreds = async () => {
        if (creds.nextPreKeyId - lastCleanedPreKeyId >= cleanupThreshold) cleanOldPreKeys().catch(() => { })
        await keyv.set('creds', ser(creds))
    }

    const clearSession = async () => {
        const s = keyv.opts?.store ?? keyv.store
        if (s && typeof s.deleteMany === 'function' && typeof s.iterator === 'function') {
            const toDelete = []
            for await (const [key] of s.iterator(sessionId)) toDelete.push(key)
            if (toDelete.length) await s.deleteMany(toDelete)
        } else {
            await keyv.clear()
        }
        keyv.removeAllListeners?.()
    }

    return { state: { creds, keys }, saveCreds, clearSession }
}

export { Keyv }