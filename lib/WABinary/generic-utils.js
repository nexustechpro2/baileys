import { Boom } from '@hapi/boom'
import { randomBytes } from 'crypto'
import { proto } from '../../WAProto/index.js'

// ─── Node Traversal ───────────────────────────────────────────────────────────

export const getBinaryNodeChildren = (node, childTag) =>
    Array.isArray(node?.content) ? node.content.filter(item => item.tag === childTag) : []

export const getAllBinaryNodeChildren = ({ content }) =>
    Array.isArray(content) ? content : []

export const getBinaryNodeChild = (node, childTag) =>
    Array.isArray(node?.content) ? node.content.find(item => item.tag === childTag) : undefined

export const getBinaryNodeChildBuffer = (node, childTag) => {
    const child = getBinaryNodeChild(node, childTag)?.content
    return Buffer.isBuffer(child) || child instanceof Uint8Array ? child : undefined
}

export const getBinaryNodeChildString = (node, childTag) => {
    const child = getBinaryNodeChild(node, childTag)?.content
    if (Buffer.isBuffer(child) || child instanceof Uint8Array) return Buffer.from(child).toString('utf-8')
    if (typeof child === 'string') return child
}

export const getBinaryNodeChildUInt = (node, childTag, length) => {
    const buff = getBinaryNodeChildBuffer(node, childTag)
    return buff ? bufferToUInt(buff, length) : undefined
}

function bufferToUInt(e, t) {
    let a = 0
    for (let i = 0; i < t; i++) a = 256 * a + e[i]
    return a
}

// ─── Node Validation ──────────────────────────────────────────────────────────

export const assertNodeErrorFree = (node) => {
    const errNode = getBinaryNodeChild(node, 'error')
    if (errNode) {
        const errorCode = +errNode.attrs.code
        if (errorCode === 429) {
            const error = new Boom('Rate limit', { data: 429 })
            error.isRateLimit = true
            throw error
        }
        throw new Boom(errNode.attrs.text || 'Unknown error', { data: errorCode })
    }
}

export const reduceBinaryNodeToDictionary = (node, tag) => {
    const nodes = getBinaryNodeChildren(node, tag)
    return nodes.reduce((dict, { attrs }) => {
        if (typeof attrs.name === 'string') dict[attrs.name] = attrs.value || attrs.config_value
        else dict[attrs.config_code] = attrs.value || attrs.config_value
        return dict
    }, {})
}

export const getBinaryNodeMessages = ({ content }) => {
    const msgs = []
    if (Array.isArray(content)) {
        for (const item of content) {
            if (item.tag === 'message') msgs.push(proto.WebMessageInfo.decode(item.content).toJSON())
        }
    }
    return msgs
}

// ─── Button Type Detection ────────────────────────────────────────────────────

export const getBinaryFilteredButtons = (nodeContent) => {
    if (!Array.isArray(nodeContent)) return false
    return nodeContent.some(a =>
        ['native_flow'].includes(a?.content?.[0]?.content?.[0]?.tag) ||
        ['interactive', 'buttons', 'list'].includes(a?.content?.[0]?.tag) ||
        ['hsm', 'biz'].includes(a?.tag)
    )
}

export const getButtonType = (message) => {
    if (message.listMessage) return 'list'
    if (message.buttonsMessage) return 'buttons'
    const interactiveMsg = message.interactiveMessage || message.interactive
    if (!interactiveMsg?.nativeFlowMessage) return null
    const btn = interactiveMsg?.nativeFlowMessage?.buttons?.[0]?.name
    if (['review_and_pay', 'review_order', 'payment_info', 'payment_status', 'payment_method'].includes(btn)) return btn
    if (interactiveMsg?.nativeFlowMessage?.buttons?.length || interactiveMsg?.nativeFlowMessage) return 'interactive'
    return null
}

// ─── Biz Binary Node (canonical single implementation) ────────────────────────

const FLOWS_MAP = new Set(['mpm', 'catalog_message', 'send_location', 'call_permission_request', 'wa_payment_transaction_details', 'automated_greeting_message_view_catalog', 'card_message', 'order_status', 'track_order', 'reorder', 'cancel_order', 'clear_chat', 'navigateToScreen', 'payment_status', 'payment_method', 'flow', 'flow_action', 'voice_call', 'video_call_button', 'otp_button', 'authentication_button', 'cta_reminder', 'cta_cancel_reminder'])

const ORDER_RESPONSE_ALIAS = {
    review_and_pay: 'order_details', review_order: 'order_status',
    payment_info: 'payment_info', payment_status: 'payment_status',
    payment_method: 'payment_method', order_details: 'order_details',
    order_status: 'order_status', track_order: 'track_order',
    reorder: 'reorder', cancel_order: 'cancel_order'
}

const NATIVE_FLOW_ATTR = { type: 'native_flow', v: '1' }
const MIXED_NATIVE_FLOW = { tag: 'interactive', attrs: NATIVE_FLOW_ATTR, content: [{ tag: 'native_flow', attrs: { v: '9', name: 'mixed' } }] }
const LIST_TYPE_CONTENT = { tag: 'list', attrs: { v: '2', type: 'product_list' } }
const DECISION_SOURCE = [{ tag: 'decision_source', attrs: { value: 'df' } }]

