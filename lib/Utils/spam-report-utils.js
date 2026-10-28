import { getBinaryNodeChild, getBinaryNodeChildString, isLidUser, isHostedLidUser, isJidGroup, S_WHATSAPP_NET } from '../WABinary/index.js'
import { extractMessageContent } from './messages.js'

// ─── Constants ────────────────────────────────────────────────────────────────

// Controls how WA routes the report internally — pass via options.spamFlow to override auto-selection.
// ACCOUNT_INFO_REPORT       → tag-based 1:1 contact report (default)
// ACCOUNT_INFO_BLOCK        → tag-based contact report signalling intent to block
// GROUP_INFO_REPORT         → tag-based group report (auto-selected for group JIDs)
// CONTACT_INFO_REPORT       → legacy lightweight report, no reporting_tag needed
// ONE_TO_ONE_SPAM_BANNER_REPORT → from the in-chat spam banner
// MESSAGE_MENU              → from long-press message context menu
// OVERFLOW_MENU_REPORT      → from the chat overflow (⋮) menu
export const SPAM_FLOWS = {
    ACCOUNT_INFO_REPORT: 'account_info_report',
    ACCOUNT_INFO_BLOCK: 'account_info_block',
    GROUP_INFO_REPORT: 'group_info_report',
    CONTACT_INFO_REPORT: 'contact_info_report',
    ONE_TO_ONE_SPAM_BANNER_REPORT: '1_1_spam_banner_report',
    MESSAGE_MENU: 'message_menu',
    OVERFLOW_MENU_REPORT: 'overflow_menu_report',
}

// Numeric reason codes for the w:report IQ endpoint — used by reportUser() and reportMessage().
export const REPORT_REASON_CODES = { spam: 1, harassment: 2, impersonation: 3, scam: 4, other: 5 }

// ─── Internal helpers ─────────────────────────────────────────────────────────

const toBuffer = data => {
    if (!data) return null
    if (Buffer.isBuffer(data)) return data
    if (data instanceof Uint8Array) return Buffer.from(data)
    if (typeof data === 'string') return Buffer.from(data, 'base64')
    return null
}

// ─── JID resolution ───────────────────────────────────────────────────────────

// Resolves a PN JID to its LID equivalent for tag-based spam IQs.
// Groups and already-LID/hosted-LID JIDs pass through unchanged.
export const resolveReportJid = async (jid, lidMapping) => {
    if (!jid) throw new Error('resolveReportJid: jid required')
    if (isJidGroup(jid) || isLidUser(jid) || isHostedLidUser(jid)) return jid
    const lid = lidMapping?.getLIDForPN ? await lidMapping.getLIDForPN(jid) : null
    return lid ?? jid
}

// Auto-detects JID type and returns the resolved JID + correct spam_flow for reportSpam().
// Returns { reportJid, spamFlow, isGroup }.
export const resolveReportContext = async (jid, lidMapping) => {
    if (!jid) throw new Error('resolveReportContext: jid required')
    if (isJidGroup(jid)) return { reportJid: jid, spamFlow: SPAM_FLOWS.GROUP_INFO_REPORT, isGroup: true }
    return { reportJid: await resolveReportJid(jid, lidMapping), spamFlow: SPAM_FLOWS.ACCOUNT_INFO_REPORT, isGroup: false }
}

// ─── Tag / text extraction ────────────────────────────────────────────────────

// Normalizes a raw reporting_tag to a Buffer — returns null if invalid or empty.
export const normalizeReportingTag = tag => {
    const buf = toBuffer(tag)
    return buf?.length ? buf : null
}

// Extracts plain text from a WAMessage across common message types.
export const extractMessageText = msg => {
    if (!msg?.message) return ''
    const c = extractMessageContent(msg.message)
    if (!c) return ''
    return c.conversation ?? c.extendedTextMessage?.text ?? c.imageMessage?.caption ?? c.videoMessage?.caption ?? ''
}

