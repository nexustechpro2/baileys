import { getBinaryNodeChild, getBinaryNodeChildString, isLidUser, isHostedLidUser, S_WHATSAPP_NET } from '../WABinary/index.js'
import { extractMessageContent } from './messages.js'

export const SPAM_FLOWS = {
    ACCOUNT_INFO_REPORT: 'account_info_report',
    ACCOUNT_INFO_BLOCK: 'account_info_block',
    ONE_TO_ONE_SPAM_BANNER_REPORT: '1_1_spam_banner_report',
    MESSAGE_MENU: 'message_menu',
    OVERFLOW_MENU_REPORT: 'overflow_menu_report'
}

const toBuffer = data => {
    if (!data) return null
    if (Buffer.isBuffer(data)) return data
    if (data instanceof Uint8Array) return Buffer.from(data)
    if (typeof data === 'string') return Buffer.from(data, 'base64')
    return null
}

export const resolveReportJid = async (jid, lidMapping) => {
    if (!jid) throw new Error('reportSpam: jid required')
    if (isLidUser(jid) || isHostedLidUser(jid)) return jid
    if (lidMapping?.getLIDForPN) {
        const lid = await lidMapping.getLIDForPN(jid)
        if (lid) return lid
    }
    return jid
}

export const normalizeReportingTag = tag => {
    const buf = toBuffer(tag)
    if (!buf?.length) return null
    return buf
}

export const extractMessageText = msg => {
    if (!msg?.message) return ''
    const content = extractMessageContent(msg.message)
    if (!content) return ''
    if (typeof content.conversation === 'string') return content.conversation
    if (content.extendedTextMessage?.text) return content.extendedTextMessage.text
    if (content.imageMessage?.caption) return content.imageMessage.caption
    if (content.videoMessage?.caption) return content.videoMessage.caption
    return ''
}

export const extractReportingInfoFromStanza = stanza => {
    const reporting = getBinaryNodeChild(stanza, 'reporting')
    if (!reporting) return null

    let tagNode = getBinaryNodeChild(reporting, 'reporting_tag')
    if (!tagNode) {
        const validation = getBinaryNodeChild(reporting, 'reporting_validation')
        tagNode = validation ? getBinaryNodeChild(validation, 'reporting_tag') : undefined
    }
    if (!tagNode) return null

    const raw = tagNode.content
    const reportingTag = toBuffer(
        raw instanceof Uint8Array || Buffer.isBuffer(raw) ? raw
            : typeof raw === 'string' ? raw
                : null
    )
    if (!reportingTag?.length) return null

    const stanzaId = tagNode.attrs?.id || stanza.attrs?.id
    const tsRaw = tagNode.attrs?.ts_s || stanza.attrs?.t
    const timestamp = tsRaw ? Number(tsRaw) : 0
    if (!stanzaId) return null

    return { stanzaId, timestamp, reportingTag }
}

export const buildSpamReportMessageNodes = messages => {
    return messages.slice(0, 5).map(m => {
        const reportingTag = normalizeReportingTag(m.reportingTag)
        if (!reportingTag) throw new Error(`reportSpam: missing reportingTag for ${m.stanzaId}`)

        return {
            tag: 'message',
            attrs: {
                t: String(m.timestamp),
                id: m.stanzaId,
                reported_push_name: m.pushName || '',
                type: m.messageType || 'text',
                from: m.fromJid
            },
            content: [
                {
                    tag: 'raw',
                    attrs: { local_message_type: '0', v: '2' },
                    content: m.text ?? ''
                },
                {
                    tag: 'reporting',
                    attrs: {},
                    content: [
                        {
                            tag: 'reporting_validation',
                            attrs: {},
                            content: [
                                {
                                    tag: 'reporting_tag',
                                    attrs: { id: m.stanzaId, ts_s: String(m.timestamp) },
                                    content: reportingTag
                                }
                            ]
                        }
                    ]
                }
            ]
        }
    })
}

export const buildSpamReportIq = (jid, messages, spamFlow = SPAM_FLOWS.ACCOUNT_INFO_REPORT) => {
    if (!messages?.length) throw new Error('reportSpam: at least one message with reporting_tag required')

    return {
        tag: 'iq',
        attrs: { type: 'set', xmlns: 'spam', to: S_WHATSAPP_NET },
        content: [
            {
                tag: 'spam_list',
                attrs: { jid, spam_flow: spamFlow },
                content: buildSpamReportMessageNodes(messages)
            }
        ]
    }
}

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