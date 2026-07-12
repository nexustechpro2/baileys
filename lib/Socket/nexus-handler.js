import { proto } from '../../WAProto/index.js'
import axios from 'axios'
import crypto from 'crypto'
import { createRequire } from 'module'
const _require = createRequire(import.meta.url)
const Prism = _require('prismjs')
const loadPrismLanguages = _require('prismjs/components/index')

let _prismReady = false
const ensurePrism = () => { if (_prismReady) return; _prismReady = true; try { loadPrismLanguages() } catch { } }

const PRISM_TYPE_MAP = {
    keyword: 1, 'keyword control': 1, builtin: 1, important: 1, bold: 1,
    function: 2, 'function-definition': 2, method: 2, 'method-definition': 2,
    string: 3, 'template-string': 3, 'string interpolation': 3, char: 3, regex: 3,
    number: 4, constant: 4, boolean: 4, unit: 4,
    comment: 5, 'block-comment': 5, prolog: 5, doctype: 5,
}

const flattenPrism = (tokens, out = []) => {
    for (const t of tokens) {
        if (typeof t === 'string') { if (t) out.push({ codeContent: t, highlightType: 0 }); continue }
        const type = PRISM_TYPE_MAP[t.type] ?? 0
        const content = Array.isArray(t.content) ? flattenPrism(t.content, []).map(x => x.codeContent).join('') : String(t.content)
        if (content) out.push({ codeContent: content, highlightType: type })
    }
    return out
}

const tokenizeCode = (code, language = 'javascript') => {
    ensurePrism()
    const lang = language.toLowerCase()
    const grammar = Prism.languages[lang] ?? Prism.languages.javascript
    const raw = flattenPrism(Prism.tokenize(code, grammar))
    const merged = []
    for (const t of raw) {
        const prev = merged[merged.length - 1]
        if (prev && prev.highlightType === t.highlightType) prev.codeContent += t.codeContent
        else merged.push({ ...t })
    }
    const TYPE_NAMES = ['DEFAULT', 'KEYWORD', 'METHOD', 'STR', 'NUMBER', 'COMMENT']
    return { codeBlocks: merged, unified_codeBlock: merged.map(t => ({ content: t.codeContent, type: TYPE_NAMES[t.highlightType] ?? 'DEFAULT' })) }
}

const extractHyperlinks = (text) => {
    const hyperlinks = []
    let cleaned = text
    const IE_RE = /\{\{IE_(\d+)\}\}([\s\S]*?)\{\{\/IE_\1\}\}/g
    const URL_RE = /https?:\/\/[^\s\])"]+/g
    let match
    while ((match = IE_RE.exec(text)) !== null) { hyperlinks.push({ key: `IE_${match[1]}`, reference_id: parseInt(match[1]) + 1, text: match[2], url: '' }); cleaned = cleaned.replace(match[0], match[2]) }
    if (!hyperlinks.length) { while ((match = URL_RE.exec(text)) !== null) hyperlinks.push({ key: `IE_${hyperlinks.length}`, reference_id: hyperlinks.length + 1, text: '', url: match[0] }) }
    return { text: cleaned, hyperlinks }
}

const parseTableArray = (table) => {
    const [title, headerStr, ...rest] = table
    const splitCols = s => typeof s === 'string' ? (s.includes('|') ? s.split('|') : s.split(',')).map(x => x.trim()) : (Array.isArray(s) ? s.map(String) : [])
    const headers = splitCols(headerStr)
    const rows = rest.flatMap(r => typeof r === 'string' ? r.split(';;').map(splitCols) : [Array.isArray(r) ? r.map(String) : [String(r)]])
    const maxLen = Math.max(headers.length, ...rows.map(r => r.length))
    const pad = arr => [...arr, ...Array(maxLen - arr.length).fill('')]
    return { title: String(title ?? ''), rows: [{ items: pad(headers), isHeading: true }, ...rows.map(r => ({ items: pad(r) }))], unified_rows: [{ is_header: true, cells: pad(headers) }, ...rows.map(r => ({ is_header: false, cells: pad(r) }))] }
}

class NexusHandler {
    constructor(utils, waUploadToServer, relayMessageFn, options = {}) {
        this.utils = utils
        this.relay = relayMessageFn
        this.upload = waUploadToServer
        this.opts = options
        this.user = options.user || null
        this.handlers = {
            PAYMENT: this.handlePayment.bind(this),
            PRODUCT: this.handleProduct.bind(this),
            INTERACTIVE: this.handleInteractive.bind(this),
            ALBUM: this.handleAlbum.bind(this),
            EVENT: this.handleEvent.bind(this),
            POLL_RESULT: this.handlePollResult.bind(this),
            STATUS_MENTION: this.handleStMention.bind(this),
            ORDER: this.handleOrderMessage.bind(this),
            STICKER_PACK: this.handleStickerPack.bind(this),
            GROUP_STATUS: this.handleGroupStory.bind(this),
            CAROUSEL: this.handleCarousel.bind(this),
            CAROUSEL_PROTO: this.handleCarouselProto.bind(this),
            AI_RICH: this.handleAiRich.bind(this)
        }
    }

