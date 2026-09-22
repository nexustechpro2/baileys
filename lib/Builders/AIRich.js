import crypto from 'crypto'
import {
  generateMessageIDV2,
  generateVerificationMetadata,
  waitAllPromises,
  extractIE,
  tokenizeCode,
  generateWAMessageFromContent,
} from '../Utils/index.js'

const DEFAULT_BOT_JID = '867051314767696@bot'
const BIZ_BOT_SUPPORT = '{"version":1,"is_ai_message":true,"should_upload_client_logs":false,"should_show_system_message":false,"ticket_id":"7004947587700716","citation_items":[],"ticket_locale":"us"}'

const mkSection = vm => ({ __typename: 'GenAIUnifiedResponseSection', view_model: vm })
const single = p => mkSection({ __typename: 'GenAISingleLayoutViewModel', primitive: p })
const vstack = ps => mkSection({ __typename: 'GenAIVStackLayoutViewModel', primitives: ps })
const hscroll = ps => mkSection({ __typename: 'GenAIHScrollLayoutViewModel', primitives: ps })
const actionRow = ps => ({ view_model: { __typename: 'GenAIActionRowLayoutViewModel', primitives: ps } })

const mkMarkdown = (text, entities = []) => {
  const { text: t, inline_entities } = extractIE(text, entities)
  return { __typename: 'GenAIMarkdownTextUXPrimitive', text: t, inline_entities }
}

const mkCode = (content, language = '', unified_codeBlock = []) => ({
  __typename: 'GenAICodeUXPrimitive',
  language,
  code_blocks: unified_codeBlock.length ? unified_codeBlock : [{ content }],
})

const mkTable = rows => ({ __typename: 'GenATableUXPrimitive', rows })

const mkImage = (url, mime = 'image/jpeg') => ({
  __typename: 'GenAIImagePrimitive',
  preview_image: { __typename: 'GenAIMediaItem', mime_type: mime, url },
  full_image: { __typename: 'GenAIMediaItem', mime_type: mime, url },
})

const mkVideo = url => ({
  __typename: 'GenAIVideoPrimitive',
  media: { __typename: 'GenAIMediaItem', mime_type: 'video/mp4', url },
})

const mkReel = ({ creator, avatar_url, thumbnail_url, reels_url }) => ({
  __typename: 'GenAIReelPrimitive', creator, avatar_url, thumbnail_url, reels_url,
})

const mkPost = d => ({
  __typename: 'GenAIPostPrimitive',
  title: d.title, username: d.username, subtitle: d.subtitle ?? '',
  thumbnail_url: d.thumbnail_url, post_url: d.post_url,
  post_caption: d.post_caption ?? '', post_type: d.post_type ?? 'photo',
  source_app: d.source_app ?? 'instagram', likes_count: d.likes_count ?? 0,
  comments_count: d.comments_count ?? 0, shares_count: d.shares_count ?? 0,
  is_verified: d.is_verified ?? false, is_carousel: false, orientation: 'portrait',
  profile_picture_url: d.profile_picture_url ?? null,
  footer_label: null, footer_icon: null, additional_images: [],
})

const mkProduct = d => ({
  __typename: 'GenAIProductItemCardPrimitive',
  title: d.title, brand: d.brand, price: d.price,
  sale_price: d.sale_price ?? null, product_url: d.product_url,
  image: { url: d.image_url }, additional_images: [],
})

const mkSearchResult = d => ({
  __typename: 'GenAISearchResultPrimitive',
  source_url: d.url ?? d.source_url,
  source_display_name: d.title ?? d.source_display_name,
  source_type: d.source_type ?? 'web',
  source_subtitle: d.subtitle ?? d.source_subtitle ?? '',
  favicon: d.favicon ?? null,
})

const mkMap = ({ latitude, longitude, name = '', address = '' }) => ({
  __typename: 'GenAIMapPrimitive', latitude, longitude, name, address,
})

