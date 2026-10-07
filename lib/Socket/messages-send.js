import NodeCache from '@cacheable/node-cache'
import { Boom } from '@hapi/boom'
import { randomBytes } from 'crypto'
import { proto } from '../../WAProto/index.js'
import { DEFAULT_CACHE_TTLS, WA_DEFAULT_EPHEMERAL } from '../Defaults/index.js'
import { getRandomHex } from '../Builders/index.js'
import {
    aggregateMessageKeysNotFromMe, assertMediaContent, bindWaitForEvent,
    buildMergedTcTokenIndexWrite, decryptMediaRetryData, delay,
    encodeNewsletterMessage, encodeSignedDeviceIdentity, encodeWAMessage,
    encryptMediaRetryRequest, extractDeviceJids, generateMessageIDV2,
    generateParticipantHashV2, generateWAMessage, generateWAMessageFromContent,
    getMessageReportingToken, getStatusCodeForMediaRetry, getUrlFromDirectPath,
    getUrlInfo, getWAUploadToServer, isTcTokenExpired, makeKeyedMutex,
    makeMutex, MessageRetryManager, normalizeMessageContent,
    parseAndInjectE2ESessions, preSeedTcToken, resolveIssuanceJid,
    resolveTcTokenJid, shouldIncludeReportingToken, shouldSendNewTcToken,
    storeTcTokensFromIqResult, unixTimestampSeconds,
} from '../Utils/index.js'
import {
    areJidsSameUser, getBinaryFilteredButtons, getBinaryNodeChild,
    getBinaryNodeChildren, getButtonArgs, getButtonType, isHostedLidUser,
    isHostedPnUser, isJidBot, isJidGroup, isJidMetaAI, isJidStatusBroadcast,
    isJidUser, isLidUser, isPnUser, jidDecode, jidEncode, jidNormalizedUser,
    S_WHATSAPP_NET, STORIES_JID, getBinaryFilteredBizBot,
} from '../WABinary/index.js'
import { USyncQuery, USyncUser } from '../WAUSync/index.js'
import { makeNewsletterSocket } from './newsletter.js'