    // ─── TYPE DETECTION ───────────────────────────────────────────────────────
    detectType(content) {
        if (content.aiRich || content.airich || content.richResponse || content.richResponseMessage || content.AIRich) return 'AI_RICH'
        if (content.carouselMessage || content.carousel) return 'CAROUSEL'
        if (content.carouselProto) return 'CAROUSEL_PROTO'
        const map = {
            requestPaymentMessage: 'PAYMENT', productMessage: 'PRODUCT',
            interactiveMessage: 'INTERACTIVE', interactive: 'INTERACTIVE',
            albumMessage: 'ALBUM', eventMessage: 'EVENT',
            pollResultMessage: 'POLL_RESULT', statusMentionMessage: 'STATUS_MENTION',
            orderMessage: 'ORDER', stickerPack: 'STICKER_PACK', groupStatus: 'GROUP_STATUS'
        }
        return map[Object.keys(map).find(k => content[k])] || null
    }

    // ─── UNIFIED PROCESSOR ────────────────────────────────────────────────────
    async processMessage(content, jid, quoted) {
        const type = this.detectType(content)
        if (!type) throw new Error('Unknown message type')
        const handler = this.handlers[type]
        if (!handler) throw new Error(`No handler for: ${type}`)
        return await handler(content, jid, quoted)
    }

    // ─── HELPERS ──────────────────────────────────────────────────────────────
    async prepMedia(data, type) {
        if (!data) return null
        const payload = typeof data === 'object' && data.url ? { [type]: { url: data.url } } : { [type]: data }
        return await this.utils.prepareWAMessageMedia(payload, { upload: this.upload })
    }

    async genMsg(jid, content, opts = {}) {
        return await this.utils.generateWAMessage(jid, content, { ...opts, upload: this.upload, userJid: opts.userJid || this.user?.id, getUrlInfo: opts.getUrlInfo || this.opts.getUrlInfo, logger: opts.logger || this.opts.logger })
    }

    async genFromContent(jid, content, opts = {}) {
        return await this.utils.generateWAMessageFromContent(jid, content, { ...opts, userJid: opts.userJid || this.user?.id })
    }

    async sendMsg(jid, message, opts = {}) { return await this.relay(jid, message, opts) }

    buildCtx(quoted, sender) { return { stanzaId: quoted?.key?.id, participant: quoted?.key?.participant || sender, quotedMessage: quoted?.message } }

    buildFullCtx(ctx, adReply) {
        const allowed = ['title', 'body', 'mediaType', 'thumbnailUrl', 'mediaUrl', 'sourceUrl', 'showAdAttribution', 'renderLargerThumbnail', 'thumbnail']
        const final = ctx ? { mentionedJid: ctx.mentionedJid || [], forwardingScore: ctx.forwardingScore || 0, isForwarded: ctx.isForwarded || false, ...ctx } : {}
        if (adReply) { final.externalAdReply = {}; for (const k of allowed) if (adReply[k] !== undefined) final.externalAdReply[k] = adReply[k]; final.externalAdReply = { mediaType: 1, showAdAttribution: false, renderLargerThumbnail: false, ...final.externalAdReply } }
        return final
    }

    genJid() { const id = this.utils.generateMessageIDV2?.() || this.utils.generateMessageID?.() || crypto.randomBytes(10).toString('hex'); return id.includes('@') ? id : `${id}@s.whatsapp.net` }
    parseTime(val, def) { return typeof val === 'string' ? parseInt(val) : (val || def) }
    delay(ms) { return new Promise(r => setTimeout(r, ms)) }
    genMsgId() { return this.utils.generateMessageIDV2?.() || crypto.randomBytes(10).toString('hex').toUpperCase() }

    async downloadBuffer(urlOrBuffer) {
        if (Buffer.isBuffer(urlOrBuffer)) return urlOrBuffer
        if (typeof urlOrBuffer === 'string') { try { const res = await axios.get(urlOrBuffer, { responseType: 'arraybuffer' }); return Buffer.from(res.data) } catch { this.opts.logger?.warn('Failed to download buffer from URL') } }
        return null
    }