const mkWidget = (ctas, title = '') => ({
  __typename: 'GenAI3PExtWidgetPrimitive',
  header: { __typename: 'GenAI3PExtWidgetStandardHeader', title },
  body: {
    __typename: 'GenAI3PExtCalendarEventList',
    ctas: ctas.map(c => ({
      __typename: 'GenAI3PExtWidgetCTA',
      label: c.label, state: 'PENDING',
      kind: c.kind ?? 'OTHER',
      tool_call_id: c.tool_call_id ?? c.id ?? c.label,
      toast: { __typename: 'GenAI3PExtWidgetToast', label: c.toast ?? '' },
    })),
    sections: [],
  },
})

const mkFooterAction = d => ({
  __typename: 'GenAIFooterActionPrimitive',
  cta_text: d.cta_text ?? d.text,
  cta_type: d.cta_type ?? 'OPEN_URL',
  cta_url: d.cta_url ?? d.url,
})

const mkMeta = text => ({ __typename: 'GenAIMetadataTextPrimitive', text })
const mkFOA = text => ({ __typename: 'FOATextPrimitive', text })
const mkTip = text => ({ __typename: 'GenAITipUXPrimitive', text })
const mkDivider = (type = 'HORIZONTAL_LINE') => ({ __typename: 'GenAIDividerPrimitive', divider_type: type })
const mkSpacer = (spacing = 2) => ({ __typename: 'GenAISpacerPrimitive', spacing })
const mkThinking = (title, icon = 'THINKING') => ({ __typename: 'GenAIBotThinkingStatusPrimitive', title, icon })
const mkProgress = (title, inProgress = true) => ({
  __typename: 'GenAIBotProgressStatusPrimitive', title, is_in_progress: inProgress,
  icon: null, meta_search_apps: null,
  target_secondary_screen_id: null, target_secondary_screen_tab_id: null,
})
const mkTask = ({ taskId, title, subtitle = '', status = 'PENDING' }) => ({
  __typename: 'GenAITaskPrimitive', task_id: taskId, title, subtitle, status,
})
const mkLatex = ({ expression, imageUrl, width = 400, height = 200, fontHeight = 83.333, padding = 15 }) => ({
  __typename: 'GenAITextInlineEntity',
  key: `latex_${crypto.randomUUID().slice(0, 8)}`,
  metadata: {
    __typename: 'GenAILatexItem',
    latex_expression: expression,
    font_height: fontHeight, padding,
    latex_image: {
      __typename: 'GenAIMediaItem',
      mime_type: 'image/png',
      url: imageUrl, url_fallback: imageUrl,
      width, height,
      expiration_timestamp_ms: Date.now() + 86400000,
    },
  },
})
const mkGenerating = (status = 'GENERATING') => ({ __typename: 'GenAIGeneratingImageStatusPrimitive', status })
const mkInlineImage = (url, alignment = 'center') => ({
  __typename: 'GenAIInlineImageUXPrimitive',
  image: { __typename: 'GenAIMediaItem', mime_type: 'image/jpeg', url },
  alignment,
})
const mkPill = prompt_text => ({ __typename: 'GenAIFollowUpSuggestionPillPrimitive', prompt_text })

export class AIRich {
  #client
  #nodes = []
  #idIndex = {}
  #title = ''
  #footer = ''
  #botJid = DEFAULT_BOT_JID
  #responseId = null
  #dynamic = true
  #signedVerificationMetadata = null
  #contextInfoExtra = {}
  #embeddedScreens = []

  constructor(client, opts = {}) {
    if (!client) throw new Error('Socket client is required')
    this.#client = client
    if (opts.botJid) this.#botJid = opts.botJid
    if (opts.dynamic !== undefined) this.#dynamic = opts.dynamic
    if (opts.responseId) { this.#responseId = opts.responseId; this.#dynamic = false }
  }

  #push(section, submessage = null, id = null) {
    const nodeId = id ?? `node_${this.#nodes.length}`
    this.#nodes.push({ id: nodeId, section, submessage })
    this.#idIndex[nodeId] = this.#nodes.length - 1
    return this
  }