// Extracts { stanzaId, timestamp, reportingTag, reportingToken, tokenVersion, validationPolicy }
// from a raw incoming binary stanza. Call inside messages.upsert and persist via reportingInfoStore
// so reportSpam() can use the tags later.
export const extractReportingInfoFromStanza = stanza => {
    const reporting = getBinaryNodeChild(stanza, 'reporting')
    if (!reporting) return null
    const tokenNode = getBinaryNodeChild(reporting, 'reporting_token')
    const tagNode = getBinaryNodeChild(reporting, 'reporting_tag') ||
        getBinaryNodeChild(getBinaryNodeChild(reporting, 'reporting_validation'), 'reporting_tag')
    if (!tagNode?.content) return null
    const raw = tagNode.content
    const reportingTag = toBuffer(raw instanceof Uint8Array || Buffer.isBuffer(raw) ? raw : typeof raw === 'string' ? raw : null)
    if (!reportingTag?.length) return null
    const stanzaId = tagNode.attrs?.id || stanza.attrs?.id
    if (!stanzaId) return null
    const tsRaw = tagNode.attrs?.ts_s || stanza.attrs?.t
    return {
        stanzaId,
        timestamp: tsRaw ? Number(tsRaw) : 0,
        reportingTag,
        reportingToken: tokenNode?.content ? toBuffer(tokenNode.content) : null,
        tokenVersion: tokenNode?.attrs?.v ? parseInt(tokenNode.attrs.v) : null,
        validationPolicy: reporting.attrs?.validation_policy || null,
    }
}

// ─── Node builders ────────────────────────────────────────────────────────────

// Builds <message> child nodes for a spam_list IQ.
// Skips messages missing a reportingTag (warn) — throws only if all are filtered (error).
export const buildSpamReportMessageNodes = (messages, logger) => {
    const ts = () => Math.floor(Date.now() / 1000)
    const nodes = messages.slice(0, 5).reduce((acc, m) => {
        const reportingTag = normalizeReportingTag(m.reportingTag)
        if (!reportingTag) {
            logger?.warn?.({ stanzaId: m.stanzaId }, 'buildSpamReportMessageNodes: skipping — missing reportingTag')
            return acc
        }
        const t = String(m.timestamp || ts())
        acc.push({
            tag: 'message',
            attrs: { t, id: m.stanzaId, reported_push_name: m.pushName || '', type: m.messageType || 'text', from: m.fromJid },
            content: [
                { tag: 'raw', attrs: { local_message_type: '0', v: '2' }, content: m.text != null ? String(m.text) : '' },
                { tag: 'reporting', attrs: {}, content: [{ tag: 'reporting_validation', attrs: {}, content: [{ tag: 'reporting_tag', attrs: { id: m.stanzaId, ts_s: t }, content: reportingTag }] }] },
            ],
        })
        return acc
    }, [])
    if (!nodes.length) {
        logger?.error?.({}, 'buildSpamReportMessageNodes: all messages filtered — none had a valid reportingTag')
        throw new Error('reportSpam: no valid messages with reportingTag after filtering')
    }
    return nodes
}

// Builds the full xmlns="spam" IQ stanza for tag-based reporting — used by reportSpam().
export const buildSpamReportIq = (jid, messages, spamFlow = SPAM_FLOWS.ACCOUNT_INFO_REPORT, logger) => {
    if (!messages?.length) {
        logger?.error?.({ jid, spamFlow }, 'buildSpamReportIq: called with empty messages array')
        throw new Error('reportSpam: at least one message with reporting_tag required')
    }
    return {
        tag: 'iq',
        attrs: { type: 'set', xmlns: 'spam', to: S_WHATSAPP_NET },
        content: [{ tag: 'spam_list', attrs: { jid, spam_flow: spamFlow }, content: buildSpamReportMessageNodes(messages, logger) }],
    }
}

// Builds the simpler xmlns="spam" <report> node — used by reportContact() and reportGroup().
// Does NOT require reporting_tags, only message key ids or bare id strings.
export const buildSimpleReportNode = (jid, messageKeys) => ({
    tag: 'report',
    attrs: { jid, type: 'spam' },
    content: (messageKeys || []).map(key => ({ tag: 'message', attrs: { id: key.id || key, ...(key.fromMe ? {} : { from: jid }) } })),
})

// ─── Response parser ──────────────────────────────────────────────────────────

// Parses the IQ result node from any spam report query.
// Returns { success: true, reportId? } on success or { success: false, error } on failure.
export const parseSpamReportResponse = result => {
    if (!result) return { success: false, error: 'empty response' }
    if (result.attrs?.type === 'error') {
        const errNode = getBinaryNodeChild(result, 'error')
        const code = errNode?.attrs?.code
        const text = errNode?.content?.toString?.() || errNode?.attrs?.text
        return { success: false, error: `spam IQ error${code ? ` ${code}` : ''}${text ? `: ${text}` : ''}` }
    }
    const reportNode = getBinaryNodeChild(result, 'report')
    const reportId = reportNode?.attrs?.id || getBinaryNodeChildString(reportNode, 'id')
    if (reportId) return { success: true, reportId: String(reportId) }
    if (result.attrs?.type === 'result') return { success: true }
    return { success: false, error: 'unexpected spam IQ response' }
}