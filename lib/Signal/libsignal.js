import {
  SessionCipher,
  SessionBuilder,
  SessionRecord,
  ProtocolAddress,
  GroupCipher,
  GroupSessionBuilder,
  SenderKeyName,
  SenderKeyDistributionMessage,
} from 'whatsapp-rust-bridge'
import { LRUCache } from 'lru-cache'
import { generateSignalPubKey, migrateIndexKey } from '../Utils/index.js'
import { isHostedLidUser, isHostedPnUser, isLidUser, isPnUser, jidDecode, transferDevice, WAJIDDomains } from '../WABinary/index.js'
import { LIDMappingStore } from './lid-mapping.js'

// ─── Address Helpers ──────────────────────────────────────────────────────────

const jidToAddr = (jid) => {
  const { user, device, server, domainType } = jidDecode(jid)
  if (!user) throw new Error(`Invalid JID: "${jid}"`)
  if (device === 99 && server !== 'hosted' && server !== 'hosted.lid') throw new Error('Invalid device 99: ' + jid)
  const signalUser = domainType !== WAJIDDomains.WHATSAPP ? `${user}_${domainType}` : user
  return new ProtocolAddress(signalUser, device || 0)
}

const jidToSenderKeyName = (group, user) => new SenderKeyName(group, jidToAddr(user))

const v2Key = (addr) => `${addr}:v2` // v2 slot holds the actual serialized SessionRecord bytes

// ─── Identity Extraction ──────────────────────────────────────────────────────

