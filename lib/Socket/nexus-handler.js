import { proto } from '../../WAProto/index.js'
import { AIRich, aiRichFromObject, Button, Interactive, Album, Poll, Carousel, Payment, Order, Event, StickerPack } from '../Builders/index.js'
import { generateWAMessageFromContent, generateWAMessage, generateWAMessageContent, prepareWAMessageMedia } from '../Utils/messages.js'
import { makeUsernameSocket } from './username.js'


export const makeMessageBuilderSocket = (config) => {
  const sock = makeUsernameSocket(config)
  const result = { ...sock }

  // builder factory methods
  result.airich = (opts) => new AIRich(result, opts)
  result.button = (opts) => new Button(result, opts)
  result.interactive = () => new Interactive(result)
  result.album = () => new Album(result)
  result.poll = () => new Poll(result)
  result.carousel = () => new Carousel(result)
  result.payment = () => new Payment(result)
  result.order = () => new Order(result)
  result.event = () => new Event(result)
  result.stickerpack = () => new StickerPack(result)

  // wrap sendMessage to intercept our custom content keys
  const _sendMessage = sock.sendMessage.bind(sock)

  result.sendMessage = async (jid, content, options = {}) => {
    if ('aiRich' in content || 'airich' in content || 'richResponse' in content || 'AIRich' in content) {
      const data = content.aiRich ?? content.airich ?? content.richResponse ?? content.AIRich
      return aiRichFromObject(result, jid, data, options)
    }

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

    if ('interactiveMessage' in content && content.interactiveMessage?.__nexus) {
      return new Interactive(result).from(content.interactiveMessage).send(jid, options)
    }

    if ('requestPaymentMessage' in content) {
      return new Payment(result).from(content.requestPaymentMessage).send(jid, options)
    }

    if ('orderMessage' in content) {
      return new Order(result).from(content.orderMessage).send(jid, options)
    }

    if ('eventMessage' in content) {
      return new Event(result).from(content.eventMessage).send(jid, options)
    }

    if ('stickerPack' in content) {
      return new StickerPack(result).from(content.stickerPack).send(jid, options)
    }

    if ('groupStatus' in content) {
      return handleGroupStatus(result, jid, content.groupStatus, options)
    }

    if ('statusMentionMessage' in content) {
      return handleStatusMention(result, jid, content.statusMentionMessage, options)
    }

    if ('pollResultMessage' in content) {
      return handlePollResult(result, jid, content.pollResultMessage, options)
    }

    return _sendMessage(jid, content, options)
  }

  // capture and relay an existing AIRich message
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

  result.relayAiRich = async (jid, captured, opts = {}) => {
    const r = new AIRich(result)
    if (captured.sections?.response_id) r.setResponseId(captured.sections.response_id)
    return r.loadFrom({ botForwardedMessage: { message: { richResponseMessage: { submessages: captured.submessages, unifiedResponse: { data: Buffer.from(JSON.stringify(captured.sections)) }, contextInfo: captured.contextInfo, messageType: captured.messageType } } } }).send(jid, opts)
  }

  // shorthand methods
  result.sendCodeBlock = (jid, code, quoted, opts = {}) =>
    result.sendMessage(jid, { aiRich: { code, language: opts.language ?? 'javascript', title: opts.title } }, quoted ? { quoted } : {})

  result.sendCodeBlockV2 = (jid, code, quoted, opts = {}) =>
    result.sendMessage(jid, { aiRich: { text: opts.text, code, language: opts.language ?? '', title: opts.title } }, quoted ? { quoted } : {})

  result.sendTable = (jid, title, headers, rows, quoted, opts = {}) =>
    result.sendMessage(jid, { aiRich: { title, table: [headers, ...rows] } }, quoted ? { quoted } : {})

  result.sendTableV2 = (jid, tableArray, quoted, opts = {}) =>
    result.sendMessage(jid, { aiRich: { text: opts.text, title: opts.headerText, table: tableArray } }, quoted ? { quoted } : {})

  result.sendList = (jid, title, items, quoted, opts = {}) =>
    result.sendMessage(jid, { aiRich: { title, table: [['Key', 'Value'], ...items] } }, quoted ? { quoted } : {})

  result.sendLink = (jid, text, links, quoted, opts = {}) =>
    result.sendMessage(jid, { aiRich: { title: opts.headerText, text, sources: links.map(url => ({ url, title: url, subtitle: new URL(url).hostname })) } }, quoted ? { quoted } : {})

  result.sendLinkV2 = (jid, text, links, quoted, opts = {}) =>
    result.sendMessage(jid, { aiRich: { title: opts.headerText, text, sources: links } }, quoted ? { quoted } : {})

  result.sendLatex = (jid, expressions, quoted, opts = {}) =>
    result.sendMessage(jid, { aiRich: { text: opts.text, title: opts.headerText, latex: expressions } }, quoted ? { quoted } : {})

  result.sendRichMessage = (jid, data, quoted, opts = {}) =>
    result.sendMessage(jid, { aiRich: data }, quoted ? { quoted, ...opts } : opts)

  result.sendAlbumMessage = (jid, items, quoted, opts = {}) =>
    result.sendMessage(jid, { albumMessage: items }, quoted ? { quoted, ...opts } : opts)

  result.sendGroupStatusMessage = (jid, content, opts = {}) =>
    result.sendMessage(jid, { groupStatus: content }, opts)

  result.sendPoll = (jid, name, values, multiSelect = false, opts = {}) =>
    result.sendMessage(jid, { poll: { name, values, selectableOptionsCount: multiSelect ? 0 : 1 } }, opts)

  result.sendReaction = (jid, key, emoji, opts = {}) =>
    result.sendMessage(jid, { react: { text: emoji, key } }, opts)

  result.sendText = (jid, text, opts = {}) =>
    result.sendMessage(jid, { text }, opts)

  result.sendImage = (jid, image, caption = '', opts = {}) =>
    result.sendMessage(jid, { image, caption }, opts)

  result.sendVideo = (jid, video, caption = '', opts = {}) =>
    result.sendMessage(jid, { video, caption }, opts)

  result.sendDocument = (jid, document, caption = '', opts = {}) =>
    result.sendMessage(jid, { document, caption }, opts)

  result.sendAudio = (jid, audio, opts = {}) =>
    result.sendMessage(jid, { audio, ptt: opts.ptt ?? false, ...opts })

  result.sendSticker = (jid, sticker, opts = {}) =>
    result.sendMessage(jid, { sticker }, opts)

  result.sendLocation = (jid, location, opts = {}) =>
    result.sendMessage(jid, { location }, opts)

  result.sendContact = (jid, contact, opts = {}) =>
    result.sendMessage(jid, { contacts: { displayName: contact.name ?? '', contacts: [contact] } }, opts)

  return result
}

