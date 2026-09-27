import { Boom } from '@hapi/boom'
import { proto } from '../../WAProto/index.js'
import { areJidsSameUser, isHostedLidUser, isHostedPnUser, isJidBroadcast, isJidGroup, isJidMetaAI, isJidNewsletter, isJidStatusBroadcast, isLidUser, isPnUser } from '../WABinary/index.js'
import { unpadRandomMax16 } from './generics.js'

export const NO_MESSAGE_FOUND_ERROR_TEXT = 'Message absent from node'
export const MISSING_KEYS_ERROR_TEXT = 'Key used already or never filled'
export const ACCOUNT_RESTRICTED_TEXT = 'Your account has been restricted'

export const DECRYPTION_RETRY_CONFIG = { maxRetries: 3, baseDelayMs: 100, sessionRecordErrors: ['No session record', 'SessionError: No session record'] }

export const NACK_REASONS = {
  ParsingError: 487, UnrecognizedStanza: 488, UnrecognizedStanzaClass: 489, UnrecognizedStanzaType: 490,
  InvalidProtobuf: 491, InvalidHostedCompanionStanza: 493, MissingMessageSecret: 495,
  SignalErrorOldCounter: 496, MessageDeletedOnPeer: 499, UnhandledError: 500,
  UnsupportedAdminRevoke: 550, UnsupportedLIDGroup: 551, DBOperationFailed: 552
}

export const SERVER_ERROR_CODES = { MessageAccountRestriction: '463', SmaxInvalid: '479' }

export const getDecryptionJid = async (sender, repository, logger) => {
  if (isJidNewsletter(sender) || isJidStatusBroadcast(sender) || isJidMetaAI(sender)) return sender
  if (isLidUser(sender) || isHostedLidUser(sender)) return sender
  return (await repository.lidMapping.getLIDForPN(sender)) || sender
}

const storeMappingFromEnvelope = async (stanza, sender, repository, decryptionJid, logger, meId, meLid) => {
  const { senderAlt } = extractAddressingContext(stanza)
  if (!senderAlt) return
  if (isLidUser(senderAlt) && isPnUser(sender) && decryptionJid === sender) {
    if (areJidsSameUser(sender, meId) || areJidsSameUser(senderAlt, meLid)) return
    try {
      await repository.lidMapping.storeLIDPNMappings([{ lid: senderAlt, pn: sender }])
      repository.migrateSession(sender, senderAlt).catch(err => logger?.warn?.({ sender, senderAlt, err }, 'Failed to migrate session (PN→LID)'))
      logger.debug({ sender, senderAlt }, 'Stored LID mapping from envelope (PN→LID)')
    } catch (error) { logger.warn({ sender, senderAlt, error }, 'Failed to store LID mapping (PN→LID)') }
  } else if (isPnUser(senderAlt) && isLidUser(sender)) {
    if (areJidsSameUser(sender, meLid) || areJidsSameUser(senderAlt, meId)) return
    try {
      await repository.lidMapping.storeLIDPNMappings([{ lid: sender, pn: senderAlt }])
      repository.migrateSession(senderAlt, sender).catch(err => logger?.warn?.({ sender, senderAlt, err }, 'Failed to migrate session (LID→PN)'))
      logger.debug({ sender, senderAlt }, 'Stored LID mapping from envelope (LID→PN)')
    } catch (error) { logger.warn({ sender, senderAlt, error }, 'Failed to store LID mapping (LID→PN)') }
  }
}

export const extractAddressingContext = stanza => {
  const sender = stanza.attrs.participant || stanza.attrs.from
  const addressingMode = stanza.attrs.addressing_mode || (sender?.endsWith('lid') ? 'lid' : 'pn')
  let senderAlt, recipientAlt
  if (addressingMode === 'lid') {
    senderAlt = stanza.attrs.participant_pn || stanza.attrs.sender_pn || stanza.attrs.peer_recipient_pn
    recipientAlt = stanza.attrs.recipient_pn
  } else {
    senderAlt = stanza.attrs.participant_lid || stanza.attrs.sender_lid || stanza.attrs.peer_recipient_lid
    recipientAlt = stanza.attrs.recipient_lid
  }
  return { addressingMode, senderAlt, recipientAlt }
}

