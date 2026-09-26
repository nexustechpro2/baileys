import crypto from 'crypto'
import {
  generateMessageIDV2,
  generateVerificationMetadata,
  waitAllPromises,
  extractIE,
  tokenizeCode,
  generateWAMessageFromContent,
} from '../Utils/index.js'
import { BOT_RENDERING_CONFIG_METADATA } from '../Defaults/index.js'

const DEFAULT_BOT_JID = '867051314767696@bot'
const BIZ_BOT_SUPPORT = '{"version":1,"is_ai_message":true,"should_upload_client_logs":false,"should_show_system_message":false,"ticket_id":"7004947587700716","citation_items":[],"ticket_locale":"us"}'

// ─── Layout wrappers ──────────────────────────────────────────────────────────
const mkSection = vm => ({ __typename: 'GenAIUnifiedResponseSection', view_model: vm })
const single = p => mkSection({ __typename: 'GenAISingleLayoutViewModel', primitive: p })
const vstack = ps => mkSection({ __typename: 'GenAIVStackLayoutViewModel', primitives: ps })
const hscroll = ps => mkSection({ __typename: 'GenAIHScrollLayoutViewModel', primitives: ps })
const grid = ps => mkSection({ __typename: 'GenAIGridLayoutViewModel', primitives: ps })
const actionRow = ps => ({ view_model: { __typename: 'GenAIActionRowLayoutViewModel', primitives: ps } })
const addonAction = (type, ps, alignment = 'END') => mkSection({
  __typename: 'GenAIAddonActionLayoutViewModel',
  addon_action_type: type,
  addon_action_alignment: alignment,
  primitives: ps,
})

// ─── Primitive builders ───────────────────────────────────────────────────────
const mkMarkdown = (text, entities = []) => {
  const { text: t, inline_entities } = extractIE(text, entities)
  return { __typename: 'GenAIMarkdownTextUXPrimitive', text: t, inline_entities }
}

const mkCode = (content, language = '', unified_codeBlock = []) => ({
  __typename: 'GenAICodeUXPrimitive',
  language,
  code_blocks: unified_codeBlock.length ? unified_codeBlock : [{ content }],
})

/**
 * Table row format:
 *   Array form:  [['Header1','Header2'], ['Cell1','Cell2'], ...]
 *   Object form: [{ cells: ['H1','H2'], is_header: true }, ...]
 *
 * Each cell can be a plain string or { text, markdown_text }.
 * First row is treated as header automatically in array form.
 */
const mkTable = (rows, title = '') => {
  const normalized = Array.isArray(rows[0])
    ? rows.map((r, i) => ({
      is_header: i === 0,
      cells: r.map(c => (typeof c === 'string' ? c : String(c))),
      markdown_cells: r.map(c => ({ text: typeof c === 'string' ? c : String(c) })),
    }))
    : rows.map(r => ({
      is_header: !!r.is_header,
      cells: (r.cells ?? r.items ?? []).map(c => (typeof c === 'string' ? c : String(c))),
      markdown_cells: (r.cells ?? r.items ?? []).map(c => ({ text: typeof c === 'string' ? c : String(c) })),
    }))
  return { __typename: 'GenATableUXPrimitive', title, rows: normalized }
}

/**
 * Image primitive with full dark-mode + fallback URL resolution.
 * Accepts: { url, previewUrl, highResUrl, darkModePreviewUrl, darkModeHighResUrl,
 *            width, height, mimeType, expiration }
 * Or just a plain URL string.
 */