export const makeMessagesSocket = (config) => {
    const { logger, linkPreviewImageThumbnailWidth, generateHighQualityLinkPreview, options: httpRequestOptions, patchMessageBeforeSending, cachedGroupMetadata, enableRecentMessageCache, maxMsgRetryCount, getMessage, aiLabel: configAiLabel } = config

    const sock = makeNewsletterSocket(config)
    const { ev, authState, processingMutex, signalRepository, upsertMessage, query, fetchPrivacySettings, sendNode, groupMetadata, groupToggleEphemeral, placeholderResendCache } = sock

    const userDevicesCache = config.userDevicesCache || new NodeCache({ stdTTL: DEFAULT_CACHE_TTLS.USER_DEVICES, useClones: false })
    const devicesMutex = makeMutex()
    const encryptionMutex = makeKeyedMutex()
    const mediaConnMutex = makeKeyedMutex()
    const messageRetryManager = enableRecentMessageCache ? new MessageRetryManager(logger, maxMsgRetryCount) : null
    const inFlightTcTokenIssuance = new Set()

    let mediaConn

    const refreshMediaConn = async (forceGet = false) => mediaConnMutex.mutex('media-conn', async () => {
        const media = await mediaConn
        if (!media || forceGet || Date.now() - media.fetchDate.getTime() > media.ttl * 1000) {
            mediaConn = (async () => {
                const result = await query({ tag: 'iq', attrs: { type: 'set', xmlns: 'w:m', to: S_WHATSAPP_NET }, content: [{ tag: 'media_conn', attrs: {} }] })
                const node = getBinaryNodeChild(result, 'media_conn')
                return { hosts: getBinaryNodeChildren(node, 'host').map(({ attrs }) => ({ hostname: attrs.hostname, maxContentLengthBytes: +attrs.maxContentLengthBytes })), auth: node.attrs.auth, ttl: +node.attrs.ttl, fetchDate: new Date() }
            })()
            logger.debug('fetched media conn')
        }
        return mediaConn
    })

    const waUploadToServer = getWAUploadToServer(config, refreshMediaConn)

    // ── Receipts ──────────────────────────────────────────────────────────────

    const sendReceipt = async (jid, participant, messageIds, type) => {
        if (!messageIds?.length) throw new Boom('missing ids in receipt')
        const node = { tag: 'receipt', attrs: { id: messageIds[0] } }
        const isReadType = type === 'read' || type === 'read-self'
        if (isReadType) node.attrs.t = unixTimestampSeconds().toString()
        if (isJidStatusBroadcast(jid) && !participant && getMessage) {
            try { const msg = await getMessage({ remoteJid: jid, id: messageIds[0], fromMe: false }); participant = msg?.key?.participant || msg?.participant || msg?.key?.remoteJid } catch (err) { logger.debug({ err, jid }, 'failed to resolve status receipt participant') }
        }
        if (type === 'sender' && (isPnUser(jid) || isLidUser(jid))) { node.attrs.recipient = jid; node.attrs.to = participant }
        else if (isJidStatusBroadcast(jid) && participant) { node.attrs.to = jid; node.attrs.participant = participant }
        else { node.attrs.to = jid; if (participant) node.attrs.participant = participant }
        if (type) node.attrs.type = type
        if (messageIds.length > 1) node.content = [{ tag: 'list', attrs: {}, content: messageIds.slice(1).map(id => ({ tag: 'item', attrs: { id } })) }]
        logger.debug({ attrs: node.attrs, messageIds }, 'sending receipt')
        await sendNode(node)
    }

    const sendReceipts = async (keys, type) => { for (const { jid, participant, messageIds } of aggregateMessageKeysNotFromMe(keys)) await sendReceipt(jid, participant, messageIds, type) }

    const readMessages = async (keys) => {
        const privacySettings = await fetchPrivacySettings()
        const hasStatusKey = keys.some(k => isJidStatusBroadcast(k.remoteJid))
        await sendReceipts(keys, hasStatusKey ? 'read' : (privacySettings.readreceipts === 'all' ? 'read' : 'read-self'))
    }

    // ── Device resolution ─────────────────────────────────────────────────────

    const getUSyncDevices = async (jids, useCache, ignoreZeroDevices) => {
        const deviceResults = []
        const jidsWithUser = jids.map(jid => {
            const { user, device } = jidDecode(jid) || {}
            if (typeof device === 'number' && device >= 0 && user) { deviceResults.push({ user, device, jid }); return null }
            return { jid: jidNormalizedUser(jid), user }
        }).filter(Boolean)

        let mgetDevices
        if (useCache && userDevicesCache.mget) mgetDevices = await userDevicesCache.mget(jidsWithUser.map(j => j?.user).filter(Boolean))

        const toFetch = []
        for (const { jid, user } of jidsWithUser) {
            if (useCache) {
                const devices = mgetDevices?.[user] || (userDevicesCache.mget ? undefined : await userDevicesCache.get(user))
                if (devices) deviceResults.push(...devices.map(d => ({ ...d, jid: jidEncode(d.user, d.server, d.device) })))
                else toFetch.push(jid)
            } else {
                toFetch.push(jid)
            }
        }

        if (!toFetch.length) return deviceResults

        const requestedLidUsers = new Set()
        for (const jid of toFetch) { const user = jidDecode(jid)?.user; if ((isLidUser(jid) || isHostedLidUser(jid)) && user) requestedLidUsers.add(user) }

        const usyncQuery = new USyncQuery().withContext('message').withDeviceProtocol().withLIDProtocol()
        for (const jid of toFetch) usyncQuery.withUser(new USyncUser().withId(jid))

        const result = await sock.executeUSyncQuery(usyncQuery)
        if (result) {
            const lidResults = result.list.filter(a => !!a.lid)
            if (lidResults.length > 0) {
                await signalRepository.lidMapping.storeLIDPNMappings(lidResults.map(a => ({ lid: a.lid, pn: a.id })))
                try { if (lidResults.length) await assertSessions(lidResults.map(a => a.lid), true) } catch (e) { logger.warn({ error: e, count: lidResults.length }, 'failed to assert sessions for newly mapped LIDs') }
            }

            const extracted = extractDeviceJids(result.list, authState.creds.me.id, authState.creds.me.lid, ignoreZeroDevices)
            const deviceMap = {}
            for (const item of extracted) { deviceMap[item.user] = deviceMap[item.user] || []; deviceMap[item.user].push(item) }

            for (const [user, userDevices] of Object.entries(deviceMap)) {
                const isLid = requestedLidUsers.has(user)
                for (const item of userDevices) deviceResults.push({ ...item, jid: jidEncode(isLid ? user : item.user, item.server, item.device) })
            }

            await devicesMutex.mutex(async () => {
                if (userDevicesCache.mset) await userDevicesCache.mset(Object.entries(deviceMap).map(([key, value]) => ({ key, value })))
                else for (const key in deviceMap) if (deviceMap[key]) await userDevicesCache.set(key, deviceMap[key])
            })

            const userDeviceUpdates = {}
            for (const [userId, devices] of Object.entries(deviceMap)) if (devices?.length > 0) userDeviceUpdates[userId] = devices.map(d => d.device?.toString() || '0')
            if (Object.keys(userDeviceUpdates).length > 0) { try { await authState.keys.set({ 'device-list': userDeviceUpdates }) } catch (error) { logger.warn({ error }, 'failed to store user device lists') } }
        }
        return deviceResults
    }

    const assertSessions = async (jids, force) => {
        let jidsRequiringFetch = []
        if (force) { jidsRequiringFetch = jids }
        else {
            const signalIds = jids.map(jid => signalRepository.jidToSignalProtocolAddress(jid))
            const sessionBatch = await authState.keys.get('session', signalIds)
            for (let i = 0; i < jids.length; i++) if (!sessionBatch[signalIds[i]]) jidsRequiringFetch.push(jids[i])
        }
        if (!jidsRequiringFetch.length) return false
        const pnJids = jidsRequiringFetch.filter(jid => isPnUser(jid) || isHostedPnUser(jid))
        const mappedLids = (await signalRepository.lidMapping.getLIDsForPNs(pnJids)) || []
        const wireJids = [...jidsRequiringFetch.filter(jid => isLidUser(jid) || isHostedLidUser(jid)), ...mappedLids.map(a => a.lid)]
        logger.debug({ jidsRequiringFetch, wireJids }, 'fetching sessions')
        const result = await query({ tag: 'iq', attrs: { xmlns: 'encrypt', type: 'get', to: S_WHATSAPP_NET }, content: [{ tag: 'key', attrs: {}, content: wireJids.map(jid => ({ tag: 'user', attrs: { jid, ...(force ? { reason: 'identity' } : {}) } })) }] })
        await parseAndInjectE2ESessions(result, signalRepository)
        return true
    }

    // ── Privacy tokens ────────────────────────────────────────────────────────

    const issuePrivacyTokens = async (jids, timestamp) => {
        const t = (timestamp ?? unixTimestampSeconds()).toString()
        return query({ tag: 'iq', attrs: { to: S_WHATSAPP_NET, type: 'set', xmlns: 'privacy' }, content: [{ tag: 'tokens', attrs: {}, content: jids.map(jid => ({ tag: 'token', attrs: { jid: jidNormalizedUser(jid), t, type: 'trusted_contact' } })) }] })
    }

    const getPrivacyTokens = async (jids) => {
        const t = unixTimestampSeconds().toString()
        const result = await query({ tag: 'iq', attrs: { to: S_WHATSAPP_NET, type: 'set', xmlns: 'privacy' }, content: [{ tag: 'tokens', attrs: {}, content: jids.map(jid => ({ tag: 'token', attrs: { jid: jidNormalizedUser(jid), t, type: 'trusted_contact' } })) }] })
        const tokens = {}
        const list = getBinaryNodeChild(result, 'tokens')
        if (list) for (const node of getBinaryNodeChildren(list, 'token')) { const { jid, content } = { jid: node.attrs.jid, content: node.content }; if (jid && content) tokens[jid] = { token: content, timestamp: Number(unixTimestampSeconds()) } }
        if (Object.keys(tokens).length > 0) await authState.keys.set({ tctoken: tokens })
        return tokens
    }

    // ── Protocol helpers ──────────────────────────────────────────────────────

    const sendPeerDataOperationMessage = async (pdoMessage) => {
        if (!authState.creds.me?.id) throw new Boom('Not authenticated')
        return relayMessage(jidNormalizedUser(authState.creds.me.id), { protocolMessage: { peerDataOperationRequestMessage: pdoMessage, type: proto.Message.ProtocolMessage.Type.PEER_DATA_OPERATION_REQUEST_MESSAGE } }, { additionalAttributes: { category: 'peer', push_priority: 'high_force' }, additionalNodes: [{ tag: 'meta', attrs: { appdata: 'default' } }] })
    }

    const updateMemberLabel = (jid, memberLabel) => {
        if (!memberLabel || typeof memberLabel !== 'string') throw new Error('Member label must be a non-empty string')
        if (!isJidGroup(jid)) throw new Error('Member labels can only be set in groups')
        return relayMessage(jid, { protocolMessage: { type: proto.Message.ProtocolMessage.Type.GROUP_MEMBER_LABEL_CHANGE, memberLabel: { label: memberLabel.slice(0, 30), labelTimestamp: unixTimestampSeconds() } } }, { additionalNodes: [{ tag: 'meta', attrs: { tag_reason: 'user_update', appdata: 'member_tag' }, content: undefined }] })
    }

    // ── Message type helpers ──────────────────────────────────────────────────

    const getMediaType = (message) => {
        const inner = message.viewOnceMessage?.message || message.viewOnceMessageV2?.message || message.viewOnceMessageV2Extension?.message
        if (inner) return getMediaType(inner)
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

    const getMessageType = (msg) => {
        const message = normalizeMessageContent(msg)
        if (!message) return 'text'
        if (message.pollCreationMessage || message.pollCreationMessageV2 || message.pollCreationMessageV3 || message.pollCreationMessageV5 || message.pollCreationMessageV6 || message.pollUpdateMessage) return 'poll'
        if (message.reactionMessage || message.encReactionMessage) return 'reaction'
        if (message.eventMessage) return 'event'
        if (getMediaType(message)) return 'media'
        return 'text'
    }

    const getUrlInfoFn = (text) => getUrlInfo(text, { thumbnailWidth: linkPreviewImageThumbnailWidth, fetchOpts: { timeout: 4000, ...(httpRequestOptions || {}) }, logger, uploadImage: generateHighQualityLinkPreview ? waUploadToServer : undefined })

    // ── Encryption ────────────────────────────────────────────────────────────

    const createParticipantNodes = async (recipientJids, message, extraAttrs, dsmMessage) => {
        if (!recipientJids.length) return { nodes: [], shouldIncludeDeviceIdentity: false }
        if (typeof signalRepository.preLoadKeys === 'function') await signalRepository.preLoadKeys(recipientJids)
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
            } catch (err) { logger.warn({ jid, err: err?.message || err }, 'Failed to encrypt for recipient — no session'); return null }
        })

        const nodes = (await Promise.all(encryptionPromises)).filter(Boolean)
        if (recipientJids.length > 0 && nodes.length === 0) throw new Boom('All encryptions failed', { statusCode: 500 })
        return { nodes, shouldIncludeDeviceIdentity }
    }

    // ── relayMessage ──────────────────────────────────────────────────────────

    const relayMessage = async (jid, message, { messageId: msgId, participant, additionalAttributes, additionalNodes, useUserDevicesCache, useCachedGroupMetadata, statusJidList, quoted, deliveryMode = 'toAll', aiLabel: msgAiLabel, ai: msgAi } = {} = {} = {} = {}) => {
        jid = jidNormalizedUser(jid)
        const meId = authState.creds.me.id
        const meLid = authState.creds.me?.lid
        const { user, server } = jidDecode(jid)
        const isGroup = server === 'g.us'
        const isStatus = isJidStatusBroadcast(jid)
        const isLid = server === 'lid'
        const isNewsletter = server === 'newsletter'

        let activeSender = meId
        let groupAddressingMode = 'pn'
        if (isGroup && !isStatus) {
            const groupData = useCachedGroupMetadata && cachedGroupMetadata ? await cachedGroupMetadata(jid) : undefined
            groupAddressingMode = additionalAttributes?.addressing_mode || groupData?.addressingMode || 'lid'
            if (groupAddressingMode === 'lid' && meLid) activeSender = meLid
        } else if (isLid && meLid) {
            activeSender = meLid
        }

        const isRetryResend = Boolean(participant?.jid)
        let shouldIncludeDeviceIdentity = isRetryResend
        let finalMsgId = msgId

        const hasProtoMessage = Object.keys(message).some(k => k.endsWith('Message') || k === 'conversation')
        if (!hasProtoMessage) {
            const generatedMsg = await generateWAMessage(jid, message, { logger, userJid: jidNormalizedUser(activeSender), getUrlInfo: getUrlInfoFn, getProfilePicUrl: sock.profilePictureUrl, getCallLink: sock.createCallLink, upload: waUploadToServer, mediaCache: config.mediaCache, options: config.options, messageId: finalMsgId || generateMessageIDV2(activeSender), quoted })
            message = generatedMsg.message
            if (!finalMsgId) finalMsgId = generatedMsg.key.id
        }

        finalMsgId = finalMsgId || generateMessageIDV2(activeSender)
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
        let hasDeviceFanoutFalse = false

        if (participant) {
            if (!isGroup && !isStatus) hasDeviceFanoutFalse = true
            const { user, device } = jidDecode(participant.jid)
            devices.push({ user, device, jid: participant.jid })
        }

        await authState.keys.transaction(async () => {
            const mediaType = getMediaType(message)
            if (mediaType) extraAttrs.mediatype = mediaType

            if (isNewsletter) {
                const patched = patchMessageBeforeSending ? await patchMessageBeforeSending(message, []) : message
                binaryNodeContent.push({ tag: 'plaintext', attrs: {}, content: encodeNewsletterMessage(patched) })
                await sendNode({ tag: 'message', attrs: { to: jid, id: finalMsgId, type: getMessageType(message), ...(additionalAttributes || {}) }, content: binaryNodeContent })
                return
            }

            if (messages?.pinInChatMessage || messages?.keepInChatMessage || message.reactionMessage || message.protocolMessage?.editedMessage) extraAttrs['decrypt-fail'] = 'hide'

            if ((isGroup || isStatus) && !isRetryResend) {
                const groupData = await (async () => { let data = useCachedGroupMetadata && cachedGroupMetadata ? await cachedGroupMetadata(jid) : undefined; if (!data && !isStatus) data = await groupMetadata(jid); return data })()
                const participantsList = []

                if (isStatus) {
                    if (statusJidList?.length) participantsList.push(...statusJidList.map(j => jidNormalizedUser(j)).filter(j => jidDecode(j)?.user !== jidDecode(meId)?.user))
                } else {
                    if (groupData) { participantsList.push(...groupData.participants.map(p => p.id)); groupAddressingMode = groupData.addressingMode || groupAddressingMode }
                    additionalAttributes = { ...additionalAttributes, addressing_mode: groupAddressingMode }
                }

                if (groupData?.ephemeralDuration > 0) additionalAttributes = { ...additionalAttributes, expiration: groupData.ephemeralDuration.toString() }

                const additionalDevices = await getUSyncDevices(participantsList, !!useUserDevicesCache, false)
                devices.push(...additionalDevices)

                // Force device 0 — USync can omit it for LID groups
                for (const pJid of participantsList) { const decoded = jidDecode(pJid); if (decoded?.user && !devices.some(d => d.user === decoded.user && d.device === 0)) devices.push({ user: decoded.user, device: 0, server: decoded.server, domainType: decoded.domainType, jid: jidEncode(decoded.user, decoded.server, 0) }) }

                const patched = await patchMessageBeforeSending(message)
                if (Array.isArray(patched)) throw new Boom('Per-jid patching not supported in groups')

                const bytes = encodeWAMessage(patched)
                const gAddressingMode = additionalAttributes?.addressing_mode || groupAddressingMode
                const gSenderIdentity = gAddressingMode === 'lid' && meLid ? meLid : meId
                const { ciphertext, senderKeyDistributionMessage } = await signalRepository.encryptGroupMessage({ group: destinationJid, data: bytes, meId: gSenderIdentity })

                const senderKeyRecipients = devices.filter(d => !isHostedLidUser(d.jid) && !isHostedPnUser(d.jid) && d.device !== 99).map(d => d.jid)
                if (senderKeyRecipients.length) {
                    const senderKeyMsg = { senderKeyDistributionMessage: { axolotlSenderKeyDistributionMessage: senderKeyDistributionMessage, groupId: destinationJid } }
                    await assertSessions(senderKeyRecipients)
                    const result = await createParticipantNodes(senderKeyRecipients, senderKeyMsg, extraAttrs)
                    shouldIncludeDeviceIdentity = shouldIncludeDeviceIdentity || result.shouldIncludeDeviceIdentity
                    participants.push(...result.nodes)
                }

                binaryNodeContent.push({ tag: 'enc', attrs: { v: '2', type: 'skmsg', ...extraAttrs }, content: ciphertext })

            } else if ((isGroup || isStatus) && isRetryResend) {
                const groupData = useCachedGroupMetadata && cachedGroupMetadata ? await cachedGroupMetadata(jid) : undefined
                if (!groupData && !isStatus) await groupMetadata(jid)
                if (groupData?.ephemeralDuration > 0) additionalAttributes = { ...additionalAttributes, expiration: groupData.ephemeralDuration.toString() }
                additionalAttributes = { ...additionalAttributes, addressing_mode: groupData?.addressingMode || 'lid' }

                const patched = await patchMessageBeforeSending(message)
                if (Array.isArray(patched)) throw new Boom('Per-jid patching not supported in groups')

                const bytes = encodeWAMessage(patched)
                const gAddressingMode = additionalAttributes?.addressing_mode || groupData?.addressingMode || 'lid'
                const gSenderIdentity = gAddressingMode === 'lid' && meLid ? meLid : meId
                const { ciphertext, senderKeyDistributionMessage } = await signalRepository.encryptGroupMessage({ group: destinationJid, data: bytes, meId: gSenderIdentity })

                const senderKeyMsg = { senderKeyDistributionMessage: { axolotlSenderKeyDistributionMessage: senderKeyDistributionMessage, groupId: destinationJid } }
                await assertSessions([participant.jid])
                const skResult = await createParticipantNodes([participant.jid], senderKeyMsg, {})
                shouldIncludeDeviceIdentity = shouldIncludeDeviceIdentity || skResult.shouldIncludeDeviceIdentity
                participants.push(...skResult.nodes)

                const isParticipantLid = isLidUser(participant.jid)
                const isMe = areJidsSameUser(participant.jid, isParticipantLid ? meLid : meId)
                const encodedMsg = isMe ? encodeWAMessage({ deviceSentMessage: { destinationJid, message } }) : encodeWAMessage(message)
                const { type, ciphertext: encryptedContent } = await signalRepository.encryptMessage({ data: encodedMsg, jid: participant.jid })
                binaryNodeContent.push({ tag: 'enc', attrs: { v: '2', type, count: participant.count.toString() }, content: encryptedContent })

            } else {
                const ownId = isLid && meLid ? meLid : meId
                const { user: ownUser } = jidDecode(ownId)
                const targetUserServer = isLid ? 'lid' : 's.whatsapp.net'

                devices.push({ user, device: 0, jid: jidEncode(user, targetUserServer, 0) })
                if (user !== ownUser) {
                    const ownUserServer = isLid ? 'lid' : 's.whatsapp.net'
                    const ownUserForAddressing = isLid && meLid ? jidDecode(meLid).user : jidDecode(meId).user
                    devices.push({ user: ownUserForAddressing, device: 0, jid: jidEncode(ownUserForAddressing, ownUserServer, 0) })
                }

                if (!participant && additionalAttributes?.category !== 'peer') {
                    const device0Entries = devices.filter(d => d.device === 0)
                    const senderOwnUser = device0Entries.find(d => d.user !== user)?.user
                    devices.length = 0
                    const senderIdentity = isLid && meLid ? jidEncode(jidDecode(meLid)?.user, 'lid', undefined) : jidEncode(jidDecode(meId)?.user, 's.whatsapp.net', undefined)
                    const sessionDevices = await getUSyncDevices([senderIdentity, jid], true, false)
                    const seenJids = new Set()
                    for (const d of [...device0Entries, ...sessionDevices]) { if (!seenJids.has(d.jid)) { seenJids.add(d.jid); devices.push(d) } }
                    if (senderOwnUser && !sessionDevices.some(d => d.user === senderOwnUser && d.device !== 0)) {
                        const senderDevices = await getUSyncDevices([senderIdentity], true, false)
                        devices.push(...senderDevices.filter(d => d.device !== 0 && d.user === senderOwnUser))
                    }
                }

                const meRecipients = [], otherRecipients = []
                const { user: mePnUser } = jidDecode(meId)
                const { user: meLidUser } = meLid ? jidDecode(meLid) : { user: null }

                for (const { user: devUser, jid: devJid } of devices) {
                    if (devJid === meId || (meLid && devJid === meLid)) continue
                    const isOwnUser = devUser === mePnUser || devUser === meLidUser
                    const isCompanion = devJid.includes(':')

                    if (deliveryMode === 'toMainOnly' && isCompanion) continue
                    if (deliveryMode === 'toRecipientMain' && !isOwnUser && isCompanion) continue
                    if (deliveryMode === 'toSelf' && !isOwnUser) continue
                    if (deliveryMode === 'toRecipient' && isOwnUser) continue
                    if (deliveryMode === 'toSelfMain' && (!isOwnUser || isCompanion)) continue
                    if (deliveryMode === 'toRecipientMainOnly' && (isOwnUser || isCompanion)) continue

                    if (isOwnUser) meRecipients.push(devJid); else otherRecipients.push(devJid)
                }

                await assertSessions([...meRecipients, ...otherRecipients])
                const [{ nodes: meNodes, shouldIncludeDeviceIdentity: s1 }, { nodes: otherNodes, shouldIncludeDeviceIdentity: s2 }] = await Promise.all([
                    createParticipantNodes(meRecipients, meMsg || message, extraAttrs),
                    createParticipantNodes(otherRecipients, message, extraAttrs, meMsg),
                ])
                participants.push(...meNodes, ...otherNodes)
                if (meRecipients.length > 0 || otherRecipients.length > 0) extraAttrs.phash = generateParticipantHashV2([...meRecipients, ...otherRecipients])
                shouldIncludeDeviceIdentity = shouldIncludeDeviceIdentity || s1 || s2
            }

            if (participants.length) {
                if (additionalAttributes?.category === 'peer') { const peerNode = participants[0]?.content?.[0]; if (peerNode) binaryNodeContent.push(peerNode) }
                else binaryNodeContent.push({ tag: 'participants', attrs: {}, content: participants })
            }

            const stanza = {
                tag: 'message',
                attrs: { id: finalMsgId, to: destinationJid, type: getMessageType(message), ...((isGroup && groupAddressingMode === 'lid') ? { addressing_mode: 'lid' } : {}), ...(hasDeviceFanoutFalse ? { device_fanout: 'false' } : {}), ...(additionalAttributes || {}) },
                content: binaryNodeContent,
            }

            if (participant) {
                if (isJidGroup(destinationJid)) { stanza.attrs.to = destinationJid; stanza.attrs.participant = participant.jid }
                else if (areJidsSameUser(participant.jid, meId)) { stanza.attrs.to = participant.jid; stanza.attrs.recipient = destinationJid }
                else stanza.attrs.to = participant.jid
            } else {
                stanza.attrs.to = destinationJid
            }

            let didPushAdditional = false
            if (!isNewsletter && buttonType && !isStatus) {
                const buttonsNode = getButtonArgs(messages)
                const filteredButtons = getBinaryFilteredButtons(additionalNodes || [])
                if (filteredButtons) { stanza.content.push(...additionalNodes); didPushAdditional = true }
                else stanza.content.push(...buttonsNode)
            }
            if (!didPushAdditional && additionalNodes?.length > 0) stanza.content.push(...additionalNodes)

            if ((shouldIncludeDeviceIdentity || (meLid && (isLid || (isGroup && groupAddressingMode === 'lid')))) && !isNewsletter) stanza.content.push({ tag: 'device-identity', attrs: {}, content: encodeSignedDeviceIdentity(authState.creds.account, true) })

            const isPeerMessage = additionalAttributes?.category === 'peer'
            const is1on1 = !isGroup && !isRetryResend && !isStatus && !isNewsletter && !isPeerMessage
            if (is1on1) {
                const getLIDForPN = signalRepository.lidMapping.getLIDForPN.bind(signalRepository.lidMapping)
                const tcTokenJid = await resolveTcTokenJid(destinationJid, getLIDForPN)
                const contactTcTokenData = await authState.keys.get('tctoken', [tcTokenJid])
                const existingEntry = contactTcTokenData[tcTokenJid]
                let tcTokenBuffer = existingEntry?.token

                if (tcTokenBuffer?.length && isTcTokenExpired(existingEntry?.timestamp)) {
                    tcTokenBuffer = undefined
                    const cleared = existingEntry?.senderTimestamp !== undefined ? { token: Buffer.alloc(0), senderTimestamp: existingEntry.senderTimestamp } : null
                    try { await authState.keys.set({ tctoken: { [tcTokenJid]: cleared } }) } catch (err) { logger.debug({ jid: destinationJid, err: err?.message }, 'failed to persist tctoken expiry cleanup') }
                }

                if (!tcTokenBuffer?.length && sock.serverProps?.privacyTokenOn1to1) {
                    try { const seeded = await preSeedTcToken({ authState, jid: destinationJid, getLIDForPN, logger }); tcTokenBuffer = seeded.token } catch (err) { logger.warn({ jid: destinationJid, err: err?.message }, 'local tctoken generation failed') }
                }

                if (tcTokenBuffer?.length && sock.serverProps?.privacyTokenOn1to1) stanza.content.push({ tag: 'tctoken', attrs: {}, content: tcTokenBuffer })

                const isProtocolMsg = !!normalizeMessageContent(message)?.protocolMessage
                const isBotOrPSA = isJidBot(destinationJid) || isJidMetaAI(destinationJid)
                if (!isProtocolMsg && !isBotOrPSA && shouldSendNewTcToken(existingEntry?.senderTimestamp) && !inFlightTcTokenIssuance.has(tcTokenJid)) {
                    inFlightTcTokenIssuance.add(tcTokenJid)
                    const issueTimestamp = unixTimestampSeconds()
                    const getPNForLID = signalRepository.lidMapping.getPNForLID.bind(signalRepository.lidMapping)
                    const issueToLid = sock.serverProps?.lidTrustedTokenIssueToLid ?? false
                    resolveIssuanceJid(destinationJid, issueToLid, getLIDForPN, getPNForLID)
                        .then(issueJid => issuePrivacyTokens([issueJid], issueTimestamp))
                        .then(async (result) => {
                            await storeTcTokensFromIqResult({ result, fallbackJid: tcTokenJid, keys: authState.keys, getLIDForPN })
                            const currentData = await authState.keys.get('tctoken', [tcTokenJid])
                            const currentEntry = currentData[tcTokenJid]
                            const indexWrite = await buildMergedTcTokenIndexWrite(authState.keys, [tcTokenJid])
                            await authState.keys.set({ tctoken: { [tcTokenJid]: { token: Buffer.alloc(0), ...currentEntry, senderTimestamp: issueTimestamp }, ...indexWrite } })
                        })
                        .catch(err => logger.debug({ jid: destinationJid, err: err?.message }, 'fire-and-forget tctoken issuance failed'))
                        .finally(() => inFlightTcTokenIssuance.delete(tcTokenJid))
                }
            }

            if (!isNewsletter && !isRetryResend && messages?.messageContextInfo?.messageSecret && shouldIncludeReportingToken(messages)) {
                try {
                    const encoded = encodeWAMessage(messages)
                    const reportingKey = { id: finalMsgId, fromMe: true, remoteJid: destinationJid, participant: participant?.jid }
                    const reportingNode = await getMessageReportingToken(encoded, messages, reportingKey)
                    if (reportingNode) stanza.content.push(reportingNode)
                } catch (error) { logger.warn({ jid, trace: error?.stack }, 'failed to attach reporting token') }
            }

            const aiLabel = msgAiLabel ?? msgAi ?? configAiLabel ?? false
            if (aiLabel && !isGroup && !isStatus && !isNewsletter) {
                const alreadyHasBizBot = getBinaryFilteredBizBot(additionalNodes || []) || getBinaryFilteredBizBot(stanza.content)
                if (!alreadyHasBizBot) stanza.content.push({ tag: 'bot', attrs: { biz_bot: '1' } })
            }

            logger.debug({ msgId: finalMsgId }, `sending message to ${participants.length} devices`)
            await sendNode(stanza)
            if (messageRetryManager && !participant) messageRetryManager.addRecentMessage(destinationJid, finalMsgId, message)

        }, activeSender)

        const isSelf = areJidsSameUser(jid, meId) || (meLid && areJidsSameUser(jid, meLid))
        return { key: { remoteJid: jid, fromMe: true, id: finalMsgId, participant: (isGroup || isSelf) ? jidNormalizedUser(activeSender) : undefined, addressingMode: (isLid || (isGroup && groupAddressingMode === 'lid')) ? 'lid' : 'pn' }, messageId: finalMsgId }
    }

    const waitForMsgMediaUpdate = bindWaitForEvent(ev, 'messages.media-update')

    // ── sendMessage ───────────────────────────────────────────────────────────

    const sendMessage = async (jid, content, options = {}) => {
        const meId = authState.creds.me.id
        const meLid = authState.creds.me?.lid
        const { server } = jidDecode(jid)
        const isGroup = server === 'g.us'
        const isDestinationLid = server === 'lid'
        const useCache = options.useCachedGroupMetadata !== false

        let activeSender = meId
        if (isGroup) {
            const groupData = useCache && cachedGroupMetadata ? await cachedGroupMetadata(jid) : undefined
            const addressingMode = groupData?.addressingMode || 'lid'
            if (addressingMode === 'lid' && meLid) activeSender = meLid
        } else if (isDestinationLid && meLid) {
            activeSender = meLid
        }

        if (content.interactive && !content.interactiveMessage) { const { interactive, ...rest } = content; content = { ...rest, interactiveMessage: interactive } }

        if (content.disappearingMessagesInChat && isJidGroup(jid)) {
            const value = typeof content.disappearingMessagesInChat === 'boolean' ? (content.disappearingMessagesInChat ? WA_DEFAULT_EPHEMERAL : 0) : content.disappearingMessagesInChat
            await groupToggleEphemeral(jid, value); return
        }

        let ephemeralDuration = options.ephemeralExpiration
        if (!ephemeralDuration) {
            if (isGroup) { const groupData = useCache && cachedGroupMetadata ? await cachedGroupMetadata(jid) : undefined; if (groupData?.ephemeralDuration > 0) ephemeralDuration = groupData.ephemeralDuration }
            else { const chatEphemeral = await authState.keys.get('chat-ephemeral', [jid]); if (chatEphemeral?.[jid]?.expiration > 0) ephemeralDuration = chatEphemeral[jid].expiration }
        }

        const fullMsg = await generateWAMessage(jid, content, { logger, userJid: jidNormalizedUser(activeSender), getUrlInfo: getUrlInfoFn, getProfilePicUrl: sock.profilePictureUrl, getCallLink: sock.createCallLink, upload: waUploadToServer, mediaCache: config.mediaCache, options: config.options, messageId: generateMessageIDV2(activeSender), ...options, ephemeralExpiration: ephemeralDuration })

        const additionalAttributes = {}, additionalNodes = []
        if (content.delete) { const fromMe = content.delete?.fromMe; const isGroupDelete = isJidGroup(content.delete?.remoteJid); additionalAttributes.edit = (isGroupDelete && !fromMe) ? '8' : '7' }
        else if (content.edit) additionalAttributes.edit = '1'
        else if (content.pin) additionalAttributes.edit = '2'
        if (content.poll) additionalNodes.push({ tag: 'meta', attrs: { polltype: 'creation' } })
        if (content.event) additionalNodes.push({ tag: 'meta', attrs: { event_type: 'creation' } })

        await relayMessage(jid, fullMsg.message, { messageId: fullMsg.key.id, useCachedGroupMetadata: options.useCachedGroupMetadata, additionalAttributes, statusJidList: options.statusJidList, additionalNodes, deliveryMode: options.deliveryMode, aiLabel: options.aiLabel ?? options.ai })
        if (config.emitOwnEvents) process.nextTick(() => processingMutex.mutex(() => upsertMessage(fullMsg, 'append')))
        return fullMsg
    }

    // ── updateMediaMessage ────────────────────────────────────────────────────

    const updateMediaMessage = async (message) => {
        const content = assertMediaContent(message.message)
        const mediaKey = content.mediaKey
        const meId = authState.creds.me.id
        const node = await encryptMediaRetryRequest(message.key, mediaKey, meId)
        let error
        await Promise.all([sendNode(node), waitForMsgMediaUpdate(async (update) => {
            const result = update.find(c => c.key.id === message.key.id)
            if (result) {
                if (result.error) { error = result.error }
                else {
                    try {
                        const media = await decryptMediaRetryData(result.media, mediaKey, result.key.id)
                        if (media.result !== proto.MediaRetryNotification.ResultType.SUCCESS) throw new Boom(`Media re-upload failed (${proto.MediaRetryNotification.ResultType[media.result]})`, { data: media, statusCode: getStatusCodeForMediaRetry(media.result) || 404 })
                        content.directPath = media.directPath
                        content.url = getUrlFromDirectPath(content.directPath)
                    } catch (err) { error = err }
                }
                return true
            }
        })])
        if (error) throw error
        ev.emit('messages.update', [{ key: message.key, update: { message: message.message } }])
        return message
    }

    // ── sendStatusMentions ────────────────────────────────────────────────────

    const sendStatusMentions = async (content, jids = []) => {
        const userJid = jidNormalizedUser(authState.creds.me.id)
        const allUsers = new Set([userJid])
        for (const id of jids) {
            if (isJidGroup(id)) {
                try { const metadata = await cachedGroupMetadata?.(id) || await groupMetadata(id); metadata.participants.forEach(p => allUsers.add(jidNormalizedUser(p.id))) }
                catch (error) { logger.error({ id, error }, 'failed to fetch group metadata for status mentions') }
            } else if (isJidUser(id)) {
                allUsers.add(jidNormalizedUser(id))
            }
        }

        const isMedia = content.image || content.video || content.audio
        const isAudio = !!content.audio
        const msgContent = { ...content }
        if (isMedia && !isAudio) { if (msgContent.text) { msgContent.caption = msgContent.text; delete msgContent.text }; delete msgContent.ptt; delete msgContent.font; delete msgContent.backgroundColor; delete msgContent.textColor }
        if (isAudio) { delete msgContent.text; delete msgContent.caption; delete msgContent.font; delete msgContent.textColor }

        const msg = await generateWAMessage(STORIES_JID, msgContent, { logger, userJid, getUrlInfo: getUrlInfoFn, upload: waUploadToServer, mediaCache: config.mediaCache, options: config.options, font: !isMedia ? (content.font || Math.floor(Math.random() * 9)) : undefined, textColor: !isMedia ? (content.textColor || getRandomHex()) : undefined, backgroundColor: (!isMedia || isAudio) ? (content.backgroundColor || getRandomHex()) : undefined, ptt: isAudio ? (typeof content.ptt === 'boolean' ? content.ptt : true) : undefined })

        await relayMessage(STORIES_JID, msg.message, { messageId: msg.key.id, statusJidList: Array.from(allUsers), additionalNodes: [{ tag: 'meta', attrs: {}, content: [{ tag: 'mentioned_users', attrs: {}, content: jids.map(jid => ({ tag: 'to', attrs: { jid: jidNormalizedUser(jid) } })) }] }] })

        for (const id of jids) {
            try {
                const normalizedId = jidNormalizedUser(id)
                const isPrivate = isJidUser(normalizedId)
                const type = isPrivate ? 'statusMentionMessage' : 'groupStatusMentionMessage'
                const protocolMessage = { [type]: { message: { protocolMessage: { key: msg.key, type: 25 } } }, messageContextInfo: { messageSecret: randomBytes(32) } }
                const statusMsg = await generateWAMessageFromContent(normalizedId, protocolMessage, {})
                await relayMessage(normalizedId, statusMsg.message, { additionalNodes: [{ tag: 'meta', attrs: isPrivate ? { is_status_mention: 'true' } : { is_group_status_mention: 'true' } }] })
                await delay(2000)
            } catch (error) { logger.error({ id, error }, 'failed to send status mention') }
        }
        return msg
    }

    return {
        ...sock,
        getPrivacyTokens,
        issuePrivacyTokens,
        assertSessions,
        relayMessage,
        sendReceipt,
        sendReceipts,
        readMessages,
        refreshMediaConn,
        waUploadToServer,
        sendPeerDataOperationMessage,
        createParticipantNodes,
        getUSyncDevices,
        messageRetryManager,
        updateMemberLabel,
        userDevicesCache,
        devicesMutex,
        placeholderResendCache,
        updateMediaMessage,
        sendStatusMentions,
        sendMessage,
    }
}