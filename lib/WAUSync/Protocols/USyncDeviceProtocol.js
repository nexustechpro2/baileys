import { assertNodeErrorFree, getBinaryNodeChild } from '../../WABinary/index.js';

export class USyncDeviceProtocol {
    constructor() { this.name = 'devices'; }

    getQueryElement() { return { tag: 'devices', attrs: { version: '2' } }; }

    getUserElement() { return null; }

    parser(node) {
        const deviceList = [];
        let keyIndex;
        if (node.tag === 'devices') {
            assertNodeErrorFree(node);
            const deviceListNode = getBinaryNodeChild(node, 'device-list');
            const keyIndexNode   = getBinaryNodeChild(node, 'key-index-list');
            if (Array.isArray(deviceListNode?.content)) {
                for (const { tag, attrs } of deviceListNode.content) {
                    if (tag === 'device') deviceList.push({ id: +attrs.id, keyIndex: +attrs['key-index'], isHosted: attrs['is_hosted'] === 'true' });
                }
            }
            if (keyIndexNode?.tag === 'key-index-list') {
                keyIndex = { timestamp: +keyIndexNode.attrs['ts'], signedKeyIndex: keyIndexNode?.content, expectedTimestamp: keyIndexNode.attrs['expected_ts'] ? +keyIndexNode.attrs['expected_ts'] : undefined };
            }
        }
        return { deviceList, keyIndex };
    }
}