const mkImage = (input, expiration) => {
  const img = typeof input === 'string' ? { url: input } : input
  const exp = expiration ?? String(Date.now() + 30 * 24 * 60 * 60 * 1000)
  const first = (...vals) => vals.find(v => v != null && String(v).length > 0)
  const previewUrl = first(img.previewUrl, img.preview_url, img.imagePreviewUrl, img.url) ?? ''
  const fullUrl = first(img.highResUrl, img.high_res_url, img.imageHighResUrl, img.fullUrl, img.full_url, img.url, previewUrl)
  const darkPreview = first(img.darkModePreviewUrl, img.dark_mode_preview_url, previewUrl)
  const darkFull = first(img.darkModeHighResUrl, img.dark_mode_high_res_url, darkPreview)
  const mime = img.mimeType ?? img.mime_type ?? (/\.png$/i.test(img.url ?? '') ? 'image/png' : 'image/jpeg')
  const w = Number(img.width ?? 600)
  const h = Number(img.height ?? 400)
  const media = (url, mw, mh) => ({ url, url_fallback: url, mime_type: mime, expiration_timestamp_ms: exp, width: mw, height: mh })
  return {
    __typename: 'GenAIImagePrimitive',
    preview_image: media(previewUrl, w, h),
    full_image: media(fullUrl, w, h),
    dark_mode_preview_image: media(darkPreview, w, h),
    dark_mode_full_image: media(darkFull, w, h),
    asset_query_status: 'FETCHED',
  }
}

const mkVideo = url => ({
  __typename: 'GenAIVideoPrimitive',
  media: { __typename: 'GenAIMediaItem', mime_type: 'video/mp4', url },
})

/**
 * Imagine primitive — used for AI generation states (GENERATING → READY).
 * mediaType: 'image' | 'video'
 * status: 'GENERATING' | 'READY' | 'ERROR'
 * estimatedMs: optional ms from now for completion ETA
 */
const mkImagine = ({ mediaType = 'video', url = '', thumbnail, mimeType, fileLength = 0, duration = 0, status = 'GENERATING', estimatedMs, imagineType } = {}) => {
  const type = String(mediaType).toLowerCase() === 'image' ? 'IMAGE' : 'ANIMATE'
  const prim = {
    __typename: 'GenAIImaginePrimitive',
    media: {
      url: url ?? '',
      mime_type: mimeType ?? (type === 'IMAGE' ? 'image/jpeg' : 'video/mp4'),
      file_length: fileLength ?? 0,
      duration: duration ?? 0,
    },
    imagine_type: imagineType ?? type,
    status: { status: String(status).toUpperCase() },
  }
  if (estimatedMs != null) prim.status.estimated_completion_time = Math.floor((Date.now() + Number(estimatedMs)) / 1000)
  if (thumbnail) prim.thumbnail = { raw_media: thumbnail }
  return prim
}

const mkReel = ({ creator, avatar_url, thumbnail_url, reels_url, title, likes_count, shares_count, view_count, reel_source, is_verified }) => ({
  __typename: 'GenAIReelPrimitive',
  creator: creator ?? '',
  avatar_url: avatar_url ?? '',
  thumbnail_url: thumbnail_url ?? '',
  reels_url: reels_url ?? '',
  reels_title: title ?? '',
  likes_count: likes_count ?? 0,
  shares_count: shares_count ?? 0,
  view_count: view_count ?? 0,
  reel_source: reel_source ?? 'IG',
  is_verified: !!is_verified,
})

const mkPost = d => ({
  __typename: 'GenAIPostPrimitive',
  title: d.title ?? '',
  username: d.username ?? '',
  subtitle: d.subtitle ?? '',
  thumbnail_url: d.thumbnail_url ?? '',
  post_url: d.post_url ?? d.url ?? '',
  post_caption: d.post_caption ?? d.caption ?? '',
  post_type: d.post_type ?? 'photo',
  source_app: d.source_app ?? 'instagram',
  likes_count: d.likes_count ?? 0,
  comments_count: d.comments_count ?? 0,
  shares_count: d.shares_count ?? 0,
  is_verified: d.is_verified ?? false,
  is_carousel: d.is_carousel ?? false,
  orientation: d.orientation ?? 'portrait',
  profile_picture_url: d.profile_picture_url ?? null,
  footer_label: d.footer_label ?? null,
  footer_icon: d.footer_icon ?? null,
  additional_images: d.additional_images ?? [],
})

