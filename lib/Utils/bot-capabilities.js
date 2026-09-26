import { proto } from '../../WAProto/index.js'
import { BOT_RENDERING_CONFIG_METADATA } from '../Defaults/index.js'

export const BotCapabilityType = proto.BotCapabilityMetadata.BotCapabilityType

const capabilityNames = new Set(Object.keys(BotCapabilityType).filter(n => Number.isNaN(Number(n))))

export const normalizeBotCapabilities = (capabilities = []) => {
    if (!Array.isArray(capabilities)) throw new TypeError('capabilities must be an array')
    const values = capabilities.map(c => {
        if (typeof c === 'string') {
            if (!capabilityNames.has(c)) throw new TypeError(`Unknown bot capability: ${c}`)
            return BotCapabilityType[c]
        }
        if (Number.isInteger(c) && BotCapabilityType[c] !== undefined) return c
        throw new TypeError(`Invalid bot capability: ${String(c)}`)
    })
    return [...new Set(values)]
}

export const buildBotCapabilityMetadata = (capabilities = []) => ({ capabilities: normalizeBotCapabilities(capabilities) })

// Standalone wrapper producing a bot richResponseMessage envelope.
// Use the AIRich builder for complex multi-section responses.
// Use this when you need a quick single-submessage rich envelope with specific capabilities.
export const buildBotRichResponse = ({ text, submessages, capabilities = [], botMetadata = {}, botJid = '867051314767696@bot', richResponse = {} } = {}) => {
    const resolved = submessages || (text == null ? [] : [{ messageType: proto.AIRichResponseSubMessageType.AI_RICH_RESPONSE_TEXT, messageText: String(text) }])
    return {
        messageContextInfo: {
            botMetadata: {
                ...botMetadata,
                capabilityMetadata: buildBotCapabilityMetadata(capabilities),
                botRenderingConfigMetadata: BOT_RENDERING_CONFIG_METADATA,
            }
        },
        botForwardedMessage: {
            message: {
                richResponseMessage: {
                    messageType: proto.AIRichResponseMessageType.AI_RICH_RESPONSE_TYPE_STANDARD,
                    submessages: resolved,
                    ...richResponse,
                    contextInfo: { isForwarded: true, forwardingScore: 1, forwardedAiBotMessageInfo: { botJid }, forwardOrigin: 4, ...(richResponse.contextInfo || {}) }
                }
            }
        }
    }
}

export const capability = (name) => {
    if (!capabilityNames.has(name)) throw new TypeError(`Unknown bot capability: ${name}`)
    return BotCapabilityType[name]
}
