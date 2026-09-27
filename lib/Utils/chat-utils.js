import { Boom } from '@hapi/boom'
import { expandAppStateKeys } from 'whatsapp-rust-bridge'
import { proto } from '../../WAProto/index.js'
import { LabelAssociationType } from '../Types/LabelAssociation.js'
import { processContactAction, emitSyncActionResults } from './sync-action-utils.js'
import { getBinaryNodeChild, getBinaryNodeChildren, isJidGroup, jidNormalizedUser } from '../WABinary/index.js'
import { aesDecrypt, aesEncrypt, hmacSign } from './crypto.js'
import { toNumber } from './generics.js'
import { LT_HASH_ANTI_TAMPERING } from './lt-hash.js'
import { downloadContentFromMessage } from './messages-media.js'

const OP = proto.SyncdMutation.SyncdOperation

const mutationKeys = keydata => {
    const keys = expandAppStateKeys(keydata)
    return { indexKey: keys.indexKey, valueEncryptionKey: keys.valueEncryptionKey, valueMacKey: keys.valueMacKey, snapshotMacKey: keys.snapshotMacKey, patchMacKey: keys.patchMacKey }
}

const generateMac = (operation, data, keyId, key) => {
    const opByte = operation === OP.SET ? 0x01 : 0x02
    const keyIdBuffer = typeof keyId === 'string' ? Buffer.from(keyId, 'base64') : keyId
    const keyData = new Uint8Array(1 + keyIdBuffer.length)
    keyData[0] = opByte
    keyData.set(keyIdBuffer, 1)
    const last = new Uint8Array(8)
    last[7] = keyData.length
    const total = new Uint8Array(keyData.length + data.length + last.length)
    total.set(keyData, 0); total.set(data, keyData.length); total.set(last, keyData.length + data.length)
    return hmacSign(total, key, 'sha512').subarray(0, 32)
}

const to64BitNetworkOrder = e => { const buff = Buffer.alloc(8); buff.writeUint32BE(e, 4); return buff }

export const makeLtHashGenerator = ({ indexValueMap, hash }) => {
    indexValueMap = { ...indexValueMap }
    const addBuffs = [], subBuffs = []
    return {
        mix: ({ indexMac, valueMac, operation }) => {
            const key = Buffer.from(indexMac).toString('base64')
            const prev = indexValueMap[key]
            if (operation === OP.REMOVE) { if (!prev) return; delete indexValueMap[key] }
            else { addBuffs.push(valueMac); indexValueMap[key] = { valueMac } }
            if (prev) subBuffs.push(prev.valueMac)
        },
        finish: async () => ({ hash: Buffer.from(LT_HASH_ANTI_TAMPERING.subtractThenAdd(hash, subBuffs, addBuffs)), indexValueMap })
    }
}

const generateSnapshotMac = (lthash, version, name, key) => hmacSign(Buffer.concat([lthash, to64BitNetworkOrder(version), Buffer.from(name, 'utf-8')]), key, 'sha256')
const generatePatchMac = (snapshotMac, valueMacs, version, type, key) => hmacSign(Buffer.concat([snapshotMac, ...valueMacs, to64BitNetworkOrder(version), Buffer.from(type, 'utf-8')]), key)

export const newLTHashState = () => ({ version: 0, hash: Buffer.alloc(128), indexValueMap: {} })
export const ensureLTHashStateVersion = state => { if (typeof state.version !== 'number' || isNaN(state.version)) state.version = 0; return state }

export const MAX_SYNC_ATTEMPTS = 2
export const isMissingKeyError = error => error?.data?.isMissingKey === true
export const isAppStateSyncIrrecoverable = (error, attempts) => attempts >= MAX_SYNC_ATTEMPTS || error?.name === 'TypeError'

