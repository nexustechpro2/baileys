import { Boom } from "@hapi/boom"
import { randomBytes } from "crypto"
import { URL } from "url"
import { promisify } from "util"
import { proto } from "../../WAProto/index.js"
import { DEF_CALLBACK_PREFIX, DEF_TAG_PREFIX, INITIAL_PREKEY_COUNT, MIN_PREKEY_COUNT, MIN_UPLOAD_INTERVAL, NOISE_WA_HEADER, UPLOAD_TIMEOUT, BATCH_SIZE } from "../Defaults/index.js"
import { DisconnectReason } from "../Types/index.js"
import { addTransactionCapability, aesEncryptCTR, bindWaitForConnectionUpdate, bytesToCrockford, configureSuccessfulPairing, Curve, derivePairingCodeKey, generateLoginNode, generateMdTagPrefix, generateRegistrationNode, getCodeFromWSError, getErrorCodeFromStreamError, getNextPreKeysNode, makeEventBuffer, makeNoiseHandler, promiseTimeout } from "../Utils/index.js"
import { getPlatformId, migrateIndexKey } from "../Utils/index.js"
import { assertNodeErrorFree, binaryNodeToString, encodeBinaryNode, getBinaryNodeChild, getBinaryNodeChildren, isLidUser, jidDecode, jidEncode, S_WHATSAPP_NET } from "../WABinary/index.js"
import { BinaryInfo } from "../WAM/BinaryInfo.js"
import { USyncQuery, USyncUser } from "../WAUSync/index.js"
import { WebSocketClient } from "./Client/index.js"

const CONSTANTS = {
  MAX_RECONNECT: 5,
  MAX_FAILED_PINGS: 6,
  HEALTH_CHECK_MULTIPLIER: 4
}

