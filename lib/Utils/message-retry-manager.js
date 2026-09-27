import { LRUCache } from 'lru-cache'

const RECENT_MESSAGES_SIZE = 512
const RECREATE_SESSION_TIMEOUT = 60 * 60 * 1000
const PHONE_REQUEST_DELAY = 3000

export class MessageRetryManager {
    constructor(logger, maxMsgRetryCount) {
        this.logger = logger
        this.maxMsgRetryCount = maxMsgRetryCount
        this.recentMessagesMap = new LRUCache({ max: RECENT_MESSAGES_SIZE })
        this.sessionRecreateHistory = new LRUCache({ ttl: RECREATE_SESSION_TIMEOUT * 2, ttlAutopurge: true })
        this.retryCounters = new LRUCache({ ttl: 15 * 60 * 1000, ttlAutopurge: true, updateAgeOnGet: true })
        this.pendingPhoneRequests = {}
        this.statistics = { totalRetries: 0, successfulRetries: 0, failedRetries: 0, mediaRetries: 0, sessionRecreations: 0, phoneRequests: 0 }
    }

    keyToString(key) { return `${key.to}:${key.id}` }

    addRecentMessage(to, id, message) { this.recentMessagesMap.set(this.keyToString({ to, id }), { message, timestamp: Date.now() }) }
    getRecentMessage(to, id) { return this.recentMessagesMap.get(this.keyToString({ to, id })) }

    shouldRecreateSession(jid, retryCount, hasSession) {
        if (!hasSession) { this.sessionRecreateHistory.set(jid, Date.now()); this.statistics.sessionRecreations++; return { reason: "we don't have a Signal session with them", recreate: true } }
        if (retryCount < 2) return { reason: '', recreate: false }
        const now = Date.now()
        const prevTime = this.sessionRecreateHistory.get(jid)
        if (!prevTime || now - prevTime > RECREATE_SESSION_TIMEOUT) { this.sessionRecreateHistory.set(jid, now); this.statistics.sessionRecreations++; return { reason: 'retry count > 1 and over an hour since last recreation', recreate: true } }
        return { reason: '', recreate: false }
    }

    incrementRetryCount(messageId) { this.retryCounters.set(messageId, (this.retryCounters.get(messageId) || 0) + 1); this.statistics.totalRetries++; return this.retryCounters.get(messageId) }
    getRetryCount(messageId) { return this.retryCounters.get(messageId) || 0 }
    hasExceededMaxRetries(messageId) { return this.getRetryCount(messageId) >= this.maxMsgRetryCount }

    markRetrySuccess(messageId) { this.statistics.successfulRetries++; this.retryCounters.delete(messageId); this.cancelPendingPhoneRequest(messageId) }
    markRetryFailed(messageId) { this.statistics.failedRetries++; this.retryCounters.delete(messageId) }

    schedulePhoneRequest(messageId, callback, delay = PHONE_REQUEST_DELAY) {
        this.cancelPendingPhoneRequest(messageId)
        this.pendingPhoneRequests[messageId] = setTimeout(() => { delete this.pendingPhoneRequests[messageId]; this.statistics.phoneRequests++; callback() }, delay)
    }

    cancelPendingPhoneRequest(messageId) {
        const timeout = this.pendingPhoneRequests[messageId]
        if (timeout) { clearTimeout(timeout); delete this.pendingPhoneRequests[messageId] }
    }
}