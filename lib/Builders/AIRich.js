import crypto from 'crypto'
import { proto } from '../../WAProto/index.js'
import {
  generateMessageIDV2, generateVerificationMetadata, waitAllPromises, extractIE, tokenizeCode, generateWAMessageFromContent, generateWAMessage,
  makeWhatsAppFlowButton, metaTyping, sendMetaComposited, PlanningStepStatus, buildSteps, replayPlanning, replayPlanningOnly, buildReasoningSteps, buildSearchSteps,
  mixedSteps, buildBotRichResponse, BotCapabilityType, generateTableContent, generateListContent, generateCodeBlockContent,
  generateLatexContent, captureUnifiedResponse, generateUnifiedResponseContent
} from '../Utils/index.js'
import { isJidGroup, isJidMetaAI, jidNormalizedUser } from '../WABinary/index.js'
import { BOT_RENDERING_CONFIG_METADATA } from '../Defaults/index.js'
import { randomBytes } from 'crypto'

const DEFAULT_BOT_JID = '867051314767696@bot'
const META_AI_BOT_JID = '867051314767696@bot'
const STATUS_JID = 'status@broadcast'
const BIZ_BOT_SUPPORT = '{"version":1,"is_ai_message":true,"should_upload_client_logs":false,"should_show_system_message":false,"ticket_id":"7004947587700716","citation_items":[],"ticket_locale":"us"}'

const mkSection = vm => ({ __typename: 'GenAIUnifiedResponseSection', view_model: vm })
const single = p => mkSection({ __typename: 'GenAISingleLayoutViewModel', primitive: p })
const vstack = ps => mkSection({ __typename: 'GenAIVStackLayoutViewModel', primitives: ps })
const hscroll = ps => mkSection({ __typename: 'GenAIHScrollLayoutViewModel', primitives: ps })
const grid = ps => mkSection({ __typename: 'GenAIGridLayoutViewModel', primitives: ps })
const actionRow = ps => ({ view_model: { __typename: 'GenAIActionRowLayoutViewModel', primitives: ps } })
const addonAction = (type, ps, alignment = 'END') => mkSection({ __typename: 'GenAIAddonActionLayoutViewModel', addon_action_type: type, addon_action_alignment: alignment, primitives: ps })

const mkMarkdown = (text, entities = []) => { const { text: t, inline_entities } = extractIE(text, entities); return { __typename: 'GenAIMarkdownTextUXPrimitive', text: t, inline_entities } }
const mkCode = (content, language = '', unified_codeBlock = []) => ({ __typename: 'GenAICodeUXPrimitive', language, code_blocks: unified_codeBlock.length ? unified_codeBlock : [{ content }] })

const mkTable = (rows, title = '') => {
  const normalized = Array.isArray(rows[0])
    ? rows.map((r, i) => ({ is_header: i === 0, cells: r.map(c => (typeof c === 'string' ? c : String(c))), markdown_cells: r.map(c => ({ text: typeof c === 'string' ? c : String(c) })) }))
    : rows.map(r => ({ is_header: !!r.is_header, cells: (r.cells ?? r.items ?? []).map(c => (typeof c === 'string' ? c : String(c))), markdown_cells: (r.cells ?? r.items ?? []).map(c => ({ text: typeof c === 'string' ? c : String(c) })) }))
  return { __typename: 'GenATableUXPrimitive', title, rows: normalized }
}

const mkImage = (input, expiration) => {
  const img = typeof input === 'string' ? { url: input } : input
  const exp = expiration ?? String(Date.now() + 30 * 24 * 60 * 60 * 1000)
  const first = (...vals) => vals.find(v => v != null && String(v).length > 0)
  const previewUrl = first(img.previewUrl, img.preview_url, img.imagePreviewUrl, img.url) ?? ''
  const fullUrl = first(img.highResUrl, img.high_res_url, img.imageHighResUrl, img.fullUrl, img.full_url, img.url, previewUrl)
  const darkPreview = first(img.darkModePreviewUrl, img.dark_mode_preview_url, previewUrl)
  const darkFull = first(img.darkModeHighResUrl, img.dark_mode_high_res_url, darkPreview)
  const mime = img.mimeType ?? img.mime_type ?? (/\.png$/i.test(img.url ?? '') ? 'image/png' : 'image/jpeg')
  const w = Number(img.width ?? 600), h = Number(img.height ?? 400)
  const media = (url, mw, mh) => ({ url, url_fallback: url, mime_type: mime, expiration_timestamp_ms: exp, width: mw, height: mh })
  return { __typename: 'GenAIImagePrimitive', preview_image: media(previewUrl, w, h), full_image: media(fullUrl, w, h), dark_mode_preview_image: media(darkPreview, w, h), dark_mode_full_image: media(darkFull, w, h), asset_query_status: 'FETCHED' }
}

const mkVideo = url => ({ __typename: 'GenAIVideoPrimitive', media: { __typename: 'GenAIMediaItem', mime_type: 'video/mp4', url } })
const mkReel = ({ creator, avatar_url, thumbnail_url, reels_url, title, likes_count, shares_count, view_count, reel_source, is_verified }) => ({ __typename: 'GenAIReelPrimitive', creator: creator ?? '', avatar_url: avatar_url ?? '', thumbnail_url: thumbnail_url ?? '', reels_url: reels_url ?? '', reels_title: title ?? '', likes_count: likes_count ?? 0, shares_count: shares_count ?? 0, view_count: view_count ?? 0, reel_source: reel_source ?? 'IG', is_verified: !!is_verified })
const mkPost = d => ({ __typename: 'GenAIPostPrimitive', title: d.title ?? '', username: d.username ?? '', subtitle: d.subtitle ?? '', thumbnail_url: d.thumbnail_url ?? '', post_url: d.post_url ?? d.url ?? '', post_caption: d.post_caption ?? d.caption ?? '', post_type: d.post_type ?? 'photo', source_app: d.source_app ?? 'instagram', likes_count: d.likes_count ?? 0, comments_count: d.comments_count ?? 0, shares_count: d.shares_count ?? 0, is_verified: d.is_verified ?? false, is_carousel: d.is_carousel ?? false, orientation: d.orientation ?? 'portrait', profile_picture_url: d.profile_picture_url ?? null, footer_label: d.footer_label ?? null, footer_icon: d.footer_icon ?? null, additional_images: d.additional_images ?? [] })
const mkProduct = d => ({ __typename: 'GenAIProductItemCardPrimitive', title: d.title ?? '', brand: d.brand ?? '', price: d.price ?? '', sale_price: d.sale_price ?? null, product_url: d.product_url ?? d.url ?? '', image: { url: d.image_url ?? d.image ?? '' }, additional_images: [] })
const mkSearchResult = d => ({ __typename: 'GenAISearchResultPrimitive', source_url: d.url ?? d.source_url ?? '', source_display_name: d.title ?? d.source_display_name ?? '', source_type: d.source_type ?? 'web', source_subtitle: d.subtitle ?? d.source_subtitle ?? '', favicon: d.favicon ?? null })
const mkMap = ({ latitude, longitude, name = '', address = '' }) => ({ __typename: 'GenAIMapPrimitive', latitude, longitude, name, address })

const mkRichMap = ({ centerLatitude, centerLongitude, latitudeDelta, longitudeDelta, annotations = [], showInfoList = false }) => {
  if (centerLatitude == null || centerLongitude == null) throw new TypeError('addRichMap requires centerLatitude and centerLongitude')
  const submessage = { messageType: proto.AIRichResponseSubMessageType.AI_RICH_RESPONSE_MAP, mapMetadata: { centerLatitude, centerLongitude, ...(latitudeDelta != null ? { latitudeDelta } : {}), ...(longitudeDelta != null ? { longitudeDelta } : {}), showInfoList: !!showInfoList, annotations: annotations.map((a, i) => ({ annotationNumber: a.annotationNumber ?? i + 1, latitude: a.latitude, longitude: a.longitude, title: a.title ?? '', body: a.body ?? '' })) } }
  const displayLat = annotations[0]?.latitude ?? centerLatitude, displayLng = annotations[0]?.longitude ?? centerLongitude
  return { submessage, section: single({ __typename: 'GenAIMapPrimitive', latitude: displayLat, longitude: displayLng, name: annotations[0]?.title ?? '', address: annotations[0]?.body ?? '' }) }
}

