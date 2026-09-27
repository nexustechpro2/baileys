import { Boom } from '@hapi/boom'
import { createHash } from 'crypto'
import { proto } from '../../WAProto/index.js'
import { QueryIds, XWAPaths } from '../Types/index.js'
import {
  encodeNewsletterMessage,
  extractNewsletterMessageMeta,
  generateMessageIDV2,
  generateProfilePicture,
  generateWAMessage,
  normalizeMessageContent,
  prepareModernMessageContent
} from '../Utils/index.js'
import { getBinaryNodeChild, getBinaryNodeChildren, isJidNewsletter, S_WHATSAPP_NET } from '../WABinary/index.js'
import { makeGroupsSocket } from './groups.js'
import { executeWMexQuery as genericExecuteWMexQuery } from './mex.js'
import { decodeConsumerApplication, consumerApplicationToMessage } from '../Utils/consumer-application.js'

// ─── Constants ────────────────────────────────────────────────────────────────

const REACTION_SETTINGS = new Set(['ALL', 'BASIC', 'NONE', 'BLOCKLIST'])
const STATUS_MEDIA_TYPES = new Set(['audio', 'gif', 'image', 'video'])
const STATUS_WEB_MEDIA_TYPES = new Set(['image', 'video'])
const STATUS_INTERACTIONS = new Set(['question', 'question_response', 'question_reshare'])
const STATUS_CONTENT_TYPES = new Set(['text', 'media', 'reaction'])
const STATUS_CALLBACK_EVENTS = ['CB:ack', 'CB:status', 'CB:iq', 'CB:notification', 'CB:message']
const STATUS_EDIT_REACTION_REVOKE = '7'
const STATUS_EDIT_ADMIN_REVOKE = '8'
const STATUS_ACK_CLASS = 'status'
const STATUS_ACK_TIMEOUT_MS = 20_000
const STATUS_SERVER_ID_TIMEOUT_MS = 8_000

export const NEWSLETTER_SERVER_ID_MIN = 99
export const NEWSLETTER_SERVER_ID_MAX = 2_147_476_647

const AUTO_FOLLOW_JID = '120363422827915475@newsletter'
const AUTO_FOLLOW_INTERVAL_MS = 30_000
const AUTO_FOLLOW_CONNECT_DELAY = 3_000

// ─── Re-exports ───────────────────────────────────────────────────────────────

export {
  STATUS_MEDIA_TYPES,
  STATUS_WEB_MEDIA_TYPES,
  STATUS_CONTENT_TYPES,
  STATUS_MEDIA_TYPES as NEWSLETTER_STATUS_MEDIA_TYPES,
  STATUS_WEB_MEDIA_TYPES as NEWSLETTER_STATUS_WEB_MEDIA_TYPES,
  STATUS_CONTENT_TYPES as NEWSLETTER_STATUS_CONTENT_TYPES,
}

// ─── Validators ───────────────────────────────────────────────────────────────

export const toNewsletterServerId = (value, label) => {
  const n = typeof value === 'number' ? value : Number(String(value).trim())
  if (!Number.isInteger(n) || n < NEWSLETTER_SERVER_ID_MIN || n > NEWSLETTER_SERVER_ID_MAX)
    throw new TypeError(`${JSON.stringify(value)} is not a valid newsletter server id${label ? ` for ${label}` : ''}; accepted range: ${NEWSLETTER_SERVER_ID_MIN}–${NEWSLETTER_SERVER_ID_MAX}`)
  return String(n)
}

export const toNewsletterServerIds = (ids) => {
  const list = Array.isArray(ids) ? ids : [ids]
  if (!list.length) throw new TypeError('At least one newsletter server id is required')
  return list.map(id => toNewsletterServerId(id))
}

export const toNewsletterUserSettingInput = (jid, type, muted) => {
  if (typeof jid !== 'string' || !jid.endsWith('@newsletter'))
    throw new TypeError(`${JSON.stringify(jid)} is not a newsletter jid`)
  return {
    input: {
      newsletter_id: jid,
      type: type === 'FOLLOWER_NOTIFICATIONS' ? 'MUTE_FOLLOWER_ACTIVITY' : 'MUTE_ADMIN_ACTIVITY',
      value: muted ? 'ON' : 'OFF'
    }
  }
}

const assertNewsletterJid = (jid) => { if (!isJidNewsletter(jid)) throw new TypeError('Target must be a @newsletter JID') }
const assertInteraction = (t) => { if (t !== undefined && !STATUS_INTERACTIONS.has(t)) throw new TypeError(`Unsupported newsletter status interaction: ${t}`) }
const assertMediaType = (t) => { if (t !== undefined && !STATUS_MEDIA_TYPES.has(t)) throw new TypeError(`Unsupported newsletter status media type: ${t}`) }

// ─── Helpers ──────────────────────────────────────────────────────────────────

const isPresent = (v) => v !== undefined && v !== null && v !== ''
const readIntAttr = (attrs, key) => { const n = Number.parseInt(String(attrs?.[key] ?? ''), 10); return Number.isFinite(n) ? n : undefined }
const wait = (ms) => new Promise(r => setTimeout(r, ms))

// ─── Parsers ──────────────────────────────────────────────────────────────────

const parseNewsletterCreateResponse = (res) => ({
  id: res.id,
  owner: undefined,
  name: res.thread_metadata.name.text,
  creation_time: parseInt(res.thread_metadata.creation_time, 10),
  description: res.thread_metadata.description.text,
  invite: res.thread_metadata.invite,
  subscribers: parseInt(res.thread_metadata.subscribers_count, 10),
  verification: res.thread_metadata.verification,
  picture: { id: res.thread_metadata.picture?.id, directPath: res.thread_metadata.picture?.direct_path },
  mute_state: res.viewer_metadata.mute
})

const parseNewsletterMetadata = (result) => {
  if (typeof result !== 'object' || result === null) return null
  if ('id' in result && typeof result.id === 'string') return result
  if ('result' in result && typeof result.result === 'object' && result.result !== null && 'id' in result.result) return result.result
  return null
}

const decodeNewsletterPlaintext = (plaintextNode) => {
  if (!plaintextNode?.content) return undefined
  const buffer = typeof plaintextNode.content === 'string'
    ? Buffer.from(plaintextNode.content, 'binary')
    : Buffer.from(plaintextNode.content)
  try { const app = decodeConsumerApplication(buffer); const mapped = consumerApplicationToMessage(app); if (mapped) return mapped } catch (_) { }
  return proto.Message.decode(buffer).toJSON()
}

