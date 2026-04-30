import {
  SessionCipher,
  SessionBuilder,
  SessionRecord,
  ProtocolAddress,
  GroupCipher,
  GroupSessionBuilder,
  SenderKeyName,
  SenderKeyRecord,
  SenderKeyDistributionMessage,
} from 'whatsapp-rust-bridge'
import { LRUCache } from 'lru-cache'
import { generateSignalPubKey } from '../Utils/index.js'
import {
  isHostedLidUser, isHostedPnUser, isLidUser, isPnUser,
  jidDecode, transferDevice, WAJIDDomains
} from '../WABinary/index.js'
import { LIDMappingStore } from './lid-mapping.js'

// ─── ADDRESS HELPERS ──────────────────────────────────────────────────────────
const jidToAddr = (jid) => {
  const { user, device, server, domainType } = jidDecode(jid)
  if (!user) throw new Error(`Invalid JID: "${jid}"`)
  if (device === 99 && server !== 'hosted' && server !== 'hosted.lid')
    throw new Error('Invalid device 99: ' + jid)
  const signalUser = domainType !== WAJIDDomains.WHATSAPP ? `${user}_${domainType}` : user
  return new ProtocolAddress(signalUser, device || 0)
}

const jidToSenderKeyName = (group, user) => new SenderKeyName(group, jidToAddr(user))

// ─── IDENTITY EXTRACTION ──────────────────────────────────────────────────────
function extractIdentityFromPkmsg(ciphertext) {
  try {
    if (!ciphertext || ciphertext.length < 2) return undefined
    if ((ciphertext[0] & 0xf) !== 3) return undefined
    // proto: skip version byte, identityKey field is tag 4, 33 bytes
    const buf = ciphertext.slice(1)
    let i = 0
    while (i < buf.length) {
      const tag = buf[i++]
      const fieldNum = tag >> 3
      const wireType = tag & 0x7
      if (wireType === 2) {
        let len = 0, shift = 0
        while (i < buf.length) { const b = buf[i++]; len |= (b & 0x7f) << shift; if (!(b & 0x80)) break; shift += 7 }
        if (fieldNum === 4 && len === 33) return new Uint8Array(buf.slice(i, i + len))
        i += len
      } else if (wireType === 0) {
        while (i < buf.length && buf[i++] & 0x80) { }
      } else if (wireType === 5) { i += 4 }
      else if (wireType === 1) { i += 8 }
      else break
    }
  } catch { }
  return undefined
}

