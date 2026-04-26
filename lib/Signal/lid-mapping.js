import { LRUCache } from 'lru-cache'
import { isHostedPnUser, isLidUser, isPnUser, jidDecode, jidNormalizedUser, WAJIDDomains } from '../WABinary/index.js'

export class LIDMappingStore {
    constructor(keys, logger, pnToLIDFunc) {
        this.mappingCache = new LRUCache({ ttl: 3 * 24 * 60 * 60 * 1000, ttlAutopurge: true, updateAgeOnGet: true })
        this.inflightLIDLookups = new Map()
        this.inflightPNLookups = new Map()
        this.keys = keys
        this.logger = logger
        this.pnToLIDFunc = pnToLIDFunc
    }

    async storeLIDPNMappings(pairs) {
        if (!pairs.length) return

        const validatedPairs = []
        for (const { lid, pn } of pairs) {
            if (!((isLidUser(lid) && isPnUser(pn)) || (isPnUser(lid) && isLidUser(pn)))) {
                this.logger.warn(`Invalid LID-PN mapping: ${lid}, ${pn}`)
                continue
            }
            const lidDecoded = jidDecode(lid)
            const pnDecoded = jidDecode(pn)
            if (!lidDecoded || !pnDecoded) continue // fixed: was `return`, skips only this pair
            validatedPairs.push({ pnUser: pnDecoded.user, lidUser: lidDecoded.user })
        }

        if (!validatedPairs.length) return

        // Batch check all cache misses in one DB call
        const cacheMissSet = new Set()
        const existingMappings = new Map()

        for (const { pnUser } of validatedPairs) {
            const cached = this.mappingCache.get(`pn:${pnUser}`)
            if (cached) existingMappings.set(pnUser, cached)
            else cacheMissSet.add(pnUser)
        }

        if (cacheMissSet.size > 0) {
            this.logger.trace(`Batch fetching ${cacheMissSet.size} LID mappings from database`)
            const stored = await this.keys.get('lid-mapping', [...cacheMissSet])
            for (const pnUser of cacheMissSet) {
                const lidUser = stored[pnUser]
                if (lidUser) {
                    existingMappings.set(pnUser, lidUser)
                    this.mappingCache.set(`pn:${pnUser}`, lidUser)
                    this.mappingCache.set(`lid:${lidUser}`, pnUser)
                }
            }
        }

        const pairMap = {}
        for (const { pnUser, lidUser } of validatedPairs) {
            if (existingMappings.get(pnUser) === lidUser) {
                this.logger.debug({ pnUser, lidUser }, 'LID mapping already exists, skipping')
                continue
            }
            pairMap[pnUser] = lidUser
        }

        if (!Object.keys(pairMap).length) return

        this.logger.trace({ pairMap }, `Storing ${Object.keys(pairMap).length} pn mappings`)

        // Single batched keys.set inside transaction
        const batchData = {}
        for (const [pnUser, lidUser] of Object.entries(pairMap)) {
            batchData[pnUser] = lidUser
            batchData[`${lidUser}_reverse`] = pnUser
        }

        await this.keys.transaction(async () => {
            await this.keys.set({ 'lid-mapping': batchData })
        }, 'lid-mapping')

        // Update cache only after successful DB write
        for (const [pnUser, lidUser] of Object.entries(pairMap)) {
            this.mappingCache.set(`pn:${pnUser}`, lidUser)
            this.mappingCache.set(`lid:${lidUser}`, pnUser)
        }
    }

    async getLIDForPN(pn) {
        return (await this.getLIDsForPNs([pn]))?.[0]?.lid || null
    }

    async getLIDsForPNs(pns) {
        if (!pns.length) return null
        const sortedPns = [...new Set(pns)].sort()
        const cacheKey = sortedPns.join(',')

        const inflight = this.inflightLIDLookups.get(cacheKey)
        if (inflight) {
            this.logger.trace(`Coalescing getLIDsForPNs for ${sortedPns.length} PNs`)
            return inflight
        }

        const promise = this._getLIDsForPNsImpl(pns)
        this.inflightLIDLookups.set(cacheKey, promise)
        try {
            return await promise
        } finally {
            this.inflightLIDLookups.delete(cacheKey)
        }
    }

