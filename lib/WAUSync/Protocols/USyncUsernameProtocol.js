import { assertNodeErrorFree } from '../../WABinary/index.js'
import { USyncUser } from '../USyncUser.js'
export class USyncUsernameProtocol {
    constructor() {
        this.name = 'username'
    }
    getQueryElement() {
        return {
            tag: 'username',
            attrs: {}
        }
    }
    getUserElement(user) {
        void user
        return null
    }
    parser(node) {
        if (node.tag === 'username') {
            assertNodeErrorFree(node)
            if (typeof node.content === 'string') return node.content
            if (node.attrs?.username) return node.attrs.username
            return null
        }
        return null
    }
}
//# sourceMappingURL=USyncUsernameProtocol.js.map