    // ─── AI RICH MESSAGES ─────────────────────────────────────────────────────
    _buildAiRichPayload(data = {}) {
        const submessages = [], sections = [], richResponseSources = []

        const addText = (text = '') => {
            const str = String(text ?? '')
            const { text: cleaned, hyperlinks } = extractHyperlinks(str)
            submessages.push({ messageType: 2, messageText: cleaned })
            sections.push({ view_model: { primitive: hyperlinks.length ? { text: cleaned, inline_entities: hyperlinks.map(h => ({ key: h.key, metadata: h.text?.trim() ? { display_name: h.text, is_trusted: true, url: h.url, __typename: 'GenAIInlineLinkItem' } : { reference_id: h.reference_id, reference_url: h.url, reference_title: h.url, reference_display_name: h.url, sources: [], __typename: 'GenAISearchCitationItem' } })), __typename: 'GenAIMarkdownTextUXPrimitive' } : { text: str, __typename: 'GenAIMarkdownTextUXPrimitive' }, __typename: 'GenAISingleLayoutViewModel' } })
        }

        const addCode = (language = 'javascript', code = '') => {
            const { codeBlocks, unified_codeBlock } = tokenizeCode(String(code ?? ''), language)
            submessages.push({ messageType: 5, codeMetadata: { codeLanguage: language, codeBlocks } })
            sections.push({ view_model: { primitive: { language, code_blocks: unified_codeBlock, __typename: 'GenAICodeUXPrimitive' }, __typename: 'GenAISingleLayoutViewModel' } })
        }

        const addTable = (table = []) => {
            const isRaw = Array.isArray(table[0])
            let meta
            if (isRaw) {
                const headers = table[0].map(String), rows = table.slice(1).map(r => r.map(String))
                const maxLen = Math.max(headers.length, ...rows.map(r => r.length))
                const pad = arr => [...arr, ...Array(maxLen - arr.length).fill('')]
                meta = { title: '', rows: [{ items: pad(headers), isHeading: true }, ...rows.map(r => ({ items: pad(r) }))], unified_rows: [{ is_header: true, cells: pad(headers) }, ...rows.map(r => ({ is_header: false, cells: pad(r) }))] }
            } else { meta = parseTableArray(table) }
            submessages.push({ messageType: 4, tableMetadata: { title: meta.title, rows: meta.rows } })
            sections.push({ view_model: { primitive: { rows: meta.unified_rows, ...(meta.title ? { title: meta.title } : {}), __typename: 'GenATableUXPrimitive' }, __typename: 'GenAISingleLayoutViewModel' } })
        }

        const addImages = (images = []) => {
            const list = (Array.isArray(images) ? images : [images]).filter(Boolean).map(item => { const url = typeof item === 'string' ? item : item.url || item.imageUrl || item.imagePreviewUrl; return { imagePreviewUrl: url, imageHighResUrl: item?.imageHighResUrl || item?.highResUrl || url, sourceUrl: item?.sourceUrl || data.sourceUrl || 'https://google.com' } }).filter(x => x.imagePreviewUrl)
            if (!list.length) return
            submessages.push({ messageType: 1, gridImageMetadata: { gridImageUrl: { imagePreviewUrl: list[0].imagePreviewUrl }, imageUrls: list } })
            list.forEach(({ imagePreviewUrl }) => sections.push({ view_model: { primitive: { media: { url: imagePreviewUrl, mime_type: 'image/jpeg' }, imagine_type: 3, status: { status: 'READY' }, __typename: 'GenAIImaginePrimitive' }, __typename: 'GenAISingleLayoutViewModel' } }))
        }

        const addSources = (sources = []) => {
            if (!Array.isArray(sources) || !sources.length) return
            sections.push({ view_model: { primitive: { sources: sources.map(s => { const arr = Array.isArray(s) ? s : null; return { source_type: 'THIRD_PARTY', source_display_name: arr ? arr[2] : s.displayName || s.title || s.sourceTitle || 'Source', source_subtitle: s.subtitle || 'AI', source_url: arr ? arr[1] : s.url || s.sourceUrl || '', favicon: { url: arr ? arr[0] : s.profileIconUrl || s.faviconUrl || s.thumbnailUrl || '', mime_type: 'image/jpeg', width: 16, height: 16 } } }), search_engine: data.searchEngine || 'MAME', __typename: 'GenAISearchResultPrimitive' }, __typename: 'GenAISingleLayoutViewModel' } })
        }

        const addReels = (reels = []) => {
            if (!Array.isArray(reels) || !reels.length) return
            submessages.push({ messageType: 9, contentItemsMetadata: { contentType: 1, itemsMetadata: reels.map(r => ({ reelItem: { title: r.title || r.creator || '', profileIconUrl: r.profileIconUrl || r.avatar_url || '', thumbnailUrl: r.thumbnailUrl || r.thumbnail_url || '', videoUrl: r.videoUrl || r.reels_url || r.url || '' } })) } })
            reels.forEach((r, idx) => richResponseSources.push({ provider: r.provider || 'UNKNOWN', thumbnailCDNURL: r.thumbnailUrl || '', sourceProviderURL: r.videoUrl || r.url || '', sourceQuery: '', faviconCDNURL: r.profileIconUrl || '', citationNumber: idx + 1, sourceTitle: r.title || r.creator || `Reel ${idx + 1}` }))
            sections.push({ view_model: { primitives: reels.map(r => ({ reels_url: r.videoUrl || r.url || '', thumbnail_url: r.thumbnailUrl || r.thumbnail_url || '', creator: r.title || r.creator || '', avatar_url: r.profileIconUrl || r.avatar_url || '', reels_title: r.reels_title || r.title || '', likes_count: r.likes_count || 0, shares_count: r.shares_count || 0, view_count: r.view_count || 0, reel_source: r.reel_source || 'IG', is_verified: !!(r.is_verified ?? r.isVerified), __typename: 'GenAIReelPrimitive' })), __typename: 'GenAIHScrollLayoutViewModel' } })
        }

        const addLatex = (expressions = [], text = '') => {
            submessages.push({ messageType: 8, latexMetadata: { text, expressions: expressions.map(e => ({ latexExpression: e.expression || e.latexExpression || '', url: e.url || '', width: e.width || 0, height: e.height || 0, ...(e.fontHeight !== undefined ? { fontHeight: e.fontHeight } : {}), ...(e.imageTopPadding !== undefined ? { imageTopPadding: e.imageTopPadding } : {}), ...(e.imageLeadingPadding !== undefined ? { imageLeadingPadding: e.imageLeadingPadding } : {}), ...(e.imageBottomPadding !== undefined ? { imageBottomPadding: e.imageBottomPadding } : {}), ...(e.imageTrailingPadding !== undefined ? { imageTrailingPadding: e.imageTrailingPadding } : {}) })) } })
        }

        // process in declaration order for predictable output
        if (data.header) addText(data.header)
        if (data.text) addText(data.text)
        if (Array.isArray(data.texts)) data.texts.forEach(t => addText(t))
        if (data.code) { typeof data.code === 'string' ? addCode(data.language || 'javascript', data.code) : addCode(data.code.language || data.language || 'javascript', data.code.content || data.code.code || '') }
        if (Array.isArray(data.codes)) data.codes.forEach(c => typeof c === 'string' ? addCode(data.language || 'javascript', c) : addCode(c.language || data.language || 'javascript', c.content || c.code || ''))
        if (data.table) { Array.isArray(data.table[0]) ? addTable(data.table) : Array.isArray(data.table) ? addTable(data.table) : null }
        if (data.headers && data.rows) addTable([[...(data.title ? [data.title] : ['']), data.headers, ...data.rows].flat(0)])
        if (data.image || data.images || data.gridImage) addImages(data.images || data.gridImage || data.image)
        if (data.sources) addSources(data.sources)
        if (data.reels || data.reel) addReels(data.reels || data.reel)
        if (data.latex) addLatex(Array.isArray(data.latex) ? data.latex : [data.latex], data.latexText || '')
        if (Array.isArray(data.parts)) {
            for (const p of data.parts) {
                if (p.type === 'text') addText(p.content)
                else if (p.type === 'code') addCode(p.language || 'javascript', p.content)
                else if (p.type === 'table') { if (Array.isArray(p.table)) addTable(p.table); else if (p.headers && p.rows) addTable([p.title || '', p.headers, ...p.rows]) }
                else if (p.type === 'images') addImages(p.images || p.image)
                else if (p.type === 'sources') addSources(p.sources)
                else if (p.type === 'reels') addReels(p.reels)
                else if (p.type === 'latex') addLatex(Array.isArray(p.expressions) ? p.expressions : [p.expressions], p.text || '')
            }
        }
        if (data.footer) addText(data.footer)

        const forwarded = data.forwarded !== false
        const includesUnifiedResponse = data.includesUnifiedResponse !== false
        const botJid = data.botJid || '259786046210223@bot'
        const allSources = data.richResponseSources || richResponseSources
        const ctxInfo = forwarded ? { forwardingScore: data.forwardingScore || 2, isForwarded: true, forwardedAiBotMessageInfo: { botJid }, forwardOrigin: data.forwardOrigin || 4, botMessageSharingInfo: { botEntryPointOrigin: 1, forwardScore: data.forwardingScore || 2 }, mentionedJid: [], groupMentions: [], ...(data.quoted?.key ? { stanzaId: data.quoted.key.id, participant: data.quoted.key.participant ?? data.quoted.sender ?? data.quoted.key.remoteJid, quotedMessage: data.quoted.message } : {}), ...(data.contextInfo || {}) } : (data.contextInfo || {})

        return {
            messageContextInfo: {
                deviceListMetadata: { senderKeyIndexes: [], recipientKeyIndexes: [], recipientKeyHash: '', recipientTimestamp: Math.floor(Date.now() / 1000) },
                deviceListMetadataVersion: 2,
                messageSecret: crypto.randomBytes(32),
                botMetadata: { messageDisclaimerText: data.disclaimerText || data.messageDisclaimerText || '', pluginMetadata: {}, richResponseSourcesMetadata: { sources: allSources } }
            },
            botForwardedMessage: { message: { richResponseMessage: { messageType: data.messageType || 1, submessages, unifiedResponse: { data: includesUnifiedResponse ? Buffer.from(JSON.stringify({ response_id: data.responseId || crypto.randomUUID(), sections })).toString('base64') : '' }, contextInfo: ctxInfo } } }
        }
    }

