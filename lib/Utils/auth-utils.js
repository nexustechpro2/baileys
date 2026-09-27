import NodeCache from '@cacheable/node-cache'
import { AsyncLocalStorage } from 'async_hooks'
import { Mutex } from 'async-mutex'
import { randomBytes } from 'crypto'
import PQueue from 'p-queue'
import { v4 } from 'uuid'
import { DEFAULT_CACHE_TTLS } from '../Defaults/index.js'
import { Curve, signedKeyPair } from './crypto.js'
import { delay, generateRegistrationId } from './generics.js'
import { PreKeyManager } from './pre-key-manager.js'

export function makeCacheableSignalKeyStore(store, logger, _cache) {
    const cache = _cache || new NodeCache({ stdTTL: DEFAULT_CACHE_TTLS.SIGNAL_STORE, useClones: false, deleteOnExpire: true })
    const cacheMutex = new Mutex()
    const uid = (type, id) => `${type}.${id}`
    return {
        async get(type, ids) {
            return cacheMutex.runExclusive(async () => {
                const data = {}, missing = []
                for (const id of ids) { const item = await cache.get(uid(type, id)); if (typeof item !== 'undefined') data[id] = item; else missing.push(id) }
                if (missing.length) { logger?.trace({ items: missing.length }, 'loading from store'); const fetched = await store.get(type, missing); for (const id of missing) { if (fetched[id]) { data[id] = fetched[id]; cache.set(uid(type, id), fetched[id]) } } }
                return data
            })
        },
        async set(data) {
            return cacheMutex.runExclusive(async () => {
                let keys = 0
                for (const type in data) { for (const id in data[type]) { await cache.set(uid(type, id), data[type][id]); keys++ } }
                logger?.trace({ keys }, 'updated cache')
                await store.set(data)
            })
        },
        async clear() { await cache.flushAll(); await store.clear?.() }
    }
}

export const addTransactionCapability = (state, logger, { maxCommitRetries, delayBetweenTriesMs }) => {
    const txStorage = new AsyncLocalStorage()
    const keyQueues = new Map()
    const txMutexes = new Map()
    const preKeyManager = new PreKeyManager(state, logger)

    const getQueue = key => { if (!keyQueues.has(key)) keyQueues.set(key, new PQueue({ concurrency: 1 })); return keyQueues.get(key) }
    const getTxMutex = key => { if (!txMutexes.has(key)) txMutexes.set(key, new Mutex()); return txMutexes.get(key) }
    const isInTransaction = () => !!txStorage.getStore()

    const EXPECTED_ERRORS = ['InvalidPreKeyId', 'SessionNotFound', 'InvalidMessage', 'no sender key state', 'memory access out of bounds', 'old counter', 'DuplicatedMessage', 'BadMac', 'Connection Closed']
    const isExpectedError = msg => EXPECTED_ERRORS.some(e => msg.includes(e))

    async function commitWithRetry(mutations) {
        if (Object.keys(mutations).length === 0) { logger.trace('no mutations in transaction'); return }
        logger.trace('committing transaction')
        for (let attempt = 0; attempt < maxCommitRetries; attempt++) {
            try {
                await state.set(mutations)
                logger.trace({ mutationCount: Object.keys(mutations).length }, 'committed transaction')
                return
            } catch (error) {
                const msg = error?.message || (typeof error === 'string' ? error : '') || ''
                if (isExpectedError(msg)) { logger?.debug?.({ error: msg }, 'transaction skipped — expected decrypt error'); return }
                if (attempt < maxCommitRetries - 1) { await delay(delayBetweenTriesMs); continue }
                logger?.error?.({ error: msg || error }, 'transaction failed after retries')
                throw error
            }
        }
    }

    return {
        get: async (type, ids) => {
            const ctx = txStorage.getStore()
            if (!ctx) return state.get(type, ids)
            const cached = ctx.cache[type] || {}
            const missing = ids.filter(id => !(id in cached))
            if (missing.length) { ctx.dbQueries++; logger.trace({ type, count: missing.length }, 'fetching missing keys in transaction'); const fetched = await getTxMutex(type).runExclusive(() => state.get(type, missing)); ctx.cache[type] = ctx.cache[type] || {}; Object.assign(ctx.cache[type], fetched) }
            const result = {}
            for (const id of ids) { const value = ctx.cache[type]?.[id]; if (value !== undefined && value !== null) result[id] = value }
            return result
        },
        set: async (data) => {
            const ctx = txStorage.getStore()
            if (!ctx) {
                const types = Object.keys(data)
                for (const type of types) { if (type === 'pre-key') await preKeyManager.validateDeletions(data, type) }
                await Promise.all(types.map(type => getQueue(type).add(async () => state.set({ [type]: data[type] }))))
                return
            }
            logger.trace({ types: Object.keys(data) }, 'caching in transaction')
            for (const key in data) {
                ctx.cache[key] = ctx.cache[key] || {}
                ctx.mutations[key] = ctx.mutations[key] || {}
                if (key === 'pre-key') await preKeyManager.processOperations(data, key, ctx.cache, ctx.mutations, true)
                else { Object.assign(ctx.cache[key], data[key]); Object.assign(ctx.mutations[key], data[key]) }
            }
        },
        isInTransaction,
        transaction: async (work, key) => {
            const existing = txStorage.getStore()
            if (existing) { logger.trace('reusing existing transaction context'); return work() }
            return getTxMutex(key).runExclusive(async () => {
                const ctx = { cache: {}, mutations: {}, dbQueries: 0 }
                logger.trace('entering transaction')
                try {
                    const result = await txStorage.run(ctx, work)
                    await commitWithRetry(ctx.mutations)
                    logger.trace({ dbQueries: ctx.dbQueries }, 'transaction completed')
                    return result
                } catch (error) {
                    const msg = error?.message || (typeof error === 'string' ? error : '') || ''
                        ; (isExpectedError(msg) ? logger?.debug?.bind(logger) : logger?.error?.bind(logger))?.({ error: msg || error }, 'transaction failed, rolling back')
                    throw error
                }
            })
        }
    }
}

export const initAuthCreds = () => {
    const identityKey = Curve.generateKeyPair()
    return {
        noiseKey: Curve.generateKeyPair(),
        pairingEphemeralKeyPair: Curve.generateKeyPair(),
        signedIdentityKey: identityKey,
        signedPreKey: signedKeyPair(identityKey, 1),
        registrationId: generateRegistrationId(),
        advSecretKey: randomBytes(32).toString('base64'),
        processedHistoryMessages: [],
        nextPreKeyId: 1,
        firstUnuploadedPreKeyId: 1,
        accountSyncCounter: 0,
        accountSettings: { unarchiveChats: false },
        deviceId: Buffer.from(v4().replace(/-/g, ''), 'hex').toString('base64url'),
        phoneId: v4(),
        identityId: randomBytes(20),
        registered: false,
        backupToken: randomBytes(20),
        registration: {},
        pairingCode: undefined,
        lastPropHash: undefined,
        routingInfo: undefined,
        additionalData: undefined
    }
}