export const encodeSyncdPatch = async ({ type, index, syncAction, apiVersion, operation }, myAppStateKeyId, state, getAppStateSyncKey) => {
    const key = myAppStateKeyId ? await getAppStateSyncKey(myAppStateKeyId) : undefined
    if (!key) throw new Boom(`myAppStateKey ("${myAppStateKeyId}") not present`, { data: { isMissingKey: true } })
    const encKeyId = Buffer.from(myAppStateKeyId, 'base64')
    state = { ...state, indexValueMap: { ...state.indexValueMap } }
    const indexBuffer = Buffer.from(JSON.stringify(index))
    const dataProto = proto.SyncActionData.fromObject({ index: indexBuffer, value: syncAction, padding: new Uint8Array(0), version: apiVersion })
    const encoded = proto.SyncActionData.encode(dataProto).finish()
    const keyValue = mutationKeys(key.keyData)
    const encValue = aesEncrypt(encoded, keyValue.valueEncryptionKey)
    const valueMac = generateMac(operation, encValue, encKeyId, keyValue.valueMacKey)
    const indexMac = hmacSign(indexBuffer, keyValue.indexKey)
    const generator = makeLtHashGenerator(state)
    generator.mix({ indexMac, valueMac, operation })
    Object.assign(state, await generator.finish())
    state.version += 1
    const snapshotMac = generateSnapshotMac(state.hash, state.version, type, keyValue.snapshotMacKey)
    const patch = {
        patchMac: generatePatchMac(snapshotMac, [valueMac], state.version, type, keyValue.patchMacKey),
        snapshotMac,
        keyId: { id: encKeyId },
        mutations: [{ operation, record: { index: { blob: indexMac }, value: { blob: Buffer.concat([encValue, valueMac]) }, keyId: { id: encKeyId } } }]
    }
    state.indexValueMap[indexMac.toString('base64')] = { valueMac }
    return { patch, state }
}

export const decodeSyncdMutations = async (msgMutations, initialState, getAppStateSyncKey, onMutation, validateMacs) => {
    const ltGenerator = makeLtHashGenerator(initialState)
    const derivedKeyCache = new Map()

    async function getKey(keyId) {
        const base64Key = Buffer.from(keyId).toString('base64')
        if (derivedKeyCache.has(base64Key)) return derivedKeyCache.get(base64Key)
        const keyEnc = await getAppStateSyncKey(base64Key)
        if (!keyEnc) throw new Boom(`failed to find key "${base64Key}" to decode mutation`, { data: { isMissingKey: true, msgMutations } })
        const keys = mutationKeys(keyEnc.keyData)
        derivedKeyCache.set(base64Key, keys)
        return keys
    }

    for (const msgMutation of msgMutations) {
        const operation = 'operation' in msgMutation ? msgMutation.operation : OP.SET
        const record = 'record' in msgMutation && msgMutation.record ? msgMutation.record : msgMutation
        let key
        try { key = await getKey(record.keyId.id) } catch (err) { if (isMissingKeyError(err)) throw err; continue }
        const content = record.value.blob
        const encContent = content.subarray(0, -32)
        const ogValueMac = content.subarray(-32)
        if (validateMacs) {
            const contentHmac = generateMac(operation, encContent, record.keyId.id, key.valueMacKey)
            if (Buffer.compare(contentHmac, ogValueMac) !== 0) continue
        }
        let result
        try { result = aesDecrypt(encContent, key.valueEncryptionKey) } catch { continue }
        const syncAction = proto.SyncActionData.decode(result)
        if (validateMacs) {
            const hmac = hmacSign(syncAction.index, key.indexKey)
            if (Buffer.compare(hmac, record.index.blob) !== 0) throw new Boom('HMAC index verification failed')
        }
        onMutation({ syncAction, index: JSON.parse(Buffer.from(syncAction.index).toString()) })
        ltGenerator.mix({ indexMac: record.index.blob, valueMac: ogValueMac, operation })
    }
    return ltGenerator.finish()
}

