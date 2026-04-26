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

// ===== ADDRESS HELPERS =====
const jidToAddr = (jid) => {
  const { user, device, server, domainType } = jidDecode(jid)
  if (!user) throw new Error(`Invalid JID: "${jid}"`)
  const signalUser = domainType !== WAJIDDomains.WHATSAPP ? `${user}_${domainType}` : user
  if (device === 99 && server !== 'hosted' && server !== 'hosted.lid')
    throw new Error('Invalid device 99: ' + jid)
  return new ProtocolAddress(signalUser, device || 0)
}

const jidToSenderKeyName = (group, user) => new SenderKeyName(group, jidToAddr(user))

// ===== MAIN FACTORY =====
export function makeLibSignalRepository(auth, logger, pnToLIDFunc) {
  const lidMapping = new LIDMappingStore(auth.keys, logger, pnToLIDFunc)
  const storage = signalStorage(auth, lidMapping, logger)
  const parsedKeys = auth.keys
  const migratedCache = new LRUCache({ ttl: 7 * 24 * 60 * 60 * 1000, ttlAutopurge: true, updateAgeOnGet: true })

  const txn = (fn, key) => parsedKeys.transaction(fn, key)

  return {
    decryptGroupMessage: ({ group, authorJid, msg }) => {
      const cipher = new GroupCipher(storage, group, jidToAddr(authorJid))
      return txn(() => cipher.decrypt(msg), group)
    },

    processSenderKeyDistributionMessage: async ({ item, authorJid }) => {
      if (!item.groupId) throw new Error('Group ID required')
      const builder = new GroupSessionBuilder(storage)
      const senderName = jidToSenderKeyName(item.groupId, authorJid)
      const senderMsg = SenderKeyDistributionMessage.deserialize(item.axolotlSenderKeyDistributionMessage)
      return txn(async () => {
        await builder.process(senderName, senderMsg)
        logger?.info?.(`[Signal] Sender key processed from ${authorJid}`)
      }, item.groupId)
    },

    decryptMessage: async ({ jid, type, ciphertext, alternateJid }) => {
      const addr = jidToAddr(jid)
      const cipher = new SessionCipher(storage, addr)

      const doDecrypt = async (c, t) => {
        switch (t) {
          case 'pkmsg': return await c.decryptPreKeyWhisperMessage(ciphertext)
          case 'msg': return await c.decryptWhisperMessage(ciphertext)
          default: throw new Error(`Unknown message type: ${t}`)
        }
      }

      try {
        return await txn(() => doDecrypt(cipher, type), jid)
      } catch (e) {
        const msg = e?.message || ''
        if (msg.includes('Bad MAC') || msg.includes('Key used already')) {
          logger?.warn?.({ jid, error: msg }, '[Signal] Session corrupted')
        }
        if (alternateJid && msg.includes('No matching sessions found')) {
          logger?.debug?.({ jid, alternateJid }, '[Signal] Retrying with alternate address')
          const altCipher = new SessionCipher(storage, jidToAddr(alternateJid))
          try {
            return await txn(() => doDecrypt(altCipher, type), alternateJid)
          } catch (altErr) {
            logger?.warn?.({ alternateJid, error: altErr?.message }, '[Signal] Alternate also failed')
            throw e
          }
        }
        throw e
      }
    },

    encryptMessage: ({ jid, data }) => txn(async () => {
      const cipher = new SessionCipher(storage, jidToAddr(jid))
      const { type: sigType, body } = await cipher.encrypt(data)
      // bridge returns body as Uint8Array, not string like libsignal npm
      return { type: sigType === 3 ? 'pkmsg' : 'msg', ciphertext: Buffer.from(body) }
    }, jid),

    encryptGroupMessage: async ({ group, meId, data }) => {
      const senderName = jidToSenderKeyName(group, meId)
      const builder = new GroupSessionBuilder(storage)
      return txn(async () => {
        const senderKeyDistMsg = await builder.create(senderName)
        const cipher = new GroupCipher(storage, group, jidToAddr(meId))
        return {
          ciphertext: await cipher.encrypt(data),
          senderKeyDistributionMessage: senderKeyDistMsg.serialize()
        }
      }, group)
    },

    injectE2ESession: ({ jid, session }) => txn(
      () => new SessionBuilder(storage, jidToAddr(jid)).processPreKeyBundle(session),
      jid
    ),

    jidToSignalProtocolAddress: jid => jidToAddr(jid).toString(),

    lidMapping,

    validateSession: async (jid) => {
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

    deleteSession: async (jids) => {
      if (!jids.length) return
      return txn(async () => {
        const batchData = await parsedKeys.get('session', ['_index'])
        const sessionBatch = batchData?.['_index'] || {}
        for (const jid of jids) delete sessionBatch[jidToAddr(jid).toString()]
        await parsedKeys.set({ session: { '_index': sessionBatch } })
      }, `del-${jids.length}`)
    },

    migrateSession: async (fromJid, toJid) => {
      if (!fromJid || (!isLidUser(toJid) && !isHostedLidUser(toJid)))
        return { migrated: 0, skipped: 0, total: 0 }
      if (!isPnUser(fromJid) && !isHostedPnUser(fromJid))
        return { migrated: 0, skipped: 0, total: 1 }

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
        const addrStr = num === 0 ? `${user}.0` : `${user}.${d}`
        return {
          addr: addrStr,
          jid: num === 0 ? `${user}@s.whatsapp.net`
            : num === 99 ? `${user}:99@hosted`
              : `${user}:${num}@s.whatsapp.net`
        }
      }).filter(({ addr }) => sessionBatch[addr])

      return txn(async () => {
        const updatedBatch = { ...sessionBatch }
        let migrated = 0

        for (const { jid } of deviceJids) {
          const pnAddr = jidToAddr(jid).toString()
          const lidAddr = jidToAddr(transferDevice(jid, toJid)).toString()
          const rawSession = updatedBatch[pnAddr]
          if (rawSession) {
            const sess = SessionRecord.deserialize(rawSession)
            if (sess.haveOpenSession()) {
              updatedBatch[lidAddr] = sess.serialize()
              delete updatedBatch[pnAddr]
              migrated++
              migratedCache.set(`${user}.${jidDecode(jid).device || 0}`, true)
            }
          }
        }

        if (migrated > 0) await parsedKeys.set({ session: { '_index': updatedBatch } })
        return { migrated, skipped: deviceJids.length - migrated, total: deviceJids.length }
      }, `migrate-${deviceJids.length}`)
    }
  }
}

