/**
 * @nexus/baileys - Advanced Message Handler
 * Handles: PAYMENT, PRODUCT, INTERACTIVE, ALBUM, EVENT, POLL_RESULT,
 * STATUS_MENTION, ORDER, GROUP_STATUS, CAROUSEL, CAROUSEL_PROTO, STICKER_PACK
 */

import axios from 'axios'
import crypto from 'crypto'

class NexusHandler {
    constructor(utils, waUploadToServer, relayMessageFn, options = {}) {
        this.utils = utils
        this.relay = relayMessageFn
        this.upload = waUploadToServer
        this.opts = options
        this.user = options.user || null

        // Auto-routing map for message types
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
            CAROUSEL_PROTO: this.handleCarouselProto.bind(this)
        }
    }

    // ========== TYPE DETECTION ==========
    detectType(content) {
        const types = {
            requestPaymentMessage: 'PAYMENT',
            productMessage: 'PRODUCT',
            interactiveMessage: 'INTERACTIVE',
            interactive: 'INTERACTIVE',  // Also detect 'interactive' key
            albumMessage: 'ALBUM',
            eventMessage: 'EVENT',
            pollResultMessage: 'POLL_RESULT',
            statusMentionMessage: 'STATUS_MENTION',
            orderMessage: 'ORDER',
            stickerPack: 'STICKER_PACK',
            groupStatus: 'GROUP_STATUS',
            carouselProto: 'CAROUSEL_PROTO'
        }

        if (content.carouselMessage || content.carousel) return 'CAROUSEL'
        return types[Object.keys(types).find(k => content[k])] || null
    }

    // ========== UNIFIED PROCESSOR ==========
    async processMessage(content, jid, quoted) {
        const messageType = this.detectType(content)
        if (!messageType) throw new Error('Unknown message type')

        const handler = this.handlers[messageType]
        if (!handler) throw new Error(`No handler for: ${messageType}`)

        return messageType === 'STICKER_PACK'
            ? await handler(content.stickerPack, jid, quoted)
            : await handler(content, jid, quoted)
    }

    // ========== HELPERS ==========
    async prepMedia(data, type) {
        if (!data) return null
        const payload = typeof data === 'object' && data.url ? { [type]: { url: data.url } } : { [type]: data }
        return await this.utils.prepareWAMessageMedia(payload, { upload: this.upload })
    }

    async genContent(jid, content, opts = {}) {
        return await this.utils.generateWAMessage(jid, content, { ...opts, upload: this.upload })
    }

    async sendMsg(jid, message, opts = {}) {
        await this.relay(jid, message, opts)
    }

    buildCtx(quoted, sender) {
        return {
            stanzaId: quoted?.key?.id,
            participant: quoted?.key?.participant || sender,
            quotedMessage: quoted?.message
        }
    }

    buildFullCtx(ctx, adReply) {
        const final = ctx ? { mentionedJid: ctx.mentionedJid || [], forwardingScore: ctx.forwardingScore || 0, isForwarded: ctx.isForwarded || false, ...ctx } : {}
        if (adReply) {
            final.externalAdReply = {
                title: adReply.title || '', body: adReply.body || '', mediaType: adReply.mediaType || 1,
                thumbnailUrl: adReply.thumbnailUrl || '', mediaUrl: adReply.mediaUrl || '', sourceUrl: adReply.sourceUrl || '',
                showAdAttribution: adReply.showAdAttribution || false, renderLargerThumbnail: adReply.renderLargerThumbnail || false, ...adReply
            }
        }
        return final
    }

    genJid() {
        return this.utils.generateMessageID().split('@')[0] + '@s.whatsapp.net'
    }

    parseTime(val, def) {
        return typeof val === 'string' ? parseInt(val) : val || def
    }

    delay(ms) {
        return new Promise(resolve => setTimeout(resolve, ms))
    }

    // ========== MESSAGE HANDLERS ==========

    async handlePayment(content, quoted) {
        const d = content.requestPaymentMessage
        const notes = d.sticker?.stickerMessage ? {
            stickerMessage: { ...d.sticker.stickerMessage, contextInfo: this.buildCtx(quoted, content.sender) }
        } : d.note ? {
            extendedTextMessage: { text: d.note, contextInfo: this.buildCtx(quoted, content.sender) }
        } : {}

        const msg = await this.genContent(content.jid, {
            requestPaymentMessage: this.utils.WAProto.proto.Message.RequestPaymentMessage.fromObject({
                expiryTimestamp: d.expiry || 0, amount1000: d.amount || 0, currencyCodeIso4217: d.currency || 'IDR',
                requestFrom: d.from || '0@s.whatsapp.net', noteMessage: notes, background: d.background ?? { id: 'DEFAULT', placeholderArgb: 0xfff0f0f0 }
            })
        }, { quoted })

        await this.sendMsg(content.jid, msg.message, { messageId: msg.key.id })
        return msg
    }

    async handleProduct(content, jid, quoted) {
        const p = content.productMessage || {}
        let prodImg = null

        if (p.thumbnail) {
            const imgContent = Buffer.isBuffer(p.thumbnail) ? { image: p.thumbnail } : { image: { url: p.thumbnail.url || p.thumbnail } }
            const res = await this.utils.generateWAMessageContent(imgContent, { upload: this.upload })
            prodImg = res?.imageMessage || res?.message?.imageMessage
        }

        const product = {
            productId: p.productId, title: p.title || '', description: p.description || '', currencyCode: p.currencyCode || 'IDR',
            priceAmount1000: p.priceAmount1000, retailerId: p.retailerId, url: p.url, productImageCount: prodImg ? 1 : 0,
            ...(prodImg && { productImage: prodImg })
        }

        const msg = await this.genContent(jid, {
            viewOnceMessage: {
                message: {
                    interactiveMessage: {
                        body: { text: p.body || '' }, footer: { text: p.footer || '' },
                        header: { title: p.title, hasMediaAttachment: !!prodImg, productMessage: { product, businessOwnerJid: '0@s.whatsapp.net' } },
                        nativeFlowMessage: { buttons: p.buttons || [] }
                    }
                }
            }
        }, { quoted })

        await this.sendMsg(jid, msg.message, { messageId: msg.key.id })
        return msg
    }

    async handleInteractive(content, jid, quoted) {
        // Handle both 'interactiveMessage' and 'interactive' keys
        const i = content.interactiveMessage || content.interactive || {}
        let media = null

        if (i.thumbnail) media = await this.prepMedia({ url: i.thumbnail }, 'image')
        else if (i.image) media = await this.prepMedia(i.image, 'image')
        else if (i.video) media = await this.prepMedia(i.video, 'video')
        else if (i.document) {
            media = await this.prepMedia(i.document, 'document')
            if (i.jpegThumbnail) media.documentMessage.jpegThumbnail = typeof i.jpegThumbnail === 'object' && i.jpegThumbnail.url ? { url: i.jpegThumbnail.url } : i.jpegThumbnail
            if (i.fileName) media.documentMessage.fileName = i.fileName
            if (i.mimetype) media.documentMessage.mimetype = i.mimetype
        }

        // Handle both formats: { title, footer } and { body: {text}, footer: {text} }
        const bodyText = i.body?.text || i.title || ''
        const footerText = i.footer?.text || i.footer || ''
        const interactive = { body: { text: bodyText }, footer: { text: footerText } }

        if (i.buttons?.length || i.nativeFlowMessage) {
            // Build nativeFlowMessage with proper structure
            const nativeFlow = i.nativeFlowMessage || {}
            interactive.nativeFlowMessage = {
                buttons: i.buttons || nativeFlow.buttons || [],
                messageParamsJson: nativeFlow.messageParamsJson || ''
            }
        }

        if (media) {
            const headerMedia = {}
            if (media.imageMessage) headerMedia.imageMessage = media.imageMessage
            if (media.videoMessage) headerMedia.videoMessage = media.videoMessage
            if (media.documentMessage) headerMedia.documentMessage = media.documentMessage
            // Handle both plain title string and full header object
            const headerTitle = typeof i.header === 'string' ? i.header : i.header?.title || ''
            interactive.header = { title: headerTitle, hasMediaAttachment: true, ...headerMedia }
        } else {
            // Handle both plain title string and full header object
            const headerTitle = typeof i.header === 'string' ? i.header : i.header?.title || ''
            interactive.header = { title: headerTitle, hasMediaAttachment: false }
        }

        const ctx = this.buildFullCtx(i.contextInfo, i.externalAdReply)
        if (Object.keys(ctx).length) interactive.contextInfo = ctx

        // Return interactiveMessage directly without wrapping for native flows
        // This matches fadzzz404's approach which works correctly
        const messageContent = { interactiveMessage: interactive }

        const msg = await this.genContent(jid, messageContent, { quoted })
        await this.sendMsg(jid, msg.message, { messageId: msg.key.id })
        return msg
    }

    async handleAlbum(content, jid, quoted) {
        const arr = Array.isArray(content.albumMessage) ? content.albumMessage : []
        if (!arr.length) throw new Error('albumMessage must contain media items')

        const album = await this.genContent(jid, {
            messageContextInfo: { messageSecret: crypto.randomBytes(32) },
            albumMessage: { expectedImageCount: arr.filter(a => a.image).length, expectedVideoCount: arr.filter(a => a.video).length }
        }, { userJid: this.genJid(), quoted })

        await this.sendMsg(jid, album.message, { messageId: album.key.id })

        for (const item of arr) {
            const img = await this.utils.generateWAMessage(jid, item, { upload: this.upload })

            img.message.messageContextInfo = {
                messageSecret: crypto.randomBytes(32), messageAssociation: { associationType: 1, parentMessageKey: album.key },
                participant: '0@s.whatsapp.net', remoteJid: 'status@broadcast', forwardingScore: 99999, isForwarded: true,
                mentionedJid: [jid], starred: true, labels: ['Y', 'Important'], isHighlighted: true,
                businessMessageForwardInfo: { businessOwnerJid: jid }, dataSharingContext: { showMmDisclosure: true }
            }

            img.message.forwardedNewsletterMessageInfo = {
                newsletterJid: '0@newsletter', serverMessageId: 1, newsletterName: 'WhatsApp', contentType: 'UPDATE_CARD',
                timestamp: new Date().toISOString(), senderName: 'Nexus', priority: 'high', status: 'sent'
            }

            img.message.disappearingMode = {
                initiator: 3, trigger: 4, initiatorDeviceJid: jid, initiatedByExternalService: true, initiatedByUserDevice: true,
                initiatedBySystem: true, initiatedByServer: true, initiatedByAdmin: true, initiatedByUser: true, initiatedByApp: true,
                initiatedByBot: true, initiatedByMe: true
            }

            await this.sendMsg(jid, img.message, {
                messageId: img.key.id,
                quoted: { key: { ...album.key, fromMe: true, participant: this.genJid() }, message: album.message }
            })
        }

        return album
    }

    async handleEvent(content, jid, quoted) {
        const e = content.eventMessage

        const msg = await this.genContent(jid, {
            viewOnceMessage: {
                message: {
                    messageContextInfo: {
                        deviceListMetadata: {}, deviceListMetadataVersion: 2, messageSecret: crypto.randomBytes(32),
                        supportPayload: JSON.stringify({ version: 2, is_ai_message: true, should_show_system_message: true, ticket_id: crypto.randomBytes(16).toString('hex') })
                    },
                    eventMessage: {
                        contextInfo: {
                            mentionedJid: [jid], participant: jid, remoteJid: 'status@broadcast',
                            forwardedNewsletterMessageInfo: { newsletterName: 'Nexus Events', newsletterJid: '120363422827915475@newsletter', serverMessageId: 1 }
                        },
                        isCanceled: e.isCanceled || false, name: e.name, description: e.description,
                        location: e.location || { degreesLatitude: 0, degreesLongitude: 0, name: 'Location' }, joinLink: e.joinLink || '',
                        startTime: this.parseTime(e.startTime, Date.now()), endTime: this.parseTime(e.endTime, Date.now() + 3600000),
                        extraGuestsAllowed: e.extraGuestsAllowed !== false
                    }
                }
            }
        }, { quoted })

        await this.sendMsg(jid, msg.message, { messageId: msg.key.id })
        return msg
    }

    async handlePollResult(content, jid, quoted) {
        const p = content.pollResultMessage

        const msg = await this.genContent(jid, {
            pollResultSnapshotMessage: {
                name: p.name,
                pollVotes: (p.pollVotes || []).map(v => ({
                    optionName: v.optionName,
                    optionVoteCount: typeof v.optionVoteCount === 'number' ? v.optionVoteCount.toString() : v.optionVoteCount
                })),
                contextInfo: {
                    isForwarded: true, forwardingScore: 1,
                    forwardedNewsletterMessageInfo: {
                        newsletterName: p.newsletter?.newsletterName || 'Newsletter',
                        newsletterJid: p.newsletter?.newsletterJid || '120363399602691477@newsletter',
                        serverMessageId: 1000, contentType: 'UPDATE'
                    }
                }
            }
        }, { userJid: this.genJid(), quoted })

        await this.sendMsg(jid, msg.message, { messageId: msg.key.id })
        return msg
    }

    async handleStMention(content, jid, quoted) {
        const d = content.statusMentionMessage
        const media = await this.prepMedia(d.image || d.video, d.image ? 'image' : 'video')

        const msg = await this.relay('status@broadcast', { ...media }, {
            statusJidList: [d.mentions, this.user?.id],
            additionalNodes: [{
                tag: 'meta', attrs: {},
                content: [{ tag: 'mentioned_users', attrs: {}, content: [{ tag: 'to', attrs: { jid: d.mentions }, content: undefined }] }]
            }]
        })

        const xontols = await this.genContent(jid, {
            statusMentionMessage: { message: { protocolMessage: { messageId: msg.key, type: 'STATUS_MENTION_MESSAGE' } } }
        }, { additionalNodes: [{ tag: 'meta', attrs: { is_status_mention: true }, content: undefined }] })

        await this.sendMsg(jid, xontols.message, { messageId: xontols.key.id })
        return xontols
    }

    async handleOrderMessage(content, jid, quoted) {
        const o = content.orderMessage
        let thumb = null

        if (o.thumbnail) {
            if (Buffer.isBuffer(o.thumbnail)) {
                thumb = o.thumbnail
            } else if (typeof o.thumbnail === 'string') {
                try {
                    const res = await axios.get(o.thumbnail, { responseType: 'arraybuffer' })
                    thumb = Buffer.from(res.data)
                } catch (err) {
                    console.error('Failed to download thumbnail:', err)
                }
            }
        }

        const msg = await this.genContent(jid, {
            orderMessage: {
                orderId: '7NEXUS25022008', thumbnail: thumb, itemCount: o.itemCount || 0, status: 'ACCEPTED', surface: 'CATALOG',
                message: o.message, orderTitle: o.orderTitle, sellerJid: '0@whatsapp.net', token: 'NEXUS_EXAMPLE_TOKEN',
                totalAmount1000: o.totalAmount1000 || 0, totalCurrencyCode: o.totalCurrencyCode || 'IDR', messageVersion: 2
            }
        }, { quoted })

        await this.sendMsg(jid, msg.message, { messageId: msg.key.id })
        return msg
    }

    async handleGroupStory(content, jid, quoted) {
        const storyData = content.groupStatus
        const mediaContent = await this.utils.generateWAMessageContent(storyData, { upload: this.upload })
        const msg = await this.utils.generateWAMessageFromContent(jid, {
            groupStatusMessageV2: { message: mediaContent }
        }, { userJid: jid })
        return await this.relay(jid, msg.message, {
            messageId: msg.key.id,
            additionalNodes: [{ tag: 'meta', attrs: { is_group_status: 'true' }, content: undefined }]
        })
    }

    async handleCarousel(content, jid, quoted) {
        const c = content.carouselMessage || content.carousel || {}
        const cards = await Promise.all((c.cards || []).map(card => this.buildCard(card)))

        const msg = await this.genContent(jid, {
            viewOnceMessage: {
                message: {
                    interactiveMessage: {
                        body: { text: c.caption || c.body || '' }, footer: { text: c.footer || '' },
                        carouselMessage: { cards, messageVersion: 1 }
                    }
                }
            }
        }, { quoted })

        await this.sendMsg(jid, msg.message, { messageId: msg.key.id })
        return msg
    }

    async buildCard(card) {
        if (card.productTitle) {
            return {
                header: {
                    title: card.headerTitle || '', subtitle: card.headerSubtitle || '',
                    productMessage: {
                        product: {
                            productImage: (await this.prepMedia({ url: card.imageUrl }, 'image')).imageMessage,
                            productId: card.productId || '123456', title: card.productTitle, description: card.productDescription || '',
                            currencyCode: card.currencyCode || 'IDR', priceAmount1000: card.priceAmount1000 || '100000',
                            retailerId: card.retailerId || 'Retailer', url: card.url || '', productImageCount: 1
                        },
                        businessOwnerJid: card.businessOwnerJid || '0@s.whatsapp.net'
                    },
                    hasMediaAttachment: false
                },
                body: { text: card.bodyText || '' }, footer: { text: card.footerText || '' },
                nativeFlowMessage: { buttons: (card.buttons || []).map(btn => ({ name: btn.name, buttonParamsJson: JSON.stringify(btn.params || {}) })) }
            }
        }

        const imgMedia = card.imageUrl ? await this.prepMedia({ url: card.imageUrl }, 'image') : {}
        return {
            header: { title: card.headerTitle || '', subtitle: card.headerSubtitle || '', hasMediaAttachment: !!card.imageUrl, ...imgMedia },
            body: { text: card.bodyText || '' }, footer: { text: card.footerText || '' },
            nativeFlowMessage: { buttons: (card.buttons || []).map(btn => ({ name: btn.name, buttonParamsJson: JSON.stringify(btn.params || {}) })) }
        }
    }

    async handleCarouselProto(content, jid, quoted) {
        const c = content.carouselProto
        const proto = this.utils.WAProto?.proto
        if (!proto) throw new Error('WAProto not available')

        const cards = await Promise.all((c.cards || []).map(async card => ({
            header: proto.Message.InteractiveMessage.Header.create({ title: card.title?.substring(0, 60) || '', subtitle: card.subtitle || '', hasMediaAttachment: false }),
            body: proto.Message.InteractiveMessage.Body.create({ text: card.bodyText || '' }),
            footer: proto.Message.InteractiveMessage.Footer.create({ text: card.footerText || '' }),
            nativeFlowMessage: proto.Message.InteractiveMessage.NativeFlowMessage.create({
                buttons: (card.buttons || []).map(btn => ({ name: btn.name, buttonParamsJson: JSON.stringify(btn.params || {}) }))
            })
        })))

        const msg = await this.genContent(jid, {
            viewOnceMessage: {
                message: {
                    messageContextInfo: { deviceListMetadata: {}, deviceListMetadataVersion: 2 },
                    interactiveMessage: proto.Message.InteractiveMessage.create({
                        body: proto.Message.InteractiveMessage.Body.create({ text: c.body || '' }),
                        footer: proto.Message.InteractiveMessage.Footer.create({ text: c.footer || '' }),
                        carouselMessage: proto.Message.InteractiveMessage.CarouselMessage.create({ cards })
                    })
                }
            }
        }, { quoted })

        await this.sendMsg(jid, msg.message, { messageId: msg.key.id })
        return msg
    }

    async handleStickerPack(stickerPack, jid, quoted) {
        const result = await this.utils.prepareStickerPackMessage(stickerPack, {
            logger: this.opts?.logger, upload: this.upload, mediaCache: this.opts?.mediaCache,
            options: this.opts, mediaUploadTimeoutMs: this.opts?.mediaUploadTimeoutMs
        })

        if (result.isBatched) {
            const sent = []
            for (let i = 0; i < result.stickerPackMessage.length; i++) {
                const msg = await this.genContent(jid, { stickerPackMessage: result.stickerPackMessage[i] }, { quoted })
                await this.sendMsg(jid, msg.message, { messageId: msg.key.id })
                sent.push(msg)
                if (i < result.stickerPackMessage.length - 1) await this.delay(2000)
            }
            return sent[sent.length - 1]
        }

        const msg = await this.genContent(jid, { stickerPackMessage: result.stickerPackMessage }, { quoted })
        await this.sendMsg(jid, msg.message, { messageId: msg.key.id })
        return msg
    }
}

export default NexusHandler