    async handleAiRich(content, jid, quoted) {
        const raw = content.aiRich || content.airich || content.richResponse || content.richResponseMessage || content.AIRich || content
        const data = { ...raw, quoted: raw.quoted || quoted }
        const message = this._buildAiRichPayload(data)
        const messageId = raw.messageId || this.genMsgId()
        await this.sendMsg(jid, message, { messageId })
        return { message, messageId }
    }

    captureAiRich(msg) {
        const rich = msg?.botForwardedMessage?.message?.richResponseMessage
        if (!rich?.unifiedResponse?.data) return null
        return { submessages: rich.submessages || [], sections: JSON.parse(Buffer.from(rich.unifiedResponse.data, 'base64').toString()), contextInfo: rich.contextInfo || {}, messageType: rich.messageType || 1 }
    }

    async relayAiRich(jid, captured, quoted) {
        const data = { responseId: captured.sections?.response_id, forwarded: true, quoted, includesUnifiedResponse: true, messageType: captured.messageType }
        const message = this._buildAiRichPayload(data)
        message.botForwardedMessage.message.richResponseMessage.submessages = captured.submessages
        message.botForwardedMessage.message.richResponseMessage.unifiedResponse.data = Buffer.from(JSON.stringify(captured.sections)).toString('base64')
        const messageId = this.genMsgId()
        await this.sendMsg(jid, message, { messageId })
        return { message, messageId }
    }

