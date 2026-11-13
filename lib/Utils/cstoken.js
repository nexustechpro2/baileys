import { isJidBot, isJidMetaAI, isLidUser, isPnUser, jidNormalizedUser, PSA_WID } from '../WABinary/index.js'
import { hmacSign } from './crypto.js'

export const shouldSendCsToken = (jid) => {
    const n = jidNormalizedUser(jid)
    return !!n && (isPnUser(n) || isLidUser(n)) && n !== jidNormalizedUser(PSA_WID) && !isJidBot(jid) && !isJidMetaAI(jid)
}

export const generateCsToken = async ({ jid, nctSalt, getLIDForPN }) => {
    if (!nctSalt?.length || !shouldSendCsToken(jid)) return undefined
    const n = jidNormalizedUser(jid)
    const lid = isLidUser(n) ? n : jidNormalizedUser(await getLIDForPN(n))
    if (!lid || !isLidUser(lid)) return undefined
    return hmacSign(Buffer.from(lid), nctSalt, 'sha256')
}