  #replace(id, section, submessage = null) {
    const idx = this.#idIndex[id]
    if (idx === undefined) throw new Error(`Node id "${id}" not found`)
    this.#nodes[idx] = { id, section, submessage }
    return this
  }

  #insertAt(pos, section, submessage = null, id = null) {
    const nodeId = id ?? `node_${this.#nodes.length}`
    this.#nodes.splice(pos, 0, { id: nodeId, section, submessage })
    this.#idIndex = {}
    this.#nodes.forEach((n, i) => { this.#idIndex[n.id] = i })
    return this
  }

  #add(section, submessage, opts = {}) {
    if (opts.replace) return this.#replace(opts.replace, section, submessage)
    if (opts.insertAt !== undefined) return this.#insertAt(opts.insertAt, section, submessage, opts.id)
    return this.#push(section, submessage, opts.id)
  }

  setTitle(title) { this.#title = title; return this }
  setFooter(footer) { this.#footer = footer; return this }
  setBotJid(jid) { this.#botJid = jid; return this }
  setResponseId(id) { this.#responseId = id; this.#dynamic = false; return this }
  setContextInfo(ci) { this.#contextInfoExtra = ci; return this }

  addText(text, opts = {}) {
    const { text: t, inline_entities } = extractIE(text)
    return this.#add(single(mkMarkdown(t, inline_entities)), null, opts)
  }

  addCode(language, content, opts = {}) {
    const { codeBlocks, unified_codeBlock } = tokenizeCode(content, language)
    const submessage = { messageType: 5, codeMetadata: { codeLanguage: language, codeBlocks } }
    return this.#add(single(mkCode(content, language, unified_codeBlock)), submessage, opts)
  }

  addTable(rows, opts = {}) {
    const normalized = Array.isArray(rows[0])
      ? rows.map((r, i) => ({ cells: r, is_header: i === 0 }))
      : rows
    return this.#add(single(mkTable(normalized)), null, opts)
  }

  addImage(url, opts = {}) {
    const mime = /\.png$/i.test(url) ? 'image/png' : 'image/jpeg'
    return this.#add(single(mkImage(url, mime)), null, opts)
  }

  addVideo(url, opts = {}) {
    return this.#add(single(mkVideo(url)), null, opts)
  }

  addReels(reels, opts = {}) {
    const prims = reels.map(mkReel)
    return this.#add(prims.length === 1 ? single(prims[0]) : hscroll(prims), null, opts)
  }

  addPost(data, opts = {}) {
    return this.#add(single(mkPost(data)), null, opts)
  }

  addProduct(data, opts = {}) {
    return this.#add(single(mkProduct(data)), null, opts)
  }

  addSource(sources, opts = {}) {
    const prims = sources.map(mkSearchResult)
    return this.#add(prims.length === 1 ? single(prims[0]) : vstack(prims), null, opts)
  }

  addMap(locations, opts = {}) {
    const prims = locations.map(mkMap)
    return this.#add(prims.length === 1 ? single(prims[0]) : vstack(prims), null, opts)
  }

  addWidget(ctas, title = '', opts = {}) {
    return this.#add(single(mkWidget(ctas, title)), null, opts)
  }

  addFooterAction(data, opts = {}) {
    return this.#add(single(mkFooterAction(data)), null, opts)
  }

  addMetadata(text, opts = {}) { return this.#add(single(mkMeta(text)), null, opts) }
  addFOAText(text, opts = {}) { return this.#add(single(mkFOA(text)), null, opts) }
  addTip(text, opts = {}) { return this.#add(single(mkTip(text)), null, opts) }

  addDivider(type = 'HORIZONTAL_LINE', opts = {}) {
    return this.#add(single(mkDivider(type)), null, opts)
  }

  addSpacer(spacing = 2, opts = {}) {
    return this.#add(single(mkSpacer(spacing)), null, opts)
  }

  addThinkingStatus(title, icon = 'THINKING', opts = {}) {
    return this.#add(single(mkThinking(title, icon)), null, opts)
  }

  addProgressStatus(title, inProgress = true, opts = {}) {
    return this.#add(single(mkProgress(title, inProgress)), null, opts)
  }

  addTask(data, opts = {}) {
    return this.#add(single(mkTask(data)), null, opts)
  }

  addLatex(data, opts = {}) {
    const entity = mkLatex(data)
    const prim = mkMarkdown(`{{${entity.key}}}.{{/${entity.key}}}`, [entity])
    return this.#add(single(prim), null, opts)
  }

  addGenerating(status = 'GENERATING', opts = {}) {
    return this.#add(single(mkGenerating(status)), null, opts)
  }

  addInlineImage(url, alignment = 'center', opts = {}) {
    return this.#add(single(mkInlineImage(url, alignment)), null, opts)
  }

  addSuggest(prompts, scroll = false, opts = {}) {
    const prims = prompts.map(p => mkPill(typeof p === 'string' ? p : p.text ?? p))
    return this.#add(scroll ? hscroll(prims) : actionRow(prims), null, opts)
  }

  addSection(section, opts = {}) {
    return this.#add(section, null, opts)
  }

  addEmbeddedScreen(screen) {
    this.#embeddedScreens.push(screen)
    return this
  }

  loadFrom(msg) {
    const rich = msg?.botForwardedMessage?.message?.richResponseMessage ?? msg?.richResponseMessage
    if (!rich) throw new Error('Not an AIRich message')
    const mci = msg?.messageContextInfo
    if (mci?.botMetadata?.messageDisclaimerText) this.#title = mci.botMetadata.messageDisclaimerText
    if (mci?.botMetadata?.verificationMetadata) this.#signedVerificationMetadata = mci.botMetadata.verificationMetadata
    if (rich.unifiedResponse?.data) {
      try {
        const parsed = JSON.parse(
          Buffer.isBuffer(rich.unifiedResponse.data)
            ? rich.unifiedResponse.data.toString()
            : Buffer.from(rich.unifiedResponse.data, 'base64').toString()
        )
          ; (parsed.sections ?? []).forEach((s, i) => {
            const sub = rich.submessages?.[i] ?? null
            this.#nodes.push({ id: `loaded_${i}`, section: s, submessage: sub })
            this.#idIndex[`loaded_${i}`] = i
          })
      } catch { }
    }
    return this
  }

  async build(jid, opts = {}) {
    const {
      botJid = this.#botJid,
      messageId = generateMessageIDV2(),
      quoted,
      quotedParticipant,
    } = opts

    const resolved = await waitAllPromises(this.#nodes)
    const sections = resolved.map(n => n.section)
    const submessages = resolved.map(n => n.submessage).filter(Boolean)
    const embeddedScreens = await waitAllPromises(this.#embeddedScreens)

    const responseId = this.#dynamic
      ? crypto.randomUUID()
      : (this.#responseId ?? crypto.randomUUID())

    const unifiedData = JSON.stringify({
      response_id: responseId,
      sections,
      ...(embeddedScreens.length ? { embedded_screens: embeddedScreens } : {}),
    })

    const unifiedResponse = { data: Buffer.from(unifiedData) }

    const contextInfo = {
      isForwarded: true,
      forwardOrigin: 4,
      forwardingScore: 1,
      forwardedAiBotMessageInfo: { botJid },
      participant: '13135550002@s.whatsapp.net',
      remoteJid: 'status@broadcast',
      quotedMessage: { protocolMessage: { type: 25 } },
      ...this.#contextInfoExtra,
      ...(quoted ? {
        quotedMessage: quoted.message,
        stanzaId: quoted.key?.id,
        participant: quotedParticipant ?? quoted.key?.participant ?? quoted.key?.remoteJid,
        remoteJid: quoted.key?.remoteJid,
      } : {}),
    }

    const message = {
      messageContextInfo: {
        deviceListMetadata: {},
        deviceListMetadataVersion: 2,
        supportPayload: BIZ_BOT_SUPPORT,
        botMetadata: {
          botResponseId: responseId,
          ...(this.#title ? { messageDisclaimerText: this.#title } : {}),
          verificationMetadata: this.#signedVerificationMetadata ?? generateVerificationMetadata(),
          capabilities: {
            richResponseUnifiedResponse: true,
            richResponseEmbeddedScreens: true,
            richResponseInlineLinksEnabled: true,
            richResponseUrBloksEnabled: true,
            richResponseUrImagine: true,
            richResponseUrReasoning: true,
          },
        },
      },
      botForwardedMessage: {
        message: {
          richResponseMessage: {
            messageType: 1,
            submessages,
            unifiedResponse,
            originalRecipientMetadata: unifiedResponse,
            contextInfo,
          },
        },
      },
    }

    return generateWAMessageFromContent(jid, message, {
      userJid: this.#client.user?.id,
      messageId,
    })
  }

  async send(jid, opts = {}) {
    const { additionalNodes = [], ...buildOpts } = opts
    const msg = await this.build(jid, buildOpts)
    await this.#client.relayMessage(jid, msg.message, {
      messageId: msg.key.id,
      additionalNodes: [
        { tag: 'bot', attrs: { biz_bot: '1' }, content: undefined },
        { tag: 'biz', attrs: {}, content: [{ tag: 'interactive', attrs: { type: 'native_flow', v: '1' }, content: [{ tag: 'native_flow', attrs: { v: '9', name: 'mixed' } }] }] },
        ...additionalNodes,
      ],
    })
    return msg
  }

  async sendEdit(jid, targetId, opts = {}) {
    if (!targetId) throw new Error('targetId is required for sendEdit')
    const msg = await this.build(jid, opts)
    const editMsg = {
      protocolMessage: {
        key: { remoteJid: jid, fromMe: true, id: targetId },
        type: 14,
        editedMessage: msg.message,
      },
    }
    const waMsg = await generateWAMessageFromContent(jid, editMsg, { userJid: this.#client.user?.id })
    await this.#client.relayMessage(jid, waMsg.message, { messageId: waMsg.key.id })
    return waMsg
  }
}

export function aiRichFromObject(client, jid, data, opts = {}) {
  const r = new AIRich(client, { botJid: data.botJid })

  if (data.title) r.setTitle(data.title)

  if (data.parts) {
    for (const p of data.parts) {
      if (p.type === 'text') r.addText(p.content ?? p.text)
      if (p.type === 'code') r.addCode(p.language ?? '', p.content ?? p.code)
      if (p.type === 'table') r.addTable(p.table)
      if (p.type === 'image') r.addImage(p.url)
      if (p.type === 'sources') r.addSource(p.sources)
      if (p.type === 'divider') r.addDivider()
      if (p.type === 'spacer') r.addSpacer(p.spacing)
      if (p.type === 'tip') r.addTip(p.content ?? p.text)
      if (p.type === 'meta') r.addMetadata(p.content ?? p.text)
      if (p.type === 'foa') r.addFOAText(p.content ?? p.text)
    }
    return r.send(jid, opts)
  }

  if (data.texts) data.texts.forEach(t => r.addText(t))
  else if (data.text) r.addText(data.text)

  if (data.codes) data.codes.forEach(c => r.addCode(c.language ?? data.language ?? '', c.code ?? c.content))
  else if (data.code) {
    const c = typeof data.code === 'string' ? data.code : (data.code.code ?? data.code.content)
    const lang = typeof data.code === 'string' ? (data.language ?? '') : (data.code.language ?? data.language ?? '')
    r.addCode(lang, c)
  }

  if (data.table) {
    r.addTable(Array.isArray(data.table[0]) ? data.table : data.table)
  } else if (data.headers && data.rows) {
    r.addTable([data.headers, ...data.rows])
  }

  if (data.images) data.images.forEach(img => r.addImage(img.url ?? img))
  if (data.image) r.addImage(data.image.url ?? data.image)
  if (data.reels) r.addReels(data.reels)
  if (data.sources) r.addSource(data.sources)
  if (data.latex) {
    if (data.latexText) r.addText(data.latexText)
      ; (Array.isArray(data.latex) ? data.latex : [data.latex]).forEach(l => r.addLatex({
        expression: l.expression ?? l.latexExpression ?? '',
        imageUrl: l.url ?? l.imageUrl ?? '',
        width: l.width ?? 400, height: l.height ?? 200,
      }))
  }

  if (data.suggest) r.addSuggest(data.suggest)
  if (data.tip) r.addTip(data.tip)
  if (data.metadata ?? data.meta) r.addMetadata(data.metadata ?? data.meta)
  if (data.footer) r.addFOAText(data.footer)

  return r.send(jid, opts)
}
