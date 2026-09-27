import crypto from 'crypto'
import { proto } from '../../WAProto/index.js'
import { BOT_RENDERING_CONFIG_METADATA } from '../Defaults/index.js'
import { generateWAMessage, generateWAMessageFromContent, generateMessageIDV2, prepareStickerPackMessage, prepareWAMessageMedia } from '../Utils/index.js'
import { getBizBinaryNode } from '../WABinary/index.js'
import { BaseBuilder, norm, q } from './base.js'

const delay = ms => new Promise(r => setTimeout(r, ms))

const SPECIAL_FLOW = {
    cta_url: { v: '2', name: 'cta_url' }, cta_call: { v: '2', name: 'cta_call' },
    cta_copy: { v: '2', name: 'cta_copy' }, cta_reminder: { v: '2', name: 'cta_reminder' },
    cta_cancel_reminder: { v: '2', name: 'cta_cancel_reminder' }, address: { v: '2', name: 'address_message' },
    send_location: { v: '2', name: 'send_location' }, cta_open_webview: { v: '3', name: 'cta_open_webview' },
    review_and_pay: { v: '4', name: 'review_and_pay' }, review_order: { v: '4', name: 'review_order' },
    payment_status: { v: '4', name: 'payment_status' }, transaction_details: { v: '4', name: 'transaction_details' },
    order_details: { v: '4', name: 'order_details' }, multi_product: { v: '4', name: 'multi_product' },
    catalog: { v: '5', name: 'catalog_message' }, flow: { v: '5', name: 'flow' },
    galaxy_message: { v: '9', name: 'galaxy_message' },
}
const DEFAULT_FLOW = { v: '9', name: 'mixed' }

// ─── Button ───────────────────────────────────────────────────────────────────
export class Button {
    #client; #buttons = []; #header = {}; #body = ''; #footer = ''
    #title = ''; #subtitle = ''; #params = {}; #mode = 'native'; #bloks = null

    constructor(client, opts = {}) {
        if (!client) throw new Error('Socket client is required')
        this.#client = client
        if (opts.mode) this.#mode = opts.mode
    }

