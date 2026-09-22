import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from 'crypto'
import { proto } from '../../WAProto/index.js'

export const SCHEDULED_MSG_META_TYPE = 'scheduled_message'
export const SCHEDULED_MSG_MAX_PER_CHAT = 30
export const SCHEDULED_MSG_MAX_MEDIA = 1
export const SCHEDULED_MSG_RESOURCE_LIMIT_NACK_CODE = 419
export const SCHEDULED_MSG_REVEAL_KEY_BYTES = 32
export const SCHEDULED_MSG_REVEAL_KEY_IV_BYTES = 12
export const SCHEDULED_MSG_REVEAL_KEY_RETENTION_DAYS = 30
export const SCHEDULED_MSG_TAG_BYTES = 16
export const SCHEDULED_MSG_WINDOW = Object.freeze({ chat: { minSeconds: 600, maxSeconds: 1209600 }, newsletter: { minSeconds: 600, maxSeconds: 2592000 } })
export const generateRevealKey = () => randomBytes(SCHEDULED_MSG_REVEAL_KEY_BYTES)
export const generateRevealKeyId = () => randomUUID()
export const encryptWithRevealKey = (plaintext, revealKey) => {
    const key = Buffer.from(revealKey)
    if (key.length !== SCHEDULED_MSG_REVEAL_KEY_BYTES) throw new TypeError(`reveal key must be ${SCHEDULED_MSG_REVEAL_KEY_BYTES} bytes`)
    const encIv = randomBytes(SCHEDULED_MSG_REVEAL_KEY_IV_BYTES)
    const cipher = createCipheriv('aes-256-gcm', key, encIv)
    const body = Buffer.concat([cipher.update(Buffer.from(plaintext)), cipher.final()])
    return { encIv, encPayload: Buffer.concat([body, cipher.getAuthTag()]) }
}
export const decryptWithRevealKey = (encPayload, encIv, revealKey) => {
    const key = Buffer.from(revealKey)
    const payload = Buffer.from(encPayload)
    if (payload.length < SCHEDULED_MSG_TAG_BYTES) throw new TypeError('encrypted payload is too short to carry an auth tag')
    const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(encIv))
    decipher.setAuthTag(payload.subarray(payload.length - SCHEDULED_MSG_TAG_BYTES))
    return Buffer.concat([decipher.update(payload.subarray(0, payload.length - SCHEDULED_MSG_TAG_BYTES)), decipher.final()])
}
export const buildConditionalRevealMessage = ({ encPayload, encIv, revealKeyId }) => ({ conditionalRevealMessage: { conditionalRevealMessageType: proto.Message.ConditionalRevealMessage.ConditionalRevealMessageType.SCHEDULED_MESSAGE, encPayload: Buffer.from(encPayload), encIv: Buffer.from(encIv), revealKeyId } })
export const encodeScheduledMessage = (message, revealKey = generateRevealKey()) => {
    const plaintext = proto.Message.encode(proto.Message.fromObject(message)).finish()
    const { encIv, encPayload } = encryptWithRevealKey(plaintext, revealKey)
    const revealKeyId = generateRevealKeyId()
    return { revealKey, revealKeyId, encIv, encPayload, message: buildConditionalRevealMessage({ encPayload, encIv, revealKeyId }) }
}
export const decodeScheduledMessage = (conditionalRevealMessage, revealKey) => {
    const inner = conditionalRevealMessage?.conditionalRevealMessage ?? conditionalRevealMessage
    if (!inner?.encPayload || !inner?.encIv) throw new TypeError('conditionalRevealMessage is missing encPayload or encIv')
    return proto.Message.decode(decryptWithRevealKey(inner.encPayload, inner.encIv, revealKey))
}
export const buildScheduledMsgMetaNode = ({ kind = 'schedule', scheduledTimestampS, revealKeyId, revealKey }) => {
    if (!revealKeyId) throw new TypeError('revealKeyId is required')
    if (kind === 'schedule' && !revealKey) throw new TypeError('scheduling requires the reveal key')
    const attrs = { type: SCHEDULED_MSG_META_TYPE }
    if (kind === 'schedule') {
        if (!Number.isFinite(Number(scheduledTimestampS))) throw new TypeError('scheduledTimestampS must be a unix timestamp in seconds')
        attrs.st = String(Math.floor(Number(scheduledTimestampS)))
    }
    return { tag: 'meta', attrs, content: [{ tag: 'key', attrs: { rkid: revealKeyId }, content: kind === 'schedule' ? Buffer.from(revealKey) : undefined }] }
}
export const buildUnscheduleProtocolMessage = (key) => ({ protocolMessage: { key, type: proto.Message.ProtocolMessage.Type.MESSAGE_UNSCHEDULE } })
export const isScheduledTimeValid = (scheduledTimestampS, nowSeconds = Math.floor(Date.now() / 1000), window = SCHEDULED_MSG_WINDOW.chat) => {
    const rounded = Math.floor(nowSeconds / 60) * 60
    return scheduledTimestampS - rounded >= window.minSeconds && scheduledTimestampS - nowSeconds <= window.maxSeconds
}
export const SplitPaymentStatus = Object.freeze({ PENDING: 0, PAID: 1 })
export const ReminderFrequency = Object.freeze({ REMINDER_FREQUENCY_UNKNOWN: 0, WEEKLY: 1, BI_WEEKLY: 2, MONTHLY: 3, QUARTERLY: 4 })
export const ReminderStatus = Object.freeze({ REMINDER_STATUS_UNKNOWN: 0, ACTIVE: 1, CANCELLED_BY_CREATOR: 2, STOPPED_BY_RECEIVER: 3, EXPIRED: 4, PAID: 5 })
export const MONEY_OFFSET = 1000
const drop = (object) => { for (const key of Object.keys(object)) { if (object[key] === undefined || object[key] === null) delete object[key] } return object }
export const money = (amount, currencyCode, offset = MONEY_OFFSET) => {
    const value = Number(amount)
    if (!Number.isFinite(value) || value < 0) throw new TypeError('money needs a non-negative amount')
    if (typeof currencyCode !== 'string' || currencyCode.length !== 3) throw new TypeError('money needs a three letter currency code, like IDR or USD')
    if (!Number.isInteger(offset) || offset <= 0) throw new TypeError('money offset must be a positive integer')
    return { value: Math.round(value * offset), offset, currencyCode: currencyCode.toUpperCase() }
}
export const readMoney = (value) => { if (!value?.offset) return undefined; return { amount: Number(value.value) / Number(value.offset), currencyCode: value.currencyCode } }
export const buildSplitPayment = ({ splitId, total, currency, description, requesterJid, participants = [], createdAt } = {}) => {
    if (!splitId) throw new TypeError('buildSplitPayment needs a splitId')
    if (!participants.length) throw new TypeError('buildSplitPayment needs at least one participant')
    return drop({ splitId: String(splitId), totalAmount: total === undefined ? undefined : money(total, currency), description, requesterJid, participants: participants.map((p, i) => { if (!p?.jid) throw new TypeError(`participant ${i} needs a jid`); return drop({ jid: p.jid, amount: p.amount === undefined ? undefined : money(p.amount, p.currency ?? currency), status: p.status ?? SplitPaymentStatus.PENDING }) }), createdAtMs: createdAt === undefined ? Date.now() : Number(createdAt) })
}
export const buildSplitPaymentUpdate = ({ splitId, participantJid } = {}) => { if (!splitId || !participantJid) throw new TypeError('buildSplitPaymentUpdate needs both splitId and participantJid'); return { splitId: String(splitId), participantJid } }
export const buildPaymentReminder = ({ reminderId, instanceId, description, frequency = ReminderFrequency.MONTHLY, status = ReminderStatus.ACTIVE, amount, currency, payeeVpa, payeeJid, payerJid } = {}) => {
    if (!reminderId) throw new TypeError('buildPaymentReminder needs a reminderId')
    return drop({ reminderId: String(reminderId), instanceId: instanceId === undefined ? undefined : String(instanceId), description, frequency, status, amount: amount === undefined ? undefined : money(amount, currency), payeeVpa, payeeJid, payerJid })
}
export const readSplitPayment = (msg) => {
    const split = (msg?.message ?? msg)?.splitPaymentMessage
    if (!split) return null
    return drop({ splitId: split.splitId, total: readMoney(split.totalAmount), description: split.description, requesterJid: split.requesterJid, createdAtMs: split.createdAtMs === undefined ? undefined : Number(split.createdAtMs), participants: (split.participants ?? []).map(p => drop({ jid: p.jid, amount: readMoney(p.amount), status: p.status })) })
}
export const readPaymentReminder = (msg) => {
    const reminder = (msg?.message ?? msg)?.paymentReminderMessage
    if (!reminder) return null
    return drop({ reminderId: reminder.reminderId, instanceId: reminder.instanceId, description: reminder.description, frequency: reminder.frequency, status: reminder.status, amount: readMoney(reminder.amount), payeeVpa: reminder.payeeVpa, payeeJid: reminder.payeeJid, payerJid: reminder.payerJid })
}
export const StatusLinkType = Object.freeze({ RASTERIZED_LINK_PREVIEW: 1, RASTERIZED_LINK_TRUNCATED: 2, RASTERIZED_LINK_FULL_URL: 3 })
export const STICKER_DEFAULT_AREA = Object.freeze({ x: 0.25, y: 0.4, width: 0.5, height: 0.2 })
const trimUndefined = (object) => { for (const key of Object.keys(object)) { if (object[key] === undefined) delete object[key] } return object }
const fraction = (value, name) => { const n = Number(value); if (!Number.isFinite(n) || n < 0 || n > 1) throw new TypeError(`${name} must be between 0 and 1`); return n }
export const stickerArea = ({ x, y, width, height } = STICKER_DEFAULT_AREA) => {
    const left = fraction(x, 'x'), top = fraction(y, 'y'), right = fraction(left + Number(width), 'x + width'), bottom = fraction(top + Number(height), 'y + height')
    if (right <= left || bottom <= top) throw new TypeError('a sticker area needs a positive width and height')
    return [{ x: left, y: top }, { x: right, y: top }, { x: right, y: bottom }, { x: left, y: bottom }]
}
const annotation = (area, fields) => ({ polygonVertices: Array.isArray(area) ? area : stickerArea(area), ...fields })
export const locationSticker = ({ latitude, longitude, name, area, skipConfirmation } = {}) => {
    const degreesLatitude = Number(latitude), degreesLongitude = Number(longitude)
    if (!Number.isFinite(degreesLatitude) || !Number.isFinite(degreesLongitude)) throw new TypeError('locationSticker needs a numeric latitude and longitude')
    return annotation(area, { location: { degreesLatitude, degreesLongitude, ...(name ? { name } : {}) }, ...(skipConfirmation === undefined ? {} : { shouldSkipConfirmation: !!skipConfirmation }) })
}
export const channelSticker = ({ jid, name, serverMessageId = 0, accessibilityText, area } = {}) => {
    if (typeof jid !== 'string' || !jid.endsWith('@newsletter')) throw new TypeError('channelSticker needs the channel jid ending in @newsletter')
    return annotation(area, { newsletter: { newsletterJid: jid, serverMessageId: Number(serverMessageId), ...(name ? { newsletterName: name } : {}), ...(accessibilityText ? { accessibilityText } : {}) } })
}
export const linkSticker = ({ url, title, area, linkType = StatusLinkType.RASTERIZED_LINK_PREVIEW } = {}) => {
    if (typeof url !== 'string' || !url) throw new TypeError('linkSticker needs a url')
    return annotation(area, { tapAction: { tapUrl: url, ...(title ? { title } : {}) }, statusLinkType: linkType })
}
export const musicSticker = ({ songId, title, author, mediaId, artworkDirectPath, artworkSha256, artworkEncSha256, artworkMediaKey, artistAttribution, countryBlocklist, isExplicit, startTimeMs = 0, derivedStartTimeMs, durationMs, area } = {}) => {
    if (!songId && !mediaId) throw new TypeError('musicSticker needs at least a songId or a musicContentMediaId')
    const bytes = v => v === undefined ? undefined : Buffer.isBuffer(v) ? v : Buffer.from(v, 'base64')
    const em = { ...(songId ? { songId: String(songId) } : {}), ...(mediaId ? { musicContentMediaId: String(mediaId) } : {}), ...(title ? { title } : {}), ...(author ? { author } : {}), ...(artistAttribution ? { artistAttribution } : {}), ...(artworkDirectPath ? { artworkDirectPath } : {}), ...(isExplicit === undefined ? {} : { isExplicit: !!isExplicit }), musicSongStartTimeInMs: Number(startTimeMs), ...(derivedStartTimeMs === undefined ? {} : { derivedContentStartTimeInMs: Number(derivedStartTimeMs) }), ...(durationMs === undefined ? {} : { overlapDurationInMs: Number(durationMs) }) }
    for (const [k, v] of [['artworkSha256', artworkSha256], ['artworkEncSha256', artworkEncSha256], ['artworkMediaKey', artworkMediaKey], ['countryBlocklist', countryBlocklist]]) { const b = bytes(v); if (b) em[k] = b }
    return annotation(area, { embeddedContent: { embeddedMusic: em } })
}
export const messageSticker = ({ stanzaId, message, area } = {}) => {
    if (!message) throw new TypeError('messageSticker needs the message it embeds')
    return annotation(area, { embeddedContent: { embeddedMessage: { ...(stanzaId ? { stanzaId } : {}), message } } })
}
const STICKER_ACTIONS = ['location', 'newsletter', 'embeddedAction', 'tapAction']
export const normalizeStickers = (stickers) => {
    const list = Array.isArray(stickers) ? stickers : [stickers]
    return list.filter(Boolean).map((sticker, i) => {
        const v = sticker.polygonVertices
        if (!Array.isArray(v) || v.length !== 4) throw new TypeError(`sticker ${i} needs four polygonVertices`)
        const actions = STICKER_ACTIONS.filter(n => sticker[n] !== undefined && sticker[n] !== null)
        if (actions.length > 1) throw new TypeError(`sticker ${i} sets ${actions.join(' and ')}, but only one action is allowed per sticker`)
        return proto.InteractiveAnnotation.fromObject(sticker)
    })
}
export const readStickers = (message) => {
    const media = message?.imageMessage ?? message?.videoMessage ?? message
    const annotations = media?.interactiveAnnotations
    if (!Array.isArray(annotations) || !annotations.length) return []
    return annotations.map(item => {
        const [topLeft, , bottomRight] = item.polygonVertices ?? []
        const music = item.embeddedContent?.embeddedMusic
        return { kind: item.location ? 'location' : item.newsletter ? 'channel' : item.tapAction ? 'link' : music ? 'music' : item.embeddedContent?.embeddedMessage ? 'message' : 'unknown', area: topLeft && bottomRight ? { x: topLeft.x, y: topLeft.y, width: bottomRight.x - topLeft.x, height: bottomRight.y - topLeft.y } : undefined, location: item.location ?? undefined, channel: item.newsletter ?? undefined, link: item.tapAction ? { url: item.tapAction.tapUrl, title: item.tapAction.title, linkType: item.statusLinkType } : undefined, music: music ? { songId: music.songId, title: music.title, author: music.author } : undefined, message: item.embeddedContent?.embeddedMessage ?? undefined, annotation: item }
    })
}
export const MusicMessageStyle = Object.freeze({ UNKNOWN: 0, VINYL: 1 })
export const MUSIC_ALLOWED_HOSTS = Object.freeze(['.whatsapp.net', '.whatsapp.com', '.fbcdn.net', '.facebook.com', '.instagram.com', '.cdninstagram.com'])
export const isMusicHostAllowed = (value) => { let host; try { host = new URL(String(value)).hostname.toLowerCase() } catch { return false } return MUSIC_ALLOWED_HOSTS.some(s => host.endsWith(s) || host === s.slice(1)) }
const assertMusicHost = (value, label) => { if (value === undefined) return undefined; if (!isMusicHostAllowed(value)) throw new TypeError(`${label} must be hosted on ${MUSIC_ALLOWED_HOSTS.join(', ')}`); return value }
const embeddedMusicOf = (options) => musicSticker(options).embeddedContent.embeddedMusic
export const buildMusicMessage = ({ songUri, artworkUri, style = MusicMessageStyle.VINYL, contextInfo, ...music } = {}) => trimUndefined({ embeddedMusic: embeddedMusicOf(music), songUri: assertMusicHost(songUri, 'songUri'), artworkUri: assertMusicHost(artworkUri, 'artworkUri'), style, contextInfo })
export const readMusicMessage = (msg) => {
    const music = (msg?.message ?? msg)?.musicMessage
    if (!music) return null
    const em = music.embeddedMusic ?? {}
    return { songId: em.songId, mediaId: em.musicContentMediaId, title: em.title, author: em.author, artistAttribution: em.artistAttribution, isExplicit: em.isExplicit, startTimeMs: em.musicSongStartTimeInMs, durationMs: em.overlapDurationInMs, songUri: music.songUri, artworkUri: music.artworkUri, style: music.style, embeddedMusic: em }
}
export function buildAckStanza(node, errorCode, meId) {
    const { tag, attrs } = node
    const stanza = { tag: 'ack', attrs: { id: attrs.id, to: attrs.from, class: tag } }
    if (errorCode) stanza.attrs.error = errorCode.toString()
    if (attrs.participant) stanza.attrs.participant = attrs.participant
    if (attrs.recipient) stanza.attrs.recipient = attrs.recipient
    if (attrs.type) stanza.attrs.type = attrs.type
    if (tag === 'message' && meId) stanza.attrs.from = meId
    return stanza
}
export const pickSenderKeyRecipients = (devices, senderKeyMap, { force = false, skip } = {}) => {
    const recipients = []
    for (const device of devices) {
        const deviceJid = device?.jid
        if (!deviceJid || (!force && senderKeyMap[deviceJid]) || (skip && skip(device))) continue
        recipients.push(deviceJid)
    }
    return recipients
}
export const deliveredSenderKeyJids = nodes => { const delivered = new Set(); for (const node of nodes || []) { const jid = node?.attrs?.jid; if (jid) delivered.add(jid) } return delivered }
export const senderKeyResetSummary = (stored, jid) => { const devices = Object.keys(stored?.[jid] || {}); return { jid, cleared: devices.length, devices } }
export const commitSenderKeyDelivery = (senderKeyMap, recipients, nodes) => {
    const delivered = deliveredSenderKeyJids(nodes), marked = [], skipped = []
    for (const jid of recipients) { if (delivered.has(jid)) { senderKeyMap[jid] = true; marked.push(jid) } else { delete senderKeyMap[jid]; skipped.push(jid) } }
    return { marked, skipped }
}
export const GROUP_ADDRESSING_MODES = Object.freeze(['pn', 'lid'])
export const isUsableGroupMetadata = metadata => { if (!metadata || typeof metadata !== 'object') return false; if (!Array.isArray(metadata.participants)) return false; return GROUP_ADDRESSING_MODES.includes(metadata.addressingMode) }
export const describeUnusableGroupMetadata = metadata => { if (!metadata || typeof metadata !== 'object') return 'nothing cached'; if (!Array.isArray(metadata.participants)) return 'no participants'; if (metadata.addressingMode === undefined || metadata.addressingMode === null) return 'no addressingMode'; return `addressingMode ${JSON.stringify(metadata.addressingMode)} is not pn or lid` }