export const decodeSyncdPatch = async (msg, name, initialState, getAppStateSyncKey, onMutation, validateMacs) => {
    if (validateMacs) {
        const base64Key = Buffer.from(msg.keyId.id).toString('base64')
        const mainKeyObj = await getAppStateSyncKey(base64Key)
        if (!mainKeyObj) throw new Boom(`failed to find key "${base64Key}" to decode patch`, { data: { isMissingKey: true, msg } })
        const mainKey = mutationKeys(mainKeyObj.keyData)
        const mutationmacs = msg.mutations.map(m => m.record.value.blob.slice(-32))
        const patchMac = generatePatchMac(msg.snapshotMac, mutationmacs, toNumber(msg.version.version), name, mainKey.patchMacKey)
        if (Buffer.compare(patchMac, msg.patchMac) !== 0) throw new Boom('Invalid patch mac')
    }
    return decodeSyncdMutations(msg.mutations, initialState, getAppStateSyncKey, onMutation, validateMacs)
}

export const extractSyncdPatches = async (result, options) => {
    const syncNode = getBinaryNodeChild(result, 'sync')
    const collectionNodes = getBinaryNodeChildren(syncNode, 'collection')
    const final = {}
    await Promise.all(collectionNodes.map(async collectionNode => {
        const patchesNode = getBinaryNodeChild(collectionNode, 'patches')
        const patches = getBinaryNodeChildren(patchesNode || collectionNode, 'patch')
        const snapshotNode = getBinaryNodeChild(collectionNode, 'snapshot')
        const syncds = []
        const name = collectionNode.attrs.name
        const hasMorePatches = collectionNode.attrs.has_more_patches === 'true'
        let snapshot
        if (snapshotNode?.content) {
            if (!Buffer.isBuffer(snapshotNode)) snapshotNode.content = Buffer.from(Object.values(snapshotNode.content))
            const blobRef = proto.ExternalBlobReference.decode(snapshotNode.content)
            snapshot = proto.SyncdSnapshot.decode(await downloadExternalBlob(blobRef, options))
        }
        for (let { content } of patches) {
            if (!content) continue
            if (!Buffer.isBuffer(content)) content = Buffer.from(Object.values(content))
            const syncd = proto.SyncdPatch.decode(content)
            if (!syncd.version) syncd.version = { version: +collectionNode.attrs.version + 1 }
            syncds.push(syncd)
        }
        final[name] = { patches: syncds, hasMorePatches, snapshot }
    }))
    return final
}

export const downloadExternalBlob = async (blob, options) => {
    const stream = await downloadContentFromMessage(blob, 'md-app-state', { options })
    const bufferArray = []
    for await (const chunk of stream) bufferArray.push(chunk)
    return Buffer.concat(bufferArray)
}

export const downloadExternalPatch = async (blob, options) => {
    const buffer = await downloadExternalBlob(blob, options)
    return proto.SyncdMutations.decode(buffer)
}

export const decodeSyncdSnapshot = async (name, snapshot, getAppStateSyncKey, minimumVersionNumber, validateMacs = true, logger) => {
    const newState = newLTHashState()
    newState.version = toNumber(snapshot.version.version)
    const mutationMap = {}
    const areMutationsRequired = minimumVersionNumber === undefined || newState.version > minimumVersionNumber
    const onMutation = areMutationsRequired ? mutation => { const index = mutation.syncAction.index?.toString(); mutationMap[index] = mutation } : () => { }
    const { hash, indexValueMap } = await decodeSyncdMutations(snapshot.records, newState, getAppStateSyncKey, onMutation, validateMacs)
    newState.hash = hash
    newState.indexValueMap = indexValueMap
    if (validateMacs) {
        const base64Key = Buffer.from(snapshot.keyId.id).toString('base64')
        const keyEnc = await getAppStateSyncKey(base64Key)
        if (!keyEnc) throw new Boom(`failed to find key "${base64Key}" to decode mutation`, { data: { isMissingKey: true } })
        const computedSnapshotMac = generateSnapshotMac(newState.hash, newState.version, name, mutationKeys(keyEnc.keyData).snapshotMacKey)
        // soft failure — MAC mismatch on snapshot doesn't abort; state is still usable
        if (Buffer.compare(snapshot.mac, computedSnapshotMac) !== 0) logger?.warn({ name, version: newState.version }, 'LTHash verification failed on snapshot, continuing with partial state')
    }
    return { state: newState, mutationMap }
}