const mkProduct = d => ({
  __typename: 'GenAIProductItemCardPrimitive',
  title: d.title ?? '',
  brand: d.brand ?? '',
  price: d.price ?? '',
  sale_price: d.sale_price ?? null,
  product_url: d.product_url ?? d.url ?? '',
  image: { url: d.image_url ?? d.image ?? '' },
  additional_images: [],
})

const mkSearchResult = d => ({
  __typename: 'GenAISearchResultPrimitive',
  source_url: d.url ?? d.source_url ?? '',
  source_display_name: d.title ?? d.source_display_name ?? '',
  source_type: d.source_type ?? 'web',
  source_subtitle: d.subtitle ?? d.source_subtitle ?? '',
  favicon: d.favicon ?? null,
})

const mkMap = ({ latitude, longitude, name = '', address = '' }) => ({
  __typename: 'GenAIMapPrimitive', latitude, longitude, name, address,
})

/**
 * Widget (CTA menu) primitive.
 * ctas: [{ label, id?, kind?, toast? }]
 * title: widget header title
 */
const mkWidget = (ctas, title = '') => ({
  __typename: 'GenAI3PExtWidgetPrimitive',
  header: { __typename: 'GenAI3PExtWidgetStandardHeader', title },
  body: {
    __typename: 'GenAI3PExtCalendarEventList',
    ctas: ctas.map(c => ({
      __typename: 'GenAI3PExtWidgetCTA',
      label: c.label,
      state: 'PENDING',
      kind: c.kind ?? 'OTHER',
      tool_call_id: c.tool_call_id ?? c.id ?? crypto.randomBytes(8).toString('hex'),
      toast: { __typename: 'GenAI3PExtWidgetToast', label: c.toast ?? '' },
    })),
    sections: [],
  },
})

const mkFooterAction = d => ({
  __typename: 'GenAIFooterActionPrimitive',
  cta_text: d.cta_text ?? d.text ?? '',
  cta_type: d.cta_type ?? 'OPEN_URL',
  cta_url: d.cta_url ?? d.url ?? '',
})

/**
 * Social/entity profile card.
 * Used for Instagram/Twitter/etc profile results.
 * entityType: 'IG_PROFILE' | 'SOCIAL_PROFILE' | 'WEBSITE' etc.
 * platform: 'INSTAGRAM' | 'TWITTER' | 'GENERIC' etc.
 */
const mkSocialProfile = ({
  username = '', platform = 'GENERIC', title = '', subtitle = '',
  imageUrl = '', entityId, entityUrl, entityType, fullName = '',
  isVerified = false, resultText = 'See results',
}) => {
  const normalizedPlatform = String(platform).toUpperCase()
  const profileUrl = entityUrl ?? (username ? `https://www.${platform.toLowerCase()}.com/${encodeURIComponent(username)}` : '')
  const resolvedType = entityType ?? (normalizedPlatform === 'INSTAGRAM' ? 'IG_PROFILE' : 'SOCIAL_PROFILE')
  const image = imageUrl ? { url: imageUrl, mime_type: 'image/png' } : undefined
  return [
    {
      view_model: {
        primitives: [{
          __typename: 'GenAICompactEntityPrimitive',
          title,
          subtitle,
          ...(image ? { image } : {}),
          entity_id: String(entityId ?? username ?? ''),
          entity_url: profileUrl,
          entity_type: 'WEBSITE',
          action_type: 'OPEN_URL',
          is_verified: !!isVerified,
        }],
        __typename: 'GenAIActionRowLayoutViewModel',
      },
    },
    {
      view_model: {
        primitives: [{ type: 'HORIZONTAL_LINE', __typename: 'GenAIDividerPrimitive' }],
        __typename: 'GenAIVStackLayoutViewModel',
      },
    },
    {
      view_model: {
        primitives: [
          { __typename: 'GenAISpacerPrimitive' },
          {
            __typename: 'GenAIMarkdownTextUXPrimitive',
            text: `# {{social_entity_1}}${resultText}\0{{/social_entity_1}}    `,
            inline_entities: [{
              key: 'social_entity_1',
              metadata: {
                __typename: 'GenAISocialEntityItem',
                entity_id: String(entityId ?? username ?? ''),
                entity_name: username,
                entity_full_name: fullName,
                platform: normalizedPlatform,
                entity_picture_url: imageUrl,
                entity_url: profileUrl,
                entity_type: resolvedType,
                is_verified: !!isVerified,
              },
            }],
          },
          { __typename: 'GenAISpacerPrimitive' },
        ],
        __typename: 'GenAIActionRowLayoutViewModel',
      },
    },
  ]
}