    async _getLIDsForPNsImpl(pns) {
        const usyncFetch = {}
        const successfulPairs = {}
        const pending = []

        const addResolvedPair = (pn, decoded, lidUser) => {
            const normalizedLidUser = lidUser.toString()
            if (!normalizedLidUser) {
                this.logger.warn(`Invalid or empty LID user for PN ${pn}: lidUser = "${lidUser}"`)
                return false
            }
            const pnDevice = decoded.device !== undefined ? decoded.device : 0
            const deviceSpecificLid = `${normalizedLidUser}${pnDevice ? `:${pnDevice}` : ''}@${decoded.server === 'hosted' ? 'hosted.lid' : 'lid'}`
            this.logger.trace(`getLIDForPN: ${pn} → ${deviceSpecificLid} (user mapping with device ${pnDevice})`)
            successfulPairs[pn] = { lid: deviceSpecificLid, pn }
            return true
        }

        for (const pn of pns) {
            if (!isPnUser(pn) && !isHostedPnUser(pn)) continue
            const decoded = jidDecode(pn)
            if (!decoded) continue
            const pnUser = decoded.user
            const cached = this.mappingCache.get(`pn:${pnUser}`)
            if (cached) {
                addResolvedPair(pn, decoded, cached)
            } else {
                pending.push({ pn, pnUser, decoded })
            }
        }

        if (pending.length) {
            // Single batched DB fetch for all cache misses
            const pnUsers = [...new Set(pending.map(p => p.pnUser))]
            const stored = await this.keys.get('lid-mapping', pnUsers)

            for (const pnUser of pnUsers) {
                const lidUser = stored[pnUser]
                if (lidUser) {
                    this.mappingCache.set(`pn:${pnUser}`, lidUser)
                    this.mappingCache.set(`lid:${lidUser}`, pnUser)
                }
            }

            for (const { pn, pnUser, decoded } of pending) {
                const cached = this.mappingCache.get(`pn:${pnUser}`)
                if (cached) {
                    addResolvedPair(pn, decoded, cached)
                } else {
                    this.logger.trace(`No LID mapping found for PN user ${pnUser}; batch getting from USync`)
                    const device = decoded.device || 0
                    let normalizedPn = jidNormalizedUser(pn)
                    if (isHostedPnUser(normalizedPn)) normalizedPn = `${pnUser}@s.whatsapp.net`
                    if (!usyncFetch[normalizedPn]) usyncFetch[normalizedPn] = [device]
                    else usyncFetch[normalizedPn].push(device)
                }
            }
        }

        if (Object.keys(usyncFetch).length > 0) {
            const result = await this.pnToLIDFunc?.(Object.keys(usyncFetch))
            if (result?.length > 0) {
                await this.storeLIDPNMappings(result) // fixed: was fire-and-forget
                for (const pair of result) {
                    const pnDecoded = jidDecode(pair.pn)
                    const pnUser = pnDecoded?.user
                    if (!pnUser) continue
                    const lidUser = jidDecode(pair.lid)?.user
                    if (!lidUser) continue
                    for (const device of usyncFetch[pair.pn] || []) {
                        const deviceSpecificLid = `${lidUser}${device ? `:${device}` : ''}@${device === 99 ? 'hosted.lid' : 'lid'}`
                        const deviceSpecificPn = `${pnUser}${device ? `:${device}` : ''}@${device === 99 ? 'hosted' : 's.whatsapp.net'}`
                        this.logger.trace(`getLIDForPN: USYNC success for ${pair.pn} → ${deviceSpecificLid} (user mapping with device ${device})`)
                        successfulPairs[deviceSpecificPn] = { lid: deviceSpecificLid, pn: deviceSpecificPn }
                    }
                }
            } else {
                return null
            }
        }

        return Object.values(successfulPairs).length ? Object.values(successfulPairs) : null
    }

    async getPNForLID(lid) {
        return (await this.getPNsForLIDs([lid]))?.[0]?.pn || null
    }

    async getPNsForLIDs(lids) {
        if (!lids.length) return null
        const sortedLids = [...new Set(lids)].sort()
        const cacheKey = sortedLids.join(',')

        const inflight = this.inflightPNLookups.get(cacheKey)
        if (inflight) {
            this.logger.trace(`Coalescing getPNsForLIDs for ${sortedLids.length} LIDs`)
            return inflight
        }

        const promise = this._getPNsForLIDsImpl(lids)
        this.inflightPNLookups.set(cacheKey, promise)
        try {
            return await promise
        } finally {
            this.inflightPNLookups.delete(cacheKey)
        }
    }

    async _getPNsForLIDsImpl(lids) {
        const successfulPairs = {}
        const pending = []

        const addResolvedPair = (lid, decoded, pnUser) => {
            if (!pnUser || typeof pnUser !== 'string') return false
            const lidDevice = decoded.device !== undefined ? decoded.device : 0
            const pnJid = `${pnUser}:${lidDevice}@${decoded.domainType === WAJIDDomains.HOSTED_LID ? 'hosted' : 's.whatsapp.net'}`
            this.logger.trace(`Found reverse mapping: ${lid} → ${pnJid}`)
            successfulPairs[lid] = { lid, pn: pnJid }
            return true
        }

        for (const lid of lids) {
            if (!isLidUser(lid)) continue
            const decoded = jidDecode(lid)
            if (!decoded) continue
            const lidUser = decoded.user
            const cached = this.mappingCache.get(`lid:${lidUser}`)
            if (cached) {
                addResolvedPair(lid, decoded, cached)
            } else {
                pending.push({ lid, lidUser, decoded })
            }
        }

        if (pending.length) {
            // Single batched DB fetch for all cache misses
            const reverseKeys = [...new Set(pending.map(p => `${p.lidUser}_reverse`))]
            const stored = await this.keys.get('lid-mapping', reverseKeys)

            for (const { lid, lidUser, decoded } of pending) {
                let pnUser = this.mappingCache.get(`lid:${lidUser}`)
                if (!pnUser || typeof pnUser !== 'string') {
                    pnUser = stored[`${lidUser}_reverse`]
                    if (pnUser && typeof pnUser === 'string') {
                        this.mappingCache.set(`lid:${lidUser}`, pnUser)
                        this.mappingCache.set(`pn:${pnUser}`, lidUser)
                    }
                }
                if (pnUser) addResolvedPair(lid, decoded, pnUser)
                else this.logger.trace(`No reverse mapping found for LID user: ${lidUser}`)
            }
        }

        return Object.values(successfulPairs).length ? Object.values(successfulPairs) : null
    }
}