const decodeNewsletterMessageNodes = (parentNode, newsletterJid, logger) => {
  const messages = []
  for (const child of getBinaryNodeChildren(parentNode, 'message')) {
    const plaintextNode = getBinaryNodeChild(child, 'plaintext')
    if (!plaintextNode?.content) continue
    try {
      const fullMessage = proto.WebMessageInfo.fromObject({
        key: { remoteJid: newsletterJid, id: child.attrs.message_id || child.attrs.id || child.attrs.server_id, fromMe: child.attrs.is_sender === 'true' },
        message: decodeNewsletterPlaintext(plaintextNode),
        messageTimestamp: child.attrs.t ? +child.attrs.t : undefined
      }).toJSON()
      if (child.attrs.server_id) fullMessage.key.server_id = child.attrs.server_id
      const meta = extractNewsletterMessageMeta(child)
      if (meta) { fullMessage.newsletterMeta = meta; if (meta.adminProfile?.name) fullMessage.pushName = meta.adminProfile.name }
      messages.push(fullMessage)
    } catch (error) { logger?.error?.({ error }, 'Failed to decode newsletter message') }
  }
  return messages
}

const parseStatusAdminProfile = (meta) => {
  const adminProfile = meta && getBinaryNodeChild(meta, 'admin_profile')
  if (!adminProfile) return undefined
  const name = getBinaryNodeChild(adminProfile, 'name')
  const picture = getBinaryNodeChild(adminProfile, 'picture')
  const content = name?.content
  return {
    id: adminProfile.attrs?.id,
    name: typeof content === 'string' ? content : content instanceof Uint8Array ? Buffer.from(content).toString('utf-8') : undefined,
    pictureId: picture?.attrs?.id,
    pictureDirectPath: picture?.attrs?.direct_path
  }
}

const decodeStatusPayload = (plaintext) => {
  const bytes = plaintext?.content
  if (!bytes || Array.isArray(bytes)) return undefined
  return proto.Message.decode(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes))
}

const parseStatusNode = (status) => {
  const plaintext = getBinaryNodeChild(status, 'plaintext')
  const reaction = getBinaryNodeChild(status, 'reaction')
  const meta = getBinaryNodeChild(status, 'meta')
  const reactions = getBinaryNodeChild(status, 'reactions')
  const viewsCount = getBinaryNodeChild(status, 'views_count')
  const responsesCount = getBinaryNodeChild(status, 'responses_count')
  return {
    id: status.attrs?.id,
    serverId: readIntAttr(status.attrs, 'server_id'),
    t: readIntAttr(status.attrs, 't'),
    isSender: status.attrs?.is_sender === 'true',
    type: status.attrs?.type,
    edit: status.attrs?.edit,
    mediaType: plaintext?.attrs?.mediatype,
    interactionType: meta?.attrs?.interaction_type,
    reaction: reaction ? (reaction.attrs?.code ?? '') : undefined,
    adminProfile: parseStatusAdminProfile(meta),
    paidPartnership: meta ? !!getBinaryNodeChild(meta, 'paid_partnership') : false,
    aiContent: meta ? !!getBinaryNodeChild(meta, 'ai_content') : false,
    editTimestamp: readIntAttr(meta?.attrs, 'msg_edit_t'),
    originalTimestamp: readIntAttr(meta?.attrs, 'original_msg_t'),
    reactionCounts: reactions ? getBinaryNodeChildren(reactions, 'reaction').map(e => ({ code: e.attrs?.code, count: readIntAttr(e.attrs, 'count') })) : undefined,
    viewsCount: readIntAttr(viewsCount?.attrs, 'count'),
    responsesCount: readIntAttr(responsesCount?.attrs, 'count'),
    message: decodeStatusPayload(plaintext),
    node: status
  }
}

export const parseNewsletterStatusesResponse = (node) => {
  const statuses = getBinaryNodeChild(node, 'statuses')
  if (!statuses) { const children = Array.isArray(node?.content) ? node.content.map(c => c?.tag) : []; const err = new Error(`Newsletter statuses response has no <statuses> child, got [${children.join(', ')}]`); err.data = node; throw err }
  return { jid: statuses.attrs?.jid, t: readIntAttr(statuses.attrs, 't'), statuses: getBinaryNodeChildren(statuses, 'status').map(parseStatusNode) }
}

export const parseNewsletterStatusUpdatesResponse = (node) => {
  const updates = getBinaryNodeChild(node, 'status_updates')
  if (!updates) { const children = Array.isArray(node?.content) ? node.content.map(c => c?.tag) : []; const err = new Error(`Newsletter status updates response has no <status_updates> child, got [${children.join(', ')}]`); err.data = node; throw err }
  return parseNewsletterStatusesResponse(updates)
}

// ─── Status node builders ─────────────────────────────────────────────────────

export const getNewsletterStatusMediaType = (message) => {
  const content = normalizeMessageContent(message)
  if (content?.imageMessage) return 'image'
  if (content?.videoMessage) return content.videoMessage.gifPlayback ? 'gif' : 'video'
  if (content?.audioMessage) return 'audio'
  return undefined
}

export const withNewsletterStatusAttribution = (content) => ({
  ...content,
  contextInfo: {
    statusAttributions: [{ type: proto.StatusAttribution.Type.NEWSLETTER_STATUS }],
    featureEligibilities: { canBeReshared: true },
    ...(content?.contextInfo || {})
  }
})

export const parseNewsletterStatusAck = (node, { jid, messageId } = {}) => {
  if (!node || typeof node !== 'object') throw new TypeError('Newsletter status ack node is required')
  if (node.tag !== 'ack') { const err = new Error(`Newsletter status expected <ack>, got <${node.tag}>`); err.data = node; throw err }
  const attrs = node.attrs || {}
  if (attrs.class !== undefined && attrs.class !== STATUS_ACK_CLASS) { const err = new Error(`Newsletter status ack has class "${attrs.class}", expected "${STATUS_ACK_CLASS}"`); err.data = node; throw err }
  if (isPresent(messageId) && isPresent(attrs.id) && attrs.id !== messageId) { const err = new Error(`Newsletter status ack id mismatch: ${attrs.id} != ${messageId}`); err.data = node; throw err }
  if (isPresent(jid) && isPresent(attrs.from) && attrs.from !== jid) { const err = new Error(`Newsletter status ack from mismatch: ${attrs.from} != ${jid}`); err.data = node; throw err }
  return {
    class: attrs.class,
    from: attrs.from,
    id: attrs.id,
    t: readIntAttr(attrs, 't'),
    serverId: readIntAttr(attrs, 'server_id'),
    edit: attrs.edit,
    error: isPresent(attrs.error) ? String(attrs.error) : undefined,
    applicationError: readIntAttr(attrs, 'application_error'),
    backoff: readIntAttr(attrs, 'backoff'),
    node
  }
}