const findChildByTag = (node, tag) => Array.isArray(node?.content) ? node.content.find(c => c?.tag === tag) : undefined

export const extractNewsletterMessageMeta = stanza => {
  const meta = findChildByTag(stanza, 'meta')
  if (!meta) return undefined
  const result = {}
  const adminProfile = findChildByTag(meta, 'admin_profile')
  if (adminProfile) {
    const name = findChildByTag(adminProfile, 'name')
    const picture = findChildByTag(adminProfile, 'picture')
    const content = name?.content
    result.adminProfile = {
      id: adminProfile.attrs?.id,
      name: typeof content === 'string' ? content : content instanceof Uint8Array ? Buffer.from(content).toString('utf-8') : undefined,
      pictureId: picture?.attrs?.id,
      pictureDirectPath: picture?.attrs?.direct_path
    }
  }
  if (findChildByTag(meta, 'paid_partnership')) result.paidPartnership = true
  if (findChildByTag(meta, 'ai_content')) result.aiContent = true
  return result
}

export const decodeMessageNode = (stanza, meId, meLid) => {
  let msgType, chatId, author, fromMe = false
  const { id: msgId, from, participant, recipient } = stanza.attrs
  const addressingContext = extractAddressingContext(stanza)
  const isMe = jid => areJidsSameUser(jid, meId)
  const isMeLid = jid => areJidsSameUser(jid, meLid)

  if (isPnUser(from) || isLidUser(from) || isHostedLidUser(from) || isHostedPnUser(from)) {
    if (isMe(from) || isMeLid(from)) fromMe = true
    chatId = (recipient && !isJidMetaAI(recipient)) ? (fromMe ? recipient : (() => { throw new Boom('recipient present, but msg not from me', { data: stanza }) })()) : from
    msgType = 'chat'; author = from
  } else if (isJidGroup(from)) {
    if (!participant) throw new Boom('No participant in group message')
    if (isMe(participant) || isMeLid(participant)) fromMe = true
    msgType = 'group'; author = participant; chatId = from
  } else if (isJidBroadcast(from)) {
    if (!participant) throw new Boom('No participant in group message')
    const isParticipantMe = isMe(participant)
    msgType = isJidStatusBroadcast(from) ? (isParticipantMe ? 'direct_peer_status' : 'other_status') : (isParticipantMe ? 'peer_broadcast' : 'other_broadcast')
    fromMe = isParticipantMe; chatId = from; author = participant
  } else if (isJidNewsletter(from)) {
    msgType = 'newsletter'; chatId = from; author = from
    if (isMe(from) || isMeLid(from)) fromMe = true
  } else throw new Boom('Unknown message type', { data: stanza })

  const key = {
    remoteJid: chatId,
    remoteJidAlt: !isJidGroup(chatId) ? addressingContext.senderAlt : undefined,
    fromMe, id: msgId, participant,
    participantAlt: isJidGroup(chatId) ? addressingContext.senderAlt : undefined,
    addressingMode: addressingContext.addressingMode,
    ...(msgType === 'newsletter' && stanza.attrs.server_id ? { server_id: stanza.attrs.server_id } : {})
  }
  const fullMessage = { key, messageTimestamp: +stanza.attrs.t, pushName: stanza.attrs?.notify, broadcast: isJidBroadcast(from) }
  if (key.fromMe) fullMessage.status = proto.WebMessageInfo.Status.SERVER_ACK
  return { fullMessage, author, sender: msgType === 'chat' ? author : chatId }
}

