const parseJsonObject = v => {
    if (!v) return {}
    if (typeof v === 'object') return v
    try { const p = JSON.parse(v); return p && typeof p === 'object' ? p : {} } catch { return {} }
}

export const parseNativeFlowResponse = (message) => {
    const content = message?.message || message
    const response = content?.interactiveResponseMessage?.nativeFlowResponseMessage || content?.nativeFlowResponseMessage
    if (!response) return null
    const params = parseJsonObject(response.paramsJson)
    const actionPayload = params.flow_action_payload || params.flowActionPayload || {}
    const data = params.data || params.response || params.form_data || params.formData || actionPayload.data || {}
    return {
        name: response.name || '',
        version: response.version,
        paramsJson: response.paramsJson || '',
        params,
        isFlow: response.name === 'galaxy_message' || response.name === 'flow' || !!(params.flow_id || params.flow_token || params.flow_message_version),
        flowId: params.flow_id || params.flowId,
        flowToken: params.flow_token || params.flowToken,
        screen: params.screen || actionPayload.screen,
        action: params.flow_action || params.flowAction || actionPayload.action,
        actionPayload,
        data,
        buttonId: params.id || params.button_id || params.buttonId,
        displayText: params.display_text || params.displayText,
        raw: response
    }
}

// Extracts only completed WhatsApp Flow form responses. Returns null for plain buttons.
export const parseWhatsAppFlowResponse = (message) => {
    const response = parseNativeFlowResponse(message)
    return response?.isFlow ? response : null
}

export const buildWhatsAppFlowButton = ({ flowId, flowToken, cta = 'Open form', action = 'navigate', actionPayload, mode = 'published', flowMessageVersion = '3', metadata, name = 'galaxy_message' } = {}) => {
    if (!flowId) throw new TypeError('flowId is required')
    if (!flowToken) throw new TypeError('flowToken is required')
    return {
        name, flow_message_version: String(flowMessageVersion), flow_token: String(flowToken),
        flow_id: String(flowId), flow_cta: String(cta), flow_action: action,
        ...(actionPayload ? { flow_action_payload: actionPayload } : {}),
        ...(metadata ? { flow_metadata: metadata } : {})
    }
}

export const makeWhatsAppFlowButton = (flow) => ({
    name: flow?.nativeFlowName || 'galaxy_message',
    buttonParamsJson: JSON.stringify(buildWhatsAppFlowButton(flow))
})
