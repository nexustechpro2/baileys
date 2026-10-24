import { Boom } from '@hapi/boom'
import { createHash } from 'crypto'
import { proto } from '../../WAProto/index.js'
import { KEY_BUNDLE_TYPE, WA_ADV_ACCOUNT_SIG_PREFIX, WA_ADV_DEVICE_SIG_PREFIX, WA_ADV_HOSTED_ACCOUNT_SIG_PREFIX } from '../Defaults/index.js'
import { getBinaryNodeChild, jidDecode, S_WHATSAPP_NET } from '../WABinary/index.js'
import { Curve, hmacSign } from './crypto.js'
import { encodeBigEndian } from './generics.js'
import { createSignalIdentity } from './signal.js'
import { getPlatformType } from './browser-utils.js'

const PLATFORM_MAP = {
    'Mac OS': proto.ClientPayload.WebInfo.WebSubPlatform.DARWIN,
    'Windows': proto.ClientPayload.WebInfo.WebSubPlatform.WIN_HYBRID,
    'WindowsStore': proto.ClientPayload.WebInfo.WebSubPlatform.WIN_STORE,
}

const getUserAgent = (config) => ({
    appVersion: {
        primary: config.version[0],
        secondary: config.version[1],
        tertiary: config.version[2],
    },
    platform: proto.ClientPayload.UserAgent.Platform.WEB,
    releaseChannel: proto.ClientPayload.UserAgent.ReleaseChannel.RELEASE,
    osVersion: '0.1',
    device: 'Desktop',
    deviceType: proto.ClientPayload.UserAgent.DeviceType.DESKTOP,
    osBuildNumber: '0.1',
    localeLanguageIso6391: 'en',
    mnc: '000',
    mcc: '000',
    localeCountryIso31661Alpha2: config.countryCode,
})

const getWebInfo = (config) => {
    let webSubPlatform = proto.ClientPayload.WebInfo.WebSubPlatform.WEB_BROWSER
    if (config.syncFullHistory && PLATFORM_MAP[config.browser[0]] && config.browser[1] === 'Desktop')
        webSubPlatform = PLATFORM_MAP[config.browser[0]]
    return { webSubPlatform }
}

const getClientPayload = (config) => {
    const payload = {
        connectType: proto.ClientPayload.ConnectType.WIFI_UNKNOWN,
        connectReason: proto.ClientPayload.ConnectReason.USER_ACTIVATED,
        userAgent: getUserAgent(config),
    }
    if (!config.browser[1].toLowerCase().includes('android')) payload.webInfo = getWebInfo(config)
    return payload
}

const buildHistorySyncConfig = () => {
    const fields = proto.DeviceProps.HistorySyncConfig.fields
    const config = {}
    for (const [name, field] of Object.entries(fields)) {
        if (field.type === 'bool') config[name] = true
    }
    config.storageQuotaMb = 569150
    config.supportCallLogHistory = false
    config.supportGroupHistory = false
    return config
}

export const generateLoginNode = (userJid, config) => {
    const { user, device } = jidDecode(userJid)
    return proto.ClientPayload.fromObject({
        ...getClientPayload(config),
        passive: true,
        pull: true,
        username: +user,
        device,
        lidDbMigrated: false, // hard-set; behaviour under true is unknown
    })
}

export const generateRegistrationNode = ({ registrationId, signedPreKey, signedIdentityKey }, config) => {
    const appVersionBuf = createHash('md5').update(config.version.join('.')).digest()
    const companionProto = proto.DeviceProps.encode({
        os: config.browser[0],
        platformType: getPlatformType(config.browser[1]),
        requireFullSync: config.syncFullHistory,
        historySyncConfig: buildHistorySyncConfig(),
        version: { primary: config.version[0], secondary: config.version[1], tertiary: config.version[2] },
    }).finish()

    return proto.ClientPayload.fromObject({
        ...getClientPayload(config),
        passive: false,
        pull: false,
        devicePairingData: {
            eRegid: encodeBigEndian(registrationId),
            eKeytype: KEY_BUNDLE_TYPE,
            eIdent: signedIdentityKey.public,
            eSkeyId: encodeBigEndian(signedPreKey.keyId, 3),
            eSkeyVal: signedPreKey.keyPair.public,
            eSkeySig: signedPreKey.signature,
            buildHash: appVersionBuf,
            deviceProps: companionProto,
        },
    })
}