async function handleGroupStatus(sock, jid, content, opts) {
  const userJid = sock.user?.id
  const upload = sock.waUploadToServer
  const logger = sock.logger

  // text-only group status
  if (content.text && !content.image && !content.video && !content.audio) {
    const msg = await generateWAMessageFromContent(jid, {
      groupStatusMessageV2: proto.Message.FutureProofMessage.create({
        message: proto.Message.fromObject({
          extendedTextMessage: { text: content.text },
        }),
      }),
    }, { userJid })
    return sock.relayMessage(jid, msg.message, {
      messageId: msg.key.id,
      additionalNodes: [{ tag: 'meta', attrs: { is_group_status: 'true' }, content: undefined }],
    })
  }

  // media group status — upload media then wrap in FutureProofMessage
  const innerMsg = await generateWAMessage(jid, content, { userJid, upload, logger })
  const msg = await generateWAMessageFromContent(jid, {
    groupStatusMessageV2: proto.Message.FutureProofMessage.create({
      message: proto.Message.fromObject(innerMsg.message),
    }),
  }, { userJid })

  return sock.relayMessage(jid, msg.message, {
    messageId: msg.key.id,
    additionalNodes: [{ tag: 'meta', attrs: { is_group_status: 'true' }, content: undefined }],
  })
}

async function handleStatusMention(sock, jid, d, opts) {
  const userJid = sock.user?.id
  const upload = sock.waUploadToServer
  const mediaType = d.image ? 'image' : 'video'
  const media = await prepareWAMessageMedia({ [mediaType]: d.image ?? d.video }, { upload })

  const statusMsg = await sock.relayMessage('status@broadcast', { ...media }, {
    statusJidList: [d.mentions, userJid].filter(Boolean),
    additionalNodes: [{
      tag: 'meta', attrs: {}, content: [{
        tag: 'mentioned_users', attrs: {}, content: [{ tag: 'to', attrs: { jid: d.mentions }, content: undefined }],
      }],
    }],
  })

  const mentionMsg = await generateWAMessageFromContent(jid, {
    statusMentionMessage: proto.Message.StatusMentionMessage.create({
      message: {
        protocolMessage: proto.Message.ProtocolMessage.create({
          messageId: statusMsg?.key?.id ?? d.mentions,
          type: proto.Message.ProtocolMessage.Type.STATUS_MENTION_MESSAGE,
        }),
      },
    }),
  }, { userJid })

  return sock.relayMessage(jid, mentionMsg.message, {
    messageId: mentionMsg.key.id,
    additionalNodes: [{ tag: 'meta', attrs: { is_status_mention: 'true' }, content: undefined }],
  })
}

async function handlePollResult(sock, jid, p, opts) {
  const userJid = sock.user?.id
  const msg = await generateWAMessageFromContent(jid, {
    pollResultSnapshotMessage: proto.Message.PollResultSnapshotMessage.create({
      name: p.name,
      pollVotes: (p.pollVotes ?? []).map(v => proto.Message.PollResultSnapshotMessage.PollVote.create({
        optionName: v.optionName,
        optionVoteCount: String(v.optionVoteCount ?? 0),
      })),
      contextInfo: proto.ContextInfo.create({
        isForwarded: true, forwardingScore: 1,
        forwardedNewsletterMessageInfo: proto.ContextInfo.ForwardedNewsletterMessageInfo.create({
          newsletterName: p.newsletter?.newsletterName ?? 'Newsletter',
          newsletterJid: p.newsletter?.newsletterJid ?? '120363399602691477@newsletter',
          serverMessageId: 1000,
          contentType: 'UPDATE',
        }),
      }),
    }),
  }, { userJid })

  await sock.relayMessage(jid, msg.message, { messageId: msg.key.id })
  return msg
}
