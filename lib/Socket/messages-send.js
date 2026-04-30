import NodeCache from '@cacheable/node-cache'
import { Boom } from '@hapi/boom'
import * as Utils from '../Utils/index.js'
import { proto } from '../../WAProto/index.js'
import { DEFAULT_CACHE_TTLS, WA_DEFAULT_EPHEMERAL } from '../Defaults/index.js'
import * as WABinary from '../WABinary/index.js'
import { getUrlInfo, migrateIndexKey } from '../Utils/link-preview.js'
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

const TC_TOKEN_BUCKET_DURATION = 604800 // 7 days
const TC_TOKEN_NUM_BUCKETS = 4          // ~28-day rolling window

const isTcTokenExpired = (timestamp) => {
    if (timestamp === null || timestamp === undefined) return true
    const ts = typeof timestamp === 'string' ? parseInt(timestamp) : timestamp
    if (isNaN(ts)) return true
    const now = Math.floor(Date.now() / 1000)
    const currentBucket = Math.floor(now / TC_TOKEN_BUCKET_DURATION)
    const cutoffBucket = currentBucket - (TC_TOKEN_NUM_BUCKETS - 1)
    return ts < (cutoffBucket * TC_TOKEN_BUCKET_DURATION)
}

const shouldSendNewTcToken = (senderTimestamp) => {
    if (senderTimestamp === undefined) return true
    const now = Math.floor(Date.now() / 1000)
    const currentBucket = Math.floor(now / TC_TOKEN_BUCKET_DURATION)
    const senderBucket = Math.floor(senderTimestamp / TC_TOKEN_BUCKET_DURATION)
    return currentBucket > senderBucket
}

const resolveTcTokenJid = async (jid, getLIDForPN) => {
    if (isLidUser(jid)) return jid
    const lid = await getLIDForPN(jid)
    return lid ?? jid
}

const resolveIssuanceJid = async (jid, issueToLid, getLIDForPN, getPNForLID) => {
    if (issueToLid) {
        if (isLidUser(jid)) return jid
        return (await getLIDForPN(jid)) ?? jid
    }
    if (!isLidUser(jid)) return jid
    if (getPNForLID) return (await getPNForLID(jid)) ?? jid
    return jid
}

