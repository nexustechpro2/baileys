import WebSocket from 'ws'
import { DEFAULT_ORIGIN } from '../../Defaults/index.js'
import { AbstractSocketClient } from './types.js'

const MAX_CONNECT_RETRIES = 5
const BASE_RETRY_DELAY = 1000

export class WebSocketClient extends AbstractSocketClient {
  constructor() {
    super(...arguments)
    this.socket = null
    this._connectRetries = 0
    this._connectTimer = null
    this._dead = false
  }

  get isOpen() { return this.socket?.readyState === WebSocket.OPEN }
  get isClosed() { return this.socket === null || this.socket?.readyState === WebSocket.CLOSED }
  get isClosing() { return this.socket === null || this.socket?.readyState === WebSocket.CLOSING }
  get isConnecting() { return this.socket?.readyState === WebSocket.CONNECTING }

  connect() {
    if (this.socket || this._dead) return
    this._tryConnect()
  }

  _tryConnect() {
    if (this._dead) return
    let didOpen = false
    this.socket = new WebSocket(this.url, {
      origin: DEFAULT_ORIGIN,
      headers: this.config.options?.headers,
      handshakeTimeout: this.config.connectTimeoutMs,
      timeout: this.config.connectTimeoutMs,
      agent: this.config.agent,
      family: 4, // skip IPv6 — avoids ENETUNREACH on broken IPv6 networks
    })
    this.socket.setMaxListeners(0)

    const passthroughEvents = ['close', 'upgrade', 'message', 'open', 'ping', 'pong', 'unexpected-response']
    for (const event of passthroughEvents) {
      this.socket.on(event, (...args) => this.emit(event, ...args))
    }

    this.socket.once('open', () => {
      didOpen = true
      this._connectRetries = 0
    })

    this.socket.on('error', (err) => {
      const isConnectError = !didOpen && ['ETIMEDOUT', 'ECONNREFUSED', 'ENETUNREACH', 'ENOTFOUND', 'EAI_AGAIN'].includes(err.code)
      if (isConnectError && this._connectRetries < MAX_CONNECT_RETRIES) {
        this._connectRetries++
        const delay = Math.min(BASE_RETRY_DELAY * Math.pow(2, this._connectRetries - 1), 30000)
        this.socket = null
        this._connectTimer = setTimeout(() => this._tryConnect(), delay)
      } else {
        this.emit('error', err)
      }
    })
  }

  async close() {
    this._dead = true
    clearTimeout(this._connectTimer)
    if (!this.socket) return
    const closePromise = new Promise(resolve => { this.socket?.once('close', resolve) })
    this.socket.close()
    await closePromise
    this.socket = null
  }

  reset() {
    this._dead = false
    this._connectRetries = 0
    clearTimeout(this._connectTimer)
  }

  send(str, cb) {
    this.socket?.send(str, cb)
    return Boolean(this.socket)
  }
}

export default WebSocketClient