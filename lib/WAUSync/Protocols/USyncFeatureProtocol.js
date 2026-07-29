import { getBinaryNodeChild } from '../../WABinary/index.js'

export const USYNC_FEATURES = ['document', 'encrypt', 'encrypt_blist', 'encrypt_contact', 'encrypt_group_gen2', 'encrypt_image', 'encrypt_location', 'encrypt_url', 'encrypt_v2', 'voip', 'multi_agent']

export class USyncFeatureProtocol {
    constructor(features) {
        this.name = 'feature'
        this.features = features?.length ? features : USYNC_FEATURES
    }
    getQueryElement() {
        return { tag: 'feature', attrs: {}, content: this.features.map(feature => ({ tag: feature, attrs: {} })) }
    }
    getUserElement() { return null }
    parser(node) {
        if (node.tag !== 'feature') return null
        const errorNode = getBinaryNodeChild(node, 'error')
        if (errorNode) return { errorCode: errorNode.attrs?.code ? +errorNode.attrs.code : undefined, errorText: errorNode.attrs?.text }
        const features = {}
        const children = Array.isArray(node.content) ? node.content : []
        for (const child of children) if (child?.attrs && child.attrs.value !== undefined) features[child.tag] = child.attrs.value
        return features
    }
}