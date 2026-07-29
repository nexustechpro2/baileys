import { Boom } from "@hapi/boom"
import { proto } from "../../WAProto/index.js"
import {
  areJidsSameUser,
  isHostedLidUser,
  isHostedPnUser,
  isJidBroadcast,
  isJidGroup,
  isJidMetaAI,
  isJidNewsletter,
  isJidStatusBroadcast,
  isLidUser,
  isPnUser,
  //	transferDevice
} from "../WABinary/index.js"
import { unpadRandomMax16 } from "./generics.js"
export const getDecryptionJid = async (sender, repository, logger) => {
  // Skip LID mapping for newsletters, status broadcasts, and meta AI - they don't use it
  if (isJidNewsletter(sender) || isJidStatusBroadcast(sender) || isJidMetaAI(sender)) {
    return sender
  }

  if (isLidUser(sender) || isHostedLidUser(sender)) {
    return sender
  }
  const mapped = await repository.lidMapping.getLIDForPN(sender)
  return mapped || sender
}
const storeMappingFromEnvelope = async (stanza, sender, repository, decryptionJid, logger, meId, meLid) => {
  const { senderAlt } = extractAddressingContext(stanza)
  if (!senderAlt) return

  // Case 1: PN-addressed message — sender is PN, senderAlt is LID
  if (isLidUser(senderAlt) && isPnUser(sender) && decryptionJid === sender) {
    if (areJidsSameUser(sender, meId) || areJidsSameUser(senderAlt, meLid)) return // never remap own identity
    try {
      await repository.lidMapping.storeLIDPNMappings([{ lid: senderAlt, pn: sender }])
      repository.migrateSession(sender, senderAlt).catch(err => logger?.warn?.({ sender, senderAlt, err }, 'Failed to migrate session (PN→LID)'))
      logger.debug({ sender, senderAlt }, 'Stored LID mapping from envelope (PN→LID)')
    } catch (error) {
      logger.warn({ sender, senderAlt, error }, 'Failed to store LID mapping (PN→LID)')
    }
  }
  // Case 2: LID-addressed message — sender is LID, senderAlt is PN
  else if (isPnUser(senderAlt) && isLidUser(sender)) {
    if (areJidsSameUser(sender, meLid) || areJidsSameUser(senderAlt, meId)) return // never remap own identity
    try {
      await repository.lidMapping.storeLIDPNMappings([{ lid: sender, pn: senderAlt }])
      repository.migrateSession(senderAlt, sender).catch(err => logger?.warn?.({ sender, senderAlt, err }, 'Failed to migrate session (LID→PN)'))
      logger.debug({ sender, senderAlt }, 'Stored LID mapping from envelope (LID→PN)')
    } catch (error) {
      logger.warn({ sender, senderAlt, error }, 'Failed to store LID mapping (LID→PN)')
    }
  }
}
export const NO_MESSAGE_FOUND_ERROR_TEXT = "Message absent from node"
export const MISSING_KEYS_ERROR_TEXT = "Key used already or never filled"
export const ACCOUNT_RESTRICTED_TEXT = 'Your account has been restricted';
// Retry configuration for failed decryption
export const DECRYPTION_RETRY_CONFIG = {
  maxRetries: 3,
  baseDelayMs: 100,
  sessionRecordErrors: ["No session record", "SessionError: No session record"],
}
export const NACK_REASONS = {
  ParsingError: 487,
  UnrecognizedStanza: 488,
  UnrecognizedStanzaClass: 489,
  UnrecognizedStanzaType: 490,
  InvalidProtobuf: 491,
  InvalidHostedCompanionStanza: 493,
  MissingMessageSecret: 495,
  SignalErrorOldCounter: 496,
  MessageDeletedOnPeer: 499,
  UnhandledError: 500,
  UnsupportedAdminRevoke: 550,
  UnsupportedLIDGroup: 551,
  DBOperationFailed: 552,
}
export const extractAddressingContext = (stanza) => {
  let senderAlt
  let recipientAlt
  const sender = stanza.attrs.participant || stanza.attrs.from
  const addressingMode = stanza.attrs.addressing_mode || (sender?.endsWith("lid") ? "lid" : "pn")
  if (addressingMode === "lid") {
    // Message is LID-addressed: sender is LID, extract corresponding PN
    // without device data
    senderAlt = stanza.attrs.participant_pn || stanza.attrs.sender_pn || stanza.attrs.peer_recipient_pn
    recipientAlt = stanza.attrs.recipient_pn
    // with device data
    //if (sender && senderAlt) senderAlt = transferDevice(sender, senderAlt)
  } else {
    // Message is PN-addressed: sender is PN, extract corresponding LID
    // without device data
    senderAlt = stanza.attrs.participant_lid || stanza.attrs.sender_lid || stanza.attrs.peer_recipient_lid
    recipientAlt = stanza.attrs.recipient_lid
    //with device data
    //if (sender && senderAlt) senderAlt = transferDevice(sender, senderAlt)
  }
  return {
    addressingMode,
    senderAlt,
    recipientAlt,
  }
}
/**
 * Server-side error codes returned in ack stanzas (server → client) that we
 * currently have dedicated handlers for. Extend as more handlers are added.
 * Distinct from the client-side NackReason enum (WAWebCreateNackFromStanza).
 */
