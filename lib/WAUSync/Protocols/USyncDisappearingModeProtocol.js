import { assertNodeErrorFree } from '../../WABinary/index.js';

export class USyncDisappearingModeProtocol {
    constructor() { this.name = 'disappearing_mode'; }

    getQueryElement() { return { tag: 'disappearing_mode', attrs: {} }; }

    getUserElement() { return null; }

    parser(node) {
        if (node.tag !== 'disappearing_mode') return;
        assertNodeErrorFree(node);
        return { duration: +node.attrs.duration, setAt: new Date(+(node.attrs.t || 0) * 1000) };
    }
}