    // ─── PAYMENT ──────────────────────────────────────────────────────────────
    async handlePayment(content, jid, quoted) {
        const d = content.requestPaymentMessage
        const ctx = this.buildCtx(quoted, content.sender)
        const notes = d.sticker?.stickerMessage ? { stickerMessage: { ...d.sticker.stickerMessage, contextInfo: ctx } } : d.note ? { extendedTextMessage: { text: d.note, contextInfo: ctx } } : {}
        const targetJid = jid || content.jid
        const msg = await this.genFromContent(targetJid, { requestPaymentMessage: proto.Message.RequestPaymentMessage.fromObject({ expiryTimestamp: d.expiry || 0, amount1000: d.amount || 0, currencyCodeIso4217: d.currency || 'IDR', requestFrom: d.from || '0@s.whatsapp.net', noteMessage: notes, background: d.background ?? { id: 'DEFAULT', placeholderArgb: 0xfff0f0f0 } }) }, { quoted })
        await this.sendMsg(targetJid, msg.message, { messageId: msg.key.id })
        return msg
    }

    // ─── PRODUCT ──────────────────────────────────────────────────────────────
    async handleProduct(content, jid, quoted) {
        const p = content.productMessage || {}
        let prodImg = null
        if (p.thumbnail) { const src = Buffer.isBuffer(p.thumbnail) ? { image: p.thumbnail } : { image: { url: p.thumbnail.url || p.thumbnail } }; const res = await this.utils.generateWAMessageContent(src, { upload: this.upload }); prodImg = res?.imageMessage || res?.message?.imageMessage }
        const product = proto.Message.ProductMessage.ProductSnapshot.create({ productId: p.productId, title: p.title || '', description: p.description || '', currencyCode: p.currencyCode || 'IDR', priceAmount1000: p.priceAmount1000, retailerId: p.retailerId, url: p.url, productImageCount: prodImg ? 1 : 0, ...(prodImg && { productImage: prodImg }) })
        const msg = await this.genFromContent(jid, { viewOnceMessage: { message: { interactiveMessage: proto.Message.InteractiveMessage.create({ body: proto.Message.InteractiveMessage.Body.create({ text: p.body || '' }), footer: proto.Message.InteractiveMessage.Footer.create({ text: p.footer || '' }), header: proto.Message.InteractiveMessage.Header.create({ title: p.title || '', hasMediaAttachment: !!prodImg, productMessage: proto.Message.ProductMessage.create({ product, businessOwnerJid: '0@s.whatsapp.net' }) }), nativeFlowMessage: proto.Message.InteractiveMessage.NativeFlowMessage.create({ buttons: p.buttons || [] }) }) } } }, { quoted })
        await this.sendMsg(jid, msg.message, { messageId: msg.key.id })
        return msg
    }

    // ─── INTERACTIVE ──────────────────────────────────────────────────────────
    async handleInteractive(content, jid, quoted) {
        const i = content.interactiveMessage || content.interactive || {}
        let media = null
        if (i.thumbnail) media = await this.prepMedia({ url: i.thumbnail }, 'image')
        else if (i.image) media = await this.prepMedia(i.image, 'image')
        else if (i.video) media = await this.prepMedia(i.video, 'video')
        else if (i.document) { media = await this.prepMedia(i.document, 'document'); if (i.jpegThumbnail) media.documentMessage.jpegThumbnail = typeof i.jpegThumbnail === 'object' && i.jpegThumbnail.url ? { url: i.jpegThumbnail.url } : i.jpegThumbnail; if (i.fileName) media.documentMessage.fileName = i.fileName; if (i.mimetype) media.documentMessage.mimetype = i.mimetype }
        const bodyText = i.body?.text || i.title || ''
        const footerText = i.footer?.text || (typeof i.footer === 'string' ? i.footer : '') || ''
        const headerTitle = typeof i.header === 'string' ? i.header : i.header?.title || ''
        let nativeFlow = null
        if (i.buttons?.length || i.nativeFlowMessage) { const nfm = i.nativeFlowMessage || {}; nativeFlow = proto.Message.InteractiveMessage.NativeFlowMessage.create({ buttons: i.buttons || nfm.buttons || [], messageParamsJson: nfm.messageParamsJson || '' }) }
        const headerMedia = {}
        if (media?.imageMessage) headerMedia.imageMessage = media.imageMessage
        if (media?.videoMessage) headerMedia.videoMessage = media.videoMessage
        if (media?.documentMessage) headerMedia.documentMessage = media.documentMessage
        const interactive = proto.Message.InteractiveMessage.create({ body: proto.Message.InteractiveMessage.Body.create({ text: bodyText }), footer: proto.Message.InteractiveMessage.Footer.create({ text: footerText }), header: proto.Message.InteractiveMessage.Header.create({ title: headerTitle, hasMediaAttachment: !!media, ...headerMedia }), ...(nativeFlow && { nativeFlowMessage: nativeFlow }) })
        const ctx = this.buildFullCtx(i.contextInfo, i.externalAdReply)
        if (Object.keys(ctx).length) interactive.contextInfo = ctx
        const msg = await this.genFromContent(jid, { interactiveMessage: interactive }, { quoted })
        await this.sendMsg(jid, msg.message, { messageId: msg.key.id })
        return msg
    }

