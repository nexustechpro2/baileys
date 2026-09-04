export var XWAPaths;
(function (XWAPaths) {
  // ─── Core newsletter ──────────────────────────────────────────────────────
  XWAPaths['xwa2_newsletter_create'] = 'xwa2_newsletter_create'
  XWAPaths['xwa2_newsletter'] = 'xwa2_newsletter'            // fetch / dehydrated
  XWAPaths['xwa2_newsletter_update'] = 'xwa2_newsletter_update'
  XWAPaths['xwa2_newsletter_delete_v2'] = 'xwa2_newsletter_delete_v2'
  XWAPaths['xwa2_newsletter_join_v2'] = 'xwa2_newsletter_join_v2'
  XWAPaths['xwa2_newsletter_leave_v2'] = 'xwa2_newsletter_leave_v2'
  XWAPaths['xwa2_newsletter_subscribed'] = 'xwa2_newsletter_subscribed'
  XWAPaths['xwa2_newsletter_update_user_setting'] = 'xwa2_newsletter_update_user_setting' // mute/unmute
  XWAPaths['xwa2_newsletter_link_preview'] = 'xwa2_newsletter_link_preview'
  // ─── Admin ────────────────────────────────────────────────────────────────
  XWAPaths['xwa2_newsletter_admin'] = 'xwa2_newsletter_admin'      // info / capabilities / pending invites
  XWAPaths['xwa2_newsletter_admin_demote'] = 'xwa2_newsletter_admin_demote'
  XWAPaths['xwa2_newsletter_admin_invite_create'] = 'xwa2_newsletter_admin_invite_create'
  XWAPaths['xwa2_newsletter_admin_invite_accept'] = 'xwa2_newsletter_admin_invite_accept'
  XWAPaths['xwa2_newsletter_admin_invite_revoke'] = 'xwa2_newsletter_admin_invite_revoke'
  XWAPaths['xwa2_newsletter_change_owner'] = 'xwa2_newsletter_change_owner'
  XWAPaths['xwa2_newsletter_admin_insights'] = 'xwa2_newsletter_admin_insights'
  // ─── Followers / subscribers ──────────────────────────────────────────────
  XWAPaths['xwa2_newsletter_followers'] = 'xwa2_newsletter_followers'
  // ─── Content / messages ───────────────────────────────────────────────────
  XWAPaths['xwa2_newsletter_pin_messages'] = 'xwa2_newsletter_pin_messages'
  XWAPaths['xwa2_newsletter_unpin_messages'] = 'xwa2_newsletter_unpin_messages'
  XWAPaths['xwa2_newsletter_log_exposures'] = 'xwa2_newsletter_log_exposures'
  XWAPaths['xwa2_newsletter_label_ai_content'] = 'xwa2_newsletter_label_ai_content'
  XWAPaths['xwa2_newsletter_label_paid_partnership'] = 'xwa2_newsletter_label_paid_partnership'
  XWAPaths['xwa2_newsletter_message_integrity'] = 'xwa2_newsletter_message_integrity'
  // ─── Polls / reactions ────────────────────────────────────────────────────
  XWAPaths['xwa2_newsletters_poll_voter_list'] = 'xwa2_newsletters_poll_voter_list'
  XWAPaths['xwa2_newsletters_reaction_sender_list'] = 'xwa2_newsletters_reaction_sender_list'
  // ─── Discovery ────────────────────────────────────────────────────────────
  XWAPaths['xwa2_newsletters_recommended'] = 'xwa2_newsletters_recommended'
  XWAPaths['xwa2_newsletters_similar'] = 'xwa2_newsletters_similar'
  XWAPaths['xwa2_newsletters_directory_list'] = 'xwa2_newsletters_directory_list'
  XWAPaths['xwa2_newsletters_directory_search'] = 'xwa2_newsletters_directory_search'
  XWAPaths['xwa2_newsletters_directory_category_preview'] = 'xwa2_newsletters_directory_category_preview'
  // ─── Enforcement ──────────────────────────────────────────────────────────
  XWAPaths['xwa2_channels_reports'] = 'xwa2_channels_reports'
  // ─── Non-newsletter shared ────────────────────────────────────────────────
  XWAPaths['xwa2_fetch_account_reachout_timelock'] = 'xwa2_fetch_account_reachout_timelock'
  XWAPaths['xwa2_message_capping_info'] = 'xwa2_message_capping_info'
})(XWAPaths || (XWAPaths = {}))