export const decodePatches = async (name, syncds, initial, getAppStateSyncKey, options, minimumVersionNumber, logger, validateMacs = true) => {
    const newState = { ...initial, indexValueMap: { ...initial.indexValueMap } }
    const mutationMap = {}
    for (const syncd of syncds) {
        const { version, keyId, snapshotMac } = syncd
        if (syncd.externalMutations) {
            logger?.trace({ name, version }, 'downloading external patch')
            const ref = await downloadExternalPatch(syncd.externalMutations, options)
            logger?.debug({ name, version, mutations: ref.mutations.length }, 'downloaded external patch')
            syncd.mutations?.push(...ref.mutations)
        }
        const patchVersion = toNumber(version.version)
        newState.version = patchVersion
        const shouldMutate = minimumVersionNumber === undefined || patchVersion > minimumVersionNumber
        const onMutation = shouldMutate ? mutation => { const index = mutation.syncAction.index?.toString(); mutationMap[index] = mutation } : () => { }
        let decodeResult
        try { decodeResult = await decodeSyncdPatch(syncd, name, newState, getAppStateSyncKey, onMutation, validateMacs) }
        catch (err) { if (isMissingKeyError(err)) throw err; logger?.warn({ name, version: patchVersion, error: err.message }, 'failed to decode patch, skipping'); continue }
        newState.hash = decodeResult.hash
        newState.indexValueMap = decodeResult.indexValueMap
        if (validateMacs) {
            const base64Key = Buffer.from(keyId.id).toString('base64')
            const keyEnc = await getAppStateSyncKey(base64Key)
            if (!keyEnc) throw new Boom(`failed to find key "${base64Key}" to decode mutation`, { data: { isMissingKey: true } })
            const computedSnapshotMac = generateSnapshotMac(newState.hash, newState.version, name, mutationKeys(keyEnc.keyData).snapshotMacKey)
            // MAC mismatch mid-patch-stream means state is corrupted from this point; stop processing
            if (Buffer.compare(snapshotMac, computedSnapshotMac) !== 0) { logger?.warn({ name, version: newState.version }, 'LTHash verification failed, skipping remaining patches'); break }
        }
        syncd.mutations = []
    }
    return { state: newState, mutationMap }
}

