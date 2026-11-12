import { proto } from '../../WAProto/index.js'
import { generateWAMessageFromContent, generateWAMessageContent, SCALAR_KINDS, SAFE_MSG_TYPES, USER_MEDIA_KEYS } from '../Utils/index.js'
import { getBizBinaryNode } from '../WABinary/index.js'
import { BaseBuilder } from './base.js'

export const buildAutoBuilders = handBuiltKeys => {
    const result = []
    for (const [fieldName, fd] of Object.entries(proto.Message.fields)) {
        if (fd.type !== 'msg') continue
        const sub = proto.Message[fd.msgType]
        if (!sub?.fields) continue
        if (sub.fields?.message?.msgType === 'Message') continue
        const inputKey = fieldName.replace(/Message$/, '')
        if (handBuiltKeys.has(inputKey) || handBuiltKeys.has(fieldName) || USER_MEDIA_KEYS.has(inputKey)) continue
        const isScalar = Object.values(sub.fields).every(f =>
            SCALAR_KINDS.has(f.type) || (f.type === 'msg' && SAFE_MSG_TYPES.has(f.msgType))
        )
        if (!isScalar) continue
        const className = inputKey.charAt(0).toUpperCase() + inputKey.slice(1)
        const BuilderClass = class extends BaseBuilder {
            static dispatchKeys = [fieldName, ...(fieldName !== inputKey ? [inputKey] : [])]
            async send(jid, opts = {}) {
                const content = await generateWAMessageContent(
                    { [fieldName]: this.data },
                    { userJid: this.client.user?.id, quoted: opts.quoted, waUploadToServer: this.client.waUploadToServer, jid }
                )
                const msg = await generateWAMessageFromContent(jid, content, { userJid: this.client.user?.id, quoted: opts.quoted, waUploadToServer: this.client.waUploadToServer })
                const bizNode = getBizBinaryNode(msg.message)
                await this.client.relayMessage(jid, msg.message, { messageId: msg.key.id, additionalNodes: bizNode ? [bizNode] : [] })
                return msg
            }
        }
        Object.defineProperty(BuilderClass, 'name', { value: className })
        result.push(BuilderClass)
    }
    return result
}

let _autoBuilders = null
export const getAutoBuilders = (handBuilt, messageHandlerKeys = []) => {
    if (_autoBuilders) return _autoBuilders
    const handBuiltKeys = new Set([
        ...messageHandlerKeys,
        ...handBuilt.flatMap(B =>
            B?.dispatchKeys?.length ? B.dispatchKeys : B?.name ? [B.name.replace(/Builder$/, '').toLowerCase()] : []
        )
    ])
    _autoBuilders = buildAutoBuilders(handBuiltKeys)
    return _autoBuilders
}