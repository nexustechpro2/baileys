import crypto from 'crypto'
import * as Builders from '../Builders/index.js'
import { buildDispatch, buildPlugins, norm, handleGroupStatus, handleStatusMention, handlePollResult, handleNativeFlow, PRIMITIVE_SHORTCUTS, HANDLER_SHORTCUTS, attachAIRich } from '../Builders/index.js'
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
        const aiData = content.aiRich ?? content.airich ?? content.richResponse ?? content.AIRich ?? content.richMessage
        if (aiData) return result.sendRichFromObject(jid, Array.isArray(aiData) ? { ...content, parts: aiData } : { ...content, ...aiData }, options)

        // dispatch to registered builder handlers
        for (const [key, handler] of Object.entries(DISPATCH)) {
            if (key in content) return handler(result, jid, content, options, config)
        }
        // templateButtons check
        if (content.templateButtons) return result.sendMessage(jid, { text: content.text ?? content.caption ?? '', footer: content.footer, ...(content.image ? { image: content.image } : {}), nativeFlow: content.templateButtons.map(b => b.url ? { text: b.text, url: b.url } : b.call ? { text: b.text, call: b.call } : { text: b.text, id: b.id }) }, options)
        // carousel && card message check
        if (content.cards && !content.carouselMessage) return result.sendMessage(jid, { carouselMessage: { caption: content.text ?? content.caption ?? '', footer: content.footer, cards: content.cards } }, options)
        // bare nativeFlow array/object
        if (content.nativeFlow && !content.interactiveMessage) return handleNativeFlow(result, jid, content, options)

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