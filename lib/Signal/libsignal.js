import {
    SessionCipher,
    SessionBuilder,
    SessionRecord,
    ProtocolAddress,
    GroupCipher,
    GroupSessionBuilder,
    SenderKeyName,
    SenderKeyDistributionMessage,
    SenderKeyRecord,
} from 'whatsapp-rust-bridge'
import { proto } from '../../WAProto/index.js'
import { LRUCache } from 'lru-cache'
import { generateSignalPubKey } from '../Utils/index.js'
import { isHostedLidUser, isHostedPnUser, isLidUser, isPnUser, jidDecode, transferDevice, WAJIDDomains } from '../WABinary/index.js'
import { LIDMappingStore } from './lid-mapping.js'

// ─── Address Helpers ──────────────────────────────────────────────────────────

const jidToAddr = (jid) => {
    const { user, device, server, domainType } = jidDecode(jid)
    if (!user) throw new Error(`Invalid JID: "${jid}"`)
    if (device === 99 && server !== 'hosted' && server !== 'hosted.lid') throw new Error('Invalid device 99: ' + jid)
    return new ProtocolAddress(
        domainType !== WAJIDDomains.WHATSAPP ? `${user}_${domainType}` : user,
        device || 0
    )
}

const jidToSenderKeyName = (group, user) => new SenderKeyName(group, jidToAddr(user))

// ─── Buffer Utils ─────────────────────────────────────────────────────────────

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

const toU8 = (raw) => {
    const buf = toBuffer(raw)
    if (!buf) return null
    return buf instanceof Uint8Array && buf.constructor === Uint8Array
        ? buf
        : new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength)
}

const isOldJson = (raw) => {
    if (!raw || raw instanceof Uint8Array || Buffer.isBuffer(raw)) return false
    if (typeof raw === 'object') return 'version' in raw || '_sessions' in raw
    if (typeof raw === 'string') {
        try { const p = JSON.parse(raw); return 'version' in p || '_sessions' in p } catch { return false }
    }
    return false
}

const bufEqual = (a, b) =>
    a && b && a.length === b.length && a.every((byte, i) => byte === b[i])

// ─── Identity Key Extraction ──────────────────────────────────────────────────

const extractIdentityFromPkmsg = (ciphertext) => {
    try {
        if (!ciphertext || ciphertext.length < 2) return undefined
        if ((ciphertext[0] & 0xf) !== 3) return undefined
        const decoded = proto.PreKeySignalMessage.decode(ciphertext.subarray(1))
        const key = decoded.identityKey
        if (key && key.length === 33) return new Uint8Array(key)
        return undefined
    } catch {
        return undefined
    }
}

// ─── Main Factory ─────────────────────────────────────────────────────────────

