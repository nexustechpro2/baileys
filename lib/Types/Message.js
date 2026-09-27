import { proto } from '../../WAProto/index.js'

export { proto as WAProto }

// Proto is the authoritative source. These Proxies let callers use
// WAMessageStubType.GROUP_CREATE or WAMessageStatus.READ exactly as before.
export const WAMessageStubType = new Proxy({}, { get: (_, k) => proto.WebMessageInfo?.StubType?.[k] })
export const WAMessageStatus = new Proxy({}, { get: (_, k) => proto.WebMessageInfo?.Status?.[k] })

export const WAMessageAddressingMode = Object.freeze({ PN: 'pn', LID: 'lid' })

// Resolve a numeric stub type to its string name.
// Proto is the true source — only falls back to UNKNOWN_STUB_N for values not yet in the compiled proto.
export const resolveStubType = (stubType) =>
    proto.WebMessageInfo?.StubType?.[stubType] ?? `UNKNOWN_STUB_${stubType}`