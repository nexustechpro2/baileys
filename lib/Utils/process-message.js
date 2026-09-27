import { proto } from '../../WAProto/index.js'
import { Boom } from '@hapi/boom'
import { WAMessageStubType } from '../Types/index.js'
import { getContentType, normalizeMessageContent } from './messages.js'
import { areJidsSameUser, isHostedLidUser, isHostedPnUser, isJidBroadcast, isJidStatusBroadcast, isLidUser, jidDecode, jidEncode, jidNormalizedUser } from '../WABinary/index.js'
import { aesDecryptGCM, hmacSign } from './crypto.js'
import { getKeyAuthor, toNumber } from './generics.js'
import { downloadAndProcessHistorySyncNotification } from './history.js'
import { buildMergedTcTokenIndexWrite, resolveTcTokenJid } from './tc-token-utils.js'

const REAL_MSG_STUB_TYPES = new Set([
    WAMessageStubType.CALL_MISSED_GROUP_VIDEO,
    WAMessageStubType.CALL_MISSED_GROUP_VOICE,
    WAMessageStubType.CALL_MISSED_VIDEO,
    WAMessageStubType.CALL_MISSED_VOICE,
])

const REAL_MSG_REQ_ME_STUB_TYPES = new Set([WAMessageStubType.GROUP_PARTICIPANT_ADD])

// Self-only protocol types: drop if not fromMe to prevent local-state spoofing.
// Cross-user types (REVOKE, MESSAGE_EDIT, EPHEMERAL_SETTING, GROUP_MEMBER_LABEL_CHANGE) must NOT be listed here.
const SELF_ONLY_PROTOCOL_TYPES = new Set([
    proto.Message.ProtocolMessage.Type.HISTORY_SYNC_NOTIFICATION,
    proto.Message.ProtocolMessage.Type.APP_STATE_SYNC_KEY_SHARE,
    proto.Message.ProtocolMessage.Type.LID_MIGRATION_MAPPING_SYNC,
    proto.Message.ProtocolMessage.Type.PEER_DATA_OPERATION_REQUEST_RESPONSE_MESSAGE,
])

async function storeTcTokensFromHistorySync(chats, signalRepository, keyStore, logger) {
    const getLIDForPN = signalRepository.lidMapping.getLIDForPN.bind(signalRepository.lidMapping)
    const candidates = []
    for (const chat of chats) {
        const ts = chat.tcTokenTimestamp ? toNumber(chat.tcTokenTimestamp) : 0
        if (!chat.tcToken?.length || ts <= 0) continue
        const jid = jidNormalizedUser(chat.id)
        const storageJid = await resolveTcTokenJid(jid, getLIDForPN)
        candidates.push({ storageJid, token: Buffer.from(chat.tcToken), ts, senderTs: chat.tcTokenSenderTimestamp ? toNumber(chat.tcTokenSenderTimestamp) : undefined })
    }
    if (!candidates.length) return

    const existing = await keyStore.get('tctoken', candidates.map(c => c.storageJid))
    const entries = {}
    for (const c of candidates) {
        const existingTs = existing[c.storageJid]?.timestamp ? Number(existing[c.storageJid].timestamp) : 0
        if (existingTs > 0 && existingTs >= c.ts) continue
        entries[c.storageJid] = { ...existing[c.storageJid], token: c.token, timestamp: String(c.ts), ...(c.senderTs !== undefined ? { senderTimestamp: c.senderTs } : {}) }
    }
    if (!Object.keys(entries).length) return

    try {
        const indexWrite = await buildMergedTcTokenIndexWrite(keyStore, Object.keys(entries)) // keeps __index in sync for cross-session pruning
        await keyStore.set({ tctoken: { ...entries, ...indexWrite } })
    } catch (err) {
        logger?.warn({ err }, 'failed to store tctokens from history sync')
    }
}