// ===== STORAGE ADAPTER =====
// The bridge's SignalStorage interface expects:
// - loadSession → Uint8Array | null  (raw bytes, not SessionRecord)
// - loadSenderKey → Uint8Array | null (raw bytes)
// - storeSenderKey → receives Uint8Array
// This adapter translates your key store format to what the bridge expects
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

  return {
    // Returns raw Uint8Array — bridge deserializes internally
    loadSession: async (id) => {
      try {
        const addr = await resolveLID(id)
        const batchData = await keys.get('session', ['_index'])
        const sessionBatch = batchData?.['_index'] || {}
        const raw = sessionBatch[addr]
        if (!raw) return null
        // raw is already serialized bytes from storeSession
        return raw instanceof Uint8Array ? raw : Buffer.from(raw)
      } catch (e) {
        logger?.error?.(`[Signal] Load session error: ${e.message}`)
        return null
      }
    },

    // Bridge passes SessionRecord object — serialize to bytes for storage
    storeSession: async (id, session) => {
      const addr = await resolveLID(id)
      const existingData = await keys.get('session', ['_index'])
      const sessionBatch = existingData?.['_index'] || {}
      sessionBatch[addr] = session.serialize()
      const sessionKeys = Object.keys(sessionBatch).sort()
      const trimmed = {}
      for (const k of sessionKeys.slice(-1000)) trimmed[k] = sessionBatch[k]
      await keys.set({ session: { '_index': trimmed } })
    },

    isTrustedIdentity: () => true,

    loadIdentityKey: async (id) => {
      const addr = await resolveLID(id)
      const { [addr]: key } = await keys.get('identity-key', [addr])
      return key ? new Uint8Array(key) : undefined
    },

    saveIdentity: async (id, identityKey) => {
      // Not called by bridge storage interface directly but kept for compat
      return false
    },

    loadPreKey: async (id) => {
      const { [id]: key } = await keys.get('pre-key', [id.toString()])
      if (!key) return null
      return { pubKey: new Uint8Array(key.public), privKey: new Uint8Array(key.private) }
    },

    removePreKey: (id) => keys.set({ 'pre-key': { [id]: null } }),

    loadSignedPreKey: () => {
      const key = creds.signedPreKey
      return {
        keyId: key.keyId,
        keyPair: {
          pubKey: new Uint8Array(key.keyPair.public),
          privKey: new Uint8Array(key.keyPair.private)
        },
        signature: new Uint8Array(key.signature)
      }
    },

    // Bridge loadSenderKey expects Uint8Array | null
    loadSenderKey: async (keyId) => {
      try {
        const id = keyId.toString()
        const { [id]: key } = await keys.get('sender-key', [id])
        if (!key) return null
        return key instanceof Uint8Array ? key : Buffer.from(key)
      } catch (e) {
        logger?.error?.(`[Signal] Load sender key error: ${e.message}`)
        return null
      }
    },

    // Bridge storeSenderKey passes Uint8Array directly
    storeSenderKey: async (keyId, record) => {
      const id = keyId.toString()
      const bytes = record instanceof Uint8Array ? record : record.serialize()
      await keys.set({ 'sender-key': { [id]: bytes } })
    },

    getOurRegistrationId: () => creds.registrationId,

    getOurIdentity: () => {
      const { signedIdentityKey } = creds
      return {
        pubKey: new Uint8Array(generateSignalPubKey(signedIdentityKey.public)),
        privKey: new Uint8Array(signedIdentityKey.private)
      }
    }
  }
}

export default makeLibSignalRepository