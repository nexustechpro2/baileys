import crypto from 'crypto'
import { proto } from '../../WAProto/index.js'
import { generateWAMessageFromContent, generateWAMessage, generateMessageIDV2, prepareStickerPackMessage, prepareWAMessageMedia } from '../Utils/index.js'
import { getBizBinaryNode } from '../WABinary/index.js'

export { AIRich, aiRichFromObject } from './AIRich.js'

const delay = ms => new Promise(r => setTimeout(r, ms))

const SPECIAL_FLOW = {
  cta_url: { v: '2', name: 'cta_url' },
  cta_call: { v: '2', name: 'cta_call' },
  cta_copy: { v: '2', name: 'cta_copy' },
  cta_reminder: { v: '2', name: 'cta_reminder' },
  cta_cancel_reminder: { v: '2', name: 'cta_cancel_reminder' },
  address: { v: '2', name: 'address_message' },
  send_location: { v: '2', name: 'send_location' },
  cta_open_webview: { v: '3', name: 'cta_open_webview' },
  review_and_pay: { v: '4', name: 'review_and_pay' },
  review_order: { v: '4', name: 'review_order' },
  payment_status: { v: '4', name: 'payment_status' },
  transaction_details: { v: '4', name: 'transaction_details' },
  order_details: { v: '4', name: 'order_details' },
  multi_product: { v: '4', name: 'multi_product' },
  catalog: { v: '5', name: 'catalog_message' },
  flow: { v: '5', name: 'flow' },
  galaxy_message: { v: '9', name: 'galaxy_message' },
}

const DEFAULT_FLOW = { v: '9', name: 'mixed' }

export class Button {
  #client
  #buttons = []
  #header = {}
  #body = ''
  #footer = ''
  #title = ''
  #subtitle = ''
  #params = {}
  #mode = 'native'
  #bloks = null

  constructor(client, opts = {}) {
    if (!client) throw new Error('Socket client is required')
    this.#client = client
    if (opts.mode) this.#mode = opts.mode
  }