export const cleanMessage = (message, meId, meLid) => {
    if (isHostedPnUser(message.key.remoteJid) || isHostedLidUser(message.key.remoteJid)) {
        message.key.remoteJid = jidEncode(jidDecode(message.key?.remoteJid)?.user, isHostedPnUser(message.key.remoteJid) ? 's.whatsapp.net' : 'lid')
    } else {
        message.key.remoteJid = jidNormalizedUser(message.key.remoteJid)
    }
    if (isHostedPnUser(message.key.participant) || isHostedLidUser(message.key.participant)) {
        message.key.participant = jidEncode(jidDecode(message.key.participant)?.user, isHostedPnUser(message.key.participant) ? 's.whatsapp.net' : 'lid')
    } else {
        message.key.participant = jidNormalizedUser(message.key.participant)
    }

    const content = normalizeMessageContent(message.message)
    if (content?.reactionMessage) normaliseKey(content.reactionMessage.key)
    if (content?.pollUpdateMessage) normaliseKey(content.pollUpdateMessage.pollCreationMessageKey)

    function normaliseKey(msgKey) {
        if (message.key.fromMe) return
        msgKey.fromMe = !msgKey.fromMe
            ? areJidsSameUser(msgKey.participant || msgKey.remoteJid, meId) || areJidsSameUser(msgKey.participant || msgKey.remoteJid, meLid)
            : false
        msgKey.remoteJid = message.key.remoteJid // TODO: investigate inconsistencies
        msgKey.participant = msgKey.participant || message.key.participant
    }
}

export const isRealMessage = message => {
    const normalizedContent = normalizeMessageContent(message.message)
    return (
        (!!normalizedContent || REAL_MSG_STUB_TYPES.has(message.messageStubType) || REAL_MSG_REQ_ME_STUB_TYPES.has(message.messageStubType)) &&
        !!getContentType(normalizedContent) &&
        !normalizedContent?.protocolMessage &&
        !normalizedContent?.reactionMessage &&
        !normalizedContent?.pollUpdateMessage
    )
}

export const shouldIncrementChatUnread = message => !message.key.fromMe && !message.messageStubType

export const getChatId = ({ remoteJid, participant, fromMe }) => {
    if (!remoteJid) throw new Boom('Cannot derive chat id: message key is missing remoteJid', { data: { remoteJid, participant, fromMe } })
    if (isJidBroadcast(remoteJid) && !isJidStatusBroadcast(remoteJid) && !fromMe) {
        if (!participant) throw new Boom('Cannot derive chat id: broadcast message key is missing participant', { data: { remoteJid, fromMe } })
        return participant
    }
    return remoteJid
}

export function decryptPollVote({ encPayload, encIv }, { pollCreatorJid, pollMsgId, pollEncKey, voterJid }) {
    const toBinary = txt => Buffer.from(txt)
    const sign = Buffer.concat([toBinary(pollMsgId), toBinary(pollCreatorJid), toBinary(voterJid), toBinary('Poll Vote'), new Uint8Array([1])])
    const decKey = hmacSign(sign, hmacSign(pollEncKey, new Uint8Array(32), 'sha256'), 'sha256')
    return proto.Message.PollVoteMessage.decode(aesDecryptGCM(encPayload, decKey, encIv, toBinary(`${pollMsgId}\u0000${voterJid}`)))
}

export function decryptEventResponse({ encPayload, encIv }, { eventCreatorJid, eventMsgId, eventEncKey, responderJid }) {
    const toBinary = txt => Buffer.from(txt)
    const sign = Buffer.concat([toBinary(eventMsgId), toBinary(eventCreatorJid), toBinary(responderJid), toBinary('Event Response'), new Uint8Array([1])])
    const decKey = hmacSign(sign, hmacSign(eventEncKey, new Uint8Array(32), 'sha256'), 'sha256')
    return proto.Message.EventResponseMessage.decode(aesDecryptGCM(encPayload, decKey, encIv, toBinary(`${eventMsgId}\u0000${responderJid}`)))
}

