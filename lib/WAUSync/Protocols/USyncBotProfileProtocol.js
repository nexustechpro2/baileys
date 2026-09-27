import { getBinaryNodeChild, getBinaryNodeChildren, getBinaryNodeChildString } from '../../WABinary/index.js';

export class USyncBotProfileProtocol {
    constructor() { this.name = 'bot'; }

    getQueryElement() { return { tag: 'bot', attrs: {}, content: [{ tag: 'profile', attrs: { v: '1' } }] }; }

    getUserElement(user) { return { tag: 'bot', attrs: {}, content: [{ tag: 'profile', attrs: { persona_id: user.personaId } }] }; }

    parser(node) {
        const botNode      = getBinaryNodeChild(node, 'bot');
        const profile      = getBinaryNodeChild(botNode, 'profile');
        const commandsNode = getBinaryNodeChild(profile, 'commands');
        const promptsNode  = getBinaryNodeChild(profile, 'prompts');
        const commands = getBinaryNodeChildren(commandsNode, 'command').map(c => ({ name: getBinaryNodeChildString(c, 'name'), description: getBinaryNodeChildString(c, 'description') }));
        const prompts  = getBinaryNodeChildren(promptsNode, 'prompt').map(p => `${getBinaryNodeChildString(p, 'emoji')} ${getBinaryNodeChildString(p, 'text')}`);
        return {
            isDefault: !!getBinaryNodeChild(profile, 'default'),
            jid: node.attrs.jid,
            name: getBinaryNodeChildString(profile, 'name'),
            attributes: getBinaryNodeChildString(profile, 'attributes'),
            description: getBinaryNodeChildString(profile, 'description'),
            category: getBinaryNodeChildString(profile, 'category'),
            personaId: profile.attrs['persona_id'],
            commandsDescription: getBinaryNodeChildString(commandsNode, 'description'),
            commands,
            prompts
        };
    }
}