    // ─── ALBUM ────────────────────────────────────────────────────────────────
    async handleAlbum(content, jid, quoted) {
        const arr = Array.isArray(content.albumMessage) ? content.albumMessage : []
        if (!arr.length) throw new Error('albumMessage must contain media items')
        const album = await this.genFromContent(jid, { messageContextInfo: proto.MessageContextInfo.create({ messageSecret: crypto.randomBytes(32) }), albumMessage: proto.Message.AlbumMessage.create({ expectedImageCount: arr.filter(a => a.image).length, expectedVideoCount: arr.filter(a => a.video).length }) }, { userJid: this.genJid(), quoted })
        await this.sendMsg(jid, album.message, { messageId: album.key.id })
        for (const item of arr) {
            const img = await this.genMsg(jid, item, {})
            img.message.messageContextInfo = proto.MessageContextInfo.create({ messageSecret: crypto.randomBytes(32), messageAssociation: proto.MessageAssociation.create({ associationType: 1, parentMessageKey: album.key }), participant: '0@s.whatsapp.net', remoteJid: 'status@broadcast', forwardingScore: 99999, isForwarded: true, mentionedJid: [jid], starred: true, labels: ['Y', 'Important'], isHighlighted: true, businessMessageForwardInfo: proto.ContextInfo.BusinessMessageForwardInfo.create({ businessOwnerJid: jid }), dataSharingContext: proto.ContextInfo.DataSharingContext.create({ showMmDisclosure: true }) })
            img.message.forwardedNewsletterMessageInfo = proto.ContextInfo.ForwardedNewsletterMessageInfo.create({ newsletterJid: '0@newsletter', serverMessageId: 1, newsletterName: 'WhatsApp', contentType: 'UPDATE_CARD', timestamp: new Date().toISOString(), senderName: 'Nexus', priority: 'high', status: 'sent' })
            img.message.disappearingMode = proto.DisappearingMode.create({ initiator: 3, trigger: 4, initiatorDeviceJid: jid, initiatedByExternalService: true, initiatedByUserDevice: true, initiatedBySystem: true, initiatedByServer: true, initiatedByAdmin: true, initiatedByUser: true, initiatedByApp: true, initiatedByBot: true, initiatedByMe: true })
            await this.sendMsg(jid, img.message, { messageId: img.key.id, quoted: { key: { ...album.key, fromMe: true, participant: this.genJid() }, message: album.message } })
        }
        return album
    }

    // ─── EVENT ────────────────────────────────────────────────────────────────
    async handleEvent(content, jid, quoted) {
        const e = content.eventMessage
        const msg = await this.genFromContent(jid, { messageContextInfo: proto.MessageContextInfo.create({ deviceListMetadata: {}, deviceListMetadataVersion: 2, messageSecret: crypto.randomBytes(32), supportPayload: JSON.stringify({ version: 2, is_ai_message: true, should_show_system_message: true, ticket_id: crypto.randomBytes(16).toString('hex') }) }), eventMessage: proto.Message.EventMessage.create({ contextInfo: proto.ContextInfo.create({ mentionedJid: [jid], participant: jid, remoteJid: 'status@broadcast', forwardedNewsletterMessageInfo: proto.ContextInfo.ForwardedNewsletterMessageInfo.create({ newsletterName: 'Nexus Events', newsletterJid: '120363422827915475@newsletter', serverMessageId: 1 }) }), isCanceled: e.isCanceled || false, name: e.name, description: e.description, location: e.location || { degreesLatitude: 0, degreesLongitude: 0, name: 'Location' }, joinLink: e.joinLink || '', startTime: this.parseTime(e.startTime, Date.now()), endTime: this.parseTime(e.endTime, Date.now() + 3600000), extraGuestsAllowed: e.extraGuestsAllowed !== false }) }, { quoted })
        await this.sendMsg(jid, msg.message, { messageId: msg.key.id })
        return msg
    }