const processMessage = async (message, { shouldProcessHistoryMsg, placeholderResendCache, ev, creds, signalRepository, keyStore, logger, options, getMessage }) => {
    const meId = creds.me.id
    const { accountSettings } = creds
    const chat = { id: jidNormalizedUser(getChatId(message.key)) }
    const isRealMsg = isRealMessage(message)

    if (isRealMsg) {
        chat.messages = [{ message }]
        chat.conversationTimestamp = toNumber(message.messageTimestamp)
        if (shouldIncrementChatUnread(message)) chat.unreadCount = (chat.unreadCount || 0) + 1
    }

    const content = normalizeMessageContent(message.message)

    if ((isRealMsg || content?.reactionMessage?.key?.fromMe) && accountSettings?.unarchiveChats) {
        chat.archived = false
        chat.readOnly = false
    }

    const protocolMsg = content?.protocolMessage
    if (protocolMsg) {
        if (protocolMsg.type !== null && protocolMsg.type !== undefined && SELF_ONLY_PROTOCOL_TYPES.has(protocolMsg.type) && !message.key.fromMe) {
            logger?.warn({ msgId: message.key.id, type: protocolMsg.type, from: message.key.participant || message.key.remoteJid }, 'dropping spoofed self-only protocolMessage from non-self origin')
            return
        }

        switch (protocolMsg.type) {
            case proto.Message.ProtocolMessage.Type.HISTORY_SYNC_NOTIFICATION: {
                const histNotification = protocolMsg.historySyncNotification
                const isLatest = !creds.processedHistoryMessages?.length
                if (shouldProcessHistoryMsg) {
                    if (histNotification.syncType !== proto.HistorySync.HistorySyncType.ON_DEMAND) {
                        ev.emit('creds.update', { processedHistoryMessages: [...(creds.processedHistoryMessages || []), { key: message.key, messageTimestamp: message.messageTimestamp }] })
                    }
                    const data = await downloadAndProcessHistorySyncNotification(histNotification, options, logger)
                    if (data.lidPnMappings?.length) {
                        await signalRepository.lidMapping.storeLIDPNMappings(data.lidPnMappings).catch(err => logger?.warn({ err }, 'failed to store LID-PN mappings from history sync'))
                    }
                    await storeTcTokensFromHistorySync(data.chats, signalRepository, keyStore, logger)
                    ev.emit('messaging-history.set', { ...data, isLatest: histNotification.syncType !== proto.HistorySync.HistorySyncType.ON_DEMAND ? isLatest : undefined, chunkOrder: histNotification.chunkOrder, peerDataRequestSessionId: histNotification.peerDataRequestSessionId })
                }
                break
            }

            case proto.Message.ProtocolMessage.Type.APP_STATE_SYNC_KEY_SHARE: {
                const keys = protocolMsg.appStateSyncKeyShare.keys
                if (keys?.length) {
                    let newAppStateSyncKeyId = ''
                    await keyStore.transaction(async () => {
                        const newKeys = []
                        for (const { keyData, keyId } of keys) {
                            const strKeyId = Buffer.from(keyId.keyId).toString('base64')
                            newKeys.push(strKeyId)
                            await keyStore.set({ 'app-state-sync-key': { [strKeyId]: keyData } })
                            newAppStateSyncKeyId = strKeyId
                        }
                    }, meId)
                    ev.emit('creds.update', { myAppStateKeyId: newAppStateSyncKeyId })
                }
                break
            }

            case proto.Message.ProtocolMessage.Type.REVOKE: {
                ev.emit('messages.update', [{ key: { ...message.key, id: protocolMsg.key.id }, update: { message: null, messageStubType: WAMessageStubType.REVOKE, key: message.key } }])
                break
            }

            case proto.Message.ProtocolMessage.Type.EPHEMERAL_SETTING: {
                Object.assign(chat, { ephemeralSettingTimestamp: toNumber(message.messageTimestamp), ephemeralExpiration: protocolMsg.ephemeralExpiration || null })
                break
            }

            case proto.Message.ProtocolMessage.Type.MESSAGE_EDIT: {
                ev.emit('messages.update', [{
                    key: { ...message.key, id: protocolMsg.key?.id }, // key is in sender's perspective; fromMe flip happens at read time
                    update: {
                        message: { editedMessage: { message: protocolMsg.editedMessage } },
                        messageTimestamp: protocolMsg.timestampMs ? Math.floor(toNumber(protocolMsg.timestampMs) / 1000) : message.messageTimestamp,
                    },
                }])
                break
            }

            case proto.Message.ProtocolMessage.Type.GROUP_MEMBER_LABEL_CHANGE: {
                const labelAssociationMsg = protocolMsg.memberLabel
                if (labelAssociationMsg?.label) {
                    ev.emit('group.member-tag.update', { groupId: chat.id, label: labelAssociationMsg.label, participant: message.key.participant, participantAlt: message.key.participantAlt, messageTimestamp: Number(message.messageTimestamp) })
                }
                break
            }

            case proto.Message.ProtocolMessage.Type.PEER_DATA_OPERATION_REQUEST_RESPONSE_MESSAGE: {
                const response = protocolMsg.peerDataOperationRequestResponseMessage
                if (!response) break
                for (const result of (response.peerDataOperationResult || [])) {
                    const retryResponse = result?.placeholderMessageResendResponse
                    if (!retryResponse?.webMessageInfoBytes) continue
                    try {
                        const webMessageInfo = proto.WebMessageInfo.decode(retryResponse.webMessageInfoBytes)
                        const msgId = webMessageInfo.key?.id
                        const cachedData = msgId ? await placeholderResendCache?.get(msgId) : undefined // preserves LID, timestamps etc. that phone may omit in PDO response
                        if (msgId) await placeholderResendCache?.del(msgId)
                        let finalMsg
                        if (cachedData && typeof cachedData === 'object') {
                            cachedData.message = webMessageInfo.message
                            if (webMessageInfo.messageTimestamp) cachedData.messageTimestamp = webMessageInfo.messageTimestamp
                            finalMsg = cachedData
                        } else {
                            finalMsg = webMessageInfo
                        }
                        ev.emit('messages.upsert', { messages: [finalMsg], type: 'notify', requestId: response.stanzaId })
                    } catch (err) {
                        logger?.warn({ err, stanzaId: response.stanzaId }, 'failed to decode placeholder resend response')
                    }
                }
                break
            }

            case proto.Message.ProtocolMessage.Type.LID_MIGRATION_MAPPING_SYNC: {
                const encodedPayload = protocolMsg.lidMigrationMappingSyncMessage?.encodedMappingPayload
                const { pnToLidMappings, chatDbMigrationTimestamp } = proto.LIDMigrationMappingSyncPayload.decode(encodedPayload)
                const pairs = []
                for (const { pn, latestLid, assignedLid } of pnToLidMappings) {
                    pairs.push({ lid: `${latestLid || assignedLid}@lid`, pn: `${pn}@s.whatsapp.net` }) // latestLid takes priority over assignedLid
                }
                await signalRepository.lidMapping.storeLIDPNMappings(pairs)
                for (const { pn, lid } of pairs) await signalRepository.migrateSession(pn, lid)
                break
            }

            case proto.Message.ProtocolMessage.Type.STOP_GENERATION_MESSAGE: {
                ev.emit('messages.update', [{ key: { remoteJid: message.key.remoteJid, id: protocolMsg.key?.id }, update: { generationStopped: true } }])
                break
            }

            case proto.Message.ProtocolMessage.Type.CHAT_THEME_SETTING: {
                ev.emit('chats.update', [{ id: message.key.remoteJid, theme: protocolMsg.chatThemeSetting }])
                break
            }

            case proto.Message.ProtocolMessage.Type.MARK_AS_VERIFIED_ACTION: {
                ev.emit('contacts.update', [{ id: message.key.remoteJid, verified: protocolMsg.markAsVerifiedAction?.verified }])
                break
            }

            case proto.Message.ProtocolMessage.Type.MESSAGE_UNSCHEDULE: {
                ev.emit('messages.update', [{ key: { remoteJid: message.key.remoteJid, id: protocolMsg.key?.id }, update: { messageStubType: WAMessageStubType.SCHEDULED_MESSAGE_CREATED, scheduled: false } }])
                break
            }
        }
    } else if (content?.reactionMessage) {
        ev.emit('messages.reaction', [{ reaction: { ...content.reactionMessage, key: message.key }, key: content.reactionMessage?.key }])
    } else if (content?.pollUpdateMessage) {
        const creationMsgKey = content.pollUpdateMessage.pollCreationMessageKey
        const pollMsg = await getMessage(creationMsgKey)
        if (pollMsg) {
            try {
                const meIdNormalised = jidNormalizedUser(meId)
                const pollCreatorJid = getKeyAuthor(creationMsgKey, meIdNormalised)
                const voterJid = getKeyAuthor(message.key, meIdNormalised)
                const pollEncKey = pollMsg.messageContextInfo?.messageSecret
                if (!pollEncKey) {
                    logger?.warn({ creationMsgKey }, 'poll vote: missing messageSecret for decryption')
                } else {
                    const voteMsg = decryptPollVote(content.pollUpdateMessage.vote, { pollEncKey, pollCreatorJid, pollMsgId: creationMsgKey.id, voterJid })
                    ev.emit('messages.update', [{ key: creationMsgKey, update: { pollUpdates: [{ pollUpdateMessageKey: message.key, vote: voteMsg, senderTimestampMs: toNumber(content.pollUpdateMessage.senderTimestampMs) }] } }])
                }
            } catch (err) {
                logger?.warn({ err, creationMsgKey }, 'failed to decrypt poll vote')
            }
        } else {
            logger?.warn({ creationMsgKey }, 'poll creation message not found, cannot decrypt update')
        }
    } else if (content?.encEventResponseMessage) {
        const encEventResponse = content.encEventResponseMessage
        const creationMsgKey = encEventResponse.eventCreationMessageKey
        const eventMsg = await getMessage(creationMsgKey)
        if (eventMsg) {
            try {
                const meIdNormalised = jidNormalizedUser(meId)
                const eventCreatorKey = creationMsgKey.participant || creationMsgKey.remoteJid
                const eventCreatorPn = isLidUser(eventCreatorKey) ? await signalRepository.lidMapping.getPNForLID(eventCreatorKey) : eventCreatorKey // event creator must be PN; resolve from LID if necessary
                const eventCreatorJid = getKeyAuthor({ remoteJid: jidNormalizedUser(eventCreatorPn), fromMe: meIdNormalised === eventCreatorPn }, meIdNormalised)
                const responderJid = getKeyAuthor(message.key, meIdNormalised)
                const eventEncKey = eventMsg?.messageContextInfo?.messageSecret
                if (!eventEncKey) {
                    logger?.warn({ creationMsgKey }, 'event response: missing messageSecret for decryption')
                } else {
                    const responseMsg = decryptEventResponse(encEventResponse, { eventEncKey, eventCreatorJid, eventMsgId: creationMsgKey.id, responderJid })
                    ev.emit('messages.update', [{ key: creationMsgKey, update: { eventResponses: [{ eventResponseMessageKey: message.key, senderTimestampMs: responseMsg.timestampMs, response: responseMsg }] } }])
                }
            } catch (err) {
                logger?.warn({ err, creationMsgKey }, 'failed to decrypt event response')
            }
        } else {
            logger?.warn({ creationMsgKey }, 'event creation message not found, cannot decrypt response')
        }
    } else if (message.messageStubType) {
        const jid = message.key?.remoteJid
        let participants
        const emitParticipantsUpdate = action => ev.emit('group-participants.update', { id: jid, author: message.key.participant, authorPn: message.key.participantAlt, authorUsername: message.key.participantUsername, participants, action })
        const emitGroupUpdate = update => ev.emit('groups.update', [{ id: jid, ...update, author: message.key.participant ?? undefined, authorPn: message.key.participantAlt, authorUsername: message.key.participantUsername }])
        const emitGroupRequestJoin = (participant, action, method) => ev.emit('group.join-request', { id: jid, author: message.key.participant, authorPn: message.key.participantAlt, authorUsername: message.key.participantUsername, participant: participant.lid, participantPn: participant.pn, action, method })

        const participantsIncludesMe = () => participants.find(p => areJidsSameUser(meId, p.phoneNumber)) // TODO: ADD SUPPORT FOR LID

        switch (message.messageStubType) {
            case WAMessageStubType.GROUP_PARTICIPANT_CHANGE_NUMBER:
                participants = message.messageStubParameters.map(a => JSON.parse(a)) || []
                emitParticipantsUpdate('modify')
                break
            case WAMessageStubType.GROUP_PARTICIPANT_LEAVE:
            case WAMessageStubType.GROUP_PARTICIPANT_REMOVE:
                participants = message.messageStubParameters.map(a => JSON.parse(a)) || []
                emitParticipantsUpdate('remove')
                if (participantsIncludesMe()) chat.readOnly = true
                break
            case WAMessageStubType.GROUP_PARTICIPANT_ADD:
            case WAMessageStubType.GROUP_PARTICIPANT_INVITE:
            case WAMessageStubType.GROUP_PARTICIPANT_ADD_REQUEST_JOIN:
                participants = message.messageStubParameters.map(a => JSON.parse(a)) || []
                if (participantsIncludesMe()) chat.readOnly = false
                emitParticipantsUpdate('add')
                break
            case WAMessageStubType.GROUP_PARTICIPANT_DEMOTE:
                participants = message.messageStubParameters.map(a => JSON.parse(a)) || []
                emitParticipantsUpdate('demote')
                break
            case WAMessageStubType.GROUP_PARTICIPANT_PROMOTE:
                participants = message.messageStubParameters.map(a => JSON.parse(a)) || []
                emitParticipantsUpdate('promote')
                break
            case WAMessageStubType.GROUP_CHANGE_ANNOUNCE: {
                const announceValue = message.messageStubParameters?.[0]
                emitGroupUpdate({ announce: announceValue === 'true' || announceValue === 'on' })
                break
            }
            case WAMessageStubType.GROUP_CHANGE_RESTRICT: {
                const restrictValue = message.messageStubParameters?.[0]
                emitGroupUpdate({ restrict: restrictValue === 'true' || restrictValue === 'on' })
                break
            }
            case WAMessageStubType.GROUP_CHANGE_SUBJECT: {
                const name = message.messageStubParameters?.[0]
                chat.name = name
                emitGroupUpdate({ subject: name })
                break
            }
            case WAMessageStubType.GROUP_CHANGE_DESCRIPTION: {
                const description = message.messageStubParameters?.[0]
                chat.description = description
                emitGroupUpdate({ desc: description })
                break
            }
            case WAMessageStubType.GROUP_CHANGE_INVITE_LINK: {
                emitGroupUpdate({ inviteCode: message.messageStubParameters?.[0] })
                break
            }
            case WAMessageStubType.GROUP_MEMBER_ADD_MODE: {
                const memberAddValue = message.messageStubParameters?.[0]
                emitGroupUpdate({ memberAddMode: memberAddValue === 'all_member_add' })
                break
            }
            case WAMessageStubType.GROUP_MEMBERSHIP_JOIN_APPROVAL_MODE: {
                const approvalMode = message.messageStubParameters?.[0]
                emitGroupUpdate({ joinApprovalMode: approvalMode === 'on' })
                break
            }
            case WAMessageStubType.GROUP_MEMBERSHIP_JOIN_APPROVAL_REQUEST_NON_ADMIN_ADD: {
                const participant = JSON.parse(message.messageStubParameters?.[0])
                emitGroupRequestJoin(participant, message.messageStubParameters?.[1], message.messageStubParameters?.[2])
                break
            }
        }
    }

    if (Object.keys(chat).length > 1) ev.emit('chats.update', [chat])
}

export default processMessage