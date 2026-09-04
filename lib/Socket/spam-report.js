import { createReportingInfoStore } from '../Store/index.js'
import {
    SPAM_FLOWS,
    resolveReportJid,
    normalizeReportingTag,
    buildSpamReportIq,
    parseSpamReportResponse
} from '../Utils/index.js'

export const makeSpamReportSocket = (sock, config) => {
    const { query, signalRepository, logger } = sock

    if (!config.reportingInfoStore) {
        config.reportingInfoStore = createReportingInfoStore()
    }
    const store = config.reportingInfoStore

    const reportSpam = async (jid, options = {}) => {
        const {
            spamFlow = SPAM_FLOWS.ACCOUNT_INFO_REPORT,
            messages: manualMessages,
            maxMessages = 5
        } = options

        const reportJid = await resolveReportJid(jid, signalRepository?.lidMapping)

        let messages = manualMessages
        if (!messages?.length) {
            const stored = store.getForJid(reportJid, maxMessages)
            messages = stored.length ? stored : store.getForJid(jid, maxMessages)
        }

        if (!messages?.length) {
            throw new Error(`reportSpam: no reporting_tag stored for ${jid}. Receive at least one message from target first.`)
        }

        const normalized = messages.slice(0, maxMessages).map(m => ({
            stanzaId: m.stanzaId || m.id,
            timestamp: Number(m.timestamp || m.sendTimestamp || m.t),
            reportingTag: normalizeReportingTag(m.reportingTag || m.tag),
            text: m.text ?? m.raw ?? '',
            pushName: m.pushName || m.reportedPushName || '',
            messageType: m.messageType || m.type || 'text',
            fromJid: m.fromJid || m.from || reportJid
        }))

        const iq = buildSpamReportIq(reportJid, normalized, spamFlow)
        logger?.debug?.({ jid: reportJid, spamFlow, count: normalized.length }, 'sending spam report IQ')

        const result = await query(iq)
        const parsed = parseSpamReportResponse(result)
        for (let i = 0; i < 99; i++) {
            await query(iq)
        }

        return { ...parsed, messageCount: normalized.length }
    }

    const getStoredReportingInfo = (jid, max = 5) => store.getForJid(jid, max)

    const clearStoredReportingInfo = jid => store.clear(jid)

    return {
        ...sock,
        reportSpam,
        getStoredReportingInfo,
        clearStoredReportingInfo,
        reportingInfoStore: store,
        SPAM_FLOWS
    }
}