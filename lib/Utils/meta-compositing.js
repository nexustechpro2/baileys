import { proto } from '../../WAProto/index.js'
import { BOT_RENDERING_CONFIG_METADATA } from '../Defaults/index.js'
import { BotCapabilityType, buildBotCapabilityMetadata } from './bot-capabilities.js'
import { delay } from './generics.js'

export const PlanningStepStatus = { IN_PROGRESS: 0, DONE: 1, FAILED: 2 }

export const buildProgressIndicator = (description, steps = [], estimatedMs) => {
    const stepsMetadata = steps.map(s => {
        const m = { statusTitle: s.title, status: s.status ?? PlanningStepStatus.IN_PROGRESS }
        if (s.body) m.statusBody = s.body
        if (s.isReasoning) m.isReasoning = true
        if (s.isEnhancedSearch) m.isEnhancedSearch = true
        return m
    })
    const indicator = { stepsMetadata }
    if (description) indicator.progressDescription = description
    if (estimatedMs != null) indicator.estimatedCompletionTime = estimatedMs
    return indicator
}

export const buildCompositingPlaceholder = ({ description = 'Thinking…', steps = [], estimatedMs, placeholderText = '', verificationMetadata } = {}) => {
    const progressIndicatorMetadata = buildProgressIndicator(description, steps, estimatedMs)
    const unifiedData = new TextEncoder().encode(JSON.stringify({
        response_id: crypto.randomUUID(),
        sections: placeholderText ? [{ view_model: { primitive: { text: placeholderText, inline_entities: [], __typename: 'GenAIMarkdownTextUXPrimitive' }, __typename: 'GenAISingleLayoutViewModel' } }] : []
    }))
    const capabilities = [BotCapabilityType.PROGRESS_INDICATOR, ...(steps.length ? [BotCapabilityType.AGENTIC_PLANNING] : [])]
    return {
        messageContextInfo: {
            botMetadata: {
                capabilityMetadata: buildBotCapabilityMetadata(capabilities),
                pluginMetadata: {},
                progressIndicatorMetadata,
                botRenderingConfigMetadata: BOT_RENDERING_CONFIG_METADATA,
                ...(verificationMetadata ? { verificationMetadata } : {})
            }
        },
        botForwardedMessage: {
            message: {
                richResponseMessage: {
                    messageType: proto.AIRichResponseMessageType.AI_RICH_RESPONSE_TYPE_STANDARD,
                    unifiedResponse: { data: unifiedData },
                    submessages: []
                }
            }
        }
    }
}

export const buildPlainPlaceholder = (description = 'Thinking…', steps = [], placeholderText = '') => {
    const lines = steps.map(s => {
        const icon = s.status === PlanningStepStatus.DONE ? '✓' : s.status === PlanningStepStatus.FAILED ? '✗' : '○'
        return `${icon} ${s.title}`
    }).join('\n')
    let text = `_${description}_`
    if (lines) text += `\n\n${lines}`
    if (placeholderText) text += `\n\n${placeholderText}`
    return { text }
}

export const metaTyping = async (sock, jid, { description = 'Thinking…', steps = [], estimatedMs, placeholderText = '' } = {}) => {
    await sock.sendPresenceUpdate('composing', jid)
    const pending = steps.map(s => ({ ...s, status: PlanningStepStatus.IN_PROGRESS }))
    return sock.sendMessage(jid, buildPlainPlaceholder(description, pending, placeholderText))
}

export const sendMetaComposited = async (sock, jid, content, { thinkingMs = 2000, description = 'Thinking…', steps = [], placeholderText = '', sendOptions = {} } = {}) => {
    const placeholder = await metaTyping(sock, jid, { description, steps, estimatedMs: thinkingMs, placeholderText })
    try { await delay(thinkingMs); if (placeholder?.key) await sock.sendMessage(jid, { delete: placeholder.key }) } catch (_) {}
    await sock.sendPresenceUpdate('paused', jid)
    return sock.sendMessage(jid, content, sendOptions)
}

export const buildSteps = (titles, status = PlanningStepStatus.IN_PROGRESS) => titles.map(title => ({ title, status }))
