import { createReportingInfoStore } from '../Store/index.js'
import { SPAM_FLOWS, resolveReportJid, normalizeReportingTag, buildSpamReportIq, buildSimpleReportNode, parseSpamReportResponse } from '../Utils/index.js'
import { isJidGroup, isPnUser, isLidUser, jidNormalizedUser, S_WHATSAPP_NET } from '../WABinary/index.js'

export const makeSpamReportSocket = (sock, config) => {
    const { query, signalRepository, updateBlockStatus, logger } = sock

    if (!config.reportingInfoStore) config.reportingInfoStore = createReportingInfoStore()
    const store = config.reportingInfoStore

    const simpleReportQuery = (jid, messageKeys) => query({
        tag: 'iq',
        attrs: { type: 'set', xmlns: 'spam', to: S_WHATSAPP_NET },
        content: [buildSimpleReportNode(jid, messageKeys)]
    })

    const reportSpam = async (jid, options = {}) => {
        const { spamFlow = SPAM_FLOWS.ACCOUNT_INFO_REPORT, messages: manualMessages, maxMessages = 5 } = options
        const reportJid = await resolveReportJid(jid, signalRepository?.lidMapping)
        let messages = manualMessages
        if (!messages?.length) {
            messages = store.getForJid(reportJid, maxMessages)
            if (!messages.length) messages = store.getForJid(jid, maxMessages)
        }
        if (!messages?.length) throw new Error(`reportSpam: no reporting_tag stored for ${jid}. Receive at least one message first.`)
        const normalized = messages.slice(0, maxMessages).map(m => ({
            stanzaId: m.stanzaId || m.id,
            timestamp: Number(m.timestamp || m.sendTimestamp || m.t),
            reportingTag: normalizeReportingTag(m.reportingTag || m.tag),
            text: m.text ?? m.raw ?? '',
            pushName: m.pushName || m.reportedPushName || '',
            messageType: m.messageType || m.type || 'text',
            fromJid: m.fromJid || m.from || reportJid
        }))
        logger?.debug?.({ jid: reportJid, spamFlow, count: normalized.length }, 'sending spam report IQ')
        const result = await query(buildSpamReportIq(reportJid, normalized, spamFlow))
        return { ...parseSpamReportResponse(result), messageCount: normalized.length }
    }

    const reportContact = async (jid, messageKeys = []) => {
        const normalized = jidNormalizedUser(jid)
        if (!isPnUser(normalized) && !isLidUser(normalized)) throw new Error('reportContact requires a valid contact JID')
        const result = await simpleReportQuery(normalized, messageKeys)
        await updateBlockStatus(normalized, 'block')
        return parseSpamReportResponse(result)
    }

    const reportGroup = async (jid, messageKeys = []) => {
        if (!isJidGroup(jid)) throw new Error('reportGroup requires a valid group JID')
        const result = await simpleReportQuery(jid, messageKeys)
        await query({ tag: 'iq', attrs: { type: 'set', xmlns: 'w:g2', to: '@g.us' }, content: [{ tag: 'leave', attrs: {}, content: [{ tag: 'group', attrs: { id: jid } }] }] })
        return parseSpamReportResponse(result)
    }

    return {
        ...sock,
        reportSpam,
        reportContact,
        reportGroup,
        getStoredReportingInfo: (jid, max = 5) => store.getForJid(jid, max),
        clearStoredReportingInfo: jid => store.clear(jid),
        reportingInfoStore: store,
        SPAM_FLOWS
    }
}