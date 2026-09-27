import { KEY_BUNDLE_TYPE } from '../Defaults/index.js'
import { assertNodeErrorFree, getBinaryNodeChild, getBinaryNodeChildBuffer, getBinaryNodeChildren, getBinaryNodeChildUInt, getServerFromDomainType, jidDecode, S_WHATSAPP_NET, WAJIDDomains } from '../WABinary/index.js'
import { Curve, generateSignalPubKey } from './crypto.js'
import { encodeBigEndian } from './generics.js'

const chunk = (array, size) => {
    const chunks = []
    for (let i = 0; i < array.length; i += size) chunks.push(array.slice(i, i + size))
    return chunks
}

export const createSignalIdentity = (wid, accountSignatureKey) => ({
    identifier: { name: wid, deviceId: 0 },
    identifierKey: generateSignalPubKey(accountSignatureKey),
})

export const getPreKeys = async ({ get }, min, limit) => {
    const idList = []
    for (let id = min; id < limit; id++) idList.push(id.toString())
    return get('pre-key', idList)
}

export const generateOrGetPreKeys = (creds, range) => {
    const available = creds.nextPreKeyId - creds.firstUnuploadedPreKeyId
    const remaining = range - available
    const lastPreKeyId = creds.nextPreKeyId + remaining - 1
    const newPreKeys = {}
    if (remaining > 0) {
        for (let i = creds.nextPreKeyId; i <= lastPreKeyId; i++) newPreKeys[i] = Curve.generateKeyPair()
    }
    return { newPreKeys, lastPreKeyId, preKeysRange: [creds.firstUnuploadedPreKeyId, range] }
}

export const xmppSignedPreKey = key => ({
    tag: 'skey',
    attrs: {},
    content: [
        { tag: 'id', attrs: {}, content: encodeBigEndian(key.keyId, 3) },
        { tag: 'value', attrs: {}, content: key.keyPair.public },
        { tag: 'signature', attrs: {}, content: key.signature },
    ],
})

export const xmppPreKey = (pair, id) => ({
    tag: 'key',
    attrs: {},
    content: [
        { tag: 'id', attrs: {}, content: encodeBigEndian(id, 3) },
        { tag: 'value', attrs: {}, content: pair.public },
    ],
})

const isValidUInt = n => typeof n === 'number' && Number.isInteger(n) && n >= 0

export const extractE2ESessionFromRetryReceipt = receipt => {
    const keysNode = getBinaryNodeChild(receipt, 'keys')
    if (!keysNode) return null

    const typeBuf = getBinaryNodeChildBuffer(keysNode, 'type')
    if (!typeBuf || typeBuf.length !== 1 || typeBuf[0] !== KEY_BUNDLE_TYPE[0]) return null

    const identity = getBinaryNodeChildBuffer(keysNode, 'identity')
    const skey = getBinaryNodeChild(keysNode, 'skey')
    if (!identity || identity.length !== 32 || !skey) return null

    const registrationId = getBinaryNodeChildUInt(receipt, 'registration', 4)
    if (!isValidUInt(registrationId)) return null

    const signedPubKey = getBinaryNodeChildBuffer(skey, 'value')
    const signedSig = getBinaryNodeChildBuffer(skey, 'signature')
    const signedKeyId = getBinaryNodeChildUInt(skey, 'id', 3)
    if (!signedPubKey || signedPubKey.length !== 32 || !signedSig || !isValidUInt(signedKeyId)) return null

    const preKeyNode = getBinaryNodeChild(keysNode, 'key')
    let preKey
    if (preKeyNode) {
        const preKeyPub = getBinaryNodeChildBuffer(preKeyNode, 'value')
        const preKeyId = getBinaryNodeChildUInt(preKeyNode, 'id', 3)
        if (!preKeyPub || preKeyPub.length !== 32 || !isValidUInt(preKeyId)) return null
        preKey = { keyId: preKeyId, publicKey: generateSignalPubKey(preKeyPub) }
    }

    return {
        registrationId,
        identityKey: generateSignalPubKey(identity),
        signedPreKey: { keyId: signedKeyId, publicKey: generateSignalPubKey(signedPubKey), signature: signedSig },
        preKey,
    }
}