function extractIdentityFromPkmsg(ciphertext) {
  try {
    if (!ciphertext || ciphertext.length < 2) return undefined
    if ((ciphertext[0] & 0xf) !== 3) return undefined
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

// ─── Buffer Utils ─────────────────────────────────────────────────────────────

// universal deserializer — handles all shapes written by any previous version
const toBuffer = (raw) => {
  if (!raw) return null
  if (raw instanceof Uint8Array) return raw
  if (Buffer.isBuffer(raw)) return raw
  if (raw?.type === 'Buffer' && Array.isArray(raw?.data)) return Buffer.from(raw.data)
  if (Array.isArray(raw)) return Buffer.from(raw)
  if (typeof raw === 'string') return Buffer.from(raw, 'base64')
  if (raw?.data) return Buffer.from(raw.data)
  return null
}

// detects old libsignal JS JSON format — not deserializable by whatsapp-rust-bridge
const isOldJson = (raw) => {
  if (!raw || raw instanceof Uint8Array || Buffer.isBuffer(raw)) return false
  if (typeof raw === 'object') return 'version' in raw || '_sessions' in raw
  if (typeof raw === 'string') { try { const p = JSON.parse(raw); return 'version' in p || '_sessions' in p } catch { return false } }
  return false
}

// ─── Main Factory ─────────────────────────────────────────────────────────────

export function makeLibSignalRepository(auth, logger, pnToLIDFunc) {
  const lidMapping = new LIDMappingStore(auth.keys, logger, pnToLIDFunc)
  const storage = signalStorage(auth, lidMapping, logger)
  const parsedKeys = auth.keys
  const migratedCache = new LRUCache({ ttl: 7 * 24 * 60 * 60 * 1000, ttlAutopurge: true, updateAgeOnGet: true })
  const txn = (fn, key) => parsedKeys.transaction(fn, key)

  return {
    decryptGroupMessage({ group, authorJid, msg }) {
      return txn(() => new GroupCipher(storage, group, jidToAddr(authorJid)).decrypt(msg), group)
    },

    async processSenderKeyDistributionMessage({ item, authorJid }) {
      if (!item.groupId) throw new Error('Group ID required')
      const senderName = jidToSenderKeyName(item.groupId, authorJid)
      const senderMsg = SenderKeyDistributionMessage.deserialize(item.axolotlSenderKeyDistributionMessage)
      return txn(() => new GroupSessionBuilder(storage).process(senderName, senderMsg), item.groupId)
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
      try {
        return await txn(() => doDecrypt(cipher, type), jid)
      } catch (e) {
        if (e?.message?.includes('DuplicatedMessage')) { logger?.debug?.({ jid }, '[Signal] Duplicate message ignored — offline replay'); return null }
        throw e
      }
    },

    encryptMessage({ jid, data }) {
      return txn(async () => {
        const { type: sigType, body } = await new SessionCipher(storage, jidToAddr(jid)).encrypt(data)
        return { type: sigType === 3 ? 'pkmsg' : 'msg', ciphertext: Buffer.from(body) }
      }, jid)
    },

    encryptGroupMessage({ group, meId, data }) {
      return txn(async () => {
        const senderName = jidToSenderKeyName(group, meId)
        const senderKeyDistributionMessage = await new GroupSessionBuilder(storage).create(senderName)
        return { ciphertext: await new GroupCipher(storage, group, jidToAddr(meId)).encrypt(data), senderKeyDistributionMessage: senderKeyDistributionMessage.serialize() }
      }, group)
    },

    injectE2ESession({ jid, session }) {
      return txn(() => new SessionBuilder(storage, jidToAddr(jid)).processPreKeyBundle(session), jid)
    },

    jidToSignalProtocolAddress: jid => jidToAddr(jid).toString(),

    lidMapping,

    async validateSession(jid) {
      try {
        const addr = jidToAddr(jid).toString()
        const batch = await migrateIndexKey(parsedKeys, 'session')
        const raw = toBuffer(batch[v2Key(addr)]) || toBuffer(batch[addr]) // v2 slot first, fall back to plain
        if (!raw || isOldJson(raw)) return { exists: false, reason: 'no session' }
        const sess = SessionRecord.deserialize(raw)
        if (!sess.haveOpenSession()) return { exists: false, reason: 'no open session' }
        return { exists: true }
      } catch { return { exists: false, reason: 'error' } }
    },

    async deleteSession(jids) {
      if (!jids.length) return
      return txn(async () => {
        const batch = await migrateIndexKey(parsedKeys, 'session')
        for (const jid of jids) { const addr = jidToAddr(jid).toString(); delete batch[addr]; delete batch[v2Key(addr)] }
        await parsedKeys.set({ session: { 'index': batch } })
      }, `del-${jids.length}`)
    },

    async migrateSession(fromJid, toJid) {
      if (!fromJid || (!isLidUser(toJid) && !isHostedLidUser(toJid))) return { migrated: 0, skipped: 0, total: 0 }
      if (!isPnUser(fromJid) && !isHostedPnUser(fromJid)) return { migrated: 0, skipped: 0, total: 1 }
      const { user } = jidDecode(fromJid)
      const deviceListBatch = await migrateIndexKey(parsedKeys, 'device-list')
      const userDevices = deviceListBatch[user]
      if (!userDevices?.length) return { migrated: 0, skipped: 0, total: 0 }
      const fromDeviceStr = jidDecode(fromJid).device?.toString() || '0'
      if (!userDevices.includes(fromDeviceStr)) userDevices.push(fromDeviceStr)
      const uncachedDevices = userDevices.filter(d => !migratedCache.has(`${user}.${d}`))
      const sessionBatch = await migrateIndexKey(parsedKeys, 'session')
      const deviceJids = uncachedDevices.map(d => {
        const num = parseInt(d)
        return { addr: `${user}.${d || 0}`, jid: num === 99 ? `${user}:99@hosted` : num === 0 ? `${user}@s.whatsapp.net` : `${user}:${num}@s.whatsapp.net` }
      }).filter(({ addr }) => sessionBatch[v2Key(addr)] || sessionBatch[addr])
      return txn(async () => {
        const updated = { ...sessionBatch }
        let migrated = 0
        for (const { jid } of deviceJids) {
          const pnAddr = jidToAddr(jid).toString()
          const lidAddr = jidToAddr(transferDevice(jid, toJid)).toString()
          const raw = toBuffer(updated[v2Key(pnAddr)]) || toBuffer(updated[pnAddr]) // prefer v2 slot
          if (!raw || isOldJson(raw)) continue
          const sess = SessionRecord.deserialize(raw)
          if (!sess.haveOpenSession()) continue
          updated[v2Key(lidAddr)] = sess.serialize()
          updated[lidAddr] = { version: 'v1', _sessions: {} } // plain slot marker for compat
          delete updated[v2Key(pnAddr)]
          delete updated[pnAddr]
          migrated++
          migratedCache.set(`${user}.${jidDecode(jid).device || 0}`, true)
        }
        if (migrated > 0) await parsedKeys.set({ session: { 'index': updated } })
        return { migrated, skipped: deviceJids.length - migrated, total: deviceJids.length }
      }, `migrate-${deviceJids.length}`)
    },

    // Batch-migrate all PN-addressed sessions to their LID equivalents.
    // Called once on CB:success before offline messages are processed — one read, one remap, one write.
    async migrateAllPNSessionsToLID() {
      return txn(async () => {
        const sessionBatch = await migrateIndexKey(parsedKeys, 'session')
        const sessionKeys = Object.keys(sessionBatch)
        if (!sessionKeys.length) return 0

        // collect plain (non-v2) PN-domain keys only — v2 slots are handled via their plain counterpart
        const pnAddrs = sessionKeys.filter(addr => {
          if (addr.endsWith(':v2')) return false
          if (!addr.includes('.')) return false
          const [deviceId] = addr.split('.')
          const [, dt] = deviceId.split('_')
          const domainType = parseInt(dt || '0')
          return domainType === WAJIDDomains.WHATSAPP || domainType === WAJIDDomains.HOSTED
        })
        if (!pnAddrs.length) return 0

        // batch-fetch LID mappings directly from key store — same format storeLIDPNMappings writes
        const pnUserSet = new Set(pnAddrs.map(addr => addr.split('.')[0].split('_')[0]))
        const stored = await parsedKeys.get('lid-mapping', [...pnUserSet])

        const pnToLidUserMap = new Map()
        for (const pnUser of pnUserSet) {
          const lidUser = stored[pnUser]
          if (lidUser && typeof lidUser === 'string') pnToLidUserMap.set(pnUser, lidUser)
        }
        if (!pnToLidUserMap.size) return 0

        let migrated = 0
        const updated = { ...sessionBatch }

        for (const addr of pnAddrs) {
          const [deviceId, device] = addr.split('.')
          const [user, dt] = deviceId.split('_')
          const domainType = parseInt(dt || '0')
          const lidUser = pnToLidUserMap.get(user)
          if (!lidUser) continue
          const lidDomainType = domainType === WAJIDDomains.HOSTED ? WAJIDDomains.HOSTED_LID : WAJIDDomains.LID
          const lidAddr = `${lidUser}_${lidDomainType}.${device}`
          if (updated[v2Key(lidAddr)]) continue // LID session already exists, skip
          const raw = toBuffer(updated[v2Key(addr)]) || toBuffer(updated[addr]) // prefer v2 slot
          if (!raw || isOldJson(raw)) continue
          const sess = SessionRecord.deserialize(raw)
          if (!sess.haveOpenSession()) continue
          updated[v2Key(lidAddr)] = sess.serialize()
          updated[lidAddr] = { version: 'v1', _sessions: {} } // plain slot marker for compat
          delete updated[v2Key(addr)]
          delete updated[addr]
          migrated++
          migratedCache.set(`${user}.${device}`, true)
        }

        if (migrated > 0) {
          await parsedKeys.set({ session: { 'index': updated } })
          logger?.info?.({ migrated, totalPN: pnAddrs.length, mappingsFound: pnToLidUserMap.size }, '[Signal] Batch-migrated PN sessions to LID on connect')
        }
        return migrated
      }, 'migrate-all-pn-to-lid')
    }
  }
}

// ─── Storage Adapter ──────────────────────────────────────────────────────────

function signalStorage({ creds, keys }, lidMapping, logger) {
  const lidCache = new LRUCache({ max: 500, ttl: 5 * 60 * 1000 }) // cache PN→LID resolutions for 5 min

  const resolveLID = async (id) => {
    if (!id.includes('.')) return id
    const cached = lidCache.get(id)
    if (cached) return cached
    const [deviceId, device] = id.split('.')
    const [user, dt] = deviceId.split('_')
    const domainType = parseInt(dt || '0')
    if (domainType === WAJIDDomains.LID || domainType === WAJIDDomains.HOSTED_LID) return id
    const pnJid = `${user}${device !== '0' ? `:${device}` : ''}@${domainType === WAJIDDomains.HOSTED ? 'hosted' : 's.whatsapp.net'}`
    const lid = await lidMapping.getLIDForPN(pnJid)
    const result = lid ? jidToAddr(lid).toString() : id
    lidCache.set(id, result)
    return result
  }

  const getIndex = () => migrateIndexKey(keys, 'session')
  const setIndex = (batch) => keys.set({ session: { 'index': batch } })

  return {
    loadSession: async (id) => {
      try {
        const addr = await resolveLID(id)
        const batch = await getIndex()
        const v2 = batch[v2Key(addr)]
        if (v2) {
          if (isOldJson(v2)) { logger?.debug?.(`[Signal] Corrupt v2 for ${addr}, will fresh handshake`); return null }
          const buf = toBuffer(v2)
          if (buf) return buf
        }
        const plain = batch[addr]
        if (!plain || isOldJson(plain)) { // old JS JSON format — not usable by rust bridge
          if (plain) logger?.debug?.(`[Signal] Old JSON session for ${addr}, will fresh handshake`)
          return null
        }
        return toBuffer(plain)
      } catch (e) { logger?.error?.(`[Signal] loadSession error: ${e.message}`); return null }
    },

    storeSession: async (id, session) => {
      const addr = await resolveLID(id)
      const batch = await getIndex()
      batch[v2Key(addr)] = session.serialize() // always write to v2 slot
      batch[addr] = { version: 'v1', _sessions: {} } // plain slot marker so old code sees something
      await setIndex(batch)
    },

    isTrustedIdentity: () => true,

    loadIdentityKey: async (id) => {
      const addr = await resolveLID(id)
      const { [addr]: key } = await keys.get('identity-key', [addr])
      const buf = toBuffer(key)
      return buf ? new Uint8Array(buf) : undefined
    },

    saveIdentity: async (id, identityKey) => {
      const addr = await resolveLID(id)
      const { [addr]: raw } = await keys.get('identity-key', [addr])
      const buf = toBuffer(raw)
      const existing = buf ? new Uint8Array(buf) : null
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
      const { signedPreKey: key } = creds
      return { keyId: key.keyId, keyPair: { pubKey: new Uint8Array(Buffer.from(key.keyPair.public)), privKey: new Uint8Array(Buffer.from(key.keyPair.private)) }, signature: new Uint8Array(Buffer.from(key.signature)) }
    },

    loadSenderKey: async (keyId) => {
      try {
        const id = keyId.toString()
        const { [id]: key } = await keys.get('sender-key', [id])
        return toBuffer(key)
      } catch (e) { logger?.error?.(`[Signal] loadSenderKey error: ${e.message}`); return null }
    },

    storeSenderKey: async (keyId, record) => {
      const id = keyId.toString()
      const bytes = record instanceof Uint8Array ? record : Buffer.isBuffer(record) ? record : record.serialize()
      await keys.set({ 'sender-key': { [id]: bytes } })
    },

    getOurRegistrationId: () => creds.registrationId,

    getOurIdentity: () => {
      const { signedIdentityKey } = creds
      return { pubKey: new Uint8Array(generateSignalPubKey(Buffer.from(signedIdentityKey.public))), privKey: new Uint8Array(Buffer.from(signedIdentityKey.private)) }
    }
  }
}

export default makeLibSignalRepository