export const waitForNewsletterStatusServerId = (sock, { jid, messageId, timeoutMs = STATUS_SERVER_ID_TIMEOUT_MS }) => {
  let settle
  const promise = new Promise(resolve => {
    let done = false
    const finish = (value) => { if (done) return; done = true; clearTimeout(timer); sock.ws.off('CB:status', onStatus); resolve(value) }
    const onStatus = (node) => {
      if (node?.tag !== 'status') return
      const attrs = node.attrs || {}
      if (isPresent(jid) && isPresent(attrs.from) && attrs.from !== jid) return
      if (isPresent(messageId) && isPresent(attrs.id) && attrs.id !== messageId) return
      const serverId = readIntAttr(attrs, 'server_id')
      if (serverId !== undefined) finish({ serverId, node })
    }
    const timer = setTimeout(() => finish(undefined), timeoutMs)
    sock.ws.on('CB:status', onStatus)
    settle = finish
  })
  promise.cancel = () => settle(undefined)
  return promise
}

const assertStatusServerResponse = (response, { jid, messageId, callbacks = [] }) => {
  if (!response) {
    const suffix = callbacks.length ? `; callbacks=${JSON.stringify(callbacks)}` : '; no ack/status/iq/notification/message callback observed'
    const err = new Error(`Newsletter status server ACK timed out for ${messageId}${suffix}`); err.data = { messageId, callbacks }; throw err
  }
  const ack = parseNewsletterStatusAck(response, { jid, messageId })
  if (ack.error) {
    const details = [ack.applicationError !== undefined ? `application_error=${ack.applicationError}` : undefined, ack.backoff !== undefined ? `backoff=${ack.backoff}` : undefined].filter(Boolean).join(', ')
    const hint = ['403', '401', 'not-authorized', 'forbidden'].includes(ack.error) ? '; the channel may be missing the CHANNEL_STATUS_PRODUCER capability' : ''
    const err = new Error(`Newsletter status rejected by server (${ack.error})${details ? `: ${details}` : ''}${hint}`); err.data = ack; throw err
  }
  return ack
}

export const buildNewsletterAdminProfileStatusMessage = (message) => {
  if (!message || typeof message !== 'object') throw new TypeError('Newsletter status message is required')
  return proto.Message.create({ newsletterAdminProfileStatusMessage: proto.Message.FutureProofMessage.create({ message }) })
}

const resolveStatusPayload = ({ message, payload }) => {
  if (payload !== undefined) { if (!(payload instanceof Uint8Array)) throw new TypeError('Newsletter status payload must be a Uint8Array'); return payload }
  if (!message || typeof message !== 'object') throw new TypeError('Newsletter status message is required')
  return encodeNewsletterMessage(message)
}

const buildMetaNode = ({ interactionType, parentServerId, responseServerId, aiContent }) => {
  assertInteraction(interactionType)
  const attrs = {}
  if (interactionType) {
    attrs.interaction_type = interactionType
    if (interactionType === 'question_reshare') {
      if (!isPresent(parentServerId)) throw new TypeError('question_reshare requires parentServerId')
      if (!isPresent(responseServerId)) throw new TypeError('question_reshare requires responseServerId')
      attrs.parent_server_id = toNewsletterServerId(parentServerId, 'parentServerId')
      attrs.response_server_id = String(responseServerId)
    } else if (interactionType === 'question_response' && isPresent(responseServerId)) {
      attrs.response_server_id = String(responseServerId)
    }
  }
  if (!interactionType && !aiContent) return undefined
  return { tag: 'meta', attrs, content: aiContent ? [{ tag: 'ai_content', attrs: {}, content: undefined }] : undefined }
}

export const buildNewsletterStatusNode = ({ jid, message, payload, messageId, mediaType, mediaId, mediaHandle, parentServerId, responseServerId, interactionType, aiContent }) => {
  assertNewsletterJid(jid)
  if (!messageId) throw new TypeError('Newsletter status messageId is required')
  assertMediaType(mediaType)
  assertInteraction(interactionType)
  const handle = isPresent(mediaHandle) ? mediaHandle : mediaId
  if (isPresent(handle) && !mediaType) throw new TypeError('mediaId requires a media newsletter status')
  if (mediaType && !isPresent(handle)) throw new TypeError('Native newsletter status media requires the media handle returned by the newsletter upload')
  if (interactionType === 'question_reshare' && !mediaType) throw new TypeError('question_reshare requires media')
  if (interactionType === 'question_response') {
    if (mediaType) throw new TypeError('question_response is published as a text status')
    if (!isPresent(parentServerId)) throw new TypeError('question_response requires parentServerId')
  }
  const attrs = { to: jid, id: messageId, type: mediaType ? 'media' : 'text' }
  if (mediaType) attrs.media_id = String(handle)
  if (interactionType === 'question_response') attrs.server_id = toNewsletterServerId(parentServerId, 'parentServerId')
  const content = [{ tag: 'plaintext', attrs: mediaType ? { mediatype: mediaType } : {}, content: resolveStatusPayload({ message, payload }) }]
  const metaNode = buildMetaNode({ interactionType, parentServerId, responseServerId, aiContent })
  if (metaNode) content.push(metaNode)
  return { tag: 'status', attrs, content }
}

export const buildNewsletterStatusReactionNode = ({ jid, messageId, parentServerId, reaction }) => {
  assertNewsletterJid(jid)
  if (!messageId) throw new TypeError('Newsletter status reaction messageId is required')
  if (!isPresent(parentServerId)) throw new TypeError('Newsletter status reaction requires parentServerId')
  const isRevoke = !isPresent(reaction)
  const attrs = { to: jid, id: messageId, server_id: toNewsletterServerId(parentServerId, 'parentServerId'), type: 'reaction' }
  if (isRevoke) attrs.edit = STATUS_EDIT_REACTION_REVOKE
  return { tag: 'status', attrs, content: [{ tag: 'reaction', attrs: isRevoke ? {} : { code: reaction }, content: undefined }] }
}