/**
 * Inline image primitive (uses latex wrapper trick to embed image inline in text flow).
 * alignment: 'center' | 'left' | 'right'
 */
const mkInlineImage = (url, alignment = 'center') => ({
  __typename: 'GenAIInlineImageUXPrimitive',
  image: { __typename: 'GenAIMediaItem', mime_type: 'image/jpeg', url },
  alignment,
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
    font_height: fontHeight,
    padding,
    latex_image: {
      __typename: 'GenAIMediaItem',
      mime_type: 'image/png',
      url: imageUrl,
      url_fallback: imageUrl,
      width,
      height,
      expiration_timestamp_ms: Date.now() + 86400000,
    },
  },
})
const mkPill = prompt_text => ({ __typename: 'GenAIFollowUpSuggestionPillPrimitive', prompt_text })

/**
 * HTML primitive — renders raw HTML inside the chat bubble.
 * NOTE: This is FOAHtmlPrimitiveDemoDONOTUSE — experimental, works on Meta AI clients.
 * trustedSources: array of allowed origin URLs
 */
const mkHtml = (html, trustedSources = []) => ({
  __typename: 'FOAHtmlPrimitiveDemoDONOTUSE',
  trusted_sources: trustedSources,
  payload: String(html).trim(),
})

/**
 * Rich HTML primitive — for embedded tab screens.
 * Used internally by addRichHtml; not a standalone section.
 */
const mkRichHtml = (html, url = '', trustedSources = []) => ({
  __typename: 'GenAIaeacdsnwHtmlPrimitive',
  payload: String(html).trim(),
  url,
  trusted_sources: trustedSources,
})

// ─── Shared botMetadata wrapper ──────────────────────────────────────────────
// Used internally by build() and exported for callers that need the wrapper shape
// without the full AIRich builder chain.
export const buildBotMessageWrapper = (verificationMetadata) => ({
  messageContextInfo: {
    botMetadata: {
      pluginMetadata: {},
      ...(verificationMetadata?.proofs?.length ? { verificationMetadata } : {}),
      botRenderingConfigMetadata: BOT_RENDERING_CONFIG_METADATA,
    },
  },
})

// ─── Build additional botMetadata from submessages (reel/latex media) ─────────
const buildAdditionalBotMetadata = (submessages) => {
  const sources = []
  const mediaDetailsMetadataList = []
  for (const sub of submessages) {
    if (sub?.contentItemsMetadata?.itemsMetadata) {
      for (const item of sub.contentItemsMetadata.itemsMetadata) {
        const r = item?.reelItem ?? item ?? {}
        sources.push({
          provider: 0,
          thumbnailCdnUrl: r.thumbnailUrl ?? r.thumbnail_url ?? '',
          sourceProviderUrl: r.videoUrl ?? r.reels_url ?? r.url ?? '',
          sourceQuery: '',
          faviconCdnUrl: r.profileIconUrl ?? r.avatar_url ?? '',
          citationNumber: sources.length + 1,
          sourceTitle: r.title ?? r.reels_title ?? r.creator ?? '',
        })
      }
    }
  }
  return { sources, mediaDetailsMetadataList }
}

