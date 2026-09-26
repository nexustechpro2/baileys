import { proto } from '../../WAProto/index.js'
import { randomBytes } from 'crypto'
import { AIRich, aiRichFromObject, Button, Interactive, Album, Poll, Carousel, Payment, Order, Event, StickerPack, handleGroupStatus, handleStatusMention, handlePollResult } from '../Builders/index.js'
import { generateMessageIDV2, generateWAMessageFromContent, generateWAMessage, delay } from '../Utils/index.js'
import { generateTableContent, generateListContent, generateCodeBlockContent, generateLatexContent, captureUnifiedResponse, generateUnifiedResponseContent } from '../Utils/message-composer.js'
import { buildBotRichResponse, BotCapabilityType } from '../Utils/bot-capabilities.js'
import { replayPlanning, replayPlanningOnly, buildReasoningSteps, buildSearchSteps, mixedSteps } from '../Utils/bot-planning-replay.js'
import { metaTyping, sendMetaComposited, PlanningStepStatus, buildSteps } from '../Utils/meta-compositing.js'
import { makeWhatsAppFlowButton } from '../Utils/native-flow.js'
import { isJidGroup, isJidMetaAI, jidNormalizedUser } from '../WABinary/index.js'
import { makeUsernameSocket } from './username.js'

const META_AI_BOT_JID = '867051314767696@bot'
const STATUS_JID = 'status@broadcast'

// Resolve bot participant JIDs inside an AI group so the response matcher handles LID addressing.
const collectMetaAIBotJids = async (sock, jid, botUser) => {
    const candidates = new Set([botUser])
    if (!isJidGroup(jid)) return candidates
    const botNumber = jidNormalizedUser(botUser).split('@')[0]
    try {
        const meta = await sock.groupMetadata(jid)
        for (const p of meta.participants || []) {
            const idNum = jidNormalizedUser(p.id).split('@')[0]
            const pnNum = p.phoneNumber ? jidNormalizedUser(p.phoneNumber).split('@')[0] : undefined
            if (pnNum === botNumber || idNum === botNumber || isJidMetaAI(p.id)) candidates.add(p.id)
        }
    } catch (_) { }
    return candidates
}

const stripDevice = (jid) => String(jid || '').replace(/:\d+$/, '')

const isMetaAIResponse = (msg, chatJid, promptId, botJids) => {
    if (!msg?.key || msg.key.fromMe || msg.key.remoteJid !== chatJid) return false
    const sender = stripDevice(msg.key.participant || msg.key.remoteJid)
    if (isJidMetaAI(sender)) return true
    for (const b of botJids) if (jidNormalizedUser(stripDevice(b)) === jidNormalizedUser(sender)) return true
    if (promptId) {
        const inner = msg.message ? Object.values(msg.message)[0] : undefined
        const stanzaId = inner?.contextInfo?.stanzaId || msg.message?.contextInfo?.stanzaId
        if (stanzaId === promptId) return true
    }
    return false
}