export const chatModificationToAppPatch = (mod, jid) => {
    const getMessageRange = lastMessages => {
        if (!Array.isArray(lastMessages)) return lastMessages
        const lastMsg = lastMessages[lastMessages.length - 1]
        return {
            lastMessageTimestamp: lastMsg?.messageTimestamp,
            messages: lastMessages?.length ? lastMessages.map(m => {
                if (!m.key?.id || !m.key?.remoteJid) throw new Boom('Incomplete key', { statusCode: 400, data: m })
                if (isJidGroup(m.key.remoteJid) && !m.key.fromMe && !m.key.participant) throw new Boom('Expected not from me message to have participant', { statusCode: 400, data: m })
                if (!m.messageTimestamp || !toNumber(m.messageTimestamp)) throw new Boom('Missing timestamp in last message list', { statusCode: 400, data: m })
                if (m.key.participant) m.key.participant = jidNormalizedUser(m.key.participant)
                return m
            }) : undefined
        }
    }

    let patch
    if ('mute' in mod) patch = { syncAction: { muteAction: { muted: !!mod.mute, muteEndTimestamp: mod.mute || undefined } }, index: ['mute', jid], type: 'regular_high', apiVersion: 2, operation: OP.SET }
    else if ('archive' in mod) patch = { syncAction: { archiveChatAction: { archived: !!mod.archive, messageRange: getMessageRange(mod.lastMessages) } }, index: ['archive', jid], type: 'regular_low', apiVersion: 3, operation: OP.SET }
    else if ('markRead' in mod) patch = { syncAction: { markChatAsReadAction: { read: mod.markRead, messageRange: getMessageRange(mod.lastMessages) } }, index: ['markChatAsRead', jid], type: 'regular_low', apiVersion: 3, operation: OP.SET }
    else if ('deleteForMe' in mod) { const { timestamp, key, deleteMedia } = mod.deleteForMe; patch = { syncAction: { deleteMessageForMeAction: { deleteMedia, messageTimestamp: timestamp } }, index: ['deleteMessageForMe', jid, key.id, key.fromMe ? '1' : '0', '0'], type: 'regular_high', apiVersion: 3, operation: OP.SET } }
    else if ('clear' in mod) patch = { syncAction: { clearChatAction: { messageRange: getMessageRange(mod.lastMessages) } }, index: ['clearChat', jid, '1', '0'], type: 'regular_high', apiVersion: 6, operation: OP.SET }
    else if ('pin' in mod) patch = { syncAction: { pinAction: { pinned: !!mod.pin } }, index: ['pin_v1', jid], type: 'regular_low', apiVersion: 5, operation: OP.SET }
    else if ('contact' in mod) patch = { syncAction: { contactAction: mod.contact || {} }, index: ['contact', jid], type: 'critical_unblock_low', apiVersion: 2, operation: mod.contact ? OP.SET : OP.REMOVE }
    else if ('disableLinkPreviews' in mod) patch = { syncAction: { privacySettingDisableLinkPreviewsAction: mod.disableLinkPreviews || {} }, index: ['setting_disableLinkPreviews'], type: 'regular', apiVersion: 8, operation: OP.SET }
    else if ('star' in mod) { const key = mod.star.messages[0]; patch = { syncAction: { starAction: { starred: !!mod.star.star } }, index: ['star', jid, key.id, key.fromMe ? '1' : '0', '0'], type: 'regular_low', apiVersion: 2, operation: OP.SET } }
    else if ('delete' in mod) patch = { syncAction: { deleteChatAction: { messageRange: getMessageRange(mod.lastMessages) } }, index: ['deleteChat', jid, '1'], type: 'regular_high', apiVersion: 6, operation: OP.SET }
    else if ('pushNameSetting' in mod) patch = { syncAction: { pushNameSetting: { name: mod.pushNameSetting } }, index: ['setting_pushName'], type: 'critical_block', apiVersion: 1, operation: OP.SET }
    else if ('quickReply' in mod) patch = { syncAction: { quickReplyAction: { count: 0, deleted: mod.quickReply.deleted || false, keywords: [], message: mod.quickReply.message || '', shortcut: mod.quickReply.shortcut || '' } }, index: ['quick_reply', mod.quickReply.timestamp || String(Math.floor(Date.now() / 1000))], type: 'regular', apiVersion: 2, operation: OP.SET }
    else if ('addLabel' in mod) patch = { syncAction: { labelEditAction: { name: mod.addLabel.name, color: mod.addLabel.color, predefinedId: mod.addLabel.predefinedId, deleted: mod.addLabel.deleted } }, index: ['label_edit', mod.addLabel.id], type: 'regular', apiVersion: 3, operation: OP.SET }
    else if ('addChatLabel' in mod) patch = { syncAction: { labelAssociationAction: { labeled: true } }, index: [LabelAssociationType.Chat, mod.addChatLabel.labelId, jid], type: 'regular', apiVersion: 3, operation: OP.SET }
    else if ('removeChatLabel' in mod) patch = { syncAction: { labelAssociationAction: { labeled: false } }, index: [LabelAssociationType.Chat, mod.removeChatLabel.labelId, jid], type: 'regular', apiVersion: 3, operation: OP.SET }
    else if ('addMessageLabel' in mod) patch = { syncAction: { labelAssociationAction: { labeled: true } }, index: [LabelAssociationType.Message, mod.addMessageLabel.labelId, jid, mod.addMessageLabel.messageId, '0', '0'], type: 'regular', apiVersion: 3, operation: OP.SET }
    else if ('removeMessageLabel' in mod) patch = { syncAction: { labelAssociationAction: { labeled: false } }, index: [LabelAssociationType.Message, mod.removeMessageLabel.labelId, jid, mod.removeMessageLabel.messageId, '0', '0'], type: 'regular', apiVersion: 3, operation: OP.SET }
    else throw new Boom('not supported')

    patch.syncAction.timestamp = Date.now()
    return patch
}