export function makeLibSignalRepository(auth, logger, pnToLIDFunc) {
    const lidMapping = new LIDMappingStore(auth.keys, logger, pnToLIDFunc)
    const parsedKeys = auth.keys

    // LRU cache for PN→LID address resolution to avoid repeated DB lookups
    const lidCache = new LRUCache({ max: 500, ttl: 5 * 60 * 1000 })

    // Per-address session read cache: avoids a DB round-trip on every decrypt.
    // Keyed by resolved LID addr string. Value is Uint8Array | null.
    const sessionReadCache = new LRUCache({ max: 1000, ttl: 5 * 60 * 1000, ttlAutopurge: true })

    // Per-address identity read cache: avoids a DB round-trip on every encrypt.
    const identityReadCache = new LRUCache({ max: 1000, ttl: 5 * 60 * 1000, ttlAutopurge: true })

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

    const storage = signalStorage(auth, lidMapping, logger, lidCache, sessionReadCache, identityReadCache, resolveLID)

    // Tracks which PN→LID session migrations have already been done this process
    // lifetime so migrateSession is idempotent even if called repeatedly.
    const migratedCache = new LRUCache({ max: 5000, ttl: 7 * 24 * 60 * 60 * 1000, ttlAutopurge: true, updateAgeOnGet: true })

    const txn = (fn, key) => parsedKeys.transaction(fn, key)

    return {
        // ── Group messaging ───────────────────────────────────────────────────────

        decryptGroupMessage({ group, authorJid, msg }) {
            return txn(
                () => new GroupCipher(storage, group, jidToAddr(authorJid)).decrypt(toU8(msg)),
                group
            )
        },

        async processSenderKeyDistributionMessage({ item, authorJid }) {
            if (!item.groupId) throw new Error('Group ID required')
            const senderName = jidToSenderKeyName(item.groupId, authorJid)
            const senderMsg = SenderKeyDistributionMessage.deserialize(
                toU8(item.axolotlSenderKeyDistributionMessage)
            )
            return txn(() => new GroupSessionBuilder(storage).process(senderName, senderMsg), item.groupId)
        },

        encryptGroupMessage({ group, meId, data }) {
            return txn(async () => {
                const senderName = jidToSenderKeyName(group, meId)
                const name = senderName.toString()
                const { [name]: raw } = await parsedKeys.get('sender-key', [name])
                const hasKey = raw ? (() => { try { return !SenderKeyRecord.deserialize(toU8(raw)).isEmpty() } catch { return false } })() : false
                const skdm = await new GroupSessionBuilder(storage).create(senderName)
                const ciphertext = await new GroupCipher(storage, group, jidToAddr(meId)).encrypt(toU8(data))
                return { ciphertext, senderKeyDistributionMessage: hasKey ? undefined : skdm.serialize() }
            }, group)
        },

        getSenderKeyDistributionMessage({ group, meId }) {
            return txn(async () => {
                const senderName = jidToSenderKeyName(group, meId)
                return (await new GroupSessionBuilder(storage).create(senderName)).serialize()
            }, group)
        },

        async hasSenderKey({ group, meId }) {
            const name = jidToSenderKeyName(group, meId).toString()
            const { [name]: raw } = await parsedKeys.get('sender-key', [name])
            const buf = toU8(raw)
            if (!buf) return false
            try {
                return !SenderKeyRecord.deserialize(buf).isEmpty()
            } catch {
                return false
            }
        },

        deleteSenderKey(group, authorJid) {
            return parsedKeys.set({ 'sender-key': { [jidToSenderKeyName(group, authorJid).toString()]: null } })
        },

        // ── 1:1 messaging ─────────────────────────────────────────────────────────

        async decryptMessage({ jid, type, ciphertext }) {
            const addr = jidToAddr(jid)
            const addrStr = addr.toString()
            const cipher = new SessionCipher(storage, addr)

            try {
                return await txn(async () => {
                    if (type === 'pkmsg') {
                        const identityKey = extractIdentityFromPkmsg(ciphertext)
                        if (identityKey) {
                            const changed = await storage.saveIdentity(addrStr, identityKey)
                            if (changed) logger?.info?.({ jid }, '[Signal] Identity key changed — session cleared for re-handshake')
                        } else {
                            logger?.warn?.({ jid }, '[Signal] pkmsg: could not extract identity key from envelope')
                        }
                        return cipher.decryptPreKeyWhisperMessage(toU8(ciphertext))
                    }
                    if (type === 'msg') {
                        return cipher.decryptWhisperMessage(toU8(ciphertext))
                    }
                    throw new Error(`[Signal] Unknown message type: ${type}`)
                }, jid)
            } catch (e) {
                if (e?.message?.includes('DuplicatedMessage')) {
                    logger?.debug?.({ jid }, '[Signal] Duplicate message ignored')
                    return null
                }
                if (e?.message?.includes('UntrustedIdentity') || e?.message?.includes('InvalidMessage') || e?.message?.includes('BadMac')) {
                    logger?.warn?.({ jid, err: e.message }, '[Signal] Session error — wiping session for re-handshake')
                    await storage.wipeSession(addrStr)
                    sessionReadCache.delete(addrStr)
                }
                throw e
            }
        },

        encryptMessage({ jid, data }) {
            return txn(async () => {
                const { type: sigType, body } = await new SessionCipher(storage, jidToAddr(jid)).encrypt(toU8(data))
                return { type: sigType === 3 ? 'pkmsg' : 'msg', ciphertext: Buffer.from(body) }
            }, jid)
        },

        injectE2ESession({ jid, session }) {
            return txn(() => new SessionBuilder(storage, jidToAddr(jid)).processPreKeyBundle(session), jid)
        },

        // ── Session utilities ──────────────────────────────────────────────────────

        jidToSignalProtocolAddress: (jid) => jidToAddr(jid).toString(),

        lidMapping,

        async validateSession(jid) {
            try {
                const addr = jidToAddr(jid).toString()
                const raw = await storage.loadSession(addr)
                if (!raw) return { exists: false, reason: 'no session' }
                try {
                    return SessionRecord.deserialize(raw).haveOpenSession()
                        ? { exists: true }
                        : { exists: false, reason: 'no open session' }
                } catch {
                    return { exists: false, reason: 'deserialize error' }
                }
            } catch {
                return { exists: false, reason: 'error' }
            }
        },

        async deleteSession(jids) {
            if (!jids?.length) return
            return txn(async () => {
                const updates = {}
                for (const jid of jids) {
                    const addr = jidToAddr(jid).toString()
                    updates[addr] = null
                    sessionReadCache.delete(addr)
                }
                await parsedKeys.set({ session: updates })
            }, `del-${jids.length}`)
        },

        // ── Session migration (PN → LID) ──────────────────────────────────────────

        async migrateSession(fromJid, toJid) {
            if (!fromJid || (!isLidUser(toJid) && !isHostedLidUser(toJid))) return { migrated: 0, skipped: 0, total: 0 }
            if (!isPnUser(fromJid) && !isHostedPnUser(fromJid)) return { migrated: 0, skipped: 0, total: 1 }
            const { user } = jidDecode(fromJid)

            const { [user]: userDevices_ } = await parsedKeys.get('device-list', [user])
            const userDevices = userDevices_ ? [...userDevices_] : []
            const fromDeviceStr = jidDecode(fromJid).device?.toString() || '0'
            if (!userDevices.includes(fromDeviceStr)) userDevices.push(fromDeviceStr)

            // Build addr strings for each device, skip already-migrated
            const candidates = userDevices
                .filter(d => !migratedCache.has(`${user}.${d}`))
                .map(d => {
                    const num = parseInt(d)
                    const jid = num === 99 ? `${user}:99@hosted`
                        : num === 0 ? `${user}@s.whatsapp.net`
                            : `${user}:${num}@s.whatsapp.net`
                    return { cacheKey: `${user}.${d}`, jid, addr: jidToAddr(jid).toString() }
                })

            if (!candidates.length) return { migrated: 0, skipped: 0, total: 0 }

            // Bulk-fetch only the session keys we actually need
            const addrs = candidates.map(c => c.addr)
            const existing = await parsedKeys.get('session', addrs)

            const toMigrate = candidates.filter(c => {
                const raw = toU8(existing[c.addr])
                return raw && !isOldJson(raw)
            })

            if (!toMigrate.length) return { migrated: 0, skipped: candidates.length, total: candidates.length }

            return txn(async () => {
                // Re-fetch inside txn for freshness
                const fresh = await parsedKeys.get('session', toMigrate.map(c => c.addr))
                const updates = {}
                let migrated = 0

                for (const { jid, addr, cacheKey } of toMigrate) {
                    const raw = toU8(fresh[addr])
                    if (!raw || isOldJson(raw)) continue
                    let sess
                    try { sess = SessionRecord.deserialize(raw) } catch { continue }
                    if (!sess.haveOpenSession()) continue
                    const lidAddr = jidToAddr(transferDevice(jid, toJid)).toString()
                    updates[lidAddr] = sess.serialize()
                    updates[addr] = null
                    lidCache.delete(addr)
                    sessionReadCache.delete(addr)
                    migrated++
                    migratedCache.set(cacheKey, true)
                }

                if (migrated > 0) {
                    await parsedKeys.set({ session: updates })
                }
                return { migrated, skipped: toMigrate.length - migrated, total: candidates.length }
            }, `migrate-${jidDecode(toJid)?.user}`)
        },

        async warmLIDCache(mappings) {
            for (const { pn, lid } of mappings) {
                try {
                    const pnAddr = jidToAddr(pn).toString()
                    const lidAddr = jidToAddr(lid).toString()
                    lidCache.set(pnAddr, lidAddr)
                } catch { }
            }
        },

        async preLoadKeys(jids) {
            if (!jids?.length) return
            try {
                const addrs = await Promise.all(
                    jids.map(jid => resolveLID(jidToAddr(jid).toString()))
                )
                const [sessions, identityKeys] = await Promise.all([
                    parsedKeys.get('session', addrs),
                    parsedKeys.get('identity-key', addrs)
                ])
                for (const addr of addrs) {
                    if (sessions[addr] !== undefined) {
                        sessionReadCache.set(addr, sessions[addr] ? toU8(sessions[addr]) : null)
                    }
                    if (identityKeys[addr] !== undefined) {
                        identityReadCache.set(addr, identityKeys[addr] ? toU8(identityKeys[addr]) : null)
                    }
                }
            } catch (error) {
                logger?.warn?.({ err: error?.message || error }, '[Signal] preLoadKeys failed')
            }
        },

        close() {
            migratedCache.clear()
            sessionReadCache.clear()
            identityReadCache.clear()
            lidCache.clear()
            lidMapping.close?.()
        }
    }
}