export const getBizBinaryNode = (message) => {
    const flowMsg = message.interactiveMessage?.nativeFlowMessage
    const firstButtonName = flowMsg?.buttons?.[0]?.name
    const bizAttrs = { actual_actors: '2', host_storage: '2', privacy_mode_ts: `${Date.now() / 1000 | 0}` }
    const qualityContent = {
        tag: 'quality_control',
        attrs: { decision_id: randomBytes(20).toString('hex'), source_type: 'third_party' },
        content: DECISION_SOURCE
    }

    if (firstButtonName && ORDER_RESPONSE_ALIAS[firstButtonName]) {
        bizAttrs.native_flow_name = ORDER_RESPONSE_ALIAS[firstButtonName]
        return { tag: 'biz', attrs: bizAttrs, content: [qualityContent] }
    }
    if (firstButtonName && FLOWS_MAP.has(firstButtonName)) {
        return {
            tag: 'biz', attrs: bizAttrs,
            content: [
                { tag: 'interactive', attrs: NATIVE_FLOW_ATTR, content: [{ tag: 'native_flow', attrs: { v: '2', name: firstButtonName } }] },
                qualityContent
            ]
        }
    }
    if (flowMsg || message.buttonsMessage || message.templateMessage) {
        return { tag: 'biz', attrs: bizAttrs, content: [MIXED_NATIVE_FLOW, qualityContent] }
    }
    if (message.listMessage) {
        return { tag: 'biz', attrs: bizAttrs, content: [LIST_TYPE_CONTENT, qualityContent] }
    }
    return { tag: 'biz', attrs: bizAttrs, content: [qualityContent] }
}

// Legacy alias — kept for back-compat, delegates to canonical getBizBinaryNode
export const getButtonArgs = (message) => {
    const msgContent = message.viewOnceMessage?.message || message
    const interactiveMsg = msgContent.interactiveMessage || msgContent.interactive
    const flowMsg = interactiveMsg?.nativeFlowMessage
    const btnFirst = flowMsg?.buttons?.[0]?.name
    const ts = Math.floor(Date.now() / 1000) - 77980457
    const order_response_name = { review_and_pay: 'order_details', review_order: 'order_status', payment_info: 'payment_info', payment_status: 'payment_status', payment_method: 'payment_method' }
    const flow_name = { cta_catalog: 'cta_catalog', mpm: 'mpm', call_permission_request: 'call_permission_request', call_request: 'call_permission_request', view_catalog: 'automated_greeting_message_view_catalog', automated_greeting_message_view_catalog: 'automated_greeting_message_view_catalog', wa_pay_detail: 'wa_payment_transaction_details', wa_payment_transaction_details: 'wa_payment_transaction_details', send_location: 'send_location', open_webview: 'open_webview', galaxy_message: 'galaxy_message' }
    if (btnFirst && order_response_name[btnFirst]) return [{ tag: 'biz', attrs: { native_flow_name: order_response_name[btnFirst] }, content: [] }]
    if (flowMsg || msgContent.buttonsMessage) {
        const name = (btnFirst && flow_name[btnFirst]) ? flow_name[btnFirst] : 'mixed'
        return [{ tag: 'biz', attrs: { actual_actors: '2', host_storage: '2', privacy_mode_ts: `${ts}` }, content: [{ tag: 'engagement', attrs: { customer_service_state: 'open', conversation_state: 'open' } }, { tag: 'interactive', attrs: { type: 'native_flow', v: '1' }, content: [{ tag: 'native_flow', attrs: { v: '9', name }, content: [] }] }] }]
    }
    if (msgContent.listMessage) return [{ tag: 'biz', attrs: { actual_actors: '2', host_storage: '2', privacy_mode_ts: `${ts}` }, content: [{ tag: 'engagement', attrs: { customer_service_state: 'open', conversation_state: 'open' } }] }]
    return [{ tag: 'biz', attrs: { actual_actors: '2', host_storage: '2', privacy_mode_ts: `${ts}` }, content: [{ tag: 'engagement', attrs: { customer_service_state: 'open', conversation_state: 'open' } }] }]
}

// ─── Debug Utilities ──────────────────────────────────────────────────────────

const tabs = (n) => '\t'.repeat(n)

export const binaryNodeToString = (node, i = 0) => {
    if (!node) return node
    if (typeof node === 'string') return tabs(i) + node
    if (node instanceof Uint8Array) return tabs(i) + Buffer.from(node).toString('hex')
    if (Array.isArray(node)) return node.map(x => tabs(i + 1) + binaryNodeToString(x, i + 1)).join('\n')
    const children = binaryNodeToString(node.content, i + 1)
    const tag = `<${node.tag} ${Object.entries(node.attrs || {}).filter(([, v]) => v !== undefined).map(([k, v]) => `${k}='${v}'`).join(' ')}`
    const content = children ? `>\n${children}\n${tabs(i)}</${node.tag}>` : '/>'
    return tag + content
}