export const configureSuccessfulPairing = (stanza, { advSecretKey, signedIdentityKey, signalIdentities }) => {
    const msgId = stanza.attrs.id
    const pairSuccessNode = getBinaryNodeChild(stanza, 'pair-success')
    const deviceIdentityNode = getBinaryNodeChild(pairSuccessNode, 'device-identity')
    const platformNode = getBinaryNodeChild(pairSuccessNode, 'platform')
    const deviceNode = getBinaryNodeChild(pairSuccessNode, 'device')
    const businessNode = getBinaryNodeChild(pairSuccessNode, 'biz')

    if (!deviceIdentityNode || !deviceNode)
        throw new Boom('Missing device-identity or device in pair success node', { data: stanza })

    const jid = deviceNode.attrs.jid
    const lid = deviceNode.attrs.lid
    const bizName = businessNode?.attrs.name

    const { details, hmac, accountType } = proto.ADVSignedDeviceIdentityHMAC.decode(deviceIdentityNode.content)
    const hmacPrefix = (accountType !== undefined && accountType === proto.ADVEncryptionType.HOSTED)
        ? WA_ADV_HOSTED_ACCOUNT_SIG_PREFIX
        : Buffer.from([])

    if (Buffer.compare(hmac, hmacSign(Buffer.concat([hmacPrefix, details]), Buffer.from(advSecretKey, 'base64'))) !== 0)
        throw new Boom('Invalid account signature')

    const account = proto.ADVSignedDeviceIdentity.decode(details)
    const { accountSignatureKey, accountSignature, details: deviceDetails } = account
    const deviceIdentity = proto.ADVDeviceIdentity.decode(deviceDetails)

    const accountSignaturePrefix = deviceIdentity.deviceType === proto.ADVEncryptionType.HOSTED
        ? WA_ADV_HOSTED_ACCOUNT_SIG_PREFIX
        : WA_ADV_ACCOUNT_SIG_PREFIX

    if (!Curve.verify(accountSignatureKey, Buffer.concat([accountSignaturePrefix, deviceDetails, signedIdentityKey.public]), accountSignature))
        throw new Boom('Failed to verify account signature')

    account.deviceSignature = Curve.sign(
        signedIdentityKey.private,
        Buffer.concat([WA_ADV_DEVICE_SIG_PREFIX, deviceDetails, signedIdentityKey.public, accountSignatureKey])
    )

    const identity = createSignalIdentity(lid, accountSignatureKey)
    const accountEnc = encodeSignedDeviceIdentity(account, false)

    return {
        creds: {
            account,
            me: { id: jid, name: bizName, lid },
            signalIdentities: [...(signalIdentities ?? []), identity],
            platform: platformNode?.attrs.name,
        },
        reply: {
            tag: 'iq',
            attrs: { to: S_WHATSAPP_NET, type: 'result', id: msgId },
            content: [{
                tag: 'pair-device-sign',
                attrs: {},
                content: [{
                    tag: 'device-identity',
                    attrs: { 'key-index': deviceIdentity.keyIndex.toString() },
                    content: accountEnc,
                }],
            }],
        },
    }
}

export const encodeSignedDeviceIdentity = (account, includeSignatureKey) => {
    account = { ...account }
    if (!includeSignatureKey || !account.accountSignatureKey?.length) account.accountSignatureKey = null
    return proto.ADVSignedDeviceIdentity.encode(account).finish()
}