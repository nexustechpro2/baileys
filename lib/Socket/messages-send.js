import NodeCache from '@cacheable/node-cache'
import { Boom } from '@hapi/boom'
import * as Utils from '../Utils/index.js'
import { proto } from '../../WAProto/index.js'
import { DEFAULT_CACHE_TTLS, WA_DEFAULT_EPHEMERAL } from '../Defaults/index.js'
import * as WABinary from '../WABinary/index.js'
import { getUrlInfo } from '../Utils/link-preview.js'
import { makeKeyedMutex } from '../Utils/make-mutex.js'
import { USyncQuery, USyncUser } from '../WAUSync/index.js'
import { makeNewsletterSocket } from './newsletter.js'
import NexusHandler from './nexus-handler.js'
import { randomBytes } from 'crypto'

const {
    aggregateMessageKeysNotFromMe, assertMediaContent, bindWaitForEvent, decryptMediaRetryData,
    encodeNewsletterMessage, encodeSignedDeviceIdentity, encodeWAMessage, encryptMediaRetryRequest,
    extractDeviceJids, generateMessageIDV2, generateParticipantHashV2, generateWAMessage,
    getStatusCodeForMediaRetry, getUrlFromDirectPath, getWAUploadToServer, MessageRetryManager,
    normalizeMessageContent, parseAndInjectE2ESessions, unixTimestampSeconds,
    generateWAMessageFromContent, delay
} = Utils

const {
    areJidsSameUser, getBinaryNodeChild, getBinaryNodeChildren, isHostedLidUser, isHostedPnUser,
    isJidGroup, isLidUser, isPnUser, jidDecode, jidEncode, jidNormalizedUser, S_WHATSAPP_NET,
    getBinaryFilteredButtons, STORIES_JID, isJidUser, getButtonArgs, getButtonType
} = WABinary