  setTitle(title) { this.#title = title; return this }
  setSubtitle(sub) { this.#subtitle = sub; return this }
  setBody(text) { this.#body = text; return this }
  setFooter(text) { this.#footer = text; return this }

  setImage(url, opts = {}) {
    this.#header = { hasMediaAttachment: true, imageMessage: { url, ...opts } }
    return this
  }
  setVideo(url, opts = {}) {
    this.#header = { hasMediaAttachment: true, videoMessage: { url, ...opts } }
    return this
  }
  setDocument(url, fileName = 'file', opts = {}) {
    this.#header = { hasMediaAttachment: true, documentMessage: { url, fileName, ...opts } }
    return this
  }
  setLocation(lat, lon, name = '') {
    this.#header = { hasMediaAttachment: false, locationMessage: { degreesLatitude: lat, degreesLongitude: lon, name } }
    return this
  }

  setParams(params) { this.#params = params; return this }
  setLimitedTimeOffer(expiry) { this.#params.limited_time_offer = { expiration_time_ms: expiry }; return this }
  setBottomSheet(opts = {}) { this.#params.bottom_sheet = opts; return this }
  setTapTargetConfiguration(opts = {}) { this.#params.tap_target_configuration = opts; return this }

  #addNative(name, params) {
    this.#mode = 'native'
    this.#buttons.push({ name, buttonParamsJson: JSON.stringify(params) })
    return this
  }

  reply(displayText, id) { return this.#addNative('quick_reply', { display_text: displayText, id }) }
  url(displayText, url, merchantUrl) { return this.#addNative('cta_url', { display_text: displayText, url, merchant_url: merchantUrl ?? url }) }
  call(displayText, phoneNumber) { return this.#addNative('cta_call', { display_text: displayText, phone_number: phoneNumber }) }
  copy(displayText, copyCode) { return this.#addNative('cta_copy', { display_text: displayText, copy_code: copyCode }) }
  openWebview(displayText, url, opts = {}) { return this.#addNative('cta_open_webview', { display_text: displayText, url, ...opts }) }
  catalog(displayText, opts = {}) { return this.#addNative('catalog', { display_text: displayText, ...opts }) }
  flow(displayText, flowId, opts = {}) { return this.#addNative('flow', { display_text: displayText, flow_id: flowId, flow_token: opts.token ?? crypto.randomUUID(), ...opts }) }
  remind(displayText, opts = {}) { return this.#addNative('cta_reminder', { display_text: displayText, ...opts }) }
  cancelReminder(displayText, opts = {}) { return this.#addNative('cta_cancel_reminder', { display_text: displayText, ...opts }) }
  address(displayText, opts = {}) { return this.#addNative('address', { display_text: displayText, ...opts }) }
  sendLocation(displayText) { return this.#addNative('send_location', { display_text: displayText }) }
  reviewAndPay(displayText, opts = {}) { return this.#addNative('review_and_pay', { display_text: displayText, ...opts }) }
  reviewOrder(displayText, opts = {}) { return this.#addNative('review_order', { display_text: displayText, ...opts }) }
  orderDetails(displayText, opts = {}) { return this.#addNative('order_details', { display_text: displayText, ...opts }) }
  paymentStatus(displayText, opts = {}) { return this.#addNative('payment_status', { display_text: displayText, ...opts }) }
  transactionDetails(displayText, opts = {}) { return this.#addNative('transaction_details', { display_text: displayText, ...opts }) }

  select(title, sections) { return this.#addNative('single_select', { title, sections }) }

  legacyButton(displayText, id) {
    this.#mode = 'legacy'
    this.#buttons.push({ buttonId: id, buttonText: { displayText }, type: 1 })
    return this
  }

  templateReply(displayText, id) {
    this.#mode = 'template'
    this.#buttons.push({ quickReplyButton: { displayText, id } })
    return this
  }
  templateUrl(displayText, url) {
    this.#mode = 'template'
    this.#buttons.push({ urlButton: { displayText, url } })
    return this
  }
  templateCall(displayText, phoneNumber) {
    this.#mode = 'template'
    this.#buttons.push({ callButton: { displayText, phoneNumber } })
    return this
  }

  setBloksWidget(components) {
    const flat = []
    const resolve = c => {
      if (!c.__id) c.__id = `c_${flat.length}`
      flat.push(c)
      if (c.children) c.children = c.children.map(ch => { resolve(ch); return ch.__id })
      if (c.$ref) c.$ref = c.$ref.__id
    }
      ; (Array.isArray(components) ? components : [components]).forEach(c => resolve(c))
    this.#bloks = flat
    this.#mode = 'native'
    return this
  }

  toCard() {
    return {
      header: this.#header,
      body: { text: this.#body },
      footer: { text: this.#footer },
      nativeFlowMessage: { buttons: this.#buttons },
    }
  }

  async build(jid, opts = {}) {
    const messageId = opts.messageId ?? generateMessageIDV2()
    const userJid = this.#client.user?.id

    if (this.#mode === 'legacy') {
      return generateWAMessageFromContent(jid, {
        buttonsMessage: {
          ...(Object.keys(this.#header).length ? this.#header : { contentText: this.#body }),
          footer: this.#footer,
          buttons: this.#buttons,
          headerType: Object.keys(this.#header).length ? 3 : 1,
        },
      }, { userJid, messageId })
    }

    if (this.#mode === 'template') {
      return generateWAMessageFromContent(jid, {
        templateMessage: {
          hydratedTemplate: {
            hydratedContentText: this.#body,
            hydratedFooterText: this.#footer,
            hydratedButtons: this.#buttons,
          },
        },
      }, { userJid, messageId })
    }

    const isSingleSelect = this.#buttons.length === 1 && this.#buttons[0].name === 'single_select'
    if (isSingleSelect && !this.#bloks) {
      const params = JSON.parse(this.#buttons[0].buttonParamsJson)
      return generateWAMessageFromContent(jid, {
        listMessage: {
          title: this.#title,
          description: this.#body,
          footerText: this.#footer,
          buttonText: params.title ?? 'Select',
          listType: 1,
          sections: params.sections ?? [],
        },
      }, { userJid, messageId })
    }

    const flowInfo = this.#buttons.reduce((acc, b) => {
      const f = SPECIAL_FLOW[b.name]
      return (!acc || (f && parseInt(f.v) > parseInt(acc.v))) ? (f ?? DEFAULT_FLOW) : acc
    }, null) ?? DEFAULT_FLOW

    return generateWAMessageFromContent(jid, {
      interactiveMessage: {
        header: Object.keys(this.#header).length ? this.#header : undefined,
        body: { text: this.#body },
        footer: { text: this.#footer },
        nativeFlowMessage: {
          messageParamsJson: Object.keys(this.#params).length ? JSON.stringify(this.#params) : undefined,
          buttons: this.#bloks
            ? [{ name: 'galaxy_message', buttonParamsJson: JSON.stringify({ wa_flow_response_params: { title: this.#title }, components: this.#bloks }) }]
            : this.#buttons,
        },
        ...(this.#title ? { title: this.#title } : {}),
        ...(this.#subtitle ? { subtitle: this.#subtitle } : {}),
      },
    }, { userJid, messageId })
  }

  async send(jid, opts = {}) {
    const msg = await this.build(jid, opts)
    const bizNode = getBizBinaryNode(msg.message)
    await this.#client.relayMessage(jid, msg.message, {
      messageId: msg.key.id,
      additionalNodes: bizNode ? [bizNode] : [],
    })
    return msg
  }
}

export class Interactive {
  #client
  #data = {}

  constructor(client) {
    if (!client) throw new Error('Socket client is required')
    this.#client = client
  }

  from(data) { this.#data = data; return this }

  async send(jid, opts = {}) {
    const i = this.#data
    const userJid = this.#client.user?.id

    let media = null
    const upload = this.#client.waUploadToServer
    if (i.thumbnail) media = await prepareWAMessageMedia({ image: { url: i.thumbnail } }, { upload })
    else if (i.image) media = await prepareWAMessageMedia({ image: i.image }, { upload })
    else if (i.video) media = await prepareWAMessageMedia({ video: i.video }, { upload })
    else if (i.document) media = await prepareWAMessageMedia({ document: i.document }, { upload })

    const bodyText = i.body?.text ?? i.title ?? ''
    const footerText = typeof i.footer === 'string' ? i.footer : (i.footer?.text ?? '')
    const headerTitle = typeof i.header === 'string' ? i.header : (i.header?.title ?? '')

    let nativeFlow = null
    if (i.buttons?.length || i.nativeFlowMessage) {
      const nfm = i.nativeFlowMessage ?? {}
      nativeFlow = proto.Message.InteractiveMessage.NativeFlowMessage.create({
        buttons: i.buttons ?? nfm.buttons ?? [],
        messageParamsJson: nfm.messageParamsJson ?? '',
      })
    }

    const headerMedia = {}
    if (media?.imageMessage) headerMedia.imageMessage = media.imageMessage
    if (media?.videoMessage) headerMedia.videoMessage = media.videoMessage
    if (media?.documentMessage) headerMedia.documentMessage = media.documentMessage

    const interactive = proto.Message.InteractiveMessage.create({
      body: proto.Message.InteractiveMessage.Body.create({ text: bodyText }),
      footer: proto.Message.InteractiveMessage.Footer.create({ text: footerText }),
      header: proto.Message.InteractiveMessage.Header.create({ title: headerTitle, hasMediaAttachment: !!media, ...headerMedia }),
      ...(nativeFlow ? { nativeFlowMessage: nativeFlow } : {}),
    })

    if (i.contextInfo) interactive.contextInfo = i.contextInfo

    const msg = await generateWAMessageFromContent(jid, { interactiveMessage: interactive }, { userJid, quoted: opts.quoted })
    const bizNode = getBizBinaryNode(msg.message)
    await this.#client.relayMessage(jid, msg.message, {
      messageId: msg.key.id,
      additionalNodes: bizNode ? [bizNode] : [],
    })
    return msg
  }
}

export class Album {
  #client
  #items = []
  #delay = 1500

  constructor(client) {
    if (!client) throw new Error('Socket client is required')
    this.#client = client
  }

  image(urlOrBuffer, caption = '') {
    this.#items.push({ image: typeof urlOrBuffer === 'string' ? { url: urlOrBuffer } : urlOrBuffer, caption })
    return this
  }

  video(urlOrBuffer, caption = '') {
    this.#items.push({ video: typeof urlOrBuffer === 'string' ? { url: urlOrBuffer } : urlOrBuffer, caption })
    return this
  }

  add(items) { items.forEach(item => this.#items.push(item)); return this }

  setDelay(ms) { this.#delay = ms; return this }

  async send(jid, opts = {}) {
    if (this.#items.length < 2) throw new Error('Album requires at least 2 items')
    const userJid = this.#client.user?.id
    const upload = this.#client.waUploadToServer
    const messageId = generateMessageIDV2()

    const album = await generateWAMessageFromContent(jid, {
      messageContextInfo: proto.MessageContextInfo.create({ messageSecret: crypto.randomBytes(32) }),
      albumMessage: proto.Message.AlbumMessage.create({
        expectedImageCount: this.#items.filter(a => a.image).length,
        expectedVideoCount: this.#items.filter(a => a.video).length,
      }),
    }, { userJid, messageId })

    await this.#client.relayMessage(jid, album.message, { messageId: album.key.id })

    for (const item of this.#items) {
      const img = await generateWAMessage(jid, item, { upload, userJid })
      img.message.messageContextInfo = proto.MessageContextInfo.create({
        messageSecret: crypto.randomBytes(32),
        messageAssociation: proto.MessageAssociation.create({
          associationType: 1, // MEDIA_ALBUM
          parentMessageKey: album.key,
        }),
      })
      await this.#client.relayMessage(jid, img.message, { messageId: img.key.id })
      await delay(this.#delay)
    }

    return album
  }
}

export class Poll {
  #client
  #data = {
    name: '',
    values: [],
    selectableOptionsCount: 1,
    toAnnouncementGroup: false,
    hideVoter: false,
  }

  constructor(client) {
    if (!client) throw new Error('Socket client is required')
    this.#client = client
  }

  name(name) { this.#data.name = name; return this }
  options(opts) { this.#data.values = opts; return this }
  addOption(opt) { this.#data.values.push(opt); return this }
  multiSelect(max = 0) { this.#data.selectableOptionsCount = max; return this }
  hideVoter(v = true) { this.#data.hideVoter = v; return this }
  announcement(v = true) { this.#data.toAnnouncementGroup = v; return this }
  quiz(correctAnswer) { this.#data.pollType = 1; this.#data.correctAnswer = correctAnswer; return this }
  setEndTime(t) { this.#data.endTime = t; return this }
  hideParticipantName(v = true) { this.#data.hideParticipantName = v; return this }
  allowAddOption(v = true) { this.#data.allowAddOption = v; return this }

  async send(jid, opts = {}) {
    if (!this.#data.name) throw new Error('Poll name is required')
    if (this.#data.values.length < 2) throw new Error('Poll requires at least 2 options')
    return this.#client.sendMessage(jid, { poll: this.#data }, opts)
  }
}

export class Carousel {
  #client
  #cards = []
  #caption = ''
  #footer = ''
  #cardType = 'HSCROLL_CARDS'

  constructor(client) {
    if (!client) throw new Error('Socket client is required')
    this.#client = client
  }

  setCaption(text) { this.#caption = text; return this }
  setFooter(text) { this.#footer = text; return this }
  setCardType(type) { this.#cardType = type; return this } // 'HSCROLL_CARDS' | 'ALBUM_IMAGE'

  card(buttonBuilder) {
    this.#cards.push(buttonBuilder instanceof Button ? buttonBuilder.toCard() : buttonBuilder)
    return this
  }

  async send(jid, opts = {}) {
    if (!this.#cards.length) throw new Error('Carousel requires at least 1 card')
    if (this.#cards.length > 10) throw new Error('Carousel max 10 cards')
    const userJid = this.#client.user?.id

    const msg = await generateWAMessageFromContent(jid, {
      interactiveMessage: proto.Message.InteractiveMessage.create({
        header: proto.Message.InteractiveMessage.Header.create({ hasMediaAttachment: false }),
        body: proto.Message.InteractiveMessage.Body.create({ text: this.#caption }),
        footer: proto.Message.InteractiveMessage.Footer.create({ text: this.#footer }),
        carouselMessage: proto.Message.InteractiveMessage.CarouselMessage.create({
          cards: this.#cards.map(c => ({
            header: proto.Message.InteractiveMessage.Header.create({ title: c.header?.title ?? '', hasMediaAttachment: c.header?.hasMediaAttachment ?? false, ...c.header }),
            body: proto.Message.InteractiveMessage.Body.create({ text: c.body?.text ?? '' }),
            footer: proto.Message.InteractiveMessage.Footer.create({ text: c.footer?.text ?? '' }),
            nativeFlowMessage: proto.Message.InteractiveMessage.NativeFlowMessage.create({ buttons: c.nativeFlowMessage?.buttons ?? [] }),
          })),
          messageVersion: 1,
          carouselCardType: this.#cardType === 'ALBUM_IMAGE' ? 2 : 1,
        }),
      }),
    }, { userJid })

    const bizNode = getBizBinaryNode(msg.message)
    await this.#client.relayMessage(jid, msg.message, {
      messageId: msg.key.id,
      additionalNodes: bizNode ? [bizNode] : [],
    })
    return msg
  }
}

export class Payment {
  #client
  #data = {}

  constructor(client) {
    if (!client) throw new Error('Socket client is required')
    this.#client = client
  }

  from(data) { this.#data = data; return this }
  setAmount(amount) { this.#data.amount = amount; return this }
  setCurrency(code) { this.#data.currency = code; return this }
  setExpiry(timestamp) { this.#data.expiry = timestamp; return this }
  setNote(note) { this.#data.note = note; return this }
  setFrom(jid) { this.#data.from = jid; return this }

  async send(jid, opts = {}) {
    const d = this.#data
    const userJid = this.#client.user?.id
    const ctx = opts.quoted ? { stanzaId: opts.quoted.key?.id, participant: opts.quoted.key?.participant, quotedMessage: opts.quoted.message } : {}
    const notes = d.note ? { extendedTextMessage: { text: d.note, contextInfo: ctx } } : {}

    const msg = await generateWAMessageFromContent(jid, {
      requestPaymentMessage: proto.Message.RequestPaymentMessage.fromObject({
        expiryTimestamp: d.expiry ?? 0,
        amount1000: d.amount ?? 0,
        currencyCodeIso4217: d.currency ?? 'NGN',
        requestFrom: d.from ?? '0@s.whatsapp.net',
        noteMessage: notes,
        background: d.background ?? { id: 'DEFAULT', placeholderArgb: 0xfff0f0f0 },
      }),
    }, { userJid })

    await this.#client.relayMessage(jid, msg.message, { messageId: msg.key.id })
    return msg
  }
}

export class Order {
  #client
  #data = {}

  constructor(client) {
    if (!client) throw new Error('Socket client is required')
    this.#client = client
  }

  from(data) { this.#data = data; return this }

  async send(jid, opts = {}) {
    const o = this.#data
    const userJid = this.#client.user?.id
    const upload = this.#client.waUploadToServer

    let thumb = null
    if (o.thumbnail) {
      if (Buffer.isBuffer(o.thumbnail)) {
        thumb = o.thumbnail
      } else if (typeof o.thumbnail === 'string') {
        try {
          const { default: axios } = await import('axios')
          const res = await axios.get(o.thumbnail, { responseType: 'arraybuffer' })
          thumb = Buffer.from(res.data)
        } catch { }
      }
    }

    const cleanJid = id => {
      if (!id) return null
      const [user] = id.split(':')
      return user.includes('@') ? user : `${user}@s.whatsapp.net`
    }

    const seller = cleanJid(o.sellerJid) ?? cleanJid(userJid) ?? cleanJid(jid) ?? '0@s.whatsapp.net'

    const msg = await generateWAMessageFromContent(jid, {
      orderMessage: proto.Message.OrderMessage.create({
        orderId: o.orderId ?? `NEXUS${Date.now()}`,
        thumbnail: thumb,
        itemCount: o.itemCount ?? 0,
        status: 2, surface: 1,
        message: o.message,
        orderTitle: o.orderTitle,
        sellerJid: seller,
        token: o.token ?? 'NEXUS_TOKEN',
        totalAmount1000: o.totalAmount1000 ?? 0,
        totalCurrencyCode: o.totalCurrencyCode ?? 'NGN',
        messageVersion: 2,
      }),
    }, { userJid, quoted: opts.quoted })

    await this.#client.relayMessage(jid, msg.message, { messageId: msg.key.id })
    return msg
  }
}

export class Event {
  #client
  #data = {}

  constructor(client) {
    if (!client) throw new Error('Socket client is required')
    this.#client = client
  }

  from(data) { this.#data = data; return this }
  setName(name) { this.#data.name = name; return this }
  setDescription(desc) { this.#data.description = desc; return this }
  setLocation(loc) { this.#data.location = loc; return this }
  setJoinLink(link) { this.#data.joinLink = link; return this }
  setStartTime(t) { this.#data.startTime = t; return this }
  setEndTime(t) { this.#data.endTime = t; return this }
  setCanceled(v = true) { this.#data.isCanceled = v; return this }
  setReminder(offsetSec) { this.#data.hasReminder = true; this.#data.reminderOffsetSec = offsetSec; return this }
  setScheduledCall(v = true) { this.#data.isScheduleCall = v; return this }

  async send(jid, opts = {}) {
    const e = this.#data
    const userJid = this.#client.user?.id
    const parseTime = (val, def) => typeof val === 'string' ? parseInt(val) : (val ?? def)

    const msg = await generateWAMessageFromContent(jid, {
      messageContextInfo: proto.MessageContextInfo.create({
        deviceListMetadata: {}, deviceListMetadataVersion: 2,
        messageSecret: crypto.randomBytes(32),
        supportPayload: JSON.stringify({ version: 2, is_ai_message: true, should_show_system_message: true, ticket_id: crypto.randomBytes(16).toString('hex') }),
      }),
      eventMessage: proto.Message.EventMessage.create({
        contextInfo: proto.ContextInfo.create({
          mentionedJid: [jid], participant: jid, remoteJid: 'status@broadcast',
          forwardedNewsletterMessageInfo: proto.ContextInfo.ForwardedNewsletterMessageInfo.create({
            newsletterName: 'Nexus Events',
            newsletterJid: '120363422827915475@newsletter',
            serverMessageId: 1,
          }),
        }),
        isCanceled: e.isCanceled ?? false,
        name: e.name,
        description: e.description,
        location: e.location ?? { degreesLatitude: 0, degreesLongitude: 0, name: 'Location' },
        joinLink: e.joinLink ?? '',
        startTime: parseTime(e.startTime, Date.now()),
        endTime: parseTime(e.endTime, Date.now() + 3600000),
        extraGuestsAllowed: e.extraGuestsAllowed !== false,
        ...(e.hasReminder ? { hasReminder: true, reminderOffsetSec: e.reminderOffsetSec ?? 3600 } : {}),
        ...(e.isScheduleCall !== undefined ? { isScheduleCall: e.isScheduleCall } : {}),
      }),
    }, { userJid, quoted: opts.quoted })

    await this.#client.relayMessage(jid, msg.message, { messageId: msg.key.id })
    return msg
  }
}

export class StickerPack {
  #client
  #data = {}

  constructor(client) {
    if (!client) throw new Error('Socket client is required')
    this.#client = client
  }

  from(data) { this.#data = data; return this }
  setStickers(stickers) { this.#data.stickers = stickers; return this }

  async send(jid, opts = {}) {
    const userJid = this.#client.user?.id
    const upload = this.#client.waUploadToServer
    const raw = this.#data

    const result = await prepareStickerPackMessage(raw, {
      upload,
      logger: this.#client.logger,
    })

    if (result.isBatched) {
      let last
      for (let i = 0; i < result.stickerPackMessage.length; i++) {
        const msg = await generateWAMessageFromContent(jid, { stickerPackMessage: result.stickerPackMessage[i] }, { userJid, quoted: opts.quoted })
        await this.#client.relayMessage(jid, msg.message, { messageId: msg.key.id })
        last = msg
        if (i < result.stickerPackMessage.length - 1) await delay(2000)
      }
      return last
    }

    const msg = await generateWAMessageFromContent(jid, { stickerPackMessage: result.stickerPackMessage }, { userJid, quoted: opts.quoted })
    await this.#client.relayMessage(jid, msg.message, { messageId: msg.key.id })
    return msg
  }
}
