import { proto } from '../../WAProto/index.js'
import { generateMessageIDV2, unixTimestampSeconds } from '../Utils/index.js'
import { getBinaryNodeChild, getBinaryNodeChildren, getBinaryNodeChildString, isLidUser, isPnUser, jidEncode, jidNormalizedUser } from '../WABinary/index.js'
import { makeChatsSocket } from './chats.js'

// ─── Metadata extraction ──────────────────────────────────────────────────────

const extractParticipants = (group) =>
    getBinaryNodeChildren(group, 'participant').map(({ attrs }) => ({
        id: attrs.jid,
        jid: attrs.phone_number || attrs.jid,
        phoneNumber: isLidUser(attrs.jid) && isPnUser(attrs.phone_number) ? attrs.phone_number : undefined,
        lid: isPnUser(attrs.jid) && isLidUser(attrs.lid) ? attrs.lid : undefined,
        admin: attrs.type || null
    }))

const extractDescriptionFields = (group) => {
    const descChild = getBinaryNodeChild(group, 'description')
    if (!descChild) return {}
    return {
        desc: getBinaryNodeChildString(descChild, 'body'),
        descId: descChild.attrs.id,
        descOwner: descChild.attrs.participant ? jidNormalizedUser(descChild.attrs.participant) : undefined,
        descOwnerPn: descChild.attrs.participant_pn ? jidNormalizedUser(descChild.attrs.participant_pn) : undefined,
        descTime: +descChild.attrs.t,
    }
}

export const extractGroupMetadata = (result) => {
    const group = getBinaryNodeChild(result, 'group')
    if (!group) throw new Error('Group node not found in result')
    const groupId = group.attrs.id.includes('@') ? group.attrs.id : jidEncode(group.attrs.id, 'g.us')
    const eph = getBinaryNodeChild(group, 'ephemeral')?.attrs.expiration
    return {
        id: groupId,
        notify: group.attrs.notify,
        addressingMode: group.attrs.addressing_mode === 'lid' ? 'lid' : 'pn',
        subject: group.attrs.subject,
        subjectOwner: group.attrs.s_o,
        subjectOwnerPn: group.attrs.s_o_pn,
        subjectTime: +group.attrs.s_t,
        size: group.attrs.size ? +group.attrs.size : getBinaryNodeChildren(group, 'participant').length,
        creation: +group.attrs.creation,
        owner: group.attrs.creator ? jidNormalizedUser(group.attrs.creator) : undefined,
        ownerPn: group.attrs.creator_pn ? jidNormalizedUser(group.attrs.creator_pn) : undefined,
        owner_country_code: group.attrs.creator_country_code,
        ...extractDescriptionFields(group),
        linkedParent: getBinaryNodeChild(group, 'linked_parent')?.attrs.jid || undefined,
        restrict: !!getBinaryNodeChild(group, 'locked'),
        announce: !!getBinaryNodeChild(group, 'announcement'),
        isCommunity: !!getBinaryNodeChild(group, 'parent'),
        isCommunityAnnounce: !!getBinaryNodeChild(group, 'default_sub_group'),
        joinApprovalMode: !!getBinaryNodeChild(group, 'membership_approval_mode'),
        memberAddMode: getBinaryNodeChildString(group, 'member_add_mode') === 'all_member_add',
        participants: extractParticipants(group),
        ephemeralDuration: eph ? +eph : undefined
    }
}

// Variant for AI groups — parses from a `create` wrapper or bare group node.
export const extractAIGroupMetadata = (result) => {
    const createNode = getBinaryNodeChild(result, 'create')
    const group = getBinaryNodeChild(createNode || result, 'group') || getBinaryNodeChild(result, 'group')
    const groupId = group.attrs.id.includes('@') ? group.attrs.id : jidEncode(group.attrs.id, 'g.us')
    const eph = getBinaryNodeChild(group, 'ephemeral')?.attrs.expiration
    return {
        id: groupId,
        subject: group.attrs.subject,
        subjectTime: +group.attrs.s_t,
        creation: +group.attrs.creation,
        owner: group.attrs.creator ? jidNormalizedUser(group.attrs.creator) : undefined,
        ownerPn: group.attrs.creator_pn ? jidNormalizedUser(group.attrs.creator_pn) : undefined,
        owner_country_code: group.attrs.creator_country_code,
        size: group.attrs.size ? +group.attrs.size : getBinaryNodeChildren(group, 'participant').length,
        ...extractDescriptionFields(group),
        isAIGroup: true,
        addressingMode: group.attrs.addressing_mode === 'lid' ? 'lid' : 'pn',
        participants: extractParticipants(group),
        ephemeralDuration: eph ? +eph : undefined
    }
}