export const makeMessagesSocket = (config) => {
    const {
        logger, linkPreviewImageThumbnailWidth, generateHighQualityLinkPreview,
        options: httpRequestOptions, patchMessageBeforeSending, cachedGroupMetadata,
        enableRecentMessageCache, maxMsgRetryCount
    } = config

    const sock = makeNewsletterSocket(config)
    const {
        ev, authState, processingMutex, signalRepository, upsertMessage, query,
        fetchPrivacySettings, sendNode, groupMetadata, groupToggleEphemeral
    } = sock

    const userDevicesCache = config.userDevicesCache || new NodeCache({ stdTTL: DEFAULT_CACHE_TTLS.USER_DEVICES, useClones: false })
    const peerSessionsCache = new NodeCache({ stdTTL: DEFAULT_CACHE_TTLS.USER_DEVICES, useClones: false })
    const messageRetryManager = enableRecentMessageCache ? new MessageRetryManager(logger, maxMsgRetryCount) : null
    const encryptionMutex = makeKeyedMutex()

    // Prevents duplicate TC token IQ requests from concurrent sends
    const inFlightTcTokenIssuance = new Set()

    let mediaConn

    const refreshMediaConn = async (forceGet = false) => {
        const media = await mediaConn
        if (!media || forceGet || Date.now() - media.fetchDate.getTime() > media.ttl * 1000) {
            mediaConn = (async () => {
                const result = await query({ tag: 'iq', attrs: { type: 'set', xmlns: 'w:m', to: S_WHATSAPP_NET }, content: [{ tag: 'media_conn', attrs: {} }] })
                const mediaConnNode = getBinaryNodeChild(result, 'media_conn')
                return {
                    hosts: getBinaryNodeChildren(mediaConnNode, 'host').map(({ attrs }) => ({ hostname: attrs.hostname, maxContentLengthBytes: +attrs.maxContentLengthBytes })),
                    auth: mediaConnNode.attrs.auth,
                    ttl: +mediaConnNode.attrs.ttl,
                    fetchDate: new Date()
                }
            })()
            logger.debug('fetched media conn')
        }
        return mediaConn
    }

    const sendReceipt = async (jid, participant, messageIds, type) => {
        if (!messageIds?.length) throw new Boom('missing ids in receipt')
        const node = { tag: 'receipt', attrs: { id: messageIds[0] } }
        const isReadReceipt = type === 'read' || type === 'read-self'
        if (isReadReceipt) node.attrs.t = unixTimestampSeconds().toString()
        if (type === 'sender' && (isPnUser(jid) || isLidUser(jid))) {
            node.attrs.recipient = jid
            node.attrs.to = participant
        } else {
            node.attrs.to = jid
            if (participant) node.attrs.participant = participant
        }
        if (type) node.attrs.type = type
        if (messageIds.length > 1) {
            node.content = [{ tag: 'list', attrs: {}, content: messageIds.slice(1).map(id => ({ tag: 'item', attrs: { id } })) }]
        }
        logger.debug({ attrs: node.attrs, messageIds }, 'sending receipt')
        await sendNode(node)
    }

    const sendReceipts = async (keys, type) => {
        const recps = aggregateMessageKeysNotFromMe(keys)
        for (const { jid, participant, messageIds } of recps) {
            await sendReceipt(jid, participant, messageIds, type)
        }
    }

    const readMessages = async (keys) => {
        const privacySettings = await fetchPrivacySettings()
        await sendReceipts(keys, privacySettings.readreceipts === 'all' ? 'read' : 'read-self')
    }

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
        if (useCache && userDevicesCache.mget) {
            mgetDevices = await userDevicesCache.mget(jidsWithUser.map(j => j?.user).filter(Boolean))
        }

        const toFetch = []
        for (const { jid, user } of jidsWithUser) {
            if (useCache) {
                const devices = mgetDevices?.[user] || (userDevicesCache.mget ? undefined : await userDevicesCache.get(user))
                if (devices) {
                    deviceResults.push(...devices.map(d => ({ ...d, jid: jidEncode(d.user, d.server, d.device) })))
                    logger.trace({ user }, 'using cache for devices')
                } else {
                    toFetch.push(jid)
                }
            } else {
                toFetch.push(jid)
            }
        }

        if (!toFetch.length) return deviceResults

        const requestedLidUsers = new Set()
        for (const jid of toFetch) {
            if (isLidUser(jid) || isHostedLidUser(jid)) {
                const user = jidDecode(jid)?.user
                if (user) requestedLidUsers.add(user)
            }
        }

        const usyncQuery = new USyncQuery().withContext('message').withDeviceProtocol().withLIDProtocol()
        for (const jid of toFetch) usyncQuery.withUser(new USyncUser().withId(jid))

        const result = await sock.executeUSyncQuery(usyncQuery)
        if (result) {
            const lidResults = result.list.filter(a => !!a.lid)
            if (lidResults.length > 0) {
                logger.trace('Storing LID maps from device call')
                await signalRepository.lidMapping.storeLIDPNMappings(lidResults.map(a => ({ lid: a.lid, pn: a.id })))
                try {
                    const lids = lidResults.map(a => a.lid)
                    if (lids.length) await assertSessions(lids, false)
                } catch (e) {
                    logger.warn({ error: e, count: lidResults.length }, 'failed to assert sessions for newly mapped LIDs')
                }
            }

            const extracted = extractDeviceJids(result?.list, authState.creds.me.id, authState.creds.me.lid, ignoreZeroDevices)
            const deviceMap = {}
            for (const item of extracted) {
                deviceMap[item.user] = deviceMap[item.user] || []
                deviceMap[item.user]?.push(item)
            }

            for (const [user, userDevices] of Object.entries(deviceMap)) {
                const isLid = requestedLidUsers.has(user)
                for (const item of userDevices) {
                    const finalJid = isLid ? jidEncode(user, item.server, item.device) : jidEncode(item.user, item.server, item.device)
                    deviceResults.push({ ...item, jid: finalJid })
                }
            }

            if (userDevicesCache.mset) {
                await userDevicesCache.mset(Object.entries(deviceMap).map(([key, value]) => ({ key, value })))
            } else {
                for (const key in deviceMap) if (deviceMap[key]) await userDevicesCache.set(key, deviceMap[key])
            }

            // Persist device lists for session migration (capped at 500 users)
            const userDeviceUpdates = {}
            for (const [userId, devices] of Object.entries(deviceMap)) {
                if (devices?.length > 0) userDeviceUpdates[userId] = devices.map(d => d.device?.toString() || '0')
            }
            if (Object.keys(userDeviceUpdates).length > 0) {
                try {
                    const currentBatch = await migrateIndexKey(authState.keys, 'device-list')
                    const mergedBatch = { ...currentBatch, ...userDeviceUpdates }
                    await authState.keys.set({ 'device-list': { 'index': mergedBatch } })
                    logger.debug({ userCount: Object.keys(userDeviceUpdates).length, batchSize: Object.keys(trimmedBatch).length }, 'stored user device lists')
                } catch (error) {
                    logger.warn({ error }, 'failed to store user device lists')
                }
            }
        }
        return deviceResults
    }

    const assertSessions = async (jids, force) => {
        let didFetchNewSession = false
        let jidsRequiringFetch = []
        if (force) {
            jidsRequiringFetch = jids
        } else {
            // assertSessions
            const sessionBatch = await migrateIndexKey(authState.keys, 'session') // sessions live in index blob, not individual files
            for (const jid of jids) {
                const signalId = signalRepository.jidToSignalProtocolAddress(jid)
                if (!sessionBatch[signalId]) jidsRequiringFetch.push(jid)
            }
        }
        if (jidsRequiringFetch.length) {
            logger.debug({ jidsRequiringFetch }, 'fetching sessions')
            const result = await query({ tag: 'iq', attrs: { xmlns: 'encrypt', type: 'get', to: S_WHATSAPP_NET }, content: [{ tag: 'key', attrs: {}, content: jidsRequiringFetch.map(jid => ({ tag: 'user', attrs: { jid } })) }] })
            await parseAndInjectE2ESessions(result, signalRepository)
            didFetchNewSession = true
        }
        return didFetchNewSession
    }
    const sendPeerDataOperationMessage = async (pdoMessage) => {
        if (!authState.creds.me?.id) throw new Boom('Not authenticated')
        return await relayMessage(jidNormalizedUser(authState.creds.me.id), {
            protocolMessage: { peerDataOperationRequestMessage: pdoMessage, type: proto.Message.ProtocolMessage.Type.PEER_DATA_OPERATION_REQUEST_MESSAGE }
        }, { additionalAttributes: { category: 'peer', push_priority: 'high_force' }, additionalNodes: [{ tag: 'meta', attrs: { appdata: 'default' } }] })
    }

    // Issues our TC token to a contact so they can send us private messages. Fire-and-forget.
    const issuePrivacyTokens = async (jids, timestamp) => {
        const t = (timestamp ?? unixTimestampSeconds()).toString()
        return query({
            tag: 'iq',
            attrs: { to: S_WHATSAPP_NET, type: 'set', xmlns: 'privacy' },
            content: [{ tag: 'tokens', attrs: {}, content: jids.map(jid => ({ tag: 'token', attrs: { jid: jidNormalizedUser(jid), t, type: 'trusted_contact' } })) }]
        })
    }

    // Fetches TC tokens from the server for the given JIDs and stores them locally.
    const getPrivacyTokens = async (jids) => {
        const t = unixTimestampSeconds().toString()
        const result = await query({
            tag: 'iq',
            attrs: { to: S_WHATSAPP_NET, type: 'set', xmlns: 'privacy' },
            content: [{ tag: 'tokens', attrs: {}, content: jids.map(jid => ({ tag: 'token', attrs: { jid: jidNormalizedUser(jid), t, type: 'trusted_contact' } })) }]
        })
        const tokens = {}
        const tokenList = getBinaryNodeChild(result, 'tokens')
        if (tokenList) {
            for (const node of getBinaryNodeChildren(tokenList, 'token')) {
                const { jid, content } = { jid: node.attrs.jid, content: node.content }
                if (jid && content) tokens[jid] = { token: content, timestamp: Number(unixTimestampSeconds()) }
            }
        }
        if (Object.keys(tokens).length > 0) await authState.keys.set({ 'tctoken': tokens })
        return tokens
    }

    const updateMemberLabel = (jid, memberLabel) => {
        if (!memberLabel || typeof memberLabel !== 'string') throw new Error('Member label must be a non-empty string')
        if (!isJidGroup(jid)) throw new Error('Member labels can only be set in groups')
        return relayMessage(jid, {
            protocolMessage: {
                type: proto.Message.ProtocolMessage.Type.GROUP_MEMBER_LABEL_CHANGE,
                memberLabel: { label: memberLabel.slice(0, 30), labelTimestamp: unixTimestampSeconds() }
            }
        }, { additionalNodes: [{ tag: 'meta', attrs: { tag_reason: 'user_update', appdata: 'member_tag' }, content: undefined }] })
    }

    const getMessageType = (msg) => {
        const message = normalizeMessageContent(msg)
        if (!message) return 'text'
        if (message.pollCreationMessage || message.pollCreationMessageV2 || message.pollCreationMessageV3) return 'poll'
        if (message.reactionMessage || message.encReactionMessage) return 'reaction'
        if (message.eventMessage) return 'event'
        if (getMediaType(message)) return 'media'
        return 'text'
    }

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

                // Use DSM for own linked devices so they can read the message
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
                logger.warn({ jid, err: err?.message || err }, 'Failed to encrypt for recipient — no session, will retry on next interaction')
                return null
            }
        })

        const nodes = (await Promise.all(encryptionPromises)).filter(Boolean)
        return { nodes, shouldIncludeDeviceIdentity }
    }

    const relayMessage = async (jid, message, { messageId: msgId, participant, additionalAttributes, additionalNodes, useUserDevicesCache, useCachedGroupMetadata, statusJidList, quoted } = {}) => {
        const meId = authState.creds.me.id
        const meLid = authState.creds.me?.lid
        const { user, server } = jidDecode(jid)
        const isGroup = server === 'g.us'
        const isStatus = jid === 'status@broadcast'
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

        // Auto-generate WAMessage from raw content if needed
        const hasProtoMessageType = Object.keys(message).some(key => key.endsWith('Message') || key === 'conversation')
        if (!hasProtoMessageType) {
            logger.debug({ jid }, 'relayMessage: auto-generating message from raw content')
            const generatedMsg = await generateWAMessage(jid, message, {
                logger, userJid: jidNormalizedUser(activeSender),
                getUrlInfo: text => getUrlInfo(text, { thumbnailWidth: linkPreviewImageThumbnailWidth, fetchOpts: { timeout: 3000, ...(httpRequestOptions || {}) }, logger, uploadImage: generateHighQualityLinkPreview ? getWAUploadToServer(config, refreshMediaConn) : undefined }),
                getProfilePicUrl: sock.profilePictureUrl, getCallLink: sock.createCallLink,
                upload: waUploadToServer, mediaCache: config.mediaCache, options: config.options,
                messageId: finalMsgId || generateMessageIDV2(activeSender), quoted
            })
            message = generatedMsg.message
            if (!finalMsgId) finalMsgId = generatedMsg.key.id
            logger.debug({ msgId: finalMsgId, jid }, 'message auto-generated successfully')
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
                logger.debug({ msgId: finalMsgId }, `sending newsletter message to ${jid}`)
                return
            }

            if (messages?.pinInChatMessage || messages?.keepInChatMessage || message.reactionMessage || message.protocolMessage?.editedMessage) {
                extraAttrs['decrypt-fail'] = 'hide'
            }

            if ((isGroup || isStatus) && !isRetryResend) {
                const [groupData] = await Promise.all([
                    (async () => {
                        let groupData = useCachedGroupMetadata && cachedGroupMetadata ? await cachedGroupMetadata(jid) : undefined
                        if (groupData?.participants) logger.trace({ jid, participants: groupData.participants.length }, 'using cached group metadata')
                        else if (!isStatus) groupData = await groupMetadata(jid)
                        return groupData
                    })(),
                    Promise.resolve({}) // senderKeyMap always empty — forces fresh SKDM every send
                ])

                const participantsList = []
                if (isStatus) {
                    if (statusJidList?.length) participantsList.push(...statusJidList)
                } else {
                    let groupAddressingMode = 'lid'
                    if (groupData) { participantsList.push(...groupData.participants.map(p => p.id)); groupAddressingMode = groupData?.addressingMode || groupAddressingMode }
                    additionalAttributes = { ...additionalAttributes, addressing_mode: groupAddressingMode }
                }

                if (groupData?.ephemeralDuration > 0) {
                    additionalAttributes = { ...additionalAttributes, expiration: groupData.ephemeralDuration.toString() }
                }

                const additionalDevices = await getUSyncDevices(participantsList, !!useUserDevicesCache, false)
                devices.push(...additionalDevices)

                // Force Device 0 inclusion — USync sometimes omits it for LID groups
                for (const pJid of participantsList) {
                    const decoded = jidDecode(pJid)
                    if (decoded?.user && !devices.some(d => d.user === decoded.user && d.device === 0)) {
                        devices.push({ user: decoded.user, device: 0, server: decoded.server, domainType: decoded.domainType, jid: jidEncode(decoded.user, decoded.server, 0) })
                    }
                }

                const patched = await patchMessageBeforeSending(message)
                if (Array.isArray(patched)) throw new Boom('Per-jid patching not supported in groups')

                const bytes = encodeWAMessage(patched)
                const gAddressingMode = additionalAttributes?.addressing_mode || groupData?.addressingMode || 'lid'
                const groupSenderIdentity = gAddressingMode === 'lid' && meLid ? meLid : meId
                const { ciphertext, senderKeyDistributionMessage } = await signalRepository.encryptGroupMessage({ group: destinationJid, data: bytes, meId: groupSenderIdentity })

                const senderKeyRecipients = devices
                    .filter(d => !isHostedLidUser(d.jid) && !isHostedPnUser(d.jid) && d.device !== 99)
                    .map(d => d.jid)

                if (senderKeyRecipients.length) {
                    logger.debug({ senderKeyJids: senderKeyRecipients }, 'sending sender key')
                    const senderKeyMsg = { senderKeyDistributionMessage: { axolotlSenderKeyDistributionMessage: senderKeyDistributionMessage, groupId: destinationJid } }
                    await assertSessions(senderKeyRecipients)
                    const result = await createParticipantNodes(senderKeyRecipients, senderKeyMsg, {})
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
                const groupSenderIdentity = gAddressingMode === 'lid' && meLid ? meLid : meId
                const { ciphertext, senderKeyDistributionMessage } = await signalRepository.encryptGroupMessage({ group: destinationJid, data: bytes, meId: groupSenderIdentity })

                const senderKeyMsg = { senderKeyDistributionMessage: { axolotlSenderKeyDistributionMessage: senderKeyDistributionMessage, groupId: destinationJid } }
                await assertSessions([participant.jid])
                const skResult = await createParticipantNodes([participant.jid], senderKeyMsg, {})
                shouldIncludeDeviceIdentity = shouldIncludeDeviceIdentity || skResult.shouldIncludeDeviceIdentity
                participants.push(...skResult.nodes)

                // For retry resend, encrypt directly to the requesting participant
                const isParticipantLid = isLidUser(participant.jid)
                const isMe = areJidsSameUser(participant.jid, isParticipantLid ? meLid : meId)
                const encodedMsg = isMe ? encodeWAMessage({ deviceSentMessage: { destinationJid, message } }) : encodeWAMessage(message)
                const { type, ciphertext: encryptedContent } = await signalRepository.encryptMessage({ data: encodedMsg, jid: participant.jid })
                binaryNodeContent.push({ tag: 'enc', attrs: { v: '2', type, count: participant.count.toString() }, content: encryptedContent })

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
                        const device0Entries = devices.filter(d => d.device === 0)
                        const senderOwnUser = device0Entries.find(d => d.user !== user)?.user
                        devices.length = 0
                        const senderIdentity = isLid && meLid
                            ? jidEncode(jidDecode(meLid)?.user, 'lid', undefined)
                            : jidEncode(jidDecode(meId)?.user, 's.whatsapp.net', undefined)
                        const sessionDevices = await getUSyncDevices([senderIdentity, jid], true, false)
                        devices.push(...device0Entries, ...sessionDevices)

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
                if (meRecipients.length > 0 || otherRecipients.length > 0) {
                    extraAttrs.phash = generateParticipantHashV2([...meRecipients, ...otherRecipients])
                }
                shouldIncludeDeviceIdentity = shouldIncludeDeviceIdentity || s1 || s2
            }

            if (participants.length) {
                if (additionalAttributes?.category === 'peer') {
                    const peerNode = participants[0]?.content?.[0]
                    if (peerNode) binaryNodeContent.push(peerNode)
                } else {
                    binaryNodeContent.push({ tag: 'participants', attrs: {}, content: participants })
                }
            }

            const stanza = {
                tag: 'message',
                attrs: {
                    id: finalMsgId,
                    to: destinationJid,
                    type: getMessageType(message),
                    ...(isLid || (isGroup && groupAddressingMode === 'lid') ? { addressing_mode: 'lid' } : {}),
                    ...(hasDeviceFanoutFalse ? { device_fanout: 'false' } : {}),
                    ...(additionalAttributes || {})
                },
                content: binaryNodeContent
            }

            if (participant) {
                if (isJidGroup(destinationJid)) { stanza.attrs.to = destinationJid; stanza.attrs.participant = participant.jid }
                else if (areJidsSameUser(participant.jid, meId)) { stanza.attrs.to = participant.jid; stanza.attrs.recipient = destinationJid }
                else stanza.attrs.to = participant.jid
            } else {
                stanza.attrs.to = destinationJid
            }

            if (!isNewsletter && buttonType) {
                const buttonsNode = getButtonArgs(messages)
                const filteredButtons = getBinaryFilteredButtons(additionalNodes || [])
                if (filteredButtons) { stanza.content.push(...additionalNodes) }
                else stanza.content.push(buttonsNode)
            } else if (additionalNodes?.length > 0) {
                stanza.content.push(...additionalNodes)
            }

            if ((shouldIncludeDeviceIdentity || (meLid && (isLid || (isGroup && groupAddressingMode === 'lid')))) && !isNewsletter) {
                stanza.content.push({ tag: 'device-identity', attrs: {}, content: encodeSignedDeviceIdentity(authState.creds.account, true) })
                logger.debug({ jid }, 'adding device identity')
            }

            // TC token handling for 1:1 messages
            const isPeerMessage = additionalAttributes?.category === 'peer'
            const is1on1 = !isGroup && !isRetryResend && !isStatus && !isNewsletter && !isPeerMessage
            if (is1on1) {
                const getLIDForPN = signalRepository.lidMapping.getLIDForPN.bind(signalRepository.lidMapping)
                const tcTokenJid = await resolveTcTokenJid(destinationJid, getLIDForPN)

                const contactTcTokenData = await authState.keys.get('tctoken', [tcTokenJid])
                const existingEntry = contactTcTokenData[tcTokenJid]
                let tcTokenBuffer = existingEntry?.token

                // Clear expired tokens
                if (tcTokenBuffer?.length && isTcTokenExpired(existingEntry?.timestamp)) {
                    logger.debug({ jid: destinationJid }, 'tctoken expired, clearing')
                    tcTokenBuffer = undefined
                    try {
                        await authState.keys.set({ tctoken: { [tcTokenJid]: existingEntry?.senderTimestamp !== undefined ? { token: Buffer.alloc(0), senderTimestamp: existingEntry.senderTimestamp } : null } })
                    } catch { }
                }

                if (tcTokenBuffer?.length) {
                    stanza.content.push({ tag: 'tctoken', attrs: {}, content: tcTokenBuffer })
                }

                // Fire-and-forget: issue our token to the contact after send
                const isProtocolMsg = !!normalizeMessageContent(message)?.protocolMessage
                if (!isProtocolMsg && shouldSendNewTcToken(existingEntry?.senderTimestamp) && !inFlightTcTokenIssuance.has(tcTokenJid)) {
                    inFlightTcTokenIssuance.add(tcTokenJid)
                    const issueTimestamp = unixTimestampSeconds()
                    const getPNForLID = signalRepository.lidMapping.getPNForLID.bind(signalRepository.lidMapping)
                    const issueToLid = sock.serverProps?.lidTrustedTokenIssueToLid ?? false
                    resolveIssuanceJid(destinationJid, issueToLid, getLIDForPN, getPNForLID)
                        .then(issueJid => issuePrivacyTokens([issueJid], issueTimestamp))
                        .then(async () => {
                            const currentData = await authState.keys.get('tctoken', [tcTokenJid])
                            const current = currentData[tcTokenJid]
                            await authState.keys.set({ tctoken: { [tcTokenJid]: { ...current, senderTimestamp: issueTimestamp } } })
                        })
                        .catch(err => logger.debug({ jid: destinationJid, err: err?.message }, 'fire-and-forget tctoken issuance failed'))
                        .finally(() => inFlightTcTokenIssuance.delete(tcTokenJid))
                }
            }

            logger.debug({ msgId: finalMsgId }, `sending message to ${participants.length} devices`)
            await sendNode(stanza)
            if (messageRetryManager && !participant) messageRetryManager.addRecentMessage(destinationJid, finalMsgId, message)

        }, activeSender)

        const isSelf = areJidsSameUser(jid, meId) || (meLid && areJidsSameUser(jid, meLid))
        const returnParticipant = (isGroup || isSelf) ? jidNormalizedUser(activeSender) : undefined
        return {
            key: {
                remoteJid: jid,
                fromMe: true,
                id: finalMsgId,
                participant: returnParticipant,
                addressingMode: (isLid || (isGroup && groupAddressingMode === 'lid')) ? 'lid' : 'pn'
            },
            messageId: finalMsgId
        }
    }

    const waUploadToServer = getWAUploadToServer(config, refreshMediaConn)
    const nexus = new NexusHandler(Utils, waUploadToServer, relayMessage, { logger, mediaCache: config.mediaCache, options: config.options, mediaUploadTimeoutMs: config.mediaUploadTimeoutMs, user: authState.creds.me })
    const waitForMsgMediaUpdate = bindWaitForEvent(ev, 'messages.media-update')

    const sendMessage = async (jid, content, options = {}) => {
        const meId = authState.creds.me.id
        const meLid = authState.creds.me?.lid
        const { server } = jidDecode(jid)
        const isGroup = server === 'g.us'
        const isDestinationLid = server === 'lid'
        const useCache = options.useCachedGroupMetadata !== false
        const { quoted } = options

        let activeSender = meId
        let addressingMode = 'pn'
        if (isGroup) {
            const groupData = useCache && cachedGroupMetadata ? await cachedGroupMetadata(jid) : undefined
            addressingMode = groupData?.addressingMode || 'lid'
            if (addressingMode === 'lid' && meLid) activeSender = meLid
        } else if (isDestinationLid && meLid) {
            activeSender = meLid
            addressingMode = 'lid'
        }

        // Unwrap shorthand `interactive` key
        if (content.interactive && !content.interactiveMessage) {
            const { interactive, ...rest } = content
            content = { ...rest, interactiveMessage: interactive }
        }

        const messageType = nexus.detectType(content)
        if (messageType) return await nexus.processMessage(content, jid, quoted)

        if (content.disappearingMessagesInChat && isJidGroup(jid)) {
            const value = typeof content.disappearingMessagesInChat === 'boolean'
                ? (content.disappearingMessagesInChat ? WA_DEFAULT_EPHEMERAL : 0)
                : content.disappearingMessagesInChat
            await groupToggleEphemeral(jid, value)
            return
        }

        if (content.delete) {
            const deleteKey = content.delete
            if (!deleteKey.remoteJid || !deleteKey.id) {
                logger.error({ deleteKey }, 'Invalid delete key: missing remoteJid or id')
                throw new Boom('Delete key must have remoteJid and id', { statusCode: 400 })
            }

            const { server: deleteServer } = jidDecode(deleteKey.remoteJid)
            let deleteAddressingMode = deleteServer === 'lid' ? 'lid' : 'pn'
            if (isJidGroup(deleteKey.remoteJid)) {
                const groupData = useCache && cachedGroupMetadata ? await cachedGroupMetadata(deleteKey.remoteJid) : undefined
                deleteAddressingMode = groupData?.addressingMode || 'lid'
            }

            let normalizedParticipant = deleteKey.participant
            if (deleteKey.fromMe || isJidGroup(deleteKey.remoteJid)) {
                const senderJid = (deleteAddressingMode === 'lid' && meLid) ? meLid : meId
                normalizedParticipant = jidNormalizedUser(senderJid)
            }

            content.delete = {
                remoteJid: deleteKey.remoteJid,
                fromMe: deleteKey.fromMe === true || deleteKey.fromMe === 'true',
                id: deleteKey.id,
                ...(normalizedParticipant ? { participant: jidNormalizedUser(normalizedParticipant) } : {}),
                addressingMode: deleteAddressingMode
            }
            logger.debug({ jid, deleteKey: content.delete }, 'processing message deletion')
        }

        const fullMsg = await generateWAMessage(jid, content, {
            logger,
            userJid: jidNormalizedUser(activeSender),
            getUrlInfo: text => getUrlInfo(text, { thumbnailWidth: linkPreviewImageThumbnailWidth, fetchOpts: { timeout: 3000, ...(httpRequestOptions || {}) }, logger, uploadImage: generateHighQualityLinkPreview ? waUploadToServer : undefined }),
            getProfilePicUrl: sock.profilePictureUrl,
            getCallLink: sock.createCallLink,
            upload: waUploadToServer,
            mediaCache: config.mediaCache,
            options: config.options,
            messageId: generateMessageIDV2(activeSender),
            ...options
        })

        const additionalAttributes = {}, additionalNodes = []
        if (content.delete) {
            additionalAttributes.edit = isJidGroup(content.delete.remoteJid) ? '8' : '7'
        } else if (content.edit) {
            additionalAttributes.edit = '1'
        } else if (content.pin) {
            additionalAttributes.edit = '2'
        }
        if (content.poll) additionalNodes.push({ tag: 'meta', attrs: { polltype: 'creation' } })
        if (content.event) additionalNodes.push({ tag: 'meta', attrs: { event_type: 'creation' } })

        // Pre-fetch TC token for new DM contacts
        if (!isJidGroup(jid) && !content.disappearingMessagesInChat) {
            const existingToken = await authState.keys.get('tctoken', [jid])
            if (!existingToken[jid]) {
                try { await getPrivacyTokens([jid]); logger.debug({ jid }, 'fetched tctoken for new contact') }
                catch (err) { logger.warn({ jid, err }, 'failed to fetch tctoken') }
            }
        }

        await relayMessage(jid, fullMsg.message, {
            messageId: fullMsg.key.id,
            useCachedGroupMetadata: options.useCachedGroupMetadata,
            additionalAttributes,
            statusJidList: options.statusJidList,
            additionalNodes
        })

        if (config.emitOwnEvents) {
            process.nextTick(() => processingMutex.mutex(() => upsertMessage(fullMsg, 'append')))
        }
        return fullMsg
    }

    return {
        ...sock,
        getPrivacyTokens, issuePrivacyTokens, assertSessions, relayMessage,
        sendReceipt, sendReceipts, nexus, readMessages, refreshMediaConn,
        waUploadToServer, fetchPrivacySettings, sendPeerDataOperationMessage,
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
                    if (result.error) {
                        error = result.error
                    } else {
                        try {
                            const media = await decryptMediaRetryData(result.media, mediaKey, result.key.id)
                            if (media.result !== proto.MediaRetryNotification.ResultType.SUCCESS) {
                                throw new Boom(`Media re-upload failed (${proto.MediaRetryNotification.ResultType[media.result]})`, { data: media, statusCode: getStatusCodeForMediaRetry(media.result) || 404 })
                            }
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
                if (isJidGroup(id)) {
                    try { const metadata = await cachedGroupMetadata(id) || await groupMetadata(id); metadata.participants.forEach(p => allUsers.add(jidNormalizedUser(p.id))) }
                    catch (error) { logger.error(`Error getting metadata for ${id}: ${error}`) }
                } else if (isJidUser(id)) {
                    allUsers.add(jidNormalizedUser(id))
                }
            }

            const getRandomHex = () => '#' + Math.floor(Math.random() * 16777215).toString(16).padStart(6, '0')
            const isMedia = content.image || content.video || content.audio
            const isAudio = !!content.audio
            const msgContent = { ...content }
            if (isMedia && !isAudio) { if (msgContent.text) { msgContent.caption = msgContent.text; delete msgContent.text }; delete msgContent.ptt; delete msgContent.font; delete msgContent.backgroundColor; delete msgContent.textColor }
            if (isAudio) { delete msgContent.text; delete msgContent.caption; delete msgContent.font; delete msgContent.textColor }

            let msg
            try {
                msg = await generateWAMessage(STORIES_JID, msgContent, {
                    logger, userJid,
                    getUrlInfo: text => getUrlInfo(text, { thumbnailWidth: linkPreviewImageThumbnailWidth, fetchOpts: { timeout: 3000, ...(httpRequestOptions || {}) }, logger, uploadImage: generateHighQualityLinkPreview ? waUploadToServer : undefined }),
                    upload: async (encFilePath, opts) => { const up = await waUploadToServer(encFilePath, { ...opts }); return up },
                    mediaCache: config.mediaCache, options: config.options,
                    font: !isMedia ? (content.font || Math.floor(Math.random() * 9)) : undefined,
                    textColor: !isMedia ? (content.textColor || getRandomHex()) : undefined,
                    backgroundColor: (!isMedia || isAudio) ? (content.backgroundColor || getRandomHex()) : undefined,
                    ptt: isAudio ? (typeof content.ptt === 'boolean' ? content.ptt : true) : undefined
                })
            } catch (error) { logger.error(`Error generating message: ${error}`); throw error }

            await relayMessage(STORIES_JID, msg.message, {
                messageId: msg.key.id,
                statusJidList: Array.from(allUsers),
                additionalNodes: [{ tag: 'meta', attrs: {}, content: [{ tag: 'mentioned_users', attrs: {}, content: jids.map(jid => ({ tag: 'to', attrs: { jid: jidNormalizedUser(jid) } })) }] }]
            })

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

        // Nexus handler shortcuts
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
        sendMessage,
        // Shorthand wrappers
        sendText: (jid, text, options = {}) => sendMessage(jid, { text, ...options }, options),
        sendImage: (jid, image, caption = '', options = {}) => sendMessage(jid, { image, caption, ...options }, options),
        sendVideo: (jid, video, caption = '', options = {}) => sendMessage(jid, { video, caption, ...options }, options),
        sendDocument: (jid, document, caption = '', options = {}) => sendMessage(jid, { document, caption, ...options }, options),
        sendAudio: (jid, audio, options = {}) => sendMessage(jid, { audio, ...options }, options),
        sendLocation: (jid, { degreesLatitude, degreesLongitude, name, url, address } = {}, options = {}) =>
            sendMessage(jid, { location: { degreesLatitude, degreesLongitude, name, url, address }, ...options }, options),
        sendPoll: (jid, name, pollVote = [], multiSelect = false, options = {}) =>
            sendMessage(jid, { poll: { name, values: pollVote, selectableOptionsCount: multiSelect ? pollVote.length : 0 }, ...options }, options),
        sendReaction: (jid, key, reaction, options = {}) => sendMessage(jid, { react: { text: reaction, key }, ...options }, options),
        sendSticker: (jid, sticker, options = {}) => sendMessage(jid, { sticker, ...options }, options),
        sendContact: (jid, contact, options = {}) => sendMessage(jid, { contacts: { contacts: Array.isArray(contact) ? contact : [contact] }, ...options }, options),
        sendForward: (jid, message, options = {}) => sendMessage(jid, { forward: message, force: options.force }, options),
    }
}