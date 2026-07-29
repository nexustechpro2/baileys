import { getBinaryNodeChild } from '../WABinary/index.js'
import { USyncUser } from './USyncUser.js'
import { USyncContactProtocol, USyncDeviceProtocol, USyncDisappearingModeProtocol, USyncStatusProtocol, USyncUsernameProtocol, USyncBotProfileProtocol, USyncLIDProtocol, USyncBusinessProtocol, USyncPictureProtocol, USyncTextStatusProtocol, USyncSidelistProtocol, USyncFeatureProtocol } from './Protocols/index.js'
export class USyncQuery {
    constructor() {
        this.protocols = []
        this.users = []
        this.context = 'interactive'
        this.mode = 'query'
    }
    withMode(mode) {
        this.mode = mode
        return this
    }
    withContext(context) {
        this.context = context
        return this
    }
    withUser(user) {
        this.users.push(user)
        return this
    }
    parseUSyncQueryResult(result) {
        if (!result || result.attrs.type !== 'result') {
            return
        }
        const protocolMap = Object.fromEntries(this.protocols.map(protocol => {
            return [protocol.name, protocol.parser]
        }))
        const queryResult = {
            // TODO: implement errors etc.
            list: [],
            sideList: []
        }
        const usyncNode = getBinaryNodeChild(result, 'usync')
        const parseUserNodes = nodes => nodes.reduce((acc, node) => {
            const id = node?.attrs?.jid
            if (id) {
                const data = Array.isArray(node?.content)
                    ? Object.fromEntries(node.content.map(content => {
                        const parser = protocolMap[content.tag]
                        return parser ? [content.tag, parser(content)] : [content.tag, null]
                    }).filter(([, b]) => b !== null))
                    : {}
                acc.push({ ...data, id })
            }
            return acc
        }, [])
        const listNode = usyncNode ? getBinaryNodeChild(usyncNode, 'list') : undefined
        if (listNode?.content && Array.isArray(listNode.content)) queryResult.list = parseUserNodes(listNode.content)
        const sideListNode = usyncNode ? getBinaryNodeChild(usyncNode, 'side_list') : undefined
        if (sideListNode?.content && Array.isArray(sideListNode.content)) queryResult.sideList = parseUserNodes(sideListNode.content)
        return queryResult
    }
    withDeviceProtocol() {
        this.protocols.push(new USyncDeviceProtocol())
        return this
    }
    withContactProtocol() {
        this.protocols.push(new USyncContactProtocol())
        return this
    }
    withStatusProtocol() {
        this.protocols.push(new USyncStatusProtocol())
        return this
    }
    withDisappearingModeProtocol() {
        this.protocols.push(new USyncDisappearingModeProtocol())
        return this
    }
    withBotProfileProtocol() {
        this.protocols.push(new USyncBotProfileProtocol())
        return this
    }
    withLIDProtocol() {
        this.protocols.push(new USyncLIDProtocol())
        return this
    }
    withUsernameProtocol() {
        this.protocols.push(new USyncUsernameProtocol())
        return this
    }
    withBusinessProtocol(profileVersion) {
        this.protocols.push(new USyncBusinessProtocol(profileVersion))
        return this
    }
    withPictureProtocol(type) {
        this.protocols.push(new USyncPictureProtocol(type))
        return this
    }
    withTextStatusProtocol() {
        this.protocols.push(new USyncTextStatusProtocol())
        return this
    }
    withSidelistProtocol(useLidAddressing) {
        this.protocols.push(new USyncSidelistProtocol(useLidAddressing))
        return this
    }
    withFeatureProtocol(features) {
        this.protocols.push(new USyncFeatureProtocol(features))
        return this
    }
}
//# sourceMappingURL=USyncQuery.js.map