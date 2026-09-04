import NodeCache from '@cacheable/node-cache'
import { Boom } from '@hapi/boom'
import { proto } from '../../WAProto/index.js'
import { DEFAULT_CACHE_TTLS, HISTORY_SYNC_PAUSED_TIMEOUT_MS, PROCESSABLE_HISTORY_TYPES, PRIVACY_MEX_IDS } from '../Defaults/index.js'
import { ALL_WA_PATCH_NAMES } from '../Types/index.js'
import { SyncState } from '../Types/State.js'
import { chatModificationToAppPatch, decodePatches, decodeSyncdSnapshot, encodeSyncdPatch, ensureLTHashStateVersion, extractSyncdPatches, generateProfilePicture, getHistoryMsg, isAppStateSyncIrrecoverable, isMissingKeyError, MAX_SYNC_ATTEMPTS, newLTHashState, processSyncAction } from '../Utils/index.js'
import { makeMutex } from '../Utils/make-mutex.js'
import processMessage from '../Utils/process-message.js'
import { buildTcTokenFromJid } from '../Utils/tc-token-utils.js'
import { getBinaryNodeChild, getBinaryNodeChildren, isHostedLidUser, isHostedPnUser, isLidUser, isPnUser, jidDecode, jidNormalizedUser, reduceBinaryNodeToDictionary, S_WHATSAPP_NET, VIOLATION_TYPES } from '../WABinary/index.js'
import { USyncQuery, USyncUser } from '../WAUSync/index.js'
import { makeSocket } from './socket.js'
import { executeWMexQuery } from './mex.js'
const APP_STATE_RESYNC_COOLDOWN_MS = 60_000

