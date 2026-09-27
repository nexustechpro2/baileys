/* eslint-disable camelcase */
import axios from 'axios'
import { MOBILE_TOKEN, MOBILE_REGISTRATION_ENDPOINT, MOBILE_USERAGENT, REGISTRATION_PUBLIC_KEY, GRAPHQL_ENDPOINT, GRAPHQL_ACCESS_TOKEN, GRAPHQL_BAN_STATUS_DOC_ID } from '../Defaults/index.js'
import { md5, Curve, aesEncryptGCM } from '../Utils/index.js'
import { jidEncode } from '../WABinary/index.js'
import { makeCommunitiesSocket } from './communities.js'

function urlencode(str) {
    return str.replace(/-/g, '%2d').replace(/_/g, '%5f').replace(/~/g, '%7e')
}

function convertBufferToUrlHex(buffer) {
    let id = ''
    buffer.forEach((x) => { id += `%${x.toString(16).padStart(2, '0').toLowerCase()}` })
    return id
}

const validRegistrationOptions = (config) =>
    config?.phoneNumberCountryCode &&
    config.phoneNumberNationalNumber &&
    config.phoneNumberMobileCountryCode

export const makeRegistrationSocket = (config) => {
    const sock = makeCommunitiesSocket(config)

    const register = async (code) => {
        if (!validRegistrationOptions(config.auth.creds.registration)) {
            throw new Error('please specify the registration options')
        }
        const result = await mobileRegister(
            { ...sock.authState.creds, ...sock.authState.creds.registration, code },
            config.options
        )
        sock.authState.creds.me = { id: jidEncode(result.login, 's.whatsapp.net'), name: '~' }
        sock.authState.creds.registered = true
        sock.ev.emit('creds.update', sock.authState.creds)
        return result
    }

    const requestRegistrationCode = async (registrationOptions) => {
        registrationOptions = registrationOptions || config.auth.creds.registration
        if (!validRegistrationOptions(registrationOptions)) {
            throw new Error('Invalid registration options')
        }
        sock.authState.creds.registration = registrationOptions
        sock.ev.emit('creds.update', sock.authState.creds)
        return mobileRegisterCode({ ...config.auth.creds, ...registrationOptions }, config.options)
    }

    return { ...sock, register, requestRegistrationCode }
}

export async function getBanDetails(appealToken) {
    const res = await axios.post(GRAPHQL_ENDPOINT, {
        variables: JSON.stringify({ app_id: 'dev.app.id', request_token: appealToken }),
        access_token: GRAPHQL_ACCESS_TOKEN,
        doc_id: GRAPHQL_BAN_STATUS_DOC_ID,
        lang: 'en_GB',
        'Content-Type': 'application/json'
    }, {
        headers: { 'User-Agent': MOBILE_USERAGENT, 'Content-Type': 'application/json' }
    })
    return res.data?.data?.whatsapp_support_ban_appeal_status || null
}

function registrationParams(params) {
    const e_regid = Buffer.alloc(4)
    e_regid.writeInt32BE(params.registrationId)
    const e_skey_id = Buffer.alloc(3)
    e_skey_id.writeInt16BE(params.signedPreKey.keyId)
    params.phoneNumberCountryCode = params.phoneNumberCountryCode.replace('+', '').trim()
    params.phoneNumberNationalNumber = params.phoneNumberNationalNumber.replace(/[/\-\s)(]/g, '').trim()
    return {
        cc: params.phoneNumberCountryCode,
        in: params.phoneNumberNationalNumber,
        Rc: '0',
        lg: 'en',
        lc: 'GB',
        mistyped: '6',
        authkey: Buffer.from(params.noiseKey.public).toString('base64url'),
        e_regid: e_regid.toString('base64url'),
        e_keytype: 'BQ',
        e_ident: Buffer.from(params.signedIdentityKey.public).toString('base64url'),
        e_skey_id: e_skey_id.toString('base64url'),
        e_skey_val: Buffer.from(params.signedPreKey.keyPair.public).toString('base64url'),
        e_skey_sig: Buffer.from(params.signedPreKey.signature).toString('base64url'),
        fdid: params.phoneId,
        network_ratio_type: '1',
        expid: params.deviceId,
        simnum: '1',
        hasinrc: '1',
        pid: Math.floor(Math.random() * 1000).toString(),
        id: convertBufferToUrlHex(params.identityId),
        backup_token: convertBufferToUrlHex(params.backupToken),
        token: Buffer.from(md5(Buffer.concat([MOBILE_TOKEN, Buffer.from(params.phoneNumberNationalNumber)]))).toString('hex'),
        fraud_checkpoint_code: params.captcha,
    }
}

export function mobileRegisterCode(params, fetchOptions) {
    return mobileRegisterFetch('/code', {
        params: {
            ...registrationParams(params),
            mcc: `${params.phoneNumberMobileCountryCode}`.padStart(3, '0'),
            mnc: `${params.phoneNumberMobileNetworkCode || '001'}`.padStart(3, '0'),
            sim_mcc: '000',
            sim_mnc: '000',
            method: params?.method || 'sms',
            reason: '',
            hasav: '1',
        },
        ...fetchOptions,
    })
}

export function mobileRegisterExists(params, fetchOptions) {
    return mobileRegisterFetch('/exist', { params: registrationParams(params), ...fetchOptions })
}

export async function mobileRegister(params, fetchOptions) {
    return mobileRegisterFetch('/register', {
        params: { ...registrationParams(params), code: params.code.replace('-', '') },
        ...fetchOptions,
    })
}

export function mobileRegisterEncrypt(data) {
    const keypair = Curve.generateKeyPair()
    const key = Curve.sharedKey(keypair.private, REGISTRATION_PUBLIC_KEY)
    const buffer = aesEncryptGCM(Buffer.from(data), new Uint8Array(key), Buffer.alloc(12), Buffer.alloc(0))
    return Buffer.concat([Buffer.from(keypair.public), buffer]).toString('base64url')
}

export async function mobileRegisterFetch(path, opts = {}) {
    let url = `${MOBILE_REGISTRATION_ENDPOINT}${path}`
    if (opts.params) {
        const parameter = []
        for (const param in opts.params) {
            if (opts.params[param] !== null && opts.params[param] !== undefined) {
                parameter.push(param + '=' + urlencode(opts.params[param]))
            }
        }
        url += `?${parameter.join('&')}`
        delete opts.params
    }
    if (!opts.headers) opts.headers = {}
    opts.headers['User-Agent'] = MOBILE_USERAGENT
    const response = await axios(url, opts)
    const json = response.data
    if (response.status > 300 || json.reason) throw json
    if (json.status && !['ok', 'sent'].includes(json.status)) throw json
    return json
}

export { registrationParams }