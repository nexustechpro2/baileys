import { createReportingInfoStore } from '../Store/index.js'
import { SPAM_FLOWS, REPORT_REASON_CODES, resolveReportContext, buildSpamReportIq, buildSimpleReportNode, parseSpamReportResponse } from '../Utils/index.js'
import { isJidGroup, isPnUser, isLidUser, jidNormalizedUser, S_WHATSAPP_NET } from '../WABinary/index.js'
import { generateMessageTag } from '../Utils/generics.js'

// ─── Socket layer ─────────────────────────────────────────────────────────────

export const makeSpamReportSocket = (sock, config) => {
    const { query, signalRepository, updateBlockStatus, checkStatusWA, logger } = sock
    const store = config.reportingInfoStore ?? createReportingInfoStore()
    const delay = ms => new Promise(r => setTimeout(r, ms))

    if (!signalRepository?.lidMapping) logger?.warn?.({}, 'makeSpamReportSocket: signalRepository.lidMapping unavailable — LID resolution disabled')

    // ─── Internal ──────────────────────────────────────────────────────────────

    const simpleReportQuery = (jid, messageKeys) => query({
        tag: 'iq',
        attrs: { type: 'set', xmlns: 'spam', to: S_WHATSAPP_NET },
        content: [buildSimpleReportNode(jid, messageKeys)],
    })

    // Sends a w:report IQ, tolerates 408 timeouts (WA often doesn't ack these).
    const wReportQuery = async (node, label, meta, waitForAckMs = 5000) => {
        try {
            await query(node, waitForAckMs)
            logger?.info?.(meta, `${label} (ack received)`)
            return true
        } catch (err) {
            const code = err?.output?.statusCode || err?.statusCode
            if (code === 408 || err?.message?.toLowerCase?.().includes('timed out')) {
                logger?.warn?.(meta, `${label} (no ack; request likely sent)`)
                return false
            }
            throw err
        }
    }

    // Reverse-maps LID → PN for IQ endpoints that require PN addressing.
    // checkStatusWA handles its own stripping so the raw PN JID can be passed directly.
    const resolveToPN = async jid => {
        if (!isLidUser(jid)) return jidNormalizedUser(jid)
        const pn = await signalRepository?.lidMapping?.getPNForLID?.(jid)
        if (!pn) {
            logger?.error?.({ jid }, 'resolveToPN: could not resolve LID to PN')
            throw new Error(`resolveToPN: no PN found for LID ${jid}`)
        }
        logger?.debug?.({ lid: jid, pn }, 'resolveToPN: resolved LID → PN')
        return jidNormalizedUser(pn)
    }

    // Calls checkStatusWA and blocks immediately on confirmed ban. Returns true if blocked.
    const checkAndBlock = async (pnJid, label) => {
        try {
            const status = await checkStatusWA(pnJid)
            if (status?.isBanned) {
                logger?.info?.({ jid: pnJid, banInfo: status.banInfo }, `${label}: ban confirmed — blocking`)
                await updateBlockStatus(pnJid, 'block')
                return true
            }
            logger?.debug?.({ jid: pnJid, status: status?.status }, `${label}: no ban detected — skipping block`)
        } catch (err) {
            logger?.warn?.({ jid: pnJid, err: err?.message }, `${label}: checkStatusWA failed — skipping block`)
        }
        return false
    }

    // ─── reportSpam ────────────────────────────────────────────────────────────
    // Full tag-based report. Auto-detects group vs contact and picks the correct spam_flow.
    // Requires at least one stored reporting_tag — call extractReportingInfoFromStanza()
    // in messages.upsert and persist results so tags are available here.
    const reportSpam = async (jid, options = {}) => {
        const { spamFlow: manualFlow, messages: manualMessages, maxMessages = 5 } = options
        const { reportJid, spamFlow: autoFlow, isGroup } = await resolveReportContext(jid, signalRepository?.lidMapping)
        const spamFlow = manualFlow ?? autoFlow
        let messages = manualMessages
        if (!messages?.length) {
            messages = store.getForJid(reportJid, maxMessages)
            if (!messages.length && !isGroup) {
                messages = store.getForJid(jid, maxMessages)
                if (messages.length) logger?.debug?.({ jid, reportJid }, 'reportSpam: fell back to raw JID for store lookup')
            }
        }
        if (!messages?.length) {
            logger?.error?.({ jid, reportJid }, 'reportSpam: no reporting_tag stored — receive at least one message first')
            throw new Error(`reportSpam: no reporting_tag stored for ${jid}`)
        }
        const normalized = messages.slice(0, maxMessages).map(m => ({
            stanzaId: m.stanzaId || m.id,
            timestamp: Number(m.timestamp || m.sendTimestamp || m.t) || Math.floor(Date.now() / 1000),
            reportingTag: m.reportingTag || m.tag,
            text: m.text != null ? String(m.text) : m.raw != null ? String(m.raw) : '',
            pushName: m.pushName || m.reportedPushName || '',
            messageType: m.messageType || m.type || 'text',
            fromJid: m.fromJid || m.from || reportJid,
        }))
        logger?.debug?.({ jid: reportJid, spamFlow, count: normalized.length }, 'reportSpam: sending IQ')
        const result = await query(buildSpamReportIq(reportJid, normalized, spamFlow, logger))
        return { ...parseSpamReportResponse(result), messageCount: normalized.length }
    }

    // ─── reportContact ─────────────────────────────────────────────────────────
    // Lightweight contact report — no reporting_tags needed, only message key ids (or none).
    // LID JIDs are reverse-mapped to PN. Checks ban status after report and blocks if confirmed.
    // Do NOT use for groups — use reportGroup() instead.
    const reportContact = async (jid, messageKeys = [], options = {}) => {
        const { delayMs = 1500 } = options
        if (!isPnUser(jid) && !isLidUser(jid)) {
            logger?.error?.({ jid }, 'reportContact: invalid contact JID')
            throw new Error('reportContact requires a valid contact JID')
        }
        const pnJid = await resolveToPN(jid)
        const parsed = parseSpamReportResponse(await simpleReportQuery(pnJid, messageKeys))
        if (parsed.success) {
            await delay(delayMs)
            await checkAndBlock(pnJid, 'reportContact')
        } else {
            logger?.warn?.({ jid: pnJid, error: parsed.error }, 'reportContact: report unsuccessful — skipping ban check')
        }
        return parsed
    }

    // ─── reportGroup ───────────────────────────────────────────────────────────
    // Lightweight group report — no reporting_tags needed, only message key ids (or none).
    // Automatically leaves the group on a successful report.
    // Do NOT use for contacts — use reportContact() instead.
    const reportGroup = async (jid, messageKeys = []) => {
        if (!isJidGroup(jid)) {
            logger?.error?.({ jid }, 'reportGroup: invalid group JID')
            throw new Error('reportGroup requires a valid group JID')
        }
        const parsed = parseSpamReportResponse(await simpleReportQuery(jid, messageKeys))
        if (parsed.success) {
            try {
                await query({ tag: 'iq', attrs: { type: 'set', xmlns: 'w:g2', to: '@g.us' }, content: [{ tag: 'leave', attrs: {}, content: [{ tag: 'group', attrs: { id: jid } }] }] })
                logger?.info?.({ jid }, 'reportGroup: left group after successful report')
            } catch (err) {
                logger?.warn?.({ jid, err: err?.message }, 'reportGroup: leave failed after successful report')
            }
        } else {
            logger?.warn?.({ jid, error: parsed.error }, 'reportGroup: report unsuccessful — skipping leave')
        }
        return parsed
    }

    // ─── reportUser ────────────────────────────────────────────────────────────
    // Reports a user account via w:report IQ — no message evidence needed.
    // LID JIDs are reverse-mapped to PN. Does NOT block.
    // Returns true if ack received, false if timed out (request still likely sent).
    // reason: 'spam' | 'harassment' | 'impersonation' | 'scam' | 'other'
    const reportUser = async (jid, reason = 'spam', waitForAckMs = 5000) => {
        const pnJid = await resolveToPN(jid)
        return wReportQuery(
            { tag: 'iq', attrs: { id: generateMessageTag(), xmlns: 'w:report', to: 's.whatsapp.net', type: 'set' }, content: [{ tag: 'user', attrs: { jid: pnJid, reason: String(REPORT_REASON_CODES[reason] ?? 1) } }] },
            'reported user', { jid: pnJid, reason }, waitForAckMs,
        )
    }

    // ─── reportMessage ─────────────────────────────────────────────────────────
    // Reports a single message via w:report IQ. Pass participantJid for group messages.
    // LID JIDs (jid + participantJid) are reverse-mapped to PN. Does NOT block or leave.
    // Returns true/false same as reportUser().
    // reason: 'spam' | 'harassment' | 'impersonation' | 'scam' | 'other'
    const reportMessage = async (jid, messageId, reason = 'spam', participantJid, waitForAckMs = 5000) => {
        const pnJid = await resolveToPN(jid)
        const participant = participantJid ? await resolveToPN(participantJid) : undefined
        const attrs = { id: String(messageId), reason: String(REPORT_REASON_CODES[reason] ?? 1), ...(participant ? { participant } : {}) }
        return wReportQuery(
            { tag: 'iq', attrs: { id: generateMessageTag(), xmlns: 'w:report', to: 's.whatsapp.net', type: 'set' }, content: [{ tag: 'message', attrs }] },
            'reported message', { jid: pnJid, messageId, reason, participant }, waitForAckMs,
        )
    }

    // ─── reportAndBlockUser ────────────────────────────────────────────────────
    // Reports a user up to maxAttempts times, checking ban status after each round.
    // Exits early and blocks the moment WA confirms a ban — skips block if none detected.
    // Returns { banned, blocked, attempts }.
    const reportAndBlockUser = async (jid, reason = 'spam', options = {}) => {
        const { waitForAckMs = 5000, maxAttempts = 4, delayMs = 1500 } = options
        const pnJid = await resolveToPN(jid)
        let attempts = 0, banned = false, blocked = false
        while (attempts < maxAttempts && !banned) {
            await reportUser(pnJid, reason, waitForAckMs)
            attempts++
            logger?.debug?.({ jid: pnJid, attempts }, 'reportAndBlockUser: attempt sent')
            await delay(delayMs)
            blocked = await checkAndBlock(pnJid, 'reportAndBlockUser')
            if (blocked) banned = true
        }
        if (!banned) logger?.info?.({ jid: pnJid, attempts }, 'reportAndBlockUser: max attempts reached — no ban confirmed, skipping block')
        return { banned, blocked, attempts }
    }

    // ─── Exports ───────────────────────────────────────────────────────────────

    return {
        ...sock,
        reportSpam,
        reportContact,
        reportGroup,
        reportUser,
        reportMessage,
        reportAndBlockUser,
        getStoredReportingInfo: (jid, max = 5) => store.getForJid(jid, max),
        clearStoredReportingInfo: jid => store.clear(jid),
        reportingInfoStore: store,
        SPAM_FLOWS,
        REPORT_REASON_CODES,
    }
}