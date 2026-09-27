import { assertNodeErrorFree } from '../../WABinary/index.js';

export class USyncStatusProtocol {
    constructor() { this.name = 'status'; }

    getQueryElement() { return { tag: 'status', attrs: {} }; }

    getUserElement() { return null; }

    parser(node) {
        if (node.tag !== 'status') return;
        assertNodeErrorFree(node);
        const setAt = new Date(+(node.attrs.t || 0) * 1000);
        let status = node.content?.toString() ?? null;
        if (!status) status = (node.attrs?.code && +node.attrs.code === 401) ? '' : null;
        else if (status.length === 0) status = null;
        return { status, setAt };
    }
}
