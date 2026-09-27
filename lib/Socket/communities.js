import { generateMessageID } from '../Utils/index.js'
import { getBinaryNodeChild, getBinaryNodeChildren, getBinaryNodeChildString, jidEncode, jidNormalizedUser } from '../WABinary/index.js'
import { makeBusinessSocket } from './business.js'

const extractCommunityParticipants = (group) =>
    getBinaryNodeChildren(group, 'participant').map(({ attrs }) => ({
        id: attrs.jid,
        admin: attrs.type || null
    }))

export const extractCommunityMetadata = (result) => {
    const community = getBinaryNodeChild(result, 'community') || getBinaryNodeChild(result, 'group')
    if (!community) throw new Error('Community node not found in result')
    const descChild = getBinaryNodeChild(community, 'description')
    const communityId = community.attrs.id.includes('@') ? community.attrs.id : jidEncode(community.attrs.id, 'g.us')
    return {
        id: communityId,
        subject: community.attrs.subject,
        subjectTime: +community.attrs.s_t,
        creation: +community.attrs.creation,
        owner: community.attrs.creator ? jidNormalizedUser(community.attrs.creator) : undefined,
        desc: descChild ? getBinaryNodeChildString(descChild, 'body') : undefined,
        descId: descChild?.attrs.id,
        participants: extractCommunityParticipants(community)
    }
}

export const makeCommunitiesSocket = (config) => {
    const sock = makeBusinessSocket(config)
    const { ev, query } = sock

    const communityQuery = (jid, type, content) => query({ tag: 'iq', attrs: { type, xmlns: 'w:g2', to: jid }, content })

    const communityMetadata = async (jid) => {
        const result = await communityQuery(jid, 'get', [{ tag: 'query', attrs: { request: 'interactive' } }])
        return extractCommunityMetadata(result)
    }

    const communityFetchAllParticipating = async () => {
        const result = await query({
            tag: 'iq',
            attrs: { to: '@g.us', xmlns: 'w:g2', type: 'get' },
            content: [{ tag: 'participating', attrs: {}, content: [{ tag: 'participants', attrs: {} }, { tag: 'description', attrs: {} }] }]
        })
        const data = {}
        const communitiesChild = getBinaryNodeChild(result, 'communities')
        if (communitiesChild) {
            for (const communityNode of getBinaryNodeChildren(communitiesChild, 'community')) {
                const meta = extractCommunityMetadata({ tag: 'result', attrs: {}, content: [communityNode] })
                data[meta.id] = meta
            }
        }
        ev.emit('groups.update', Object.values(data))
        return data
    }

    sock.ws.on('CB:ib,,dirty', async (node) => {
        const { attrs } = getBinaryNodeChild(node, 'dirty')
        if (attrs.type !== 'communities') return
        await communityFetchAllParticipating()
        await sock.cleanDirtyBits('groups')
    })

    return {
        ...sock,
        communityMetadata,
        communityCreate: async (subject, body) => {
            const descriptionId = generateMessageID().substring(0, 12)
            const result = await communityQuery('@g.us', 'set', [{
                tag: 'create',
                attrs: { subject },
                content: [
                    { tag: 'description', attrs: { id: descriptionId }, content: [{ tag: 'body', attrs: {}, content: Buffer.from(body || '', 'utf-8') }] },
                    { tag: 'parent', attrs: { default_membership_approval_mode: 'request_required' } },
                    { tag: 'allow_non_admin_sub_group_creation', attrs: {} },
                    { tag: 'create_general_chat', attrs: {} }
                ]
            }])
            const groupNode = getBinaryNodeChild(result, 'group')
            if (!groupNode) return null
            try { return await sock.groupMetadata(`${groupNode.attrs.id}@g.us`) } catch { return null }
        },
        communityCreateGroup: async (subject, participants, parentCommunityJid) => {
            const key = generateMessageID()
            const result = await communityQuery('@g.us', 'set', [{
                tag: 'create',
                attrs: { subject, key },
                content: [
                    ...participants.map(jid => ({ tag: 'participant', attrs: { jid } })),
                    { tag: 'linked_parent', attrs: { jid: parentCommunityJid } }
                ]
            }])
            const groupNode = getBinaryNodeChild(result, 'group')
            if (!groupNode) return null
            try { return await sock.groupMetadata(`${groupNode.attrs.id}@g.us`) } catch { return null }
        },
        communityLeave: async (id) => {
            await communityQuery('@g.us', 'set', [{ tag: 'leave', attrs: {}, content: [{ tag: 'community', attrs: { id } }] }])
        },
        communityUpdateSubject: async (jid, subject) => {
            await communityQuery(jid, 'set', [{ tag: 'subject', attrs: {}, content: Buffer.from(subject, 'utf-8') }])
        },
        communityLinkGroup: async (groupJid, parentCommunityJid) => {
            await communityQuery(parentCommunityJid, 'set', [{
                tag: 'links',
                attrs: {},
                content: [{ tag: 'link', attrs: { link_type: 'sub_group' }, content: [{ tag: 'group', attrs: { jid: groupJid } }] }]
            }])
        },
        communityUnlinkGroup: async (groupJid, parentCommunityJid) => {
            await communityQuery(parentCommunityJid, 'set', [{ tag: 'unlink', attrs: { unlink_type: 'sub_group' }, content: [{ tag: 'group', attrs: { jid: groupJid } }] }])
        },
        communityFetchLinkedGroups: async (jid) => {
            const metadata = await sock.groupMetadata(jid)
            const communityJid = metadata.linkedParent || jid
            const result = await communityQuery(communityJid, 'get', [{ tag: 'sub_groups', attrs: {} }])
            const subGroupsNode = getBinaryNodeChild(result, 'sub_groups')
            if (!subGroupsNode) return []
            return getBinaryNodeChildren(subGroupsNode, 'group').map(g => ({
                id: g.attrs.id.includes('@') ? g.attrs.id : jidEncode(g.attrs.id, 'g.us'),
                subject: g.attrs.subject
            }))
        },
        communityFetchAllParticipating,
        communityParticipantsUpdate: async (jid, participants, action) => {
            const result = await communityQuery(jid, 'set', [{
                tag: action,
                attrs: {},
                content: participants.map(jid => ({ tag: 'participant', attrs: { jid } }))
            }])
            const node = getBinaryNodeChild(result, action)
            return getBinaryNodeChildren(node, 'participant').map(p => ({ status: p.attrs.error || '200', jid: p.attrs.jid }))
        },
        communityAcceptInvite: async (code) => {
            const results = await communityQuery('@g.us', 'set', [{ tag: 'invite', attrs: { code } }])
            return getBinaryNodeChild(results, 'group')?.attrs.jid
        },
        communityInviteCode: async (jid) => {
            const result = await communityQuery(jid, 'get', [{ tag: 'invite', attrs: {} }])
            return getBinaryNodeChild(result, 'invite')?.attrs.code
        },
        communityRevokeInvite: async (jid) => {
            const result = await communityQuery(jid, 'set', [{ tag: 'invite', attrs: {} }])
            return getBinaryNodeChild(result, 'invite')?.attrs.code
        }
    }
}