export const makeChatsSocket = (config) => {
    const { logger, markOnlineOnConnect, fireInitQueries, appStateMacVerification, shouldIgnoreJid, shouldSyncHistoryMessage, getMessage } = config

    const sock = makeSocket(config)
    const { ev, ws, authState, generateMessageTag, sendNode, query, signalRepository, onUnexpectedError, sendUnifiedSession, registerSocketEndHandler } = sock

    const getLIDForPN = signalRepository.lidMapping.getLIDForPN.bind(signalRepository.lidMapping)

    let privacySettings
    /** Server-assigned AB props for protocol behavior. */
    const serverProps = {
        /** AB prop 10518: gate tctoken on 1:1 messages. Default true (safe: avoids 463). */
        privacyTokenOn1to1: true,
        /** AB prop 9666: gate tctoken on profile picture IQs. WA Web default: true. */
        profilePicPrivacyToken: true,
        /** AB prop 14303: issue tctokens to LID instead of PN. WA Web default: false. */
        lidTrustedTokenIssueToLid: false
    }

    let syncState = SyncState.Connecting
    let awaitingSyncTimeout
    let historySyncPausedTimeout

    const historySyncStatus = { initialBootstrapComplete: false, recentSyncComplete: false }
    const blockedCollections = new Set()
    const appStateResyncCooldown = new Map()

    /** this mutex ensures that processing happens in order */
    const processingMutex = makeMutex()
    /** this mutex ensures that messages are processed in order */
    const messageMutex = makeMutex()
    /** this mutex ensures that receipts are processed in order */
    const receiptMutex = makeMutex()
    /** this mutex ensures that app state patches are processed in order */
    const appStatePatchMutex = makeMutex()
    /** this mutex ensures that notifications are processed in order */
    const notificationMutex = makeMutex()

    const placeholderResendCache = config.placeholderResendCache || new NodeCache({ stdTTL: DEFAULT_CACHE_TTLS.MSG_RETRY, useClones: false })
    if (!config.placeholderResendCache) config.placeholderResendCache = placeholderResendCache

    const profilePictureUrlCache = config.profilePictureUrlCache || new NodeCache({ stdTTL: DEFAULT_CACHE_TTLS.PROFILE_PIC, useClones: false })
    if (!config.profilePictureUrlCache) config.profilePictureUrlCache = profilePictureUrlCache

    const inFlightProfilePictureUrl = new Map()

    // ─── Key helpers ────────────────────────────────────────────────────────────

    const getAppStateSyncKey = async (keyId) => {
        const { [keyId]: key } = await authState.keys.get('app-state-sync-key', [keyId])
        return key
    }

    const interactiveQuery = async (userNodes, queryNode) => {
        const result = await query({ tag: 'iq', attrs: { to: S_WHATSAPP_NET, type: 'get', xmlns: 'usync' }, content: [{ tag: 'usync', attrs: { sid: generateMessageTag(), mode: 'query', last: 'true', index: '0', context: 'interactive' }, content: [{ tag: 'query', attrs: {}, content: [queryNode] }, { tag: 'list', attrs: {}, content: userNodes }] }] })
        const usyncNode = getBinaryNodeChild(result, 'usync')
        const listNode = getBinaryNodeChild(usyncNode, 'list')
        return getBinaryNodeChildren(listNode, 'user')
    }

    // ─── Privacy ──────────────────────────────────────────────────────────────

    const fetchPrivacySettings = async (force = false) => {
        if (!privacySettings || force) {
            const { content } = await query({ tag: 'iq', attrs: { xmlns: 'privacy', to: S_WHATSAPP_NET, type: 'get' }, content: [{ tag: 'privacy', attrs: {} }] })
            privacySettings = reduceBinaryNodeToDictionary(content?.[0], 'category')
        }
        return privacySettings
    }

    /** helper function to run a privacy IQ query */
    const privacyQuery = async (name, value) => {
        await query({ tag: 'iq', attrs: { xmlns: 'privacy', to: S_WHATSAPP_NET, type: 'set' }, content: [{ tag: 'privacy', attrs: {}, content: [{ tag: 'category', attrs: { name, value } }] }] })
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
        await query({ tag: 'iq', attrs: { xmlns: 'disappearing_mode', to: S_WHATSAPP_NET, type: 'set' }, content: [{ tag: 'disappearing_mode', attrs: { duration: duration.toString() } }] })
    }

    // ─── Queries ──────────────────────────────────────────────────────────────

    const getBotListV2 = async () => {
        const resp = await query({ tag: 'iq', attrs: { xmlns: 'bot', to: S_WHATSAPP_NET, type: 'get' }, content: [{ tag: 'bot', attrs: { v: '2' } }] })
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
        for (let jid of jids) {
            if (isLidUser(jid)) {
                const pn = await signalRepository.lidMapping.getPNForLID(jid)
                if (pn) {
                    jid = pn
                } else {
                    if (!contactEnabled) { contactEnabled = true; usyncQuery.withContactProtocol().withLIDProtocol() }
                    usyncQuery.withUser(new USyncUser().withId(jid))
                    continue
                }
            }
            if (!contactEnabled) { contactEnabled = true; usyncQuery.withContactProtocol().withLIDProtocol() }
            const phone = `+${jid.replace('+', '').split('@')[0].split(':')[0]}`
            usyncQuery.withUser(new USyncUser().withPhone(phone))
        }
        if (usyncQuery.users.length === 0) return []
        const results = await sock.executeUSyncQuery(usyncQuery)
        if (!results) return []
        return Promise.all(
            results.list
                .filter(a => a.contact === true && a.id && a.id !== 'undefined')
                .map(async ({ id, lid }) => {
                    try {
                        const businessProfile = await getBusinessProfile(id)
                        const isBusiness = businessProfile && Object.keys(businessProfile).length > 0
                        if (isBusiness) {
                            const { wid, ...businessInfo } = businessProfile
                            return { jid: id, exists: true, lid: lid || id, status: 'business', businessInfo }
                        }
                        return { jid: id, exists: true, lid: lid || id, status: 'regular' }
                    } catch (error) {
                        return { jid: id, exists: true, lid: lid || id, status: 'error', error: error?.message }
                    }
                })
        )
    }

    // ─── Profile ──────────────────────────────────────────────────────────────

    /** update the profile picture for yourself or a group */
    const updateProfilePicture = async (jid, content, dimensions) => {
        if (!jid) throw new Boom('Illegal no-jid profile update. Please specify either your ID or the ID of the chat you wish to update')
        const targetJid = jidNormalizedUser(jid) !== jidNormalizedUser(authState.creds.me.id) ? jidNormalizedUser(jid) : undefined
        const { img } = await generateProfilePicture(content, dimensions)
        await query({ tag: 'iq', attrs: { to: S_WHATSAPP_NET, type: 'set', xmlns: 'w:profile:picture', ...(targetJid ? { target: targetJid } : {}) }, content: [{ tag: 'picture', attrs: { type: 'image' }, content: img }] })
    }

    /** remove the profile picture for yourself or a group */
    const removeProfilePicture = async (jid) => {
        if (!jid) throw new Boom('Illegal no-jid profile update. Please specify either your ID or the ID of the chat you wish to update')
        const targetJid = jidNormalizedUser(jid) !== jidNormalizedUser(authState.creds.me.id) ? jidNormalizedUser(jid) : undefined
        await query({ tag: 'iq', attrs: { to: S_WHATSAPP_NET, type: 'set', xmlns: 'w:profile:picture', ...(targetJid ? { target: targetJid } : {}) } })
    }

    /** update the profile status for yourself */
    const updateProfileStatus = async (status) => {
        await query({ tag: 'iq', attrs: { to: S_WHATSAPP_NET, type: 'set', xmlns: 'status' }, content: [{ tag: 'status', attrs: {}, content: Buffer.from(status, 'utf-8') }] })
    }

    const updateProfileName = (name) => chatModify({ pushNameSetting: name }, '')

    const profilePictureUrl = async (jid, type = 'preview', timeoutMs) => {
        const normalizedJid = jidNormalizedUser(jid)
        const cacheKey = `${normalizedJid}:${type}`
        const cached = profilePictureUrlCache.get(cacheKey)
        if (typeof cached !== 'undefined') return cached || undefined
        const inFlight = inFlightProfilePictureUrl.get(cacheKey)
        if (inFlight) return inFlight
        const fetchPromise = (async () => {
            const isUserJid = isPnUser(normalizedJid) || isLidUser(normalizedJid)
            const me = authState.creds.me
            const isSelf = me && (normalizedJid === jidNormalizedUser(me.id) || (me.lid && normalizedJid === jidNormalizedUser(me.lid)))
            let tcTokenContent
            if (serverProps.profilePicPrivacyToken && isUserJid && !isSelf) {
                tcTokenContent = await buildTcTokenFromJid({ authState, jid: normalizedJid, getLIDForPN })
            }
            const picture = { tag: 'picture', attrs: { type, query: 'url' }, ...(tcTokenContent?.length ? { content: tcTokenContent } : {}) }
            const result = await query({ tag: 'iq', attrs: { target: normalizedJid, to: S_WHATSAPP_NET, type: 'get', xmlns: 'w:profile:picture' }, content: [picture] }, timeoutMs)
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

    // ─── Blocklist ────────────────────────────────────────────────────────────

    const fetchBlocklist = async () => {
        const result = await query({ tag: 'iq', attrs: { xmlns: 'blocklist', to: S_WHATSAPP_NET, type: 'get' } })
        const listNode = getBinaryNodeChild(result, 'list')
        return getBinaryNodeChildren(listNode, 'item').map(n => n.attrs.jid)
    }

    const updateBlockStatus = async (jid, action) => {
        const normalizedJid = jidNormalizedUser(jid)
        let lid
        let pn_jid
        if (isLidUser(normalizedJid) || isHostedLidUser(normalizedJid)) {
            lid = normalizedJid
            if (action === 'block') {
                const pn = await signalRepository.lidMapping.getPNForLID(normalizedJid)
                if (!pn) throw new Boom(`Unable to resolve PN JID for LID: ${jid}`, { statusCode: 400 })
                pn_jid = jidNormalizedUser(pn)
            }
        } else if (isPnUser(normalizedJid) || isHostedPnUser(normalizedJid)) {
            const mapped = await signalRepository.lidMapping.getLIDForPN(normalizedJid)
            if (!mapped) throw new Boom(`Unable to resolve LID for PN JID: ${jid}`, { statusCode: 400 })
            lid = mapped
            if (action === 'block') pn_jid = jidNormalizedUser(normalizedJid)
        } else {
            throw new Boom(`Invalid jid: ${jid}`, { statusCode: 400 })
        }
        const itemAttrs = { action, jid: lid }
        if (action === 'block') {
            if (!pn_jid) throw new Boom(`pn_jid required for block: ${jid}`, { statusCode: 400 })
            itemAttrs.pn_jid = pn_jid
        }
        await query({ tag: 'iq', attrs: { xmlns: 'blocklist', to: S_WHATSAPP_NET, type: 'set' }, content: [{ tag: 'item', attrs: itemAttrs }] })
    }

    const privacyMexQuery = (variables, queryId, dataPath) => executeWMexQuery(variables, queryId, dataPath, query, generateMessageTag)

    const updateTextStatus = (text, emoji = null) => {
        const input = { text }
        if (emoji) input.emoji = { content: emoji }
        return privacyMexQuery({ text_status_input: input }, PRIVACY_MEX_IDS.UPDATE_TEXT_STATUS, 'xwa2_text_status_update')
    }
    const getTextStatusList = (jids, lastUpdateTime = null) => privacyMexQuery({ input: jids.map(jid => ({ jid, last_update_time: lastUpdateTime })) }, PRIVACY_MEX_IDS.GET_TEXT_STATUS_LIST, 'xwa2_text_status_list')
    const fetchUserPictureInfo = jid => privacyMexQuery({ jid }, PRIVACY_MEX_IDS.FETCH_USER_PICTURE, 'xwa2_fetch_user_picture_info')
    const setProfilePictureMex = (imageBase64, type = 'image') => privacyMexQuery({ input: { image: imageBase64, type } }, PRIVACY_MEX_IDS.PROFILE_PICTURE_MUT, 'xwa2_profile_picture_mutation')
    const accountLogin = phoneNumber => privacyMexQuery({ input: { phone_number: phoneNumber } }, PRIVACY_MEX_IDS.ACCOUNT_LOGIN, 'xwa2_account_login')
    const accountLogout = (phoneNumber, enabledBiometric = false) => privacyMexQuery({ input: { phone_number: phoneNumber, enabled_biometric: enabledBiometric } }, PRIVACY_MEX_IDS.ACCOUNT_LOGOUT, 'xwa2_account_logout')
    const addMultiAccountLink = phoneNumber => privacyMexQuery({ input: { phone_number: phoneNumber } }, PRIVACY_MEX_IDS.ADD_MULTI_ACCOUNT, 'xwa2_add_multi_account_link')
    const revokeMultiAccount = accountJid => privacyMexQuery({ account_jid: accountJid }, PRIVACY_MEX_IDS.MULTI_ACCOUNT_REVOKE, 'xwa2_multi_account_revoke')
    const addTrustedDevice = (deviceId, deviceName) => privacyMexQuery({ device_id: deviceId, device_name: deviceName }, PRIVACY_MEX_IDS.ADD_TRUSTED_DEVICE, 'xwa2_add_trusted_device')
    const getTrustedDevices = () => privacyMexQuery({}, PRIVACY_MEX_IDS.GET_TRUSTED_DEVICES, 'xwa2_get_trusted_devices')
    const untrustTrustedDevice = (deviceId, reason = 'USER_INITIATED') => privacyMexQuery({ device_id: deviceId, reason }, PRIVACY_MEX_IDS.UNTRUST_DEVICE, 'xwa2_untrust_trusted_device')
    const deleteTrustedDevice = deviceId => privacyMexQuery({ device_id: deviceId }, PRIVACY_MEX_IDS.DELETE_TRUSTED_DEVICE, 'xwa2_delete_trusted_device')
    const fetchMobileConfig = (apiVersion = 0, epRefreshId = 0, flags = '') => privacyMexQuery({ api_version: apiVersion, ep_refresh_id: epRefreshId, flags }, PRIVACY_MEX_IDS.MOBILE_CONFIG_FETCH, 'xwa2_mobile_config_fetch')
    const notifyPushName = (groupJid, participants) => privacyMexQuery({ input: { group_jid: groupJid, participants: participants.map(({ jid, pushName }) => ({ jid, push_name: pushName })) } }, PRIVACY_MEX_IDS.NOTIFY_PUSH_NAME, 'xwa2_notify_push_name')
    const contactIntegrityQuery = (jids, useCase = 'START_CHAT_CONTEXT') => privacyMexQuery({ users: jids.map(jid => ({ jid })), use_case: useCase }, PRIVACY_MEX_IDS.CONTACT_INTEGRITY, 'xwa2_fetch_wa_users')
    const bizIntegrityQuery = jids => privacyMexQuery({ users: jids.map(jid => ({ jid })) }, PRIVACY_MEX_IDS.BIZ_INTEGRITY, 'xwa2_fetch_wa_users')
    const linkedProfilesSet = profiles => privacyMexQuery({ profiles: profiles.map(p => ({ type: p.type, ...(p.vid ? { vid: p.vid } : p.username ? { username: p.username } : {}) })) }, PRIVACY_MEX_IDS.LINKED_PROFILES_SET, 'xwa2_linked_profiles_set')
    const linkedProfilesRemove = types => privacyMexQuery({ profiles: types.map(type => ({ type })) }, PRIVACY_MEX_IDS.LINKED_PROFILES_REMOVE, 'xwa2_linked_profiles_remove')
    const linkedProfilesUpdate = profiles => privacyMexQuery({ profiles: profiles.map(({ type, showOnProfile }) => ({ type, show_on_profile: showOnProfile })) }, PRIVACY_MEX_IDS.LINKED_PROFILES_UPDATE, 'xwa2_linked_profiles_update')
    const migrateBlocklistLid = (jids, dhash = '', dirtyAck = true) => privacyMexQuery({ input: { blocklist: jids.map(jid => ({ jid })), dhash, dirty_ack: dirtyAck } }, PRIVACY_MEX_IDS.MIGRATE_BLOCKLIST_LID, 'xwa2_migrate_blocklist_lid')
    const qrCodeScan = qrData => privacyMexQuery({ qr_data: qrData }, PRIVACY_MEX_IDS.QR_CODE_SCAN, 'xwa2_qr_code_scan')

    // ─── Business ─────────────────────────────────────────────────────────────

    const getBusinessProfile = async (jid) => {
        const results = await query({ tag: 'iq', attrs: { to: 's.whatsapp.net', xmlns: 'w:biz', type: 'get' }, content: [{ tag: 'business_profile', attrs: { v: '244' }, content: [{ tag: 'profile', attrs: { jid } }] }] })
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

    // ─── App state ────────────────────────────────────────────────────────────

    const cleanDirtyBits = async (type, fromTimestamp) => {
        logger.info({ fromTimestamp }, 'clean dirty bits ' + type)
        await sendNode({ tag: 'iq', attrs: { to: S_WHATSAPP_NET, type: 'set', xmlns: 'urn:xmpp:whatsapp:dirty', id: generateMessageTag() }, content: [{ tag: 'clean', attrs: { type, ...(fromTimestamp ? { timestamp: fromTimestamp.toString() } : null) } }] })
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
                    nodes.push({ tag: 'collection', attrs: { name, version: state.version.toString(), return_snapshot: (shouldForceSnapshot || !state.version).toString() } })
                }

                const result = await query({ tag: 'iq', attrs: { to: S_WHATSAPP_NET, xmlns: 'w:sync:app:state', type: 'set' }, content: [{ tag: 'sync', attrs: {}, content: nodes }] })
                const decoded = await extractSyncdPatches(result, config?.options)

                for (const key in decoded) {
                    const name = key
                    const { patches, hasMorePatches, snapshot } = decoded[name]
                    try {
                        if (snapshot) {
                            const { state: newState, mutationMap } = await decodeSyncdSnapshot(name, snapshot, getCachedAppStateSyncKey, initialVersionMap[name], appStateMacVerification.snapshot, logger)
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
                        const logData = { name, attempt: attemptsMap[name], version: states[name].version, statusCode: error.output?.statusCode, errorType: error.name, error: error.stack }
                        if (isMissingKeyError(error) && attemptsMap[name] >= MAX_SYNC_ATTEMPTS) {
                            logger.warn(logData, `${name} blocked on missing key from v${states[name].version}, parking after ${attemptsMap[name]} attempts`)
                            blockedCollections.add(name)
                            collectionsToHandle.delete(name)
                            appStateResyncCooldown.set(name, Date.now() + APP_STATE_RESYNC_COOLDOWN_MS)
                        } else if (isMissingKeyError(error)) {
                            logger.info(logData, `${name} blocked on missing key from v${states[name].version}, retrying with snapshot`)
                            forceSnapshotCollections.add(name)
                        } else if (isAppStateSyncIrrecoverable(error, attemptsMap[name])) {
                            logger.warn(logData, `failed to sync ${name} from v${states[name].version}, giving up`)
                            collectionsToHandle.delete(name)
                        } else {
                            logger.info(logData, `failed to sync ${name} from v${states[name].version}, forcing snapshot retry`)
                            forceSnapshotCollections.add(name)
                        }
                    }
                }
            }
        }, authState?.creds?.me?.id || 'resync-app-state')

        const { onMutation } = newAppStateChunkHandler(isInitialSync)
        for (const key in globalMutationMap) onMutation(globalMutationMap[key])
    })

    // ─── Presence ─────────────────────────────────────────────────────────────

    const sendPresenceUpdate = async (type, toJid) => {
        const me = authState.creds.me
        const isAvailableType = type === 'available'
        if (isAvailableType || type === 'unavailable') {
            if (!me.name) { logger.warn('no name present, ignoring presence update request...'); return }
            ev.emit('connection.update', { isOnline: isAvailableType })
            if (isAvailableType) void sendUnifiedSession()
            await sendNode({ tag: 'presence', attrs: { name: me.name.replace(/@/g, ''), type } })
        } else {
            const { server } = jidDecode(toJid)
            const isLid = server === 'lid'
            await sendNode({ tag: 'chatstate', attrs: { from: isLid ? me.lid : me.id, to: toJid }, content: [{ tag: type === 'recording' ? 'composing' : type, attrs: type === 'recording' ? { media: 'audio' } : {} }] })
        }
    }

    /**
     * @param toJid the jid to subscribe to
     * @param tcToken token for subscription, use if present
     */
    const presenceSubscribe = async (toJid) => {
        const normalizedToJid = jidNormalizedUser(toJid)
        const isUserJid = isPnUser(normalizedToJid) || isLidUser(normalizedToJid)
        const tcTokenContent = isUserJid ? await buildTcTokenFromJid({ authState, jid: normalizedToJid, getLIDForPN }) : undefined
        return sendNode({ tag: 'presence', attrs: { to: toJid, id: generateMessageTag(), type: 'subscribe' }, content: tcTokenContent })
    }

    const handlePresenceUpdate = ({ tag, attrs, content }) => {
        let presence
        const jid = attrs.from
        const participant = attrs.participant || attrs.from
        if (shouldIgnoreJid(jid) && jid !== S_WHATSAPP_NET) return
        if (tag === 'presence') {
            presence = { lastKnownPresence: attrs.type === 'unavailable' ? 'unavailable' : 'available', lastSeen: attrs.last && attrs.last !== 'deny' ? +attrs.last : undefined, groupOnlineCount: attrs.count ? +attrs.count : undefined }
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

    // ─── App patch ────────────────────────────────────────────────────────────

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
                await query({ tag: 'iq', attrs: { to: S_WHATSAPP_NET, type: 'set', xmlns: 'w:sync:app:state' }, content: [{ tag: 'sync', attrs: {}, content: [{ tag: 'collection', attrs: { name, version: (state.version - 1).toString(), return_snapshot: 'false' }, content: [{ tag: 'patch', attrs: {}, content: proto.SyncdPatch.encode(patch).finish() }] }] }] })
                await authState.keys.set({ 'app-state-sync-version': { [name]: state } })
            }, authState?.creds?.me?.id || 'app-patch')
        })

        if (config.emitOwnEvents) {
            const { onMutation } = newAppStateChunkHandler(false)
            const { mutationMap } = await decodePatches(name, [{ ...encodeResult.patch, version: { version: encodeResult.state.version } }], initial, getAppStateSyncKey, config.options, undefined, logger)
            for (const key in mutationMap) onMutation(mutationMap[key])
        }
    }

    // ─── Props ────────────────────────────────────────────────────────────────

    /** fetch AB props */
    const fetchProps = async () => {
        const resultNode = await query({ tag: 'iq', attrs: { to: S_WHATSAPP_NET, xmlns: 'abt', type: 'get' }, content: [{ tag: 'props', attrs: { protocol: '1', ...(authState?.creds?.lastPropHash ? { hash: authState.creds.lastPropHash } : {}) } }] })
        const propsNode = getBinaryNodeChild(resultNode, 'props')
        let props = {}
        if (propsNode) {
            if (propsNode.attrs?.hash) {
                authState.creds.lastPropHash = propsNode?.attrs?.hash
                ev.emit('creds.update', authState.creds)
            }
            props = reduceBinaryNodeToDictionary(propsNode, 'prop')
        }
        const privacyTokenProp = props['10518'] ?? props['privacy_token_sending_on_all_1_on_1_messages']
        if (privacyTokenProp !== undefined) serverProps.privacyTokenOn1to1 = privacyTokenProp === 'true' || privacyTokenProp === '1'
        const profilePicProp = props['9666'] ?? props['profile_scraping_privacy_token_in_photo_iq']
        if (profilePicProp !== undefined) serverProps.profilePicPrivacyToken = profilePicProp === 'true' || profilePicProp === '1'
        const lidIssueProp = props['14303'] ?? props['lid_trusted_token_issue_to_lid']
        if (lidIssueProp !== undefined) serverProps.lidTrustedTokenIssueToLid = lidIssueProp === 'true' || lidIssueProp === '1'
        logger.debug({ serverProps }, 'fetched props')
        return props
    }

    // ─── Chat modification helpers ────────────────────────────────────────────

    /**
     * modify a chat -- mark unread, read etc.
     * lastMessages must be sorted in reverse chronologically
     * requires the last messages till the last message received; required for archive & unread
     */
    const chatModify = (mod, jid) => appPatch(chatModificationToAppPatch(mod, jid))
    /** Enable/Disable link preview privacy, not related to baileys link preview generation */
    const updateDisableLinkPreviewsPrivacy = (isPreviewsDisabled) => chatModify({ disableLinkPreviews: { isPreviewsDisabled } }, '')
    /** Star or Unstar a message */
    const star = (jid, messages, star) => chatModify({ star: { messages, star } }, jid)
    /** Add or Edit Contact */
    const addOrEditContact = (jid, contact) => chatModify({ contact }, jid)
    /** Remove Contact */
    const removeContact = (jid) => chatModify({ contact: null }, jid)
    /** Adds label */
    const addLabel = (jid, labels) => chatModify({ addLabel: { ...labels } }, jid)
    /** Adds label for the chats */
    const addChatLabel = (jid, labelId) => chatModify({ addChatLabel: { labelId } }, jid)
    /** Removes label for the chat */
    const removeChatLabel = (jid, labelId) => chatModify({ removeChatLabel: { labelId } }, jid)
    /** Adds label for the message */
    const addMessageLabel = (jid, messageId, labelId) => chatModify({ addMessageLabel: { messageId, labelId } }, jid)
    /** Removes label for the message */
    const removeMessageLabel = (jid, messageId, labelId) => chatModify({ removeMessageLabel: { messageId, labelId } }, jid)
    /** Add or Edit Quick Reply */
    const addOrEditQuickReply = (quickReply) => chatModify({ quickReply }, '')
    /** Remove Quick Reply */
    const removeQuickReply = (timestamp) => chatModify({ quickReply: { timestamp, deleted: true } }, '')

    // ─── Call link ────────────────────────────────────────────────────────────

    const createCallLink = async (type, event, timeoutMs) => {
        const result = await query({ tag: 'call', attrs: { id: generateMessageTag(), to: '@call' }, content: [{ tag: 'link_create', attrs: { media: type }, content: event ? [{ tag: 'event', attrs: { start_time: String(event.startTime) } }] : undefined }] }, timeoutMs)
        return getBinaryNodeChild(result, 'link_create')?.attrs?.token
    }

    // ─── Init ─────────────────────────────────────────────────────────────────

    /**
     * queries need to be fired on connection open
     * help ensure parity with WA Web
     */
    const executeInitQueries = () => Promise.all([fetchProps(), fetchBlocklist(), fetchPrivacySettings()])

    // ─── Message upsert ───────────────────────────────────────────────────────

    const upsertMessage = ev.createBufferedFunction(async (msg, type) => {
        ev.emit('messages.upsert', { messages: [msg], type })

        if (msg.pushName) {
            let jid = msg.key.fromMe ? authState.creds.me.id : msg.key.participant || msg.key.remoteJid
            jid = jidNormalizedUser(jid)
            if (!msg.key.fromMe) ev.emit('contacts.update', [{ id: jid, notify: msg.pushName, verifiedName: msg.verifiedBizName }])
            if (msg.key.fromMe && msg.pushName && authState.creds.me?.name !== msg.pushName) ev.emit('creds.update', { me: { ...authState.creds.me, name: msg.pushName } })
        }

        const historyMsg = getHistoryMsg(msg.message)
        const shouldProcessHistoryMsg = historyMsg
            ? !!historyMsg.mediaKey?.length && shouldSyncHistoryMessage(historyMsg) && PROCESSABLE_HISTORY_TYPES.includes(historyMsg.syncType)
            : false

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

        if (historyMsg && syncState === SyncState.AwaitingInitialSync) {
            if (awaitingSyncTimeout) { clearTimeout(awaitingSyncTimeout); awaitingSyncTimeout = undefined }
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
            processMessage(msg, { signalRepository, shouldProcessHistoryMsg, placeholderResendCache, ev, creds: authState.creds, keyStore: authState.keys, logger, options: config.options, getMessage })
        ])

        if (msg.message?.protocolMessage?.appStateSyncKeyShare) {
            if (blockedCollections.size > 0) {
                const collections = [...blockedCollections]
                blockedCollections.clear()
                logger.info({ collections }, 'app state sync key arrived via protocol message, re-syncing blocked collections')
                resyncAppState(collections, false).catch(error => onUnexpectedError(error, 'blocked collections resync on key share'))
            } else if (syncState === SyncState.Syncing) {
                logger.info('App state sync key arrived, triggering app state sync')
                await doAppStateSync()
            }
        }
    })

    // ─── WS handlers ──────────────────────────────────────────────────────────

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

    // ─── Event listeners ──────────────────────────────────────────────────────

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

        const willSyncHistory = shouldSyncHistoryMessage(proto.Message.HistorySyncNotification.create({ syncType: proto.HistorySync.HistorySyncType.RECENT }))

        if (!willSyncHistory) {
            logger.info('History sync is disabled by config, not waiting for notification. Transitioning to Online.')
            syncState = SyncState.Online
            setTimeout(() => ev.flush(), 0)
            return
        }

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

    ev.on('creds.update', ({ myAppStateKeyId }) => {
        if (!myAppStateKeyId || blockedCollections.size === 0) return
        if (syncState === SyncState.Syncing) { blockedCollections.clear(); return }
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

    registerSocketEndHandler(() => {
        if (awaitingSyncTimeout) { clearTimeout(awaitingSyncTimeout); awaitingSyncTimeout = undefined }
        if (!config.placeholderResendCache && placeholderResendCache.close) placeholderResendCache.close()
        syncState = SyncState.Connecting
        privacySettings = undefined
    })

    // ─── Return ───────────────────────────────────────────────────────────────

    return {
        ...sock,
        serverProps,
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
        placeholderResendCache,
        receiptMutex,
        addLabel,
        onWhatsApp,
        addChatLabel,
        removeChatLabel,
        addMessageLabel,
        removeMessageLabel,
        star,
        addOrEditQuickReply,
        removeQuickReply,
        updateTextStatus,
        getTextStatusList,
        fetchUserPictureInfo,
        setProfilePictureMex,
        accountLogin,
        accountLogout,
        addMultiAccountLink,
        revokeMultiAccount,
        addTrustedDevice,
        getTrustedDevices,
        untrustTrustedDevice,
        deleteTrustedDevice,
        fetchMobileConfig,
        notifyPushName,
        contactIntegrityQuery,
        bizIntegrityQuery,
        linkedProfilesSet,
        linkedProfilesRemove,
        linkedProfilesUpdate,
        migrateBlocklistLid,
        qrCodeScan
    }
}

export const checkStatusWA = async (phoneNumber) => {
    if (!phoneNumber) throw new Error('Please provide a phone number')

    const formattedNumber = (() => {
        let num = phoneNumber
        if (num.includes('@')) num = num.split('@')[0]
        if (num.includes(':')) num = num.split(':')[0]
        if (!num.startsWith('+')) num = '+' + num
        return num
    })()

    const { parsePhoneNumberWithError } = await import('libphonenumber-js')
    const { countryCallingCode: countryCode, nationalNumber } = parsePhoneNumberWithError(formattedNumber)
    const { mobileRegisterExists, getBanDetails } = await import('./registration.js')
    const { initAuthCreds } = await import('../Utils/index.js')

    const state = {
        creds: initAuthCreds(),
        keys: { get: async () => ({}), set: async () => { }, transaction: async (fn) => fn() }
    }

    const build = (status, isBanned, isNeedOfficialWa, banInfo = null) => ({ number: formattedNumber, status, isBanned, isNeedOfficialWa, banInfo })

    try {
        await mobileRegisterExists({ ...state.creds, phoneNumberCountryCode: countryCode, phoneNumberNationalNumber: nationalNumber })
        return build('active', false, false)
    } catch (err) {
        if (err?.appeal_token) {
            const banDetails = await getBanDetails(err.appeal_token)
            const appealStatus = banDetails?.status || null
            const banType = appealStatus === 'BANNED' ? 'permanent' : 'temporary'
            return build('banned', true, false, {
                banType,
                violationType: err.violation_type || null,
                violationReason: err.violation_type ? `Type ${err.violation_type}` : 'Unknown',
                canAppeal: banType !== 'permanent',
                appealToken: err.appeal_token,
                banTime: banDetails?.ban_time || null,
                banDate: banDetails?.ban_time ? new Date(banDetails.ban_time * 1000).toISOString() : null,
                appealStatus,
                appealCreatedAt: banDetails?.appeal_creation_time ? new Date(banDetails.appeal_creation_time * 1000).toISOString() : null
            })
        }
        if (err?.custom_block_screen) return build('blocked', false, true)
        if (err?.reason === 'incorrect') return build('active', false, false)
        if (err?.reason === 'temporarily_unavailable') return build('rate_limited', false, false)
        return build('error', false, false)
    }
}