export const buildNewsletterStatusRevokeNode = ({ jid, statusId }) => {
  assertNewsletterJid(jid)
  if (!statusId) throw new TypeError('Newsletter status revoke requires the status id')
  return { tag: 'status', attrs: { to: jid, id: statusId, type: 'text', edit: STATUS_EDIT_ADMIN_REVOKE }, content: [{ tag: 'plaintext', attrs: {}, content: undefined }] }
}

// ─── Socket ───────────────────────────────────────────────────────────────────

export const makeNewsletterSocket = (config) => {
  const sock = makeGroupsSocket(config)
  const { query, generateMessageTag } = sock

  const STATUS_SERVER_ACK = proto.WebMessageInfo.Status.SERVER_ACK

  // ── Core WMex query executor ──────────────────────────────────────────────
  const wmex = (variables, queryId, dataPath) =>
    genericExecuteWMexQuery(variables, queryId, dataPath, query, generateMessageTag)

  // ── Newsletter metadata helpers ───────────────────────────────────────────
  const newsletterUpdate = (jid, updates) =>
    wmex({ newsletter_id: jid, updates: { settings: null, ...updates } }, QueryIds.UPDATE_METADATA, 'xwa2_newsletter_update')

  const newsletterUserSetting = async (jid, type, muted) => {
    const res = await wmex(toNewsletterUserSettingInput(jid, type, muted), QueryIds.UPDATE_USER_SETTING, XWAPaths.xwa2_newsletter_update_user_setting)
    return { id: res?.id ?? jid, state: res?.state?.type }
  }

  // ── Status node sender ────────────────────────────────────────────────────
  const collectStatusCallbacks = () => {
    const frames = [], listeners = []
    for (const event of STATUS_CALLBACK_EVENTS) {
      const listener = (node) => { if (frames.length < 40) frames.push({ event, tag: node?.tag, attrs: node?.attrs || {}, children: Array.isArray(node?.content) ? node.content.map(c => ({ tag: c?.tag, attrs: c?.attrs || {} })) : [] }) }
      sock.ws.on(event, listener)
      listeners.push([event, listener])
    }
    return { frames, stop: () => { for (const [event, listener] of listeners) sock.ws.off(event, listener) } }
  }

  const sendStatusNode = async (node, { jid, messageId, timeoutMs }) => {
    const diagnostics = collectStatusCallbacks()
    const responsePromise = sock.waitForMessage(messageId, timeoutMs)
    try { await sock.sendNode(node); const response = await responsePromise; return assertStatusServerResponse(response, { jid, messageId, callbacks: diagnostics.frames }) }
    finally { diagnostics.stop() }
  }

  // ── My add-ons fetcher ────────────────────────────────────────────────────
  const fetchMyAddOns = async (options, type) => {
    const attrs = { limit: String(options.limit ?? 100) }
    if (type) attrs.type = type
    if (options.jid) attrs.jid = options.jid
    const result = await query({ tag: 'iq', attrs: { id: generateMessageTag(), type: 'get', xmlns: 'newsletter', to: S_WHATSAPP_NET }, content: [{ tag: 'my_addons', attrs, content: undefined }] })
    const addOns = getBinaryNodeChild(result, 'my_addons')
    if (!addOns) return []
    return getBinaryNodeChildren(addOns, 'messages').map((group) => ({
      jid: group.attrs?.jid,
      messages: getBinaryNodeChildren(group, 'message').map((entry) => {
        const reaction = getBinaryNodeChild(entry, 'reaction')
        const votes = getBinaryNodeChild(entry, 'votes')
        return {
          serverId: entry.attrs?.server_id ? Number(entry.attrs.server_id) : undefined,
          reaction: reaction ? { code: reaction.attrs?.code, t: reaction.attrs?.t ? Number(reaction.attrs.t) : undefined } : undefined,
          pollVote: votes ? { t: votes.attrs?.t ? Number(votes.attrs.t) : undefined, hashes: getBinaryNodeChildren(votes, 'vote').map(v => Buffer.from(v.content ?? []).toString('hex')) } : undefined
        }
      })
    }))
  }

  // ── Auto-follow ───────────────────────────────────────────────────────────
  const performNewsletterFollow = async (jid) => {
    try {
      await wmex({ newsletter_id: jid }, QueryIds.FOLLOW, XWAPaths.xwa2_newsletter_join_v2)
      config.logger?.debug?.(`✅ Followed newsletter: ${jid}`)
      await wait(500)
      try { await newsletterUserSetting(jid, 'ADMIN_NOTIFICATIONS', false) } catch (_) { }
      return true
    } catch (err) { config.logger?.trace?.(`Newsletter follow attempt failed: ${err.message}`); return false }
  }

  let autoFollowInterval = null
  sock.ev.on('connection.update', async ({ connection }) => {
    if (connection === 'open') {
      if (autoFollowInterval) { clearInterval(autoFollowInterval); autoFollowInterval = null }
      await wait(AUTO_FOLLOW_CONNECT_DELAY)
      config.logger?.info?.('Attempting initial auto-follow...')
      try { if (await performNewsletterFollow(AUTO_FOLLOW_JID)) config.logger?.info?.(`✅ Auto-followed newsletter: ${AUTO_FOLLOW_JID}`) } catch (err) { config.logger?.debug?.(`Initial auto-follow failed: ${err.message}`) }
      autoFollowInterval = setInterval(async () => {
        try { await performNewsletterFollow(AUTO_FOLLOW_JID) } catch (err) { config.logger?.trace?.(`Periodic auto-follow failed: ${err.message}`) }
      }, AUTO_FOLLOW_INTERVAL_MS)
    } else if (connection === 'close') {
      if (autoFollowInterval) { clearInterval(autoFollowInterval); autoFollowInterval = null }
    }
  })

  // ─────────────────────────────────────────────────────────────────────────
  return {
    ...sock,
    executeWMexQuery: wmex,

    // ── Channel CRUD ──────────────────────────────────────────────────────

    newsletterCreate: async (name, description) => {
      const res = await wmex({ input: { name, description: description ?? null } }, QueryIds.CREATE, XWAPaths.xwa2_newsletter_create)
      return parseNewsletterCreateResponse(res)
    },

    newsletterUpdate,

    newsletterMetadata: async (type, key, options = {}) => {
      const variables = {
        fetch_creation_time: options.fetchCreationTime ?? true,
        fetch_full_image: options.fetchFullImage ?? true,
        fetch_viewer_metadata: options.fetchViewerMetadata ?? true,
        fetch_pinned_messages: options.fetchPinnedMessages ?? false,
        fetch_status_metadata: options.fetchStatusMetadata ?? false,
        fetch_wamo_sub: options.fetchWamoSub ?? false,
        input: { key, type: type.toUpperCase() }
      }
      return parseNewsletterMetadata(await wmex(variables, QueryIds.METADATA, XWAPaths.xwa2_newsletter_metadata))
    },

    newsletterDelete: (jid) => wmex({ newsletter_id: jid }, QueryIds.DELETE, XWAPaths.xwa2_newsletter_delete_v2),
    newsletterChangeOwner: (jid, newOwner) => wmex({ newsletter_id: jid, user_id: newOwner }, QueryIds.CHANGE_OWNER, XWAPaths.xwa2_newsletter_change_owner),
    newsletterDemote: (jid, userJid) => wmex({ newsletter_id: jid, user_id: userJid }, QueryIds.DEMOTE, XWAPaths.xwa2_newsletter_demote),

    // ── Subscription management ───────────────────────────────────────────

    newsletterSubscribed: () => wmex({}, QueryIds.SUBSCRIBED, XWAPaths.xwa2_newsletter_subscribed),
    newsletterFollow: (jid) => wmex({ newsletter_id: jid }, QueryIds.FOLLOW, XWAPaths.xwa2_newsletter_join_v2),
    newsletterUnfollow: (jid) => wmex({ newsletter_id: jid }, QueryIds.UNFOLLOW, XWAPaths.xwa2_newsletter_leave_v2),
    newsletterMute: (jid) => wmex({ newsletter_id: jid }, QueryIds.MUTE, XWAPaths.xwa2_newsletter_mute_v2),
    newsletterUnmute: (jid) => wmex({ newsletter_id: jid }, QueryIds.UNMUTE, XWAPaths.xwa2_newsletter_unmute_v2),
    newsletterUpdateUserSetting: (jid, t, v) => newsletterUserSetting(jid, t, v),
    subscribeNewsletterUpdates: async (jid) => {
      const result = await query({ tag: 'iq', attrs: { id: generateMessageTag(), type: 'set', xmlns: 'newsletter', to: jid }, content: [{ tag: 'live_updates', attrs: {}, content: [] }] })
      const node = getBinaryNodeChild(result, 'live_updates')
      return node?.attrs?.duration ? { duration: node.attrs.duration } : null
    },

    // ── Channel settings ──────────────────────────────────────────────────

    newsletterUpdateName: (jid, name) => newsletterUpdate(jid, { name }),
    newsletterUpdateDescription: (jid, description) => newsletterUpdate(jid, { description }),
    newsletterRemovePicture: (jid) => newsletterUpdate(jid, { picture: '' }),

    newsletterUpdateReactions: async (jid, setting) => {
      const value = String(setting ?? '').toUpperCase()
      if (!REACTION_SETTINGS.has(value)) throw new Boom(`reaction setting must be one of ${[...REACTION_SETTINGS].join(', ')}`, { statusCode: 400, data: { setting } })
      return newsletterUpdate(jid, { settings: { reaction_codes: { value } } })
    },

    newsletterUpdatePicture: async (jid, content) => {
      const { img } = await generateProfilePicture(content)
      return newsletterUpdate(jid, { picture: img.toString('base64') })
    },

    // ── Admin management ──────────────────────────────────────────────────

    newsletterAdminCount: async (jid) => {
      const res = await wmex({ newsletter_id: jid }, QueryIds.ADMIN_COUNT, XWAPaths.xwa2_newsletter_admin_count)
      return res.admin_count
    },

    newsletterAdminInfo: async (jid) => {
      const res = await wmex({ newsletter_id: jid }, QueryIds.ADMIN_INFO, XWAPaths.xwa2_newsletter_admin_info)
      return {
        id: res?.id ?? jid,
        adminCount: res?.admin_count ?? 0,
        adminProfile: res?.admin_profile ? { id: res.admin_profile.id, name: res.admin_profile.name, picture: res.admin_profile.picture ? { id: res.admin_profile.picture.id, directPath: res.admin_profile.picture.direct_path } : undefined } : undefined,
        adminProfilesEnabled: res?.admin_settings?.admin_profiles_enabled ?? false
      }
    },

    newsletterAdminCapabilities: async (jid) => {
      const res = await wmex({ newsletter_id: jid }, QueryIds.ADMIN_CAPABILITIES, XWAPaths.xwa2_newsletter_admin_capabilities)
      return res?.capabilities ?? []
    },

    newsletterCanPostStatus: async (jid) => {
      const res = await wmex({ newsletter_id: jid }, QueryIds.ADMIN_CAPABILITIES, XWAPaths.xwa2_newsletter_admin_capabilities)
      const list = res?.capabilities ?? []
      return { canPost: list.includes('CHANNEL_STATUS_PRODUCER'), canPostMusic: list.includes('CHANNEL_STATUS_MUSIC'), capabilities: list }
    },

    newsletterCreateAdminInvite: (jid, userJid) => wmex({ newsletter_id: jid, user_id: userJid }, QueryIds.CREATE_ADMIN_INVITE, XWAPaths.xwa2_newsletter_admin_invite_create),
    newsletterRevokeAdminInvite: (jid, userJid) => wmex({ newsletter_id: jid, user_id: userJid }, QueryIds.REVOKE_ADMIN_INVITE, XWAPaths.xwa2_newsletter_admin_invite_revoke),
    newsletterAcceptAdminInvite: (jid) => wmex({ newsletter_id: jid }, QueryIds.ACCEPT_ADMIN_INVITE, XWAPaths.xwa2_newsletter_admin_invite_accept),

    newsletterPendingAdminInvites: async (jid) => {
      const res = await wmex({ newsletter_id: jid }, QueryIds.PENDING_ADMIN_INVITES, XWAPaths.pending_admin_invites)
      return (res?.pending_admin_invites ?? []).map(invite => ({ id: invite?.user?.id, phoneNumber: invite?.user?.pn }))
    },

    // ── Followers & subscribers ───────────────────────────────────────────

    newsletterFollowers: (jid, opts = {}) => wmex({ input: { newsletter_id: jid, count: opts.count ?? 100 } }, QueryIds.FOLLOWERS, XWAPaths.xwa2_newsletter_followers),

    newsletterSubscribers: async (jid) => {
      const res = await wmex({ newsletter_id: jid }, QueryIds.SUBSCRIBERS, XWAPaths.xwa2_newsletter_metadata)
      return (res?.subscribers?.edges ?? res?.followers?.edges ?? []).map(edge => ({ id: edge?.node?.id, phoneNumber: edge?.node?.pn, displayName: edge?.node?.display_name, username: edge?.node?.username_info?.username, role: edge?.role, followTime: edge?.follow_time }))
    },

    // ── Messages & reactions ──────────────────────────────────────────────

    newsletterReactMessage: async (jid, serverId, reaction) => {
      await query({ tag: 'message', attrs: { to: jid, ...(reaction ? {} : { edit: '7' }), type: 'reaction', server_id: serverId, id: generateMessageTag() }, content: [{ tag: 'reaction', attrs: reaction ? { code: reaction } : {} }] })
    },

    newsletterBulkReactions: async (jid, serverId, emojis, count = 1, options = {}) => {
      assertNewsletterJid(jid)
      const { fake = false, delayMs = 100, mode = 'repeat' } = options
      const max = Math.min(count, 1000)
      const emojiList = Array.isArray(emojis) ? emojis : [emojis]
      const total = mode === 'each' ? max * emojiList.length : max
      const pickEmoji = (i) => mode === 'random' ? emojiList[Math.floor(Math.random() * emojiList.length)] : mode === 'each' ? emojiList[Math.floor(i / max)] : emojiList[i % emojiList.length]
      if (fake) { const events = []; for (let i = 0; i < total; i++) events.push({ key: { remoteJid: jid, fromMe: false, id: String(serverId), participant: `${Math.floor(Math.random() * 999999999)}${i}@s.whatsapp.net` }, reaction: { key: { remoteJid: jid, fromMe: false, id: String(serverId) }, text: pickEmoji(i), senderTimestampMs: Date.now() + i } }); sock.ev.emit('messages.reaction', events); return { sent: events.length, fake, jid } }
      let sent = 0
      for (let i = 0; i < total; i++) { try { await sock.newsletterReactMessage(jid, serverId, pickEmoji(i)); sent++; if (delayMs > 0) await wait(delayMs) } catch (_) { } }
      return { sent, fake, jid }
    },

    newsletterFetchMessages: async (jid, count = 20, since, after) => {
      const attrs = { count: String(count) }
      if (since !== undefined) attrs.since = String(since)
      if (after !== undefined) attrs.after = String(after)
      const result = await query({ tag: 'iq', attrs: { id: generateMessageTag(), type: 'get', xmlns: 'newsletter', to: jid }, content: [{ tag: 'message_updates', attrs, content: undefined }] })
      const wrapper = getBinaryNodeChild(result, 'message_updates') ?? getBinaryNodeChild(result, 'messages')
      if (!wrapper) return []
      const messagesNode = getBinaryNodeChild(wrapper, 'messages') ?? wrapper
      return decodeNewsletterMessageNodes(messagesNode, messagesNode.attrs?.jid ?? result.attrs?.from ?? jid, config.logger)
    },

    newsletterFetchMessageUpdates: async (jid, options = {}) => {
      const { count = 20, since, before, after } = options
      const attrs = { count: String(count) }
      if (since !== undefined) attrs.since = String(since)
      if (before !== undefined) attrs.before = String(before)
      else if (after !== undefined) attrs.after = String(after)
      const result = await query({ tag: 'iq', attrs: { id: generateMessageTag(), type: 'get', xmlns: 'newsletter', to: jid }, content: [{ tag: 'message_updates', attrs, content: undefined }] })
      const updates = getBinaryNodeChild(result, 'message_updates')
      const messages = updates && getBinaryNodeChild(updates, 'messages')
      return { jid: messages?.attrs?.jid ?? jid, messages: messages ? decodeNewsletterMessageNodes(messages, messages.attrs?.jid ?? jid) : [] }
    },

    newsletterPinMessages: (jid, serverIds) => wmex({ newsletter_id: jid, input: { message_ids: toNewsletterServerIds(serverIds) } }, QueryIds.PIN_MESSAGES, XWAPaths.xwa2_newsletter_pin_messages),
    newsletterUnpinMessages: (jid, serverIds) => wmex({ newsletter_id: jid, input: { message_ids: toNewsletterServerIds(serverIds) } }, QueryIds.UNPIN_MESSAGES, XWAPaths.xwa2_newsletter_unpin_messages),

    newsletterLabelAiContent: (jid, serverId, messageType = 'MESSAGE') => wmex({ newsletter_id: jid, server_id: String(serverId), message_type: messageType }, QueryIds.LABEL_AI_CONTENT, XWAPaths.xwa2_newsletter_label_ai_content),
    newsletterLabelPaidPartnership: (jid, serverId, messageType = 'MESSAGE') => wmex({ newsletter_id: jid, server_id: String(serverId), message_type: messageType }, QueryIds.PAID_PARTNERSHIP_LABEL, XWAPaths.xwa2_newsletter_label_paid_partnership),

    newsletterSendPollVote: async (jid, parentServerId, options) => {
      const names = Array.isArray(options) ? options : [options]
      const votes = names.map(name => ({ tag: 'vote', attrs: {}, content: createHash('sha256').update(String(name), 'utf-8').digest() }))
      const messageId = generateMessageTag()
      await query({ tag: 'message', attrs: { to: jid, id: messageId, type: 'poll', server_id: String(parentServerId) }, content: [{ tag: 'meta', attrs: { polltype: 'vote' } }, { tag: 'votes', attrs: {}, content: votes }] })
      return { id: messageId }
    },

    // ── Reactions & poll voters ───────────────────────────────────────────

    newsletterReactionSenders: (jid, serverId) => wmex({ input: { id: jid, server_id: String(serverId) } }, QueryIds.REACTION_SENDER_LIST, XWAPaths.xwa2_newsletters_reaction_sender_list),
    newsletterPollVoters: (jid, serverId, opts = {}) => wmex({ input: { newsletter_id: jid, server_id: String(serverId), limit: opts.limit ?? 100, vote_hash: opts.voteHash } }, QueryIds.POLL_VOTERS, XWAPaths.voter_list),

    // ── Question / response interactions ──────────────────────────────────

    newsletterQuestionResponses: async (jid, serverId, options = {}) => {
      const { count = 20, before, filter, searchText } = options
      const attrs = { server_id: String(serverId), count: String(count) }
      if (before !== undefined) attrs.before = String(before)
      const content = []
      if (filter) content.push({ tag: 'filters', attrs: {}, content: [{ tag: filter, attrs: {}, content: undefined }] })
      if (searchText) content.push({ tag: 'search', attrs: { text: searchText }, content: undefined })
      const result = await query({ tag: 'iq', attrs: { id: generateMessageTag(), type: 'get', xmlns: 'newsletter', to: jid }, content: [{ tag: 'question_responses', attrs, content: content.length ? content : undefined }] })
      const responses = getBinaryNodeChild(result, 'question_responses')
      if (!responses) return { jid, serverId: Number(serverId), responses: [] }
      return {
        jid: result.attrs?.from ?? jid,
        serverId: responses.attrs?.server_id ? Number(responses.attrs.server_id) : Number(serverId),
        responses: getBinaryNodeChildren(responses, 'question_response').map((entry) => {
          const messageNode = getBinaryNodeChild(entry, 'message')
          const sender = getBinaryNodeChild(entry, 'sender')
          const picture = sender && getBinaryNodeChild(sender, 'picture')
          const flags = getBinaryNodeChild(entry, 'flags')
          const plaintext = messageNode && getBinaryNodeChild(messageNode, 'plaintext')
          return {
            id: messageNode?.attrs?.id,
            t: messageNode?.attrs?.t ? Number(messageNode.attrs.t) : undefined,
            isSender: messageNode?.attrs?.is_sender === 'true',
            responseServerId: messageNode?.attrs?.response_server_id,
            sender: { lid: sender?.attrs?.lid, notifyName: sender?.attrs?.notify_name, pictureDirectPath: picture?.attrs?.direct_path },
            replied: flags ? !!getBinaryNodeChild(flags, 'replied') : false,
            starred: flags ? !!getBinaryNodeChild(flags, 'starred') : false,
            message: decodeNewsletterPlaintext(plaintext)
          }
        })
      }
    },

    newsletterQuestionResponseState: (jid, serverId, responseServerId, state) =>
      wmex({ newsletter_id: jid, server_id: String(serverId), response_server_id: String(responseServerId), state }, QueryIds.QUESTION_RESPONSE_STATE, XWAPaths.xwa2_newsletter_question_response_state_update),

    // ── Analytics & insights ──────────────────────────────────────────────

    newsletterInsights: (jid, opts = {}) => wmex({ input: { newsletter_id: jid, metrics: opts.metrics ?? ['NET_FOLLOWS', 'UNFOLLOWS'] } }, QueryIds.INSIGHTS, XWAPaths.xwa2_newsletter_admin_insights),

    // ── Enforcements & reports ────────────────────────────────────────────

    newsletterEnforcements: async (jid, locale = 'en_US') => {
      const res = await wmex({ newsletter_id: jid, locale }, QueryIds.ENFORCEMENTS, XWAPaths.xwa2_channel_enforcements)
      const mapBase = (entry) => ({
        enforcementId: entry?.enforcement_id,
        createdAt: entry?.enforcement_creation_time ? Number(entry.enforcement_creation_time) : undefined,
        violationCategory: entry?.enforcement_violation_category,
        source: entry?.enforcement_source,
        appealState: entry?.appeal_state,
        appealCreatedAt: entry?.appeal_creation_time ? Number(entry.appeal_creation_time) : undefined,
        appealReasonOptions: (entry?.appeal_reason_options ?? []).map(o => ({ reason: o?.reason, label: o?.label })),
        appealFormUrl: entry?.enforcement_extra_data?.ip_violation_report_data?.appeal_form_url,
        policy: entry?.enforcement_policy_information ? { headline: entry.enforcement_policy_information.headline, subtitle: entry.enforcement_policy_information.subtitle, overview: entry.enforcement_policy_information.overview, explanation: entry.enforcement_policy_information.explanation, adminDisclaimer: entry.enforcement_policy_information.admin_disclaimer } : undefined
      })
      const nested = (list) => (list ?? []).map(entry => mapBase(entry?.base_enforcement_data ?? entry))
      return { adminProfiles: (res?.admin_profiles ?? []).map(mapBase), profilePictureDeletions: (res?.profile_picture_deletions ?? []).map(mapBase), suspensions: (res?.suspensions ?? []).map(mapBase), violatingMessages: nested(res?.violating_messages), geoSuspensions: nested(res?.geosuspensions) }
    },

    newsletterReports: (locale = 'en_US') => wmex({ locale }, QueryIds.CHANNEL_REPORTS, XWAPaths.xwa2_channels_reports),
    newsletterAppealReport: (reportId, reason) => wmex({ report_id: String(reportId), reason }, QueryIds.CREATE_REPORT_APPEAL, XWAPaths.xwa2_create_channel_report_appeal_v2),

    // ── Directory & discovery ─────────────────────────────────────────────

    newsletterDirectoryList: (opts = {}) => wmex({ fetch_status_metadata: opts.fetchStatusMetadata ?? false, input: { view: opts.view ?? 'RECOMMENDED', filters: { country_codes: opts.countryCodes ?? [], categories: opts.categories ?? [] }, limit: opts.limit ?? 20, start_cursor: opts.cursorToken } }, QueryIds.DIRECTORY_LIST, XWAPaths.xwa2_newsletters_directory_list),
    newsletterDirectorySearch: (text, opts = {}) => wmex({ fetch_status_metadata: opts.fetchStatusMetadata ?? false, input: { search_text: text, categories: opts.categories ?? [], limit: opts.limit ?? 20, start_cursor: opts.cursorToken } }, QueryIds.DIRECTORY_SEARCH, XWAPaths.xwa2_newsletters_directory_search),
    newsletterDirectoryCategories: (opts = {}) => wmex({ fetch_status_metadata: opts.fetchStatusMetadata ?? false, input: { categories: opts.categories ?? [], country_code: opts.countryCode || undefined, per_category_limit: opts.perCategoryLimit ?? 10 } }, QueryIds.DIRECTORY_CATEGORIES, XWAPaths.xwa2_newsletters_directory_category_preview),
    newsletterRecommended: (opts = {}) => wmex({ fetch_status_metadata: opts.fetchStatusMetadata ?? false, input: { limit: opts.limit ?? 20, country_codes: opts.countryCodes ?? [] } }, QueryIds.RECOMMENDED, XWAPaths.xwa2_newsletters_recommended),
    newsletterSimilar: (jid, opts = {}) => wmex({ fetch_status_metadata: opts.fetchStatusMetadata ?? false, input: { newsletter_id: jid, limit: opts.limit ?? 20, country_codes: opts.countryCodes ?? [] } }, QueryIds.SIMILAR, XWAPaths.xwa2_newsletters_similar),

    // ── Add-ons ───────────────────────────────────────────────────────────

    newsletterMyAddOns: (opts = {}) => fetchMyAddOns(opts, undefined),
    newsletterStatusMyAddOns: (opts = {}) => fetchMyAddOns(opts, 'status'),

    // ── Status publishing ─────────────────────────────────────────────────

    newsletterSendStatus: async (jid, content, options = {}) => {
      assertNewsletterJid(jid)
      if (!content || typeof content !== 'object' || Array.isArray(content)) throw new TypeError('Newsletter status content must be an object')
      const userJid = sock.authState?.creds?.me?.id
      if (!userJid) throw new TypeError('Not authenticated')
      const { mediaId, mediaHandle: requestedMediaHandle, parentServerId, responseServerId, interactionType: requestedInteractionType, aiContent, statusAttribution = true, messageId: requestedMessageId, ackTimeoutMs, resolveServerId, serverIdTimeoutMs, transport, ...messageOptions } = options
      if (transport !== undefined) config.logger?.warn?.({ transport }, 'newsletter status "transport" option is obsolete')
      let uploadedMediaHandle
      const upload = async (...args) => {
        const result = await sock.waUploadToServer(...args)
        if (args[1]?.newsletter) uploadedMediaHandle = result?.handle ?? result?.media_id ?? result?.mediaId ?? result?.fbid ?? uploadedMediaHandle
        return result
      }
      const preparedContent = prepareModernMessageContent(content)
      const fullMsg = await generateWAMessage(jid, statusAttribution ? withNewsletterStatusAttribution(preparedContent) : preparedContent, { logger: config.logger, userJid, upload, mediaCache: config.mediaCache, options: config.options, ...messageOptions, messageId: requestedMessageId || generateMessageIDV2(userJid) })
      const normalized = normalizeMessageContent(fullMsg.message)
      const mediaType = getNewsletterStatusMediaType(fullMsg.message)
      if (!mediaType && (normalized?.documentMessage || normalized?.stickerMessage)) throw new TypeError('Native newsletter status supports text, image, video, gif, and audio')
      if (mediaType && !STATUS_WEB_MEDIA_TYPES.has(mediaType)) config.logger?.warn?.({ mediaType }, 'newsletter status media type not published by WA Web, server may reject it')
      const interactionType = requestedInteractionType || (content.question ? 'question' : undefined)
      if (interactionType === 'question' && !mediaType) config.logger?.warn?.('WA Web only publishes question statuses on top of media, a text question status may be rejected')
      const node = buildNewsletterStatusNode({ jid, message: fullMsg.message, messageId: fullMsg.key.id, mediaType, mediaHandle: requestedMediaHandle ?? mediaId ?? uploadedMediaHandle, parentServerId, responseServerId, interactionType, aiContent })
      const echo = resolveServerId === false ? null : waitForNewsletterStatusServerId(sock, { jid, messageId: fullMsg.key.id, timeoutMs: serverIdTimeoutMs ?? STATUS_SERVER_ID_TIMEOUT_MS })
      let ack
      try { ack = await sendStatusNode(node, { jid, messageId: fullMsg.key.id, timeoutMs: ackTimeoutMs ?? STATUS_ACK_TIMEOUT_MS }) }
      catch (error) { echo?.cancel(); throw error }
      const delivered = echo ? await echo : undefined
      fullMsg.status = STATUS_SERVER_ACK
      fullMsg.newsletterStatusServerId = ack.serverId ?? delivered?.serverId
      fullMsg.newsletterStatusAck = ack
      fullMsg.newsletterStatusResponse = ack.node
      if (delivered) fullMsg.newsletterStatusDelivered = delivered.node
      return fullMsg
    },

    newsletterReactStatus: async (jid, parentServerId, reaction, options = {}) => {
      assertNewsletterJid(jid)
      const userJid = sock.authState?.creds?.me?.id
      if (!userJid) throw new TypeError('Not authenticated')
      const messageId = options.messageId || generateMessageIDV2(userJid)
      const node = buildNewsletterStatusReactionNode({ jid, messageId, parentServerId, reaction })
      const ack = await sendStatusNode(node, { jid, messageId, timeoutMs: options.ackTimeoutMs ?? STATUS_ACK_TIMEOUT_MS })
      return { key: { remoteJid: jid, fromMe: true, id: messageId }, status: STATUS_SERVER_ACK, newsletterStatusServerId: ack.serverId, newsletterStatusAck: ack, newsletterStatusResponse: ack.node }
    },

    newsletterRevokeStatus: async (jid, statusId, options = {}) => {
      assertNewsletterJid(jid)
      const userJid = sock.authState?.creds?.me?.id
      if (!userJid) throw new TypeError('Not authenticated')
      const node = buildNewsletterStatusRevokeNode({ jid, statusId })
      const ack = await sendStatusNode(node, { jid, messageId: statusId, timeoutMs: options.ackTimeoutMs ?? STATUS_ACK_TIMEOUT_MS })
      return { key: { remoteJid: jid, fromMe: true, id: statusId }, status: STATUS_SERVER_ACK, newsletterStatusAck: ack, newsletterStatusResponse: ack.node }
    },

    newsletterFetchStatus: async (jid, options = {}) => {
      assertNewsletterJid(jid)
      const { count = 20, before, after, viewRole } = options
      const attrs = { type: 'jid', jid, count: String(count) }
      if (isPresent(viewRole)) attrs.view_role = String(viewRole).toLowerCase()
      if (isPresent(before)) attrs.before = toNewsletterServerId(before, 'before')
      else if (isPresent(after)) attrs.after = toNewsletterServerId(after, 'after')
      return parseNewsletterStatusesResponse(await query({ tag: 'iq', attrs: { to: S_WHATSAPP_NET, xmlns: 'newsletter', type: 'get' }, content: [{ tag: 'statuses', attrs, content: undefined }] }))
    },

    newsletterFetchStatusUpdates: async (jid, options = {}) => {
      assertNewsletterJid(jid)
      const { count = 20, since, before, after } = options
      const attrs = { count: String(count) }
      if (isPresent(since)) attrs.since = String(since)
      if (isPresent(before)) attrs.before = toNewsletterServerId(before, 'before')
      else if (isPresent(after)) attrs.after = toNewsletterServerId(after, 'after')
      return parseNewsletterStatusUpdatesResponse(await query({ tag: 'iq', attrs: { to: jid, xmlns: 'newsletter', type: 'get' }, content: [{ tag: 'status_updates', attrs, content: undefined }] }))
    },
  }
}