export const decryptMessageNode = (stanza, meId, meLid, repository, logger) => {
  const { fullMessage, author, sender } = decodeMessageNode(stanza, meId, meLid)
  return {
    fullMessage,
    category: stanza.attrs.category,
    author,
    async decrypt() {
      let decryptables = 0
      if (Array.isArray(stanza.content)) {
        for (const { tag, attrs, content } of stanza.content) {
          if (tag === 'verified_name' && content instanceof Uint8Array) {
            const cert = proto.VerifiedNameCertificate.decode(content)
            fullMessage.verifiedBizName = proto.VerifiedNameCertificate.Details.decode(cert.details).verifiedName
          }
          if (tag === 'unavailable' && attrs.type === 'view_once') fullMessage.key.isViewOnce = true
          if (tag !== 'enc' && tag !== 'plaintext') continue
          if (!(content instanceof Uint8Array)) continue
          decryptables++
          const decryptionJid = await getDecryptionJid(author, repository, logger)
          const { senderAlt } = extractAddressingContext(stanza)
          const decryptionAltJid = senderAlt ? await getDecryptionJid(senderAlt, repository, logger) : null
          if (tag !== 'plaintext') storeMappingFromEnvelope(stanza, author, repository, decryptionJid, logger, meId, meLid).catch(err => logger?.warn?.({ err }, 'storeMappingFromEnvelope failed'))
          try {
            const e2eType = tag === 'plaintext' ? 'plaintext' : attrs.type
            switch (e2eType) {
              case 'skmsg':
                try {
                  fullMessage._msgBuffer = await repository.decryptGroupMessage({ group: sender, authorJid: author, msg: content })
                } catch (decryptErr) {
                  const errMsg = decryptErr?.message || decryptErr?.toString() || ''
                  if (errMsg.includes('memory access out of bounds')) {
                    console.error('[Signal] Stale sender key — group:', sender, 'author:', author, 'err:', errMsg)
                    await repository.deleteSenderKey(sender, author).catch(e => console.error('[Signal] Failed to delete sender key:', e))
                  }
                  throw decryptErr
                }
                break
              case 'pkmsg':
              case 'msg': {
                const buf = await repository.decryptMessage({ jid: decryptionJid, type: e2eType, ciphertext: content })
                if (buf === null) return // DuplicatedMessage — libsignal handled silently
                fullMessage._msgBuffer = buf
                break
              }
              case 'plaintext':
                fullMessage._msgBuffer = content
                break
              case 'msmsg':
                if (!stanza.attrs._msmsgDecrypted) throw new Error('msmsg type but no pre-decrypted message available')
                { let msg = stanza.attrs._msmsgDecrypted; msg = msg.deviceSentMessage?.message || msg; fullMessage.message ? Object.assign(fullMessage.message, msg) : (fullMessage.message = msg) }
                continue
              default:
                throw new Error(`Unknown e2e type: ${e2eType}`)
            }
            let msg = proto.Message.decode(e2eType !== 'plaintext' ? unpadRandomMax16(fullMessage._msgBuffer) : fullMessage._msgBuffer)
            msg = msg.deviceSentMessage?.message || msg
            if (msg.senderKeyDistributionMessage) {
              await repository.processSenderKeyDistributionMessage({ authorJid: author, item: msg.senderKeyDistributionMessage })
                .catch(err => logger.error({ key: fullMessage.key, err }, 'failed to process sender key distribution message'))
            }
            fullMessage.message ? Object.assign(fullMessage.message, msg) : (fullMessage.message = msg)
            const viewOnceInner = msg?.viewOnceMessage?.message || msg?.viewOnceMessageV2?.message || msg?.viewOnceMessageV2Extension?.message
            if (viewOnceInner?.imageMessage?.viewOnce || viewOnceInner?.videoMessage?.viewOnce || viewOnceInner?.audioMessage?.viewOnce) fullMessage.key.isViewOnce = true
          } catch (err) {
            const errStr = err?.message || (typeof err === 'string' ? err : '') || ''
            const isExpected = errStr.includes('InvalidPreKeyId') || errStr.includes('SessionNotFound') || errStr.includes('InvalidMessage') || errStr.includes('no sender key state') || errStr.includes('memory access out of bounds') || errStr.includes('old counter') || errStr.includes('DuplicatedMessage') || errStr.includes('BadMac')
              ; (isExpected ? logger?.debug?.bind(logger) : logger?.error?.bind(logger))?.({ key: fullMessage.key, err, errStr, messageType: tag === 'plaintext' ? 'plaintext' : attrs.type, sender, author }, 'failed to decrypt message')
            fullMessage.messageStubType = proto.WebMessageInfo.StubType.CIPHERTEXT
            fullMessage.messageStubParameters = [errStr]
          }
        }
      }
      if (!decryptables) { fullMessage.messageStubType = proto.WebMessageInfo.StubType.CIPHERTEXT; fullMessage.messageStubParameters = [NO_MESSAGE_FOUND_ERROR_TEXT] }
    }
  }
}