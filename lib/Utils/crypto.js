import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes } from 'crypto'
import { calculateAgreement, calculateSignature, verifySignature as rustVerifySignature, generateKeyPair as rustGenerateKeyPair, hkdf, md5 } from 'whatsapp-rust-bridge'
import { KEY_BUNDLE_TYPE } from '../Defaults/index.js'

export { hkdf, md5 }

const GCM_TAG_LENGTH = 16 // 128 >> 3

export const generateSignalPubKey = pubKey => pubKey.length === 33 ? pubKey : Buffer.concat([KEY_BUNDLE_TYPE, pubKey])

export const Curve = {
    generateKeyPair: () => { const { pubKey, privKey } = rustGenerateKeyPair(); return { private: Buffer.from(privKey), public: Buffer.from(pubKey.slice(1)) } },
    sharedKey: (privateKey, publicKey) => Buffer.from(calculateAgreement(generateSignalPubKey(publicKey), privateKey)),
    sign: (privateKey, buf) => calculateSignature(privateKey, buf),
    verify: (pubKey, message, signature) => { try { return rustVerifySignature(generateSignalPubKey(pubKey), message, signature) } catch { return false } }
}

export const signedKeyPair = (identityKeyPair, keyId) => {
    const preKey = Curve.generateKeyPair()
    const pubKey = generateSignalPubKey(preKey.public)
    return { keyPair: preKey, signature: Curve.sign(identityKeyPair.private, pubKey), keyId }
}

export const aesEncryptGCM = (plaintext, key, iv, additionalData) => {
    const cipher = createCipheriv('aes-256-gcm', key, iv)
    cipher.setAAD(additionalData)
    return Buffer.concat([cipher.update(plaintext), cipher.final(), cipher.getAuthTag()])
}

export const aesDecryptGCM = (ciphertext, key, iv, additionalData) => {
    const decipher = createDecipheriv('aes-256-gcm', key, iv)
    decipher.setAAD(additionalData)
    decipher.setAuthTag(ciphertext.subarray(-GCM_TAG_LENGTH))
    return Buffer.concat([decipher.update(ciphertext.subarray(0, -GCM_TAG_LENGTH)), decipher.final()])
}

export const aesEncryptCTR = (plaintext, key, iv) => { const c = createCipheriv('aes-256-ctr', key, iv); return Buffer.concat([c.update(plaintext), c.final()]) }
export const aesDecryptCTR = (ciphertext, key, iv) => { const d = createDecipheriv('aes-256-ctr', key, iv); return Buffer.concat([d.update(ciphertext), d.final()]) }

export const aesDecryptWithIV = (buffer, key, IV) => { const d = createDecipheriv('aes-256-cbc', key, IV); return Buffer.concat([d.update(buffer), d.final()]) }
export const aesDecrypt = (buffer, key) => aesDecryptWithIV(buffer.subarray(16), key, buffer.subarray(0, 16))

export const aesEncryptWithIV = (buffer, key, IV) => { const c = createCipheriv('aes-256-cbc', key, IV); return Buffer.concat([c.update(buffer), c.final()]) }
export const aesEncrypt = (buffer, key) => { const IV = randomBytes(16); return Buffer.concat([IV, ...(() => { const c = createCipheriv('aes-256-cbc', key, IV); return [c.update(buffer), c.final()] })()]) }

export const hmacSign = (buffer, key, variant = 'sha256') => createHmac(variant, key).update(buffer).digest()
export const sha256 = buffer => createHash('sha256').update(buffer).digest()

export const derivePairingCodeKey = async (pairingCode, salt) => {
    const keyMaterial = await crypto.subtle.importKey('raw', new TextEncoder().encode(pairingCode), { name: 'PBKDF2' }, false, ['deriveBits'])
    return Buffer.from(await crypto.subtle.deriveBits({ name: 'PBKDF2', salt: salt instanceof Uint8Array ? salt : new Uint8Array(salt), iterations: 2 << 16, hash: 'SHA-256' }, keyMaterial, 256))
}