// ─── Socket layer ─────────────────────────────────────────────────────────────

export const makeGroupsSocket = (config) => {
    const sock = makeChatsSocket(config)
    const { authState, ev, query, upsertMessage, logger } = sock

    // Single group query helper — used for both regular and AI groups.
    const groupQuery = (jid, type, content) => query({ tag: 'iq', attrs: { type, xmlns: 'w:g2', to: jid }, content })

    const groupMetadata = async (jid) => {
        for (let i = 0; i < 20; i++) {
            try {
                const result = await groupQuery(jid, 'get', [{ tag: 'query', attrs: { request: 'interactive' } }])
                return extractGroupMetadata(result)
            } catch (error) {
                if (error?.data === 429 || error?.isRateLimit) {
                    await new Promise(r => setTimeout(r, 300 + Math.random() * 700))
                    continue
                }
                throw error
            }
        }
    }

    const aiGroupMetadata = async (jid) =>
        extractAIGroupMetadata(await groupQuery(jid, 'get', [{ tag: 'query', attrs: { request: 'interactive' } }]))

    sock.ws.on('CB:notification,w:gp2', async node => {
        const { attrs, content } = node
        if (!Array.isArray(content) || content.length === 0) return
        const inner = content[0]
        const tag = inner.tag
        const groupId = typeof attrs.from === 'string' ? attrs.from : attrs.from?.$1?.user ? jidEncode(attrs.from.$1.user, 'g.us') : undefined
        if (!groupId) return
        if (tag === 'create') {
            try { ev.emit('groups.upsert', [await aiGroupMetadata(groupId)]) } catch { ev.emit('groups.upsert', [{ id: groupId }]) }
        } else if (['promote', 'demote', 'remove', 'add'].includes(tag)) {
            const participants = getBinaryNodeChildren(inner, 'participant').map(p => {
                const jid = p.attrs.jid
                if (typeof jid === 'string') return jid
                if (jid?.$1) return jidEncode(jid.$1.user, jid.$1.server || 's.whatsapp.net')
                return undefined
            }).filter(Boolean)
            ev.emit('group-participants.update', { id: groupId, participants, action: tag })
        } else if (tag === 'subject') {
            ev.emit('groups.update', [{ id: groupId, subject: inner.attrs?.subject }])
        }
        await sock.sendMessageAck(node)
    })

    const groupFetchAllParticipating = async () => {
        const result = await query({
            tag: 'iq',
            attrs: { to: '@g.us', xmlns: 'w:g2', type: 'get' },
            content: [{ tag: 'participating', attrs: {}, content: [{ tag: 'participants', attrs: {} }, { tag: 'description', attrs: {} }] }]
        })
        const data = {}
        const groupsChild = getBinaryNodeChild(result, 'groups')
        if (groupsChild) {
            for (const groupNode of getBinaryNodeChildren(groupsChild, 'group')) {
                const meta = extractGroupMetadata({ tag: 'result', attrs: {}, content: [groupNode] })
                data[meta.id] = meta
            }
        }
        sock.ev.emit('groups.update', Object.values(data))
        return data
    }

    sock.ws.on('CB:ib,,dirty', async (node) => {
        const { attrs } = getBinaryNodeChild(node, 'dirty')
        if (attrs.type !== 'groups') return
        await groupFetchAllParticipating()
        await sock.cleanDirtyBits('groups')
    })

    return {
        ...sock,
        groupMetadata,
        groupCreate: async (subject, participants) => {
            const key = generateMessageIDV2()
            const result = await groupQuery('@g.us', 'set', [{ tag: 'create', attrs: { subject, key }, content: participants.map(jid => ({ tag: 'participant', attrs: { jid } })) }])
            return extractGroupMetadata(result)
        },
        groupLeave: async (id) => {
            await groupQuery('@g.us', 'set', [{ tag: 'leave', attrs: {}, content: [{ tag: 'group', attrs: { id } }] }])
        },
        groupUpdateSubject: async (jid, subject) => {
            await groupQuery(jid, 'set', [{ tag: 'subject', attrs: {}, content: Buffer.from(subject, 'utf-8') }])
        },
        groupRequestParticipantsList: async (jid) => {
            const result = await groupQuery(jid, 'get', [{ tag: 'membership_approval_requests', attrs: {} }])
            const node = getBinaryNodeChild(result, 'membership_approval_requests')
            return getBinaryNodeChildren(node, 'membership_approval_request').map(v => v.attrs)
        },
        groupRequestParticipantsUpdate: async (jid, participants, action) => {
            const result = await groupQuery(jid, 'set', [{
                tag: 'membership_requests_action',
                attrs: {},
                content: [{ tag: action, attrs: {}, content: participants.map(jid => ({ tag: 'participant', attrs: { jid } })) }]
            }])
            const node = getBinaryNodeChild(result, 'membership_requests_action')
            const nodeAction = getBinaryNodeChild(node, action)
            return getBinaryNodeChildren(nodeAction, 'participant').map(p => ({ status: p.attrs.error || '200', jid: p.attrs.jid }))
        },
        groupParticipantsUpdate: async (jid, participants, action) => {
            const result = await groupQuery(jid, 'set', [{ tag: action, attrs: {}, content: participants.map(jid => ({ tag: 'participant', attrs: { jid } })) }])
            const node = getBinaryNodeChild(result, action)
            return getBinaryNodeChildren(node, 'participant').map(p => ({ status: p.attrs.error || '200', jid: p.attrs.jid, content: p }))
        },
        groupUpdateDescription: async (jid, description) => {
            const metadata = await groupMetadata(jid)
            const prev = metadata.descId ?? null
            await groupQuery(jid, 'set', [{
                tag: 'description',
                attrs: {
                    ...(description ? { id: generateMessageIDV2() } : { delete: 'true' }),
                    ...(prev ? { prev } : {})
                },
                content: description ? [{ tag: 'body', attrs: {}, content: Buffer.from(description, 'utf-8') }] : undefined
            }])
        },
        groupInviteCode: async (jid) => {
            const result = await groupQuery(jid, 'get', [{ tag: 'invite', attrs: {} }])
            return getBinaryNodeChild(result, 'invite')?.attrs.code
        },
        groupRevokeInvite: async (jid) => {
            const result = await groupQuery(jid, 'set', [{ tag: 'invite', attrs: {} }])
            return getBinaryNodeChild(result, 'invite')?.attrs.code
        },
        groupAcceptInvite: async (code) => {
            const results = await groupQuery('@g.us', 'set', [{ tag: 'invite', attrs: { code } }])
            return getBinaryNodeChild(results, 'group')?.attrs.jid
        },
        groupRevokeInviteV4: async (groupJid, invitedJid) => {
            const result = await groupQuery(groupJid, 'set', [{ tag: 'revoke', attrs: {}, content: [{ tag: 'participant', attrs: { jid: invitedJid } }] }])
            return !!result
        },
        groupAcceptInviteV4: ev.createBufferedFunction(async (key, inviteMessage) => {
            key = typeof key === 'string' ? { remoteJid: key } : key
            const results = await groupQuery(inviteMessage.groupJid, 'set', [{
                tag: 'accept',
                attrs: { code: inviteMessage.inviteCode, expiration: inviteMessage.inviteExpiration.toString(), admin: key.remoteJid }
            }])
            if (key.id) {
                const expired = proto.Message.GroupInviteMessage.fromObject(inviteMessage)
                expired.inviteExpiration = 0
                expired.inviteCode = ''
                ev.emit('messages.update', [{ key, update: { message: { groupInviteMessage: expired } } }])
            }
            await upsertMessage({
                key: { remoteJid: inviteMessage.groupJid, id: generateMessageIDV2(sock.user?.id), fromMe: false, participant: key.remoteJid },
                messageStubType: proto.WebMessageInfo.StubType.GROUP_PARTICIPANT_ADD,
                messageStubParameters: [JSON.stringify(authState.creds.me)],
                participant: key.remoteJid,
                messageTimestamp: unixTimestampSeconds()
            }, 'notify')
            return results.attrs.from
        }),
        groupGetInviteInfo: async (code) => {
            const results = await groupQuery('@g.us', 'get', [{ tag: 'invite', attrs: { code } }])
            return extractGroupMetadata(results)
        },
        groupToggleEphemeral: async (jid, ephemeralExpiration) => {
            const content = ephemeralExpiration
                ? { tag: 'ephemeral', attrs: { expiration: ephemeralExpiration.toString() } }
                : { tag: 'not_ephemeral', attrs: {} }
            await groupQuery(jid, 'set', [content])
        },
        groupSettingUpdate: async (jid, setting) => {
            await groupQuery(jid, 'set', [{ tag: setting, attrs: {} }])
        },
        groupMemberAddMode: async (jid, mode) => {
            await groupQuery(jid, 'set', [{ tag: 'member_add_mode', attrs: {}, content: mode }])
        },
        groupJoinApprovalMode: async (jid, mode) => {
            await groupQuery(jid, 'set', [{ tag: 'membership_approval_mode', attrs: {}, content: [{ tag: 'group_join', attrs: { state: mode } }] }])
        },
        groupFetchAllParticipating,
        aiGroupMetadata,
        aiGroupCreate: async (subject, participants = [], options = {}) => {
            const key = generateMessageIDV2()
            const { autoAddBot = true, botUser = '867051314767696' } = options
            const groupNode = await groupQuery('@g.us', 'set', [{ tag: 'create', attrs: { subject, key }, content: participants.map(jid => ({ tag: 'participant', attrs: { jid } })) }])
            const metadata = extractAIGroupMetadata(groupNode)
            if (autoAddBot !== false && metadata?.id) {
                try {
                    await groupQuery(metadata.id, 'set', [{ tag: 'add', attrs: {}, content: [{ tag: 'participant', attrs: { jid: `${botUser}@bot` } }] }])
                } catch (err) {
                    logger.warn({ err, jid: metadata.id }, 'failed to auto-add AI bot after group creation')
                }
            }
            return metadata
        },
        aiGroupAddBot: async (jid, botUser = '867051314767696') => {
            const result = await groupQuery(jid, 'set', [{ tag: 'add', attrs: {}, content: [{ tag: 'participant', attrs: { jid: `${botUser}@bot` } }] }])
            const node = getBinaryNodeChild(result, 'add')
            return getBinaryNodeChildren(node, 'participant').map(p => ({ status: p.attrs.error || '200', jid: p.attrs.jid }))
        },
        aiGroupLeave: async (id) => groupQuery('@g.us', 'set', [{ tag: 'leave', attrs: {}, content: [{ tag: 'group', attrs: { id } }] }]),
        aiGroupParticipantsUpdate: async (jid, participants, action) => {
            const result = await groupQuery(jid, 'set', [{ tag: action, attrs: {}, content: participants.map(jid => ({ tag: 'participant', attrs: { jid } })) }])
            const node = getBinaryNodeChild(result, action)
            return getBinaryNodeChildren(node, 'participant').map(p => ({ status: p.attrs.error || '200', jid: p.attrs.jid }))
        },
        aiGroupUpdateSubject: async (jid, subject) => groupQuery(jid, 'set', [{ tag: 'subject', attrs: {}, content: Buffer.from(subject, 'utf-8') }]),
        aiGroupInviteCode: async (jid) => getBinaryNodeChild(await groupQuery(jid, 'get', [{ tag: 'invite', attrs: {} }]), 'invite')?.attrs.code,
        aiGroupRevokeInvite: async (jid) => getBinaryNodeChild(await groupQuery(jid, 'set', [{ tag: 'invite', attrs: {} }]), 'invite')?.attrs.code,
        aiGroupAcceptInvite: async (code) => getBinaryNodeChild(await groupQuery('@g.us', 'set', [{ tag: 'invite', attrs: { code } }]), 'group')?.attrs.jid,
        aiGroupSettingUpdate: async (jid, setting) => groupQuery(jid, 'set', [{ tag: setting, attrs: {} }]),
        aiGroupToggleEphemeral: async (jid, ephemeralExpiration) => groupQuery(jid, 'set', [ephemeralExpiration ? { tag: 'ephemeral', attrs: { expiration: ephemeralExpiration.toString() } } : { tag: 'not_ephemeral', attrs: {} }]),
    }
}