export var QueryIds;
(function (QueryIds) {
  // ─── Core newsletter ──────────────────────────────────────────────────────
  QueryIds['CREATE'] = '25149874324715067'   // WAWebMexCreateNewsletterJob
  QueryIds['FETCH'] = '27456920720571478'   // WAWebMexFetchNewsletterJob
  QueryIds['FETCH_DEHYDRATED'] = '26944199458535748'   // WAWebMexFetchNewsletterDehydratedJob
  QueryIds['FETCH_ALL_METADATA'] = '25399611239711790'   // WAWebMexFetchAllNewslettersMetadataJob
  QueryIds['UPDATE_METADATA'] = '24250201037901610'   // WAWebMexUpdateNewsletterJob
  QueryIds['DELETE'] = '30062808666639665'   // WAWebMexDeleteNewsletterJob
  // ─── Follow / subscribe ───────────────────────────────────────────────────
  QueryIds['FOLLOW'] = '24404358912487870'   // WAWebMexJoinNewsletterJob
  QueryIds['UNFOLLOW'] = '9767147403369991'    // WAWebMexLeaveNewsletterJob
  QueryIds['UPDATE_USER_SETTING'] = '31938993655691868'   // WAWebMexUpdateNewsletterUserSettingJob (mute/unmute)
  // ─── Admin ────────────────────────────────────────────────────────────────
  QueryIds['ADMIN_INFO'] = '26278439461859188'   // WAWebMexFetchNewsletterAdminInfoJob
  QueryIds['ADMIN_CAPABILITIES'] = '9801384413216421'    // WAWebMexFetchNewsletterAdminCapabilitiesJob
  QueryIds['PENDING_INVITES'] = '9783111038412085'    // WAWebMexFetchNewsletterPendingInvitesJob
  QueryIds['ADMIN_INVITE_CREATE'] = '9387141988078609'    // WAWebMexCreateNewsletterAdminInviteJob
  QueryIds['ADMIN_INVITE_ACCEPT'] = '9580828702035549'    // WAWebMexAcceptNewsletterAdminInviteJob
  QueryIds['ADMIN_INVITE_REVOKE'] = '9656078347839416'    // WAWebMexRevokeNewsletterAdminInviteJob
  QueryIds['DEMOTE'] = '9880997548630971'    // WAWebMexDemoteNewsletterAdminJob
  QueryIds['CHANGE_OWNER'] = '9546742745432473'    // WAWebMexChangeNewsletterOwnerJob
  QueryIds['ADMIN_PROFILE_UPDATE'] = '28226671310350649'   // WAWebMexUpdateNewsletterAdminProfileSettingJob
  QueryIds['INSIGHTS'] = '9853618868050977'    // WAWebMexFetchNewsletterInsightsJob
  // ─── Followers ────────────────────────────────────────────────────────────
  QueryIds['FOLLOWERS'] = '27472091235714801'   // WAWebMexFetchNewsletterFollowersJob
  // ─── Content / messages ───────────────────────────────────────────────────
  QueryIds['PIN_MESSAGES'] = '27165709459706559'   // WAWebMexNewsletterPinMessagesJob
  QueryIds['UNPIN_MESSAGES'] = '28007176042216937'   // WAWebMexNewsletterUnpinMessagesJob
  QueryIds['LOG_EXPOSURES'] = '25260800823586918'   // WAWebMexLogNewsletterExposuresJob
  QueryIds['LABEL_AI_CONTENT'] = '27909718265289596'   // WAWebMexNewsletterLabelAiContentJob
  QueryIds['LABEL_PAID_PARTNERSHIP'] = '26102375079404865' // WAWebMexNewsletterAddPaidPartnershipLabelJob
  // ─── Polls / reactions ────────────────────────────────────────────────────
  QueryIds['POLL_VOTERS'] = '9407762219322536'    // WAWebMexFetchNewsletterPollVotersJob
  QueryIds['REACTION_SENDER_LIST'] = '29575462448733991'   // WAWebMexFetchNewsletterMessageReactionSenderListJob
  // ─── Discovery ────────────────────────────────────────────────────────────
  QueryIds['RECOMMENDED'] = '25806748772361516'   // WAWebMexFetchRecommendedNewslettersJob
  QueryIds['SIMILAR'] = '26217043484590756'   // WAWebMexFetchSimilarNewslettersJob
  QueryIds['DIRECTORY_LIST'] = '26125047313831973'   // WAWebMexFetchNewsletterDirectoryListJob
  QueryIds['DIRECTORY_SEARCH'] = '26301059626252132'   // WAWebMexFetchNewsletterDirectorySearchResultsJob
  QueryIds['DIRECTORY_CATEGORIES'] = '35266481849605779'   // WAWebMexFetchNewsletterDirectoryCategoriesPreviewJob
  // ─── Enforcement ──────────────────────────────────────────────────────────
  QueryIds['ENFORCEMENTS'] = '27835373536068060'   // WAWebMexFetchNewsletterEnforcementsJob
  QueryIds['REPORTS'] = '35936238352686172'   // WAWebMexFetchNewsletterReportsJob
  QueryIds['ADMIN_INVITE_INFO'] = '26278439461859188'   // WAWebMexFetchNewsletterAdminInfoJob (invite context)
  // ─── Non-newsletter ───────────────────────────────────────────────────────
  QueryIds['REACHOUT_TIMELOCK'] = '23983697327930364'   // WAWebMexFetchReachoutTimelockJob
  QueryIds['MESSAGE_CAPPING_INFO'] = '27910975521856601'   // WAWebMexFetchNewChatMessageCappingInfoJob
})(QueryIds || (QueryIds = {}))