const mkDynamic = ({ url, type = 'GIF', version, loopCount } = {}) => {
  if (!url) throw new TypeError('addDynamic requires a url')
  const dynType = String(type).toUpperCase() === 'IMAGE' ? proto.AIRichResponseDynamicMetadata.AIRichResponseDynamicMetadataType.AI_RICH_RESPONSE_DYNAMIC_METADATA_TYPE_IMAGE : proto.AIRichResponseDynamicMetadata.AIRichResponseDynamicMetadataType.AI_RICH_RESPONSE_DYNAMIC_METADATA_TYPE_GIF
  const submessage = { messageType: proto.AIRichResponseSubMessageType.AI_RICH_RESPONSE_DYNAMIC, dynamicMetadata: { type: dynType, url, ...(version != null ? { version } : {}), ...(loopCount != null ? { loopCount } : {}) } }
  const mimeType = dynType === proto.AIRichResponseDynamicMetadata.AIRichResponseDynamicMetadataType.AI_RICH_RESPONSE_DYNAMIC_METADATA_TYPE_IMAGE ? 'image/jpeg' : 'image/gif'
  return { submessage, section: single({ __typename: 'GenAIDynamicMediaPrimitive', url, mime_type: mimeType, ...(loopCount != null ? { loop_count: loopCount } : {}) }) }
}

const mkWidget = (ctas, title = '') => ({ __typename: 'GenAI3PExtWidgetPrimitive', header: { __typename: 'GenAI3PExtWidgetStandardHeader', title }, body: { __typename: 'GenAI3PExtCalendarEventList', ctas: ctas.map(c => ({ __typename: 'GenAI3PExtWidgetCTA', label: c.label, state: 'PENDING', kind: c.kind ?? 'OTHER', tool_call_id: c.tool_call_id ?? c.id ?? crypto.randomBytes(8).toString('hex'), toast: { __typename: 'GenAI3PExtWidgetToast', label: c.toast ?? '' } })), sections: [] } })
const mkFooterAction = d => ({ __typename: 'GenAIFooterActionPrimitive', cta_text: d.cta_text ?? d.text ?? '', cta_type: d.cta_type ?? 'OPEN_URL', cta_url: d.cta_url ?? d.url ?? '' })

const mkSocialProfile = ({ username = '', platform = 'GENERIC', title = '', subtitle = '', imageUrl = '', entityId, entityUrl, entityType, fullName = '', isVerified = false, resultText = 'See results' }) => {
  if (!username || typeof username !== 'string') throw new TypeError('addSocialProfile requires a username')
  const normalizedPlatform = String(platform).toUpperCase()
  const profileUrl = entityUrl ?? (username ? `https://www.${platform.toLowerCase()}.com/${encodeURIComponent(username)}` : '')
  const resolvedType = entityType ?? (normalizedPlatform === 'INSTAGRAM' ? 'IG_PROFILE' : 'SOCIAL_PROFILE')
  const image = imageUrl ? { url: imageUrl, mime_type: 'image/png' } : undefined
  return [
    { view_model: { primitives: [{ __typename: 'GenAICompactEntityPrimitive', title, subtitle, ...(image ? { image } : {}), entity_id: String(entityId ?? username ?? ''), entity_url: profileUrl, entity_type: 'WEBSITE', action_type: 'OPEN_URL', is_verified: !!isVerified }], __typename: 'GenAIActionRowLayoutViewModel' } },
    { view_model: { primitives: [{ type: 'HORIZONTAL_LINE', __typename: 'GenAIDividerPrimitive' }], __typename: 'GenAIVStackLayoutViewModel' } },
    { view_model: { primitives: [{ __typename: 'GenAISpacerPrimitive' }, { __typename: 'GenAIMarkdownTextUXPrimitive', text: `# {{social_entity_1}}${resultText}\0{{/social_entity_1}}    `, inline_entities: [{ key: 'social_entity_1', metadata: { __typename: 'GenAISocialEntityItem', entity_id: String(entityId ?? username ?? ''), entity_name: username, entity_full_name: fullName, platform: normalizedPlatform, entity_picture_url: imageUrl, entity_url: profileUrl, entity_type: resolvedType, is_verified: !!isVerified } }] }, { __typename: 'GenAISpacerPrimitive' }], __typename: 'GenAIActionRowLayoutViewModel' } }
  ]
}

const mkInlineImage = (url, alignment = 'center') => ({ __typename: 'GenAIInlineImageUXPrimitive', image: { __typename: 'GenAIMediaItem', mime_type: 'image/jpeg', url }, alignment })
const mkMeta = text => ({ __typename: 'GenAIMetadataTextPrimitive', text })
const mkFOA = text => ({ __typename: 'FOATextPrimitive', text })
const mkTip = text => ({ __typename: 'GenAITipUXPrimitive', text })
const mkDivider = (type = 'HORIZONTAL_LINE') => ({ __typename: 'GenAIDividerPrimitive', divider_type: type })
const mkSpacer = (spacing = 2) => ({ __typename: 'GenAISpacerPrimitive', spacing })
const mkThinking = (title, icon = 'THINKING') => ({ __typename: 'GenAIBotThinkingStatusPrimitive', title, icon })
const mkProgress = (title, inProgress = true) => ({ __typename: 'GenAIBotProgressStatusPrimitive', title, is_in_progress: inProgress, icon: null, meta_search_apps: null, target_secondary_screen_id: null, target_secondary_screen_tab_id: null })
const mkTask = ({ taskId, title, subtitle = '', status = 'PENDING' }) => ({ __typename: 'GenAITaskPrimitive', task_id: taskId, title, subtitle, status })
const mkLatex = ({ expression, imageUrl, width = 400, height = 200, fontHeight = 83.333, padding = 15 }) => ({ __typename: 'GenAITextInlineEntity', key: `latex_${crypto.randomUUID().slice(0, 8)}`, metadata: { __typename: 'GenAILatexItem', latex_expression: expression, font_height: fontHeight, padding, latex_image: { __typename: 'GenAIMediaItem', mime_type: 'image/png', url: imageUrl, url_fallback: imageUrl, width, height, expiration_timestamp_ms: Date.now() + 86400000 } } })
const mkPill = prompt_text => ({ __typename: 'GenAIFollowUpSuggestionPillPrimitive', prompt_text })
const mkHtml = (html, trustedSources = []) => ({ __typename: 'FOAHtmlPrimitiveDemoDONOTUSE', trusted_sources: trustedSources, payload: String(html).trim() })
const mkRichHtml = (html, url = '', trustedSources = []) => ({ __typename: 'GenAIaeacdsnwHtmlPrimitive', payload: String(html).trim(), url, trusted_sources: trustedSources })

// validates proofs exist before attaching — never fabricate provenance
export const hasVerifiableProofs = v => Array.isArray(v?.proofs) && v.proofs.length > 0

export const wrapToBotForwardedMessage = (richResponseMessage, verificationMetadata) => ({
  messageContextInfo: { botMetadata: { pluginMetadata: {}, ...(hasVerifiableProofs(verificationMetadata) ? { verificationMetadata } : {}), botRenderingConfigMetadata: BOT_RENDERING_CONFIG_METADATA } },
  botForwardedMessage: { message: { richResponseMessage } }
})