export const parseAndInjectE2ESessions = async (node, repository) => {
    const extractKey = key => key ? {
        keyId: getBinaryNodeChildUInt(key, 'id', 3),
        publicKey: generateSignalPubKey(getBinaryNodeChildBuffer(key, 'value')),
        signature: getBinaryNodeChildBuffer(key, 'signature'),
    } : undefined

    const nodes = getBinaryNodeChildren(getBinaryNodeChild(node, 'list'), 'user').filter(node => {
        try { assertNodeErrorFree(node); return true } catch { return false }
    })

    for (const nodesChunk of chunk(nodes, 100)) {
        await Promise.all(nodesChunk.map(node => repository.injectE2ESession({
            jid: node.attrs.jid,
            session: {
                registrationId: getBinaryNodeChildUInt(node, 'registration', 4),
                identityKey: generateSignalPubKey(getBinaryNodeChildBuffer(node, 'identity')),
                signedPreKey: extractKey(getBinaryNodeChild(node, 'skey')),
                preKey: extractKey(getBinaryNodeChild(node, 'key')),
            },
        })))
        await new Promise(resolve => setImmediate(resolve)) // yield between chunks to avoid blocking on large batches
    }
}

export const extractDeviceJids = (result, myJid, myLid, excludeZeroDevices) => {
    const { user: myUser, device: myDevice } = jidDecode(myJid)
    const extracted = []
    for (const { devices, id } of result) {
        const decoded = jidDecode(id)
        const { user, server } = decoded
        let { domainType } = decoded
        const deviceList = devices?.deviceList
        if (!Array.isArray(deviceList)) continue
        for (const { id: device, keyIndex, isHosted } of deviceList) {
            if ((!excludeZeroDevices || device !== 0) &&
                ((myUser !== user && myLid !== user) || myDevice !== device) &&
                (device === 0 || !!keyIndex)) {
                if (isHosted) domainType = domainType === WAJIDDomains.LID ? WAJIDDomains.HOSTED_LID : WAJIDDomains.HOSTED
                extracted.push({ user, device, domainType, server: getServerFromDomainType(server, domainType) })
            }
        }
    }
    return extracted
}

export const getNextPreKeys = async ({ creds, keys }, count) => {
    const { newPreKeys, lastPreKeyId, preKeysRange } = generateOrGetPreKeys(creds, count)
    await keys.set({ 'pre-key': newPreKeys })
    const preKeys = await getPreKeys(keys, preKeysRange[0], preKeysRange[0] + preKeysRange[1])
    return {
        update: {
            nextPreKeyId: Math.max(lastPreKeyId + 1, creds.nextPreKeyId),
            firstUnuploadedPreKeyId: Math.max(creds.firstUnuploadedPreKeyId, lastPreKeyId + 1),
        },
        preKeys,
    }
}

export const getNextPreKeysNode = async (state, count) => {
    const { creds } = state
    const { update, preKeys } = await getNextPreKeys(state, count)
    return {
        update,
        node: {
            tag: 'iq',
            attrs: { xmlns: 'encrypt', type: 'set', to: S_WHATSAPP_NET },
            content: [
                { tag: 'registration', attrs: {}, content: encodeBigEndian(creds.registrationId) },
                { tag: 'type', attrs: {}, content: KEY_BUNDLE_TYPE },
                { tag: 'identity', attrs: {}, content: creds.signedIdentityKey.public },
                { tag: 'list', attrs: {}, content: Object.keys(preKeys).map(k => xmppPreKey(preKeys[+k], +k)) },
                xmppSignedPreKey(creds.signedPreKey),
            ],
        },
    }
}