// ─── MAIN FACTORY ─────────────────────────────────────────────────────────────
export function makeLibSignalRepository(auth, logger, pnToLIDFunc) {
  const lidMapping = new LIDMappingStore(auth.keys, logger, pnToLIDFunc)
  const storage = signalStorage(auth, lidMapping, logger)
  const parsedKeys = auth.keys
  const migratedCache = new LRUCache({ ttl: 7 * 24 * 60 * 60 * 1000, ttlAutopurge: true, updateAgeOnGet: true })

  const txn = (fn, key) => parsedKeys.transaction(fn, key)

  return {
    decryptGroupMessage({ group, authorJid, msg }) {
      const cipher = new GroupCipher(storage, group, jidToAddr(authorJid))
      return txn(() => cipher.decrypt(msg), group)
    },

    async processSenderKeyDistributionMessage({ item, authorJid }) {
      if (!item.groupId) throw new Error('Group ID required')
      const builder = new GroupSessionBuilder(storage)
      const senderName = jidToSenderKeyName(item.groupId, authorJid)
      const senderMsg = SenderKeyDistributionMessage.deserialize(item.axolotlSenderKeyDistributionMessage)
      return txn(() => builder.process(senderName, senderMsg), item.groupId)
    },

    async decryptMessage({ jid, type, ciphertext }) {
      const addr = jidToAddr(jid)
      const cipher = new SessionCipher(storage, addr)
      if (type === 'pkmsg') {
        const identityKey = extractIdentityFromPkmsg(ciphertext)
        if (identityKey) {
          const changed = await storage.saveIdentity(addr.toString(), identityKey)
          if (changed) logger?.info?.({ jid }, '[Signal] Identity key changed, session cleared')
        }
      }
      const doDecrypt = (c, t) => {
        if (t === 'pkmsg') return c.decryptPreKeyWhisperMessage(ciphertext)
        if (t === 'msg') return c.decryptWhisperMessage(ciphertext)
        throw new Error(`Unknown type: ${t}`)
      }
      return txn(() => doDecrypt(cipher, type), jid)
    },

    encryptMessage({ jid, data }) {
      return txn(async () => {
        const cipher = new SessionCipher(storage, jidToAddr(jid))
        const { type: sigType, body } = await cipher.encrypt(data)
        return { type: sigType === 3 ? 'pkmsg' : 'msg', ciphertext: Buffer.from(body) }
      }, jid)
    },

    encryptGroupMessage({ group, meId, data }) {
      const senderName = jidToSenderKeyName(group, meId)
      const builder = new GroupSessionBuilder(storage)
      return txn(async () => {
        const senderKeyDistributionMessage = await builder.create(senderName)
        const cipher = new GroupCipher(storage, group, jidToAddr(meId))
        return { ciphertext: await cipher.encrypt(data), senderKeyDistributionMessage: senderKeyDistributionMessage.serialize() }
      }, group)
    },

    injectE2ESession({ jid, session }) {
      return txn(() => new SessionBuilder(storage, jidToAddr(jid)).processPreKeyBundle(session), jid)
    },

    jidToSignalProtocolAddress: jid => jidToAddr(jid).toString(),

    lidMapping,

    async validateSession(jid) {
      try {
        const raw = await storage.loadSession(jidToAddr(jid).toString())
        if (!raw) return { exists: false, reason: 'no session' }
        const sess = SessionRecord.deserialize(raw)
        if (!sess.haveOpenSession()) return { exists: false, reason: 'no open session' }
        return { exists: true }
      } catch {
        return { exists: false, reason: 'error' }
      }
    },

    async deleteSession(jids) {
      if (!jids.length) return
      return txn(async () => {
        const data = await parsedKeys.get('session', ['_index'])
        const sessionBatch = data?.['_index'] || {}
        for (const jid of jids) delete sessionBatch[jidToAddr(jid).toString()]
        await parsedKeys.set({ session: { '_index': sessionBatch } })
      }, `del-${jids.length}`)
    },

    async migrateSession(fromJid, toJid) {
      if (!fromJid || (!isLidUser(toJid) && !isHostedLidUser(toJid))) return { migrated: 0, skipped: 0, total: 0 }
      if (!isPnUser(fromJid) && !isHostedPnUser(fromJid)) return { migrated: 0, skipped: 0, total: 1 }
      const { user } = jidDecode(fromJid)
      const batchData = await parsedKeys.get('device-list', ['_index'])
      const deviceListBatch = batchData?.['_index'] || {}
      const userDevices = deviceListBatch[user]
      if (!userDevices?.length) return { migrated: 0, skipped: 0, total: 0 }
      const { device: fromDevice } = jidDecode(fromJid)
      const fromDeviceStr = fromDevice?.toString() || '0'
      if (!userDevices.includes(fromDeviceStr)) userDevices.push(fromDeviceStr)
      const uncachedDevices = userDevices.filter(d => !migratedCache.has(`${user}.${d}`))
      const sessionBatchData = await parsedKeys.get('session', ['_index'])
      const sessionBatch = sessionBatchData?.['_index'] || {}
      const deviceJids = uncachedDevices.map(d => {
        const num = parseInt(d)
        return {
          addr: num === 0 ? `${user}.0` : `${user}.${d}`,
          jid: num === 99 ? `${user}:99@hosted` : num === 0 ? `${user}@s.whatsapp.net` : `${user}:${num}@s.whatsapp.net`
        }
      }).filter(({ addr }) => sessionBatch[addr])
      return txn(async () => {
        const updated = { ...sessionBatch }
        let migrated = 0
        for (const { jid } of deviceJids) {
          const pnAddr = jidToAddr(jid).toString()
          const lidAddr = jidToAddr(transferDevice(jid, toJid)).toString()
          const raw = updated[pnAddr]
          if (raw) {
            const sess = SessionRecord.deserialize(raw instanceof Uint8Array ? raw : Buffer.from(raw))
            if (sess.haveOpenSession()) {
              updated[lidAddr] = sess.serialize()
              delete updated[pnAddr]
              migrated++
              migratedCache.set(`${user}.${jidDecode(jid).device || 0}`, true)
            }
          }
        }
        if (migrated > 0) await parsedKeys.set({ session: { '_index': updated } })
        return { migrated, skipped: deviceJids.length - migrated, total: deviceJids.length }
      }, `migrate-${deviceJids.length}`)
    }
  }
}

