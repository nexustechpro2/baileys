import { generateMessageIDV2 } from './generics.js'
import { tokenizeCode } from './generics.js'

// ─── Shared context + envelope builders ──────────────────────────────────────

const buildRichContextInfo = (quoted, options = {}) => {
    const ctx = {
        forwardingScore: 1, isForwarded: true,
        forwardedAiBotMessageInfo: { botJid: options.botJid || '867051314767696@bot' },
        forwardOrigin: 4,
        ...(options.mentions ? { mentionedJid: options.mentions } : {})
    }
    if (quoted?.key) {
        ctx.stanzaId = quoted.key.id
        ctx.participant = quoted.key.participant || quoted.sender || quoted.key.remoteJid
        ctx.quotedMessage = quoted.message
    }
    return ctx
}

const buildBotForwardedMessage = (submessages, contextInfo, unifiedResponse) => {
    const rich = { messageType: 1, submessages, contextInfo }
    if (unifiedResponse) rich.unifiedResponse = unifiedResponse
    return { botForwardedMessage: { message: { richResponseMessage: rich } } }
}

// ─── Content generators — each returns { message, messageId } ─────────────────

export const generateTableContent = (title, headers, rows, quoted, options = {}) => {
    const { footer, headerText } = options
    const tableRows = [{ items: headers, isHeading: true }, ...rows.map(row => ({ items: row.map(String) }))]
    const sub = []
    if (headerText) sub.push({ messageType: 2, messageText: headerText })
    sub.push({ messageType: 4, tableMetadata: { title, rows: tableRows } })
    if (footer) sub.push({ messageType: 2, messageText: footer })
    return { message: buildBotForwardedMessage(sub, buildRichContextInfo(quoted)), messageId: generateMessageIDV2() }
}

export const generateListContent = (title, items, quoted, options = {}) => {
    const { footer, headerText } = options
    const tableRows = items.map(item => ({ items: Array.isArray(item) ? item.map(String) : [String(item)] }))
    const sub = []
    if (headerText) sub.push({ messageType: 2, messageText: headerText })
    sub.push({ messageType: 4, tableMetadata: { title, rows: tableRows } })
    if (footer) sub.push({ messageType: 2, messageText: footer })
    return { message: buildBotForwardedMessage(sub, buildRichContextInfo(quoted)), messageId: generateMessageIDV2() }
}

export const generateCodeBlockContent = (code, quoted, options = {}) => {
    const { title, footer, language = 'javascript' } = options
    const sub = []
    if (title) sub.push({ messageType: 2, messageText: title })
    sub.push({ messageType: 5, codeMetadata: { codeLanguage: language, codeBlocks: tokenizeCode(code, language) } })
    if (footer) sub.push({ messageType: 2, messageText: footer })
    return { message: buildBotForwardedMessage(sub, buildRichContextInfo(quoted)), messageId: generateMessageIDV2() }
}

export const generateLatexContent = (quoted, options = {}) => {
    const { text, expressions = [], headerText, footer } = options
    const sub = []
    if (headerText) sub.push({ messageType: 2, messageText: headerText })
    const latexExpressions = expressions.map(expr => {
        const e = { latexExpression: expr.latexExpression, url: expr.url, width: expr.width, height: expr.height }
        if (expr.fontHeight !== undefined) e.fontHeight = expr.fontHeight
        if (expr.imageTopPadding !== undefined) e.imageTopPadding = expr.imageTopPadding
        if (expr.imageLeadingPadding !== undefined) e.imageLeadingPadding = expr.imageLeadingPadding
        if (expr.imageBottomPadding !== undefined) e.imageBottomPadding = expr.imageBottomPadding
        if (expr.imageTrailingPadding !== undefined) e.imageTrailingPadding = expr.imageTrailingPadding
        return e
    })
    sub.push({ messageType: 8, latexMetadata: { text: text || '', expressions: latexExpressions } })
    if (footer) sub.push({ messageType: 2, messageText: footer })
    return { message: buildBotForwardedMessage(sub, buildRichContextInfo(quoted)), messageId: generateMessageIDV2() }
}

export const captureUnifiedResponse = (msg) => {
    const rich = msg?.botForwardedMessage?.message?.richResponseMessage
    if (!rich?.unifiedResponse?.data) return null
    return { unifiedResponse: { data: rich.unifiedResponse.data }, submessages: rich.submessages || [], contextInfo: rich.contextInfo || {} }
}

export const generateUnifiedResponseContent = (quoted, captured) => ({
    message: buildBotForwardedMessage(captured.submessages, buildRichContextInfo(quoted), captured.unifiedResponse),
    messageId: generateMessageIDV2()
})

export const generateRichMessageContent = (submessages, quoted, options) => ({
    message: buildBotForwardedMessage(submessages, buildRichContextInfo(quoted, options)),
    messageId: generateMessageIDV2()
})
