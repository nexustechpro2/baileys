import crypto from 'crypto'
import { proto } from '../../WAProto/index.js'
import { generateWAMessage, generateWAMessageFromContent, getUrlInfo, prepareWAMessageMedia, resolveNativeFlowButtons } from '../Utils/index.js'

export const getRandomHex = () => '#' + Array.from(crypto.getRandomValues(new Uint8Array(3)), b => b.toString(16).padStart(2, '0')).join('')

export const norm = (data, opts = {}) => {
    if (!data) return { ...opts }
    if (Array.isArray(data)) return { stickers: data, ...opts }
    if (typeof data !== 'object') return { ...opts }
    const keys = Object.keys(data)
    const base = keys.length && keys.every(k => !isNaN(k)) ? { stickers: Object.values(data) } : { ...data }
    return { ...base, ...Object.fromEntries(Object.entries(opts).filter(([, v]) => v != null)) }
}

export class BaseBuilder {
    #client; #data = {}
    constructor(client) {
        if (!client) throw new Error('Socket client is required')
        this.#client = client
    }
    from(data, opts = {}) { this.#data = norm(data, opts); return this }
    get data() { return this.#data }
    get client() { return this.#client }
}

export const buildDispatch = (builders, handlers = {}) => ({
    ...Object.fromEntries(builders.flatMap(B => (B.dispatchKeys ?? []).map(key => [key, (sock, jid, content, opts) => { const b = new B(sock); return (typeof b.from === 'function' ? b.from(content[key], opts) : b).send(jid, opts) }]))),
    ...handlers
})

// orderMessage → "order" | stickerPack → "stickerpack"
const toFactoryName = key => key.replace(/(?:Message|Pack|Packet)$/i, '').toLowerCase()
// orderMessage → "sendOrderMessage" | already starts with "send" → unchanged
const toSendName = key => key.toLowerCase().startsWith('send') ? key : 'send' + key.charAt(0).toUpperCase() + key.slice(1)

export const buildPlugins = (builders, extra = {}) => {
    const seen = new Set()
    const entries = []

    for (const B of builders) {
        // 1. explicit static shortcuts win first
        for (const [name, factory] of Object.entries(B.shortcuts ?? {})) {
            if (!seen.has(name)) { seen.add(name); entries.push([name, factory]) }
        }
        // 2. auto-derive factory + send shortcut from each dispatchKey
        for (const key of B.dispatchKeys ?? []) {
            const factoryName = toFactoryName(key)
            const sendName = toSendName(key)
            if (!seen.has(factoryName)) { seen.add(factoryName); entries.push([factoryName, sock => opts => new B(sock, opts)]) }
            if (!seen.has(sendName)) { seen.add(sendName); entries.push([sendName, sock => (jid, data, opts = {}) => new B(sock).from(data, opts).send(jid, opts)]) }
        }
        // 3. fallback: factory from class name (covers builders with no dispatchKeys)
        const className = B.name?.toLowerCase()
        if (className && !seen.has(className)) { seen.add(className); entries.push([className, sock => opts => new B(sock, opts)]) }
    }

    // 4. extra always wins — overrides any earlier registration
    for (const [name, factory] of Object.entries(extra)) {
        const idx = entries.findIndex(([n]) => n === name)
        if (idx === -1) { seen.add(name); entries.push([name, factory]) }
        else entries[idx] = [name, factory]
    }

    return Object.fromEntries(entries)
}

export async function handleGroupStatus(sock, jid, content, config) {
    const needsBackground = !content.image && !content.video
    const msg = await generateWAMessage(jid, content, {
        logger: sock.logger, userJid: sock.user?.id, upload: sock.waUploadToServer,
        getUrlInfo: text => getUrlInfo(text, { thumbnailWidth: config?.linkPreviewImageThumbnailWidth, fetchOpts: { timeout: 4000, ...(config?.options ?? {}) }, logger: sock.logger, uploadImage: config?.generateHighQualityLinkPreview ? sock.waUploadToServer : undefined }),
        ...(needsBackground && {
            font: content.font ?? Math.floor(Math.random() * 9),
            textColor: content.textColor || getRandomHex(),
            backgroundColor: content.backgroundColor || getRandomHex()
        })
    })
    return sock.relayMessage(jid, msg.message, { messageId: msg.key.id, additionalNodes: [{ tag: 'meta', attrs: { is_group_status: 'true' }, content: undefined }] })
}

export async function handleStatusMention(sock, jid, d, config) {
    const userJid = sock.user?.id
    const mediaType = d.image ? 'image' : 'video'
    const media = await prepareWAMessageMedia({ [mediaType]: d.image ?? d.video }, { upload: sock.waUploadToServer })
    const statusMsg = await sock.relayMessage('status@broadcast', { ...media }, {
        statusJidList: [d.mentions, userJid].filter(Boolean),
        additionalNodes: [{ tag: 'meta', attrs: {}, content: [{ tag: 'mentioned_users', attrs: {}, content: [{ tag: 'to', attrs: { jid: d.mentions }, content: undefined }] }] }]
    })
    const mentionMsg = await await generateWAMessageFromContent(jid, {
        statusMentionMessage: proto.Message.StatusMentionMessage.create({
            message: { protocolMessage: proto.Message.ProtocolMessage.create({ messageId: statusMsg?.key?.id ?? d.mentions, type: proto.Message.ProtocolMessage.Type.STATUS_MENTION_MESSAGE }) }
        })
    }, { userJid })
    return sock.relayMessage(jid, mentionMsg.message, { messageId: mentionMsg.key.id, additionalNodes: [{ tag: 'meta', attrs: { is_status_mention: 'true' }, content: undefined }] })
}

export async function handlePollResult(sock, jid, p) {
    const msg = await await generateWAMessageFromContent(jid, {
        pollResultSnapshotMessage: proto.Message.PollResultSnapshotMessage.create({
            name: p.name,
            pollVotes: (p.pollVotes ?? []).map(v => proto.Message.PollResultSnapshotMessage.PollVote.create({ optionName: v.optionName, optionVoteCount: String(v.optionVoteCount ?? 0) })),
            contextInfo: proto.ContextInfo.create({ isForwarded: true, forwardingScore: 1 })
        })
    }, { userJid: sock.user?.id })
    await sock.relayMessage(jid, msg.message, { messageId: msg.key.id })
    return msg
}

export const q = quoted => quoted ? { quoted } : {}

export async function handleNativeFlow(sock, jid, content, opts = {}) {
    const rawButtons = content.nativeFlow
    const resolved = resolveNativeFlowButtons(rawButtons)
    const offerParams = content.offerText ? { limited_time_offer: { text: content.offerText, url: content.offerUrl || '', copy_code: content.offerCode || '', expiration_time: content.offerExpiration ? Math.floor(content.offerExpiration / 1000) : 0 } } : {}
    const messageParams = { ...offerParams }
    if (content.optionText) messageParams.bottom_sheet = { in_thread_buttons_limit: 1, divider_indices: Array.from({ length: resolved.length }, (_, i) => i), list_title: content.optionTitle || content.optionText, button_title: content.optionText }
    if (content.interactiveAsTemplate) return sock.sendMessage(jid, { ...content, nativeFlow: undefined, interactiveButtons: undefined, templateButtons: resolved.map(b => { const p = JSON.parse(b.buttonParamsJson ?? '{}'); return b.name === 'cta_url' ? { text: p.display_text, url: p.url } : b.name === 'cta_call' ? { text: p.display_text, call: p.phone_number } : { text: p.display_text, id: p.id } }) }, opts)
    return sock.sendMessage(jid, { ...content, nativeFlow: undefined, interactiveButtons: resolved, ...(Object.keys(messageParams).length ? { messageParamsJson: JSON.stringify(messageParams) } : {}) }, opts)
}

export { resolveNativeFlowButtons }

export const PRIMITIVE_SHORTCUTS = {
    sendText: sock => (jid, text, opts = {}) => sock.sendMessage(jid, { text }, opts),
    sendImage: sock => (jid, image, caption = '', opts = {}) => sock.sendMessage(jid, { image, caption }, opts),
    sendVideo: sock => (jid, video, caption = '', opts = {}) => sock.sendMessage(jid, { video, caption }, opts),
    sendDocument: sock => (jid, document, caption = '', opts = {}) => sock.sendMessage(jid, { document, caption }, opts),
    sendAudio: sock => (jid, audio, opts = {}) => sock.sendMessage(jid, { audio, ptt: opts.ptt ?? false, ...opts }),
    sendSticker: sock => (jid, sticker, opts = {}) => sock.sendMessage(jid, { sticker }, opts),
    sendLocation: sock => (jid, location, opts = {}) => sock.sendMessage(jid, { location }, opts),
    sendContact: sock => (jid, contact, opts = {}) => sock.sendMessage(jid, { contacts: { displayName: contact.name ?? '', contacts: [contact] } }, opts),
    sendReaction: sock => (jid, key, emoji, opts = {}) => sock.sendMessage(jid, { react: { text: emoji, key } }, opts),
    sendForward: sock => (jid, message, opts = {}) => sock.sendMessage(jid, { forward: message, force: opts.force }, opts)
}

export const HANDLER_SHORTCUTS = {
    sendStatusMentionMessage: (sock, config) => (jid, data) => handleStatusMention(sock, jid, norm(data), config),
    sendStatusMentions: (sock, config) => (jid, data) => handleStatusMention(sock, jid, norm(data), config),
    sendPollResultMessage: sock => (jid, data) => handlePollResult(sock, jid, norm(data)),
    sendGroupStatusMessage: (sock, config) => (jid, content, opts = {}) => handleGroupStatus(sock, jid, norm(content), config),
    sendNativeFlow: sock => (jid, content, opts = {}) => handleNativeFlow(sock, jid, norm(content), opts)
}