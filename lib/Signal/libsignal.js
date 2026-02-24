/* @ts-ignore */
import * as libsignal from "libsignal"
import { LRUCache } from "lru-cache"
import { generateSignalPubKey } from "../Utils/index.js"
import { isHostedLidUser, isHostedPnUser, isLidUser, isPnUser, jidDecode, transferDevice, WAJIDDomains } from "../WABinary/index.js"
import { SenderKeyName } from "./Group/sender-key-name.js"
import { SenderKeyRecord } from "./Group/sender-key-record.js"
import { SenderKeyState } from "./Group/sender-key-state.js"
import { GroupCipher, GroupSessionBuilder, SenderKeyDistributionMessage } from "./Group/index.js"
import { LIDMappingStore } from "./lid-mapping.js"

const jidToAddr = jid => {
  const { user, device, server, domainType } = jidDecode(jid)
  if (!user) throw new Error(`Invalid JID: "${jid}"`)
  const signalUser = domainType !== WAJIDDomains.WHATSAPP ? `${user}_${domainType}` : user
  if (device === 99 && server !== "hosted" && server !== "hosted.lid") throw new Error("Invalid device 99:" + jid)
  return new libsignal.ProtocolAddress(signalUser, device || 0)
}

const jidToSenderKeyName = (group, user) => new SenderKeyName(group, jidToAddr(user))

