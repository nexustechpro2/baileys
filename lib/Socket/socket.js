import { Boom } from '@hapi/boom'
import { randomBytes } from 'crypto'
import { URL } from 'url'
import { promisify } from 'util'
import { proto } from '../../WAProto/index.js'
import {
  DEF_CALLBACK_PREFIX,
  DEF_TAG_PREFIX,
  INITIAL_PREKEY_COUNT,
  MIN_PREKEY_COUNT,
  MIN_UPLOAD_INTERVAL,
  NOISE_WA_HEADER,
  UPLOAD_TIMEOUT,
  BATCH_SIZE,
  TimeMs
} from '../Defaults/index.js'
import { QueryIds, ReachoutTimelockEnforcementType } from '../Types/index.js'
import { DisconnectReason, XWAPaths } from '../Types/index.js'
import {
  addTransactionCapability,
  aesEncryptCTR,
  bindWaitForConnectionUpdate,
  buildPairingQRData,
  bytesToCrockford,
  configureSuccessfulPairing,
  Curve,
  derivePairingCodeKey,
  generateLoginNode,
  generateMdTagPrefix,
  generateRegistrationNode,
  getCodeFromWSError,
  getCompanionPlatformId,
  getErrorCodeFromStreamError,
  getNextPreKeysNode,
  makeEventBuffer,
  makeNoiseHandler,
  promiseTimeout,
  signedKeyPair,
  xmppSignedPreKey,
  getPlatformId,
  isAndroidBrowser
} from '../Utils/index.js'
import {
  assertNodeErrorFree,
  binaryNodeToString,
  encodeBinaryNode,
  getAllBinaryNodeChildren,
  getBinaryNodeChild,
  getBinaryNodeChildren,
  isLidUser,
  jidDecode,
  jidEncode,
  S_WHATSAPP_NET
} from '../WABinary/index.js'
import { BinaryInfo } from '../WAM/BinaryInfo.js'
import { USyncQuery, USyncUser } from '../WAUSync/index.js'
import { WebSocketClient } from './Client/index.js'
import { executeWMexQuery } from './mex.js'

// ─── Module-scope helpers ──────────────────────────────────────────────────────

/**
 * Map a raw WebSocket error into a Boom so callers
 * can inspect the statusCode / DisconnectReason.
 */
const mapWebSocketError = (handler) => (error) =>
  handler(
    new Boom(`WebSocket Error (${error?.message})`, {
      statusCode: getCodeFromWSError(error),
      data: error
    })
  )

// ─── Factory ──────────────────────────────────────────────────────────────────