export const makeSocket = (config) => {
  const { waWebSocketUrl, connectTimeoutMs, logger, keepAliveIntervalMs, browser, auth: authState, printQRInTerminal, defaultQueryTimeoutMs, transactionOpts, qrTimeout, makeSignalRepository } = config

  if (printQRInTerminal) logger?.warn("printQRInTerminal deprecated")

  const url = typeof waWebSocketUrl === "string" ? new URL(waWebSocketUrl) : waWebSocketUrl
  if (config.mobile || url.protocol === "tcp:") throw new Boom("Mobile API not supported", { statusCode: DisconnectReason.loggedOut })
  if (url.protocol === "wss:" && authState?.creds?.routingInfo) url.searchParams.append("ED", authState.creds.routingInfo.toString("base64url"))

  const ephemeralKeyPair = Curve.generateKeyPair()
  const noise = makeNoiseHandler({ keyPair: ephemeralKeyPair, NOISE_HEADER: NOISE_WA_HEADER, logger, routingInfo: authState?.creds?.routingInfo })
  const ws = new WebSocketClient(url, config)

  logger.info({ url: url.toString() }, "Initiating WebSocket connection")
  ws.connect()

  const ev = makeEventBuffer(logger)
  const { creds } = authState
  const keys = addTransactionCapability(authState.keys, logger, transactionOpts)
  const signalRepository = makeSignalRepository({ creds, keys }, logger, pnFromLIDUSync)
  const publicWAMBuffer = new BinaryInfo()
  const uqTagId = generateMdTagPrefix()
  const sendPromise = promisify(ws.send)

  let epoch = 1
  let lastDateRecv
  let lastMessageTime = Date.now()
  let lastUploadTime = 0
  let reconnectAttempts = 0
  let consecutiveFailedPings = 0
  let closed = false
  let uploadPreKeysPromise = null
  let keepAliveReq
  let qrTimer
  let sessionHealthCheck

  const generateMessageTag = () => `${uqTagId}${epoch++}`

  const mapWebSocketError = (handler) => (error) => handler(new Boom(`WebSocket Error (${error?.message})`, { statusCode: getCodeFromWSError(error), data: error }))

  const sendRawMessage = async (data) => {
    if (!ws.isOpen) throw new Boom("Connection Closed", { statusCode: DisconnectReason.connectionClosed })
    const bytes = noise.encodeFrame(data)
    await promiseTimeout(connectTimeoutMs, async (resolve, reject) => {
      try { await sendPromise.call(ws, bytes); resolve() } catch (error) { reject(error) }
    })
  }

  const sendNode = (frame) => {
    if (logger.level === "trace") logger.trace({ xml: binaryNodeToString(frame), msg: "xml send" })
    return sendRawMessage(encodeBinaryNode(frame))
  }

  const waitForMessage = async (msgId, timeoutMs = defaultQueryTimeoutMs) => {
    let onRecv, onErr
    try {
      return await promiseTimeout(timeoutMs, (resolve, reject) => {
        onRecv = (data) => resolve(data)
        onErr = (err) => reject(err || new Boom("Connection Closed", { statusCode: DisconnectReason.connectionClosed }))
        ws.on(`TAG:${msgId}`, onRecv)
        ws.on("close", onErr)
        ws.on("error", onErr)
        return () => reject(new Boom("Query Cancelled"))
      })
    } catch (error) {
      if (error instanceof Boom && error.output?.statusCode === DisconnectReason.timedOut) { logger?.warn?.({ msgId }, "Timed out waiting for message"); return undefined }
      throw error
    } finally {
      if (onRecv) ws.off(`TAG:${msgId}`, onRecv)
      if (onErr) { ws.off("close", onErr); ws.off("error", onErr) }
    }
  }

  const query = async (node, timeoutMs) => {
    if (!node.attrs.id) node.attrs.id = generateMessageTag()
    const msgId = node.attrs.id
    for (let i = 0; i < 20; i++) {
      try {
        const result = await promiseTimeout(timeoutMs, async (resolve, reject) => {
          const result = waitForMessage(msgId, timeoutMs).catch(reject)
          sendNode(node).then(async () => resolve(await result)).catch(reject)
        })
        if (result && "tag" in result) assertNodeErrorFree(result)
        return result
      } catch (error) {
        if (error?.data === 429 || error?.isRateLimit) { await new Promise(r => setTimeout(r, 300 + Math.random() * 700)); continue }
        throw error
      }
    }
  }

  const executeUSyncQuery = async (usyncQuery) => {
    if (usyncQuery.protocols.length === 0) throw new Boom("USyncQuery must have at least one protocol")
    const userNodes = usyncQuery.users.map((user) => ({ tag: "user", attrs: { jid: !user.phone ? user.id : undefined }, content: usyncQuery.protocols.map((a) => a.getUserElement(user)).filter((a) => a !== null) }))
    const iq = { tag: "iq", attrs: { to: S_WHATSAPP_NET, type: "get", xmlns: "usync" }, content: [{ tag: "usync", attrs: { context: usyncQuery.context, mode: usyncQuery.mode, sid: generateMessageTag(), last: "true", index: "0" }, content: [{ tag: "query", attrs: {}, content: usyncQuery.protocols.map((a) => a.getQueryElement()) }, { tag: "list", attrs: {}, content: userNodes }] }] }
    return usyncQuery.parseUSyncQueryResult(await query(iq))
  }

  async function pnFromLIDUSync(jids) {
    const usyncQuery = new USyncQuery().withLIDProtocol().withContext("background")
    for (const jid of jids) {
      if (!isLidUser(jid)) usyncQuery.withUser(new USyncUser().withId(jid))
      else logger?.warn("LID user found in LID fetch call")
    }
    if (usyncQuery.users.length === 0) return []
    const results = await executeUSyncQuery(usyncQuery)
    return results ? results.list.filter((a) => !!a.lid).map(({ lid, id }) => ({ pn: id, lid })) : []
  }

  const onUnexpectedError = (err, msg) => { logger.error({ err }, `unexpected error in '${msg}'`) }

  const validateConnection = async () => {
    let helloMsg = proto.HandshakeMessage.fromObject({ clientHello: { ephemeral: ephemeralKeyPair.public } })
    logger.info({ browser, helloMsg }, "Connected to WhatsApp")
    const init = proto.HandshakeMessage.encode(helloMsg).finish()
    const result = await awaitNextMessage(init)
    const handshake = proto.HandshakeMessage.decode(result)
    logger.trace({ handshake }, "Handshake received from WhatsApp")
    const keyEnc = await noise.processHandshake(handshake, creds.noiseKey)
    const node = !creds.me ? generateRegistrationNode(creds, config) : generateLoginNode(creds.me.id, config)
    logger.info({ node }, !creds.me ? "Attempting registration..." : "Logging in...")
    const payloadEnc = noise.encrypt(proto.ClientPayload.encode(node).finish())
    await sendRawMessage(proto.HandshakeMessage.encode({ clientFinish: { static: keyEnc, payload: payloadEnc } }).finish())
    noise.finishInit()
    startKeepAliveRequest()
  }

  const awaitNextMessage = async (sendMsg) => {
    if (!ws.isOpen) throw new Boom("Connection Closed", { statusCode: DisconnectReason.connectionClosed })
    let onOpen, onClose
    const result = promiseTimeout(connectTimeoutMs, (resolve, reject) => {
      onOpen = resolve
      onClose = mapWebSocketError(reject)
      ws.on("frame", onOpen)
      ws.on("close", onClose)
      ws.on("error", onClose)
    }).finally(() => {
      ws.off("frame", onOpen)
      ws.off("close", onClose)
      ws.off("error", onClose)
    })
    if (sendMsg) sendRawMessage(sendMsg).catch(onClose)
    return result
  }

  const waitForSocketOpen = async () => {
    if (ws.isOpen) return
    if (ws.isClosed || ws.isClosing) throw new Boom("Connection Closed", { statusCode: DisconnectReason.connectionClosed })
    let onOpen, onClose
    await new Promise((resolve, reject) => {
      onOpen = () => resolve(undefined)
      onClose = mapWebSocketError(reject)
      ws.on("open", onOpen)
      ws.on("close", onClose)
      ws.on("error", onClose)
    }).finally(() => {
      ws.off("open", onOpen)
      ws.off("close", onClose)
      ws.off("error", onClose)
    })
  }

  const getAvailablePreKeysOnServer = async () => {
    const result = await query({ tag: "iq", attrs: { id: generateMessageTag(), xmlns: "encrypt", type: "get", to: S_WHATSAPP_NET }, content: [{ tag: "count", attrs: {} }] })
    return +getBinaryNodeChild(result, "count").attrs.value
  }

  const uploadPreKeys = async (count = MIN_PREKEY_COUNT, retryCount = 0) => {
    if (retryCount === 0 && Date.now() - lastUploadTime < MIN_UPLOAD_INTERVAL) { logger.debug(`Skipping upload, only ${Date.now() - lastUploadTime}ms since last`); return }
    if (uploadPreKeysPromise) { logger.debug("Pre-key upload in progress, waiting..."); await uploadPreKeysPromise; return }
    const uploadLogic = async () => {
      logger.info({ count, retryCount }, "Uploading pre-keys")
      const node = await keys.transaction(async () => {
        const { update, node } = await getNextPreKeysNode({ creds, keys }, count)
        ev.emit("creds.update", update)
        return node
      }, creds?.me?.id || "upload-pre-keys")
      try {
        await query(node)
        logger.info({ count }, "✅ Pre-keys uploaded successfully")
        lastUploadTime = Date.now()
      } catch (uploadError) {
        logger.error({ uploadError: uploadError.toString(), count }, "Failed to upload pre-keys")
        if (retryCount < 3) { const backoffDelay = Math.min(1000 * Math.pow(2, retryCount), 10000); logger.info(`Retrying pre-key upload in ${backoffDelay}ms`); await new Promise((resolve) => setTimeout(resolve, backoffDelay)); return uploadPreKeys(count, retryCount + 1) }
        throw uploadError
      }
    }
    uploadPreKeysPromise = Promise.race([uploadLogic(), new Promise((_, reject) => setTimeout(() => reject(new Boom("Pre-key upload timeout", { statusCode: 408 })), UPLOAD_TIMEOUT))])
    try { await uploadPreKeysPromise } finally { uploadPreKeysPromise = null }
  }

  const uploadPreKeysToServerIfRequired = async () => {
    try {
      const preKeyCount = await getAvailablePreKeysOnServer()
      logger.info(`${preKeyCount} pre-keys found on server`)
      if (preKeyCount < MIN_PREKEY_COUNT) { const uploadCount = INITIAL_PREKEY_COUNT - preKeyCount; logger.info(`Server pre-key count low (${preKeyCount}), uploading ${uploadCount}`); await uploadPreKeys(uploadCount) }
      else logger.info(`✅ PreKey validation passed - Server: ${preKeyCount} pre-keys`)
    } catch (error) { logger.error({ error }, "Failed to check/upload pre-keys during init") }
  }

  const onMessageReceived = (data) => {
    noise.decodeFrame(data, (frame) => {
      lastDateRecv = new Date()
      lastMessageTime = Date.now()
      reconnectAttempts = 0
      let anyTriggered = ws.emit("frame", frame)
      if (!(frame instanceof Uint8Array)) {
        const msgId = frame.attrs.id
        if (logger.level === "trace") logger.trace({ xml: binaryNodeToString(frame), msg: "recv xml" })
        anyTriggered = ws.emit(`${DEF_TAG_PREFIX}${msgId}`, frame) || anyTriggered
        const l0 = frame.tag
        const l1 = frame.attrs || {}
        const l2 = Array.isArray(frame.content) ? frame.content[0]?.tag : ""
        for (const key of Object.keys(l1)) {
          anyTriggered = ws.emit(`${DEF_CALLBACK_PREFIX}${l0},${key}:${l1[key]},${l2}`, frame) || anyTriggered
          anyTriggered = ws.emit(`${DEF_CALLBACK_PREFIX}${l0},${key}:${l1[key]}`, frame) || anyTriggered
          anyTriggered = ws.emit(`${DEF_CALLBACK_PREFIX}${l0},${key}`, frame) || anyTriggered
        }
        anyTriggered = ws.emit(`${DEF_CALLBACK_PREFIX}${l0},,${l2}`, frame) || anyTriggered
        anyTriggered = ws.emit(`${DEF_CALLBACK_PREFIX}${l0}`, frame) || anyTriggered
        if (!anyTriggered && logger.level === "debug") logger.debug({ unhandled: true, msgId, fromMe: false, frame }, "Unhandled communication received")
      }
    })
  }

  const end = (error) => {
    if (closed) { logger.trace({ trace: error?.stack }, "Connection already closed"); return }
    closed = true
    const shouldLogError = error && error.message !== "Connection Terminated"
    if (shouldLogError) logger.info({ trace: error?.stack }, "Connection errored")
    else logger.debug("Connection closed gracefully")
    clearInterval(keepAliveReq)
    clearInterval(sessionHealthCheck)
    clearTimeout(qrTimer)
    ws.removeAllListeners("close")
    ws.removeAllListeners("open")
    ws.removeAllListeners("message")
    if (!ws.isClosed && !ws.isClosing) { try { ws.close() } catch { } }
    if (shouldLogError || (error && error.output?.statusCode !== DisconnectReason.connectionClosed)) {
      ev.emit("connection.update", { connection: "close", lastDisconnect: { error, date: new Date() } })
    }
    ev.removeAllListeners("connection.update")
  }

  const attemptReconnection = async (reason = "unknown") => {
    if (closed) { logger.debug("Cannot reconnect - connection already closed"); return }
    if (reconnectAttempts >= CONSTANTS.MAX_RECONNECT) { logger.error({ attempts: reconnectAttempts, maxAttempts: CONSTANTS.MAX_RECONNECT }, "Max reconnection attempts reached"); end(new Boom("Connection Lost", { statusCode: DisconnectReason.connectionLost })); return }
    reconnectAttempts++
    const isNetworkIssue = reason === "websocket-close"
    const baseDelay = isNetworkIssue ? 2000 : 1000
    const backoffDelay = Math.min(baseDelay * Math.pow(2, reconnectAttempts - 1), 30000)
    logger.info({ attempt: reconnectAttempts, maxAttempts: CONSTANTS.MAX_RECONNECT, delay: backoffDelay, reason }, "Attempting WebSocket reconnection")
    try {
      await new Promise(resolve => setTimeout(resolve, backoffDelay))
      await ws.restart()
      logger.info("✅ WebSocket reconnected successfully")
      reconnectAttempts = 0
      consecutiveFailedPings = 0
      startSessionHealthMonitor()
    } catch (err) {
      logger.error({ err, attempt: reconnectAttempts }, "Reconnection attempt failed")
      if (reconnectAttempts < CONSTANTS.MAX_RECONNECT) return attemptReconnection(reason)
      end(new Boom("Failed to reconnect", { statusCode: DisconnectReason.connectionLost }))
    }
  }

  const startKeepAliveRequest = () => {
    keepAliveReq = setInterval(async () => {
      if (!lastDateRecv) lastDateRecv = new Date()
      if (ws.isOpen) {
        try {
          await query({ tag: "iq", attrs: { id: generateMessageTag(), to: S_WHATSAPP_NET, type: "get", xmlns: "w:p" }, content: [{ tag: "ping", attrs: {} }] })
          consecutiveFailedPings = 0
          logger.trace("Keep-alive ping successful")
        } catch (err) {
          consecutiveFailedPings++
          logger.warn({ consecutiveFailures: consecutiveFailedPings, maxAllowed: CONSTANTS.MAX_FAILED_PINGS }, "Keep-alive ping failed")
          if (consecutiveFailedPings >= CONSTANTS.MAX_FAILED_PINGS) { logger.error("Multiple consecutive ping failures - connection lost"); end(new Boom("Connection was lost", { statusCode: DisconnectReason.connectionLost })) }
        }
      } else {
        logger.warn("Keep-alive called when WebSocket not open")
        if (!closed && ws.isClosed) { ws.restart().catch(err => { logger.error({ err }, "Failed to restart WebSocket from keep-alive"); end(new Boom("Connection Lost", { statusCode: DisconnectReason.connectionLost })) }) }
      }
    }, keepAliveIntervalMs)
  }

  const startSessionHealthMonitor = () => {
    sessionHealthCheck = setInterval(() => {
      const timeSinceLastMsg = Date.now() - lastMessageTime
      const healthCheckIntervalMs = keepAliveIntervalMs * CONSTANTS.HEALTH_CHECK_MULTIPLIER
      if (timeSinceLastMsg > healthCheckIntervalMs) {
        if (ws.isOpen) logger.warn({ timeSinceLastMsg, threshold: healthCheckIntervalMs }, "Extended inactivity detected")
        else { logger.error({ timeSinceLastMsg }, "WebSocket closed during extended inactivity - reconnecting"); attemptReconnection("health-check-failed").catch(err => logger.error({ err }, "Health check reconnection failed")) }
      }
    }, keepAliveIntervalMs * CONSTANTS.HEALTH_CHECK_MULTIPLIER)
  }

  const sendPassiveIq = (tag) => query({ tag: "iq", attrs: { to: S_WHATSAPP_NET, xmlns: "passive", type: "set" }, content: [{ tag, attrs: {} }] })

  const logout = async (msg) => {
    const jid = authState.creds.me?.id
    if (jid) await sendNode({ tag: "iq", attrs: { to: S_WHATSAPP_NET, type: "set", id: generateMessageTag(), xmlns: "md" }, content: [{ tag: "remove-companion-device", attrs: { jid, reason: "user_initiated" } }] })
    end(new Boom(msg || "Intentional Logout", { statusCode: DisconnectReason.loggedOut }))
  }

  const requestPairingCode = async (phoneNumber, customPairingCode) => {
    await waitForSocketOpen()
    await new Promise(resolve => setTimeout(resolve, 500))
    const pairingCode = customPairingCode ?? bytesToCrockford(randomBytes(5))
    if (customPairingCode && customPairingCode?.length !== 8) throw new Error("Custom pairing code must be exactly 8 chars")
    authState.creds.pairingCode = pairingCode
    authState.creds.me = { id: jidEncode(phoneNumber, "s.whatsapp.net"), name: "~" }
    ev.emit("creds.update", authState.creds)
    await sendNode({ tag: "iq", attrs: { to: S_WHATSAPP_NET, type: "set", id: generateMessageTag(), xmlns: "md" }, content: [{ tag: "link_code_companion_reg", attrs: { jid: authState.creds.me.id, stage: "companion_hello", should_show_push_notification: "true" }, content: [{ tag: "link_code_pairing_wrapped_companion_ephemeral_pub", attrs: {}, content: await generatePairingKey() }, { tag: "companion_server_auth_key_pub", attrs: {}, content: authState.creds.noiseKey.public }, { tag: "companion_platform_id", attrs: {}, content: getPlatformId(browser[1]) }, { tag: "companion_platform_display", attrs: {}, content: `${browser[1]} (${browser[0]})` }, { tag: "link_code_pairing_nonce", attrs: {}, content: "0" }] }] })
    return authState.creds.pairingCode
  }

  async function generatePairingKey() {
    const salt = randomBytes(32)
    const randomIv = randomBytes(16)
    const key = await derivePairingCodeKey(authState.creds.pairingCode, salt)
    const ciphered = aesEncryptCTR(authState.creds.pairingEphemeralKeyPair.public, key, randomIv)
    return Buffer.concat([salt, randomIv, ciphered])
  }

  const sendWAMBuffer = (wamBuffer) => query({ tag: "iq", attrs: { to: S_WHATSAPP_NET, id: generateMessageTag(), xmlns: "w:stats" }, content: [{ tag: "add", attrs: { t: Math.round(Date.now() / 1000) + "" }, content: wamBuffer }] })

  ws.on("message", onMessageReceived)

  ws.on("open", async () => {
    try { await validateConnection() } catch (err) { logger.error({ err }, "Error in validating connection"); end(err) }
  })

  ws.on("error", (err) => {
    const isNetworkError = err?.code === "ENOTFOUND" || err?.code === "ECONNRESET" || err?.code === "ETIMEDOUT" || err?.code === "ECONNREFUSED"
    logger.warn({ message: err?.message, code: err?.code }, "WebSocket error occurred")
    if (isNetworkError && !closed) attemptReconnection("websocket-error").catch(err => logger.error({ err }, "Reconnection attempt failed after WebSocket error"))
  })

  ws.on("close", (code, reason) => {
    const closeReason = reason?.toString() || "Unknown"
    logger.debug({ code, reason: closeReason }, "WebSocket closed")
    if (!closed) {
      const delayMs = code === 1000 ? 1000 : 2000
      setTimeout(() => {
        attemptReconnection("websocket-close").catch(err => { logger.error({ err, code, reason: closeReason }, "Reconnection failed"); end(new Boom("Connection Terminated", { statusCode: DisconnectReason.connectionClosed })) })
      }, delayMs)
    }
  })

  ws.on("CB:xmlstreamend", () => { logger.info("Stream ended by server"); if (!closed) end(new Boom("Connection Terminated by Server", { statusCode: DisconnectReason.connectionClosed })) })

  ws.on("CB:iq,type:set,pair-device", async (stanza) => {
    await sendNode({ tag: "iq", attrs: { to: S_WHATSAPP_NET, type: "result", id: stanza.attrs.id } })
    const pairDeviceNode = getBinaryNodeChild(stanza, "pair-device")
    const refNodes = getBinaryNodeChildren(pairDeviceNode, "ref")
    const noiseKeyB64 = Buffer.from(creds.noiseKey.public).toString("base64")
    const identityKeyB64 = Buffer.from(creds.signedIdentityKey.public).toString("base64")
    const advB64 = creds.advSecretKey
    let qrMs = qrTimeout || 60000
    const genPairQR = () => {
      if (!ws.isOpen) return
      const refNode = refNodes.shift()
      if (!refNode) { end(new Boom("QR refs attempts ended", { statusCode: DisconnectReason.timedOut })); return }
      const ref = refNode.content.toString("utf-8")
      const qr = [ref, noiseKeyB64, identityKeyB64, advB64].join(",")
      ev.emit("connection.update", { qr })
      qrTimer = setTimeout(genPairQR, qrMs)
      qrMs = qrTimeout || 20000
    }
    genPairQR()
  })

  ws.on("CB:iq,,pair-success", async (stanza) => {
    logger.debug("Pair success received")
    try {
      const { reply, creds: updatedCreds } = configureSuccessfulPairing(stanza, creds)
      logger.info({ me: updatedCreds.me, platform: updatedCreds.platform }, "Pairing configured successfully")
      ev.emit("creds.update", updatedCreds)
      ev.emit("connection.update", { isNewLogin: true, qr: undefined })
      await sendNode(reply)
    } catch (error) { logger.info({ trace: error.stack }, "Error in pairing"); end(error) }
  })

  ws.on("CB:success", async (node) => {
    try {
      await uploadPreKeysToServerIfRequired()
      // Detect pre-key pool depletion and force upload
      if (creds.nextPreKeyId && creds.firstUnuploadedPreKeyId && creds.nextPreKeyId === creds.firstUnuploadedPreKeyId) {
        logger.warn({ nextPreKeyId: creds.nextPreKeyId }, "Pre-key pool depleted, forcing upload")
        await uploadPreKeys(INITIAL_PREKEY_COUNT)
      }
      await sendPassiveIq("active")
    } catch (err) { logger.warn({ err }, "Failed to send initial passive IQ") }
    logger.info("✅ Opened connection to WhatsApp")
    clearTimeout(qrTimer)
    ev.emit("creds.update", { me: { ...authState.creds.me, lid: node.attrs.lid } })
    ev.emit("connection.update", { connection: "open" })
    startSessionHealthMonitor()
    reconnectAttempts = 0
    if (node.attrs.lid && authState.creds.me?.id) {
      const myLID = node.attrs.lid
      process.nextTick(async () => {
        try {
          const myPN = authState.creds.me.id
          await signalRepository.lidMapping.storeLIDPNMappings([{ lid: myLID, pn: myPN }])
          const { user, device } = jidDecode(myPN)
          // CB:success handler
          const currentBatch = await migrateIndexKey(authState.keys, 'device-list')
          currentBatch[user] = [device?.toString() || '0']
          const deviceKeys = Object.keys(currentBatch)
          if (deviceKeys.length > BATCH_SIZE) {
            deviceKeys.sort()
            deviceKeys.slice(0, deviceKeys.length - BATCH_SIZE).forEach(k => delete currentBatch[k])
          }
          await authState.keys.set({ 'device-list': { 'index': currentBatch } })
          await signalRepository.migrateSession(myPN, myLID)
          logger.info({ myPN, myLID }, "Own LID session created successfully")

          // Batch-migrate all known PN sessions to LID on connect
          if (signalRepository.migrateAllPNSessionsToLID) {
            try {
              const migrated = await signalRepository.migrateAllPNSessionsToLID()
              if (migrated > 0) logger.info({ migrated }, "Batch-migrated PN sessions to LID on connect")
            } catch (migErr) { logger.warn({ error: migErr }, "Failed to batch-migrate PN sessions to LID") }
          }
        } catch (error) { logger.error({ error, lid: myLID }, "Failed to create own LID session") }
      })
    }
  })

  ws.on("CB:stream:error", (node) => {
    logger.error({ node }, "Stream errored out")
    const { reason, statusCode } = getErrorCodeFromStreamError(node)
    end(new Boom(`Stream Errored (${reason})`, { statusCode, data: node }))
  })

  ws.on("CB:failure", (node) => { const reason = +(node.attrs.reason || 500); end(new Boom("Connection Failure", { statusCode: reason, data: node.attrs })) })

  ws.on("CB:ib,,downgrade_webclient", () => end(new Boom("Multi-device beta not joined", { statusCode: DisconnectReason.multideviceMismatch })))

  ws.on("CB:ib,,offline_preview", (node) => {
    logger.info("Offline preview received", JSON.stringify(node))
    sendNode({ tag: "ib", attrs: {}, content: [{ tag: "offline_batch", attrs: { count: "100" } }] })
  })

  ws.on("CB:ib,,edge_routing", (node) => {
    const edgeRoutingNode = getBinaryNodeChild(node, "edge_routing")
    const routingInfo = getBinaryNodeChild(edgeRoutingNode, "routing_info")
    if (routingInfo?.content) { authState.creds.routingInfo = Buffer.from(routingInfo?.content); ev.emit("creds.update", authState.creds) }
  })

  let didStartBuffer = false
  process.nextTick(() => {
    if (creds.me?.id) { ev.buffer(); didStartBuffer = true }
    ev.emit("connection.update", { connection: "connecting", receivedPendingNotifications: false, qr: undefined })
  })

  ws.on("CB:ib,,offline", (node) => {
    const child = getBinaryNodeChild(node, "offline")
    const offlineNotifs = +(child?.attrs.count || 0)
    logger.info(`Handled ${offlineNotifs} offline messages/notifications`)
    if (didStartBuffer) { ev.flush(); logger.trace("Flushed events for initial buffer") }
    ev.emit("connection.update", { receivedPendingNotifications: true })
  })

  ev.on("creds.update", (update) => {
    const name = update.me?.name
    if (creds.me?.name !== name) { logger.debug({ name }, "Updated pushName"); sendNode({ tag: "presence", attrs: { name } }).catch((err) => logger.warn({ trace: err.stack }, "Error in sending presence update on name change")) }
    Object.assign(creds, update)
  })

  return {
    type: "md",
    ws,
    ev,
    authState: { creds, keys },
    signalRepository,
    get user() { return authState.creds.me },
    generateMessageTag,
    query,
    waitForMessage,
    waitForSocketOpen,
    sendRawMessage,
    sendNode,
    logout,
    end,
    onUnexpectedError,
    uploadPreKeys,
    uploadPreKeysToServerIfRequired,
    requestPairingCode,
    wamBuffer: publicWAMBuffer,
    waitForConnectionUpdate: bindWaitForConnectionUpdate(ev),
    sendWAMBuffer,
    executeUSyncQuery,
    listener: (eventName) => {
      if (typeof ev.listenerCount === "function") return ev.listenerCount(eventName)
      if (typeof ev.listener === "function") return ev.listener(eventName)?.length || 0
      return 0
    }
  }
}