export function makeLibSignalRepository(auth, logger, pnToLIDFunc) {
  const lidMapping = new LIDMappingStore(auth.keys, logger, pnToLIDFunc)
  const storage = signalStorage(auth, lidMapping, logger)
  const parsedKeys = auth.keys
  const migratedCache = new LRUCache({ ttl: 7 * 24 * 60 * 60 * 1000, ttlAutopurge: true, updateAgeOnGet: true })

  const txn = (fn, key) => parsedKeys.transaction(fn, key)

  return {
    decryptGroupMessage: ({ group, authorJid, msg }) => {
      const cipher = new GroupCipher(storage, jidToSenderKeyName(group, authorJid))
      return txn(() => cipher.decrypt(msg), group)
    },

    processSenderKeyDistributionMessage: async ({ item, authorJid }) => {
      if (!item.groupId) throw new Error("Group ID required")
      const builder = new GroupSessionBuilder(storage)
      const senderName = jidToSenderKeyName(item.groupId, authorJid)
      const senderMsg = new SenderKeyDistributionMessage(null, null, null, null, item.axolotlSenderKeyDistributionMessage)
      return txn(async () => {
        let record = await storage.loadSenderKey(senderName)
        if (!record) {
          record = new SenderKeyRecord()
          await storage.storeSenderKey(senderName, record)
        }
        await builder.process(senderName, senderMsg)
        logger?.info?.(`[Signal] Sender key from ${authorJid}`)
      }, item.groupId)
    },

    decryptMessage: async ({ jid, type, ciphertext, alternateJid }) => {
      const addr = jidToAddr(jid)
      const session = new libsignal.SessionCipher(storage, addr)
      try {
        return txn(async () => {
          switch (type) {
            case "pkmsg": return await session.decryptPreKeyWhisperMessage(ciphertext)
            case "msg": return await session.decryptWhisperMessage(ciphertext)
          }
        }, jid)
      } catch (e) {
        const msg = e?.message || ""
        if (msg.includes("Bad MAC") || msg.includes("Key used already")) {
          logger?.warn?.({ jid, error: msg }, "Session corrupted")
        }
        // Retry with alternate JID if available and error is specifically "No matching sessions found"
        if (alternateJid && msg.includes("No matching sessions found for message")) {
          logger?.debug?.({ jid, alternateJid }, "Retrying decryption with alternate address")
          const altAddr = jidToAddr(alternateJid)
          const altSession = new libsignal.SessionCipher(storage, altAddr)
          try {
            return txn(async () => {
              switch (type) {
                case "pkmsg": return await altSession.decryptPreKeyWhisperMessage(ciphertext)
                case "msg": return await altSession.decryptWhisperMessage(ciphertext)
              }
            }, alternateJid)
          } catch (altErr) {
            const altMsg = altErr?.message || ""
            logger?.warn?.({ alternateJid, error: altMsg }, "Decryption with alternate address also failed")
            throw e
          }
        }
        throw e
      }
    },

    encryptMessage: ({ jid, data }) => txn(async () => {
      const cipher = new libsignal.SessionCipher(storage, jidToAddr(jid))
      const { type: sigType, body } = await cipher.encrypt(data)
      return { type: sigType === 3 ? "pkmsg" : "msg", ciphertext: Buffer.from(body, "binary") }
    }, jid),

    encryptGroupMessage: async ({ group, meId, data }) => {
      const senderName = jidToSenderKeyName(group, meId)
      const builder = new GroupSessionBuilder(storage)
      return txn(async () => {
        let record = await storage.loadSenderKey(senderName)
        if (!record?.getSenderKeyStates?.()?.length) {
          record = new SenderKeyRecord()
          await storage.storeSenderKey(senderName, record)
        }
        const senderKeyDistMsg = await builder.create(senderName)
        const session = new GroupCipher(storage, senderName)
        return { ciphertext: await session.encrypt(data), senderKeyDistributionMessage: senderKeyDistMsg.serialize() }
      }, group)
    },

    injectE2ESession: ({ jid, session }) => txn(() => new libsignal.SessionBuilder(storage, jidToAddr(jid)).initOutgoing(session), jid),

    jidToSignalProtocolAddress: jid => jidToAddr(jid).toString(),

    lidMapping,

    validateSession: async jid => {
      try {
        const sess = await storage.loadSession(jidToAddr(jid).toString())
        return { exists: sess?.haveOpenSession?.() || false, reason: sess ? null : "no session" }
      } catch (e) {
        return { exists: false, reason: "error" }
      }
    },

    deleteSession: jids => jids.length && txn(async () => {
      const sessionAddrs = jids.map(j => jidToAddr(j).toString())
      // Load batched sessions
      const batchData = await parsedKeys.get("session", ["_index"])
      const sessionBatch = batchData?.['_index'] || {}
      
      // Remove the specified sessions
      sessionAddrs.forEach(addr => {
        delete sessionBatch[addr]
      })
      
      // Store updated batch
      await parsedKeys.set({ session: { "_index": sessionBatch } })
    }, `del-${jids.length}`),

    migrateSession: async (fromJid, toJid) => {
      if (!fromJid || (!isLidUser(toJid) && !isHostedLidUser(toJid))) return { migrated: 0, skipped: 0, total: 0 }
      if (!isPnUser(fromJid) && !isHostedPnUser(fromJid)) return { migrated: 0, skipped: 0, total: 1 }
      
      const { user } = jidDecode(fromJid)
      // Load device-list from batched storage
      const batchData = await parsedKeys.get("device-list", ["_index"])
      const deviceListBatch = batchData?.['_index'] || {}
      const userDevices = deviceListBatch[user]
      if (!userDevices?.length) return { migrated: 0, skipped: 0, total: 0 }

      const { device: fromDevice } = jidDecode(fromJid)
      const fromDeviceStr = fromDevice?.toString() || "0"
      if (!userDevices.includes(fromDeviceStr)) userDevices.push(fromDeviceStr)

      const uncachedDevices = userDevices.filter(d => !migratedCache.has(`${user}.${d}`))
      
      // Load batched sessions
      const sessionBatchData = await parsedKeys.get("session", ["_index"])
      const sessionBatch = sessionBatchData?.['_index'] || {}
      
      const deviceJids = uncachedDevices
        .map(d => {
          const num = Number.parseInt(d)
          const addrStr = num === 0 ? `${user}.0` : `${user}.${d}`
          return { addr: addrStr, jid: num === 0 ? `${user}@s.whatsapp.net` : num === 99 ? `${user}:99@hosted` : `${user}:${num}@s.whatsapp.net` }
        })
        .filter(({ addr }) => sessionBatch[addr])

      return txn(async () => {
        const pnAddrStrs = Array.from(new Set(deviceJids.map(d => jidToAddr(d.jid).toString())))
        const updatedBatch = { ...sessionBatch }
        let migrated = 0
        
        for (const { jid } of deviceJids) {
          const pnAddr = jidToAddr(jid).toString()
          const lidAddr = jidToAddr(transferDevice(jid, toJid)).toString()
          const pnSession = updatedBatch[pnAddr]
          
          if (pnSession) {
            const sess = libsignal.SessionRecord.deserialize(pnSession)
            if (sess.haveOpenSession()) {
              updatedBatch[lidAddr] = sess.serialize()
              delete updatedBatch[pnAddr]
              migrated++
              migratedCache.set(`${user}.${jidDecode(jid).device || 0}`, true)
            }
          }
        }
        
        if (migrated > 0) {
          await parsedKeys.set({ session: { "_index": updatedBatch } })
        }
        return { migrated, skipped: deviceJids.length - migrated, total: deviceJids.length }
      }, `migrate-${deviceJids.length}`)
    },
  }
}