// ─── AIRich class ─────────────────────────────────────────────────────────────
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

  // ─── Text & code ───────────────────────────────────────────────────────────

  addText(text, opts = {}) {
    const { text: t, inline_entities } = extractIE(text)
    return this.#add(single(mkMarkdown(t, inline_entities)), null, opts)
  }

  addCode(language, content, opts = {}) {
    const { codeBlocks, unified_codeBlock } = tokenizeCode(content, language)
    const submessage = { messageType: 5, codeMetadata: { codeLanguage: language, codeBlocks } }
    return this.#add(single(mkCode(content, language, unified_codeBlock)), submessage, opts)
  }

  // ─── Table ─────────────────────────────────────────────────────────────────

  /**
   * addTable(rows, title?, opts?)
   *
   * rows can be:
   *   - Array of arrays:  [['Col1','Col2'], ['A','B'], ['C','D']]
   *     → first row auto-becomes header
   *   - Array of objects: [{ cells: ['Col1','Col2'], is_header: true }, ...]
   *
   * cells can be plain strings or numbers (auto-converted).
   * title is optional, renders above the table.
   *
   * Example:
   *   r.addTable([['Name','Age'], ['Grace',21], ['Ada',207]], 'Users')
   */
  addTable(rows, title = '', opts = {}) {
    return this.#add(single(mkTable(rows, title)), null, opts)
  }

  // ─── Media ─────────────────────────────────────────────────────────────────

  /**
   * addImage(input, opts?)
   * input: URL string OR { url, previewUrl, highResUrl, darkModePreviewUrl, darkModeHighResUrl, width, height, mimeType }
   * Supports dark mode variants and proper fallback chain.
   */
  addImage(input, opts = {}) {
    return this.#add(single(mkImage(input)), null, opts)
  }

  addVideo(url, opts = {}) {
    return this.#add(single(mkVideo(url)), null, opts)
  }

  /**
   * addGrid(items, opts?)
   * items: array of URL strings or image objects (same format as addImage)
   * Renders as a native photo grid (GenAIGridLayoutViewModel).
   * Requires at least 2 items.
   *
   * Example:
   *   r.addGrid(['https://img1.jpg', 'https://img2.jpg', 'https://img3.jpg'])
   */
  addGrid(items, opts = {}) {
    if (!Array.isArray(items) || items.length < 2) throw new Error('addGrid requires at least 2 items')
    const prims = items.map(i => mkImage(i))
    return this.#add(grid(prims), null, opts)
  }

  /**
   * addVideoGrid(videos, opts?)
   * videos: array of URL strings or { url, thumbnailUrl, creator, likes, ... }
   * Renders as a video grid (GenAIGridLayoutViewModel with GenAIVideoPrimitive).
   * Requires at least 2 videos.
   *
   * Example:
   *   r.addVideoGrid([{ url: 'https://vid1.mp4', creator: 'Grace' }, ...])
   */
  addVideoGrid(videos, opts = {}) {
    if (!Array.isArray(videos) || videos.length < 2) throw new Error('addVideoGrid requires at least 2 videos')
    const prims = videos.map(v => {
      const url = typeof v === 'string' ? v : (v?.url ?? v?.videoUrl ?? '')
      const item = typeof v === 'string' ? {} : v
      return {
        __typename: 'GenAIVideoPrimitive',
        reels_url: url,
        reels_title: item.title,
        thumbnail_url: item.thumbnailUrl ?? item.thumbnail,
        creator: item.creator,
        avatar_url: item.avatarUrl,
        likes_count: item.likes,
        comments_count: item.comments,
        shares_count: item.shares,
        is_verified: item.isVerified,
        video_delivery_response: {
          progressive_urls: (item.progressiveUrls ?? []).map(u => ({ progressive_url: u, __typename: 'GenAIProgressiveUrlResponse' })),
          dash_manifests: (item.dashManifests ?? []).map(m => ({ manifest_xml: m, __typename: 'GenAIDashManifestResponse' })),
          __typename: 'GenAIVideoDeliveryResponse',
        },
      }
    })
    return this.#add(grid(prims), null, opts)
  }

  addReels(reels, opts = {}) {
    const prims = reels.map(mkReel)
    return this.#add(prims.length === 1 ? single(prims[0]) : hscroll(prims), null, opts)
  }

  /**
   * addImagine(opts)
   * Renders an AI generation card — shows a GENERATING spinner or READY media player.
   * opts: { mediaType, url, status, estimatedMs, thumbnail, mimeType, fileLength, duration }
   * mediaType: 'image' | 'video'
   * status: 'GENERATING' | 'READY' | 'ERROR'
   * estimatedMs: optional ms until completion (shows progress ETA)
   *
   * Typical flow:
   *   const msg = await r.addImagine({ mediaType: 'image', status: 'GENERATING', estimatedMs: 5000 }).send(jid)
   *   // later, edit with READY state:
   *   await new AIRich(sock).addImagine({ mediaType: 'image', url: 'https://...', status: 'READY' }).sendEdit(jid, msg.key.id)
   */
  addImagine(input = {}, opts = {}) {
    return this.#add(single(mkImagine(input)), null, opts)
  }

  addInlineImage(url, alignment = 'center', opts = {}) {
    return this.#add(single(mkInlineImage(url, alignment)), null, opts)
  }

  // ─── Rich HTML ─────────────────────────────────────────────────────────────

  /**
   * addHtml(html, trustedSources?, opts?)
   * Renders raw HTML/CSS/JS inside the chat bubble (experimental Meta AI feature).
   * trustedSources: array of allowed origin URLs for security policy
   *
   * Example:
   *   r.addHtml('<h1 style="color:red">Hello</h1><script>alert(1)</script>')
   */
  addHtml(html, trustedSources = [], opts = {}) {
    return this.#add(single(mkHtml(html, trustedSources)), null, opts)
  }

  /**
   * addRichHtml(tabs, title?, opts?)
   * Renders HTML in a tabbed embedded screen (GenAIaeacdsnwHtmlPrimitive).
   * tabs: [{ title, html, url?, trustedSources? }] OR a single HTML string (one tab)
   * title: screen header title
   *
   * Example:
   *   r.addRichHtml([
   *     { title: 'Dashboard', html: '<canvas id="c"></canvas><script>...</script>' },
   *     { title: 'Settings', html: '<form>...</form>' },
   *   ], 'My App')
   */
  addRichHtml(tabs, title = 'Preview', opts = {}) {
    const tabItems = typeof tabs === 'string'
      ? [{ title: 'HTML', html: tabs }]
      : Array.isArray(tabs) ? tabs : [tabs]
    const embeddedTabs = tabItems.map((tab, i) => ({
      id: tab.id ?? `tab_${i}`,
      tab_header: tab.title ?? tab.tab_header ?? `HTML ${i + 1}`,
      sections: [{
        __typename: 'GenAIUnifiedResponseSection',
        view_model: {
          __typename: 'GenAISingleLayoutViewModel',
          primitive: mkRichHtml(tab.html ?? '', tab.url ?? '', tab.trustedSources ?? []),
        },
      }],
      step_entries: [],
    }))
    const screen = {
      title,
      content: [{ __typename: 'FOAIDNixelButtonSheets', tabs: embeddedTabs }],
    }
    this.#embeddedScreens.push(screen)
    return this.#add(single(mkMarkdown(`> ${title}`)), null, opts)
  }

  // ─── Cards & interactions ──────────────────────────────────────────────────

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

  /**
   * addSocialProfile(opts)
   * Renders a social profile card (Instagram, Twitter, etc).
   * opts: { username, platform, title, subtitle, imageUrl, entityId, entityUrl, entityType,
   *         fullName, isVerified, resultText }
   *
   * Example:
   *   r.addSocialProfile({ username: 'grace', platform: 'INSTAGRAM', fullName: 'Grace O', isVerified: true })
   */
  addSocialProfile(data, opts = {}) {
    const sections = mkSocialProfile(data)
    for (const s of sections) this.#push(s, null, opts.id ? `${opts.id}_${this.#nodes.length}` : null)
    return this
  }

  /**
   * addCopyAction(text, label?, alignment?, opts?)
   * Renders a copy-to-clipboard button next to text.
   * alignment: 'END' | 'START' | 'CENTER'
   *
   * Example:
   *   r.addCopyAction('npm install @nexustechpro/baileys', 'Copy install command')
   */
  addCopyAction(text, label, alignment = 'END', opts = {}) {
    const displayText = label ?? text
    return this.#add(
      addonAction('COPY_TO_CLIPBOARD', [mkMarkdown(String(displayText))], alignment),
      null,
      opts
    )
  }

  /**
   * addAddonAction(type, primitives, alignment?, opts?)
   * Generic addon action layout for any GenAIAddonActionLayoutViewModel action type.
   * type: 'COPY_TO_CLIPBOARD' | any future action type
   */
  addAddonAction(type, primitives, alignment = 'END', opts = {}) {
    return this.#add(addonAction(type, primitives, alignment), null, opts)
  }

  // ─── Status & misc ─────────────────────────────────────────────────────────

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

  addSuggest(prompts, scroll = false, opts = {}) {
    const prims = prompts.map(p => mkPill(typeof p === 'string' ? p : (p.text ?? p)))
    return this.#add(scroll ? hscroll(prims) : actionRow(prims), null, opts)
  }

  addSection(section, opts = {}) {
    return this.#add(section, null, opts)
  }

  addEmbeddedScreen(screen) {
    this.#embeddedScreens.push(screen)
    return this
  }

  // ─── Load from existing message ────────────────────────────────────────────

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

  // ─── Build ─────────────────────────────────────────────────────────────────

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

    const verification = this.#signedVerificationMetadata ?? generateVerificationMetadata()
    const { sources, mediaDetailsMetadataList } = buildAdditionalBotMetadata(submessages)

    const message = {
      messageContextInfo: {
        deviceListMetadata: {},
        deviceListMetadataVersion: 2,
        supportPayload: BIZ_BOT_SUPPORT,
        botMetadata: {
          botResponseId: responseId,
          ...(this.#title ? { messageDisclaimerText: this.#title } : {}),
          verificationMetadata: verification,
          botRenderingConfigMetadata: BOT_RENDERING_CONFIG_METADATA,
          ...(sources.length ? { richResponseSourcesMetadata: { sources } } : {}),
          ...(mediaDetailsMetadataList.length ? { unifiedResponseMutation: { mediaDetailsMetadataList } } : {}),
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

  // ─── Send ──────────────────────────────────────────────────────────────────

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

// ─── Object shorthand ─────────────────────────────────────────────────────────
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

  if (data.table) r.addTable(data.table, data.tableTitle)
  else if (data.headers && data.rows) r.addTable([data.headers, ...data.rows], data.tableTitle)

  if (data.images) data.images.forEach(img => r.addImage(img.url ?? img))
  if (data.image) r.addImage(data.image.url ?? data.image)
  if (data.grid) r.addGrid(data.grid)
  if (data.videoGrid) r.addVideoGrid(data.videoGrid)
  if (data.reels) r.addReels(data.reels)
  if (data.imagine) r.addImagine(typeof data.imagine === 'object' ? data.imagine : { url: data.imagine })
  if (data.sources) r.addSource(data.sources)
  if (data.latex) {
    if (data.latexText) r.addText(data.latexText)
      ; (Array.isArray(data.latex) ? data.latex : [data.latex]).forEach(l => r.addLatex({
        expression: l.expression ?? l.latexExpression ?? '',
        imageUrl: l.url ?? l.imageUrl ?? '',
        width: l.width ?? 400,
        height: l.height ?? 200,
      }))
  }
  if (data.html) r.addHtml(data.html, data.trustedSources)
  if (data.richHtml) r.addRichHtml(data.richHtml, data.richHtmlTitle)
  if (data.copyText) r.addCopyAction(data.copyText, data.copyLabel, data.copyAlignment)
  if (data.social) r.addSocialProfile(data.social)
  if (data.suggest) r.addSuggest(data.suggest)
  if (data.tip) r.addTip(data.tip)
  if (data.metadata ?? data.meta) r.addMetadata(data.metadata ?? data.meta)
  if (data.footer) r.addFOAText(data.footer)

  return r.send(jid, opts)
}