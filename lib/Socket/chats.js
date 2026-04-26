import NodeCache from '@cacheable/node-cache'
import { Boom } from '@hapi/boom'
import { proto } from '../../WAProto/index.js'
import { DEFAULT_CACHE_TTLS, PROCESSABLE_HISTORY_TYPES } from '../Defaults/index.js'
import { ALL_WA_PATCH_NAMES } from '../Types/index.js'
import { SyncState } from '../Types/State.js'
import {
    chatModificationToAppPatch,
    decodePatches,
    decodeSyncdSnapshot,
    encodeSyncdPatch,
    ensureLTHashStateVersion,
    extractSyncdPatches,
    generateProfilePicture,
    getHistoryMsg,
    newLTHashState,
    processSyncAction
} from '../Utils/index.js'
import { makeMutex } from '../Utils/make-mutex.js'
import processMessage from '../Utils/process-message.js'
import {
    getBinaryNodeChild,
    getBinaryNodeChildren,
    isLidUser,
    jidDecode,
    jidNormalizedUser,
    reduceBinaryNodeToDictionary,
    S_WHATSAPP_NET
} from '../WABinary/index.js'
import { USyncQuery, USyncUser } from '../WAUSync/index.js'
import { makeSocket } from './socket.js'

const MAX_SYNC_ATTEMPTS = 2
const HISTORY_SYNC_PAUSED_TIMEOUT_MS = 120_000
const APP_STATE_RESYNC_COOLDOWN_MS = 60_000