export const makeMessagesSocket = (config) => {
    const {
        logger, linkPreviewImageThumbnailWidth, generateHighQualityLinkPreview,
        options: httpRequestOptions, patchMessageBeforeSending, cachedGroupMetadata,
        enableRecentMessageCache, maxMsgRetryCount
    } = config

    const sock = makeNewsletterSocket(config)
    const { ev, authState, processingMutex, signalRepository, upsertMessage, query, fetchPrivacySettings, sendNode, groupMetadata, groupToggleEphemeral } = sock

    const userDevicesCache = config.userDevicesCache || new NodeCache({ stdTTL: DEFAULT_CACHE_TTLS.USER_DEVICES, useClones: false })
    const peerSessionsCache = new NodeCache({ stdTTL: DEFAULT_CACHE_TTLS.USER_DEVICES, useClones: false })
    const messageRetryManager = enableRecentMessageCache ? new MessageRetryManager(logger, maxMsgRetryCount) : null
    const encryptionMutex = makeKeyedMutex()
    let mediaConn

    // ===== MEDIA CONNECTION =====
    const refreshMediaConn = async (forceGet = false) => {
        const media = await mediaConn
        if (!media || forceGet || Date.now() - media.fetchDate.getTime() > media.ttl * 1000) {
            mediaConn = (async () => {
                const result = await query({ tag: 'iq', attrs: { type: 'set', xmlns: 'w:m', to: S_WHATSAPP_NET }, content: [{ tag: 'media_conn', attrs: {} }] })
                const mediaConnNode = getBinaryNodeChild(result, 'media_conn')
                return {
                    hosts: getBinaryNodeChildren(mediaConnNode, 'host').map(({ attrs }) => ({ hostname: attrs.hostname, maxContentLengthBytes: +attrs.maxContentLengthBytes })),
                    auth: mediaConnNode.attrs.auth, ttl: +mediaConnNode.attrs.ttl, fetchDate: new Date()
                }
            })()
            logger.debug('fetched media conn')
        }
        return mediaConn
    }

    // ===== RECEIPTS =====
    const sendReceipt = async (jid, participant, messageIds, type) => {
        if (!messageIds?.length) throw new Boom('missing ids in receipt')
        const node = { tag: 'receipt', attrs: { id: messageIds[0] } }
        const isReadReceipt = type === 'read' || type === 'read-self'
        if (isReadReceipt) node.attrs.t = unixTimestampSeconds().toString()
        if (type === 'sender' && (isPnUser(jid) || isLidUser(jid))) { node.attrs.recipient = jid; node.attrs.to = participant } 
        else { node.attrs.to = jid; if (participant) node.attrs.participant = participant }
        if (type) node.attrs.type = type
        if (messageIds.length > 1) node.content = [{ tag: 'list', attrs: {}, content: messageIds.slice(1).map(id => ({ tag: 'item', attrs: { id } })) }]
        logger.debug({ attrs: node.attrs, messageIds }, 'sending receipt')
        await sendNode(node)
    }

    const sendReceipts = async (keys, type) => {
        const recps = aggregateMessageKeysNotFromMe(keys)
        for (const { jid, participant, messageIds } of recps) await sendReceipt(jid, participant, messageIds, type)
    }

    const readMessages = async (keys) => {
        const privacySettings = await fetchPrivacySettings()
        await sendReceipts(keys, privacySettings.readreceipts === 'all' ? 'read' : 'read-self')
    }

    // ===== DEVICES & SESSIONS =====
    const getUSyncDevices = async (jids, useCache, ignoreZeroDevices) => {
        const deviceResults = []
        if (!useCache) logger.debug('not using cache for devices')

        const jidsWithUser = jids.map(jid => {
            const decoded = jidDecode(jid)
            const user = decoded?.user
            const device = decoded?.device
            if (typeof device === 'number' && device >= 0 && user) { deviceResults.push({ user, device, jid }); return null }
            return { jid: jidNormalizedUser(jid), user }
        }).filter(Boolean)

        let mgetDevices
        if (useCache && userDevicesCache.mget) mgetDevices = await userDevicesCache.mget(jidsWithUser.map(j => j?.user).filter(Boolean))

        const toFetch = []
        for (const { jid, user } of jidsWithUser) {
            if (useCache) {
                const devices = mgetDevices?.[user] || (userDevicesCache.mget ? undefined : await userDevicesCache.get(user))
                if (devices) { deviceResults.push(...devices.map(d => ({ ...d, jid: jidEncode(d.user, d.server, d.device) }))); logger.trace({ user }, 'using cache for devices') } 
                else toFetch.push(jid)
            } else toFetch.push(jid)
        }

        if (!toFetch.length) return deviceResults

        const requestedLidUsers = new Set()
        for (const jid of toFetch) if (isLidUser(jid) || isHostedLidUser(jid)) { const user = jidDecode(jid)?.user; if (user) requestedLidUsers.add(user) }

        const query = new USyncQuery().withContext('message').withDeviceProtocol().withLIDProtocol()
        for (const jid of toFetch) query.withUser(new USyncUser().withId(jid))

        const result = await sock.executeUSyncQuery(query)
        if (result) {
            const lidResults = result.list.filter(a => !!a.lid)
            if (lidResults.length > 0) { logger.trace('Storing LID maps from device call'); await signalRepository.lidMapping.storeLIDPNMappings(lidResults.map(a => ({ lid: a.lid, pn: a.id }))) }
            try {
                const lids = lidResults.map(a => a.lid)
                // Re-fetch sessions during device lookup to ensure fresh state
                if (lids.length) await assertSessions(lids, false)
            } catch (e) {
                logger.warn({ error: e, count: lidResults.length }, 'failed to assert sessions for newly mapped LIDs')
            }

            const extracted = extractDeviceJids(result?.list, authState.creds.me.id, authState.creds.me.lid, ignoreZeroDevices)
            const deviceMap = {}
            for (const item of extracted) { deviceMap[item.user] = deviceMap[item.user] || []; deviceMap[item.user]?.push(item) }

            for (const [user, userDevices] of Object.entries(deviceMap)) {
                const isLidUser = requestedLidUsers.has(user)
                for (const item of userDevices) {
                    const finalJid = isLidUser ? jidEncode(user, item.server, item.device) : jidEncode(item.user, item.server, item.device)
                    deviceResults.push({ ...item, jid: finalJid })
                }
            }

            if (userDevicesCache.mset) await userDevicesCache.mset(Object.entries(deviceMap).map(([key, value]) => ({ key, value })))
            else for (const key in deviceMap) if (deviceMap[key]) await userDevicesCache.set(key, deviceMap[key])

            const userDeviceUpdates = {}
            for (const [userId, devices] of Object.entries(deviceMap)) if (devices?.length > 0) userDeviceUpdates[userId] = devices.map(d => d.device?.toString() || '0')

            if (Object.keys(userDeviceUpdates).length > 0) {
                try {
                    const existingData = await authState.keys.get('device-list', ['_index'])
                    const currentBatch = existingData?.['_index'] || {}
                    const mergedBatch = { ...currentBatch, ...userDeviceUpdates }
                    const userKeys = Object.keys(mergedBatch).sort()
                    const trimmedBatch = {}
                    userKeys.slice(-500).forEach(userId => { trimmedBatch[userId] = mergedBatch[userId] })
                    await authState.keys.set({ 'device-list': { '_index': trimmedBatch } })
                    logger.debug({ userCount: Object.keys(userDeviceUpdates).length, batchSize: Object.keys(trimmedBatch).length }, 'stored user device lists')
                } catch (error) { logger.warn({ error }, 'failed to store user device lists') }
            }
        }
        return deviceResults
    }

    const assertSessions = async (jids, force) => {
    let didFetchNewSession = false
    const uniqueJids = [...new Set(jids)]
    const jidsRequiringFetch = []

    for (const jid of uniqueJids) {
        const signalId = signalRepository.jidToSignalProtocolAddress(jid)
        const cachedSession = peerSessionsCache.get(signalId)
        if (cachedSession !== undefined) { if (cachedSession && !force) continue }  // ← Add && !force
        else { const sessionValidation = await signalRepository.validateSession(jid); peerSessionsCache.set(signalId, sessionValidation.exists); if (sessionValidation.exists && !force) continue }  // ← Add && !force
        jidsRequiringFetch.push(jid)
    }

    if (jidsRequiringFetch.length) {
        const wireJids = [...jidsRequiringFetch.filter(jid => isLidUser(jid) || isHostedLidUser(jid)), ...(await signalRepository.lidMapping.getLIDsForPNs(jidsRequiringFetch.filter(jid => isPnUser(jid) || isHostedPnUser(jid))) || []).map(a => a.lid)]
        logger.debug({ jidsRequiringFetch, wireJids }, 'fetching sessions')
        const result = await query({ tag: 'iq', attrs: { xmlns: 'encrypt', type: 'get', to: S_WHATSAPP_NET }, content: [{ tag: 'key', attrs: {}, content: wireJids.map(jid => { const attrs = { jid }; if (force) attrs.reason = 'identity'; return { tag: 'user', attrs } }) }] })
        await parseAndInjectE2ESessions(result, signalRepository)
        didFetchNewSession = true
        for (const wireJid of wireJids) peerSessionsCache.set(signalRepository.jidToSignalProtocolAddress(wireJid), true)
    }
    return didFetchNewSession
}

    const sendPeerDataOperationMessage = async (pdoMessage) => {
        if (!authState.creds.me?.id) throw new Boom('Not authenticated')
        return await relayMessage(jidNormalizedUser(authState.creds.me.id), {
            protocolMessage: { peerDataOperationRequestMessage: pdoMessage, type: proto.Message.ProtocolMessage.Type.PEER_DATA_OPERATION_REQUEST_MESSAGE }
        }, { additionalAttributes: { category: 'peer', push_priority: 'high_force' }, additionalNodes: [{ tag: 'meta', attrs: { appdata: 'default' } }] })
    }

    const parseTCTokens = (result) => {
    const tokens = {}
    const tokenList = getBinaryNodeChild(result, 'tokens')
    if (tokenList) {
        const tokenNodes = getBinaryNodeChildren(tokenList, 'token')
        for (const node of tokenNodes) {
            const jid = node.attrs.jid
            const token = node.content
            if (jid && token) tokens[jid] = { token, timestamp: Number(unixTimestampSeconds()) }
        }
    }
    return tokens
}
    const updateMemberLabel = (jid, memberLabel) => {
         if (!memberLabel || typeof memberLabel !== 'string') throw new Error('Member label must be a non-empty string')
         if (!isJidGroup(jid)) throw new Error('Member labels can only be set in groups')
         return relayMessage(jid, { protocolMessage: { type: proto.Message.ProtocolMessage.Type.GROUP_MEMBER_LABEL_CHANGE, memberLabel: { label: memberLabel.slice(0, 30), labelTimestamp: unixTimestampSeconds() } } }, { additionalNodes: [{ tag: 'meta', attrs: { tag_reason: 'user_update', appdata: 'member_tag' }, content: undefined }] })
    }

    const createParticipantNodes = async (recipientJids, message, extraAttrs, dsmMessage) => {
        if (!recipientJids.length) return { nodes: [], shouldIncludeDeviceIdentity: false }
        const patched = await patchMessageBeforeSending(message, recipientJids)
        const patchedMessages = Array.isArray(patched) ? patched : recipientJids.map(jid => ({ recipientJid: jid, message: patched }))
        let shouldIncludeDeviceIdentity = false
        const meId = authState.creds.me.id
        const meLid = authState.creds.me?.lid
        const meLidUser = meLid ? jidDecode(meLid)?.user : null

        const encryptionPromises = patchedMessages.map(async ({ recipientJid: jid, message: patchedMessage }) => {
            try {
            if (!jid) return null
            let msgToEncrypt = patchedMessage
            if (dsmMessage) {
                const { user: targetUser } = jidDecode(jid)
                const { user: ownPnUser } = jidDecode(meId)
                const isOwnUser = targetUser === ownPnUser || (meLidUser && targetUser === meLidUser)
                const isExactSenderDevice = jid === meId || (meLid && jid === meLid)
                if (isOwnUser && !isExactSenderDevice) { msgToEncrypt = dsmMessage; logger.debug({ jid, targetUser }, 'Using DSM for own device') }
            }
            const bytes = encodeWAMessage(msgToEncrypt)
            return await encryptionMutex.mutex(jid, async () => {
                const { type, ciphertext } = await signalRepository.encryptMessage({ jid, data: bytes })
                if (type === 'pkmsg') shouldIncludeDeviceIdentity = true
                return { tag: 'to', attrs: { jid }, content: [{ tag: 'enc', attrs: { v: '2', type, ...(extraAttrs || {}) }, content: ciphertext }] }
            })
        } catch (err) {
            logger.error({jid, err }, 'Failed to encrypt for recipient')
            return null
        }
        })

        const nodes = (await Promise.all(encryptionPromises)).filter(Boolean)
        return { nodes, shouldIncludeDeviceIdentity }
    }

    // ===== MESSAGE HELPERS =====
    const getMessageType = (msg) => {
        const message = normalizeMessageContent(msg)
        if (message.pollCreationMessage || message.pollCreationMessageV2 || message.pollCreationMessageV3) return 'poll'
        if (message.reactionMessage) return 'reaction'
        if (message.eventMessage) return 'event'
        if (getMediaType(message)) return 'media'
        return 'text'
    }

    const getMediaType = (message) => {
        if (message.imageMessage) return 'image'
        if (message.stickerMessage) return message.stickerMessage.isLottie ? '1p_sticker' : message.stickerMessage.isAvatar ? 'avatar_sticker' : 'sticker'
        if (message.videoMessage) return message.videoMessage.gifPlayback ? 'gif' : 'video'
        if (message.audioMessage) return message.audioMessage.ptt ? 'ptt' : 'audio'
        if (message.ptvMessage) return 'ptv'
        if (message.albumMessage) return 'collection'
        if (message.contactMessage) return 'vcard'
        if (message.documentMessage) return 'document'
        if (message.stickerPackMessage) return 'sticker_pack'
        if (message.contactsArrayMessage) return 'contact_array'
        if (message.locationMessage) return 'location'
        if (message.liveLocationMessage) return 'livelocation'
        if (message.listMessage) return 'list'
        if (message.listResponseMessage) return 'list_response'
        if (message.buttonsResponseMessage) return 'buttons_response'
        if (message.orderMessage) return 'order'
        if (message.productMessage) return 'product'
        if (message.interactiveResponseMessage) return 'native_flow_response'
        if (/https:\/\/wa\.me\/c\/\d+/.test(message.extendedTextMessage?.text)) return 'cataloglink'
        if (/https:\/\/wa\.me\/p\/\d+\/\d+/.test(message.extendedTextMessage?.text)) return 'productlink'
        if (message.extendedTextMessage?.matchedText || message.groupInviteMessage) return 'url'
    }

    // ===== RELAY MESSAGE =====
const relayMessage = async (jid, message, { messageId: msgId, participant, additionalAttributes, additionalNodes, useUserDevicesCache, useCachedGroupMetadata, statusJidList, quoted } = {}) => {
    const meId = authState.creds.me.id
    const meLid = authState.creds.me?.lid
    const isRetryResend = Boolean(participant?.jid)
    let shouldIncludeDeviceIdentity = isRetryResend
    let finalMsgId = msgId

    // Check if message is already in proper WAMessage format
    const hasProtoMessageType = Object.keys(message).some(key => key.endsWith('Message') || key === 'conversation')
    
    if (!hasProtoMessageType) {
        logger.debug({ jid }, 'relayMessage: auto-generating message from raw content')
        const generatedMsg = await generateWAMessage(jid, message, { logger, userJid: meId, getUrlInfo: text => getUrlInfo(text, { thumbnailWidth: linkPreviewImageThumbnailWidth, fetchOpts: { timeout: 3000, ...(httpRequestOptions || {}) }, logger, uploadImage: generateHighQualityLinkPreview ? waUploadToServer : undefined }), getProfilePicUrl: sock.profilePictureUrl, getCallLink: sock.createCallLink, upload: waUploadToServer, mediaCache: config.mediaCache, options: config.options, messageId: finalMsgId || generateMessageIDV2(meId), quoted: quoted })
        message = generatedMsg.message
        if (!finalMsgId) finalMsgId = generatedMsg.key.id
        logger.debug({ msgId: finalMsgId, jid }, 'message auto-generated successfully')
    }

    const { user, server } = jidDecode(jid)
    const isGroup = server === 'g.us'
    const isStatus = jid === 'status@broadcast'
    const isLid = server === 'lid'
    const isNewsletter = server === 'newsletter'

    finalMsgId = finalMsgId || generateMessageIDV2(meId)
    useUserDevicesCache = useUserDevicesCache !== false
    useCachedGroupMetadata = useCachedGroupMetadata !== false && !isStatus

    const participants = []
    const destinationJid = !isStatus ? jid : 'status@broadcast'
    const binaryNodeContent = []
    const devices = []

    const meMsg = { deviceSentMessage: { destinationJid, message }, messageContextInfo: message.messageContextInfo }
    const extraAttrs = {}
    const messages = normalizeMessageContent(message)
    const buttonType = getButtonType(messages)

    if (participant) {
        if (!isGroup && !isStatus) additionalAttributes = { ...additionalAttributes, device_fanout: 'false' }
        const { user, device } = jidDecode(participant.jid)
        devices.push({ user, device, jid: participant.jid })
    }

    await authState.keys.transaction(async () => {
        const mediaType = getMediaType(message)
        if (mediaType) extraAttrs.mediatype = mediaType

        if (isNewsletter) {
            const patched = patchMessageBeforeSending ? await patchMessageBeforeSending(message, []) : message
            const bytes = encodeNewsletterMessage(patched)
            binaryNodeContent.push({ tag: 'plaintext', attrs: {}, content: bytes })
            const stanza = { tag: 'message', attrs: { to: jid, id: finalMsgId, type: getMessageType(message), ...(additionalAttributes || {}) }, content: binaryNodeContent }
            logger.debug({ msgId: finalMsgId }, `sending newsletter message to ${jid}`)
            await sendNode(stanza)
            return
        }

        if (messages.pinInChatMessage || messages.keepInChatMessage || message.reactionMessage || message.protocolMessage?.editedMessage) extraAttrs['decrypt-fail'] = 'hide'

        if (isGroup || isStatus) {
            const [groupData, senderKeyMap] = await Promise.all([
                (async () => {
                    let groupData = useCachedGroupMetadata && cachedGroupMetadata ? await cachedGroupMetadata(jid) : undefined
                    if (groupData?.participants) logger.trace({ jid, participants: groupData.participants.length }, 'using cached group metadata')
                    else if (!isStatus) groupData = await groupMetadata(jid)
                    return groupData
                })(),
                (async () => !participant && !isStatus ? (await authState.keys.get('sender-key-memory', [jid]))[jid] || {} : {})()
            ])

            if (!participant) {
                const participantsList = []
                if (isStatus) { if (statusJidList?.length) participantsList.push(...statusJidList) } 
                else {
                    let groupAddressingMode = 'lid'
                    if (groupData) { participantsList.push(...groupData.participants.map(p => p.id)); groupAddressingMode = groupData?.addressingMode || groupAddressingMode }
                    additionalAttributes = { ...additionalAttributes, addressing_mode: groupAddressingMode }
                }
                
                // DEVICE 0 PRESERVATION FOR GROUPS: Initialize device 0 for all participants
                const device0EntriesGroup = []
                for (const jid of participantsList) {
                    const { user, server } = jidDecode(jid)
                    if (user) {
                        device0EntriesGroup.push({ user, device: 0, jid: jidEncode(user, server, 0) })
                    }
                }
                
                const additionalDevices = await getUSyncDevices(participantsList, !!useUserDevicesCache, false)
                // Combine device 0 entries with fetched devices, avoiding duplicates
                const deviceMap = new Map()
                for (const d of device0EntriesGroup) deviceMap.set(`${d.user}:${d.device}`, d)
                for (const d of additionalDevices) {
                    const key = `${d.user}:${d.device}`
                    if (!deviceMap.has(key)) deviceMap.set(key, d)
                }
                devices.push(...Array.from(deviceMap.values()))
            }

            if (groupData?.ephemeralDuration > 0) additionalAttributes = { ...additionalAttributes, expiration: groupData.ephemeralDuration.toString() }

            const patched = await patchMessageBeforeSending(message)
            if (Array.isArray(patched)) throw new Boom('Per-jid patching not supported in groups')

            const bytes = encodeWAMessage(patched)
            const groupAddressingMode = additionalAttributes?.addressing_mode || groupData?.addressingMode || 'lid'
            const groupSenderIdentity = groupAddressingMode === 'lid' && meLid ? meLid : meId

            const { ciphertext, senderKeyDistributionMessage } = await signalRepository.encryptGroupMessage({ group: destinationJid, data: bytes, meId: groupSenderIdentity })

            const senderKeyRecipients = []
            for (const device of devices) {
                const deviceJid = device.jid
                const hasKey = !!senderKeyMap[deviceJid]
                if ((!hasKey || !!participant) && !isHostedLidUser(deviceJid) && !isHostedPnUser(deviceJid) && device.device !== 99) { senderKeyRecipients.push(deviceJid); senderKeyMap[deviceJid] = true }
            }

            // Assert sessions once for sender key recipients ONLY to avoid concurrent conflicts
            if (senderKeyRecipients.length) {
                logger.debug({ senderKeyJids: senderKeyRecipients }, 'sending sender key')
                const senderKeyMsg = { senderKeyDistributionMessage: { axolotlSenderKeyDistributionMessage: senderKeyDistributionMessage, groupId: destinationJid } }
                await assertSessions(senderKeyRecipients)
                const result = await createParticipantNodes(senderKeyRecipients, senderKeyMsg, extraAttrs)
                shouldIncludeDeviceIdentity = shouldIncludeDeviceIdentity || result.shouldIncludeDeviceIdentity
                participants.push(...result.nodes)
            }

            if (isRetryResend) {
                const { type, ciphertext: encryptedContent } = await signalRepository.encryptMessage({ data: bytes, jid: participant?.jid })
                binaryNodeContent.push({ tag: 'enc', attrs: { v: '2', type, count: participant.count.toString() }, content: encryptedContent })
            } else {
                binaryNodeContent.push({ tag: 'enc', attrs: { v: '2', type: 'skmsg', ...extraAttrs }, content: ciphertext })
                await authState.keys.set({ 'sender-key-memory': { [jid]: senderKeyMap } })
            }
        } else {
            let ownId = meId
            if (isLid && meLid) { ownId = meLid; logger.debug({ to: jid, ownId }, 'Using LID identity') }

            const { user: ownUser } = jidDecode(ownId)

            if (!participant) {
                const targetUserServer = isLid ? 'lid' : 's.whatsapp.net'
                devices.push({ user, device: 0, jid: jidEncode(user, targetUserServer, 0) })

                if (user !== ownUser) {
                    const ownUserServer = isLid ? 'lid' : 's.whatsapp.net'
                    const ownUserForAddressing = isLid && meLid ? jidDecode(meLid).user : jidDecode(meId).user
                    devices.push({ user: ownUserForAddressing, device: 0, jid: jidEncode(ownUserForAddressing, ownUserServer, 0) })
                }

                if (additionalAttributes?.category !== 'peer') {
                    // DEVICE 0 PRESERVATION: Save device 0 entries before refetch
                    const device0Entries = devices.filter(d => d.device === 0)
                    const senderOwnUser = device0Entries.find(d => d.user !== user)?.user
                    devices.length = 0
                    const senderIdentity = isLid && meLid ? jidEncode(jidDecode(meLid)?.user, 'lid', undefined) : jidEncode(jidDecode(meId)?.user, 's.whatsapp.net', undefined)
                    // Fetch both sender and recipient devices to ensure complete enumeration
                    const sessionDevices = await getUSyncDevices([senderIdentity, jid], true, false)
                    devices.push(...device0Entries, ...sessionDevices)
                    // If sender devices weren't enumerated, explicitly fetch them
                    if (senderOwnUser && !sessionDevices.some(d => d.user === senderOwnUser && d.device !== 0)) {
                        const senderDevices = await getUSyncDevices([senderIdentity], true, false)
                        const senderLinkedDevices = senderDevices.filter(d => d.device !== 0 && d.user === senderOwnUser)
                        if (senderLinkedDevices.length > 0) devices.push(...senderLinkedDevices)
                    }
                }
            }

            const allRecipients = [], meRecipients = [], otherRecipients = []
            const { user: mePnUser } = jidDecode(meId)
            const { user: meLidUser } = meLid ? jidDecode(meLid) : { user: null }

            for (const { user, jid } of devices) {
                const isExactSenderDevice = jid === meId || (meLid && jid === meLid)
                if (isExactSenderDevice) continue
                const isMe = user === mePnUser || user === meLidUser
                if (isMe) meRecipients.push(jid)
                else otherRecipients.push(jid)
                allRecipients.push(jid)
            }

            await assertSessions(allRecipients)

            const [{ nodes: meNodes, shouldIncludeDeviceIdentity: s1 }, { nodes: otherNodes, shouldIncludeDeviceIdentity: s2 }] = await Promise.all([
                createParticipantNodes(meRecipients, meMsg || message, extraAttrs),
                createParticipantNodes(otherRecipients, message, extraAttrs, meMsg)
            ])

            participants.push(...meNodes, ...otherNodes)
            if (meRecipients.length > 0 || otherRecipients.length > 0) extraAttrs.phash = generateParticipantHashV2([...meRecipients, ...otherRecipients])
            shouldIncludeDeviceIdentity = shouldIncludeDeviceIdentity || s1 || s2
        }

        if (participants.length) {
            if (additionalAttributes?.category === 'peer') { const peerNode = participants[0]?.content?.[0]; if (peerNode) binaryNodeContent.push(peerNode) } 
            else binaryNodeContent.push({ tag: 'participants', attrs: {}, content: participants })
        }

        const stanza = { tag: 'message', attrs: { id: finalMsgId, to: destinationJid, type: getMessageType(message), ...(additionalAttributes || {}) }, content: binaryNodeContent }

        if (participant) {
            if (isJidGroup(destinationJid)) { stanza.attrs.to = destinationJid; stanza.attrs.participant = participant.jid } 
            else if (areJidsSameUser(participant.jid, meId)) { stanza.attrs.to = participant.jid; stanza.attrs.recipient = destinationJid } 
            else stanza.attrs.to = participant.jid
        } else stanza.attrs.to = destinationJid

        let additionalAlready = false
        if (!isNewsletter && buttonType) {
            const buttonsNode = getButtonArgs(messages)
            const filteredButtons = getBinaryFilteredButtons(additionalNodes || [])
            if (filteredButtons) { stanza.content.push(...additionalNodes); additionalAlready = true } 
            else stanza.content.push(buttonsNode)
        }

        if (shouldIncludeDeviceIdentity) { stanza.content.push({ tag: 'device-identity', attrs: {}, content: encodeSignedDeviceIdentity(authState.creds.account, true) }); logger.debug({ jid }, 'adding device identity') }
        if (additionalNodes?.length > 0 && !additionalAlready) stanza.content.push(...additionalNodes)
            // Add TCToken support with expiration validation
             if (!isGroup && !isRetryResend && !isStatus) {
                 const contactTcTokenData = await authState.keys.get('tctoken', [destinationJid])
                 let tcTokenBuffer = contactTcTokenData[destinationJid]?.token
                 
                 // Check if token is expired
                 if (isTokenExpired(contactTcTokenData[destinationJid])) {
                     logger.debug({ jid: destinationJid }, 'tctoken expired, refreshing')
                     try {
                         const freshTokens = await getPrivacyTokens([destinationJid])
                         tcTokenBuffer = freshTokens[destinationJid]?.token
                     } catch (err) {
                         logger.warn({ jid: destinationJid, err }, 'failed to refresh expired tctoken')
                     }
                 }
                 
                 if (tcTokenBuffer) stanza.content.push({ tag: 'tctoken', attrs: {}, content: tcTokenBuffer })
             }

            logger.debug({ msgId }, `sending message to ${participants.length} devices`)
            await sendNode(stanza)
            if (messageRetryManager && !participant) messageRetryManager.addRecentMessage(destinationJid, msgId, message)
        }, meId)

        return {key: {remoteJid: jid, fromMe: true, id: finalMsgId, participant: isGroup ? authState.creds.me.id : undefined}, messageId: finalMsgId}
    }

           const TOKEN_EXPIRY_TTL = 24 * 60 * 60 // 24 hours in seconds
    
    const isTokenExpired = (tokenData) => {
        if (!tokenData || !tokenData.timestamp) return true
        const age = unixTimestampSeconds() - Number(tokenData.timestamp)
        return age > TOKEN_EXPIRY_TTL
    }
    
    const getPrivacyTokens = async (jids) => {
           const t = unixTimestampSeconds().toString()
           const result = await query({ tag: 'iq', attrs: { to: S_WHATSAPP_NET, type: 'set', xmlns: 'privacy' }, content: [{ tag: 'tokens', attrs: {}, content: jids.map(jid => ({ tag: 'token', attrs: { jid: jidNormalizedUser(jid), t, type: 'trusted_contact' } })) }] })
           const tokens = parseTCTokens(result)
           if (Object.keys(tokens).length > 0) await authState.keys.set({ 'tctoken': tokens })
           return tokens
       }

    const waUploadToServer = getWAUploadToServer(config, refreshMediaConn)
    const nexus = new NexusHandler(Utils, waUploadToServer, relayMessage, { logger, mediaCache: config.mediaCache, options: config.options, mediaUploadTimeoutMs: config.mediaUploadTimeoutMs, user: authState.creds.me })
    const waitForMsgMediaUpdate = bindWaitForEvent(ev, 'messages.media-update')

    return {
        ...sock,
        getPrivacyTokens, assertSessions, relayMessage, sendReceipt, sendReceipts, nexus, readMessages,
        refreshMediaConn, waUploadToServer, fetchPrivacySettings, sendPeerDataOperationMessage,
        createParticipantNodes, getUSyncDevices, messageRetryManager, updateMemberLabel,

        updateMediaMessage: async (message) => {
            const content = assertMediaContent(message.message)
            const mediaKey = content.mediaKey
            const meId = authState.creds.me.id
            const node = await encryptMediaRetryRequest(message.key, mediaKey, meId)
            let error
            await Promise.all([sendNode(node), waitForMsgMediaUpdate(async (update) => {
                const result = update.find(c => c.key.id === message.key.id)
                if (result) {
                    if (result.error) error = result.error
                    else {
                        try {
                            const media = await decryptMediaRetryData(result.media, mediaKey, result.key.id)
                            if (media.result !== proto.MediaRetryNotification.ResultType.SUCCESS) throw new Boom(`Media re-upload failed (${proto.MediaRetryNotification.ResultType[media.result]})`, { data: media, statusCode: getStatusCodeForMediaRetry(media.result) || 404 })
                            content.directPath = media.directPath
                            content.url = getUrlFromDirectPath(content.directPath)
                            logger.debug({ directPath: media.directPath, key: result.key }, 'media update successful')
                        } catch (err) { error = err }
                    }
                    return true
                }
            })])
            if (error) throw error
            ev.emit('messages.update', [{ key: message.key, update: { message: message.message } }])
            return message
        },

        sendStatusMentions: async (content, jids = []) => {
            const userJid = jidNormalizedUser(authState.creds.me.id)
            const allUsers = new Set([userJid])
            for (const id of jids) {
                if (isJidGroup(id)) { try { const metadata = await cachedGroupMetadata(id) || await groupMetadata(id); metadata.participants.forEach(p => allUsers.add(jidNormalizedUser(p.id))) } catch (error) { logger.error(`Error getting metadata for ${id}: ${error}`) } } 
                else if (isJidUser(id)) allUsers.add(jidNormalizedUser(id))
            }
            const uniqueUsers = Array.from(allUsers)
            const getRandomHex = () => '#' + Math.floor(Math.random() * 16777215).toString(16).padStart(6, '0')
            const isMedia = content.image || content.video || content.audio
            const isAudio = !!content.audio
            const msgContent = { ...content }
            if (isMedia && !isAudio) { if (msgContent.text) { msgContent.caption = msgContent.text; delete msgContent.text }; delete msgContent.ptt; delete msgContent.font; delete msgContent.backgroundColor; delete msgContent.textColor }
            if (isAudio) { delete msgContent.text; delete msgContent.caption; delete msgContent.font; delete msgContent.textColor }
            const font = !isMedia ? (content.font || Math.floor(Math.random() * 9)) : undefined
            const textColor = !isMedia ? (content.textColor || getRandomHex()) : undefined
            const backgroundColor = (!isMedia || isAudio) ? (content.backgroundColor || getRandomHex()) : undefined
            const ptt = isAudio ? (typeof content.ptt === 'boolean' ? content.ptt : true) : undefined
            let msg, mediaHandle
            try {
                msg = await generateWAMessage(STORIES_JID, msgContent, {
                    logger, userJid,
                    getUrlInfo: text => getUrlInfo(text, { thumbnailWidth: linkPreviewImageThumbnailWidth, fetchOpts: { timeout: 3000, ...(httpRequestOptions || {}) }, logger, uploadImage: generateHighQualityLinkPreview ? waUploadToServer : undefined }),
                    upload: async (encFilePath, opts) => { const up = await waUploadToServer(encFilePath, { ...opts }); mediaHandle = up.handle; return up },
                    mediaCache: config.mediaCache, options: config.options, font, textColor, backgroundColor, ptt
                })
            } catch (error) { logger.error(`Error generating message: ${error}`); throw error }
            await relayMessage(STORIES_JID, msg.message, { messageId: msg.key.id, statusJidList: uniqueUsers, additionalNodes: [{ tag: 'meta', attrs: {}, content: [{ tag: 'mentioned_users', attrs: {}, content: jids.map(jid => ({ tag: 'to', attrs: { jid: jidNormalizedUser(jid) } })) }] }] })
            for (const id of jids) {
                try {
                    const normalizedId = jidNormalizedUser(id)
                    const isPrivate = isJidUser(normalizedId)
                    const type = isPrivate ? 'statusMentionMessage' : 'groupStatusMentionMessage'
                    const protocolMessage = { [type]: { message: { protocolMessage: { key: msg.key, type: 25 } } }, messageContextInfo: { messageSecret: randomBytes(32) } }
                    const statusMsg = await generateWAMessageFromContent(normalizedId, protocolMessage, {})
                    await relayMessage(normalizedId, statusMsg.message, { additionalNodes: [{ tag: 'meta', attrs: isPrivate ? { is_status_mention: 'true' } : { is_group_status_mention: 'true' } }] })
                    await delay(2000)
                } catch (error) { logger.error(`Error sending to ${id}: ${error}`) }
            }
            return msg
        },

        sendPaymentMessage: (jid, data, quoted) => nexus.handlePayment({ requestPaymentMessage: data }, jid, quoted),
        sendProductMessage: (jid, data, quoted) => nexus.handleProduct({ productMessage: data }, jid, quoted),
        sendInteractiveMessage: (jid, data, quoted) => nexus.handleInteractive({ interactiveMessage: data }, jid, quoted),
        sendAlbumMessage: (jid, medias, quoted) => nexus.handleAlbum({ albumMessage: medias }, jid, quoted),
        sendEventMessage: (jid, data, quoted) => nexus.handleEvent({ eventMessage: data }, jid, quoted),
        sendPollResultMessage: (jid, data, quoted) => nexus.handlePollResult({ pollResultMessage: data }, jid, quoted),
        sendStatusMentionMessage: (jid, data, quoted) => nexus.handleStMention({ statusMentionMessage: data }, jid, quoted),
        sendOrderMessage: (jid, data, quoted) => nexus.handleOrderMessage({ orderMessage: data }, jid, quoted),
        sendGroupStatusMessage: (jid, data, quoted) => nexus.handleGroupStory({ groupStatus: data }, jid, quoted),
        sendCarouselMessage: (jid, data, quoted) => nexus.handleCarousel({ carouselMessage: data }, jid, quoted),
        sendCarouselProtoMessage: (jid, data, quoted) => nexus.handleCarouselProto({ carouselProto: data }, jid, quoted),
        stickerPackMessage: (jid, data, options) => nexus.handleStickerPack(data, jid, options?.quoted),

        sendMessage: async (jid, content, options = {}) => {
            const userJid = authState.creds.me.id
            const { quoted } = options
            
            if (content.interactive && !content.interactiveMessage) { const { interactive, ...rest } = content; content = { ...rest, interactiveMessage: interactive } }
            
            const messageType = nexus.detectType(content)
            if (messageType) return await nexus.processMessage(content, jid, quoted)

            if (content.disappearingMessagesInChat && isJidGroup(jid)) {
                const value = typeof content.disappearingMessagesInChat === 'boolean' ? (content.disappearingMessagesInChat ? WA_DEFAULT_EPHEMERAL : 0) : content.disappearingMessagesInChat
                await groupToggleEphemeral(jid, value)
                return
            }

            const fullMsg = await generateWAMessage(jid, content, {
                logger, userJid,
                getUrlInfo: text => getUrlInfo(text, { thumbnailWidth: linkPreviewImageThumbnailWidth, fetchOpts: { timeout: 3000, ...(httpRequestOptions || {}) }, logger, uploadImage: generateHighQualityLinkPreview ? waUploadToServer : undefined }),
                getProfilePicUrl: sock.profilePictureUrl, getCallLink: sock.createCallLink,
                upload: waUploadToServer, mediaCache: config.mediaCache, options: config.options,
                messageId: generateMessageIDV2(sock.user?.id), ...options
            })

            const additionalAttributes = {}, additionalNodes = []
            if (content.delete) additionalAttributes.edit = isJidGroup(content.delete?.remoteJid) && !content.delete?.fromMe ? '8' : '7'
            else if (content.edit) additionalAttributes.edit = '1'
            else if (content.pin) additionalAttributes.edit = '2'
            if (content.poll) additionalNodes.push({ tag: 'meta', attrs: { polltype: 'creation' } })
            if (content.event) additionalNodes.push({ tag: 'meta', attrs: { event_type: 'creation' } })

            // Auto-fetch TCToken for new contacts
             if (!isJidGroup(jid) && !content.disappearingMessagesInChat) {
                 const existingToken = await authState.keys.get('tctoken', [jid])
                 if (!existingToken[jid]) {
                     try { await getPrivacyTokens([jid]); logger.debug({ jid }, 'fetched tctoken for new contact') } 
                     catch (err) { logger.warn({ jid, err }, 'failed to fetch tctoken') }
                 }
             }

            await relayMessage(jid, fullMsg.message, {
                messageId: fullMsg.key.id, useCachedGroupMetadata: options.useCachedGroupMetadata,
                additionalAttributes, statusJidList: options.statusJidList, additionalNodes
            })

            if (config.emitOwnEvents) process.nextTick(() => { processingMutex.mutex(() => upsertMessage(fullMsg, 'append')) })
            return fullMsg
        }
    }
}