export const makeSocket = (config) => {
  const {
    waWebSocketUrl,
    connectTimeoutMs,
    logger,
    keepAliveIntervalMs,
    browser,
    auth: authState,
    printQRInTerminal,
    defaultQueryTimeoutMs,
    transactionOpts,
    qrTimeout,
    makeSignalRepository
  } = config



  const url = typeof waWebSocketUrl === 'string' ? new URL(waWebSocketUrl) : waWebSocketUrl

  if (config.mobile || url.protocol === 'tcp:')
    throw new Boom('Mobile API not supported', { statusCode: DisconnectReason.loggedOut })

  if (url.protocol === 'wss:' && authState?.creds?.routingInfo)
    url.searchParams.append('ED', authState.creds.routingInfo.toString('base64url'))

  const ephemeralKeyPair = Curve.generateKeyPair()
  const noise = makeNoiseHandler({
    keyPair: ephemeralKeyPair,
    NOISE_HEADER: NOISE_WA_HEADER,
    logger,
    routingInfo: authState?.creds?.routingInfo
  })

  const ws = new WebSocketClient(url, config)
  logger.info({ url: url.toString() }, 'Initiating WebSocket connection')
  ws.connect()

  if (printQRInTerminal) {
    import('qrcode-terminal').then(({ default: qrcode }) => {
      ev.on('connection.update', ({ qr }) => {
        if (qr) qrcode.generate(qr, { small: true })
      })
    })
  }

  if (browser[1].toLocaleLowerCase().includes('android')) {
    logger.warn(
      '⚠️ Using the Android browser is experimental and may lead to unexpected behavior. Use at your own risk.'
    )
  }

  const ev = makeEventBuffer(logger)
  const { creds } = authState
  const keys = addTransactionCapability(authState.keys, logger, transactionOpts)
  const signalRepository = makeSignalRepository({ creds, keys }, logger, pnFromLIDUSync)
  const publicWAMBuffer = new BinaryInfo()
  const uqTagId = generateMdTagPrefix()
  const sendPromise = promisify(ws.send)

  // State
  let epoch = 1
  let lastDateRecv
  let lastUploadTime = 0
  let uploadPreKeysPromise = null
  let closed = false
  let keepAliveReq
  let qrTimer
  let serverTimeOffsetMs = 0
  let didStartBuffer = false

  /** Socket end handlers — registered via registerSocketEndHandler() */
  const socketEndHandlers = []

  const generateMessageTag = () => `${uqTagId}${epoch++}`

  // ─── Transport ──────────────────────────────────────────────────────────────

  const sendRawMessage = async (data) => {
    if (!ws.isOpen)
      throw new Boom('Connection Closed', { statusCode: DisconnectReason.connectionClosed })
    const bytes = noise.encodeFrame(data)
    await promiseTimeout(connectTimeoutMs, async (resolve, reject) => {
      try { await sendPromise.call(ws, bytes); resolve() }
      catch (error) { reject(error) }
    })
  }

  const sendNode = (frame) => {
    if (logger.level === 'trace') logger.trace({ xml: binaryNodeToString(frame), msg: 'xml send' })
    return sendRawMessage(encodeBinaryNode(frame))
  }

  // ─── Query / messaging ──────────────────────────────────────────────────────

  const waitForMessage = async (msgId, timeoutMs = defaultQueryTimeoutMs) => {
    let onRecv, onErr
    try {
      return await promiseTimeout(timeoutMs, (resolve, reject) => {
        onRecv = (data) => resolve(data)
        onErr = (err) =>
          reject(err || new Boom('Connection Closed', { statusCode: DisconnectReason.connectionClosed }))
        ws.on(`TAG:${msgId}`, onRecv)
        ws.on('close', onErr)
        ws.on('error', onErr)
        return () => reject(new Boom('Query Cancelled'))
      })
    } catch (error) {
      if (error instanceof Boom && error.output?.statusCode === DisconnectReason.timedOut) {
        logger?.warn?.({ msgId }, 'timed out waiting for message')
        return undefined
      }
      throw error
    } finally {
      if (onRecv) ws.off(`TAG:${msgId}`, onRecv)
      if (onErr) { ws.off('close', onErr); ws.off('error', onErr) }
    }
  }

  const query = async (node, timeoutMs) => {
    if (!node.attrs.id) node.attrs.id = generateMessageTag()
    const msgId = node.attrs.id
    const result = await promiseTimeout(timeoutMs, async (resolve, reject) => {
      const result = waitForMessage(msgId, timeoutMs).catch(reject)
      sendNode(node).then(async () => resolve(await result)).catch(reject)
    })
    if (result && 'tag' in result) assertNodeErrorFree(result)
    return result
  }

  // ─── USync ──────────────────────────────────────────────────────────────────

  const executeUSyncQuery = async (usyncQuery) => {
    if (usyncQuery.protocols.length === 0)
      throw new Boom('USyncQuery must have at least one protocol')
    const userNodes = usyncQuery.users.map((user) => ({
      tag: 'user',
      attrs: Object.fromEntries(
        Object.entries({
          jid: !user.phone && !user.username ? user.id : undefined
        }).filter(([, v]) => v !== undefined)
      ),
      content: usyncQuery.protocols.map((a) => a.getUserElement(user)).filter((a) => a !== null)
    }))
    const iq = {
      tag: 'iq',
      attrs: { to: S_WHATSAPP_NET, type: 'get', xmlns: 'usync' },
      content: [{
        tag: 'usync',
        attrs: {
          context: usyncQuery.context,
          mode: usyncQuery.mode,
          sid: generateMessageTag(),
          last: 'true',
          index: '0'
        },
        content: [
          { tag: 'query', attrs: {}, content: usyncQuery.protocols.map((a) => a.getQueryElement()) },
          { tag: 'list', attrs: {}, content: userNodes }
        ]
      }]
    }
    return usyncQuery.parseUSyncQueryResult(await query(iq))
  }

  async function pnFromLIDUSync(jids) {
    const usyncQuery = new USyncQuery().withLIDProtocol().withContext('background')
    for (const jid of jids) {
      if (isLidUser(jid)) { logger?.warn('LID user found in LID fetch call'); continue }
      usyncQuery.withUser(new USyncUser().withId(jid))
    }
    if (usyncQuery.users.length === 0) return []
    const results = await executeUSyncQuery(usyncQuery)
    return results ? results.list.filter((a) => !!a.lid).map(({ lid, id }) => ({ pn: id, lid })) : []
  }

  const onWhatsApp = async (...phoneNumbers) => {
    let usyncQuery = new USyncQuery()
    let contactEnabled = false
    for (let jid of phoneNumbers) {
      if (isLidUser(jid)) {
        const pn = await signalRepository.lidMapping.getPNForLID(jid)
        if (pn) {
          jid = pn
        } else {
          if (!contactEnabled) { contactEnabled = true; usyncQuery = usyncQuery.withContactProtocol() }
          usyncQuery.withUser(new USyncUser().withId(jid))
          continue
        }
      }
      if (!contactEnabled) { contactEnabled = true; usyncQuery = usyncQuery.withContactProtocol() }
      const phone = `+${jid.replace('+', '').split('@')[0]?.split(':')[0]}`
      usyncQuery.withUser(new USyncUser().withPhone(phone))
    }
    if (usyncQuery.users.length === 0) return []
    const results = await executeUSyncQuery(usyncQuery)
    return results
      ? results.list.filter((a) => !!a.contact && a.id && a.id !== 'undefined').map(({ contact, id }) => ({ jid: id, exists: contact }))
      : []
  }

  // ─── Pre-keys ───────────────────────────────────────────────────────────────

  const getAvailablePreKeysOnServer = async () => {
    const result = await query({
      tag: 'iq',
      attrs: { id: generateMessageTag(), xmlns: 'encrypt', type: 'get', to: S_WHATSAPP_NET },
      content: [{ tag: 'count', attrs: {} }]
    })
    return +getBinaryNodeChild(result, 'count').attrs.value
  }

  /**
   * Verify that our current pre-key actually exists in local key storage.
   * Catches the case where the server still has keys but our local store is missing them.
   */
  const verifyCurrentPreKeyExists = async () => {
    const currentPreKeyId = creds.nextPreKeyId - 1
    if (currentPreKeyId <= 0) return { exists: false, currentPreKeyId: 0 }
    const preKeys = await keys.get('pre-key', [currentPreKeyId.toString()])
    return { exists: !!preKeys[currentPreKeyId.toString()], currentPreKeyId }
  }

  const uploadPreKeys = async (count = MIN_PREKEY_COUNT, retryCount = 0) => {
    // Rate-limit guard — only on the first attempt, not retries
    if (retryCount === 0 && Date.now() - lastUploadTime < MIN_UPLOAD_INTERVAL) {
      logger.debug(`Skipping upload — only ${Date.now() - lastUploadTime}ms since last upload`)
      return
    }
    // Dedup: if an upload is already in-flight, wait for it
    if (uploadPreKeysPromise) {
      logger.debug('Pre-key upload in progress, waiting...')
      await uploadPreKeysPromise
      return
    }
    const uploadLogic = async () => {
      logger.info({ count, retryCount }, 'Uploading pre-keys')
      // Generate keys inside a transaction to prevent ID collisions on retry
      const node = await keys.transaction(async () => {
        const { update, node } = await getNextPreKeysNode({ creds, keys }, count)
        ev.emit('creds.update', update)
        return node
      }, creds?.me?.id || 'upload-pre-keys')
      try {
        await query(node)
        logger.info({ count }, '✅ Pre-keys uploaded successfully')
        lastUploadTime = Date.now()
      } catch (uploadError) {
        logger.error({ uploadError: uploadError.toString(), count }, 'Failed to upload pre-keys')
        if (retryCount < 3) {
          const backoffDelay = Math.min(1000 * Math.pow(2, retryCount), 10000)
          logger.info(`Retrying pre-key upload in ${backoffDelay}ms`)
          await new Promise((resolve) => setTimeout(resolve, backoffDelay))
          return uploadPreKeys(count, retryCount + 1)
        }
        throw uploadError
      }
    }
    uploadPreKeysPromise = Promise.race([
      uploadLogic(),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Boom('Pre-key upload timeout', { statusCode: 408 })), UPLOAD_TIMEOUT)
      )
    ])
    try { await uploadPreKeysPromise } finally { uploadPreKeysPromise = null }
  }

  const uploadPreKeysToServerIfRequired = async () => {
    try {
      const preKeyCount = await getAvailablePreKeysOnServer()
      logger.info(`${preKeyCount} pre-keys found on server`)
      const { exists: currentPreKeyExists, currentPreKeyId } = await verifyCurrentPreKeyExists()
      logger.info(`Current prekey ID: ${currentPreKeyId}, exists in storage: ${currentPreKeyExists}`)
      const lowServerCount = preKeyCount <= MIN_PREKEY_COUNT
      const missingCurrentPreKey = !currentPreKeyExists && currentPreKeyId > 0
      if (lowServerCount || missingCurrentPreKey) {
        const reasons = []
        if (lowServerCount) reasons.push(`server count low (${preKeyCount})`)
        if (missingCurrentPreKey) reasons.push(`current prekey ${currentPreKeyId} missing from storage`)
        logger.info(`Uploading PreKeys due to: ${reasons.join(', ')}`)
        const uploadCount = preKeyCount === 0 ? INITIAL_PREKEY_COUNT : MIN_PREKEY_COUNT
        await uploadPreKeys(uploadCount)
      } else {
        logger.info(`✅ PreKey validation passed — Server: ${preKeyCount}, prekey ${currentPreKeyId} exists`)
      }
    } catch (error) {
      logger.error({ error }, 'Failed to check/upload pre-keys during init')
      // Non-fatal — allow connection to continue
    }
  }

  // ─── Key-bundle digest & signed pre-key rotation ────────────────────────────

  /**
   * Validate our current key-bundle against the server.
   * If the server returns no digest node our keys are out of sync —
   * force a pre-key upload and surface the error so the caller can decide.
   */
  const digestKeyBundle = async () => {
    const res = await query({
      tag: 'iq',
      attrs: { to: S_WHATSAPP_NET, type: 'get', xmlns: 'encrypt' },
      content: [{ tag: 'digest', attrs: {} }]
    })
    const digestNode = getBinaryNodeChild(res, 'digest')
    if (!digestNode) {
      await uploadPreKeys()
      throw new Error('encrypt/get digest returned no digest node')
    }
  }

  /**
   * Rotate our signed pre-key on the server.
   * Should be called periodically (e.g. every 7 days) to keep sessions healthy.
   */
  const rotateSignedPreKey = async () => {
    const newId = (creds.signedPreKey.keyId || 0) + 1
    const skey = await signedKeyPair(creds.signedIdentityKey, newId)
    await query({
      tag: 'iq',
      attrs: { to: S_WHATSAPP_NET, type: 'set', xmlns: 'encrypt' },
      content: [{ tag: 'rotate', attrs: {}, content: [xmppSignedPreKey(skey)] }]
    })
    ev.emit('creds.update', { signedPreKey: skey })
  }

  // ─── Server time offset ─────────────────────────────────────────────────────

  const updateServerTimeOffset = ({ attrs }) => {
    const tValue = attrs?.t
    if (!tValue) return
    const parsed = Number(tValue)
    if (Number.isNaN(parsed) || parsed <= 0) return
    serverTimeOffsetMs = parsed * 1000 - Date.now()
    logger.debug({ offset: serverTimeOffsetMs }, 'Calculated server time offset')
  }

  // ─── Unified session telemetry ───────────────────────────────────────────────

  const getUnifiedSessionId = () => {
    const offsetMs = 3 * TimeMs.Day
    const now = Date.now() + serverTimeOffsetMs
    return ((now + offsetMs) % TimeMs.Week).toString()
  }

  const sendUnifiedSession = async () => {
    if (!ws.isOpen) return
    try {
      await sendNode({
        tag: 'ib',
        attrs: {},
        content: [{ tag: 'unified_session', attrs: { id: getUnifiedSessionId() } }]
      })
    } catch (error) {
      logger.debug({ error }, 'Failed to send unified_session telemetry')
    }
  }

  // ─── WAM buffer ─────────────────────────────────────────────────────────────

  const sendWAMBuffer = (wamBuffer) =>
    query({
      tag: 'iq',
      attrs: { to: S_WHATSAPP_NET, id: generateMessageTag(), xmlns: 'w:stats' },
      content: [{ tag: 'add', attrs: { t: Math.round(Date.now() / 1000) + '' }, content: wamBuffer }]
    })

  // ─── WMex queries ────────────────────────────────────────────────────────────

  /**
   * Fetches account restriction / reachout timelock status.
   */
  const fetchAccountReachoutTimelock = async () => {
    const queryResult = await executeWMexQuery(
      {},
      QueryIds.REACHOUT_TIMELOCK,
      XWAPaths.xwa2_fetch_account_reachout_timelock,
      query,
      generateMessageTag
    )
    const result = {
      isActive: !!queryResult?.is_active,
      timeEnforcementEnds:
        queryResult?.time_enforcement_ends && queryResult.time_enforcement_ends !== '0'
          ? new Date(parseInt(queryResult.time_enforcement_ends, 10) * 1000)
          : undefined,
      enforcementType: queryResult?.enforcement_type ?? ReachoutTimelockEnforcementType.DEFAULT
    }
    ev.emit('connection.update', { reachoutTimeLock: result })
    return result
  }

  /**
   * Fetches new-chat message cap quota and usage.
   */
  const fetchNewChatMessageCap = async () =>
    executeWMexQuery(
      { input: { type: 'INDIVIDUAL_NEW_CHAT_MSG' } },
      QueryIds.MESSAGE_CAPPING_INFO,
      XWAPaths.xwa2_message_capping_info,
      query,
      generateMessageTag
    )

  // ─── Connection lifecycle ────────────────────────────────────────────────────

  const onUnexpectedError = (err, msg) => {
    const isClosed = err?.message?.includes('Connection Closed') || err?.output?.statusCode === 428
    if (isClosed) {
      logger.debug({ msg: err?.message }, `Connection closed during '${msg}'`)
    } else {
      logger.error({ err }, `unexpected error in '${msg}'`)
    }
  }

  const awaitNextMessage = async (sendMsg) => {
    if (!ws.isOpen)
      throw new Boom('Connection Closed', { statusCode: DisconnectReason.connectionClosed })
    let onOpen, onClose
    const result = promiseTimeout(connectTimeoutMs, (resolve, reject) => {
      onOpen = resolve
      onClose = mapWebSocketError(reject)
      ws.on('frame', onOpen)
      ws.on('close', onClose)
      ws.on('error', onClose)
    }).finally(() => {
      ws.off('frame', onOpen)
      ws.off('close', onClose)
      ws.off('error', onClose)
    })
    if (sendMsg) sendRawMessage(sendMsg).catch(onClose)
    return result
  }

  const validateConnection = async () => {
    const helloMsg = proto.HandshakeMessage.fromObject({ clientHello: { ephemeral: ephemeralKeyPair.public } })
    logger.info({ browser, helloMsg }, 'Connected to WhatsApp')
    const init = proto.HandshakeMessage.encode(helloMsg).finish()
    const result = await awaitNextMessage(init)
    const handshake = proto.HandshakeMessage.decode(result)
    logger.trace({ handshake }, 'Handshake received from WhatsApp')
    const keyEnc = await noise.processHandshake(handshake, creds.noiseKey)
    const node = !creds.me ? generateRegistrationNode(creds, config) : generateLoginNode(creds.me.id, config)
    logger.info({ node }, !creds.me ? 'Attempting registration...' : 'Logging in...')
    const payloadEnc = noise.encrypt(proto.ClientPayload.encode(node).finish())
    await sendRawMessage(
      proto.HandshakeMessage.encode({ clientFinish: { static: keyEnc, payload: payloadEnc } }).finish()
    )
    await noise.finishInit()
    startKeepAliveRequest()
  }

  const waitForSocketOpen = async () => {
    if (ws.isOpen) return
    if (ws.isClosed || ws.isClosing)
      throw new Boom('Connection Closed', { statusCode: DisconnectReason.connectionClosed })
    let onOpen, onClose
    await new Promise((resolve, reject) => {
      onOpen = () => resolve(undefined)
      onClose = mapWebSocketError(reject)
      ws.on('open', onOpen)
      ws.on('close', onClose)
      ws.on('error', onClose)
    }).finally(() => {
      ws.off('open', onOpen)
      ws.off('close', onClose)
      ws.off('error', onClose)
    })
  }

  /**
   * Keep-alive: ping WA every keepAliveIntervalMs.
   * If the server stops responding (diff > interval + 5s) the connection
   * is considered lost and we call end() — the consumer handles reconnection.
   */
  const startKeepAliveRequest = () => {
    keepAliveReq = setInterval(() => {
      if (!lastDateRecv) lastDateRecv = new Date()
      const diff = Date.now() - lastDateRecv.getTime()
      if (diff > keepAliveIntervalMs + 5000) {
        void end(new Boom('Connection was lost', { statusCode: DisconnectReason.connectionLost }))
      } else if (ws.isOpen) {
        query({
          tag: 'iq',
          attrs: { id: generateMessageTag(), to: S_WHATSAPP_NET, type: 'get', xmlns: 'w:p' },
          content: [{ tag: 'ping', attrs: {} }]
        }).catch((err) => logger.error({ trace: err.stack }, 'Error in sending keep alive'))
      } else {
        logger.warn('Keep alive called when WS not open')
      }
    }, keepAliveIntervalMs)
  }

  /**
   * Tear down the socket.
   * Awaits ws.close() so cleanup is deterministic before emitting connection.update.
   * Runs all registered socketEndHandlers in order.
   * Calls signalRepository.close() and ev.destroy() to prevent leaks.
   */
  const end = async (error) => {
    if (closed) { logger.trace({ trace: error?.stack }, 'Connection already closed'); return }
    closed = true
    logger.info({ trace: error?.stack }, error ? 'connection errored' : 'connection closed')
    clearInterval(keepAliveReq)
    clearTimeout(qrTimer)
    ws.removeAllListeners('close')
    ws.removeAllListeners('open')
    ws.removeAllListeners('message')
    signalRepository.close?.()
    if (!ws.isClosed && !ws.isClosing) {
      try { await ws.close() } catch { }
    }
    for (const handler of socketEndHandlers) {
      try { await handler(error) }
      catch (err) { logger.error({ err }, 'error in socket end handler') }
    }
    ev.emit('connection.update', { connection: 'close', lastDisconnect: { error, date: new Date() } })
    ev.removeAllListeners('connection.update')
    ev.removeAllListeners()
    ev.destroy?.()
  }

  const sendPassiveIq = (tag) =>
    query({
      tag: 'iq',
      attrs: { to: S_WHATSAPP_NET, xmlns: 'passive', type: 'set' },
      content: [{ tag, attrs: {} }]
    })

  const logout = async (msg) => {
    const jid = authState.creds.me?.id
    if (jid) {
      await sendNode({
        tag: 'iq',
        attrs: { to: S_WHATSAPP_NET, type: 'set', id: generateMessageTag(), xmlns: 'md' },
        content: [{ tag: 'remove-companion-device', attrs: { jid, reason: 'user_initiated' } }]
      })
    }
    void end(new Boom(msg || 'Intentional Logout', { statusCode: DisconnectReason.loggedOut }))
  }

  /**
   * Register a cleanup handler that will be awaited during end().
   * Use for releasing external resources tied to this socket's lifetime.
   */
  const registerSocketEndHandler = (handler) => socketEndHandlers.push(handler)

  // ─── Pairing ─────────────────────────────────────────────────────────────────

  const requestPairingCode = async (phoneNumber, customPairingCode) => {
    await waitForSocketOpen()
    // Brief stabilisation delay — ensures the WS open event has fully propagated
    await new Promise((resolve) => setTimeout(resolve, 500))
    const pairingCode = customPairingCode ?? bytesToCrockford(randomBytes(5))
    if (customPairingCode && customPairingCode?.length !== 8)
      throw new Error('Custom pairing code must be exactly 8 chars')
    authState.creds.pairingCode = pairingCode
    authState.creds.me = { id: jidEncode(phoneNumber, 's.whatsapp.net'), name: '~' }
    ev.emit('creds.update', authState.creds)
    await sendNode({
      tag: 'iq',
      attrs: { to: S_WHATSAPP_NET, type: 'set', id: generateMessageTag(), xmlns: 'md' },
      content: [{
        tag: 'link_code_companion_reg',
        attrs: { jid: authState.creds.me.id, stage: 'companion_hello', should_show_push_notification: 'true' },
        content: [
          { tag: 'link_code_pairing_wrapped_companion_ephemeral_pub', attrs: {}, content: await generatePairingKey() },
          { tag: 'companion_server_auth_key_pub', attrs: {}, content: authState.creds.noiseKey.public },
          { tag: 'companion_platform_id', attrs: {}, content: isAndroidBrowser(browser) ? getPlatformId('Chrome') : getCompanionPlatformId(browser) },
          { tag: 'companion_platform_display', attrs: {}, content: isAndroidBrowser(browser) ? 'Chrome (Mac OS)' : `${browser[1]} (${browser[0]})` },
          { tag: 'link_code_pairing_nonce', attrs: {}, content: '0' }
        ]
      }]
    })
    return authState.creds.pairingCode
  }

  async function generatePairingKey() {
    const salt = randomBytes(32)
    const randomIv = randomBytes(16)
    const key = await derivePairingCodeKey(authState.creds.pairingCode, salt)
    const ciphered = aesEncryptCTR(authState.creds.pairingEphemeralKeyPair.public, key, randomIv)
    return Buffer.concat([salt, randomIv, ciphered])
  }

  // ─── Incoming message processing ────────────────────────────────────────────

  const onMessageReceived = (data) => {
    noise.decodeFrame(data, (frame) => {
      lastDateRecv = new Date()
      let anyTriggered = ws.emit('frame', frame)
      if (!(frame instanceof Uint8Array)) {
        const msgId = frame.attrs.id
        if (logger.level === 'trace') logger.trace({ xml: binaryNodeToString(frame), msg: 'recv xml' })
        anyTriggered = ws.emit(`${DEF_TAG_PREFIX}${msgId}`, frame) || anyTriggered
        const l0 = frame.tag
        const l1 = frame.attrs || {}
        const l2 = Array.isArray(frame.content) ? frame.content[0]?.tag : ''
        for (const key of Object.keys(l1)) {
          anyTriggered = ws.emit(`${DEF_CALLBACK_PREFIX}${l0},${key}:${l1[key]},${l2}`, frame) || anyTriggered
          anyTriggered = ws.emit(`${DEF_CALLBACK_PREFIX}${l0},${key}:${l1[key]}`, frame) || anyTriggered
          anyTriggered = ws.emit(`${DEF_CALLBACK_PREFIX}${l0},${key}`, frame) || anyTriggered
        }
        anyTriggered = ws.emit(`${DEF_CALLBACK_PREFIX}${l0},,${l2}`, frame) || anyTriggered
        anyTriggered = ws.emit(`${DEF_CALLBACK_PREFIX}${l0}`, frame) || anyTriggered
        if (!anyTriggered && logger.level === 'debug')
          logger.debug({ unhandled: true, msgId, fromMe: false, frame }, 'Unhandled communication received')
      }
    })
  }

  // ─── WebSocket event bindings ────────────────────────────────────────────────

  ws.on('message', onMessageReceived)

  ws.on('open', async () => {
    try { await validateConnection() }
    catch (err) { logger.error({ err }, 'error in validating connection'); void end(err) }
  })

  ws.on('error', mapWebSocketError(end))

  ws.on('close', () => void end(new Boom('Connection Terminated', { statusCode: DisconnectReason.connectionClosed })))

  ws.on('CB:xmlstreamend', () => {
    logger.info('Stream ended by server')
    if (!closed) void end(new Boom('Connection Terminated by Server', { statusCode: DisconnectReason.connectionClosed }))
  })

  // ─── QR pairing ─────────────────────────────────────────────────────────────

  ws.on('CB:iq,type:set,pair-device', async (stanza) => {
    await sendNode({ tag: 'iq', attrs: { to: S_WHATSAPP_NET, type: 'result', id: stanza.attrs.id } })
    const pairDeviceNode = getBinaryNodeChild(stanza, 'pair-device')
    const refNodes = getBinaryNodeChildren(pairDeviceNode, 'ref')
    const noiseKeyB64 = Buffer.from(creds.noiseKey.public).toString('base64')
    const identityKeyB64 = Buffer.from(creds.signedIdentityKey.public).toString('base64')
    const advB64 = creds.advSecretKey
    let qrMs = qrTimeout || 60000
    const genPairQR = () => {
      if (!ws.isOpen) return
      const refNode = refNodes.shift()
      if (!refNode) { void end(new Boom('QR refs attempts ended', { statusCode: DisconnectReason.timedOut })); return }
      const ref = refNode.content.toString('utf-8')
      // Use buildPairingQRData so the browser tuple is included in the QR payload
      const qr = buildPairingQRData(ref, noiseKeyB64, identityKeyB64, advB64, browser)
      ev.emit('connection.update', { qr })
      qrTimer = setTimeout(genPairQR, qrMs)
      qrMs = qrTimeout || 20000
    }
    genPairQR()
  })

  ws.on('CB:iq,,pair-success', async (stanza) => {
    logger.debug('Pair success received')
    try {
      updateServerTimeOffset(stanza)
      const { reply, creds: updatedCreds } = configureSuccessfulPairing(stanza, creds)
      logger.info({ me: updatedCreds.me, platform: updatedCreds.platform }, 'Pairing configured successfully')
      ev.emit('creds.update', updatedCreds)
      ev.emit('connection.update', { isNewLogin: true, qr: undefined })
      await sendNode(reply)
      void sendUnifiedSession()
    } catch (error) {
      logger.info({ trace: error.stack }, 'Error in pairing')
      void end(error)
    }
  })

  // ─── Login complete ──────────────────────────────────────────────────────────

  ws.on('CB:success', async (node) => {
    try {
      updateServerTimeOffset(node)
      await uploadPreKeysToServerIfRequired()
      await sendPassiveIq('active')
      try { await digestKeyBundle() }
      catch (e) { logger.warn({ e }, 'failed to run digest after login') }
    } catch (err) {
      logger.warn({ err }, 'Failed to send initial passive IQ')
    }
    logger.info('✅ Opened connection to WhatsApp')
    clearTimeout(qrTimer)
    ev.emit('creds.update', { me: { ...authState.creds.me, lid: node.attrs.lid } })
    ev.emit('connection.update', { connection: 'open' })
    void sendUnifiedSession()
    if (node.attrs.lid && authState.creds.me?.id) {
      const myLID = node.attrs.lid
      process.nextTick(async () => {
        try {
          const myPN = authState.creds.me.id
          // Store own LID-PN mapping
          await signalRepository.lidMapping.storeLIDPNMappings([{ lid: myLID, pn: myPN }])
          // Write own device entry — one key per user, no index blob
          const { user, device } = jidDecode(myPN)
          await authState.keys.set({ 'device-list': { [user]: [device?.toString() || '0'] } })
          // Migrate own session from PN → LID
          await signalRepository.migrateSession(myPN, myLID)
          logger.info({ myPN, myLID }, 'Own LID session created successfully')

          // Migrate any other known PN sessions to LID (replaces removed migrateAllPNSessionsToLID)
          if (signalRepository.lidMapping.getLIDPNMappings) {
            try {
              const allMappings = await signalRepository.lidMapping.getLIDPNMappings()
              const others = (allMappings || []).filter(m => m.pn !== myPN && m.lid && m.pn)
              let migrated = 0
              for (const { pn, lid } of others) {
                try {
                  await signalRepository.migrateSession(pn, lid)
                  migrated++
                } catch (sessErr) {
                  logger.warn({ error: sessErr, pn, lid }, 'Failed to migrate individual PN session to LID')
                }
              }
              if (migrated > 0) logger.info({ migrated }, 'Batch-migrated PN sessions to LID on connect')
            } catch (migErr) {
              logger.warn({ error: migErr }, 'Failed to batch-migrate PN sessions to LID')
            }
          }
        } catch (error) {
          logger.error({ error, lid: myLID }, 'Failed to create own LID session')
        }
      })
    }
  })
  // ─── Stream / connection error handlers ─────────────────────────────────────

  ws.on('CB:stream:error', (node) => {
    const [reasonNode] = getAllBinaryNodeChildren(node)
    logger.error({ reasonNode, fullErrorNode: node }, 'Stream errored out')
    const { reason, statusCode } = getErrorCodeFromStreamError(node)
    void end(new Boom(`Stream Errored (${reason})`, { statusCode, data: reasonNode || node }))
  })

  ws.on('CB:failure', (node) => {
    const reason = +(node.attrs.reason || 500)
    void end(new Boom('Connection Failure', { statusCode: reason, data: node.attrs }))
  })

  ws.on('CB:ib,,downgrade_webclient', () =>
    void end(new Boom('Multi-device beta not joined', { statusCode: DisconnectReason.multideviceMismatch }))
  )

  ws.on('CB:ib,,offline_preview', async (node) => {
    logger.info('Offline preview received', JSON.stringify(node))
    await sendNode({ tag: 'ib', attrs: {}, content: [{ tag: 'offline_batch', attrs: { count: '100' } }] })
  })

  ws.on('CB:ib,,edge_routing', (node) => {
    const edgeRoutingNode = getBinaryNodeChild(node, 'edge_routing')
    const routingInfo = getBinaryNodeChild(edgeRoutingNode, 'routing_info')
    if (routingInfo?.content) {
      authState.creds.routingInfo = Buffer.from(routingInfo.content)
      ev.emit('creds.update', authState.creds)
    }
  })

  // ─── Buffering & offline notifications ──────────────────────────────────────

  process.nextTick(() => {
    if (creds.me?.id) { ev.buffer(); didStartBuffer = true }
    ev.emit('connection.update', { connection: 'connecting', receivedPendingNotifications: false, qr: undefined })
  })

  ws.on('CB:ib,,offline', (node) => {
    const child = getBinaryNodeChild(node, 'offline')
    const offlineNotifs = +(child?.attrs.count || 0)
    logger.info(`Handled ${offlineNotifs} offline messages/notifications`)
    if (didStartBuffer) { ev.flush(); logger.trace('Flushed events for initial buffer') }
    ev.emit('connection.update', { receivedPendingNotifications: true })
  })

  // ─── Creds sync ──────────────────────────────────────────────────────────────

  ev.on('creds.update', (update) => {
    const name = update.me?.name
    if (creds.me?.name !== name) {
      logger.debug({ name }, 'Updated pushName')
      sendNode({ tag: 'presence', attrs: { name } }).catch((err) =>
        logger.warn({ trace: err.stack }, 'Error in sending presence update on name change')
      )
    }
    Object.assign(creds, update)
  })

  // ─── Public API ──────────────────────────────────────────────────────────────

  return {
    type: 'md',
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
    registerSocketEndHandler,
    onUnexpectedError,
    uploadPreKeys,
    uploadPreKeysToServerIfRequired,
    digestKeyBundle,
    rotateSignedPreKey,
    updateServerTimeOffset,
    sendUnifiedSession,
    requestPairingCode,
    wamBuffer: publicWAMBuffer,
    waitForConnectionUpdate: bindWaitForConnectionUpdate(ev),
    sendWAMBuffer,
    executeUSyncQuery,
    onWhatsApp,
    fetchAccountReachoutTimelock,
    fetchNewChatMessageCap,
    listener: (eventName) => {
      if (typeof ev.listenerCount === 'function') return ev.listenerCount(eventName)
      if (typeof ev.listener === 'function') return ev.listener(eventName)?.length || 0
      return 0
    }
  }
}