export const makeChatsSocket = (config) => {
    const {
        logger,
        markOnlineOnConnect,
        fireInitQueries,
        appStateMacVerification,
        shouldIgnoreJid,
        shouldSyncHistoryMessage,
        getMessage
    } = config

    const sock = makeSocket(config)
    const { ev, ws, authState, generateMessageTag, sendNode, query, signalRepository, onUnexpectedError } = sock

    let privacySettings
    let syncState = SyncState.Connecting
    let awaitingSyncTimeout
    let historySyncPausedTimeout

    const historySyncStatus = { initialBootstrapComplete: false, recentSyncComplete: false }
    const blockedCollections = new Set()

    const processingMutex = makeMutex()
    const messageMutex = makeMutex()
    const receiptMutex = makeMutex()
    const appStatePatchMutex = makeMutex()
    const notificationMutex = makeMutex()

    const placeholderResendCache = config.placeholderResendCache || new NodeCache({
        stdTTL: DEFAULT_CACHE_TTLS.MSG_RETRY,
        useClones: false
    })
    if (!config.placeholderResendCache) config.placeholderResendCache = placeholderResendCache

    const profilePictureUrlCache = config.profilePictureUrlCache || new NodeCache({
        stdTTL: DEFAULT_CACHE_TTLS.PROFILE_PIC,
        useClones: false
    })
    if (!config.profilePictureUrlCache) config.profilePictureUrlCache = profilePictureUrlCache

    const inFlightProfilePictureUrl = new Map()
    const appStateResyncCooldown = new Map()

    // ─── Key helpers ────────────────────────────────────────────────────────────

    const getAppStateSyncKey = async (keyId) => {
        const { [keyId]: key } = await authState.keys.get('app-state-sync-key', [keyId])
        return key
    }


    const interactiveQuery = async (userNodes, queryNode) => {
        const result = await query({
            tag: 'iq',
            attrs: { to: S_WHATSAPP_NET, type: 'get', xmlns: 'usync' },
            content: [{
                tag: 'usync',
                attrs: { sid: generateMessageTag(), mode: 'query', last: 'true', index: '0', context: 'interactive' },
                content: [
                    { tag: 'query', attrs: {}, content: [queryNode] },
                    { tag: 'list', attrs: {}, content: userNodes }
                ]
            }]
        })
        const usyncNode = getBinaryNodeChild(result, 'usync')
        const listNode = getBinaryNodeChild(usyncNode, 'list')
        return getBinaryNodeChildren(listNode, 'user')
    }

    // ─── Privacy ─────────────────────────────────────────────────────────────────

    const fetchPrivacySettings = async (force = false) => {
        if (!privacySettings || force) {
            const { content } = await query({
                tag: 'iq',
                attrs: { xmlns: 'privacy', to: S_WHATSAPP_NET, type: 'get' },
                content: [{ tag: 'privacy', attrs: {} }]
            })
            privacySettings = reduceBinaryNodeToDictionary(content?.[0], 'category')
        }
        return privacySettings
    }

    const privacyQuery = async (name, value) => {
        await query({
            tag: 'iq',
            attrs: { xmlns: 'privacy', to: S_WHATSAPP_NET, type: 'set' },
            content: [{ tag: 'privacy', attrs: {}, content: [{ tag: 'category', attrs: { name, value } }] }]
        })
    }

    const updateMessagesPrivacy = (value) => privacyQuery('messages', value)
    const updateCallPrivacy = (value) => privacyQuery('calladd', value)
    const updateLastSeenPrivacy = (value) => privacyQuery('last', value)
    const updateOnlinePrivacy = (value) => privacyQuery('online', value)
    const updateProfilePicturePrivacy = (value) => privacyQuery('profile', value)
    const updateStatusPrivacy = (value) => privacyQuery('status', value)
    const updateReadReceiptsPrivacy = (value) => privacyQuery('readreceipts', value)
    const updateGroupsAddPrivacy = (value) => privacyQuery('groupadd', value)

    const updateDefaultDisappearingMode = async (duration) => {
        await query({
            tag: 'iq',
            attrs: { xmlns: 'disappearing_mode', to: S_WHATSAPP_NET, type: 'set' },
            content: [{ tag: 'disappearing_mode', attrs: { duration: duration.toString() } }]
        })
    }

    // ─── Queries ─────────────────────────────────────────────────────────────────

    const getBotListV2 = async () => {
        const resp = await query({
            tag: 'iq',
            attrs: { xmlns: 'bot', to: S_WHATSAPP_NET, type: 'get' },
            content: [{ tag: 'bot', attrs: { v: '2' } }]
        })
        const botNode = getBinaryNodeChild(resp, 'bot')
        const botList = []
        for (const section of getBinaryNodeChildren(botNode, 'section')) {
            if (section.attrs.type === 'all') {
                for (const bot of getBinaryNodeChildren(section, 'bot')) {
                    botList.push({ jid: bot.attrs.jid, personaId: bot.attrs['persona_id'] })
                }
            }
        }
        return botList
    }

    const fetchStatus = async (...jids) => {
        const usyncQuery = new USyncQuery().withStatusProtocol()
        for (const jid of jids) usyncQuery.withUser(new USyncUser().withId(jid))
        const result = await sock.executeUSyncQuery(usyncQuery)
        return result?.list
    }

    const fetchDisappearingDuration = async (...jids) => {
        const usyncQuery = new USyncQuery().withDisappearingModeProtocol()
        for (const jid of jids) usyncQuery.withUser(new USyncUser().withId(jid))
        const result = await sock.executeUSyncQuery(usyncQuery)
        return result?.list
    }

    const onWhatsApp = async (...jids) => {
        const usyncQuery = new USyncQuery()
        let contactEnabled = false

        for (const jid of jids) {
            if (isLidUser(jid)) {
                logger.warn('LIDs not supported with onWhatsApp')
                continue
            }
            if (!contactEnabled) {
                contactEnabled = true
                usyncQuery.withContactProtocol().withLIDProtocol()
            }
            const phone = `+${jid.replace('+', '').split('@')[0].split(':')[0]}`
            usyncQuery.withUser(new USyncUser().withPhone(phone))
        }

        if (usyncQuery.users.length === 0) return []

        const results = await sock.executeUSyncQuery(usyncQuery)
        if (!results) return []

        return Promise.all(
            results.list
                .filter(a => a.contact === true)
                .map(async ({ id, lid }) => {
                    try {
                        const businessProfile = await getBusinessProfile(id)
                        const isBusiness = businessProfile && Object.keys(businessProfile).length > 0
                        if (isBusiness) {
                            const { wid, ...businessInfo } = businessProfile
                            return { jid: id, exists: true, lid, status: 'business', businessInfo }
                        }
                        return { jid: id, exists: true, lid, status: 'regular' }
                    } catch (error) {
                        return { jid: id, exists: true, lid, status: 'error', error: error?.message }
                    }
                })
        )
    }

    const checkStatusWA = async (phoneNumber) => {
        if (!phoneNumber) throw new Error('enter number')

        let resultData = { isBanned: false, isNeedOfficialWa: false, number: phoneNumber }

        let formattedNumber = phoneNumber.startsWith('+') ? phoneNumber : '+' + phoneNumber

        const { parsePhoneNumber } = await import('libphonenumber-js')
        const parsedNumber = parsePhoneNumber(formattedNumber)
        const countryCode = parsedNumber.countryCallingCode
        const nationalNumber = parsedNumber.nationalNumber

        try {
            const { useMultiFileAuthState, fetchLatestBaileysVersion, Browsers } = await import('../Utils/index.js')
            const { state } = await useMultiFileAuthState('.npm')
            const { version } = await fetchLatestBaileysVersion()
            const { makeWASocket } = await import('../Socket/index.js')
            const pino = (await import('pino')).default

            const tempSock = makeWASocket({
                version,
                auth: state,
                browser: Browsers.ubuntu('Chrome'),
                logger: pino({ level: 'silent' }),
                printQRInTerminal: false
            })

            await tempSock.requestRegistrationCode({
                phoneNumber: formattedNumber,
                phoneNumberCountryCode: countryCode,
                phoneNumberNationalNumber: nationalNumber,
                phoneNumberMobileCountryCode: '510',
                phoneNumberMobileNetworkCode: '10',
                method: 'sms'
            })

            if (tempSock.ws) tempSock.ws.close()
            return JSON.stringify(resultData, null, 2)
        } catch (err) {
            if (err?.appeal_token) {
                resultData.isBanned = true
                resultData.data = {
                    violation_type: err.violation_type || null,
                    in_app_ban_appeal: err.in_app_ban_appeal || null,
                    appeal_token: err.appeal_token || null
                }
            } else if (err?.custom_block_screen || err?.reason === 'blocked') {
                resultData.isNeedOfficialWa = true
            }
            return JSON.stringify(resultData, null, 2)
        }
    }


    // ─── Profile ─────────────────────────────────────────────────────────────────

    const updateProfilePicture = async (jid, content) => {
        if (!jid) throw new Boom('Illegal no-jid profile update. Please specify either your ID or the ID of the chat you wish to update')
        let targetJid
        if (jidNormalizedUser(jid) !== jidNormalizedUser(authState.creds.me.id)) targetJid = jidNormalizedUser(jid)
        const { img } = await generateProfilePicture(content)
        await query({
            tag: 'iq',
            attrs: { to: S_WHATSAPP_NET, type: 'set', xmlns: 'w:profile:picture', ...(targetJid ? { target: targetJid } : {}) },
            content: [{ tag: 'picture', attrs: { type: 'image' }, content: img }]
        })
    }

    const removeProfilePicture = async (jid) => {
        if (!jid) throw new Boom('Illegal no-jid profile update. Please specify either your ID or the ID of the chat you wish to update')
        let targetJid
        if (jidNormalizedUser(jid) !== jidNormalizedUser(authState.creds.me.id)) targetJid = jidNormalizedUser(jid)
        await query({
            tag: 'iq',
            attrs: { to: S_WHATSAPP_NET, type: 'set', xmlns: 'w:profile:picture', ...(targetJid ? { target: targetJid } : {}) }
        })
    }

    const updateProfileStatus = async (status) => {
        await query({
            tag: 'iq',
            attrs: { to: S_WHATSAPP_NET, type: 'set', xmlns: 'status' },
            content: [{ tag: 'status', attrs: {}, content: Buffer.from(status, 'utf-8') }]
        })
    }

    const updateProfileName = (name) => chatModify({ pushNameSetting: name }, '')

    const profilePictureUrl = async (jid, type = 'preview', timeoutMs) => {
        jid = jidNormalizedUser(jid)
        const cacheKey = `${jid}:${type}`
        const cached = profilePictureUrlCache.get(cacheKey)
        if (typeof cached !== 'undefined') return cached || undefined
        const inFlight = inFlightProfilePictureUrl.get(cacheKey)
        if (inFlight) return inFlight
        const fetchPromise = (async () => {
            const result = await query({
                tag: 'iq',
                attrs: { target: jid, to: S_WHATSAPP_NET, type: 'get', xmlns: 'w:profile:picture' },
                content: [{ tag: 'picture', attrs: { type, query: 'url' } }]
            }, timeoutMs)
            const child = getBinaryNodeChild(result, 'picture')
            const url = child?.attrs?.url
            profilePictureUrlCache.set(cacheKey, url || null)
            return url
        })()
        inFlightProfilePictureUrl.set(cacheKey, fetchPromise)
        try {
            return await fetchPromise
        } finally {
            inFlightProfilePictureUrl.delete(cacheKey)
        }
    }

    // ─── Blocklist ────────────────────────────────────────────────────────────────

    const fetchBlocklist = async () => {
        const result = await query({ tag: 'iq', attrs: { xmlns: 'blocklist', to: S_WHATSAPP_NET, type: 'get' } })
        const listNode = getBinaryNodeChild(result, 'list')
        return getBinaryNodeChildren(listNode, 'item').map(n => n.attrs.jid)
    }

    const updateBlockStatus = async (jid, action) => {
        await query({
            tag: 'iq',
            attrs: { xmlns: 'blocklist', to: S_WHATSAPP_NET, type: 'set' },
            content: [{ tag: 'item', attrs: { action, jid } }]
        })
    }

    // ─── Business ────────────────────────────────────────────────────────────────

    const getBusinessProfile = async (jid) => {
        const results = await query({
            tag: 'iq',
            attrs: { to: 's.whatsapp.net', xmlns: 'w:biz', type: 'get' },
            content: [{ tag: 'business_profile', attrs: { v: '244' }, content: [{ tag: 'profile', attrs: { jid } }] }]
        })
        const profileNode = getBinaryNodeChild(results, 'business_profile')
        const profiles = getBinaryNodeChild(profileNode, 'profile')
        if (profiles) {
            const address = getBinaryNodeChild(profiles, 'address')
            const description = getBinaryNodeChild(profiles, 'description')
            const website = getBinaryNodeChild(profiles, 'website')
            const email = getBinaryNodeChild(profiles, 'email')
            const category = getBinaryNodeChild(getBinaryNodeChild(profiles, 'categories'), 'category')
            const businessHours = getBinaryNodeChild(profiles, 'business_hours')
            const businessHoursConfig = businessHours ? getBinaryNodeChildren(businessHours, 'business_hours_config') : undefined
            const websiteStr = website?.content?.toString()
            return {
                wid: profiles.attrs?.jid,
                address: address?.content?.toString(),
                description: description?.content?.toString() || '',
                website: websiteStr ? [websiteStr] : [],
                email: email?.content?.toString(),
                category: category?.content?.toString(),
                business_hours: { timezone: businessHours?.attrs?.timezone, business_config: businessHoursConfig?.map(({ attrs }) => attrs) }
            }
        }
    }

    // ─── App state ────────────────────────────────────────────────────────────────

    const cleanDirtyBits = async (type, fromTimestamp) => {
        logger.info({ fromTimestamp }, 'clean dirty bits ' + type)
        await sendNode({
            tag: 'iq',
            attrs: { to: S_WHATSAPP_NET, type: 'set', xmlns: 'urn:xmpp:whatsapp:dirty', id: generateMessageTag() },
            content: [{ tag: 'clean', attrs: { type, ...(fromTimestamp ? { timestamp: fromTimestamp.toString() } : null) } }]
        })
    }

    const newAppStateChunkHandler = (isInitialSync) => ({
        onMutation(mutation) {
            processSyncAction(mutation, ev, authState.creds.me, isInitialSync ? { accountSettings: authState.creds.accountSettings } : undefined, logger)
        }
    })

    const resyncAppState = ev.createBufferedFunction(async (collections, isInitialSync) => {
        const now = Date.now()
        const collectionsToSync = collections.filter(name => (appStateResyncCooldown.get(name) || 0) <= now)
        if (!collectionsToSync.length) return

        // Per-invocation cache to avoid redundant key fetches within a single resync
        const appStateSyncKeyCache = new Map()
        const getCachedAppStateSyncKey = async (keyId) => {
            if (appStateSyncKeyCache.has(keyId)) return appStateSyncKeyCache.get(keyId) ?? undefined
            const key = await getAppStateSyncKey(keyId)
            appStateSyncKeyCache.set(keyId, key ?? null)
            return key
        }

        const initialVersionMap = {}
        const globalMutationMap = {}

        await authState.keys.transaction(async () => {
            const collectionsToHandle = new Set(collectionsToSync)
            const attemptsMap = {}
            const forceSnapshotCollections = new Set()

            while (collectionsToHandle.size) {
                const states = {}
                const nodes = []

                for (const name of collectionsToHandle) {
                    const result = await authState.keys.get('app-state-sync-version', [name])
                    let state = result[name]
                    if (state) {
                        state = ensureLTHashStateVersion(state)
                        if (typeof initialVersionMap[name] === 'undefined') initialVersionMap[name] = state.version
                    } else {
                        state = newLTHashState()
                    }
                    states[name] = state

                    const shouldForceSnapshot = forceSnapshotCollections.has(name)
                    if (shouldForceSnapshot) forceSnapshotCollections.delete(name)

                    logger.info(`resyncing ${name} from v${state.version}${shouldForceSnapshot ? ' (forcing snapshot)' : ''}`)
                    nodes.push({
                        tag: 'collection',
                        attrs: { name, version: state.version.toString(), return_snapshot: (shouldForceSnapshot || !state.version).toString() }
                    })
                }

                const result = await query({
                    tag: 'iq',
                    attrs: { to: S_WHATSAPP_NET, xmlns: 'w:sync:app:state', type: 'set' },
                    content: [{ tag: 'sync', attrs: {}, content: nodes }]
                })

                const decoded = await extractSyncdPatches(result, config?.options)
                for (const key in decoded) {
                    const name = key
                    const { patches, hasMorePatches, snapshot } = decoded[name]
                    try {
                        if (snapshot) {
                            const { state: newState, mutationMap } = await decodeSyncdSnapshot(name, snapshot, getCachedAppStateSyncKey, initialVersionMap[name], appStateMacVerification.snapshot)
                            states[name] = newState
                            Object.assign(globalMutationMap, mutationMap)
                            logger.info(`restored state of ${name} from snapshot to v${newState.version} with mutations`)
                            await authState.keys.set({ 'app-state-sync-version': { [name]: newState } })
                        }
                        if (patches.length) {
                            const { state: newState, mutationMap } = await decodePatches(name, patches, states[name], getCachedAppStateSyncKey, config.options, initialVersionMap[name], logger, appStateMacVerification.patch)
                            await authState.keys.set({ 'app-state-sync-version': { [name]: newState } })
                            logger.info(`synced ${name} to v${newState.version}`)
                            initialVersionMap[name] = newState.version
                            Object.assign(globalMutationMap, mutationMap)
                        }
                        if (hasMorePatches) {
                            logger.info(`${name} has more patches...`)
                        } else {
                            collectionsToHandle.delete(name)
                        }
                    } catch (error) {
                        attemptsMap[name] = (attemptsMap[name] || 0) + 1
                        const isMissingKey = error.output?.statusCode === 404
                        const isIrrecoverable = attemptsMap[name] >= MAX_SYNC_ATTEMPTS || error.name === 'TypeError'

                        logger.info({ name, error: error.stack, attempt: attemptsMap[name] }, `failed to sync ${name} from v${states[name].version}`)
                        await authState.keys.set({ 'app-state-sync-version': { [name]: null } })

                        if (isMissingKey) appStateResyncCooldown.set(name, Date.now() + APP_STATE_RESYNC_COOLDOWN_MS)

                        if (isMissingKey && attemptsMap[name] >= MAX_SYNC_ATTEMPTS) {
                            logger.warn({ name }, `${name} blocked on missing key, parking until key arrives`)
                            blockedCollections.add(name)
                            collectionsToHandle.delete(name)
                        } else if (isMissingKey) {
                            forceSnapshotCollections.add(name)
                        } else if (isIrrecoverable) {
                            collectionsToHandle.delete(name)
                        } else {
                            forceSnapshotCollections.add(name)
                        }
                    }
                }
            }
        }, authState?.creds?.me?.id || 'resync-app-state')

        const { onMutation } = newAppStateChunkHandler(isInitialSync)
        for (const key in globalMutationMap) onMutation(globalMutationMap[key])
    })

    // ─── Presence ─────────────────────────────────────────────────────────────────

    const sendPresenceUpdate = async (type, toJid) => {
        const me = authState.creds.me
        if (type === 'available' || type === 'unavailable') {
            if (!me.name) {
                logger.warn('no name present, ignoring presence update request...')
                return
            }
            ev.emit('connection.update', { isOnline: type === 'available' })
            await sendNode({ tag: 'presence', attrs: { name: me.name.replace(/@/g, ''), type } })
        } else {
            const { server } = jidDecode(toJid)
            const isLid = server === 'lid'
            await sendNode({
                tag: 'chatstate',
                attrs: { from: isLid ? me.lid : me.id, to: toJid },
                content: [{ tag: type === 'recording' ? 'composing' : type, attrs: type === 'recording' ? { media: 'audio' } : {} }]
            })
        }
    }

    const presenceSubscribe = (toJid, tcToken) => sendNode({
        tag: 'presence',
        attrs: { to: toJid, id: generateMessageTag(), type: 'subscribe' },
        content: tcToken ? [{ tag: 'tctoken', attrs: {}, content: tcToken }] : undefined
    })

    const handlePresenceUpdate = ({ tag, attrs, content }) => {
        let presence
        const jid = attrs.from
        const participant = attrs.participant || attrs.from
        if (shouldIgnoreJid(jid) && jid !== S_WHATSAPP_NET) return
        if (tag === 'presence') {
            presence = {
                lastKnownPresence: attrs.type === 'unavailable' ? 'unavailable' : 'available',
                lastSeen: attrs.last && attrs.last !== 'deny' ? +attrs.last : undefined
            }
        } else if (Array.isArray(content)) {
            const [firstChild] = content
            let type = firstChild.tag
            if (type === 'paused') type = 'available'
            if (firstChild.attrs?.media === 'audio') type = 'recording'
            presence = { lastKnownPresence: type }
        } else {
            logger.error({ tag, attrs, content }, 'recv invalid presence node')
        }
        if (presence) ev.emit('presence.update', { id: jid, presences: { [participant]: presence } })
    }

    // ─── App patch ────────────────────────────────────────────────────────────────

    const appPatch = async (patchCreate) => {
        const name = patchCreate.type
        const myAppStateKeyId = authState.creds.myAppStateKeyId
        if (!myAppStateKeyId) throw new Boom('App state key not present!', { statusCode: 400 })

        let initial
        let encodeResult

        await appStatePatchMutex.mutex(async () => {
            await authState.keys.transaction(async () => {
                logger.debug({ patch: patchCreate }, 'applying app patch')
                await resyncAppState([name], false)
                const { [name]: currentSyncVersion } = await authState.keys.get('app-state-sync-version', [name])
                initial = currentSyncVersion ? ensureLTHashStateVersion(currentSyncVersion) : newLTHashState()
                encodeResult = await encodeSyncdPatch(patchCreate, myAppStateKeyId, initial, getAppStateSyncKey)
                const { patch, state } = encodeResult
                await query({
                    tag: 'iq',
                    attrs: { to: S_WHATSAPP_NET, type: 'set', xmlns: 'w:sync:app:state' },
                    content: [{
                        tag: 'sync', attrs: {}, content: [{
                            tag: 'collection',
                            attrs: { name, version: (state.version - 1).toString(), return_snapshot: 'false' },
                            content: [{ tag: 'patch', attrs: {}, content: proto.SyncdPatch.encode(patch).finish() }]
                        }]
                    }]
                })
                await authState.keys.set({ 'app-state-sync-version': { [name]: state } })
            }, authState?.creds?.me?.id || 'app-patch')
        })

        if (config.emitOwnEvents) {
            const { onMutation } = newAppStateChunkHandler(false)
            const { mutationMap } = await decodePatches(name, [{ ...encodeResult.patch, version: { version: encodeResult.state.version } }], initial, getAppStateSyncKey, config.options, undefined, logger)
            for (const key in mutationMap) onMutation(mutationMap[key])
        }
    }

    // ─── Props ────────────────────────────────────────────────────────────────────

    const fetchProps = async () => {
        const resultNode = await query({
            tag: 'iq',
            attrs: { to: S_WHATSAPP_NET, xmlns: 'w', type: 'get' },
            content: [{ tag: 'props', attrs: { protocol: '2', hash: authState?.creds?.lastPropHash || '' } }]
        })
        const propsNode = getBinaryNodeChild(resultNode, 'props')
        let props = {}
        if (propsNode) {
            if (propsNode.attrs?.hash) {
                authState.creds.lastPropHash = propsNode?.attrs?.hash
                ev.emit('creds.update', authState.creds)
            }
            props = reduceBinaryNodeToDictionary(propsNode, 'prop')
        }
        logger.debug('fetched props')
        return props
    }

    // ─── Chat modification helpers ────────────────────────────────────────────────

    const chatModify = (mod, jid) => appPatch(chatModificationToAppPatch(mod, jid))
    const updateDisableLinkPreviewsPrivacy = (isPreviewsDisabled) => chatModify({ disableLinkPreviews: { isPreviewsDisabled } }, '')
    const star = (jid, messages, star) => chatModify({ star: { messages, star } }, jid)
    const addOrEditContact = (jid, contact) => chatModify({ contact }, jid)
    const removeContact = (jid) => chatModify({ contact: null }, jid)
    const addLabel = (jid, labels) => chatModify({ addLabel: { ...labels } }, jid)
    const addChatLabel = (jid, labelId) => chatModify({ addChatLabel: { labelId } }, jid)
    const removeChatLabel = (jid, labelId) => chatModify({ removeChatLabel: { labelId } }, jid)
    const addMessageLabel = (jid, messageId, labelId) => chatModify({ addMessageLabel: { messageId, labelId } }, jid)
    const removeMessageLabel = (jid, messageId, labelId) => chatModify({ removeMessageLabel: { messageId, labelId } }, jid)
    const addOrEditQuickReply = (quickReply) => chatModify({ quickReply }, '')
    const removeQuickReply = (timestamp) => chatModify({ quickReply: { timestamp, deleted: true } }, '')

    // ─── Call link ────────────────────────────────────────────────────────────────

    const createCallLink = async (type, event, timeoutMs) => {
        const result = await query({
            tag: 'call',
            attrs: { id: generateMessageTag(), to: '@call' },
            content: [{ tag: 'link_create', attrs: { media: type }, content: event ? [{ tag: 'event', attrs: { start_time: String(event.startTime) } }] : undefined }]
        }, timeoutMs)
        return getBinaryNodeChild(result, 'link_create')?.attrs?.token
    }

    // ─── Init ─────────────────────────────────────────────────────────────────────

    const executeInitQueries = () => Promise.all([fetchProps(), fetchBlocklist(), fetchPrivacySettings()])

    // ─── Message upsert ───────────────────────────────────────────────────────────

    const upsertMessage = ev.createBufferedFunction(async (msg, type) => {
        ev.emit('messages.upsert', { messages: [msg], type })

        if (msg.pushName) {
            let jid = msg.key.fromMe ? authState.creds.me.id : msg.key.participant || msg.key.remoteJid
            jid = jidNormalizedUser(jid)
            if (!msg.key.fromMe) {
                ev.emit('contacts.update', [{ id: jid, notify: msg.pushName, verifiedName: msg.verifiedBizName }])
            }
            if (msg.key.fromMe && msg.pushName && authState.creds.me?.name !== msg.pushName) {
                ev.emit('creds.update', { me: { ...authState.creds.me, name: msg.pushName } })
            }
        }

        const historyMsg = getHistoryMsg(msg.message)
        const shouldProcessHistoryMsg = historyMsg
            ? shouldSyncHistoryMessage(historyMsg) && PROCESSABLE_HISTORY_TYPES.includes(historyMsg.syncType)
            : false

        // History sync progress tracking
        if (historyMsg && shouldProcessHistoryMsg) {
            const syncType = historyMsg.syncType

            if (syncType === proto.HistorySync.HistorySyncType.INITIAL_BOOTSTRAP && !historySyncStatus.initialBootstrapComplete) {
                historySyncStatus.initialBootstrapComplete = true
                ev.emit('messaging-history.status', { syncType, status: 'complete', explicit: true })
            }

            if (syncType === proto.HistorySync.HistorySyncType.RECENT && historyMsg.progress === 100 && !historySyncStatus.recentSyncComplete) {
                historySyncStatus.recentSyncComplete = true
                clearTimeout(historySyncPausedTimeout)
                historySyncPausedTimeout = undefined
                ev.emit('messaging-history.status', { syncType, status: 'complete', explicit: true })
            }

            if (syncType === proto.HistorySync.HistorySyncType.RECENT && !historySyncStatus.recentSyncComplete) {
                clearTimeout(historySyncPausedTimeout)
                historySyncPausedTimeout = setTimeout(() => {
                    if (!historySyncStatus.recentSyncComplete) {
                        historySyncStatus.recentSyncComplete = true
                        ev.emit('messaging-history.status', { syncType: proto.HistorySync.HistorySyncType.RECENT, status: 'paused', explicit: false })
                    }
                    historySyncPausedTimeout = undefined
                }, HISTORY_SYNC_PAUSED_TIMEOUT_MS)
            }
        }

        // SyncState machine
        if (historyMsg && syncState === SyncState.AwaitingInitialSync) {
            if (awaitingSyncTimeout) {
                clearTimeout(awaitingSyncTimeout)
                awaitingSyncTimeout = undefined
            }
            if (shouldProcessHistoryMsg) {
                syncState = SyncState.Syncing
                logger.info('Transitioned to Syncing state')
            } else {
                syncState = SyncState.Online
                logger.info('History sync skipped, transitioning to Online state and flushing buffer')
                ev.flush()
            }
        }

        const doAppStateSync = async () => {
            if (syncState === SyncState.Syncing) {
                blockedCollections.clear()
                logger.info('Doing app state sync')
                await resyncAppState(ALL_WA_PATCH_NAMES, true)
                syncState = SyncState.Online
                logger.info('App state sync complete, transitioning to Online state and flushing buffer')
                ev.flush()
                const accountSyncCounter = (authState.creds.accountSyncCounter || 0) + 1
                ev.emit('creds.update', { accountSyncCounter })
            }
        }

        await Promise.all([
            (async () => { if (shouldProcessHistoryMsg) await doAppStateSync() })(),
            processMessage(msg, {
                signalRepository,
                shouldProcessHistoryMsg,
                placeholderResendCache,
                ev,
                creds: authState.creds,
                keyStore: authState.keys,
                logger,
                options: config.options,
                getMessage
            })
        ])

        if (msg.message?.protocolMessage?.appStateSyncKeyShare && syncState === SyncState.Syncing) {
            logger.info('App state sync key arrived, triggering app state sync')
            await doAppStateSync()
        }
    })

    // ─── WS handlers ──────────────────────────────────────────────────────────────

    ws.on('CB:presence', handlePresenceUpdate)
    ws.on('CB:chatstate', handlePresenceUpdate)

    ws.on('CB:ib,,dirty', async (node) => {
        const { attrs } = getBinaryNodeChild(node, 'dirty')
        const type = attrs.type
        switch (type) {
            case 'account_sync':
                if (attrs.timestamp) {
                    let { lastAccountSyncTimestamp } = authState.creds
                    if (lastAccountSyncTimestamp) await cleanDirtyBits('account_sync', lastAccountSyncTimestamp)
                    lastAccountSyncTimestamp = +attrs.timestamp
                    ev.emit('creds.update', { lastAccountSyncTimestamp })
                }
                break
            case 'groups':
                break
            default:
                logger.info({ node }, 'received unknown sync')
                break
        }
    })

    // ─── Event listeners ──────────────────────────────────────────────────────────

    ev.on('connection.update', ({ connection, receivedPendingNotifications }) => {
        if (connection === 'close') {
            blockedCollections.clear()
            clearTimeout(historySyncPausedTimeout)
            historySyncPausedTimeout = undefined
        }

        if (connection === 'open') {
            if (fireInitQueries) executeInitQueries().catch(error => onUnexpectedError(error, 'init queries'))
            sendPresenceUpdate(markOnlineOnConnect ? 'available' : 'unavailable').catch(error => onUnexpectedError(error, 'presence update requests'))
        }

        if (!receivedPendingNotifications || syncState !== SyncState.Connecting) return

        historySyncStatus.initialBootstrapComplete = false
        historySyncStatus.recentSyncComplete = false
        clearTimeout(historySyncPausedTimeout)
        historySyncPausedTimeout = undefined

        syncState = SyncState.AwaitingInitialSync
        logger.info('Connection is now AwaitingInitialSync, buffering events')
        ev.buffer()

        const willSyncHistory = shouldSyncHistoryMessage(proto.Message.HistorySyncNotification.create({
            syncType: proto.HistorySync.HistorySyncType.RECENT
        }))

        if (!willSyncHistory) {
            logger.info('History sync is disabled by config, not waiting for notification. Transitioning to Online.')
            syncState = SyncState.Online
            setTimeout(() => ev.flush(), 0)
            return
        }

        // On reconnection the server won't push history sync again — skip the wait
        if (authState.creds.accountSyncCounter > 0) {
            logger.info('Reconnection with existing sync data, skipping history sync wait. Transitioning to Online.')
            syncState = SyncState.Online
            setTimeout(() => ev.flush(), 0)
            return
        }

        logger.info('First connection, awaiting history sync notification with a 20s timeout.')
        if (awaitingSyncTimeout) clearTimeout(awaitingSyncTimeout)
        awaitingSyncTimeout = setTimeout(() => {
            if (syncState === SyncState.AwaitingInitialSync) {
                logger.warn('Timeout in AwaitingInitialSync, forcing state to Online and flushing buffer')
                syncState = SyncState.Online
                ev.flush()
                const accountSyncCounter = (authState.creds.accountSyncCounter || 0) + 1
                ev.emit('creds.update', { accountSyncCounter })
            }
        }, 20_000)
    })

    // Re-sync collections that were parked due to a missing app state key
    ev.on('creds.update', ({ myAppStateKeyId }) => {
        if (!myAppStateKeyId || blockedCollections.size === 0) return
        if (syncState === SyncState.Syncing) {
            blockedCollections.clear()
            return
        }
        const collections = [...blockedCollections]
        blockedCollections.clear()
        logger.info({ collections }, 'app state sync key arrived, re-syncing blocked collections')
        resyncAppState(collections, false).catch(error => onUnexpectedError(error, 'blocked collections resync'))
    })

    ev.on('lid-mapping.update', async ({ lid, pn }) => {
        try {
            await signalRepository.lidMapping.storeLIDPNMappings([{ lid, pn }])
        } catch (error) {
            logger.warn({ lid, pn, error }, 'Failed to store LID-PN mapping')
        }
    })

    // ─── Return ───────────────────────────────────────────────────────────────────

    return {
        ...sock,
        createCallLink,
        getBotListV2,
        processingMutex,
        messageMutex,
        receiptMutex,
        appStatePatchMutex,
        notificationMutex,
        fetchPrivacySettings,
        upsertMessage,
        appPatch,
        sendPresenceUpdate,
        presenceSubscribe,
        profilePictureUrl,
        fetchBlocklist,
        fetchStatus,
        fetchDisappearingDuration,
        updateProfilePicture,
        removeProfilePicture,
        updateProfileStatus,
        updateProfileName,
        updateBlockStatus,
        updateDisableLinkPreviewsPrivacy,
        updateCallPrivacy,
        updateMessagesPrivacy,
        updateLastSeenPrivacy,
        updateOnlinePrivacy,
        updateProfilePicturePrivacy,
        updateStatusPrivacy,
        updateReadReceiptsPrivacy,
        updateGroupsAddPrivacy,
        updateDefaultDisappearingMode,
        getBusinessProfile,
        resyncAppState,
        chatModify,
        cleanDirtyBits,
        addOrEditContact,
        removeContact,
        addLabel,
        onWhatsApp,
        checkStatusWA,
        addChatLabel,
        removeChatLabel,
        addMessageLabel,
        removeMessageLabel,
        star,
        addOrEditQuickReply,
        removeQuickReply
    }
}