    // ─── POLL RESULT ──────────────────────────────────────────────────────────
    async handlePollResult(content, jid, quoted) {
        const p = content.pollResultMessage
        const msg = await this.genFromContent(jid, { pollResultSnapshotMessage: proto.Message.PollResultSnapshotMessage.create({ name: p.name, pollVotes: (p.pollVotes || []).map(v => proto.Message.PollResultSnapshotMessage.PollVote.create({ optionName: v.optionName, optionVoteCount: typeof v.optionVoteCount === 'number' ? v.optionVoteCount.toString() : v.optionVoteCount })), contextInfo: proto.ContextInfo.create({ isForwarded: true, forwardingScore: 1, forwardedNewsletterMessageInfo: proto.ContextInfo.ForwardedNewsletterMessageInfo.create({ newsletterName: p.newsletter?.newsletterName || 'Newsletter', newsletterJid: p.newsletter?.newsletterJid || '120363399602691477@newsletter', serverMessageId: 1000, contentType: 'UPDATE' }) }) }) }, { userJid: this.genJid(), quoted })
        await this.sendMsg(jid, msg.message, { messageId: msg.key.id })
        return msg
    }

    // ─── STATUS MENTION ───────────────────────────────────────────────────────
    async handleStMention(content, jid, quoted) {
        const d = content.statusMentionMessage
        const mediaType = d.image ? 'image' : 'video'
        const media = await this.prepMedia(d.image || d.video, mediaType)
        const statusMsg = await this.relay('status@broadcast', { ...media }, { statusJidList: [d.mentions, this.user?.id].filter(Boolean), additionalNodes: [{ tag: 'meta', attrs: {}, content: [{ tag: 'mentioned_users', attrs: {}, content: [{ tag: 'to', attrs: { jid: d.mentions }, content: undefined }] }] }] })
        const mentionMsg = await this.genFromContent(jid, { statusMentionMessage: proto.Message.StatusMentionMessage.create({ message: { protocolMessage: proto.Message.ProtocolMessage.create({ messageId: statusMsg?.key?.id || d.mentions, type: proto.Message.ProtocolMessage.Type.STATUS_MENTION_MESSAGE }) } }) }, { additionalNodes: [{ tag: 'meta', attrs: { is_status_mention: 'true' }, content: undefined }] })
        await this.sendMsg(jid, mentionMsg.message, { messageId: mentionMsg.key.id })
        return mentionMsg
    }

    // ─── ORDER ────────────────────────────────────────────────────────────────
    async handleOrderMessage(content, jid, quoted) {
        const o = content.orderMessage
        const thumb = await this.downloadBuffer(o.thumbnail)
        const cleanJid = id => { if (!id) return null; const [user] = id.split(':'); return user.includes('@') ? user : `${user}@s.whatsapp.net` }
        const seller = cleanJid(o.sellerJid) || cleanJid(this.user?.id) || cleanJid(jid) || '0@s.whatsapp.net'
        const msg = await this.genFromContent(jid, { orderMessage: proto.Message.OrderMessage.create({ orderId: o.orderId || '7NEXUS25022008', thumbnail: thumb, itemCount: o.itemCount || 0, status: 2, surface: 1, message: o.message, orderTitle: o.orderTitle, sellerJid: seller, token: o.token || 'NEXUS_EXAMPLE_TOKEN', totalAmount1000: o.totalAmount1000 || 0, totalCurrencyCode: o.totalCurrencyCode || 'IDR', messageVersion: 2 }) }, { quoted })
        await this.sendMsg(jid, msg.message, { messageId: msg.key.id })
        return msg
    }

    // ─── GROUP STATUS ─────────────────────────────────────────────────────────
    async handleGroupStory(content, jid, quoted) {
        const s = content.groupStatus
        const mediaContent = await this.utils.generateWAMessageContent(s, { upload: this.upload, getUrlInfo: this.opts.getUrlInfo, logger: this.opts.logger })
        const msg = await this.genFromContent(jid, { groupStatusMessageV2: proto.Message.FutureProofMessage.create({ message: proto.Message.fromObject(mediaContent) }) }, { userJid: jid })
        return await this.sendMsg(jid, msg.message, { messageId: msg.key.id, additionalNodes: [{ tag: 'meta', attrs: { is_group_status: 'true' }, content: undefined }] })
    }

    // ─── CAROUSEL ─────────────────────────────────────────────────────────────
    async handleCarousel(content, jid, quoted) {
        const c = content.carouselMessage || content.carousel || {}
        const cards = await Promise.all((c.cards || []).map(card => this.buildCard(card)))
        const msg = await this.genFromContent(jid, { viewOnceMessage: { message: { interactiveMessage: proto.Message.InteractiveMessage.create({ body: proto.Message.InteractiveMessage.Body.create({ text: c.caption || c.body || '' }), footer: proto.Message.InteractiveMessage.Footer.create({ text: c.footer || '' }), carouselMessage: proto.Message.InteractiveMessage.CarouselMessage.create({ cards, messageVersion: 1 }) }) } } }, { quoted })
        await this.sendMsg(jid, msg.message, { messageId: msg.key.id })
        return msg
    }