export const makeMessageBuilderSocket = (config) => {
    const sock = makeUsernameSocket(config)
    const _send = sock.sendMessage.bind(sock)

    // ─── relayRichMessage ─────────────────────────────────────────────────────
    // Sends a rich message and, if it carries a richResponseMessage, emits an
    // edit stanza so legacy clients that need the edit-replay render it correctly.
    const relayRichMessage = async (jid, fullMsg, options = {}) => {
        const relayOpts = {
            messageId: fullMsg.key.id,
            useCachedGroupMetadata: options.useCachedGroupMetadata,
            statusJidList: options.statusJidList,
            ...(options.relayOptions || {})
        }
        await sock.relayMessage(jid, fullMsg.message, relayOpts)
        const hasRich = !!fullMsg.message?.botForwardedMessage?.message?.richResponseMessage
        if (options.renderRichResponse !== false && (hasRich || options.forceRichEdit)) {
            const editContent = proto.Message.fromObject({
                botForwardedMessage: {
                    message: {
                        protocolMessage: {
                            key: { remoteJid: jid, fromMe: true, id: fullMsg.key.id },
                            type: proto.Message.ProtocolMessage.Type.MESSAGE_EDIT,
                            editedMessage: fullMsg.message
                        }
                    }
                }
            })
            const editMsg = generateWAMessageFromContent(jid, editContent, {
                userJid: sock.user?.id,
                messageId: generateMessageIDV2(sock.user?.id || jid)
            })
            await sock.relayMessage(jid, editMsg.message, { ...relayOpts, messageId: editMsg.key.id })
        }
        return fullMsg
    }

    const result = {
        ...sock,
        relayRichMessage,
        // ─── Builder shortcuts ─────────────────────────────────────────────
        airich: (opts) => new AIRich(result, opts),
        button: (opts) => new Button(result, opts),
        interactive: () => new Interactive(result),
        album: () => new Album(result),
        poll: () => new Poll(result),
        carousel: () => new Carousel(result),
        payment: () => new Payment(result),
        order: () => new Order(result),
        event: () => new Event(result),
        stickerpack: () => new StickerPack(result),
    }

    // ─── sendMessage override ─────────────────────────────────────────────────
    result.sendMessage = async (jid, content, options = {}) => {
        const aiData = content.aiRich ?? content.airich ?? content.richResponse ?? content.AIRich
        if (aiData) return aiRichFromObject(result, jid, aiData, options)

        if ('albumMessage' in content) {
            const album = new Album(result)
            album.add(Array.isArray(content.albumMessage) ? content.albumMessage : [content.albumMessage])
            if (content.albumDelay) album.setDelay(content.albumDelay)
            return album.send(jid, options)
        }
        if ('carouselMessage' in content) {
            const { caption, footer, cards } = content.carouselMessage
            const c = new Carousel(result)
            if (caption) c.setCaption(caption)
            if (footer) c.setFooter(footer)
                ; (cards ?? []).forEach(card => c.card(card))
            return c.send(jid, options)
        }
        if ('interactiveMessage' in content) return new Interactive(result).from(content.interactiveMessage).send(jid, options)
        if ('requestPaymentMessage' in content) return new Payment(result).from(content.requestPaymentMessage).send(jid, options)
        if ('orderMessage' in content) return new Order(result).from(content.orderMessage).send(jid, options)
        if ('eventMessage' in content) return new Event(result).from(content.eventMessage).send(jid, options)
        if ('stickerPack' in content) return new StickerPack(result).from(content.stickerPack).send(jid, options)
        if ('stickerPackMessage' in content) return new StickerPack(result).from(content.stickerPackMessage).send(jid, options)
        if ('groupStatus' in content) return handleGroupStatus(result, jid, content.groupStatus, config)
        if ('statusMentionMessage' in content) return handleStatusMention(result, jid, content.statusMentionMessage, config)
        if ('pollResultMessage' in content) return handlePollResult(result, jid, content.pollResultMessage)

        // native-flow shorthand: { nativeFlow: [...buttons] }
        if (content.nativeFlow && !content.interactiveMessage) {
            const buttons = Array.isArray(content.nativeFlow) ? content.nativeFlow : [content.nativeFlow]
            const b = new Button(result)
            if (content.text) b.setBody(content.text)
            if (content.footer) b.setFooter(content.footer)
            for (const btn of buttons) {
                if (btn.name && btn.buttonParamsJson) b['#buttons'] ? b['#buttons'].push(btn) : (() => { b.setParams({}); b['#mode'] = 'native'; })()
                b._rawButtons = b._rawButtons || []
                b._rawButtons.push(btn)
            }
            // Fast path: build the interactive directly
            return generateWAMessageFromContent(jid, {
                interactiveMessage: {
                    body: { text: content.text || '' },
                    footer: { text: content.footer || '' },
                    header: { hasMediaAttachment: false },
                    nativeFlowMessage: { buttons }
                }
            }, { userJid: sock.user?.id }).then(msg => {
                result.relayMessage(jid, msg.message, { messageId: msg.key.id })
                return msg
            })
        }

        return _send(jid, content, options)
    }

    // ─── AIRich capture/relay ─────────────────────────────────────────────────
    result.captureAiRich = (msg) => {
        const rich = msg?.botForwardedMessage?.message?.richResponseMessage ?? msg?.richResponseMessage
        if (!rich?.unifiedResponse?.data) return null
        return {
            submessages: rich.submessages ?? [],
            sections: JSON.parse(Buffer.from(rich.unifiedResponse.data, 'base64').toString()),
            contextInfo: rich.contextInfo ?? {},
            messageType: rich.messageType ?? 1,
        }
    }

    result.relayAiRich = (jid, captured, opts = {}) => {
        const r = new AIRich(result)
        if (captured.sections?.response_id) r.setResponseId(captured.sections.response_id)
        return r.loadFrom({
            botForwardedMessage: {
                message: {
                    richResponseMessage: {
                        submessages: captured.submessages,
                        unifiedResponse: { data: Buffer.from(JSON.stringify(captured.sections)) },
                        contextInfo: captured.contextInfo,
                        messageType: captured.messageType,
                    },
                },
            },
        }).send(jid, opts)
    }

    // ─── AIRich send shortcuts ────────────────────────────────────────────────
    const q = (quoted) => quoted ? { quoted } : {}

    result.sendRichMessage = (jid, data, quoted, opts = {}) => result.sendMessage(jid, { aiRich: data }, { ...q(quoted), ...opts })
    result.sendCodeBlock = (jid, code, quoted, opts = {}) => result.sendMessage(jid, { aiRich: { code, language: opts.language ?? 'javascript', title: opts.title } }, q(quoted))
    result.sendCodeBlockV2 = (jid, code, quoted, opts = {}) => result.sendMessage(jid, { aiRich: { text: opts.text, code, language: opts.language ?? '', title: opts.title } }, q(quoted))
    result.sendTable = (jid, title, headers, rows, quoted, opts = {}) => result.sendMessage(jid, { aiRich: { title, table: [headers, ...rows] } }, q(quoted))
    result.sendTableV2 = (jid, tableArray, quoted, opts = {}) => result.sendMessage(jid, { aiRich: { text: opts.text, title: opts.headerText, table: tableArray } }, q(quoted))
    result.sendList = (jid, title, items, quoted, opts = {}) => result.sendMessage(jid, { aiRich: { title, table: [['Key', 'Value'], ...items] } }, q(quoted))
    result.sendLink = (jid, text, links, quoted, opts = {}) => result.sendMessage(jid, { aiRich: { title: opts.headerText, text, sources: links.map(url => ({ url, title: url, subtitle: new URL(url).hostname })) } }, q(quoted))
    result.sendLinkV2 = (jid, text, links, quoted, opts = {}) => result.sendMessage(jid, { aiRich: { title: opts.headerText, text, sources: links } }, q(quoted))
    result.sendLatex = (jid, expressions, quoted, opts = {}) => result.sendMessage(jid, { aiRich: { text: opts.text, title: opts.headerText, latex: expressions } }, q(quoted))

    // ─── Rich table/code/latex via message-composer (proto submessage path) ───
    result.sendRichTable = async (jid, title, headers, rows, quoted, opts = {}) => {
        const { message, messageId } = generateTableContent(title, headers, rows, quoted, opts)
        const full = generateWAMessageFromContent(jid, message, { userJid: sock.user?.id, messageId: opts.messageId || messageId })
        return relayRichMessage(jid, full, opts)
    }

    result.sendRichList = async (jid, title, items, quoted, opts = {}) => {
        const { message, messageId } = generateListContent(title, items, quoted, opts)
        const full = generateWAMessageFromContent(jid, message, { userJid: sock.user?.id, messageId: opts.messageId || messageId })
        return relayRichMessage(jid, full, opts)
    }

    result.sendRichCode = async (jid, code, quoted, opts = {}) => {
        const { message, messageId } = generateCodeBlockContent(code, quoted, opts)
        const full = generateWAMessageFromContent(jid, message, { userJid: sock.user?.id, messageId: opts.messageId || messageId })
        return relayRichMessage(jid, full, opts)
    }

    result.sendRichLatex = async (jid, quoted, opts = {}) => {
        const { message, messageId } = generateLatexContent(quoted, { expressions: [], ...opts })
        const full = generateWAMessageFromContent(jid, message, { userJid: sock.user?.id, messageId: opts.messageId || messageId })
        return relayRichMessage(jid, full, opts)
    }

    // Render LaTeX using codecogs.com — sends expressions as rich submessages with CDN image URLs.
    result.sendRichLatexImage = async (jid, opts = {}) => {
        const { text, expressions = [], headerText, footer } = opts
        const rendered = expressions.map(expr => {
            const latex = expr.latexExpression || expr.expression || expr
            const url = `https://latex.codecogs.com/png.latex?${encodeURIComponent(latex).replace(/'/g, '%27')}`
            return { latexExpression: latex, url, width: expr.width || 400, height: expr.height || 100 }
        })
        const { message, messageId } = generateLatexContent(null, { text, expressions: rendered, headerText, footer })
        const full = generateWAMessageFromContent(jid, message, { userJid: sock.user?.id, messageId: opts.messageId || messageId })
        return relayRichMessage(jid, full, opts)
    }

    result.captureAndResendRichResponse = async (jid, metaAiMsg, quoted, opts = {}) => {
        const captured = captureUnifiedResponse(metaAiMsg)
        if (!captured) throw new Error('captureAndResendRichResponse: no unifiedResponse data in message')
        const { message, messageId } = generateUnifiedResponseContent(quoted, captured)
        const full = generateWAMessageFromContent(jid, message, { userJid: sock.user?.id, messageId: opts.messageId || messageId })
        return relayRichMessage(jid, full, opts)
    }

    // ─── Bot planning ─────────────────────────────────────────────────────────

    // Sends a planning/execution-plan rich response with WAProto capability metadata.
    result.sendBotPlanning = async (jid, content = {}, opts = {}) => {
        const { text = 'Execution plan', steps = [], queryPlan = true, botJid = META_AI_BOT_JID } = content
        const submessages = [
            { messageType: proto.AIRichResponseSubMessageType.AI_RICH_RESPONSE_TEXT, messageText: text },
            ...steps.map(s => ({
                messageType: proto.AIRichResponseSubMessageType.AI_RICH_RESPONSE_TEXT,
                messageText: typeof s === 'string' ? s : `${s.title || s.name || 'Step'}${s.body ? `: ${s.body}` : ''}`
            }))
        ]
        const wrapped = buildBotRichResponse({
            botJid, submessages,
            capabilities: [BotCapabilityType.AGENTIC_PLANNING, ...(queryPlan ? [BotCapabilityType.QUERY_PLAN] : [])]
        })
        const full = await generateWAMessageFromContent(jid, wrapped, { userJid: sock.user?.id, messageId: opts.messageId || generateMessageIDV2(sock.user?.id) })
        return relayRichMessage(jid, full, opts)
    }

    // Sends a structured bot plan with per-step status using BotProgressIndicatorMetadata.
    result.sendBotPlan = async (jid, content = {}, opts = {}) => {
        const { text = 'Execution plan', title = 'Execution plan', steps = [], estimatedCompletionTime, botJid = META_AI_BOT_JID } = content
        if (!Array.isArray(steps) || steps.length === 0) throw new Error('sendBotPlan requires at least one step')
        const statusEnum = proto.BotProgressIndicatorMetadata.BotPlanningStepMetadata.PlanningStepStatus
        const normalizedSteps = steps.map((s, i) => ({
            statusTitle: String(s.title || s.name || `Step ${i + 1}`),
            statusBody: String(s.body || s.description || ''),
            status: s.status === 'executing' ? statusEnum.EXECUTING
                : (s.status === 'finished' || s.status === 'completed') ? statusEnum.FINISHED
                    : statusEnum.PLANNED,
            isReasoning: s.isReasoning === true,
            isEnhancedSearch: s.isEnhancedSearch === true,
        }))
        const wrapped = {
            messageContextInfo: {
                botMetadata: {
                    capabilityMetadata: { capabilities: [proto.BotCapabilityMetadata.BotCapabilityType.AGENTIC_PLANNING, proto.BotCapabilityMetadata.BotCapabilityType.QUERY_PLAN] },
                    progressIndicatorMetadata: { progressDescription: title, stepsMetadata: normalizedSteps, ...(estimatedCompletionTime ? { estimatedCompletionTime } : {}) }
                }
            },
            botForwardedMessage: {
                message: {
                    richResponseMessage: {
                        messageType: 1,
                        submessages: [{ messageType: 2, messageText: text }],
                        contextInfo: { isForwarded: true, forwardingScore: 1, forwardedAiBotMessageInfo: { botJid }, forwardOrigin: 4 }
                    }
                }
            }
        }
        const full = await generateWAMessageFromContent(jid, wrapped, { userJid: sock.user?.id, messageId: opts.messageId || generateMessageIDV2(sock.user?.id) })
        await sock.relayMessage(jid, full.message, { messageId: full.key.id })
        return full
    }

    // Live planning animation — shows steps resolving one-by-one, then sends final message.
    result.replayPlanning = (jid, steps, finalContent, opts) => replayPlanning(result, jid, steps, finalContent, opts)
    result.replayPlanningOnly = (jid, steps, opts) => replayPlanningOnly(result, jid, steps, opts)
    result.metaTyping = (jid, opts) => metaTyping(result, jid, opts)
    result.sendMetaComposited = (jid, content, opts) => sendMetaComposited(result, jid, content, opts)
    result.buildReasoningSteps = buildReasoningSteps
    result.buildSearchSteps = buildSearchSteps
    result.mixedSteps = mixedSteps
    result.buildSteps = buildSteps
    result.PlanningStepStatus = PlanningStepStatus

    // ─── sendMetaAI ───────────────────────────────────────────────────────────
    // Sends a prompt to the Meta AI bot. Accepts (jid, text, opts) or (text, opts).
    result.sendMetaAI = async (a, b, c = {}) => {
        let text, opts = c, yourJid
        if (typeof b === 'string') { text = b; yourJid = a }
        else { text = a; opts = b || {}; yourJid = opts.yourJid || '' }
        const jid = opts.jid || META_AI_BOT_JID
        const threadId = opts.threadId || generateMessageIDV2(yourJid)
        const now = Date.now()
        const senderKeyHash = opts.senderKeyHash || randomBytes(8).toString('base64')
        const message = {
            extendedTextMessage: proto.Message.ExtendedTextMessage.fromObject({
                text,
                previewType: 'NONE',
                contextInfo: proto.ContextInfo.fromObject({ botMessageSharingInfo: { botEntryPointOrigin: 'FAVICON', forwardScore: 0 } }),
                inviteLinkGroupTypeV2: 'DEFAULT'
            }),
            messageContextInfo: proto.MessageContextInfo.fromObject({
                deviceListMetadata: { senderKeyHash, senderTimestamp: opts.senderTimestamp || String(Math.floor(now / 1000)) },
                deviceListMetadataVersion: 2,
                messageSecret: opts.messageSecret || randomBytes(32),
                botMetadata: {
                    botModeSelectionMetadata: { overrideMode: [0] },
                    botThreadInfo: { serverInfo: { title: text.substring(0, 50) }, clientInfo: { type: 'DEFAULT' } },
                    botRenderingConfigMetadata: { bloksVersioningId: '1eb86e6f4117d052e6bab62fe758a2e2af43747b85c5c1a886c8262bac462ea4', pixelDensity: 2.625 },
                    ...(opts.conversationContext?.length ? { aiConversationContext: opts.conversationContext } : {})
                },
                threadId: [{ threadType: 'AI_THREAD', threadKey: { remoteJid: '0002@s.whatsapp.net', fromMe: true, id: threadId } }]
            })
        }
        const msgId = generateMessageIDV2(yourJid)
        await sock.relayMessage(jid, message, { messageId: msgId, ...(opts.quoted ? { quoted: opts.quoted } : {}) })
        return msgId
    }

    // ─── aiPrompt ─────────────────────────────────────────────────────────────
    // Sends a prompt to Meta AI and resolves with the full decrypted bot response.
    result.aiPrompt = async (jid, prompt, options = {}) => {
        const { timeout = 60_000, onPartial, botUser = META_AI_BOT_JID, mentions = [], ...sendOpts } = options
        if (!jid || typeof prompt !== 'string' || !prompt.trim()) throw new Error('aiPrompt requires a chat JID and a non-empty prompt')
        const botJids = await collectMetaAIBotJids(result, jid, botUser)
        const allMentions = [...new Set([...mentions, ...botJids])]
        return new Promise((resolve, reject) => {
            let promptId, settled = false
            const cleanup = () => { clearTimeout(timer); sock.ev.off('messages.upsert', onUpsert); if (onPartial) sock.ev.off('messages.update', onUpdate) }
            const settle = (fn, val) => { if (settled) return; settled = true; cleanup(); fn(val) }
            const timer = setTimeout(() => settle(reject, new Error(`aiPrompt timed out after ${timeout}ms in ${jid}`)), timeout)
            const onUpsert = ({ messages }) => { for (const msg of messages) if (isMetaAIResponse(msg, jid, promptId, botJids)) { settle(resolve, msg); return } }
            const onUpdate = ({ updates }) => { if (!onPartial) return; for (const u of updates) { if (!u.key || u.key.fromMe || u.key.remoteJid !== jid) continue; const sender = jidNormalizedUser(stripDevice(u.key.participant || u.key.remoteJid)); const isBot = isJidMetaAI(sender) || [...botJids].some(b => jidNormalizedUser(stripDevice(b)) === sender); if (isBot && u.message) onPartial(u.message, u.key) } }
            sock.ev.on('messages.upsert', onUpsert)
            if (onPartial) sock.ev.on('messages.update', onUpdate);
            (async () => {
                try {
                    const content = { text: prompt, ...(isJidGroup(jid) ? { mentions: allMentions } : {}), ...sendOpts }
                    const full = await generateWAMessage(jid, content, { userJid: sock.user?.id, messageId: sendOpts.messageId || generateMessageIDV2(sock.user?.id) })
                    await sock.relayMessage(jid, full.message, { messageId: full.key.id })
                    if (config.emitOwnEvents) process.nextTick(() => sock.ev.emit('messages.upsert', { messages: [full], type: 'append' }))
                    promptId = full.key.id
                } catch (err) { settle(reject, err) }
            })()
        })
    }

    // ─── sendBulkReactions ────────────────────────────────────────────────────
    result.sendBulkReactions = async (jid, messageId, emoji, count = 1, fake = false) => {
        const max = Math.min(count, 1000)
        if (fake) {
            // Emit fake reaction events locally — no actual sends, for testing counters
            const events = []
            for (let i = 0; i < max; i++) {
                const fakeSender = `${Math.floor(Math.random() * 999999999)}${i}@s.whatsapp.net`
                events.push({ key: { remoteJid: jid, fromMe: false, id: messageId, participant: fakeSender }, reaction: { key: { remoteJid: jid, fromMe: false, id: messageId }, text: emoji, senderTimestampMs: Date.now() + i } })
            }
            sock.ev.emit('messages.reaction', events)
            return { sent: max, fake, jid }
        }
        for (let i = 0; i < max; i++) {
            try { await result.sendMessage(jid, { react: { text: emoji, key: { remoteJid: jid, fromMe: false, id: messageId } } }); await delay(100) } catch (_) { }
        }
        return { sent: max, fake, jid }
    }

    // ─── sendAsMimic ─────────────────────────────────────────────────────────
    // Sends content appearing to come from mimicJid. Requires admin: true permission.
    result.sendAsMimic = async (jid, content, mimicJid, options = {}) => {
        if (!options.admin && !options.mimicPermission) throw new Error('sendAsMimic requires admin: true')
        const msgId = generateMessageIDV2(sock.user?.id)
        const full = await generateWAMessageFromContent(jid, content, { userJid: sock.user?.id, ...options })
        full.key = { remoteJid: jid, fromMe: false, id: msgId, participant: mimicJid }
        await sock.relayMessage(jid, full.message, { messageId: msgId, ...(options.additionalAttributes ? { additionalAttributes: options.additionalAttributes } : {}) })
        return full
    }

    // ─── sendStatus ───────────────────────────────────────────────────────────
    // Sends a WhatsApp status update. Requires statusJidList (or resolves from sock.statusJidList).
    result.sendStatus = async (content, options = {}) => {
        const provided = options.statusJidList || content?.statusJidList || sock.statusJidList || []
        if (!provided.length) throw new Error('sendStatus requires statusJidList')
        return result.sendMessage(STATUS_JID, { ...content, status: true }, { ...options, broadcast: true, statusJidList: provided })
    }

    // ─── sendBotToolResult ────────────────────────────────────────────────────
    result.sendBotToolResult = async (jid, content = {}, opts = {}) => {
        const { text = 'Tool result', toolCallId = `tool-${Date.now()}`, resolutionData, resolutionDataSerialized, botJid = META_AI_BOT_JID } = content
        const wrapped = buildBotRichResponse({
            text, botJid,
            capabilities: [BotCapabilityType.AGENTIC_PLANNING, BotCapabilityType.QUERY_PLAN],
            botMetadata: { resolvedToolCallMetadata: { toolCallId, resolutionDataSerialized: resolutionDataSerialized ?? JSON.stringify(resolutionData ?? {}) } }
        })
        const full = await generateWAMessageFromContent(jid, wrapped, { userJid: sock.user?.id, messageId: opts.messageId || generateMessageIDV2(sock.user?.id) })
        return relayRichMessage(jid, full, opts)
    }

    // ─── WhatsApp Flow helpers ─────────────────────────────────────────────────
    result.sendWhatsAppFlow = async (jid, flow, options = {}) => {
        const { text, footer, image, caption, ...flowOpts } = flow || {}
        const btn = makeWhatsAppFlowButton(flowOpts)
        const content = image ? { image, caption: caption || text || flowOpts.cta } : { text: text || flowOpts.cta || '' }
        return result.sendMessage(jid, { ...content, ...(footer ? { footer } : {}), nativeFlow: [btn] }, options)
    }

    result.sendRichButtonGrid = async (jid, grid, options = {}) => {
        const { text, footer, cards = [] } = grid || {}
        if (!Array.isArray(cards) || cards.length === 0) throw new Error('sendRichButtonGrid expects at least one card')
        return result.sendMessage(jid, { ...(text ? { text } : {}), ...(footer ? { footer } : {}), cards }, options)
    }

    // ─── Builder passthrough shortcuts ────────────────────────────────────────
    result.sendInteractiveMessage = (jid, data, quoted) => new Interactive(result).from(data).send(jid, q(quoted))
    result.sendCarouselMessage = (jid, data, quoted) => new Carousel(result).from(data).send(jid, q(quoted))
    result.sendCarouselProtoMessage = (jid, data, quoted) => new Carousel(result).from(data).send(jid, q(quoted))
    result.sendPaymentMessage = (jid, data, quoted) => new Payment(result).from(data).send(jid, q(quoted))
    result.sendProductMessage = (jid, data, quoted) => new Interactive(result).from({ ...data, __product: true }).send(jid, q(quoted))
    result.sendEventMessage = (jid, data, quoted) => new Event(result).from(data).send(jid, q(quoted))
    result.sendOrderMessage = (jid, data, quoted) => new Order(result).from(data).send(jid, q(quoted))
    result.sendPollResultMessage = (jid, data) => handlePollResult(result, jid, data)
    result.sendStatusMentionMessage = (jid, data) => handleStatusMention(result, jid, data, config)
    result.sendStatusMentions = (jid, data) => handleStatusMention(result, jid, data, config)
    result.stickerPackMessage = (jid, data, opts = {}) => new StickerPack(result).from({
        stickers: Array.isArray(data) ? data : (data.stickers ?? Object.values(data)),
        name: opts.packName ?? data?.name,
        publisher: opts.packPublisher ?? data?.publisher
    }).send(jid, q(opts.quoted))
    result.sendAlbumMessage = (jid, items, quoted, opts = {}) => result.sendMessage(jid, { albumMessage: items }, { ...q(quoted), ...opts })
    result.sendGroupStatusMessage = (jid, content, opts = {}) => result.sendMessage(jid, { groupStatus: content }, opts)
    result.sendPoll = (jid, name, values, multiSelect = false, opts = {}) => result.sendMessage(jid, { poll: { name, values, selectableOptionsCount: multiSelect ? 0 : 1 } }, opts)
    result.sendReaction = (jid, key, emoji, opts = {}) => result.sendMessage(jid, { react: { text: emoji, key } }, opts)
    result.sendText = (jid, text, opts = {}) => result.sendMessage(jid, { text }, opts)
    result.sendImage = (jid, image, caption = '', opts = {}) => result.sendMessage(jid, { image, caption }, opts)
    result.sendVideo = (jid, video, caption = '', opts = {}) => result.sendMessage(jid, { video, caption }, opts)
    result.sendDocument = (jid, document, caption = '', opts = {}) => result.sendMessage(jid, { document, caption }, opts)
    result.sendAudio = (jid, audio, opts = {}) => result.sendMessage(jid, { audio, ptt: opts.ptt ?? false, ...opts })
    result.sendSticker = (jid, sticker, opts = {}) => result.sendMessage(jid, { sticker }, opts)
    result.sendLocation = (jid, location, opts = {}) => result.sendMessage(jid, { location }, opts)
    result.sendContact = (jid, contact, opts = {}) => result.sendMessage(jid, { contacts: { displayName: contact.name ?? '', contacts: [contact] } }, opts)

    // ─── Fuzzy method proxy ───────────────────────────────────────────────────
    const normalize = s => s.toLowerCase().replace(/[^a-z]/g, '')
    const knownKeys = Object.keys(result).filter(k => typeof result[k] === 'function')
    const normalizedMap = new Map(knownKeys.map(k => [normalize(k), k]))

    return new Proxy(result, {
        get(target, prop, receiver) {
            if (prop in target) return Reflect.get(target, prop, receiver)
            if (typeof prop !== 'string') return undefined
            const match = normalizedMap.get(normalize(prop))
            if (match) {
                target.logger?.warn?.(`[NexusHandler] Unknown method "${prop}" — did you mean "${match}"? Calling it.`)
                return target[match]
            }
            return undefined
        }
    })
}
