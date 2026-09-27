export class USyncLIDProtocol {
    constructor() { this.name = 'lid'; }

    getQueryElement() { return { tag: 'lid', attrs: {} }; }

    getUserElement(user) { return user.lid ? { tag: 'lid', attrs: { jid: user.lid } } : null; }

    parser(node) { return node.tag === 'lid' ? node.attrs.val : null; }
}
