import { mkdir, readFile, rename, stat, unlink, writeFile, readdir } from 'fs/promises'
import { join } from 'path'
import { DEFAULT_PREKEY_RETENTION, DEFAULT_CLEANUP_THRESHOLD, CLEANUP_INTERVAL_MS } from '../Defaults/index.js'
import { bootstrapCreds, patchAppStateKey } from './auth-utils.js'
import { BufferJSON } from './generics.js'
import logger from './logger.js'

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