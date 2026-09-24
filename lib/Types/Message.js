import { proto, MESSAGE_FIELD_KEYS } from '../../WAProto/index.js'
export { proto as WAProto, MESSAGE_FIELD_KEYS }
export const WAMessageStubType = new Proxy({}, { get: (_, k) => proto.WebMessageInfo?.StubType?.[k] })
export const WAMessageStatus = new Proxy({}, { get: (_, k) => proto.WebMessageInfo?.Status?.[k] })
export var WAMessageAddressingMode
    ; (function (WAMessageAddressingMode) {
        WAMessageAddressingMode['PN'] = 'pn'
        WAMessageAddressingMode['LID'] = 'lid'
    })(WAMessageAddressingMode || (WAMessageAddressingMode = {}))

// New stub types from WA 2.3000.1047787617 not yet in proto
export const WA_STUB_TYPE_NAMES = {
    196: 'SUPPORT_AI_EDUCATION',
    192: 'BIZ_BOT_1P_MESSAGING_ENABLED',
    197: 'BIZ_BOT_3P_MESSAGING_ENABLED',
    198: 'REMINDER_SETUP_MESSAGE',
    199: 'REMINDER_SENT_MESSAGE',
    200: 'REMINDER_CANCEL_MESSAGE',
    220: 'QUARANTINED_MESSAGE',
    225: 'SCHEDULED_MESSAGE_CREATED',
    226: 'IDENTITY_TRUST_MARKED',
    240: 'CHANGE_ACP2_SETTING',
    249: 'UGC_BOT_PROFILE_UPDATED',
}

export const resolveStubType = (stubType) =>
    proto.WebMessageInfo?.StubType?.[stubType] ?? WA_STUB_TYPE_NAMES[stubType] ?? `UNKNOWN_STUB_${stubType}`