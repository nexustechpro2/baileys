import { getBinaryNodeChild } from '../../WABinary/index.js';

export const USYNC_FEATURES = ['document', 'encrypt', 'encrypt_blist', 'encrypt_contact', 'encrypt_group_gen2', 'encrypt_image', 'encrypt_location', 'encrypt_url', 'encrypt_v2', 'voip', 'voip_legacy', 'multi_agent', 'bot_eligible'];

const CAMEL_MAP = { encrypt_v2: 'encryptV2', voip_legacy: 'voipLegacy', multi_agent: 'multiAgent', bot_eligible: 'botEligible', encrypt_blist: 'encryptBlist', encrypt_contact: 'encryptContact', encrypt_group_gen2: 'encryptGroupGen2', encrypt_image: 'encryptImage', encrypt_location: 'encryptLocation', encrypt_url: 'encryptUrl' };

export class USyncFeatureProtocol {
    constructor(features) { this.name = 'feature'; this.features = features?.length ? features : USYNC_FEATURES; }

    getQueryElement() { return { tag: 'feature', attrs: {}, content: this.features.map(f => ({ tag: f, attrs: {} })) }; }

    getUserElement() { return null; }

    parser(node) {
        if (node.tag !== 'feature') return null;
        const errorNode = getBinaryNodeChild(node, 'error');
        if (errorNode) return { errorCode: errorNode.attrs?.code ? +errorNode.attrs.code : undefined, errorText: errorNode.attrs?.text };
        const features = {};
        for (const child of (Array.isArray(node.content) ? node.content : [])) {
            if (child?.attrs && child.attrs.value !== undefined) features[CAMEL_MAP[child.tag] || child.tag] = child.attrs.value;
        }
        return features;
    }
}
