import { webcrypto as crypto } from 'crypto'
import { proto } from '../../WAProto/index.js'
import { AIRich, aiRichFromObject, Button, Interactive, Album, Poll, Carousel, Payment, Order, Event, StickerPack, handleGroupStatus, handleStatusMention, handlePollResult } from '../Builders/index.js'
import { getUrlInfo } from '../Utils/index.js'
import { makeUsernameSocket } from './username.js'



export const makeMessageBuilderSocket = (config) => {
  const sock = makeUsernameSocket(config)
  const _send = sock.sendMessage.bind(sock)
  const result = {
    ...sock,
    airich: (opts) => new AIRich(result, opts),
    button: (opts) => new Button(result, opts),
    interactive: () => new Interactive(result),
    album: () => new Album(result),
    poll: () => new Poll(result),
    carousel: () => new Carousel(result),
    payment: () => new Payment(result),
    order: () => new Order(result),
    event: () => new Event(result),
    stickerpack: () => new StickerPack(result),
  }

  result.sendMessage = async (jid, content, options = {}) => {
    const aiData = content.aiRich ?? content.airich ?? content.richResponse ?? content.AIRich
    if (aiData) return aiRichFromObject(result, jid, aiData, options)

    if ('albumMessage' in content) {
      const album = new Album(result)
      album.add(Array.isArray(content.albumMessage) ? content.albumMessage : [content.albumMessage])
      if (content.albumDelay) album.setDelay(content.albumDelay)
      return album.send(jid, options)
    }

    if ('carouselMessage' in content) {
      const { caption, footer, cards } = content.carouselMessage
      const c = new Carousel(result)
      if (caption) c.setCaption(caption)
      if (footer) c.setFooter(footer)
        ; (cards ?? []).forEach(card => c.card(card))
      return c.send(jid, options)
    }

    if ('interactiveMessage' in content) return new Interactive(result).from(content.interactiveMessage).send(jid, options)
    if ('requestPaymentMessage' in content) return new Payment(result).from(content.requestPaymentMessage).send(jid, options)
    if ('orderMessage' in content) return new Order(result).from(content.orderMessage).send(jid, options)
    if ('eventMessage' in content) return new Event(result).from(content.eventMessage).send(jid, options)
    if ('stickerPack' in content) return new StickerPack(result).from(content.stickerPack).send(jid, options)
    if ('stickerPackMessage' in content) return new StickerPack(result).from(content.stickerPackMessage).send(jid, options)
    if ('groupStatus' in content) return handleGroupStatus(result, jid, content.groupStatus, config)
    if ('statusMentionMessage' in content) return handleStatusMention(result, jid, content.statusMentionMessage, config)
    if ('pollResultMessage' in content) return handlePollResult(result, jid, content.pollResultMessage)

    return _send(jid, content, options)
  }

  result.captureAiRich = (msg) => {
    const rich = msg?.botForwardedMessage?.message?.richResponseMessage ?? msg?.richResponseMessage
    if (!rich?.unifiedResponse?.data) return null
    return {
      submessages: rich.submessages ?? [],
      sections: JSON.parse(Buffer.from(rich.unifiedResponse.data, 'base64').toString()),
      contextInfo: rich.contextInfo ?? {},
      messageType: rich.messageType ?? 1,
    }
  }

  result.relayAiRich = (jid, captured, opts = {}) => {
    const r = new AIRich(result)
    if (captured.sections?.response_id) r.setResponseId(captured.sections.response_id)
    return r.loadFrom({
      botForwardedMessage: {
        message: {
          richResponseMessage: {
            submessages: captured.submessages,
            unifiedResponse: { data: Buffer.from(JSON.stringify(captured.sections)) },
            contextInfo: captured.contextInfo,
            messageType: captured.messageType,
          },
        },
      },
    }).send(jid, opts)
  }

  const q = (quoted) => quoted ? { quoted } : {}

  result.sendRichMessage = (jid, data, quoted, opts = {}) => result.sendMessage(jid, { aiRich: data }, { ...q(quoted), ...opts })
  result.sendCodeBlock = (jid, code, quoted, opts = {}) => result.sendMessage(jid, { aiRich: { code, language: opts.language ?? 'javascript', title: opts.title } }, q(quoted))
  result.sendCodeBlockV2 = (jid, code, quoted, opts = {}) => result.sendMessage(jid, { aiRich: { text: opts.text, code, language: opts.language ?? '', title: opts.title } }, q(quoted))
  result.sendTable = (jid, title, headers, rows, quoted, opts = {}) => result.sendMessage(jid, { aiRich: { title, table: [headers, ...rows] } }, q(quoted))
  result.sendTableV2 = (jid, tableArray, quoted, opts = {}) => result.sendMessage(jid, { aiRich: { text: opts.text, title: opts.headerText, table: tableArray } }, q(quoted))
  result.sendList = (jid, title, items, quoted, opts = {}) => result.sendMessage(jid, { aiRich: { title, table: [['Key', 'Value'], ...items] } }, q(quoted))
  result.sendLink = (jid, text, links, quoted, opts = {}) => result.sendMessage(jid, { aiRich: { title: opts.headerText, text, sources: links.map(url => ({ url, title: url, subtitle: new URL(url).hostname })) } }, q(quoted))
  result.sendLinkV2 = (jid, text, links, quoted, opts = {}) => result.sendMessage(jid, { aiRich: { title: opts.headerText, text, sources: links } }, q(quoted))
  result.sendLatex = (jid, expressions, quoted, opts = {}) => result.sendMessage(jid, { aiRich: { text: opts.text, title: opts.headerText, latex: expressions } }, q(quoted))
  // Old-style shortcut methods — wired to builders, no new logic
  result.sendInteractiveMessage = (jid, data, quoted) => new Interactive(result).from(data).send(jid, q(quoted))
  result.sendCarouselMessage = (jid, data, quoted) => new Carousel(result).from(data).send(jid, q(quoted))
  result.sendCarouselProtoMessage = (jid, data, quoted) => new Carousel(result).from(data).send(jid, q(quoted))
  result.sendPaymentMessage = (jid, data, quoted) => new Payment(result).from(data).send(jid, q(quoted))
  result.sendProductMessage = (jid, data, quoted) => new Interactive(result).from({ ...data, __product: true }).send(jid, q(quoted))
  result.sendEventMessage = (jid, data, quoted) => new Event(result).from(data).send(jid, q(quoted))
  result.sendOrderMessage = (jid, data, quoted) => new Order(result).from(data).send(jid, q(quoted))
  result.sendPollResultMessage = (jid, data, quoted) => handlePollResult(result, jid, data)
  result.sendStatusMentionMessage = (jid, data, quoted) => handleStatusMention(result, jid, data, config)
  result.stickerPackMessage = (jid, data, opts = {}) => new StickerPack(result).from({ ...data, name: opts.packName ?? data?.name, publisher: opts.packPublisher ?? data?.publisher }).send(jid, q(opts.quoted))

  result.sendAlbumMessage = (jid, items, quoted, opts = {}) => result.sendMessage(jid, { albumMessage: items }, { ...q(quoted), ...opts })
  result.sendGroupStatusMessage = (jid, content, opts = {}) => result.sendMessage(jid, { groupStatus: content }, opts)
  result.sendPoll = (jid, name, values, multiSelect = false, opts = {}) => result.sendMessage(jid, { poll: { name, values, selectableOptionsCount: multiSelect ? 0 : 1 } }, opts)
  result.sendReaction = (jid, key, emoji, opts = {}) => result.sendMessage(jid, { react: { text: emoji, key } }, opts)
  result.sendText = (jid, text, opts = {}) => result.sendMessage(jid, { text }, opts)
  result.sendImage = (jid, image, caption = '', opts = {}) => result.sendMessage(jid, { image, caption }, opts)
  result.sendVideo = (jid, video, caption = '', opts = {}) => result.sendMessage(jid, { video, caption }, opts)
  result.sendDocument = (jid, document, caption = '', opts = {}) => result.sendMessage(jid, { document, caption }, opts)
  result.sendAudio = (jid, audio, opts = {}) => result.sendMessage(jid, { audio, ptt: opts.ptt ?? false, ...opts })
  result.sendSticker = (jid, sticker, opts = {}) => result.sendMessage(jid, { sticker }, opts)
  result.sendLocation = (jid, location, opts = {}) => result.sendMessage(jid, { location }, opts)
  result.sendContact = (jid, contact, opts = {}) => result.sendMessage(jid, { contacts: { displayName: contact.name ?? '', contacts: [contact] } }, opts)

  // Proxy: fuzzy-match unknown property access against known method names
  const normalize = s => s.toLowerCase().replace(/[^a-z]/g, '')
  const knownKeys = Object.keys(result).filter(k => typeof result[k] === 'function')
  const normalizedMap = new Map(knownKeys.map(k => [normalize(k), k]))

  return new Proxy(result, {
    get(target, prop, receiver) {
      if (prop in target) return Reflect.get(target, prop, receiver)
      if (typeof prop !== 'string') return undefined
      const match = normalizedMap.get(normalize(prop))
      if (match) {
        target.logger?.warn(`[NexusHandler] Unknown method "${prop}" — did you mean "${match}"? Calling it for you.`)
        return target[match]
      }
      return undefined
    }
  })
}