    async buildCard(card) {
        const buttons = (card.buttons || []).map(btn => ({ name: btn.name, buttonParamsJson: JSON.stringify(btn.params || {}) }))
        if (card.productTitle) {
            const imgMedia = await this.prepMedia({ url: card.imageUrl }, 'image')
            return { header: proto.Message.InteractiveMessage.Header.create({ title: card.headerTitle || '', subtitle: card.headerSubtitle || '', hasMediaAttachment: false, productMessage: proto.Message.ProductMessage.create({ product: proto.Message.ProductMessage.ProductSnapshot.create({ productImage: imgMedia?.imageMessage, productId: card.productId || '123456', title: card.productTitle, description: card.productDescription || '', currencyCode: card.currencyCode || 'IDR', priceAmount1000: card.priceAmount1000 || '100000', retailerId: card.retailerId || 'Retailer', url: card.url || '', productImageCount: 1 }), businessOwnerJid: card.businessOwnerJid || '0@s.whatsapp.net' }) }), body: proto.Message.InteractiveMessage.Body.create({ text: card.bodyText || '' }), footer: proto.Message.InteractiveMessage.Footer.create({ text: card.footerText || '' }), nativeFlowMessage: proto.Message.InteractiveMessage.NativeFlowMessage.create({ buttons }) }
        }
        const imgMedia = card.imageUrl ? await this.prepMedia({ url: card.imageUrl }, 'image') : {}
        return { header: proto.Message.InteractiveMessage.Header.create({ title: card.headerTitle || '', subtitle: card.headerSubtitle || '', hasMediaAttachment: !!card.imageUrl, ...imgMedia }), body: proto.Message.InteractiveMessage.Body.create({ text: card.bodyText || '' }), footer: proto.Message.InteractiveMessage.Footer.create({ text: card.footerText || '' }), nativeFlowMessage: proto.Message.InteractiveMessage.NativeFlowMessage.create({ buttons }) }
    }

    // ─── CAROUSEL PROTO ───────────────────────────────────────────────────────
    async handleCarouselProto(content, jid, quoted) {
        const c = content.carouselProto
        const cards = await Promise.all((c.cards || []).map(async card => ({ header: proto.Message.InteractiveMessage.Header.create({ title: card.title?.substring(0, 60) || '', subtitle: card.subtitle || '', hasMediaAttachment: false }), body: proto.Message.InteractiveMessage.Body.create({ text: card.bodyText || '' }), footer: proto.Message.InteractiveMessage.Footer.create({ text: card.footerText || '' }), nativeFlowMessage: proto.Message.InteractiveMessage.NativeFlowMessage.create({ buttons: (card.buttons || []).map(btn => ({ name: btn.name, buttonParamsJson: JSON.stringify(btn.params || {}) })) }) })))
        const msg = await this.genFromContent(jid, { viewOnceMessage: { message: { messageContextInfo: proto.MessageContextInfo.create({ deviceListMetadata: {}, deviceListMetadataVersion: 2 }), interactiveMessage: proto.Message.InteractiveMessage.create({ body: proto.Message.InteractiveMessage.Body.create({ text: c.body || '' }), footer: proto.Message.InteractiveMessage.Footer.create({ text: c.footer || '' }), carouselMessage: proto.Message.InteractiveMessage.CarouselMessage.create({ cards, messageVersion: 1 }) }) } } }, { quoted })
        await this.sendMsg(jid, msg.message, { messageId: msg.key.id })
        return msg
    }

    // ─── STICKER PACK ─────────────────────────────────────────────────────────
    async handleStickerPack(content, jid, quoted, opts = {}) {
        const raw = content.stickerPack || content
        const stickers = raw.stickers
            || (Array.isArray(raw) ? raw : null)
            || (typeof raw === 'object' && Object.keys(raw).every(k => !isNaN(k)) ? Object.values(raw) : null)
        const cleanOpts = Object.fromEntries(Object.entries(opts).filter(([, v]) => v !== undefined))
        const stickerPack = stickers
            ? { ...(typeof raw === 'object' && !Array.isArray(raw) ? raw : {}), stickers, ...cleanOpts }
            : { ...raw, ...cleanOpts }
        const result = await this.utils.prepareStickerPackMessage(stickerPack, { logger: this.opts?.logger, upload: this.upload, mediaCache: this.opts?.mediaCache, options: this.opts, mediaUploadTimeoutMs: this.opts?.mediaUploadTimeoutMs })
        if (result.isBatched) {
            const sent = []
            for (let i = 0; i < result.stickerPackMessage.length; i++) { const msg = await this.genFromContent(jid, { stickerPackMessage: result.stickerPackMessage[i] }, { quoted }); await this.sendMsg(jid, msg.message, { messageId: msg.key.id }); sent.push(msg); if (i < result.stickerPackMessage.length - 1) await this.delay(2000) }
            return sent[sent.length - 1]
        }
        const msg = await this.genFromContent(jid, { stickerPackMessage: result.stickerPackMessage }, { quoted })
        await this.sendMsg(jid, msg.message, { messageId: msg.key.id })
        return msg
    }
}

export default NexusHandler