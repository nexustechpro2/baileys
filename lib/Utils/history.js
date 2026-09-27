import { promisify } from 'util'
import { inflate } from 'zlib'
import { proto } from '../../WAProto/index.js'
import { WAMessageStubType } from '../Types/index.js'
import { isJidUser } from '../WABinary/index.js'
import { toNumber } from './generics.js'
import { normalizeMessageContent } from './messages.js'
import { downloadContentFromMessage } from './messages-media.js'

const inflatePromise = promisify(inflate)

export const downloadHistory = async (msg, options) => {
    const stream = await downloadContentFromMessage(msg, 'md-msg-hist', { options })
    const chunks = []
    for await (const chunk of stream) chunks.push(chunk)
    return proto.HistorySync.decode(await inflatePromise(Buffer.concat(chunks)))
}

export const processHistoryMessage = item => {
    const messages = [], contacts = [], chats = []
    switch (item.syncType) {
        case proto.HistorySync.HistorySyncType.INITIAL_BOOTSTRAP:
        case proto.HistorySync.HistorySyncType.RECENT:
        case proto.HistorySync.HistorySyncType.FULL:
        case proto.HistorySync.HistorySyncType.ON_DEMAND:
            for (const chat of (item.conversations ?? [])) {
                contacts.push({ id: chat.id, name: chat.name || undefined, lid: chat.lidJid || undefined, phoneNumber: chat.pnJid || undefined, jid: isJidUser(chat.id) ? chat.id : undefined })
                const msgs = chat.messages || []
                delete chat.messages; delete chat.archived; delete chat.muteEndTime; delete chat.pinned
                for (const item of msgs) {
                    const { message } = item
                    messages.push(message)
                    if (!chat.messages?.length) chat.messages = [{ message }]
                    if (!message.key.fromMe && !chat.lastMessageRecvTimestamp) chat.lastMessageRecvTimestamp = toNumber(message.messageTimestamp)
                    if ((message.messageStubType === WAMessageStubType.BIZ_PRIVACY_MODE_TO_BSP || message.messageStubType === WAMessageStubType.BIZ_PRIVACY_MODE_TO_FB) && message.messageStubParameters?.[0]) contacts.push({ id: message.key.participant || message.key.remoteJid, verifiedName: message.messageStubParameters[0] })
                }
                if (isJidUser(chat.id) && chat.readOnly && chat.archived) delete chat.readOnly
                chats.push({ ...chat })
            }
            break
        case proto.HistorySync.HistorySyncType.PUSH_NAME:
            for (const c of (item.pushnames ?? [])) contacts.push({ id: c.id, notify: c.pushname })
            for (const c of (item.inlineContacts ?? [])) { if (c.id) contacts.push({ id: c.id, name: c.fullName || c.firstName || undefined, notify: c.pushName || undefined, lid: c.lidJid || undefined, phoneNumber: c.pnJid || undefined }) }
            break
    }
    return { chats, contacts, messages, syncType: item.syncType, progress: item.progress }
}

export const downloadAndProcessHistorySyncNotification = async (msg, options) => processHistoryMessage(await downloadHistory(msg, options))

export const getHistoryMsg = message => message ? normalizeMessageContent(message)?.protocolMessage?.historySyncNotification : undefined