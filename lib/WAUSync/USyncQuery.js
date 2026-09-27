import { getBinaryNodeChild } from '../WABinary/index.js';
import { USyncContactProtocol }          from './Protocols/USyncContactProtocol.js';
import { USyncDeviceProtocol }            from './Protocols/USyncDeviceProtocol.js';
import { USyncDisappearingModeProtocol }  from './Protocols/USyncDisappearingModeProtocol.js';
import { USyncStatusProtocol }            from './Protocols/USyncStatusProtocol.js';
import { USyncUsernameProtocol }          from './Protocols/USyncUsernameProtocol.js';
import { USyncBotProfileProtocol }        from './Protocols/USyncBotProfileProtocol.js';
import { USyncLIDProtocol }               from './Protocols/USyncLIDProtocol.js';
import { USyncBusinessProtocol }          from './Protocols/USyncBusinessProtocol.js';
import { USyncPictureProtocol }           from './Protocols/USyncPictureProtocol.js';
import { USyncTextStatusProtocol }        from './Protocols/USyncTextStatusProtocol.js';
import { USyncSidelistProtocol }          from './Protocols/USyncSidelistProtocol.js';
import { USyncFeatureProtocol }           from './Protocols/USyncFeatureProtocol.js';

export class USyncQuery {
    constructor() { this.protocols = []; this.users = []; this.context = 'interactive'; this.mode = 'query'; }

    withMode(mode)         { this.mode = mode; return this; }
    withContext(context)   { this.context = context; return this; }
    withUser(user)         { this.users.push(user); return this; }

    parseUSyncQueryResult(result) {
        if (!result || result.attrs.type !== 'result') return;

        const protocolMap  = Object.fromEntries(this.protocols.map(p => [p.name, p.parser.bind(p)]));
        const queryResult  = { errors: {}, refresh: {}, list: [], sideList: [] };
        const usyncNode    = getBinaryNodeChild(result, 'usync');

        // Collect per-protocol errors and refresh hints from the result node
        const resultNode = usyncNode ? getBinaryNodeChild(usyncNode, 'result') : undefined;
        if (resultNode) {
            for (const protocol of this.protocols) {
                const pNode     = getBinaryNodeChild(resultNode, protocol.name);
                if (!pNode) continue;
                const errorNode = getBinaryNodeChild(pNode, 'error');
                if (errorNode) queryResult.errors[protocol.name] = { errorCode: errorNode.attrs.code ? +errorNode.attrs.code : undefined, errorText: errorNode.attrs.text, errorBackoff: errorNode.attrs.backoff ? +errorNode.attrs.backoff : undefined };
                else if (pNode.attrs.refresh !== undefined) queryResult.refresh[protocol.name] = +pNode.attrs.refresh;
            }
        }

        const parseUserNodes = nodes => nodes.reduce((acc, node) => {
            const id = node?.attrs?.jid;
            if (!id) return acc;

            // 401/403/405 on the <user> node means blocked-by
            const userErrCode      = node.attrs?.error ? parseInt(node.attrs.error, 10) : 0;
            const isBlockedByAttr  = userErrCode === 401 || userErrCode === 403 || userErrCode === 405;

            const data = Array.isArray(node.content)
                ? Object.fromEntries(node.content.map(content => {
                    const tag = content.tag;
                    // Extract privacy token inline without a registered protocol
                    if (tag === 'privacy') {
                        const tokenNode  = getBinaryNodeChild(content, 'token');
                        const modeTsNode = getBinaryNodeChild(content, 'mode_ts');
                        const tokenVal   = tokenNode?.content || content.attrs?.token;
                        if (!tokenVal) return ['privacy', null];
                        return ['privacy', { token: Buffer.isBuffer(tokenVal) || tokenVal instanceof Uint8Array ? Buffer.from(tokenVal) : tokenVal, modeTs: modeTsNode?.content?.toString?.() || modeTsNode?.attrs?.value || content.attrs?.mode_ts || null }];
                    }
                    const parser = protocolMap[tag];
                    if (!parser) return [tag, null];
                    try { return [tag, parser(content)]; }
                    catch (err) {
                        const code = err?.data ?? err?.output?.payload?.data;
                        if (code === 401 || code === 403 || code === 405) return ['isBlockedByContact', true];
                        throw err;
                    }
                }).filter(([, v]) => v !== null))
                : {};

            if (isBlockedByAttr) data.isBlockedByContact = true;

            // Remap snake_case key to camelCase
            if ('disappearing_mode' in data) { data.disappearingMode = data.disappearing_mode; delete data.disappearing_mode; }

            acc.push({ ...data, id });
            return acc;
        }, []);

        const listNode     = usyncNode ? getBinaryNodeChild(usyncNode, 'list')      : undefined;
        const sideListNode = usyncNode ? getBinaryNodeChild(usyncNode, 'side_list') : undefined;
        if (listNode?.content     && Array.isArray(listNode.content))     queryResult.list     = parseUserNodes(listNode.content);
        if (sideListNode?.content && Array.isArray(sideListNode.content)) queryResult.sideList = parseUserNodes(sideListNode.content);

        return queryResult;
    }

    withDeviceProtocol()                        { this.protocols.push(new USyncDeviceProtocol());                      return this; }
    withContactProtocol()                       { this.protocols.push(new USyncContactProtocol());                     return this; }
    withStatusProtocol()                        { this.protocols.push(new USyncStatusProtocol());                      return this; }
    withDisappearingModeProtocol()              { this.protocols.push(new USyncDisappearingModeProtocol());            return this; }
    withBotProfileProtocol()                    { this.protocols.push(new USyncBotProfileProtocol());                  return this; }
    withLIDProtocol()                           { this.protocols.push(new USyncLIDProtocol());                         return this; }
    withUsernameProtocol()                      { this.protocols.push(new USyncUsernameProtocol());                    return this; }
    withBusinessProtocol(profileVersion)        { this.protocols.push(new USyncBusinessProtocol(profileVersion));      return this; }
    withPictureProtocol(type)                   { this.protocols.push(new USyncPictureProtocol(type));                 return this; }
    withTextStatusProtocol()                    { this.protocols.push(new USyncTextStatusProtocol());                  return this; }
    withSidelistProtocol(useLidAddressing)      { this.protocols.push(new USyncSidelistProtocol(useLidAddressing));    return this; }
    withFeatureProtocol(features)               { this.protocols.push(new USyncFeatureProtocol(features));             return this; }
}