// ─── STORAGE ADAPTER ──────────────────────────────────────────────────────────
function signalStorage({ creds, keys }, lidMapping, logger) {
  const resolveLID = async (id) => {
    if (!id.includes('.')) return id
    const [deviceId, device] = id.split('.')
    const [user, dt] = deviceId.split('_')
    const domainType = parseInt(dt || '0')
    if (domainType === WAJIDDomains.LID || domainType === WAJIDDomains.HOSTED_LID) return id
    const pnJid = `${user}${device !== '0' ? `:${device}` : ''}@${domainType === WAJIDDomains.HOSTED ? 'hosted' : 's.whatsapp.net'}`
    const lid = await lidMapping.getLIDForPN(pnJid)
    return lid ? jidToAddr(lid).toString() : id
  }

  const getIndex = async () => {
    const data = await keys.get('session', ['_index'])
    return data?.['_index'] || {}
  }

  const setIndex = async (batch) => {
    const keys_ = Object.keys(batch).sort()
    const trimmed = {}
    for (const k of keys_.slice(-1000)) trimmed[k] = batch[k]
    await keys.set({ session: { '_index': trimmed } })
  }

  return {
    loadSession: async (id) => {
      try {
        const addr = await resolveLID(id)
        const batch = await getIndex()
        const raw = batch[addr]
        if (!raw) return null
        return raw instanceof Uint8Array ? raw : Buffer.from(raw.data ? raw.data : raw)
      } catch (e) {
        logger?.error?.(`[Signal] loadSession error: ${e.message}`)
        return null
      }
    },

    storeSession: async (id, session) => {
      const addr = await resolveLID(id)
      const batch = await getIndex()
      batch[addr] = session.serialize()
      await setIndex(batch)
    },

    isTrustedIdentity: () => true,

    loadIdentityKey: async (id) => {
      const addr = await resolveLID(id)
      const { [addr]: key } = await keys.get('identity-key', [addr])
      return key ? new Uint8Array(Buffer.from(key instanceof Uint8Array ? key : key.data ? key.data : key)) : undefined
    },

    saveIdentity: async (id, identityKey) => {
      const addr = await resolveLID(id)
      const { [addr]: raw } = await keys.get('identity-key', [addr])
      const existing = raw ? new Uint8Array(Buffer.from(raw instanceof Uint8Array ? raw : raw.data ? raw.data : raw)) : null
      const match = existing && existing.length === identityKey.length && existing.every((b, i) => b === identityKey[i])
      if (existing && !match) {
        await keys.set({ session: { [addr]: null }, 'identity-key': { [addr]: identityKey } })
        return true
      }
      if (!existing) {
        await keys.set({ 'identity-key': { [addr]: identityKey } })
        return true
      }
      return false
    },

    loadPreKey: async (id) => {
      const { [id.toString()]: key } = await keys.get('pre-key', [id.toString()])
      if (!key) return null
      return { pubKey: new Uint8Array(Buffer.from(key.public)), privKey: new Uint8Array(Buffer.from(key.private)) }
    },

    removePreKey: (id) => keys.set({ 'pre-key': { [id]: null } }),

    loadSignedPreKey: () => {
      const key = creds.signedPreKey
      return {
        keyId: key.keyId,
        keyPair: { pubKey: new Uint8Array(Buffer.from(key.keyPair.public)), privKey: new Uint8Array(Buffer.from(key.keyPair.private)) },
        signature: new Uint8Array(Buffer.from(key.signature))
      }
    },

    loadSenderKey: async (keyId) => {
      try {
        const id = keyId.toString()
        const { [id]: key } = await keys.get('sender-key', [id])
        if (!key) return null
        return Buffer.from(key instanceof Uint8Array || Array.isArray(key) ? key : key.data ? key.data : key)
      } catch (e) {
        logger?.error?.(`[Signal] loadSenderKey error: ${e.message}`)
        return null
      }
    },

    storeSenderKey: async (keyId, record) => {
      const id = keyId.toString()
      const bytes = record instanceof Uint8Array ? record : Buffer.isBuffer(record) ? record : record.serialize()
      await keys.set({ 'sender-key': { [id]: bytes } })
    },

    getOurRegistrationId: () => creds.registrationId,

    getOurIdentity: () => {
      const { signedIdentityKey } = creds
      return {
        pubKey: new Uint8Array(generateSignalPubKey(Buffer.from(signedIdentityKey.public))),
        privKey: new Uint8Array(Buffer.from(signedIdentityKey.private))
      }
    }
  }
}

export default makeLibSignalRepository