    setTitle(t) { this.#title = t; return this }
    setSubtitle(s) { this.#subtitle = s; return this }
    setBody(t) { this.#body = t; return this }
    setFooter(t) { this.#footer = t; return this }
    setImage(url, opts = {}) { this.#header = { hasMediaAttachment: true, imageMessage: { url, ...opts } }; return this }
    setVideo(url, opts = {}) { this.#header = { hasMediaAttachment: true, videoMessage: { url, ...opts } }; return this }
    setDocument(url, fileName = 'file', opts = {}) { this.#header = { hasMediaAttachment: true, documentMessage: { url, fileName, ...opts } }; return this }
    setLocation(lat, lon, name = '') { this.#header = { hasMediaAttachment: false, locationMessage: { degreesLatitude: lat, degreesLongitude: lon, name } }; return this }
    setParams(p) { this.#params = p; return this }
    setLimitedTimeOffer(exp) { this.#params.limited_time_offer = { expiration_time_ms: exp }; return this }
    setBottomSheet(opts = {}) { this.#params.bottom_sheet = opts; return this }
    setTapTargetConfiguration(opts = {}) { this.#params.tap_target_configuration = opts; return this }

    #addNative(name, params) { this.#mode = 'native'; this.#buttons.push({ name, buttonParamsJson: JSON.stringify(params) }); return this }

    reply(text, id) { return this.#addNative('quick_reply', { display_text: text, id }) }
    url(text, url, merchantUrl) { return this.#addNative('cta_url', { display_text: text, url, merchant_url: merchantUrl ?? url }) }
    call(text, phone) { return this.#addNative('cta_call', { display_text: text, phone_number: phone }) }
    copy(text, code) { return this.#addNative('cta_copy', { display_text: text, copy_code: code }) }
    openWebview(text, url, opts = {}) { return this.#addNative('cta_open_webview', { display_text: text, url, ...opts }) }
    catalog(text, opts = {}) { return this.#addNative('catalog', { display_text: text, ...opts }) }
    flow(text, flowId, opts = {}) { return this.#addNative('flow', { display_text: text, flow_id: flowId, flow_token: opts.token ?? crypto.randomUUID(), ...opts }) }
    remind(text, opts = {}) { return this.#addNative('cta_reminder', { display_text: text, ...opts }) }
    cancelReminder(text, opts = {}) { return this.#addNative('cta_cancel_reminder', { display_text: text, ...opts }) }
    address(text, opts = {}) { return this.#addNative('address', { display_text: text, ...opts }) }
    sendLocation(text) { return this.#addNative('send_location', { display_text: text }) }
    reviewAndPay(text, opts = {}) { return this.#addNative('review_and_pay', { display_text: text, ...opts }) }
    reviewOrder(text, opts = {}) { return this.#addNative('review_order', { display_text: text, ...opts }) }
    orderDetails(text, opts = {}) { return this.#addNative('order_details', { display_text: text, ...opts }) }
    paymentStatus(text, opts = {}) { return this.#addNative('payment_status', { display_text: text, ...opts }) }
    transactionDetails(text, opts = {}) { return this.#addNative('transaction_details', { display_text: text, ...opts }) }
    select(title, sections) { return this.#addNative('single_select', { title, sections }) }

    legacyButton(text, id) { this.#mode = 'legacy'; this.#buttons.push({ buttonId: id, buttonText: { displayText: text }, type: 1 }); return this }
    templateReply(text, id) { this.#mode = 'template'; this.#buttons.push({ quickReplyButton: { displayText: text, id } }); return this }
    templateUrl(text, url) { this.#mode = 'template'; this.#buttons.push({ urlButton: { displayText: text, url } }); return this }
    templateCall(text, phone) { this.#mode = 'template'; this.#buttons.push({ callButton: { displayText: text, phoneNumber: phone } }); return this }

    setBloksWidget(components) {
        const flat = []
        const resolve = c => { if (!c.__id) c.__id = `c_${flat.length}`; flat.push(c); if (c.children) c.children = c.children.map(ch => { resolve(ch); return ch.__id }); if (c.$ref) c.$ref = c.$ref.__id }
            ; (Array.isArray(components) ? components : [components]).forEach(c => resolve(c))
        this.#bloks = flat; this.#mode = 'native'; return this
    }

    toCard() { return { header: this.#header, body: { text: this.#body }, footer: { text: this.#footer }, nativeFlowMessage: { buttons: this.#buttons } } }

    async build(jid, opts = {}) {
        const messageId = opts.messageId ?? generateMessageIDV2()
        const userJid = this.#client.user?.id
        if (this.#mode === 'legacy') return generateWAMessageFromContent(jid, { buttonsMessage: { ...(Object.keys(this.#header).length ? this.#header : { contentText: this.#body }), footer: this.#footer, buttons: this.#buttons, headerType: Object.keys(this.#header).length ? 3 : 1 } }, { userJid, messageId })
        if (this.#mode === 'template') return generateWAMessageFromContent(jid, { templateMessage: { hydratedTemplate: { hydratedContentText: this.#body, hydratedFooterText: this.#footer, hydratedButtons: this.#buttons } } }, { userJid, messageId })
        const isSingleSelect = this.#buttons.length === 1 && this.#buttons[0].name === 'single_select'
        if (isSingleSelect && !this.#bloks) { const params = JSON.parse(this.#buttons[0].buttonParamsJson); return generateWAMessageFromContent(jid, { listMessage: { title: this.#title, description: this.#body, footerText: this.#footer, buttonText: params.title ?? 'Select', listType: 1, sections: params.sections ?? [] } }, { userJid, messageId }) }
        const flowInfo = this.#buttons.reduce((acc, b) => { const f = SPECIAL_FLOW[b.name]; return (!acc || (f && parseInt(f.v) > parseInt(acc.v))) ? (f ?? DEFAULT_FLOW) : acc }, null) ?? DEFAULT_FLOW
        return generateWAMessageFromContent(jid, { interactiveMessage: { header: Object.keys(this.#header).length ? this.#header : undefined, body: { text: this.#body }, footer: { text: this.#footer }, nativeFlowMessage: { messageParamsJson: Object.keys(this.#params).length ? JSON.stringify(this.#params) : undefined, buttons: this.#bloks ? [{ name: 'galaxy_message', buttonParamsJson: JSON.stringify({ wa_flow_response_params: { title: this.#title }, components: this.#bloks }) }] : this.#buttons }, ...(this.#title ? { title: this.#title } : {}), ...(this.#subtitle ? { subtitle: this.#subtitle } : {}) } }, { userJid, messageId })
    }

    async send(jid, opts = {}) {
        const msg = await this.build(jid, opts)
        const bizNode = getBizBinaryNode(msg.message)
        await this.#client.relayMessage(jid, msg.message, { messageId: msg.key.id, additionalNodes: bizNode ? [bizNode] : [] })
        return msg
    }
}

// ─── Interactive ──────────────────────────────────────────────────────────────
export class Interactive extends BaseBuilder {
    static dispatchKeys = ['interactiveMessage']
    static shortcuts = {
        sendInteractiveMessage: sock => (jid, data, quoted) => new Interactive(sock).from(data).send(jid, q(quoted)),
        sendProductMessage: sock => (jid, data, quoted) => new Interactive(sock).from(data, { __product: true }).send(jid, q(quoted)),
    }

    async send(jid, opts = {}) {
        const i = this.data
        const userJid = this.client.user?.id
        const upload = this.client.waUploadToServer
        let media = null
        if (i.thumbnail) media = await prepareWAMessageMedia({ image: { url: i.thumbnail } }, { upload })
        else if (i.image) media = await prepareWAMessageMedia({ image: i.image }, { upload })
        else if (i.video) media = await prepareWAMessageMedia({ video: i.video }, { upload })
        else if (i.document) media = await prepareWAMessageMedia({ document: i.document }, { upload })
        const bodyText = i.body?.text ?? i.title ?? ''
        const footerText = typeof i.footer === 'string' ? i.footer : (i.footer?.text ?? '')
        const headerTitle = typeof i.header === 'string' ? i.header : (i.header?.title ?? '')
        let nativeFlow = null
        if (i.buttons?.length || i.nativeFlowMessage) { const nfm = i.nativeFlowMessage ?? {}; nativeFlow = proto.Message.InteractiveMessage.NativeFlowMessage.create({ buttons: i.buttons ?? nfm.buttons ?? [], messageParamsJson: nfm.messageParamsJson ?? '' }) }
        const headerMedia = {}
        if (media?.imageMessage) headerMedia.imageMessage = media.imageMessage
        if (media?.videoMessage) headerMedia.videoMessage = media.videoMessage
        if (media?.documentMessage) headerMedia.documentMessage = media.documentMessage
        const interactive = proto.Message.InteractiveMessage.create({ body: proto.Message.InteractiveMessage.Body.create({ text: bodyText }), footer: proto.Message.InteractiveMessage.Footer.create({ text: footerText }), header: proto.Message.InteractiveMessage.Header.create({ title: headerTitle, hasMediaAttachment: !!media, ...headerMedia }), ...(nativeFlow ? { nativeFlowMessage: nativeFlow } : {}) })
        if (i.contextInfo) interactive.contextInfo = i.contextInfo
        const msg = await generateWAMessageFromContent(jid, { interactiveMessage: interactive }, { userJid, quoted: opts.quoted })
        const bizNode = getBizBinaryNode(msg.message)
        await this.client.relayMessage(jid, msg.message, { messageId: msg.key.id, additionalNodes: bizNode ? [bizNode] : [] })
        return msg
    }
}

// ─── Carousel ─────────────────────────────────────────────────────────────────
export class Carousel {
    #client; #cards = []; #caption = ''; #footer = ''; #cardType = 'HSCROLL_CARDS'

    static dispatchKeys = ['carouselMessage']
    static shortcuts = {
        sendCarouselMessage: sock => (jid, data, quoted) => { const d = norm(data); const c = new Carousel(sock); if (d.caption) c.setCaption(d.caption); if (d.footer) c.setFooter(d.footer); (d.cards ?? []).forEach(card => c.card(card)); return c.send(jid, q(quoted)) },
        sendCarouselProtoMessage: sock => (jid, data, quoted) => Carousel.shortcuts.sendCarouselMessage(sock)(jid, data, quoted),
    }

    constructor(client) { if (!client) throw new Error('Socket client is required'); this.#client = client }
    setCaption(t) { this.#caption = t; return this }
    setFooter(t) { this.#footer = t; return this }
    setCardType(t) { this.#cardType = t; return this }
    card(b) { this.#cards.push(b instanceof Button ? b.toCard() : b); return this }

    async send(jid, opts = {}) {
        if (!this.#cards.length) throw new Error('Carousel requires at least 1 card')
        if (this.#cards.length > 10) throw new Error('Carousel max 10 cards')
        const msg = await generateWAMessageFromContent(jid, { interactiveMessage: proto.Message.InteractiveMessage.create({ header: proto.Message.InteractiveMessage.Header.create({ hasMediaAttachment: false }), body: proto.Message.InteractiveMessage.Body.create({ text: this.#caption }), footer: proto.Message.InteractiveMessage.Footer.create({ text: this.#footer }), carouselMessage: proto.Message.InteractiveMessage.CarouselMessage.create({ cards: this.#cards.map(c => ({ header: proto.Message.InteractiveMessage.Header.create({ title: c.header?.title ?? '', hasMediaAttachment: c.header?.hasMediaAttachment ?? false, ...c.header }), body: proto.Message.InteractiveMessage.Body.create({ text: c.body?.text ?? '' }), footer: proto.Message.InteractiveMessage.Footer.create({ text: c.footer?.text ?? '' }), nativeFlowMessage: proto.Message.InteractiveMessage.NativeFlowMessage.create({ buttons: c.nativeFlowMessage?.buttons ?? [] }) })), messageVersion: 1, carouselCardType: this.#cardType === 'ALBUM_IMAGE' ? 2 : 1 }) }) }, { userJid: this.#client.user?.id })
        const bizNode = getBizBinaryNode(msg.message)
        await this.#client.relayMessage(jid, msg.message, { messageId: msg.key.id, additionalNodes: bizNode ? [bizNode] : [] })
        return msg
    }
}

// ─── Album ────────────────────────────────────────────────────────────────────
export class Album extends BaseBuilder {
    #items = []; #delay = 1500

    static dispatchKeys = ['albumMessage']
    static shortcuts = {
        sendAlbumMessage: sock => (jid, items, quoted, opts = {}) => sock.sendMessage(jid, { albumMessage: items }, { ...q(quoted), ...opts }),
    }

    image(urlOrBuffer, caption = '') { this.#items.push({ image: typeof urlOrBuffer === 'string' ? { url: urlOrBuffer } : urlOrBuffer, caption }); return this }
    video(urlOrBuffer, caption = '') { this.#items.push({ video: typeof urlOrBuffer === 'string' ? { url: urlOrBuffer } : urlOrBuffer, caption }); return this }
    add(items) { items.forEach(item => this.#items.push(item)); return this }
    setDelay(ms) { this.#delay = ms; return this }

    async send(jid, opts = {}) {
        const items = this.data.albumMessage ? (Array.isArray(this.data.albumMessage) ? this.data.albumMessage : [this.data.albumMessage]) : this.#items
        if (items.length < 2) throw new Error('Album requires at least 2 items')
        const userJid = this.client.user?.id
        const album = await generateWAMessageFromContent(jid, { messageContextInfo: proto.MessageContextInfo.create({ messageSecret: crypto.randomBytes(32) }), albumMessage: proto.Message.AlbumMessage.create({ expectedImageCount: items.filter(a => a.image).length, expectedVideoCount: items.filter(a => a.video).length }) }, { userJid, messageId: generateMessageIDV2() })
        await this.client.relayMessage(jid, album.message, { messageId: album.key.id })
        for (const item of items) {
            const img = await generateWAMessage(jid, item, { upload: this.client.waUploadToServer, userJid })
            img.message.messageContextInfo = proto.MessageContextInfo.create({ messageSecret: crypto.randomBytes(32), messageAssociation: proto.MessageAssociation.create({ associationType: 1, parentMessageKey: album.key }) })
            await this.client.relayMessage(jid, img.message, { messageId: img.key.id })
            await delay(opts.albumDelay ?? this.#delay)
        }
        return album
    }
}

// ─── Poll ─────────────────────────────────────────────────────────────────────
export class Poll extends BaseBuilder {
    #poll = { name: '', values: [], selectableOptionsCount: 1, toAnnouncementGroup: false, hideVoter: false }

    static shortcuts = {
        sendPoll: sock => (jid, name, values, multiSelect = false, opts = {}) => sock.sendMessage(jid, { poll: { name, values, selectableOptionsCount: multiSelect ? 0 : 1 } }, opts),
    }

    name(n) { this.#poll.name = n; return this }
    options(o) { this.#poll.values = o; return this }
    addOption(o) { this.#poll.values.push(o); return this }
    multiSelect(max = 0) { this.#poll.selectableOptionsCount = max; return this }
    quiz(ans) { this.#poll.pollType = 1; this.#poll.correctAnswer = ans; return this }
    setEndTime(t) { this.#poll.endTime = t; return this }

    async send(jid, opts = {}) {
        if (!this.#poll.name) throw new Error('Poll name is required')
        if (this.#poll.values.length < 2) throw new Error('Poll requires at least 2 options')
        return this.client.sendMessage(jid, { poll: this.#poll }, opts)
    }
}

// ─── Payment ──────────────────────────────────────────────────────────────────
export class Payment extends BaseBuilder {
    static dispatchKeys = ['requestPaymentMessage']
    static shortcuts = {
        sendPaymentMessage: sock => (jid, data, quoted) => new Payment(sock).from(data).send(jid, q(quoted)),
    }

    setAmount(a) { this.data.amount = a; return this }
    setCurrency(c) { this.data.currency = c; return this }
    setExpiry(t) { this.data.expiry = t; return this }
    setNote(n) { this.data.note = n; return this }
    setFrom(j) { this.data.from = j; return this }

    async send(jid, opts = {}) {
        const d = this.data
        const ctx = opts.quoted ? { stanzaId: opts.quoted.key?.id, participant: opts.quoted.key?.participant, quotedMessage: opts.quoted.message } : {}
        const notes = d.note ? { extendedTextMessage: { text: d.note, contextInfo: ctx } } : {}
        const msg = await generateWAMessageFromContent(jid, { requestPaymentMessage: proto.Message.RequestPaymentMessage.fromObject({ expiryTimestamp: d.expiry ?? 0, amount1000: d.amount ?? 0, currencyCodeIso4217: d.currency ?? 'NGN', requestFrom: d.from ?? '0@s.whatsapp.net', noteMessage: notes, background: d.background ?? { id: 'DEFAULT', placeholderArgb: 0xfff0f0f0 } }) }, { userJid: this.client.user?.id })
        await this.client.relayMessage(jid, msg.message, { messageId: msg.key.id })
        return msg
    }
}

// ─── Order ────────────────────────────────────────────────────────────────────
export class Order extends BaseBuilder {
    static dispatchKeys = ['orderMessage']
    static shortcuts = {
        sendOrderMessage: sock => (jid, data, quoted) => new Order(sock).from(data).send(jid, q(quoted)),
    }

    async send(jid, opts = {}) {
        const o = this.data
        const userJid = this.client.user?.id
        let thumb = null
        if (o.thumbnail) {
            if (Buffer.isBuffer(o.thumbnail)) { thumb = o.thumbnail }
            else if (typeof o.thumbnail === 'string') { try { const { default: axios } = await import('axios'); const res = await axios.get(o.thumbnail, { responseType: 'arraybuffer' }); thumb = Buffer.from(res.data) } catch { } }
        }
        const cleanJid = id => { if (!id) return null; const [user] = id.split(':'); return user.includes('@') ? user : `${user}@s.whatsapp.net` }
        const seller = cleanJid(o.sellerJid) ?? cleanJid(userJid) ?? cleanJid(jid) ?? '0@s.whatsapp.net'
        const msg = await generateWAMessageFromContent(jid, { orderMessage: proto.Message.OrderMessage.create({ orderId: o.orderId ?? `NEXUS${Date.now()}`, thumbnail: thumb, itemCount: o.itemCount ?? 0, status: 2, surface: 1, message: o.message, orderTitle: o.orderTitle, sellerJid: seller, token: o.token ?? 'NEXUS_TOKEN', totalAmount1000: o.totalAmount1000 ?? 0, totalCurrencyCode: o.totalCurrencyCode ?? 'NGN', messageVersion: 2 }) }, { userJid, quoted: opts.quoted })
        await this.client.relayMessage(jid, msg.message, { messageId: msg.key.id })
        return msg
    }
}

// ─── Event ────────────────────────────────────────────────────────────────────
export class Event extends BaseBuilder {
    static dispatchKeys = ['eventMessage']
    static shortcuts = {
        sendEventMessage: sock => (jid, data, quoted) => new Event(sock).from(data).send(jid, q(quoted)),
    }

    setName(n) { this.data.name = n; return this }
    setDescription(d) { this.data.description = d; return this }
    setLocation(l) { this.data.location = l; return this }
    setJoinLink(l) { this.data.joinLink = l; return this }
    setStartTime(t) { this.data.startTime = t; return this }
    setEndTime(t) { this.data.endTime = t; return this }
    setCanceled(v = true) { this.data.isCanceled = v; return this }
    setReminder(sec) { this.data.hasReminder = true; this.data.reminderOffsetSec = sec; return this }
    setScheduledCall(v = true) { this.data.isScheduleCall = v; return this }

    async send(jid, opts = {}) {
        const e = this.data
        const parseTime = (val, def) => typeof val === 'string' ? parseInt(val) : (val ?? def)
        const msg = await generateWAMessageFromContent(jid, { messageContextInfo: proto.MessageContextInfo.create({ deviceListMetadata: {}, deviceListMetadataVersion: 2, messageSecret: crypto.randomBytes(32), supportPayload: JSON.stringify({ version: 2, is_ai_message: true, should_show_system_message: true, ticket_id: crypto.randomBytes(16).toString('hex') }) }), eventMessage: proto.Message.EventMessage.create({ contextInfo: proto.ContextInfo.create({ mentionedJid: [jid], participant: jid, remoteJid: 'status@broadcast', forwardedNewsletterMessageInfo: proto.ContextInfo.ForwardedNewsletterMessageInfo.create({ newsletterName: 'Nexus Events', newsletterJid: '120363422827915475@newsletter', serverMessageId: 1 }) }), isCanceled: e.isCanceled ?? false, name: e.name, description: e.description, location: e.location ?? { degreesLatitude: 0, degreesLongitude: 0, name: 'Location' }, joinLink: e.joinLink ?? '', startTime: parseTime(e.startTime, Date.now()), endTime: parseTime(e.endTime, Date.now() + 3600000), extraGuestsAllowed: e.extraGuestsAllowed !== false, ...(e.hasReminder ? { hasReminder: true, reminderOffsetSec: e.reminderOffsetSec ?? 3600 } : {}), ...(e.isScheduleCall !== undefined ? { isScheduleCall: e.isScheduleCall } : {}) }) }, { userJid: this.client.user?.id, quoted: opts.quoted })
        await this.client.relayMessage(jid, msg.message, { messageId: msg.key.id })
        return msg
    }
}

// ─── StickerPack ──────────────────────────────────────────────────────────────
export class StickerPack extends BaseBuilder {
    static dispatchKeys = ['stickerPack', 'stickerPackMessage']
    static shortcuts = {
        stickerPackMessage: sock => (jid, data, opts = {}) => new StickerPack(sock).from(data, { name: opts.packName, publisher: opts.packPublisher }).send(jid, q(opts.quoted)),
    }

    setStickers(s) { this.data.stickers = s; return this }

    async send(jid, opts = {}) {
        const userJid = this.client.user?.id
        const { quoted, ...passOpts } = opts
        const result = await prepareStickerPackMessage(this.data, { upload: this.client.waUploadToServer, logger: this.client.logger, ...passOpts })
        if (result.isBatched) {
            let last
            for (let i = 0; i < result.stickerPackMessage.length; i++) {
                const msg = await generateWAMessageFromContent(jid, { stickerPackMessage: result.stickerPackMessage[i] }, { userJid, quoted })
                await this.client.relayMessage(jid, msg.message, { messageId: msg.key.id })
                last = msg
                if (i < result.stickerPackMessage.length - 1) await delay(2000)
            }
            return last
        }
        const msg = await generateWAMessageFromContent(jid, { stickerPackMessage: result.stickerPackMessage }, { userJid, quoted })
        await this.client.relayMessage(jid, msg.message, { messageId: msg.key.id })
        return msg
    }
}
// ─── VerticalAlbum ────────────────────────────────────────────────────────────
export class VerticalAlbum extends BaseBuilder {
    static dispatchKeys = ['verticalAlbumMessage']
    static shortcuts = {
        sendVerticalAlbumMessage: sock => (jid, data, opts = {}) => new VerticalAlbum(sock).from(data, opts).send(jid, opts)
    }

    async send(jid, opts = {}) {
        const items = this.data.items ?? (Array.isArray(this.data.verticalAlbumMessage) ? this.data.verticalAlbumMessage : [])
        if (!Array.isArray(items) || items.length < 2) throw new Error('VerticalAlbum requires at least 2 items')
        const expiration = String(Date.now() + 30 * 24 * 60 * 60 * 1000)
        const primitives = items.map((item, i) => {
            const kind = item?.type || (item?.video ? 'video' : 'image')
            if (kind === 'video') {
                const v = item.video || item.data || item
                const url = typeof v === 'string' ? v : (v?.url ?? v?.videoUrl ?? '')
                if (!url) throw new Error(`VerticalAlbum item ${i}: video requires a URL`)
                return { media: { url, mime_type: v?.mimeType ?? v?.mime_type ?? 'video/mp4', file_length: v?.fileLength ?? v?.file_length ?? 0, duration: v?.duration ?? 0 }, imagine_type: 'ANIMATE', status: { status: 'READY' }, __typename: 'GenAIImaginePrimitive', ...(v?.thumbnail ? { thumbnail: { raw_media: v.thumbnail } } : {}) }
            }
            const img = item?.image || item?.data || item
            const url = typeof img === 'string' ? img : (img?.imageHighResUrl ?? img?.highResUrl ?? img?.fullUrl ?? img?.imagePreviewUrl ?? img?.previewUrl ?? img?.url ?? '')
            if (!url) throw new Error(`VerticalAlbum item ${i}: image requires a URL`)
            const w = Number(img?.width ?? 600), h = Number(img?.height ?? 400)
            const media = (u, mw, mh) => ({ url: u, url_fallback: u, mime_type: img?.mimeType ?? img?.mime_type ?? 'image/png', expiration_timestamp_ms: expiration, width: mw, height: mh })
            return { preview_image: media(url, w, h), full_image: media(img?.highResUrl ?? url, w, h), dark_mode_preview_image: media(img?.darkModePreviewUrl ?? url, w, h), dark_mode_full_image: media(img?.darkModeHighResUrl ?? url, w, h), asset_query_status: 'FETCHED', display_mode: 'FULL_WIDTH', full_width: true, __typename: 'GenAIImagePrimitive' }
        })
        const unified = { response_id: crypto.randomUUID(), sections: [{ view_model: { primitives, display_mode: 'FULL_WIDTH', full_width: true, __typename: 'GenAIVStackLayoutViewModel' } }] }
        const msg = await generateWAMessageFromContent(jid, {
            messageContextInfo: { botMetadata: { pluginMetadata: {}, botRenderingConfigMetadata: BOT_RENDERING_CONFIG_METADATA } },
            botForwardedMessage: { message: { richResponseMessage: proto.Message.AIRichResponseMessage?.create?.({ messageType: 1, submessages: [], unifiedResponse: { data: Buffer.from(JSON.stringify(unified)) }, contextInfo: { isForwarded: true, forwardingScore: 1, forwardedAiBotMessageInfo: { botJid: '867051314767696@bot' }, forwardOrigin: 4 } }) ?? { messageType: 1, submessages: [], unifiedResponse: { data: Buffer.from(JSON.stringify(unified)) }, contextInfo: { isForwarded: true, forwardingScore: 1, forwardedAiBotMessageInfo: { botJid: '867051314767696@bot' }, forwardOrigin: 4 } } } }
        }, { userJid: this.client.user?.id })
        await this.client.relayMessage(jid, msg.message, { messageId: msg.key.id })
        return msg
    }
}

// ─── GridImage ────────────────────────────────────────────────────────────────
export class GridImage extends BaseBuilder {
    static dispatchKeys = ['gridImageMessage']
    static shortcuts = {
        sendGridImageMessage: sock => (jid, data, opts = {}) => new GridImage(sock).from(data, opts).send(jid, opts)
    }

    async send(jid, opts = {}) {
        const imageUrls = this.data.imageUrls ?? this.data.images ?? (Array.isArray(this.data.gridImageMessage) ? this.data.gridImageMessage : [])
        if (!Array.isArray(imageUrls) || imageUrls.length < 2) throw new Error('GridImage requires at least 2 images')
        const expiration = String(Date.now() + 30 * 24 * 60 * 60 * 1000)
        // GRID_IMAGE submessage type (6) — proper protocol path, not just unified sections
        const submessages = [{ messageType: 6, gridImageMetadata: { imageUrls } }]
        const sections = imageUrls.map(img => {
            const image = typeof img === 'string' ? { url: img } : img
            const url = image.imageHighResUrl ?? image.highResUrl ?? image.fullUrl ?? image.imagePreviewUrl ?? image.previewUrl ?? image.url ?? ''
            const w = Number(image.width ?? 600), h = Number(image.height ?? 400)
            const media = (u, mw, mh) => ({ url: u, url_fallback: u, mime_type: image.mimeType ?? image.mime_type ?? 'image/png', expiration_timestamp_ms: expiration, width: mw, height: mh })
            return { preview_image: media(url, w, h), full_image: media(image.highResUrl ?? url, w, h), dark_mode_preview_image: media(image.darkModePreviewUrl ?? url, w, h), dark_mode_full_image: media(image.darkModeHighResUrl ?? url, w, h), asset_query_status: 'FETCHED', __typename: 'GenAIImagePrimitive' }
        })
        const unified = { response_id: crypto.randomUUID(), sections: [{ view_model: { primitives: sections, __typename: 'GenAIGridLayoutViewModel' } }] }
        const msg = await generateWAMessageFromContent(jid, {
            messageContextInfo: { botMetadata: { pluginMetadata: {}, botRenderingConfigMetadata: BOT_RENDERING_CONFIG_METADATA } },
            botForwardedMessage: { message: { richResponseMessage: { messageType: 1, submessages, unifiedResponse: { data: Buffer.from(JSON.stringify(unified)) }, contextInfo: { isForwarded: true, forwardingScore: 1, forwardedAiBotMessageInfo: { botJid: '867051314767696@bot' }, forwardOrigin: 4 } } } }
        }, { userJid: this.client.user?.id })
        await this.client.relayMessage(jid, msg.message, { messageId: msg.key.id })
        return msg
    }
}

// ─── VideoGrid ────────────────────────────────────────────────────────────────
export class VideoGrid extends BaseBuilder {
    static dispatchKeys = ['videoGridMessage']
    static shortcuts = {
        sendVideoGridMessage: sock => (jid, data, opts = {}) => new VideoGrid(sock).from(data, opts).send(jid, opts)
    }

    async send(jid, opts = {}) {
        const videos = this.data.videos ?? (Array.isArray(this.data.videoGridMessage) ? this.data.videoGridMessage : [])
        if (!Array.isArray(videos) || videos.length < 2) throw new Error('VideoGrid requires at least 2 videos')
        const primitives = videos.map((v, i) => {
            const url = typeof v === 'string' ? v : (v?.url ?? v?.videoUrl ?? v?.reelsUrl ?? '')
            if (!url) throw new Error(`VideoGrid item ${i}: requires a URL`)
            const item = typeof v === 'string' ? {} : v
            return { post_id: item.postId != null ? String(item.postId) : undefined, reels_url: url, reels_title: item.title, thumbnail_url: item.thumbnailUrl ?? item.thumbnail, creator: item.creator, avatar_url: item.avatarUrl, content_hash: item.contentHash, likes_count: item.likes, comments_count: item.comments, shares_count: item.shares, is_verified: item.isVerified, source_app: item.sourceApp, video_delivery_response: { progressive_urls: (item.progressiveUrls ?? []).map(u => ({ progressive_url: u, __typename: 'GenAIProgressiveUrlResponse' })), dash_manifests: (item.dashManifests ?? []).map(m => ({ manifest_xml: m, __typename: 'GenAIDashManifestResponse' })), __typename: 'GenAIVideoDeliveryResponse' }, __typename: 'GenAIVideoPrimitive' }
        })
        const unified = { response_id: crypto.randomUUID(), sections: [{ view_model: { primitives, __typename: 'GenAIGridLayoutViewModel' } }] }
        const msg = await generateWAMessageFromContent(jid, {
            messageContextInfo: { botMetadata: { pluginMetadata: {}, botRenderingConfigMetadata: BOT_RENDERING_CONFIG_METADATA } },
            botForwardedMessage: { message: { richResponseMessage: { messageType: 1, submessages: [], unifiedResponse: { data: Buffer.from(JSON.stringify(unified)) }, contextInfo: { isForwarded: true, forwardingScore: 1, forwardedAiBotMessageInfo: { botJid: '867051314767696@bot' }, forwardOrigin: 4 } } } }
        }, { userJid: this.client.user?.id })
        await this.client.relayMessage(jid, msg.message, { messageId: msg.key.id })
        return msg
    }
}

// ─── A2UI ─────────────────────────────────────────────────────────────────────
export class A2UI extends BaseBuilder {
    static dispatchKeys = ['a2uiMessage']
    static shortcuts = {
        sendA2UIMessage: sock => (jid, data, opts = {}) => new A2UI(sock).from(data, opts).send(jid, opts),
        sendA2UICommandMenu: sock => (jid, data, opts = {}) => new A2UI(sock).from(data, { __commandMenu: true, ...opts }).send(jid, opts)
    }

    async send(jid, opts = {}) {
        const d = this.data
        let content
        if (d.__commandMenu) {
            // command menu preset — builds bloksWidget + nativeFlowMessage together
            const rows = (d.rows ?? []).map((r, i) => ({ title: String(r?.[0] ?? r?.title ?? `Command ${i + 1}`), description: String(r?.[1] ?? r?.description ?? ''), id: String(r?.[2] ?? r?.id ?? r?.[0] ?? `command_${i + 1}`) }))
            const buttons = (d.buttons ?? []).map((b, i) => ({ id: `a2ui_button_${i + 1}`, label: String(b?.text ?? b?.label ?? `Button ${i + 1}`), url: String(b?.url ?? '') }))
            const componentIds = ['title', 'divider', 'tableCard', 'footer', ...(buttons.length ? ['buttonRow'] : [])]
            const components = [
                { id: 'root', component: 'Column', align: 'center', children: componentIds },
                { id: 'title', component: 'Text', text: String(d.title ?? 'Menu'), variant: 'h2' },
                { id: 'divider', component: 'Divider' },
                { id: 'tableCard', component: 'Card', child: 'tableColumn' },
                { id: 'tableColumn', component: 'Column', children: ['headerRow', ...rows.flatMap((_, i) => [`divider_${i}`, `row_${i}`])] },
                { id: 'headerRow', component: 'Row', children: ['headerCommand', 'headerFunction'] },
                { id: 'headerCommand', component: 'Text', text: 'Command', variant: 'h5' },
                { id: 'headerFunction', component: 'Text', text: 'Function', variant: 'h5' },
                ...rows.flatMap((r, i) => [{ id: `divider_${i}`, component: 'Divider' }, { id: `row_${i}`, component: 'Row', children: [`command_${i}`, `description_${i}`] }, { id: `command_${i}`, component: 'Text', text: r.title }, { id: `description_${i}`, component: 'Text', text: r.description }]),
                { id: 'footer', component: 'Text', text: d.footer ?? 'Powered by NexusBot', variant: 'caption' }
            ]
            if (buttons.length) {
                components.push({ id: 'buttonRow', component: 'Row', justify: 'spaceEvenly', children: buttons.flatMap((b, i) => [`buttonLabel_${i}`, `button_${i}`]) })
                buttons.forEach((b, i) => { components.push({ id: `buttonLabel_${i}`, component: 'Text', text: b.label }); components.push({ id: `button_${i}`, component: 'Button', child: `buttonLabel_${i}`, variant: 'primary', action: { call: 'openUrl', args: { url: b.url } } }) })
            }
            content = { interactiveMessage: { ...(d.imageMessage ? { header: { imageMessage: d.imageMessage, hasMediaAttachment: true } } : {}), bloksWidget: { type: 'im_a2ui', data: JSON.stringify({ version: 'v0.9', createSurface: { surfaceId: 'plogme-a2ui-command-menu', catalogId: 'https://a2ui.org/specification/v0_9/catalogs/basic/catalog.json', components } }), fallback: String(d.fallback ?? d.title ?? '') }, nativeFlowMessage: { messageParamsJson: JSON.stringify({ limited_time_offer: { text: String(d.title ?? ''), url: buttons[0]?.url ?? '', copy_code: String(d.title ?? ''), expiration_time: Date.now() * 1000 } }), buttons: [{ name: 'single_select', buttonParamsJson: JSON.stringify({ title: String(d.title ?? ''), sections: [{ title: 'Available Commands', rows }] }) }] } } }
        } else {
            // generic A2UI envelope
            const { imageMessage, bloksWidget = {}, nativeFlowMessage, fallback = '', ...rest } = d
            content = { interactiveMessage: { ...rest, ...(imageMessage ? { header: { imageMessage, hasMediaAttachment: true } } : {}), bloksWidget: { type: bloksWidget.type ?? 'im_a2ui', data: typeof bloksWidget.data === 'string' ? bloksWidget.data : JSON.stringify(bloksWidget.data ?? {}), ...(bloksWidget.fallback || fallback ? { fallback: String(bloksWidget.fallback ?? fallback) } : {}) }, ...(nativeFlowMessage ? { nativeFlowMessage: { ...nativeFlowMessage, ...(nativeFlowMessage.buttons ? { buttons: nativeFlowMessage.buttons } : {}) } } : {}) } }
        }
        const msg = await generateWAMessageFromContent(jid, content, { userJid: this.client.user?.id })
        const bizNode = getBizBinaryNode(msg.message)
        await this.client.relayMessage(jid, msg.message, { messageId: msg.key.id, additionalNodes: bizNode ? [bizNode] : [] })
        return msg
    }
}