function signalStorage({ creds, keys }, lidMapping, logger) {
  const resolveLID = async id => {
    if (!id.includes(".")) return id
    const [deviceId, device] = id.split(".")
    const [user, dt] = deviceId.split("_")
    const domainType = Number.parseInt(dt || "0")
    if (domainType === WAJIDDomains.LID || domainType === WAJIDDomains.HOSTED_LID) return id
    const pnJid = `${user}${device !== "0" ? `:${device}` : ""}@${domainType === WAJIDDomains.HOSTED ? "hosted" : "s.whatsapp.net"}`
    const lid = await lidMapping.getLIDForPN(pnJid)
    return lid ? jidToAddr(lid).toString() : id
  }

  return {
    loadSession: async id => {
      try {
        const addr = await resolveLID(id)
        // Load from batched session storage
        const batchData = await keys.get("session", ["_index"])
        const sessionBatch = batchData?.['_index'] || {}
        const sess = sessionBatch[addr]
        return sess ? libsignal.SessionRecord.deserialize(sess) : null
      } catch (e) {
        logger?.error?.(`[Signal] Load session: ${e.message}`)
        return null
      }
    },

    storeSession: async (id, session) => {
      const addr = await resolveLID(id)
      // Store in batched session storage
      const existingData = await keys.get("session", ["_index"])
      const sessionBatch = existingData?.['_index'] || {}
      
      // Add/update the session
      sessionBatch[addr] = session.serialize()
      
      // Keep only the most recent 1000 sessions to prevent unlimited growth
      const sessionKeys = Object.keys(sessionBatch).sort()
      const recentSessions = sessionKeys.slice(-1000)
      const trimmedBatch = {}
      recentSessions.forEach(key => {
        trimmedBatch[key] = sessionBatch[key]
      })
      
      await keys.set({ session: { "_index": trimmedBatch } })
    },

    isTrustedIdentity: () => true,

    loadPreKey: async id => {
      const { [id]: key } = await keys.get("pre-key", [id.toString()])
      return key ? { privKey: Buffer.from(key.private), pubKey: Buffer.from(key.public) } : null
    },

    removePreKey: id => keys.set({ "pre-key": { [id]: null } }),

    loadSignedPreKey: () => {
      const key = creds.signedPreKey
      return { privKey: Buffer.from(key.keyPair.private), pubKey: Buffer.from(key.keyPair.public) }
    },

    loadSenderKey: async senderKeyName => {
      try {
        const id = senderKeyName.toString()
        const { [id]: key } = await keys.get("sender-key", [id])
        if (!key) return new SenderKeyRecord()
        try {
          return SenderKeyRecord.deserialize(key)
        } catch (e) {
          logger?.warn?.(`[Signal] Deserialize error, creating new`)
          return new SenderKeyRecord()
        }
      } catch (e) {
        logger?.error?.(`[Signal] Load sender key: ${e.message}`)
        return new SenderKeyRecord()
      }
    },

    storeSenderKey: async (senderKeyName, key) => {
      const id = senderKeyName.toString()
      const serialized = key.serialize()
      const buf = typeof serialized === "string" ? Buffer.from(serialized, "utf-8") : Buffer.from(JSON.stringify(serialized), "utf-8")
      await keys.set({ "sender-key": { [id]: buf } })
    },

    getOurRegistrationId: () => creds.registrationId,

    getOurIdentity: () => {
      const { signedIdentityKey } = creds
      return { privKey: Buffer.from(signedIdentityKey.private), pubKey: Buffer.from(generateSignalPubKey(signedIdentityKey.public)) }
    },
  }
}

export default makeLibSignalRepository