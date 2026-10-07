import crypto from 'crypto'
import * as Builders from '../Builders/index.js'
import { buildDispatch, buildPlugins, norm, handleGroupStatus, handleStatusMention, handlePollResult, PRIMITIVE_SHORTCUTS, HANDLER_SHORTCUTS, attachAIRich } from '../Builders/index.js'
import { makeUsernameSocket } from './username.js'

export const makeMessageBuilderSocket = (config) => {
    const sock = makeUsernameSocket(config)
    const _send = sock.sendMessage.bind(sock)

    const ALL_BUILDERS = Object.values(Builders).filter(B => typeof B === 'function' && (B.dispatchKeys || B.shortcuts || B.name))

    const DISPATCH = buildDispatch(ALL_BUILDERS, {
        groupStatus: (sock, jid, content, opts, config) => handleGroupStatus(sock, jid, norm(content.groupStatus), config),
        statusMentionMessage: (sock, jid, content, opts, config) => handleStatusMention(sock, jid, norm(content.statusMentionMessage), config),
        pollResultMessage: (sock, jid, content) => handlePollResult(sock, jid, norm(content.pollResultMessage))
    })

    const PLUGINS = buildPlugins(ALL_BUILDERS, { ...PRIMITIVE_SHORTCUTS, ...HANDLER_SHORTCUTS })

    const result = { ...sock }

    for (const [name, factory] of Object.entries(PLUGINS)) result[name] = factory(result, config)

    result.sendMessage = async (jid, content, options = {}) => {
        // aiRich shorthand — multiple aliases supported
        const aiData = content.aiRich ?? content.airich ?? content.richResponse ?? content.AIRich
        if (aiData) return result.sendRichFromObject(jid, aiData, options)

        // dispatch to registered builder handlers
        for (const [key, handler] of Object.entries(DISPATCH)) {
            if (key in content) return handler(result, jid, content, options, config)
        }

        // bare nativeFlow array/object — wrap into interactiveMessage before sending
        if (content.nativeFlow && !content.interactiveMessage) {
            const buttons = Array.isArray(content.nativeFlow) ? content.nativeFlow : [content.nativeFlow]
            const { generateWAMessageFromContent } = await import('../Utils/index.js')
            const msg = await generateWAMessageFromContent(jid, {
                interactiveMessage: { body: { text: content.text || '' }, footer: { text: content.footer || '' }, header: { hasMediaAttachment: false }, nativeFlowMessage: { buttons } }
            }, { userJid: sock.user?.id })
            await result.relayMessage(jid, msg.message, { messageId: msg.key.id, aiLabel: !!(content.ai ?? content.aiLabel ?? options.aiLabel ?? options.ai ?? config.aiLabel ?? config.ai) })
            return msg
        }

        const { ai, aiLabel: contentAiLabel, ...cleanContent } = content
        const isAi = !!(ai ?? contentAiLabel ?? options.aiLabel ?? options.ai ?? config.aiLabel)
        if (isAi) {
            const secret = cleanContent.messageContextInfo?.messageSecret || crypto.randomBytes(32)
            cleanContent.messageContextInfo = { ...(cleanContent.messageContextInfo || {}), messageSecret: secret, supportPayload: JSON.stringify({ version: 2, is_ai_message: true, should_show_system_message: true, ticket_id: crypto.randomBytes(16).toString('hex') }) }
        }
        return _send(jid, isAi ? cleanContent : content, { ...options, aiLabel: isAi })
    }

    return attachAIRich(result, config)
}