export const attachBotVerificationProofs = (envelope, verificationMetadata) => {
  if (!envelope || !hasVerifiableProofs(verificationMetadata)) return envelope
  const botMetadata = envelope?.messageContextInfo?.botMetadata
  if (!botMetadata || botMetadata.verificationMetadata) return envelope
  botMetadata.verificationMetadata = verificationMetadata
  return envelope
}

// only ships previewMedia when all required crypto fields are present — drops incomplete descriptors
const normalizePreviewMedia = media => {
  if (!media || typeof media !== 'object') return null
  const { fileSha256, mediaKey, fileEncSha256, directPath, mimetype, mediaKeyTimestamp } = media
  if (!fileSha256 || !mediaKey || !fileEncSha256 || !directPath) return null
  return { fileSha256, mediaKey, fileEncSha256, directPath, mediaKeyTimestamp: mediaKeyTimestamp ?? Math.floor(Date.now() / 1000), mimetype: mimetype || 'image/jpeg' }
}

const buildAdditionalBotMetadata = (submessages) => {
  const sources = [], mediaDetailsMetadataList = []
  for (const sub of submessages) {
    if (sub?.contentItemsMetadata?.itemsMetadata) {
      for (const item of sub.contentItemsMetadata.itemsMetadata) {
        const r = item?.reelItem ?? item ?? {}
        sources.push({ provider: 0, thumbnailCdnUrl: r.thumbnailUrl ?? r.thumbnail_url ?? '', sourceProviderUrl: r.videoUrl ?? r.reels_url ?? r.url ?? '', sourceQuery: '', faviconCdnUrl: r.profileIconUrl ?? r.avatar_url ?? '', citationNumber: sources.length + 1, sourceTitle: r.title ?? r.reels_title ?? r.creator ?? '' })
        const previewMedia = normalizePreviewMedia(r.previewMedia)
        if (previewMedia) mediaDetailsMetadataList.push({ id: r.mediaId ?? r.previewMedia?.mediaId ?? crypto.randomBytes(32).toString('hex'), previewMedia })
      }
    }
    if (sub?.latexMetadata?.expressions) {
      for (const expr of sub.latexMetadata.expressions) {
        const previewMedia = normalizePreviewMedia(expr?.previewMedia)
        if (previewMedia) mediaDetailsMetadataList.push({ id: expr.mediaId ?? expr.previewMedia?.mediaId ?? crypto.randomBytes(32).toString('hex'), previewMedia })
      }
    }
  }
  return { sources, mediaDetailsMetadataList }
}

export const buildImaginePrimitive = ({ mediaType = 'video', url = '', thumbnail, mimeType, fileLength = 0, duration = 0, status = 'GENERATING', estimatedMs, imagineType } = {}) => {
  const type = String(mediaType).toLowerCase() === 'image' ? 'IMAGE' : 'ANIMATE'
  const prim = { __typename: 'GenAIImaginePrimitive', media: { url: url ?? '', mime_type: mimeType ?? (type === 'IMAGE' ? 'image/jpeg' : 'video/mp4'), file_length: fileLength ?? 0, duration: duration ?? 0 }, imagine_type: imagineType ?? type, status: { status: String(status).toUpperCase() } }
  if (estimatedMs != null) prim.status.estimated_completion_time = Math.floor((Date.now() + Number(estimatedMs)) / 1000)
  if (thumbnail) prim.thumbnail = { raw_media: thumbnail }
  return prim
}

export const prepareRichGenerationMessage = ({ text = '', mediaType = 'video', url = '', thumbnail, mimeType, fileLength = 0, duration = 0, status = 'GENERATING', estimatedMs, itemId = `imagine_${crypto.randomUUID()}`, responseId = crypto.randomUUID(), verificationMetadata } = {}) => {
  const sections = []
  if (text) sections.push({ view_model: { primitive: { text: String(text), inline_entities: [], __typename: 'GenAIMarkdownTextUXPrimitive' }, __typename: 'GenAISingleLayoutViewModel' } })
  sections.push({ view_model: { primitive: buildImaginePrimitive({ mediaType, url, thumbnail, mimeType, fileLength, duration, status, estimatedMs }), __typename: 'GenAISingleLayoutViewModel', id: itemId } })
  const submessages = text ? [{ messageType: 2, messageText: String(text) }] : []
  const richResponseMessage = proto.AIRichResponseMessage.create({ submessages, messageType: 1, unifiedResponse: { data: Buffer.from(JSON.stringify({ response_id: responseId, sections })) }, contextInfo: { isForwarded: true, forwardingScore: 1, forwardedAiBotMessageInfo: { botJid: DEFAULT_BOT_JID }, forwardOrigin: 4 } })
  const message = wrapToBotForwardedMessage(richResponseMessage, verificationMetadata)
  message.messageContextInfo.botMetadata.botResponseId = responseId
  return { message, responseId, itemId }
}

export class AIRich {
  #client; #nodes = []; #idIndex = {}; #title = ''; #footer = ''; #botJid = DEFAULT_BOT_JID
  #responseId = null; #dynamic = true; #signedVerificationMetadata = null
  #contextInfoExtra = {}; #embeddedScreens = []; #suggestedPrompts = null
  #botSources = null; #pttTranscript = null