export const processSyncAction = (syncAction, ev, me, initialSyncOpts, logger) => {
    const isInitialSync = !!initialSyncOpts
    const accountSettings = initialSyncOpts?.accountSettings
    logger?.trace({ syncAction, initialSync: isInitialSync }, 'processing sync action')
    const { syncAction: { value: action }, index: [type, id, msgId, fromMe] } = syncAction

    const getChatUpdateConditional = (id, msgRange) => !isInitialSync ? undefined : data => {
        const chat = data.historySets.chats[id] || data.chatUpserts[id]
        if (!chat) return false
        if (!msgRange) return true
        const lastMsgTimestamp = Number(msgRange?.lastMessageTimestamp || msgRange?.lastSystemMessageTimestamp || 0)
        return lastMsgTimestamp >= Number(chat?.lastMessageRecvTimestamp || 0)
    }

    if (action?.muteAction) ev.emit('chats.update', [{ id, muteEndTime: action.muteAction?.muted ? toNumber(action.muteAction.muteEndTimestamp) : null, conditional: getChatUpdateConditional(id, undefined) }])
    else if (action?.archiveChatAction || type === 'archive' || type === 'unarchive') { const archiveAction = action?.archiveChatAction; ev.emit('chats.update', [{ id, archived: archiveAction ? archiveAction.archived : type === 'archive', conditional: getChatUpdateConditional(id, !accountSettings?.unarchiveChats ? undefined : archiveAction?.messageRange) }]) }
    else if (action?.markChatAsReadAction) ev.emit('chats.update', [{ id, unreadCount: isInitialSync && action.markChatAsReadAction.read ? null : action.markChatAsReadAction?.read ? 0 : -1, conditional: getChatUpdateConditional(id, action.markChatAsReadAction?.messageRange) }])
    else if (action?.deleteMessageForMeAction || type === 'deleteMessageForMe') ev.emit('messages.delete', { keys: [{ remoteJid: id, id: msgId, fromMe: fromMe === '1' }] })
    else if (action?.contactAction) emitSyncActionResults(ev, processContactAction(action.contactAction, id, logger))
    else if (action?.pushNameSetting) { const name = action?.pushNameSetting?.name; if (name && me?.name !== name) ev.emit('creds.update', { me: { ...me, name } }) }
    else if (action?.pinAction) ev.emit('chats.update', [{ id, pinned: action.pinAction?.pinned ? toNumber(action.timestamp) : null, conditional: getChatUpdateConditional(id, undefined) }])
    else if (action?.unarchiveChatsSetting) { const unarchiveChats = !!action.unarchiveChatsSetting.unarchiveChats; ev.emit('creds.update', { accountSettings: { unarchiveChats } }); if (accountSettings) accountSettings.unarchiveChats = unarchiveChats }
    else if (action?.starAction || type === 'star') { let starred = action?.starAction?.starred; if (typeof starred !== 'boolean') starred = syncAction.index[syncAction.index.length - 1] === '1'; ev.emit('messages.update', [{ key: { remoteJid: id, id: msgId, fromMe: fromMe === '1' }, update: { starred } }]) }
    else if (action?.deleteChatAction || type === 'deleteChat') { if (!isInitialSync) ev.emit('chats.delete', [id]) }
    else if (action?.labelEditAction) { const { name, color, deleted, predefinedId } = action.labelEditAction; ev.emit('labels.edit', { id, name, color, deleted, predefinedId: predefinedId ? String(predefinedId) : undefined }) }
    else if (action?.labelAssociationAction) ev.emit('labels.association', { type: action.labelAssociationAction.labeled ? 'add' : 'remove', association: type === LabelAssociationType.Chat ? { type: LabelAssociationType.Chat, chatId: syncAction.index[2], labelId: syncAction.index[1] } : { type: LabelAssociationType.Message, chatId: syncAction.index[2], messageId: syncAction.index[3], labelId: syncAction.index[1] } })
    else if (action?.localeSetting?.locale) ev.emit('settings.update', { setting: 'locale', value: action.localeSetting.locale })
    else if (action?.timeFormatAction) ev.emit('settings.update', { setting: 'timeFormat', value: action.timeFormatAction })
    else if (action?.pnForLidChatAction?.pnJid) ev.emit('lid-mapping.update', { lid: id, pn: action.pnForLidChatAction.pnJid })
    else if (action?.privacySettingRelayAllCalls) ev.emit('settings.update', { setting: 'privacySettingRelayAllCalls', value: action.privacySettingRelayAllCalls })
    else if (action?.statusPrivacy) ev.emit('settings.update', { setting: 'statusPrivacy', value: action.statusPrivacy })
    else if (action?.lockChatAction) ev.emit('chats.lock', { id, locked: !!action.lockChatAction.locked })
    else if (action?.privacySettingDisableLinkPreviewsAction) ev.emit('settings.update', { setting: 'disableLinkPreviews', value: action.privacySettingDisableLinkPreviewsAction })
    else if (action?.notificationActivitySettingAction?.notificationActivitySetting) ev.emit('settings.update', { setting: 'notificationActivitySetting', value: action.notificationActivitySettingAction.notificationActivitySetting })
    else if (action?.lidContactAction) ev.emit('contacts.upsert', [{ id, name: action.lidContactAction.fullName || action.lidContactAction.firstName || action.lidContactAction.username || undefined, username: action.lidContactAction.username || undefined, lid: id, phoneNumber: undefined }])
    else if (action?.privacySettingChannelsPersonalisedRecommendationAction) ev.emit('settings.update', { setting: 'channelsPersonalisedRecommendation', value: action.privacySettingChannelsPersonalisedRecommendationAction })
    else if (action?.aiThreadRenameAction) ev.emit('chats.update', [{ id, name: action.aiThreadRenameAction.newTitle || undefined, conditional: getChatUpdateConditional(id, undefined) }])
    else if (action?.threadPinAction) ev.emit('chats.update', [{ id, pinned: action.threadPinAction.pinned ? toNumber(action.timestamp) : null, conditional: getChatUpdateConditional(id, undefined) }])
    else if (action?.newsletterSavedInterestsAction) ev.emit('settings.update', { setting: 'newsletterSavedInterests', value: action.newsletterSavedInterestsAction.newsletterSavedInterests })
    else if (action?.interactiveMessageAction) ev.emit('messages.update', [{ key: { remoteJid: id, id: msgId, fromMe: fromMe === '1' }, update: { interactiveMessageAction: action.interactiveMessageAction } }])
    else if (action?.deviceCapabilities || action?.deviceCapabilitiesV2) ev.emit('creds.update', { deviceCapabilities: action.deviceCapabilities || action.deviceCapabilitiesV2 })
    else if (action?.nctSaltSyncAction) ev.emit('creds.update', { nctSalt: action.nctSaltSyncAction.salt })
    else if (action?.bubbleLockMessageAction) ev.emit('messages.update', [{ key: { remoteJid: id, id: msgId, fromMe: fromMe === '1' }, update: { bubbleLocked: !!action.bubbleLockMessageAction.locked } }])
    else logger?.debug({ syncAction, id }, 'unprocessable update')
}