export const SERVER_ERROR_CODES = {
  /**
   * 1:1 message missing privacy token (tctoken). Usually means the account is
   * restricted: WhatsApp blocks starting new chats but preserves existing ones,
   * since established chats already carry a tctoken.
   */
  MessageAccountRestriction: '463',
  /** Stanza validation failure (SMAX_INVALID) — likely stale device session */
  SmaxInvalid: '479'
};
/**
 * Decode the received node as a message.
 * @note this will only parse the message, not decrypt it
 */
export function decodeMessageNode(stanza, meId, meLid) {
  let msgType
  let chatId
  let author
  let fromMe = false
  const msgId = stanza.attrs.id
  const from = stanza.attrs.from
  const participant = stanza.attrs.participant
  const recipient = stanza.attrs.recipient
  const addressingContext = extractAddressingContext(stanza)
  const isMe = (jid) => areJidsSameUser(jid, meId)
  const isMeLid = (jid) => areJidsSameUser(jid, meLid)
  if (isPnUser(from) || isLidUser(from) || isHostedLidUser(from) || isHostedPnUser(from)) {
    if (isMe(from) || isMeLid(from)) {
      fromMe = true
    }
    if (recipient && !isJidMetaAI(recipient)) {
      if (!fromMe) {
        throw new Boom("receipient present, but msg not from me", { data: stanza })
      }
      chatId = recipient
    } else {
      chatId = from
    }
    msgType = "chat"
    author = from
  } else if (isJidGroup(from)) {
    if (!participant) {
      throw new Boom("No participant in group message")
    }
    if (isMe(participant) || isMeLid(participant)) {
      fromMe = true
    }
    msgType = "group"
    author = participant
    chatId = from
  } else if (isJidBroadcast(from)) {
    if (!participant) {
      throw new Boom("No participant in group message")
    }
    const isParticipantMe = isMe(participant)
    if (isJidStatusBroadcast(from)) {
      msgType = isParticipantMe ? "direct_peer_status" : "other_status"
    } else {
      msgType = isParticipantMe ? "peer_broadcast" : "other_broadcast"
    }
    fromMe = isParticipantMe
    chatId = from
    author = participant
  } else if (isJidNewsletter(from)) {
    msgType = "newsletter"
    chatId = from
    author = from
    if (isMe(from) || isMeLid(from)) {
      fromMe = true
    }
  } else {
    throw new Boom("Unknown message type", { data: stanza })
  }
  const pushname = stanza?.attrs?.notify
  const key = {
    remoteJid: chatId,
    remoteJidAlt: !isJidGroup(chatId) ? addressingContext.senderAlt : undefined,
    fromMe,
    id: msgId,
    participant,
    participantAlt: isJidGroup(chatId) ? addressingContext.senderAlt : undefined,
    addressingMode: addressingContext.addressingMode,
    ...(msgType === "newsletter" && stanza.attrs.server_id ? { server_id: stanza.attrs.server_id } : {}),
  }
  const fullMessage = {
    key,
    messageTimestamp: +stanza.attrs.t,
    pushName: pushname,
    broadcast: isJidBroadcast(from),
  }
  if (key.fromMe) {
    fullMessage.status = proto.WebMessageInfo.Status.SERVER_ACK
  }
  return {
    fullMessage,
    author,
    sender: msgType === "chat" ? author : chatId,
  }
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
          if (tag === "verified_name" && content instanceof Uint8Array) {
            const cert = proto.VerifiedNameCertificate.decode(content)
            const details = proto.VerifiedNameCertificate.Details.decode(cert.details)
            fullMessage.verifiedBizName = details.verifiedName
          }
          if (tag === "unavailable" && attrs.type === "view_once") {
            fullMessage.key.isViewOnce = true // TODO: remove from here and add a STUB TYPE
          }
          if (tag !== "enc" && tag !== "plaintext") {
            continue
          }
          if (!(content instanceof Uint8Array)) {
            continue
          }
          decryptables += 1
          let msgBuffer
          const decryptionJid = await getDecryptionJid(author, repository, logger)
          let decryptionAltJid = null
          const { senderAlt } = extractAddressingContext(stanza)
          if (senderAlt) {
            decryptionAltJid = await getDecryptionJid(senderAlt, repository, logger)
          }
          if (tag !== 'plaintext') {
            storeMappingFromEnvelope(stanza, author, repository, decryptionJid, logger, meId, meLid).catch(err => logger?.warn?.({ err }, 'storeMappingFromEnvelope failed'))
          }
          try {
            const e2eType = tag === "plaintext" ? "plaintext" : attrs.type
            switch (e2eType) {
              case "skmsg":
                try {
                  msgBuffer = await repository.decryptGroupMessage({
                    group: sender,
                    authorJid: author,
                    msg: content,
                  })
                } catch (decryptErr) {
                  const errMsg = decryptErr?.message || decryptErr?.toString() || ''
                  if (errMsg.includes('memory access out of bounds')) {
                    console.error('[Signal] Stale sender key — group:', sender, 'author:', author, 'err:', errMsg)
                    try {
                      await repository.deleteSenderKey(sender, author)
                      console.error('[Signal] Sender key deleted successfully')
                    } catch (e) {
                      console.error('[Signal] Failed to delete sender key:', e)
                    }
                  }
                  throw decryptErr
                }
                break
              case "pkmsg":
              case "msg":
                msgBuffer = await repository.decryptMessage({ jid: decryptionJid, type: e2eType, ciphertext: content })
                if (msgBuffer === null) return // DuplicatedMessage — libsignal already handled it silently
                break
              case "plaintext":
                msgBuffer = content
                break
              case "msmsg":
                if (stanza.attrs._msmsgDecrypted) {
                  let msg = stanza.attrs._msmsgDecrypted
                  msg = msg.deviceSentMessage?.message || msg
                  if (fullMessage.message) {
                    Object.assign(fullMessage.message, msg)
                  } else {
                    fullMessage.message = msg
                  }
                  continue
                }
                throw new Error(`msmsg type but no pre-decrypted message available`)
              default:
                throw new Error(`Unknown e2e type: ${e2eType}`)
            }
            let msg = proto.Message.decode(e2eType !== "plaintext" ? unpadRandomMax16(msgBuffer) : msgBuffer)
            msg = msg.deviceSentMessage?.message || msg
            if (msg.senderKeyDistributionMessage) {
              //eslint-disable-next-line max-depth
              try {
                await repository.processSenderKeyDistributionMessage({
                  authorJid: author,
                  item: msg.senderKeyDistributionMessage,
                })
              } catch (err) {
                logger.error({ key: fullMessage.key, err }, "failed to process sender key distribution message")
              }
            }
            if (fullMessage.message) {
              Object.assign(fullMessage.message, msg)
            } else {
              fullMessage.message = msg
            }
            const viewOnceInner =
              msg?.viewOnceMessage?.message ||
              msg?.viewOnceMessageV2?.message ||
              msg?.viewOnceMessageV2Extension?.message
            if (
              viewOnceInner?.imageMessage?.viewOnce ||
              viewOnceInner?.videoMessage?.viewOnce ||
              viewOnceInner?.audioMessage?.viewOnce
            ) {
              fullMessage.key.isViewOnce = true
            }
          } catch (err) {
            const errorMessage = err?.message || err?.toString() || ""
            const errStr = err?.message || (typeof err === "string" ? err : "") || ""
            const isExpectedDecryptErr = errStr.includes("InvalidPreKeyId") || errStr.includes("SessionNotFound") || errStr.includes("InvalidMessage") || errStr.includes("no sender key state") || errStr.includes("memory access out of bounds") || errStr.includes("old counter") || errStr.includes("DuplicatedMessage") || errStr.includes("BadMac")
              ; (isExpectedDecryptErr ? logger?.debug?.bind(logger) : logger?.error?.bind(logger))?.({ key: fullMessage.key, err, errorMessage, messageType: tag === "plaintext" ? "plaintext" : attrs.type, sender, author }, "failed to decrypt message")
            fullMessage.messageStubType = proto.WebMessageInfo.StubType.CIPHERTEXT
            fullMessage.messageStubParameters = [errorMessage]
          }
        }
      }
      // if nothing was found to decrypt
      if (!decryptables) {
        fullMessage.messageStubType = proto.WebMessageInfo.StubType.CIPHERTEXT
        fullMessage.messageStubParameters = [NO_MESSAGE_FOUND_ERROR_TEXT]
      }
    },
  }
}
//# sourceMappingURL=decode-wa-message.js.map