  constructor(client, opts = {}) {
    if (!client) throw new Error('Socket client is required')
    this.#client = client
    if (opts.botJid) this.#botJid = opts.botJid
    if (opts.dynamic !== undefined) this.#dynamic = opts.dynamic
    if (opts.responseId) { this.#responseId = opts.responseId; this.#dynamic = false }
  }

  #push(section, submessage = null, id = null) { const nodeId = id ?? `node_${this.#nodes.length}`; this.#nodes.push({ id: nodeId, section, submessage }); this.#idIndex[nodeId] = this.#nodes.length - 1; return this }
  #replace(id, section, submessage = null) { const idx = this.#idIndex[id]; if (idx === undefined) throw new Error(`Node id "${id}" not found`); this.#nodes[idx] = { id, section, submessage }; return this }
  #insertAt(pos, section, submessage = null, id = null) { const nodeId = id ?? `node_${this.#nodes.length}`; this.#nodes.splice(pos, 0, { id: nodeId, section, submessage }); this.#idIndex = {}; this.#nodes.forEach((n, i) => { this.#idIndex[n.id] = i }); return this }
  #add(section, submessage, opts = {}) { if (opts.replace) return this.#replace(opts.replace, section, submessage); if (opts.insertAt !== undefined) return this.#insertAt(opts.insertAt, section, submessage, opts.id); return this.#push(section, submessage, opts.id) }

  async #uploadMedia(input, mediaType = 'image') { if (typeof input === 'string' && !input.startsWith('http')) { const { readFileSync } = await import('fs'); input = readFileSync(input) } if (Buffer.isBuffer(input) || input instanceof Uint8Array) { const uploaded = await this.#client.waUploadToServer({ [mediaType]: input }, { mediaType, upload: this.#client.waUploadToServer }); return uploaded.url } return typeof input === 'string' ? input : input }

  setTitle(title) { this.#title = title; return this }

  setTitle(title) { this.#title = title; return this }
  setFooter(footer) { this.#footer = footer; return this }
  setBotJid(jid) { this.#botJid = jid; return this }
  setResponseId(id) { this.#responseId = id; this.#dynamic = false; return this }
  setContextInfo(ci) { this.#contextInfoExtra = ci; return this }

  addText(text, opts = {}) { const { text: t, inline_entities } = extractIE(text); return this.#add(single(mkMarkdown(t, inline_entities)), null, opts) }
  addCode(language, content, opts = {}) { const { codeBlocks, unified_codeBlock } = tokenizeCode(content, language); const submessage = { messageType: 5, codeMetadata: { codeLanguage: language, codeBlocks } }; return this.#add(single(mkCode(content, language, unified_codeBlock)), submessage, opts) }
  addTable(rows, title = '', opts = {}) { return this.#add(single(mkTable(rows, title)), null, opts) }
  addImage(input, opts = {}) { const resolved = this.#uploadMedia(input, 'image').then(url => single(mkImage(url))); return this.#add(resolved, null, opts) }
  addVideo(url, opts = {}) { const resolved = this.#uploadMedia(url, 'video').then(u => single(mkVideo(u))); return this.#add(resolved, null, opts) }
  addGrid(items, opts = {}) { if (!Array.isArray(items) || items.length < 2) throw new Error('addGrid requires at least 2 items'); return this.#add(grid(items.map(i => mkImage(i))), null, opts) }

  addVideoGrid(videos, opts = {}) {
    if (!Array.isArray(videos) || videos.length < 2) throw new Error('addVideoGrid requires at least 2 videos')
    const prims = videos.map(v => { const url = typeof v === 'string' ? v : (v?.url ?? v?.videoUrl ?? ''); const item = typeof v === 'string' ? {} : v; return { __typename: 'GenAIVideoPrimitive', reels_url: url, reels_title: item.title, thumbnail_url: item.thumbnailUrl ?? item.thumbnail, creator: item.creator, avatar_url: item.avatarUrl, likes_count: item.likes, comments_count: item.comments, shares_count: item.shares, is_verified: item.isVerified, video_delivery_response: { progressive_urls: (item.progressiveUrls ?? []).map(u => ({ progressive_url: u, __typename: 'GenAIProgressiveUrlResponse' })), dash_manifests: (item.dashManifests ?? []).map(m => ({ manifest_xml: m, __typename: 'GenAIDashManifestResponse' })), __typename: 'GenAIVideoDeliveryResponse' } } })
    return this.#add(grid(prims), null, opts)
  }

  addReels(reels, opts = {}) { const prims = reels.map(mkReel); return this.#add(prims.length === 1 ? single(prims[0]) : hscroll(prims), null, opts) }
  addImagine(input = {}, opts = {}) { return this.#add(single(buildImaginePrimitive(input)), null, opts) }
  addInlineImage(url, alignment = 'center', opts = {}) { return this.#add(single(mkInlineImage(url, alignment)), null, opts) }
  addHtml(html, trustedSources = [], opts = {}) { return this.#add(single(mkHtml(html, trustedSources)), null, opts) }

  addRichHtml(tabs, title = 'Preview', opts = {}) {
    const tabItems = typeof tabs === 'string' ? [{ title: 'HTML', html: tabs }] : Array.isArray(tabs) ? tabs : [tabs]
    const embeddedTabs = tabItems.map((tab, i) => ({ id: tab.id ?? `tab_${i}`, tab_header: tab.title ?? tab.tab_header ?? `HTML ${i + 1}`, sections: [{ __typename: 'GenAIUnifiedResponseSection', view_model: { __typename: 'GenAISingleLayoutViewModel', primitive: mkRichHtml(tab.html ?? '', tab.url ?? '', tab.trustedSources ?? []) } }], step_entries: [] }))
    this.#embeddedScreens.push({ title, content: [{ __typename: 'FOAIDNixelButtonSheets', tabs: embeddedTabs }] })
    return this.#add(single(mkMarkdown(`> ${title}`)), null, opts)
  }

  addPost(data, opts = {}) { return this.#add(single(mkPost(data)), null, opts) }
  addProduct(data, opts = {}) { return this.#add(single(mkProduct(data)), null, opts) }
  addSource(sources, opts = {}) { const prims = sources.map(mkSearchResult); return this.#add(prims.length === 1 ? single(prims[0]) : vstack(prims), null, opts) }
  addMap(locations, opts = {}) { const prims = locations.map(mkMap); return this.#add(prims.length === 1 ? single(prims[0]) : vstack(prims), null, opts) }
  addWidget(ctas, title = '', opts = {}) { return this.#add(single(mkWidget(ctas, title)), null, opts) }
  addFooterAction(data, opts = {}) { return this.#add(single(mkFooterAction(data)), null, opts) }
  addSocialProfile(data, opts = {}) { const sections = mkSocialProfile(data); for (const s of sections) this.#push(s, null, opts.id ? `${opts.id}_${this.#nodes.length}` : null); return this }
  addInstagramProfile(data, opts = {}) { return this.addSocialProfile({ platform: 'INSTAGRAM', entityType: 'IG_PROFILE', entityUrl: data.entityUrl ?? (data.username ? `https://www.instagram.com/${encodeURIComponent(data.username)}` : ''), ...data }, opts) }
  addCopyAction(text, label, alignment = 'END', opts = {}) { return this.#add(addonAction('COPY_TO_CLIPBOARD', [mkMarkdown(String(label ?? text))], alignment), null, opts) }
  addAddonAction(type, primitives, alignment = 'END', opts = {}) { return this.#add(addonAction(type, primitives, alignment), null, opts) }
  addMetadata(text, opts = {}) { return this.#add(single(mkMeta(text)), null, opts) }
  addFOAText(text, opts = {}) { return this.#add(single(mkFOA(text)), null, opts) }
  addTip(text, opts = {}) { return this.#add(single(mkTip(text)), null, opts) }
  addDivider(type = 'HORIZONTAL_LINE', opts = {}) { return this.#add(single(mkDivider(type)), null, opts) }
  addSpacer(spacing = 2, opts = {}) { return this.#add(single(mkSpacer(spacing)), null, opts) }
  addThinkingStatus(title, icon = 'THINKING', opts = {}) { return this.#add(single(mkThinking(title, icon)), null, opts) }
  addProgressStatus(title, inProgress = true, opts = {}) { return this.#add(single(mkProgress(title, inProgress)), null, opts) }
  addTask(data, opts = {}) { return this.#add(single(mkTask(data)), null, opts) }
  addLatex(data, opts = {}) { const entity = mkLatex(data); const prim = mkMarkdown(`{{${entity.key}}}.{{/${entity.key}}}`, [entity]); return this.#add(single(prim), null, opts) }
  addSuggest(prompts, scroll = false, opts = {}) { const prims = prompts.map(p => mkPill(typeof p === 'string' ? p : (p.text ?? p))); return this.#add(scroll ? hscroll(prims) : actionRow(prims), null, opts) }
  addRichMap(mapOpts, opts = {}) { const { submessage, section } = mkRichMap(mapOpts); return this.#add(section, submessage, opts) }
  addDynamic(dynOpts, opts = {}) { const { submessage, section } = mkDynamic(dynOpts); return this.#add(section, submessage, opts) }
  addSection(section, opts = {}) { return this.#add(section, null, opts) }
  addEmbeddedScreen(screen) { this.#embeddedScreens.push(screen); return this }
  // push raw sections + submessages directly — escape hatch for new primitives not yet wrapped
  addRawSections(sections, submessages = []) { sections.forEach((s, i) => this.#push(s, submessages[i] ?? null)); return this }

  addSuggestPrompts(suggestions, opts = {}) {
    if (!Array.isArray(suggestions) || !suggestions.length) throw new Error('addSuggestPrompts requires at least one suggestion')
    this.#suggestedPrompts = { suggestedPrompts: suggestions.map(String), ...(opts.selectedPromptIndex != null ? { selectedPromptIndex: opts.selectedPromptIndex } : {}), ...(opts.selectedPromptId != null ? { selectedPromptId: String(opts.selectedPromptId) } : {}) }
    return this.#add(actionRow(suggestions.map(s => mkPill(s))), null, opts)
  }

  addSources(sources, opts = {}) {
    if (!Array.isArray(sources) || !sources.length) throw new Error('addSources requires at least one source')
    this.#botSources = sources.map((s, i) => ({ provider: s.provider ?? 0, thumbnailCdnUrl: s.thumbnailCdnUrl ?? s.thumbnail ?? '', sourceProviderUrl: s.sourceProviderUrl ?? s.url ?? '', sourceQuery: s.sourceQuery ?? s.query ?? '', faviconCdnUrl: s.faviconCdnUrl ?? s.favicon ?? '', citationNumber: s.citationNumber ?? i + 1, sourceTitle: s.sourceTitle ?? s.title ?? '' }))
    const prims = sources.map(mkSearchResult)
    return this.#add(prims.length === 1 ? single(prims[0]) : vstack(prims), null, opts)
  }

  addPttTranscript(transcript, opts = {}) {
    if (!transcript) throw new Error('addPttTranscript requires a transcript string')
    this.#pttTranscript = String(transcript)
    return this.#add(single(mkMeta(`🎤 _${transcript}_`)), null, opts)
  }

  loadFrom(msg) {
    const rich = msg?.botForwardedMessage?.message?.richResponseMessage ?? msg?.richResponseMessage
    if (!rich) throw new Error('Not an AIRich message')
    const mci = msg?.messageContextInfo
    if (mci?.botMetadata?.messageDisclaimerText) this.#title = mci.botMetadata.messageDisclaimerText
    if (mci?.botMetadata?.verificationMetadata) this.#signedVerificationMetadata = mci.botMetadata.verificationMetadata
    if (rich.unifiedResponse?.data) {
      try {
        const parsed = JSON.parse(Buffer.isBuffer(rich.unifiedResponse.data) ? rich.unifiedResponse.data.toString() : Buffer.from(rich.unifiedResponse.data, 'base64').toString())
          ; (parsed.sections ?? []).forEach((s, i) => { const sub = rich.submessages?.[i] ?? null; this.#nodes.push({ id: `loaded_${i}`, section: s, submessage: sub }); this.#idIndex[`loaded_${i}`] = i })
      } catch { }
    }
    return this
  }

  async build(jid, opts = {}) {
    const { botJid = this.#botJid, messageId = generateMessageIDV2(), quoted, quotedParticipant } = opts
    const resolved = await waitAllPromises(this.#nodes)
    const sections = resolved.map(n => n.section)
    const submessages = resolved.map(n => n.submessage).filter(Boolean)
    const embeddedScreens = await waitAllPromises(this.#embeddedScreens)
    const responseId = this.#dynamic ? crypto.randomUUID() : (this.#responseId ?? crypto.randomUUID())
    const unifiedData = JSON.stringify({ response_id: responseId, sections, ...(embeddedScreens.length ? { embedded_screens: embeddedScreens } : {}) })
    const contextInfo = { isForwarded: true, forwardOrigin: 4, forwardingScore: 1, forwardedAiBotMessageInfo: { botJid }, participant: '13135550002@s.whatsapp.net', remoteJid: 'status@broadcast', quotedMessage: { protocolMessage: { type: 25 } }, ...this.#contextInfoExtra, ...(quoted ? { quotedMessage: quoted.message, stanzaId: quoted.key?.id, participant: quotedParticipant ?? quoted.key?.participant ?? quoted.key?.remoteJid, remoteJid: quoted.key?.remoteJid } : {}) }
    const verification = this.#signedVerificationMetadata ?? generateVerificationMetadata()
    const { sources, mediaDetailsMetadataList } = buildAdditionalBotMetadata(submessages)
    const richResponseMessage = proto.AIRichResponseMessage.create({ messageType: 1, submessages, unifiedResponse: { data: Buffer.from(unifiedData) }, originalRecipientMetadata: { data: Buffer.from(unifiedData) }, contextInfo })
    const message = wrapToBotForwardedMessage(richResponseMessage, verification)
    const botMeta = message.messageContextInfo.botMetadata
    botMeta.botResponseId = responseId
    botMeta.deviceListMetadata = {}
    botMeta.deviceListMetadataVersion = 2
    botMeta.supportPayload = BIZ_BOT_SUPPORT
    if (this.#title) botMeta.messageDisclaimerText = this.#title
    if (sources.length || this.#botSources?.length) botMeta.richResponseSourcesMetadata = { sources: this.#botSources ?? sources }
    if (mediaDetailsMetadataList.length) botMeta.unifiedResponseMutation = { mediaDetailsMetadataList }
    if (this.#suggestedPrompts) botMeta.suggestedPromptMetadata = this.#suggestedPrompts
    if (this.#pttTranscript) botMeta.pttPromptMetadata = { transcript: this.#pttTranscript }
    botMeta.capabilities = { richResponseUnifiedResponse: true, richResponseEmbeddedScreens: true, richResponseInlineLinksEnabled: true, richResponseUrBloksEnabled: true, richResponseUrImagine: true, richResponseUrReasoning: true }
    return generateWAMessageFromContent(jid, message, { userJid: this.#client.user?.id, messageId })
  }

  async send(jid, opts = {}) {
    const { additionalNodes = [], ...buildOpts } = opts
    const msg = await this.build(jid, buildOpts)
    await this.#client.relayMessage(jid, msg.message, { messageId: msg.key.id, additionalNodes: [{ tag: 'bot', attrs: { biz_bot: '1' }, content: undefined }, { tag: 'biz', attrs: {}, content: [{ tag: 'interactive', attrs: { type: 'native_flow', v: '1' }, content: [{ tag: 'native_flow', attrs: { v: '9', name: 'mixed' } }] }] }, ...additionalNodes] })
    return msg
  }

  async sendEdit(jid, targetId, opts = {}) {
    if (!targetId) throw new Error('targetId is required for sendEdit')
    const msg = await this.build(jid, opts)
    const editMsg = { protocolMessage: { key: { remoteJid: jid, fromMe: true, id: targetId }, type: 14, editedMessage: msg.message } }
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
      if (p.type === 'table') r.addTable(p.table, p.title)
      if (p.type === 'image') r.addImage(p.url ?? p.image)
      if (p.type === 'grid') r.addGrid(p.items ?? p.images)
      if (p.type === 'videoGrid') r.addVideoGrid(p.items ?? p.videos)
      if (p.type === 'imagine') r.addImagine(p)
      if (p.type === 'sources') r.addSource(p.sources)
      if (p.type === 'divider') r.addDivider()
      if (p.type === 'spacer') r.addSpacer(p.spacing)
      if (p.type === 'tip') r.addTip(p.content ?? p.text)
      if (p.type === 'meta') r.addMetadata(p.content ?? p.text)
      if (p.type === 'foa') r.addFOAText(p.content ?? p.text)
      if (p.type === 'html') r.addHtml(p.html, p.trustedSources)
      if (p.type === 'richHtml') r.addRichHtml(p.tabs ?? p.html, p.title)
      if (p.type === 'copy') r.addCopyAction(p.text, p.label, p.alignment)
      if (p.type === 'social') r.addSocialProfile(p)
      if (p.type === 'imagine') r.addImagine(p)
      if (p.type === 'rawSections') r.addRawSections(p.sections, p.submessages)
    }
    return r.send(jid, opts)
  }
  if (data.texts) data.texts.forEach(t => r.addText(t))
  else if (data.text) r.addText(data.text)
  if (data.codes) data.codes.forEach(c => r.addCode(c.language ?? data.language ?? '', c.code ?? c.content))
  else if (data.code) { const c = typeof data.code === 'string' ? data.code : (data.code.code ?? data.code.content); const lang = typeof data.code === 'string' ? (data.language ?? '') : (data.code.language ?? data.language ?? ''); r.addCode(lang, c) }
  if (data.table) r.addTable(data.table, data.tableTitle)
  else if (data.headers && data.rows) r.addTable([data.headers, ...data.rows], data.tableTitle)
  if (data.images) data.images.forEach(img => r.addImage(img.url ?? img))
  if (data.image) r.addImage(data.image.url ?? data.image)
  if (data.grid) r.addGrid(data.grid)
  if (data.videoGrid) r.addVideoGrid(data.videoGrid)
  if (data.reels) r.addReels(data.reels)
  if (data.imagine) r.addImagine(typeof data.imagine === 'object' ? data.imagine : { url: data.imagine })
  if (data.sources) r.addSource(data.sources)
  if (data.richMapSources) r.addSources(data.richMapSources)
  else if (data.botSources) r.addSources(data.botSources)
  if (data.richMap) r.addRichMap(data.richMap)
  if (data.dynamic) r.addDynamic(data.dynamic)
  if (data.suggestPrompts) r.addSuggestPrompts(Array.isArray(data.suggestPrompts) ? data.suggestPrompts : data.suggestPrompts.suggestions, data.suggestPrompts)
  if (data.pttTranscript) r.addPttTranscript(data.pttTranscript)
  if (data.instagramProfile) r.addInstagramProfile(data.instagramProfile)
  if (data.latex) { if (data.latexText) r.addText(data.latexText); (Array.isArray(data.latex) ? data.latex : [data.latex]).forEach(l => r.addLatex({ expression: l.expression ?? l.latexExpression ?? '', imageUrl: l.url ?? l.imageUrl ?? '', width: l.width ?? 400, height: l.height ?? 200 })) }
  if (data.html) r.addHtml(data.html, data.trustedSources)
  if (data.richHtml) r.addRichHtml(data.richHtml, data.richHtmlTitle)
  if (data.copyText) r.addCopyAction(data.copyText, data.copyLabel, data.copyAlignment)
  if (data.social) r.addSocialProfile(data.social)
  if (data.suggest) r.addSuggest(data.suggest)
  if (data.tip) r.addTip(data.tip)
  if (data.metadata ?? data.meta) r.addMetadata(data.metadata ?? data.meta)
  if (data.footer) r.addFOAText(data.footer)
  if (data.rawSections) r.addRawSections(data.rawSections, data.rawSubmessages)
  return r.send(jid, opts)
}

const stripDevice = jid => String(jid || '').replace(/:\d+$/, '')

const collectMetaAIBotJids = async (sock, jid, botUser) => {
  const candidates = new Set([botUser])
  if (!isJidGroup(jid)) return candidates
  const botNumber = jidNormalizedUser(botUser).split('@')[0]
  try {
    const meta = await sock.groupMetadata(jid)
    for (const p of meta.participants || []) {
      const idNum = jidNormalizedUser(p.id).split('@')[0]
      const pnNum = p.phoneNumber ? jidNormalizedUser(p.phoneNumber).split('@')[0] : undefined
      if (pnNum === botNumber || idNum === botNumber || isJidMetaAI(p.id)) candidates.add(p.id)
    }
  } catch { }
  return candidates
}

const isMetaAIResponse = (msg, chatJid, promptId, botJids) => {
  if (!msg?.key || msg.key.fromMe || msg.key.remoteJid !== chatJid) return false
  const sender = stripDevice(msg.key.participant || msg.key.remoteJid)
  if (isJidMetaAI(sender)) return true
  for (const b of botJids) if (jidNormalizedUser(stripDevice(b)) === jidNormalizedUser(sender)) return true
  if (promptId) { const inner = msg.message ? Object.values(msg.message)[0] : undefined; const stanzaId = inner?.contextInfo?.stanzaId || msg.message?.contextInfo?.stanzaId; if (stanzaId === promptId) return true }
  return false
}

const q = quoted => quoted ? { quoted } : {}

// ─── attachAIRich ─────────────────────────────────────────────────────────────
// Attaches all AIRich, meta, bot, and relay methods to result, then returns the
// fuzzy-proxy-wrapped result. This is the only export nexus-handler.js needs.
export function attachAIRich(result, config) {
  const sock = result

  const relayRichMessage = async (jid, fullMsg, options = {}) => {
    const relayOpts = { messageId: fullMsg.key.id, useCachedGroupMetadata: options.useCachedGroupMetadata, statusJidList: options.statusJidList, ...(options.relayOptions || {}) }
    await sock.relayMessage(jid, fullMsg.message, relayOpts)
    const hasRich = !!fullMsg.message?.botForwardedMessage?.message?.richResponseMessage || !!fullMsg.message?.interactiveMessage?.bloksWidget
    if (options.renderRichResponse !== false && (hasRich || options.forceRichEdit)) {
      const editContent = proto.Message.fromObject({ botForwardedMessage: { message: { protocolMessage: { key: { remoteJid: jid, fromMe: true, id: fullMsg.key.id }, type: proto.Message.ProtocolMessage.Type.MESSAGE_EDIT, editedMessage: fullMsg.message } } } })
      const editMsg = generateWAMessageFromContent(jid, editContent, { userJid: sock.user?.id, messageId: generateMessageIDV2(sock.user?.id || jid) })
      await sock.relayMessage(jid, editMsg.message, { ...relayOpts, messageId: editMsg.key.id })
    }
    return fullMsg
  }

  result.relayRichMessage = relayRichMessage
  result.airich = opts => new AIRich(result, opts)

  result.captureAiRich = msg => {
    const rich = msg?.botForwardedMessage?.message?.richResponseMessage ?? msg?.richResponseMessage
    if (!rich?.unifiedResponse?.data) return null
    return { submessages: rich.submessages ?? [], sections: JSON.parse(Buffer.from(rich.unifiedResponse.data, 'base64').toString()), contextInfo: rich.contextInfo ?? {}, messageType: rich.messageType ?? 1 }
  }

  result.relayAiRich = (jid, captured, opts = {}) => {
    const r = new AIRich(result)
    if (captured.sections?.response_id) r.setResponseId(captured.sections.response_id)
    return r.loadFrom({ botForwardedMessage: { message: { richResponseMessage: { submessages: captured.submessages, unifiedResponse: { data: Buffer.from(JSON.stringify(captured.sections)) }, contextInfo: captured.contextInfo, messageType: captured.messageType } } } }).send(jid, opts)
  }

  result.sendRichFromObject = (jid, data, opts = {}) => aiRichFromObject(result, jid, data, opts)
  result.sendRichMessage = (jid, data, quoted, opts = {}) => result.sendMessage(jid, { aiRich: data }, { ...q(quoted), ...opts })
  result.sendCodeBlock = (jid, code, quoted, opts = {}) => result.sendMessage(jid, { aiRich: { code, language: opts.language ?? 'javascript', title: opts.title } }, q(quoted))
  result.sendCodeBlockV2 = (jid, code, quoted, opts = {}) => result.sendMessage(jid, { aiRich: { text: opts.text, code, language: opts.language ?? '', title: opts.title } }, q(quoted))
  result.sendTable = (jid, title, headers, rows, quoted, opts = {}) => result.sendMessage(jid, { aiRich: { title, table: [headers, ...rows] } }, q(quoted))
  result.sendTableV2 = (jid, tableArray, quoted, opts = {}) => result.sendMessage(jid, { aiRich: { text: opts.text, title: opts.headerText, table: tableArray } }, q(quoted))
  result.sendList = (jid, title, items, quoted, opts = {}) => result.sendMessage(jid, { aiRich: { title, table: [['Key', 'Value'], ...items] } }, q(quoted))
  result.sendLink = (jid, text, links, quoted, opts = {}) => result.sendMessage(jid, { aiRich: { title: opts.headerText, text, sources: links.map(url => ({ url, title: url, subtitle: new URL(url).hostname })) } }, q(quoted))
  result.sendLinkV2 = (jid, text, links, quoted, opts = {}) => result.sendMessage(jid, { aiRich: { title: opts.headerText, text, sources: links } }, q(quoted))
  result.sendLatex = (jid, expressions, quoted, opts = {}) => result.sendMessage(jid, { aiRich: { text: opts.text, title: opts.headerText, latex: expressions } }, q(quoted))
  result.sendRichTable = async (jid, title, headers, rows, quoted, opts = {}) => { const { message, messageId } = generateTableContent(title, headers, rows, quoted, opts); return relayRichMessage(jid, generateWAMessageFromContent(jid, message, { userJid: sock.user?.id, messageId: opts.messageId || messageId }), opts) }
  result.sendRichList = async (jid, title, items, quoted, opts = {}) => { const { message, messageId } = generateListContent(title, items, quoted, opts); return relayRichMessage(jid, generateWAMessageFromContent(jid, message, { userJid: sock.user?.id, messageId: opts.messageId || messageId }), opts) }
  result.sendRichCode = async (jid, code, quoted, opts = {}) => { const { message, messageId } = generateCodeBlockContent(code, quoted, opts); return relayRichMessage(jid, generateWAMessageFromContent(jid, message, { userJid: sock.user?.id, messageId: opts.messageId || messageId }), opts) }
  result.sendRichLatex = async (jid, quoted, opts = {}) => { const { message, messageId } = generateLatexContent(quoted, { expressions: [], ...opts }); return relayRichMessage(jid, generateWAMessageFromContent(jid, message, { userJid: sock.user?.id, messageId: opts.messageId || messageId }), opts) }
  result.sendRichLatexImage = async (jid, opts = {}) => {
    const { text, expressions = [], headerText, footer } = opts
    const rendered = expressions.map(expr => { const latex = expr.latexExpression || expr.expression || expr; const url = `https://latex.codecogs.com/png.latex?${encodeURIComponent(latex).replace(/'/g, '%27')}`; return { latexExpression: latex, url, width: expr.width || 400, height: expr.height || 100 } })
    const { message, messageId } = generateLatexContent(null, { text, expressions: rendered, headerText, footer })
    return relayRichMessage(jid, generateWAMessageFromContent(jid, message, { userJid: sock.user?.id, messageId: opts.messageId || messageId }), opts)
  }
  result.captureAndResendRichResponse = async (jid, metaAiMsg, quoted, opts = {}) => {
    const captured = captureUnifiedResponse(metaAiMsg)
    if (!captured) throw new Error('captureAndResendRichResponse: no unifiedResponse data in message')
    const { message, messageId } = generateUnifiedResponseContent(quoted, captured)
    return relayRichMessage(jid, generateWAMessageFromContent(jid, message, { userJid: sock.user?.id, messageId: opts.messageId || messageId }), opts)
  }
  result.sendBotPlanning = async (jid, content = {}, opts = {}) => {
    const { text = 'Execution plan', steps = [], queryPlan = true, botJid = META_AI_BOT_JID } = content
    const submessages = [{ messageType: proto.AIRichResponseSubMessageType.AI_RICH_RESPONSE_TEXT, messageText: text }, ...steps.map(s => ({ messageType: proto.AIRichResponseSubMessageType.AI_RICH_RESPONSE_TEXT, messageText: typeof s === 'string' ? s : `${s.title || s.name || 'Step'}${s.body ? `: ${s.body}` : ''}` }))]
    const wrapped = buildBotRichResponse({ botJid, submessages, capabilities: [BotCapabilityType.AGENTIC_PLANNING, ...(queryPlan ? [BotCapabilityType.QUERY_PLAN] : [])] })
    const full = await generateWAMessageFromContent(jid, wrapped, { userJid: sock.user?.id, messageId: opts.messageId || generateMessageIDV2(sock.user?.id) })
    return relayRichMessage(jid, full, opts)
  }
  result.sendBotPlan = async (jid, content = {}, opts = {}) => {
    const { text = 'Execution plan', title = 'Execution plan', steps = [], estimatedCompletionTime, botJid = META_AI_BOT_JID } = content
    if (!Array.isArray(steps) || steps.length === 0) throw new Error('sendBotPlan requires at least one step')
    const statusEnum = proto.BotProgressIndicatorMetadata.BotPlanningStepMetadata.PlanningStepStatus
    const normalizedSteps = steps.map((s, i) => ({ statusTitle: String(s.title || s.name || `Step ${i + 1}`), statusBody: String(s.body || s.description || ''), status: s.status === 'executing' ? statusEnum.EXECUTING : (s.status === 'finished' || s.status === 'completed') ? statusEnum.FINISHED : statusEnum.PLANNED, isReasoning: s.isReasoning === true, isEnhancedSearch: s.isEnhancedSearch === true }))
    const wrapped = { messageContextInfo: { botMetadata: { capabilityMetadata: { capabilities: [proto.BotCapabilityMetadata.BotCapabilityType.AGENTIC_PLANNING, proto.BotCapabilityMetadata.BotCapabilityType.QUERY_PLAN] }, progressIndicatorMetadata: { progressDescription: title, stepsMetadata: normalizedSteps, ...(estimatedCompletionTime ? { estimatedCompletionTime } : {}) } } }, botForwardedMessage: { message: { richResponseMessage: { messageType: 1, submessages: [{ messageType: 2, messageText: text }], contextInfo: { isForwarded: true, forwardingScore: 1, forwardedAiBotMessageInfo: { botJid }, forwardOrigin: 4 } } } } }
    const full = await generateWAMessageFromContent(jid, wrapped, { userJid: sock.user?.id, messageId: opts.messageId || generateMessageIDV2(sock.user?.id) })
    await sock.relayMessage(jid, full.message, { messageId: full.key.id })
    return full
  }
  result.replayPlanning = (jid, steps, finalContent, opts) => replayPlanning(result, jid, steps, finalContent, opts)
  result.replayPlanningOnly = (jid, steps, opts) => replayPlanningOnly(result, jid, steps, opts)
  result.metaTyping = (jid, opts) => metaTyping(result, jid, opts)
  result.sendMetaComposited = (jid, content, opts) => sendMetaComposited(result, jid, content, opts)
  result.buildReasoningSteps = buildReasoningSteps
  result.buildSearchSteps = buildSearchSteps
  result.mixedSteps = mixedSteps
  result.buildSteps = buildSteps
  result.PlanningStepStatus = PlanningStepStatus
  result.sendMetaAI = async (a, b, c = {}) => {
    let text, opts = c, yourJid
    if (typeof b === 'string') { text = b; yourJid = a } else { text = a; opts = b || {}; yourJid = opts.yourJid || '' }
    const jid = opts.jid || META_AI_BOT_JID
    const threadId = opts.threadId || generateMessageIDV2(yourJid)
    const now = Date.now()
    const senderKeyHash = opts.senderKeyHash || randomBytes(8).toString('base64')
    const message = {
      extendedTextMessage: proto.Message.ExtendedTextMessage.fromObject({ text, previewType: 'NONE', contextInfo: proto.ContextInfo.fromObject({ botMessageSharingInfo: { botEntryPointOrigin: 'FAVICON', forwardScore: 0 } }), inviteLinkGroupTypeV2: 'DEFAULT' }),
      messageContextInfo: proto.MessageContextInfo.fromObject({ deviceListMetadata: { senderKeyHash, senderTimestamp: opts.senderTimestamp || String(Math.floor(now / 1000)) }, deviceListMetadataVersion: 2, messageSecret: opts.messageSecret || randomBytes(32), botMetadata: { botModeSelectionMetadata: { overrideMode: [0] }, botThreadInfo: { serverInfo: { title: text.substring(0, 50) }, clientInfo: { type: 'DEFAULT' } }, botRenderingConfigMetadata: { bloksVersioningId: '1eb86e6f4117d052e6bab62fe758a2e2af43747b85c5c1a886c8262bac462ea4', pixelDensity: 2.625 }, ...(opts.conversationContext?.length ? { aiConversationContext: opts.conversationContext } : {}) }, threadId: [{ threadType: 'AI_THREAD', threadKey: { remoteJid: '0002@s.whatsapp.net', fromMe: true, id: threadId } }] })
    }
    const msgId = generateMessageIDV2(yourJid)
    await sock.relayMessage(jid, message, { messageId: msgId, ...(opts.quoted ? { quoted: opts.quoted } : {}) })
    return msgId
  }
  result.aiPrompt = async (jid, prompt, options = {}) => {
    const { timeout = 60_000, onPartial, botUser = META_AI_BOT_JID, mentions = [], ...sendOpts } = options
    if (!jid || typeof prompt !== 'string' || !prompt.trim()) throw new Error('aiPrompt requires a chat JID and a non-empty prompt')
    const botJids = await collectMetaAIBotJids(result, jid, botUser)
    const allMentions = [...new Set([...mentions, ...botJids])]
    return new Promise((resolve, reject) => {
      let promptId, settled = false
      const cleanup = () => { clearTimeout(timer); sock.ev.off('messages.upsert', onUpsert); if (onPartial) sock.ev.off('messages.update', onUpdate) }
      const settle = (fn, val) => { if (settled) return; settled = true; cleanup(); fn(val) }
      const timer = setTimeout(() => settle(reject, new Error(`aiPrompt timed out after ${timeout}ms in ${jid}`)), timeout)
      const onUpsert = ({ messages }) => { for (const msg of messages) if (isMetaAIResponse(msg, jid, promptId, botJids)) { settle(resolve, msg); return } }
      const onUpdate = ({ updates }) => { if (!onPartial) return; for (const u of updates) { if (!u.key || u.key.fromMe || u.key.remoteJid !== jid) continue; const sender = jidNormalizedUser(stripDevice(u.key.participant || u.key.remoteJid)); const isBot = isJidMetaAI(sender) || [...botJids].some(b => jidNormalizedUser(stripDevice(b)) === sender); if (isBot && u.message) onPartial(u.message, u.key) } }
      sock.ev.on('messages.upsert', onUpsert)
      if (onPartial) sock.ev.on('messages.update', onUpdate)
        ; (async () => {
          try {
            const content = { text: prompt, ...(isJidGroup(jid) ? { mentions: allMentions } : {}), ...sendOpts }
            const full = await generateWAMessage(jid, content, { userJid: sock.user?.id, messageId: sendOpts.messageId || generateMessageIDV2(sock.user?.id) })
            await sock.relayMessage(jid, full.message, { messageId: full.key.id })
            if (config.emitOwnEvents) process.nextTick(() => sock.ev.emit('messages.upsert', { messages: [full], type: 'append' }))
            promptId = full.key.id
          } catch (err) { settle(reject, err) }
        })()
    })
  }
  result.sendAsMimic = async (jid, content, mimicJid, options = {}) => {
    if (!options.admin && !options.mimicPermission) throw new Error('sendAsMimic requires admin: true')
    const msgId = generateMessageIDV2(sock.user?.id)
    const full = await generateWAMessageFromContent(jid, content, { userJid: sock.user?.id, ...options })
    full.key = { remoteJid: jid, fromMe: false, id: msgId, participant: mimicJid }
    await sock.relayMessage(jid, full.message, { messageId: msgId, ...(options.additionalAttributes ? { additionalAttributes: options.additionalAttributes } : {}) })
    return full
  }
  result.sendStatus = async (content, options = {}) => {
    const provided = options.statusJidList || content?.statusJidList || sock.statusJidList || []
    if (!provided.length) throw new Error('sendStatus requires statusJidList')
    return result.sendMessage(STATUS_JID, { ...content, status: true }, { ...options, broadcast: true, statusJidList: provided })
  }
  result.sendBotToolResult = async (jid, content = {}, opts = {}) => {
    const { text = 'Tool result', toolCallId = `tool-${Date.now()}`, resolutionData, resolutionDataSerialized, botJid = META_AI_BOT_JID } = content
    const wrapped = buildBotRichResponse({ text, botJid, capabilities: [BotCapabilityType.AGENTIC_PLANNING, BotCapabilityType.QUERY_PLAN], botMetadata: { resolvedToolCallMetadata: { toolCallId, resolutionDataSerialized: resolutionDataSerialized ?? JSON.stringify(resolutionData ?? {}) } } })
    const full = await generateWAMessageFromContent(jid, wrapped, { userJid: sock.user?.id, messageId: opts.messageId || generateMessageIDV2(sock.user?.id) })
    return relayRichMessage(jid, full, opts)
  }
  result.sendWhatsAppFlow = async (jid, flow, options = {}) => {
    const { text, footer, image, caption, ...flowOpts } = flow || {}
    const btn = makeWhatsAppFlowButton(flowOpts)
    const content = image ? { image, caption: caption || text || flowOpts.cta } : { text: text || flowOpts.cta || '' }
    return result.sendMessage(jid, { ...content, ...(footer ? { footer } : {}), nativeFlow: [btn] }, options)
  }
  result.sendRichMap = (jid, mapOpts, options = {}) => { const r = new AIRich(result); r.addRichMap(mapOpts); return r.send(jid, options) }
  result.sendDynamic = (jid, dynOpts, options = {}) => { const r = new AIRich(result); r.addDynamic(dynOpts); return r.send(jid, options) }
  result.sendBotPromptSuggestions = (jid, content = {}, options = {}) => { const { text, suggestions = [] } = content; const r = new AIRich(result); if (text) r.addText(text); r.addSuggestPrompts(suggestions, content); return r.send(jid, options) }
  result.sendBotSources = (jid, content = {}, options = {}) => { const { text, sources = [] } = content; const r = new AIRich(result); if (text) r.addText(text); r.addSources(sources); return r.send(jid, options) }
  result.sendBotPttTranscript = (jid, content = {}, options = {}) => { const { text, transcript } = content; const r = new AIRich(result); if (text) r.addText(text); r.addPttTranscript(transcript); return r.send(jid, options) }
  result.sendInstagramProfile = (jid, data, options = {}) => { const r = new AIRich(result); r.addInstagramProfile(data); return r.send(jid, options) }
  result.sendRichGeneration = async (jid, opts = {}) => { const { message, responseId, itemId } = prepareRichGenerationMessage(opts); const full = await generateWAMessageFromContent(jid, message, { userJid: sock.user?.id, messageId: opts.messageId || generateMessageIDV2(sock.user?.id) }); await sock.relayMessage(jid, full.message, { messageId: full.key.id }); return { msg: full, responseId, itemId } }
  result.sendUnifiedResponse = (jid, sections, submessages = [], options = {}) => { const r = new AIRich(result); r.addRawSections(sections, submessages); return r.send(jid, options) }
  result.sendRichButtonGrid = async (jid, grid, options = {}) => {
    const { text, footer, cards = [] } = grid || {}
    if (!Array.isArray(cards) || cards.length === 0) throw new Error('sendRichButtonGrid expects at least one card')
    return result.sendMessage(jid, { ...(text ? { text } : {}), ...(footer ? { footer } : {}), cards }, options)
  }

  const normalize = s => s.toLowerCase().replace(/[^a-z]/g, '')
  const knownKeys = Object.keys(result).filter(k => typeof result[k] === 'function')
  const normalizedMap = new Map(knownKeys.map(k => [normalize(k), k]))

  return new Proxy(result, {
    get(target, prop, receiver) {
      if (prop in target) return Reflect.get(target, prop, receiver)
      if (typeof prop !== 'string') return undefined
      const match = normalizedMap.get(normalize(prop))
      if (match) { target.logger?.warn?.(`[NexusHandler] Unknown method "${prop}" — did you mean "${match}"? Calling it.`); return target[match] }
      return undefined
    }
  })
}