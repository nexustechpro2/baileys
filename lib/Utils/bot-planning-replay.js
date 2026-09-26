import { buildPlainPlaceholder, PlanningStepStatus } from './meta-compositing.js'
import { delay } from './generics.js'

// Live planning animation. Shows pending steps, edits each to DONE one-by-one,
// deletes placeholder, then sends the final message. Works on all WA clients.
export const replayPlanning = async (sock, jid, steps, finalContent, {
    description = 'Thinking…',
    placeholderText = '',
    stepDelayMs = 900,
    finalPauseMs = 600,
    abortOnDisconnect = true,
    sendOptions = {}
} = {}) => {
    if (!steps?.length) throw new Error('replayPlanning: steps must have at least one entry')

    let aborted = false
    if (abortOnDisconnect) sock.ev?.once?.('connection.update', ({ connection }) => { if (connection === 'close') aborted = true })

    await sock.sendPresenceUpdate('composing', jid)

    const initial = steps.map(s => ({ ...s, status: PlanningStepStatus.IN_PROGRESS }))
    const placeholder = await sock.sendMessage(jid, buildPlainPlaceholder(description, initial, placeholderText))
    const key = placeholder?.key

    try {
        const current = [...initial]
        for (let i = 0; i < current.length; i++) {
            if (aborted) break
            await delay(stepDelayMs)
            if (aborted) break
            current[i] = { ...current[i], status: PlanningStepStatus.DONE }
            if (key) await sock.sendMessage(jid, { edit: key, ...buildPlainPlaceholder(description, current, placeholderText) })
        }
        if (!aborted && finalPauseMs > 0) await delay(finalPauseMs)
        if (key && !aborted) await sock.sendMessage(jid, { delete: key })
    } catch (_) {
        try { if (key) await sock.sendMessage(jid, { delete: key }) } catch (__) {}
    }

    await sock.sendPresenceUpdate('paused', jid)
    if (sendOptions._skipFinalSend) return placeholder
    return sock.sendMessage(jid, finalContent, sendOptions)
}

// Animation without a final message.
export const replayPlanningOnly = (sock, jid, steps, options = {}) =>
    replayPlanning(sock, jid, steps, null, { ...options, sendOptions: { ...options.sendOptions, _skipFinalSend: true } })

export const buildReasoningSteps = (titles) => titles.map(title => ({ title, isReasoning: true }))
export const buildSearchSteps = (titles) => titles.map(title => ({ title, isEnhancedSearch: true }))
export const mixedSteps = (defs) => defs.map(({ title, body, type }) => ({
    title,
    ...(body ? { body } : {}),
    ...(type === 'reasoning' ? { isReasoning: true } : {}),
    ...(type === 'search' ? { isEnhancedSearch: true } : {})
}))
