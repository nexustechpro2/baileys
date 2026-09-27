import { generateMessageIDV2, tokenizeCode } from './generics.js'

const buildRichContextInfo = (quoted, options = {}) => {
    const ctx = { forwardingScore: 1, isForwarded: true, forwardedAiBotMessageInfo: { botJid: options.botJid || '867051314767696@bot' }, forwardOrigin: 4, ...(options.mentions ? { mentionedJid: options.mentions } : {}) }
    if (quoted?.key) { ctx.stanzaId = quoted.key.id; ctx.participant = quoted.key.participant || quoted.sender || quoted.key.remoteJid; ctx.quotedMessage = quoted.message }
    return ctx
}

const buildBotForwardedMessage = (submessages, contextInfo, unifiedResponse) => {
    const rich = { messageType: 1, submessages, contextInfo }
    if (unifiedResponse) rich.unifiedResponse = unifiedResponse
    return { botForwardedMessage: { message: { richResponseMessage: rich } } }
}

const wrap = (sub, quoted, options) => ({ message: buildBotForwardedMessage(sub, buildRichContextInfo(quoted, options)), messageId: generateMessageIDV2() })
const text = msg => ({ messageType: 2, messageText: msg })
const table = (title, rows) => ({ messageType: 4, tableMetadata: { title, rows } })

export const generateTableContent = (title, headers, rows, quoted, options = {}) => {
    const { footer, headerText } = options
    const sub = [...(headerText ? [text(headerText)] : []), table(title, [{ items: headers, isHeading: true }, ...rows.map(row => ({ items: row.map(String) }))]), ...(footer ? [text(footer)] : [])]
    return wrap(sub, quoted, options)
}

export const generateListContent = (title, items, quoted, options = {}) => {
    const { footer, headerText } = options
    const sub = [...(headerText ? [text(headerText)] : []), table(title, items.map(item => ({ items: Array.isArray(item) ? item.map(String) : [String(item)] }))), ...(footer ? [text(footer)] : [])]
    return wrap(sub, quoted, options)
}

export const generateCodeBlockContent = (code, quoted, options = {}) => {
    const { title, footer, language = 'javascript' } = options
    const sub = [...(title ? [text(title)] : []), { messageType: 5, codeMetadata: { codeLanguage: language, codeBlocks: tokenizeCode(code, language) } }, ...(footer ? [text(footer)] : [])]
    return wrap(sub, quoted, options)
}

export const generateLatexContent = (quoted, options = {}) => {
    const { text: txt, expressions = [], headerText, footer } = options
    const latexExpressions = expressions.map(({ latexExpression, url, width, height, fontHeight, imageTopPadding, imageLeadingPadding, imageBottomPadding, imageTrailingPadding }) => {
        const e = { latexExpression, url, width, height }
        if (fontHeight !== undefined) e.fontHeight = fontHeight
        if (imageTopPadding !== undefined) e.imageTopPadding = imageTopPadding
        if (imageLeadingPadding !== undefined) e.imageLeadingPadding = imageLeadingPadding
        if (imageBottomPadding !== undefined) e.imageBottomPadding = imageBottomPadding
        if (imageTrailingPadding !== undefined) e.imageTrailingPadding = imageTrailingPadding
        return e
    })
    const sub = [...(headerText ? [text(headerText)] : []), { messageType: 8, latexMetadata: { text: txt || '', expressions: latexExpressions } }, ...(footer ? [text(footer)] : [])]
    return wrap(sub, quoted, options)
}

export const captureUnifiedResponse = msg => {
    const rich = msg?.botForwardedMessage?.message?.richResponseMessage
    if (!rich?.unifiedResponse?.data) return null
    return { unifiedResponse: { data: rich.unifiedResponse.data }, submessages: rich.submessages || [], contextInfo: rich.contextInfo || {} }
}

export const generateUnifiedResponseContent = (quoted, captured) => wrap(captured.submessages, quoted, { unifiedResponse: captured.unifiedResponse })
export const generateRichMessageContent = (submessages, quoted, options) => wrap(submessages, quoted, options)