// ─── Storage Adapter ──────────────────────────────────────────────────────────
// Implements the SignalStorage interface consumed by whatsapp-rust-bridge WASM.
//
// One key per record — exactly as original Baileys does:
//   session:      addr string  → Uint8Array (SessionRecord.serialize())
//   identity-key: addr string  → Uint8Array (33-byte identity key)
//   pre-key:      id string    → { public, private }
//   sender-key:   keyId string → Buffer

function signalStorage({ creds, keys }, lidMapping, logger, lidCache, sessionReadCache, identityReadCache, resolveLID) {

    return {
        // ── Sessions ─────────────────────────────────────────────────────────────

        loadSession: async (id) => {
            try {
                const addr = await resolveLID(id)
                const cached = sessionReadCache.get(addr)
                if (cached !== undefined) return cached === null ? null : toU8(cached)
                const { [addr]: raw } = await keys.get('session', [addr])
                if (!raw || isOldJson(raw)) {
                    sessionReadCache.set(addr, null)
                    return null
                }
                const buf = toU8(raw)
                sessionReadCache.set(addr, buf)
                return buf
            } catch (e) {
                logger?.error?.(`[Signal] loadSession error for ${id}: ${e.message}`)
                return null
            }
        },

        storeSession: async (id, record) => {
            const addr = await resolveLID(id)
            const serialized = record.serialize()
            sessionReadCache.set(addr, toU8(serialized))
            await keys.set({ session: { [addr]: serialized } })
        },

        // ── Identity keys ─────────────────────────────────────────────────────────

        isTrustedIdentity: async (id, identityKey) => {
            try {
                const addr = await resolveLID(id)
                let existing = identityReadCache.get(addr)
                if (existing === undefined) {
                    const { [addr]: raw } = await keys.get('identity-key', [addr])
                    existing = toU8(raw) ?? null
                    identityReadCache.set(addr, existing)
                }
                if (!existing) return true
                const a = existing
                const b = identityKey instanceof Uint8Array ? identityKey : toU8(identityKey)
                return !!bufEqual(a, b)
            } catch {
                return true
            }
        },

        loadIdentityKey: async (id) => {
            const addr = await resolveLID(id)
            let key = identityReadCache.get(addr)
            if (key === undefined) {
                const { [addr]: raw } = await keys.get('identity-key', [addr])
                key = toU8(raw) ?? null
                identityReadCache.set(addr, key)
            }
            return key === null ? undefined : key
        },

        saveIdentity: async (id, identityKey) => {
            const addr = await resolveLID(id)
            let existing = identityReadCache.get(addr)
            if (existing === undefined) {
                const { [addr]: raw } = await keys.get('identity-key', [addr])
                existing = toU8(raw) ?? null
                identityReadCache.set(addr, existing)
            }
            const a = existing
            const b = identityKey instanceof Uint8Array ? identityKey : toU8(identityKey)
            if (a && !bufEqual(a, b)) {
                // Identity changed — wipe session and update key atomically
                sessionReadCache.delete(addr)
                identityReadCache.set(addr, b)
                lidCache.delete(id)
                await keys.set({
                    session: { [addr]: null },
                    'identity-key': { [addr]: b }
                })
                return true
            }
            if (!a) {
                identityReadCache.set(addr, b)
                await keys.set({ 'identity-key': { [addr]: b } })
                return true
            }
            return false
        },

        wipeSession: async (addr) => {
            sessionReadCache.delete(addr)
            await keys.set({ session: { [addr]: null } })
        },

        // ── PreKeys ───────────────────────────────────────────────────────────────

        loadPreKey: async (id) => {
            const { [id.toString()]: key } = await keys.get('pre-key', [id.toString()])
            if (!key) return null
            return {
                pubKey: new Uint8Array(Buffer.from(key.public)),
                privKey: new Uint8Array(Buffer.from(key.private))
            }
        },

        removePreKey: (id) => keys.set({ 'pre-key': { [id]: null } }),

        loadSignedPreKey: (id) => {
            const key = creds.signedPreKey
            if (key.keyId !== id) {
                logger?.warn?.({ requested: id, current: key.keyId }, '[Signal] loadSignedPreKey id mismatch')
                return null
            }
            return {
                keyId: key.keyId,
                keyPair: {
                    pubKey: new Uint8Array(Buffer.from(key.keyPair.public)),
                    privKey: new Uint8Array(Buffer.from(key.keyPair.private))
                },
                signature: new Uint8Array(Buffer.from(key.signature))
            }
        },

        // ── Sender keys ───────────────────────────────────────────────────────────

        loadSenderKey: async (keyId) => {
            try {
                const id = keyId.toString()
                const { [id]: key } = await keys.get('sender-key', [id])
                return toU8(key) ?? null
            } catch (e) {
                logger?.error?.(`[Signal] loadSenderKey error: ${e.message}`)
                return null
            }
        },

        storeSenderKey: async (keyId, record) => {
            await keys.set({ 'sender-key': { [keyId.toString()]: Buffer.from(record) } })
        },

        // ── Own identity ──────────────────────────────────────────────────────────

        getOurRegistrationId: () => creds.registrationId,

        getOurIdentity: () => ({
            pubKey: new Uint8Array(generateSignalPubKey(Buffer.from(creds.signedIdentityKey.public))),
            privKey: new Uint8Array(Buffer.from(creds.signedIdentityKey.private))
        })
    }
}

export default makeLibSignalRepository