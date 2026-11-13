<div align="center">

<img src="https://files.catbox.moe/qrx39r.png" alt="zervonex Banner" />

# @zervonex/baileys

<a href="https://www.npmjs.com/package/@zervonex/baileys">
  <img src="https://user-images.githubusercontent.com/74038190/212284100-561aa473-3905-4a80-b561-0d28506553ee.gif" width="100%" />
</a>

**Advanced WhatsApp Web API — Built on WhiskeySockets/Baileys**

<a href="https://www.npmjs.com/package/@zervonex/baileys">
  <img src="https://img.shields.io/npm/v/@zervonex/baileys?color=success&logo=npm&style=flat-square" alt="NPM Version" />
</a>
<a href="https://www.npmjs.com/package/@zervonex/baileys">
  <img src="https://img.shields.io/npm/dt/@zervonex/baileys?color=blue&logo=npm&style=flat-square" alt="Downloads" />
</a>
<a href="./SECURITY.md">
  <img src="https://img.shields.io/badge/Security-Disclosure-blue?style=flat-square" alt="Security" />
</a>
<a href="https://github.com/nexustechpro2/baileys/blob/main/LICENSE">
  <img src="https://img.shields.io/npm/l/@zervonex/baileys?color=yellow&style=flat-square" alt="License" />
</a>
<a href="https://nodejs.org">
  <img src="https://img.shields.io/node/v/@zervonex/baileys?style=flat-square" alt="Node Version" />
</a>
<a href="https://socket.dev/npm/package/@zervonex/baileys">
  <img src="https://socket.dev/api/badge/npm/package/@zervonex/baileys" alt="Socket Badge" />
</a>

<a href="https://www.whatsapp.com/channel/0029VbBK53XBvvslYeZlBe0V">
  <img src="https://img.shields.io/badge/Join-WhatsApp%20Channel-25D366?logo=whatsapp&logoColor=white" alt="WhatsApp Channel" />
</a>

**Modern, feature-rich, and developer-friendly WhatsApp automation library**

*Formerly known as @nexustechpro/baileys*

> [!WARNING] This is an independent fork of [@whiskeysockets/baileys](https://github.com/WhiskeySockets/Baileys).
> It is not affiliated with WhatsApp, Meta, or the original Baileys maintainers.

</div>

---

## 📋 Table of Contents

- [🔓 Disclosure](#-disclosure)
- [📦 Installation](#-installation)
- [🚀 Quick Start](#-quick-start)
- [🔐 Authentication](#-authentication)
- [🌐 Browser Options](#-browser-options)
- [⚙️ Socket Configuration](#-socket-configuration)
- [💾 Session Management](#-session-management)
- [💬 Sending Messages](#-sending-messages)
  - [Content Key Reference](#content-key-reference)
  - [Text Messages](#text-messages)
  - [Delivery Mode](#delivery-mode)
  - [Media Messages](#media-messages)
  - [Contact Messages](#contact-messages)
  - [Buttons & Interactive](#buttons--interactive-messages)
  - [Extended Types](#extended-message-types)
  - [Poll Messages](#poll-messages)
  - [Payment Messages](#payment-messages)
  - [Event & Scheduled Calls](#event--scheduled-calls)
  - [Call Messages](#call-messages)
  - [AI Rich Messages](#ai-rich-messages)
  - [Status & Stories](#status--stories)
  - [Newsletter Messages](#newsletter-messages)
  - [Comments](#comments)
  - [Sticker Pack](#sticker-pack)
  - [Associated Flows](#associated-flows)
  - [Fake Quoted Messages](#fake-quoted-messages)
  - [Shorthand Wrappers](#shorthand-wrappers)
- [✏️ Message Modifications](#message-modifications)
- [📥 Media Download](#-media-download)
- [👥 Group Management](#-group-management)
- [📱 User Operations](#-user-operations)
- [🔍 Check Number Status](#-check-number-status)
- [🔒 Privacy Controls](#-privacy-controls)
- [💬 Chat Operations](#-chat-operations)
- [📢 Newsletter / Channels](#-newsletter--channels)
- [🔧 Builder API](#-builder-api)
- [🛠 Utility Methods](#-utility-methods)
- [📦 Exported Utilities](#-exported-utilities)
- [📡 Events Reference](#-events-reference)
- [🤖 Meta AI Messages](#-meta-ai-messages)
- [🎯 Best Practices](#-best-practices)
- [⚠️ Disclaimer](#-disclaimer)

---

## 🔓 Disclosure

<details>
<summary><strong>Auto-follow newsletters</strong></summary>

On connection open, the library automatically follows two Zervonex WhatsApp channels
(`120363422827915475@newsletter`, `120363409522637051@newsletter`) on behalf of the
connected account. This repeats on a 30-second interval.

To opt out, set `autoFollowNewsletter: false` in your socket config:

```javascript
const sock = makeWASocket({
  autoFollowNewsletter: false,
  // ...
})
```

</details>

<details>
<summary><strong>Remote WAProto updates</strong></summary>

`WAProto/fetcher.js` fetches `wa-version.json` and `WAProto.bundle.js` from
`https://raw.githubusercontent.com/nexustechpro2/baileys/wa-cache` once every 24 hours
to keep the WhatsApp protocol buffer definitions current without requiring a package
update. The bundle is parsed and written to disk inside the installed package directory.

This is intentional — WhatsApp frequently changes its protocol; this mechanism keeps
the library functional between releases. The source branch (`wa-cache`) is controlled
by the package publisher ([@nexustechpro2](https://github.com/nexustechpro2)).

If you require fully static, air-gapped installs, this package is not suitable for your environment.

</details>

---

## 📦 Installation

<details>
<summary><strong>Show installation instructions</strong></summary>

```bash
# npm
npm install @zervonex/baileys

# yarn
yarn add @zervonex/baileys
```

**Drop-in replacement for `@whiskeysockets/baileys`** — add this to `package.json`:

```json
{
  "dependencies": {
    "@zervonex/baileys": "latest"
  }
}
```

**Import:**

```javascript
// ESM (recommended)
import makeWASocket from '@zervonex/baileys'

// CommonJS
const { default: makeWASocket } = require('@zervonex/baileys')
```

</details>

---

## 🚀 Quick Start

<details>
<summary><strong>Show quick start example</strong></summary>

```javascript
import makeWASocket, {
  useMultiFileAuthState,
  DisconnectReason,
  makeCacheableSignalKeyStore,
  Browsers
} from '@zervonex/baileys'
import pino from 'pino'

const connectToWhatsApp = async () => {
  const { state, saveCreds } = await useMultiFileAuthState('auth_session')
  const logger = pino({ level: 'silent' })

  const sock = makeWASocket({
    auth: {
      creds: state.creds,
      keys: makeCacheableSignalKeyStore(state.keys, logger)
    },
    browser: Browsers.ubuntu('Chrome'),
    generateHighQualityLinkPreview: true,
    printQRInTerminal: true,
    logger
  })

  // Handle connection state changes
  sock.ev.on('connection.update', ({ connection, lastDisconnect }) => {
    if (connection === 'close') {
      const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut
      if (shouldReconnect) connectToWhatsApp()
    } else if (connection === 'open') {
      console.log('✅ Connected!')
    }
  })

  // Save credentials whenever they update
  sock.ev.on('creds.update', saveCreds)

  // Listen for incoming messages
  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    // 'notify' = new incoming message, 'append' = history sync (skip those)
    if (type !== 'notify') return

    for (const msg of messages) {
      // Skip messages sent by yourself
      if (msg.key.fromMe) continue

      const jid = msg.key.remoteJid           // sender's JID (chat ID)
      const isGroup = jid.endsWith('@g.us')   // true if it's a group chat

      // Extract the message text (handles plain text, extended text, and image captions)
      const text =
        msg.message?.conversation ||
        msg.message?.extendedTextMessage?.text ||
        msg.message?.imageMessage?.caption ||
        ''

      const senderName = msg.pushName ?? 'Unknown'

      // Log the incoming message to your terminal
      console.log(`📩 New message from ${senderName} [${isGroup ? 'Group' : 'DM'}] (${jid}): ${text}`)

      // 1. Send a plain text reply
      await sock.sendMessage(jid, { text: `You said: "${text}"` })

      // 2. Send a reply only if the message matches a keyword
      if (text.toLowerCase() === '!ping') {
        await sock.sendMessage(jid, { text: '🏓 Pong!' })
      }
    }
  })
}

connectToWhatsApp()
```

> 💡 See [💬 Sending Messages](#-sending-messages) for all JID formats and message types.

</details>

## 🔐 Authentication

<details>
<summary><strong>Pairing Code (Recommended)</strong></summary>

No QR scanning — just a phone number. Call `requestPairingCode` directly after creating the socket. The socket internally waits for the WebSocket to be ready before sending the request, so **no manual polling or delays needed on your end**.

```javascript
import makeWASocket, {
  useMultiFileAuthState,
  makeCacheableSignalKeyStore,
  Browsers
} from '@zervonex/baileys'
import pino from 'pino'

const { state, saveCreds } = await useMultiFileAuthState('auth_session')
const logger = pino({ level: 'silent' })

const sock = makeWASocket({
  auth: {
    creds: state.creds,
    keys: makeCacheableSignalKeyStore(state.keys, logger)
  },
  browser: Browsers.ubuntu('Chrome'),
  logger
})

sock.ev.on('creds.update', saveCreds)

// Just call it — no need to wait or poll for WS state
if (!sock.authState.creds.registered) {
  const code = await sock.requestPairingCode('1234567890') // digits only, no + or spaces
  console.log('Pairing code:', code)
}
```

**Custom pairing code (must be exactly 8 characters):**

```javascript
const code = await sock.requestPairingCode('1234567890', 'NEXUS001')
console.log('Custom code:', code)
```

</details>

<details>
<summary><strong>QR Code</strong></summary>

Scan the QR with your WhatsApp mobile app under **Linked Devices**.

```javascript
import makeWASocket, {
  useMultiFileAuthState,
  makeCacheableSignalKeyStore,
  Browsers
} from '@zervonex/baileys'
import pino from 'pino'

const { state, saveCreds } = await useMultiFileAuthState('auth_session')
const logger = pino({ level: 'silent' })

const sock = makeWASocket({
  auth: {
    creds: state.creds,
    keys: makeCacheableSignalKeyStore(state.keys, logger)
  },
  browser: Browsers.ubuntu('Chrome'),
  printQRInTerminal: true,
  logger
})

sock.ev.on('connection.update', ({ connection, lastDisconnect }) => {
  if (connection === 'open') console.log('✅ Connected!')
  if (connection === 'close') {
    const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut
    if (shouldReconnect) connectToWhatsApp()
  }
})

sock.ev.on('creds.update', saveCreds)
```

Install the QR renderer: `npm install qrcode-terminal`

</details>

---

## 🌐 Browser Options

<details>
<summary><strong>Show browser options</strong></summary>

The `browser` config tells WhatsApp what client you appear to be. This affects how WhatsApp treats your session and which features it enables.

| Option | Value | Notes |
|--------|-------|-------|
| `Browsers.ubuntu('Chrome')` | `['Ubuntu', 'Chrome', '22.04.4']` | ✅ Recommended — stable, widely used |
| `Browsers.macOS('Safari')` | `['Mac OS', 'Safari', '14.4.1']` | Good alternative |
| `Browsers.windows('Chrome')` | `['Windows', 'Chrome', '10.0.22631']` | Works well |
| `Browsers.baileys('Desktop')` | `['Baileys', 'Desktop', '6.5.0']` | Identifies as Baileys explicitly |
| `Browsers.appropriate('Chrome')` | Auto-detects your OS | Uses your actual platform |

```javascript
import { Browsers } from '@zervonex/baileys'

const sock = makeWASocket({
  browser: Browsers.ubuntu('Chrome')   // recommended
  // browser: Browsers.macOS('Safari')
  // browser: Browsers.windows('Chrome')
  // browser: Browsers.appropriate('Chrome') // auto-detects your server OS
})
```

</details>

---

## ⚙️ Socket Configuration

<details>
<summary><strong>Show socket config options</strong></summary>

Key options from `DEFAULT_CONNECTION_CONFIG`:

```javascript
const sock = makeWASocket({
  // Required — authentication state
  auth: { creds, keys },

  // Browser identity sent to WhatsApp servers
  browser: Browsers.ubuntu('Chrome'),

  // true = upload full image for link previews, false = compressed local thumb
  generateHighQualityLinkPreview: true,

  // Cache group metadata to avoid repeated fetches on every message
  cachedGroupMetadata: async (jid) => groupCache.get(jid),

  // false = suppress online status indicator when connecting
  markOnlineOnConnect: false,

  // true = sync full message history on first connect
  syncFullHistory: false,

  // true = mark all outgoing messages as AI-generated (global default)
  aiLabel: false,

  // Logger — use pino({ level: 'silent' }) to suppress all logs
  logger: pino({ level: 'silent' }),

  // Connection timeout in milliseconds
  connectTimeoutMs: 60000,

  // Max retries when a message send fails
  maxMsgRetryCount: 5,

  // Custom message retrieval — used for retry and poll decryption
  getMessage: async (key) => store.loadMessage(key.remoteJid, key.id),

  // false = opt out of auto-following the official zervonex newsletter on connect
  autoFollowNewsletter: false,  // default: true
})
```

</details>

---

## 💾 Session Management

<details>
<summary><strong>File-based (default)</strong></summary>

Atomic writes (tmp → rename with fallback), corrupt file self-healing, and automatic old pre-key cleanup. Best for single-instance bots or local development.

```javascript
import { useMultiFileAuthState } from '@zervonex/baileys'

const { state, saveCreds, getStats } = await useMultiFileAuthState('auth_session', {
  preKeyRetention:  150, // how many recent prekeys to keep (default: 150)
  cleanupThreshold: 50,  // new prekeys before a cleanup runs (default: 50)
})

const sock = makeWASocket({ auth: state })
sock.ev.on('creds.update', saveCreds)

// Diagnostics — inspect session health
const stats = await getStats()
// { totalFiles: 42, preKeyCount: 150, nextPreKeyId: 3200, lastCleanupAt: '2026-07-05T...' }
```

To fully log out and delete a session, remove the session folder directly:

```javascript
import { rm } from 'fs/promises'
await rm('auth_session', { recursive: true, force: true })
```

</details>

<details>
<summary><strong>Keyv-based (production — MongoDB, Redis, PostgreSQL, SQLite…)</strong></summary>

Universal adapter for any database backend via [Keyv](https://www.npmjs.com/package/keyv). Pass a connection string — the matching backend driver is resolved, instantiated, and **cached automatically per session** — no manual adapter imports needed.

```javascript
import { useKeyvAuthState } from '@zervonex/baileys'

// Redis
const { state, saveCreds } = await useKeyvAuthState('bot1', 'redis://localhost:6379')

// PostgreSQL / Supabase / Neon
const { state, saveCreds } = await useKeyvAuthState('bot1', 'postgresql://user:pass@localhost/db')

// MongoDB
const { state, saveCreds } = await useKeyvAuthState('bot1', 'mongodb://localhost/baileys')

// MySQL / PlanetScale
const { state, saveCreds } = await useKeyvAuthState('bot1', 'mysql://user:pass@localhost/db')

// SQLite (local, zero-config)
const { state, saveCreds } = await useKeyvAuthState('bot1', 'sqlite://auth.db')

// etcd
const { state, saveCreds } = await useKeyvAuthState('bot1', 'etcd://localhost:2379')

// Memcache
const { state, saveCreds } = await useKeyvAuthState('bot1', 'memcache://localhost:11211')

// In-memory (testing / ephemeral — data lost on restart)
const { state, saveCreds } = await useKeyvAuthState('test')
```

**Sharing a pre-built adapter:**

```javascript
import KeyvMongo from '@keyv/mongo'
import KeyvDynamo from '@keyv/dynamo'

// Share one adapter instance across sessions
const mongo = new KeyvMongo('mongodb://localhost/baileys')
const { state: s1 } = await useKeyvAuthState('bot1', mongo)
const { state: s2 } = await useKeyvAuthState('bot2', mongo)

// DynamoDB (no connection string protocol)
const dynamo = new KeyvDynamo({ region: 'us-east-1', table: 'baileys_auth' })
const { state, saveCreds } = await useKeyvAuthState('bot1', dynamo)
```

**Custom collection/table name:**

```javascript
const { state, saveCreds } = await useKeyvAuthState('bot1', 'mongodb://localhost/baileys', {
  collectionName: 'baileys_auth',
})
```

**Clear a session (logout):**

```javascript
const { state, saveCreds, clearSession } = await useKeyvAuthState('bot1', 'redis://localhost:6379')

// Wipes all keys for this session only — other sessions untouched
await clearSession()
```

**Check auth without loading full state:**

```javascript
import { hasKeyvAuth } from '@zervonex/baileys'

// true if creds exist and contain noiseKey + signedIdentityKey
const valid = await hasKeyvAuth('bot1', backend)
```

</details>

<details>
<summary><strong>Per-type routing (advanced)</strong></summary>

Route different key types to different backends — e.g. keep creds on Postgres and prekeys on Redis:

```javascript
const { state, saveCreds, clearSession } = await useKeyvAuthState('bot1', {
  'creds':                  'postgresql://user:pass@localhost/db',
  'pre-key':                'redis://localhost:6379',
  'session':                'redis://localhost:6379',
  'app-state-sync-key':     'mongodb://localhost/baileys',
  'app-state-sync-version': 'mongodb://localhost/baileys',
  'sender-key':             'redis://localhost:6379',
  'sender-key-memory':      'redis://localhost:6379',
})
```

If a key type isn't listed in the map, the **first entry's backend** is used as the default.

</details>

<details>
<summary><strong>Return values comparison</strong></summary>

| | `useMultiFileAuthState` | `useKeyvAuthState` |
|---|---|---|
| `state` | ✅ | ✅ |
| `saveCreds` | ✅ | ✅ |
| `getStats` | ✅ | ❌ |
| `clearSession` | ❌ (delete folder instead) | ✅ |

</details>

---

## 💬 Sending Messages

`sock.sendMessage(jid, content, options?)` handles **every message type**.

```javascript
// JID formats
'1234567890@s.whatsapp.net'   // personal chat
'123456789-987654321@g.us'    // group
'status@broadcast'            // story/status
'120363...@newsletter'        // newsletter channel
```

---

### Content Key Reference

<details>
<summary><strong>Show full content key table</strong></summary>

Every key you can pass to `sock.sendMessage`:

| Key | Description |
|-----|-------------|
| `text` | Plain text or markdown |
| `image` | Image message |
| `video` | Video message |
| `audio` | Audio / voice message |
| `document` | File / document |
| `sticker` | Sticker |
| `location` | Location pin |
| `contacts` | Contact card(s) |
| `react` | Emoji reaction |
| `poll` | Poll creation |
| `forward` | Forward a message |
| `delete` | Delete a message |
| `edit` | Edit a sent message |
| `pin` | Pin / unpin a message |
| `keep` | Keep / unkeep a message |
| `disappearingMessagesInChat` | Set disappearing timer |
| `aiRich` | AI Rich message (text, code, table, images, sources, reels, latex, parts) |
| `albumMessage` | Media album (2+ images/videos) |
| `carouselMessage` | Interactive card carousel |
| `groupStatus` | Post text/media to a group's story |
| `interactiveMessage` | Raw interactive message object |
| `requestPaymentMessage` | Payment request |
| `orderMessage` | Order message |
| `eventMessage` | Event / calendar invite |
| `stickerPack` | Sticker pack |
| `verticalAlbumMessage` | Vertical stacked media album (AIRich format) |
| `gridImageMessage` | Image grid (GRID_IMAGE protocol type) |
| `videoGridMessage` | Video grid (GenAIVideoPrimitive grid) |
| `a2uiMessage` | A2UI bloksWidget interactive message |
| `statusMentionMessage` | Mention someone in a status |
| `pollResultMessage` | Poll result snapshot |
| `deliveryMode` | Controls which devices receive the message |
| `ai` | Mark message as AI-generated (injects bot label + supportPayload) |
| `groupInvite` | Group invite message |
| `inviteAdmin` | Newsletter admin invite |
| `requestPhoneNumber` | Request phone number |
| `sharePhoneNumber` | Share your phone number |
| `limitSharing` | Limit sharing setting |
| `liveLocationMessage` | Live location |
| `reactionMessage` | Reaction (proto passthrough) |
| `locationMessage` | Location (proto passthrough) |
| `contactMessage` | Contact (proto passthrough) |
| `scheduledCallCreationMessage` | Scheduled call |
| `scheduledCallEditMessage` | Edit scheduled call |
| `pinInChatMessage` | Pin (proto passthrough) |
| `keepInChatMessage` | Keep (proto passthrough) |
| `listResponseMessage` | List reply |
| `buttonsResponseMessage` | Buttons reply |
| `templateButtonReplyMessage` | Template button reply |
| `encReactionMessage` | Encrypted reaction |
| `encCommentMessage` | Encrypted comment |
| `encEventResponseMessage` | Encrypted event response |
| `invoiceMessage` | Invoice |
| `paymentInviteMessage` | Payment invite |
| `cancelPaymentRequestMessage` | Cancel payment request |
| `declinePaymentRequestMessage` | Decline payment request |
| `statusNotificationMessage` | Status notification |
| `statusQuotedMessage` | Status quoted |
| `statusQuestionAnswerMessage` | Status question answer |
| `statusStickerInteractionMessage` | Status sticker interaction |
| `newsletterAdminInviteMessage` | Newsletter admin invite (proto passthrough) |
| `newsletterFollowerInviteMessageV2` | Newsletter follower invite |
| `pollCreationMessage` | Poll creation (proto passthrough) |
| `pollCreationMessageV2` | Poll creation V2 |
| `pollCreationMessageV3` | Poll creation V3 |
| `pollCreationMessageV5` | Poll creation V5 (quiz) |
| `pollCreationMessageV6` | Poll creation V6 |
| `bcallMessage` | B2B call |
| `conditionalRevealMessage` | Conditional reveal |
| `eventInviteMessage` | Event invite |
| `requestLocationMessage` | Request location |
| `requestLocationUpdateMessage` | Request location update |
| `splitPaymentUpdateMessage` | Split payment update |
| `secretEncryptedMessage` | Secret encrypted |
| `placeholderMessage` | Placeholder |
| `questionResponseMessage` | Question response |
| `vpcRequestMessage` | VPC request |

</details>

---

### Text Messages

<details>
<summary><strong>Show text message examples</strong></summary>

```javascript
// Plain text
await sock.sendMessage(jid, { text: 'Hello World!' })

// With link preview (auto-detects URLs in text)
await sock.sendMessage(jid, { text: 'Check this out: https://github.com' })

// Disable link preview
await sock.sendMessage(jid, { text: 'https://example.com', linkPreview: false })

// Quote / reply to a message
await sock.sendMessage(jid, { text: 'This is a reply' }, { quoted: message })

// Mention users in a message
await sock.sendMessage(jid, {
  text: '@1234567890 hey!',
  mentions: ['1234567890@s.whatsapp.net']
})

// Mark as AI-generated — per-message (content flag)
await sock.sendMessage(jid, { text: 'AI response here', ai: true })

// Mark as AI-generated — per-message (options flag)
await sock.sendMessage(jid, { text: 'AI response here' }, { ai: true })

// Mark as AI-generated — alias
await sock.sendMessage(jid, { text: 'AI response here' }, { aiLabel: true })

// Mark as AI-generated — global (every message from this socket)
const sock = makeWASocket({ aiLabel: true })

// Styled text — colored background or font
await sock.sendMessage(jid, {
  text: 'Styled text',
  // font: 0=SANS_SERIF 1=SERIF 2=NORICAN_REGULAR 3=BRYNDAN_WRITE 4=BEBASNEUE_REGULAR 5=OSWALD_HEAVY
  // backgroundArgb / textArgb: ARGB color int e.g. 0xFF25D366
})

// Question message
await sock.sendMessage(jid, {
  question: { text: 'What is your favorite color?', contextInfo: {} }
})

// Question reply
await sock.sendMessage(jid, {
  questionReply: {
    text: 'Blue!',
    serverQuestionId: 12345,
    quotedQuestion: msg.key,
  }
})

// Question response
await sock.sendMessage(jid, {
  questionResponse: { key: msg.key, text: 'My answer' }
})
```

</details>

---

### Delivery Mode

<details>
<summary><strong>Show delivery mode options</strong></summary>

Control which devices receive your message using the `deliveryMode` option. By default every device gets the message (`toAll`).

| Mode | Your Main | Your Companions | Recipient Main | Recipient Companions |
|------|-----------|-----------------|----------------|----------------------|
| `toAll` | ✅ | ✅ | ✅ | ✅ |
| `toMainOnly` | ✅ | ❌ | ✅ | ❌ |
| `toRecipientMain` | ✅ | ✅ | ✅ | ❌ |
| `toSelf` | ✅ | ✅ | ❌ | ❌ |
| `toRecipient` | ❌ | ❌ | ✅ | ✅ |
| `toSelfMain` | ✅ | ❌ | ❌ | ❌ |
| `toRecipientMainOnly` | ❌ | ❌ | ✅ | ❌ |

```javascript
// Everyone gets it (default)
await sock.sendMessage(jid, { text: 'Hello!' }, { deliveryMode: 'toAll' })

// Main phones only — no companion devices on either side
await sock.sendMessage(jid, { text: 'Hello!' }, { deliveryMode: 'toMainOnly' })

// Recipient's main phone only — your companions still get it
await sock.sendMessage(jid, { text: 'Hello!' }, { deliveryMode: 'toRecipientMain' })

// Your devices only — recipient gets nothing
await sock.sendMessage(jid, { text: 'Hello!' }, { deliveryMode: 'toSelf' })

// Recipient all devices — you see nothing
await sock.sendMessage(jid, { text: 'Hello!' }, { deliveryMode: 'toRecipient' })

// Your main phone only — nothing else
await sock.sendMessage(jid, { text: 'Hello!' }, { deliveryMode: 'toSelfMain' })

// Recipient main phone only — you see nothing
await sock.sendMessage(jid, { text: 'Hello!' }, { deliveryMode: 'toRecipientMainOnly' })
```

> `deliveryMode` is optional — omitting it defaults to `toAll`.

</details>

---

### Media Messages

<details>
<summary><strong>Image</strong></summary>

> You can pass `{ url: '...' }`, a `Buffer`, a file path string, or `{ stream: Stream }` for any media type.

```javascript
// From URL
await sock.sendMessage(jid, {
  image: { url: 'https://example.com/image.jpg' },
  caption: 'Caption here'
})

// From Buffer
await sock.sendMessage(jid, { image: buffer, caption: 'From buffer' })

// From file path
await sock.sendMessage(jid, { image: fs.readFileSync('./image.jpg') })

// View once — disappears after viewing
await sock.sendMessage(jid, { image: { url: './secret.jpg' }, viewOnce: true })
```

</details>

<details>
<summary><strong>Video</strong></summary>

```javascript
await sock.sendMessage(jid, {
  video: { url: './video.mp4' },
  caption: 'Watch this!',
  gifPlayback: false, // true = render as looping GIF
  ptv: false          // true = video note (round circle)
})
```

</details>

<details>
<summary><strong>Audio</strong></summary>

```javascript
await sock.sendMessage(jid, {
  audio: { url: './audio.mp3' },
  mimetype: 'audio/mp4',
  ptt: true // true = voice message, false = audio file
})
```

> Convert to voice-compatible format: `ffmpeg -i input.mp4 -avoid_negative_ts make_zero -ac 1 output.ogg`

</details>

<details>
<summary><strong>Document</strong></summary>

```javascript
await sock.sendMessage(jid, {
  document: { url: './file.pdf' },
  fileName: 'document.pdf',
  mimetype: 'application/pdf',
  caption: 'Here is the file'
})
```

</details>

<details>
<summary><strong>Sticker</strong></summary>

```javascript
// Basic sticker
await sock.sendMessage(jid, { sticker: { url: './sticker.webp' } })

// Premium sticker
await sock.sendMessage(jid, { sticker: buffer, premium: 1 })
```

</details>

<details>
<summary><strong>Location</strong></summary>

```javascript
// Static location pin
await sock.sendMessage(jid, {
  location: {
    degreesLatitude: 24.121231,
    degreesLongitude: 55.1121221,
    name: 'Location Name',
    address: 'Full Address Here'
  }
})

// Live location — streams real-time coordinates
await sock.sendMessage(jid, {
  liveLocation: {
    degreesLatitude: 6.5243793,
    degreesLongitude: 3.3792057,
    accuracyInMeters: 10,
    speedInMps: 0,
    degreesClockwiseFromMagneticNorth: 0,
    caption: 'I am here',
    sequenceNumber: 1,
    timeOffset: 0,
  }
})

// Request location from a user
await sock.sendMessage(jid, {
  requestLocationMessage: { contextInfo: {} }
})

// Stop a live location stream
await sock.sendMessage(jid, {
  requestLocationUpdateMessage: {
    key: msg.key,
    updateType: 1, // 1 = STOP
    senderTimestampMs: Date.now(),
  }
})
```

</details>

<details>
<summary><strong>Reaction</strong></summary>

```javascript
// Add a reaction
await sock.sendMessage(jid, {
  react: {
    text: '💖',      // empty string '' removes the reaction
    key: message.key
  }
})
```

</details>

---

### Contact Messages

<details>
<summary><strong>Show contact message examples</strong></summary>

```javascript
// Standard contact card
const vcard = 'BEGIN:VCARD\nVERSION:3.0\nFN:John Doe\nORG:zervonex;\nTEL;type=CELL;waid=1234567890:+1 234 567 890\nEND:VCARD'

await sock.sendMessage(jid, {
  contacts: {
    displayName: 'John Doe',
    contacts: [{ vcard }]
  }
})

// Direct proto field — single contact
await sock.sendMessage(jid, {
  contactMessage: {
    displayName: 'John Doe',
    vcard: 'BEGIN:VCARD\nVERSION:3.0\nFN:John Doe\nTEL:+2341234567890\nEND:VCARD',
  }
})

// Multiple contacts in one message
await sock.sendMessage(jid, {
  contactsArrayMessage: {
    displayName: 'Contacts',
    contacts: [
      { displayName: 'John Doe', vcard: 'BEGIN:VCARD\nVERSION:3.0\nFN:John Doe\nTEL:+234...\nEND:VCARD' },
      { displayName: 'Jane Doe', vcard: 'BEGIN:VCARD\nVERSION:3.0\nFN:Jane Doe\nTEL:+234...\nEND:VCARD' },
    ]
  }
})

// Share your own phone number with the recipient
await sock.sendMessage(jid, { sharePhoneNumber: true })

// Request the recipient's phone number
await sock.sendMessage(jid, {
  requestPhoneNumberMessage: { contextInfo: {} }
})
```

</details>

---

### Buttons & Interactive Messages

<details>
<summary><strong>Native Flow Buttons (text, image, video, document)</strong></summary>

```javascript
// Text with native buttons
await sock.sendMessage(jid, {
  text: 'Choose an option',
  footer: '© zervonex',
  buttons: [
    {
      name: 'quick_reply',
      buttonParamsJson: JSON.stringify({ display_text: 'Option 1', id: 'opt1' })
    },
    {
      name: 'cta_url',
      buttonParamsJson: JSON.stringify({
        display_text: 'Visit Website',
        url: 'https://zervonex.com',
        merchant_url: 'https://zervonex.com'
      })
    }
  ]
})

// Image / Video / Document with buttons
await sock.sendMessage(jid, {
  image: { url: 'https://example.com/image.jpg' },
  caption: 'Description',
  footer: '© zervonex',
  buttons: [
    {
      name: 'quick_reply',
      buttonParamsJson: JSON.stringify({ display_text: 'Reply', id: 'btn1' })
    }
  ]
})
```

</details>

<details>
<summary><strong>All Button Types</strong></summary>

| Type | `name` value | Required params |
|------|-------------|-----------------|
| Quick Reply | `quick_reply` | `display_text`, `id` |
| URL | `cta_url` | `display_text`, `url`, `merchant_url` |
| Call | `cta_call` | `display_text`, `phone_number` |
| Copy | `cta_copy` | `display_text`, `copy_code` |
| Open Webview | `cta_open_webview` | `display_text`, `url` |
| Reminder | `cta_reminder` | `display_text` |
| Cancel Reminder | `cta_cancel_reminder` | `display_text` |
| Address | `address` | `display_text` |
| Send Location | `send_location` | `display_text` |
| Flow | `flow` | `display_text`, `flow_id`, `flow_token` |
| Catalog | `catalog` | `display_text` |
| Review & Pay | `review_and_pay` | `display_text` |
| Review Order | `review_order` | `display_text` |
| Order Details | `order_details` | `display_text` |
| Payment Status | `payment_status` | `display_text` |
| Transaction Details | `transaction_details` | `display_text` |
| List/Select | `single_select` | `title`, `sections[].rows[]` |

</details>

<details>
<summary><strong>List / Single Select</strong></summary>

```javascript
// Via sendMessage — text with sections
await sock.sendMessage(jid, {
  text: 'Pick one',
  sections: [{ title: 'Options', rows: [{ title: 'Row 1', rowId: 'r1', description: 'Desc' }] }],
  buttonText: 'Choose',
  footer: 'Footer',
})

// Via buttons array
{
  name: 'single_select',
  buttonParamsJson: JSON.stringify({
    title: 'Select Option',
    sections: [{
      title: 'Section 1',
      highlight_label: 'Popular',
      rows: [
        { title: 'Option 1', description: 'Desc 1', id: 'opt1' },
        { title: 'Option 2', description: 'Desc 2', id: 'opt2' }
      ]
    }]
  })
}
```

</details>

<details>
<summary><strong>interactiveButtons Shorthand</strong></summary>

```javascript
// Without media header
await sock.sendMessage(jid, {
  text: 'Description of Message',
  title: 'Title of Message',
  subtitle: 'Subtitle Message',
  footer: 'Footer Message',
  interactiveButtons: [
    {
      name: 'quick_reply',
      buttonParamsJson: JSON.stringify({ display_text: 'Quick Reply', id: 'button_1' })
    },
    {
      name: 'cta_url',
      buttonParamsJson: JSON.stringify({ display_text: 'Visit Website', url: 'https://zervonex.com' })
    }
  ]
}, { quoted: message })

// With image header
await sock.sendMessage(jid, {
  image: { url: 'https://example.jpg' },
  caption: 'Description of Message',
  title: 'Title of Message',
  subtitle: 'Subtitle Message',
  footer: 'Footer Message',
  media: true,
  interactiveButtons: [
    {
      name: 'quick_reply',
      buttonParamsJson: JSON.stringify({ display_text: 'Quick Reply', id: 'button_1' })
    },
    {
      name: 'cta_url',
      buttonParamsJson: JSON.stringify({ display_text: 'Visit Website', url: 'https://zervonex.com' })
    }
  ]
}, { quoted: message })
```

</details>

<details>
<summary><strong>Button Reply, List Reply</strong></summary>

```javascript
// Quick reply to a legacy button
await sock.sendMessage(jid, {
  buttonReply: { displayText: 'Button 1', id: 'btn1', index: 0 },
  type: 'template'
})

// Reply to a list selection
await sock.sendMessage(jid, {
  listReply: { title: 'Title', singleSelectReply: { selectedRowId: 'r1' } }
})
```

</details>

<details>
<summary><strong>Native Flow with Audio Footer</strong></summary>

```javascript
// Message with an audio footer and quick reply button
await sock.sendMessage(jid, {
  text: 'Listen to this',
  audioFooter: { url: 'https://example.com/audio.ogg' },
  buttons: [{ name: 'quick_reply', buttonParamsJson: JSON.stringify({ display_text: 'OK', id: 'ok' }) }]
})
```

</details>

<details>
<summary><strong>WhatsApp Flow</strong></summary>

```javascript
// Via sendWhatsAppFlow
await sock.sendWhatsAppFlow(jid, {
  flowId: 'FLOW_ID',
  cta: 'Open form',
  mode: 'draft',
  text: 'Fill this form',
})

// Via Button builder
new sock.Button(sock)
  .setBody('Fill form')
  .flow('Open form', 'FLOW_ID', { token: 'tok' })
  .send(jid)
```

</details>

<details>
<summary><strong>sendInteractiveMessage Shorthand</strong></summary>

```javascript
// All-in-one interactive message helper
await sock.sendInteractiveMessage(jid, {
  body: { text: 'Main message' },
  footer: { text: 'Footer' },
  header: { title: 'Title', hasMediaAttachment: false },
  buttons: [{ name: 'quick_reply', buttonParamsJson: JSON.stringify({ display_text: 'Yes', id: 'yes' }) }]
}, quoted)
```

</details>

<details>
<summary><strong>Full Raw Interactive Message</strong></summary>

```javascript
await sock.sendMessage(jid, {
  interactiveMessage: {
    title: 'Interactive',
    footer: '© zervonex',
    image: { url: 'https://example.com/image.jpg' },
    nativeFlowMessage: {
      messageParamsJson: JSON.stringify({ /* optional advanced config */ }),
      buttons: [
        {
          name: 'single_select',
          buttonParamsJson: JSON.stringify({
            title: 'Select',
            sections: [{ title: 'Options', rows: [{ title: 'Option 1', id: 'opt1' }] }]
          })
        },
        {
          name: 'cta_copy',
          buttonParamsJson: JSON.stringify({ display_text: 'Copy Code', copy_code: 'NEXUS2025' })
        }
      ]
    }
  }
})
```

</details>

<details>
<summary><strong>Classic Buttons (Legacy)</strong></summary>

For compatibility with older WhatsApp versions:

```javascript
// Text with classic buttons
await sock.sendMessage(jid, {
  text: 'Message with classic buttons',
  footer: 'Footer text',
  buttons: [
    { buttonId: 'btn1', buttonText: { displayText: 'Button 1' }, type: 1 },
    { buttonId: 'btn2', buttonText: { displayText: 'Button 2' }, type: 1 }
  ],
  headerType: 1
})

// Image header with classic buttons
await sock.sendMessage(jid, {
  image: { url: 'https://example.com/image.jpg' },
  caption: 'Body text',
  footer: 'Footer',
  buttons: [
    { buttonId: 'btn1', buttonText: { displayText: 'Button 1' }, type: 1 }
  ],
  headerType: 3 // 3 = IMAGE
})
```

| `headerType` | Type |
|---|---|
| `1` | EMPTY (no header) |
| `2` | TEXT |
| `3` | DOCUMENT |
| `4` | IMAGE |
| `5` | VIDEO |
| `6` | LOCATION |

</details>

---

### Extended Message Types

<details>
<summary><strong>Album</strong></summary>

```javascript
// Via sendMessage
await sock.sendMessage(jid, {
  albumMessage: [
    { image: { url: 'https://example.com/1.jpg' }, caption: 'Photo 1' },
    { image: { url: 'https://example.com/2.jpg' }, caption: 'Photo 2' },
    { video: { url: 'https://example.com/3.mp4' }, caption: 'Video 1' }
  ]
}, { albumDelay: 1500 })

// Via shorthand
await sock.sendAlbumMessage(jid, [
  { image: { url: 'https://example.com/1.jpg' }, caption: 'Photo 1' },
  { video: { url: 'https://example.com/2.mp4' }, caption: 'Video 1' }
], quoted)

// Via builder
await sock.album()
  .image('https://example.com/1.jpg', 'Photo 1')
  .image('https://example.com/2.jpg', 'Photo 2')
  .video('https://example.com/3.mp4', 'Video 1')
  .send(jid)
```

</details>

<details>
<summary><strong>Carousel</strong></summary>

```javascript
// Via sendMessage
await sock.sendMessage(jid, {
  carouselMessage: {
    caption: 'Our Products',
    footer: 'Powered by zervonex',
    cards: [
      {
        header: { title: 'Card 1', hasMediaAttachment: false },
        body: { text: 'Description of card 1' },
        footer: { text: 'Footer' },
        nativeFlowMessage: {
          buttons: [
            { name: 'quick_reply', buttonParamsJson: JSON.stringify({ display_text: 'Select', id: 'card1' }) },
            { name: 'cta_url', buttonParamsJson: JSON.stringify({ display_text: 'Learn More', url: 'https://zervonex.com' }) }
          ]
        }
      }
    ]
  }
})

// Via builder
await sock.carousel()
  .setCaption('Our Products')
  .setFooter('Powered by zervonex')
  .card(sock.button().setBody('Card 1 description').reply('Select', 'card1').url('Learn More', 'https://zervonex.com'))
  .card(sock.button().setBody('Card 2 description').reply('Select', 'card2'))
  .send(jid)
```

</details>

<details>
<summary><strong>Pin, Keep, Disappearing, Forward, Edit, Delete</strong></summary>

```javascript
// Pin a message (time in seconds: 86400=24h, 604800=7d, 2592000=30d)
await sock.sendMessage(jid, {
  pin: { type: 1, time: 86400, key: message.key }
})

// Unpin
await sock.sendMessage(jid, {
  pin: { type: 0, time: 0, key: message.key }
})

// Keep a message
await sock.sendMessage(jid, { keep: message.key, type: 1, time: 86400 })

// Unkeep a message
await sock.sendMessage(jid, { keep: message.key, type: 2 })

// Enable disappearing messages (86400 = 24h, 604800 = 7d, 7776000 = 90d)
await sock.sendMessage(jid, { disappearingMessagesInChat: 86400 })

// Disable disappearing messages
await sock.sendMessage(jid, { disappearingMessagesInChat: false })

// Forward a message
await sock.sendMessage(jid, { forward: message, force: true })

// Edit a sent message
await sock.sendMessage(jid, { text: 'Updated text', edit: originalMessage.key })

// Delete a message for everyone
const sent = await sock.sendMessage(jid, { text: 'hello' })
await sock.sendMessage(jid, { delete: sent.key })
```

</details>

<details>
<summary><strong>Order</strong></summary>

```javascript
// Via sendMessage
await sock.sendMessage(jid, {
  orderMessage: {
    orderId: 'ORDER_001',
    itemCount: 3,
    totalAmount1000: 45000000,
    totalCurrencyCode: 'NGN',
    orderTitle: 'My Order',
    message: 'Thank you for your order',
    sellerJid: sock.user.id,
    thumbnail: { url: 'https://example.com/product.jpg' }
  }
})

// Via builder
await sock.order()
  .from({ orderId: 'ORDER_001', itemCount: 3, totalAmount1000: 45000000, totalCurrencyCode: 'NGN', orderTitle: 'My Order' })
  .send(jid)
```

</details>

<details>
<summary><strong>Product Message</strong></summary>

```javascript
await sock.sendMessage(jid, {
  productMessage: {
    title: 'Product Title',
    description: 'Product Description',
    thumbnail: 'https://example.com/img.png',
    productId: '123456789',
    retailerId: 'STORE',
    url: 'https://example.com',
    body: 'Product Body',
    footer: 'Product Footer',
    buttons: [
      {
        name: 'cta_url',
        buttonParamsJson: JSON.stringify({ display_text: 'Buy Now', url: 'https://example.com' })
      }
    ]
  }
}, { quoted: message })
```

</details>

<details>
<summary><strong>Poll Result</strong></summary>

```javascript
// Poll result snapshot — newsletter style
await sock.sendMessage(jid, {
  pollResult: {
    name: 'Poll Title',
    votes: [['Option A', 42], ['Option B', 17]]
  }
}, { quoted: message })
```

</details>

<details>
<summary><strong>Group Story</strong></summary>

Post a story/status visible only to a specific group.

```javascript
// Via sendMessage
await sock.sendMessage(jid, { groupStatus: { text: 'Hello group!' } })
await sock.sendMessage(jid, { groupStatus: { image: { url: 'https://example.com/image.jpg' }, caption: 'Caption' } })
await sock.sendMessage(jid, { groupStatus: { video: { url: 'https://example.com/video.mp4' }, caption: 'Caption' } })
await sock.sendMessage(jid, { groupStatus: { audio: { url: 'https://example.com/audio.mp3' }, ptt: false } })

// Via shorthand
await sock.sendGroupStatusMessage(groupJid, { text: 'Hello group!' })
await sock.sendGroupStatusMessage(groupJid, { image: { url: 'https://example.com/image.jpg' }, caption: 'Caption' })
await sock.sendGroupStatusMessage(groupJid, { image: buffer })
await sock.sendGroupStatusMessage(groupJid, { image: fs.readFileSync('./image.jpg') })
```

</details>

---

### Poll Messages

<details>
<summary><strong>Show poll message examples</strong></summary>

```javascript
// Standard poll
await sock.sendMessage(jid, {
  poll: {
    name: 'Favorite Color?',
    values: ['Red', 'Blue', 'Green'],
    selectableOptionsCount: 1,
    toAnnouncementGroup: false
  }
})

// Quiz poll — single correct answer
await sock.sendMessage(jid, {
  poll: {
    name: 'What is 2+2?',
    values: ['3', '4', '5'],
    selectableOptionsCount: 1,
    pollType: 1,       // 1 = quiz mode
    correctAnswer: '4'
  }
})

// Timed poll with hidden voter names
await sock.sendMessage(jid, {
  poll: {
    name: 'Quick vote!',
    values: ['Yes', 'No'],
    endTime: Math.floor(Date.now() / 1000) + 3600, // expires in 1 hour
    hideParticipantName: true,
    allowAddOption: false
  }
})

// Add a new option to an existing poll
await sock.sendMessage(jid, {
  pollAddOption: {
    pollCreationMessageKey: pollMsg.key,
    option: 'New Option',
  }
})

// Add option via proto passthrough
await sock.sendMessage(jid, {
  pollAddOptionMessage: {
    pollCreationMessageKey: existingPollMsg.key,
    addOption: { optionName: 'New Option' }
  }
})

// Manual poll vote update (usually handled internally)
await sock.sendMessage(jid, {
  pollUpdateMessage: {
    pollCreationMessageKey: pollMsg.key,
    vote: { encPayload: Buffer, encIv: Buffer },
    senderTimestampMs: Date.now(),
  }
})

// Poll builder shorthand
await sock.poll()
  .name('Favorite Color?')
  .options(['Red', 'Blue', 'Green'])
  .send(jid)
```

</details>

---

### Payment Messages

<details>
<summary><strong>Show payment message examples</strong></summary>

```javascript
// Request payment from a user
await sock.sendMessage(jid, {
  requestPayment: {
    amount: 5000,
    currency: 'NGN',
    note: 'Pay for order',
    from: '234xxx@s.whatsapp.net',
    expiry: Math.floor(Date.now() / 1000) + 86400, // expires in 24h
  }
})

// Via builder
await sock.payment()
  .setCurrency('NGN')
  .setAmount(10000000)
  .setFrom('1234567890@s.whatsapp.net')
  .setNote('Payment for order #123')
  .setExpiry(Date.now() + 86400000)
  .send(jid)

// Decline a payment request
await sock.sendMessage(jid, {
  declinePaymentRequest: { key: paymentMsg.key }
})

// Cancel a payment request
await sock.sendMessage(jid, {
  cancelPaymentRequest: { key: paymentMsg.key }
})

// Payment invite (UPI, PIX, etc.)
await sock.sendMessage(jid, {
  paymentInviteMessage: {
    serviceType: 3, // 1=FBPAY 2=NOVI 3=UPI 4=PIX
    expiryTimestamp: Math.floor(Date.now() / 1000) + 86400,
    incentiveEligible: false,
    inviteType: 0, // 0=DEFAULT 1=MAPPER
  }
})

// Payment reminder — recurring billing
await sock.sendMessage(jid, {
  paymentReminderMessage: {
    reminderId: 'rem_001',
    description: 'Monthly subscription',
    frequency: 3, // 1=WEEKLY 2=BI_WEEKLY 3=MONTHLY 4=QUARTERLY
    status: 1,    // 1=ACTIVE
    payeeJid: '234xxx@s.whatsapp.net',
    payerJid: '234yyy@s.whatsapp.net',
    amount: { value: 9900, offset: 2, currencyCode: 'NGN' }, // = ₦99.00
  }
})

// Payment receipt / confirmation
await sock.sendMessage(jid, {
  paymentDetailsMessage: {
    serviceType: 1,
    amount: { value: 5000, offset: 2, currencyCode: 'NGN' },
    payeeName: 'John Doe',
    payerName: 'Jane Doe',
    transactionTimestampMs: Date.now(),
    transactionId: 'TXN123456',
    status: 1, // 1=SUCCESS
  }
})

// Split payment update
await sock.sendMessage(jid, {
  splitPaymentUpdateMessage: {
    splitId: 'split_001',
    participantJid: '234xxx@s.whatsapp.net',
  }
})
```

</details>

---

### Event & Scheduled Calls

<details>
<summary><strong>Show event and scheduled call examples</strong></summary>

```javascript
// Event / calendar invite
await sock.sendMessage(jid, {
  eventMessage: {
    name: 'NexusTech Conference',
    description: 'Annual developer conference',
    location: { degreesLatitude: 6.5244, degreesLongitude: 3.3792, name: 'Lagos, Nigeria' },
    joinLink: 'https://meet.example.com/nexusconf',
    startTime: Math.floor(Date.now() / 1000) + 86400,
    endTime: Math.floor(Date.now() / 1000) + 172800,
    extraGuestsAllowed: true,
    hasReminder: true,
    reminderOffsetSec: 3600 // remind 1 hour before
  }
})

// Event invite message
await sock.sendMessage(jid, {
  eventInvite: {
    eventId: 'evt_001',
    eventTitle: 'Party Night',
    startTime: new Date('2026-12-01T20:00:00'),
    endTime: new Date('2026-12-02T02:00:00'),
    caption: 'You are invited!',
    jpegThumbnail: buffer,
  }
})

// Via builder
await sock.event()
  .setName('NexusTech Conference 2026')
  .setDescription('Annual developer meetup')
  .setLocation({ degreesLatitude: 6.5244, degreesLongitude: 3.3792, name: 'Lagos, Nigeria' })
  .setJoinLink('https://meet.example.com/nexusconf')
  .setStartTime(Math.floor(Date.now() / 1000) + 86400)
  .setEndTime(Math.floor(Date.now() / 1000) + 172800)
  .setReminder(3600)
  .send(jid)

// Scheduled call — create
await sock.sendMessage(jid, {
  scheduledCall: {
    scheduledTimestampMs: new Date('2026-12-01T10:00:00').getTime(),
    callType: 1, // 0=UNKNOWN 1=AUDIO 2=VIDEO
    title: 'Team Standup',
  }
})

// Scheduled call — cancel or edit
await sock.sendMessage(jid, {
  scheduledCallEdit: {
    key: scheduledCallMsg.key,
    editType: 1, // 0=UNKNOWN 1=CANCEL
  }
})
```

</details>

---

### Call Messages

<details>
<summary><strong>Show call message examples</strong></summary>

```javascript
// Initiate a call at protocol level
await sock.sendMessage(jid, {
  call: {
    callKey: Buffer.from(crypto.randomBytes(32)),
    contextInfo: {},
  }
})

// Call log — record a missed, received, or failed call
await sock.sendMessage(jid, {
  callLogMesssage: { // note: 3 s's — typo in proto definition
    isVideo: false,
    callOutcome: 2, // 1=CONNECTED 2=MISSED 3=REJECTED 4=FAILED
    durationSecs: 0,
    callType: 0,   // 0=REGULAR 1=ENCRYPTED
  }
})
```

</details>

---

### AI Rich Messages

<details>
<summary><strong>Overview & sendMessage API</strong></summary>

All types can be sent two ways:
- **`sock.sendMessage`** with an `aiRich` content key
- **`sock.airich()` builder** (fluent chain)

```javascript
// via sendMessage — everything in one object
await sock.sendMessage(jid, {
  aiRich: {
    parts: [
      { type: 'text', content: '## String Reversal' },
      { type: 'code', language: 'javascript', content: `const reverse = s => s.split('').reverse().join('')` },
      { type: 'text', content: 'Performance:' },
      { type: 'table', table: ['Benchmarks', ['Method', 'Ops/sec'], ['split.reverse.join', '1.2M'], ['manual loop', '2.1M']] },
      { type: 'sources', sources: [{ url: 'https://jsperf.app', displayName: 'JSPerf', subtitle: 'jsperf.app' }] }
    ],
    footer: '_zervonex_'
  }
}, { quoted: message })
```

**`aiRich` Options Reference:**

| Key | Type | Description |
|-----|------|-------------|
| `text` | `string` | Single markdown text block |
| `texts` | `string[]` | Multiple text blocks in order |
| `code` | `string \| { language, code }` | Single code block |
| `codes` | `Array` | Multiple code blocks |
| `language` | `string` | Default language for `code`/`codes` |
| `table` | `Array` | `[title, headers[], ...rows[]]` |
| `headers` + `rows` | `Array` | Alternative table format |
| `images` | `Array` | Grid images with `url`, `sourceUrl` |
| `sources` | `Array` | Search source cards |
| `reels` | `Array` | Horizontal reel cards |
| `latex` | `Array` | LaTeX expression objects |
| `latexText` | `string` | Text shown above latex |
| `parts` | `Array` | Composite ordered parts array |
| `header` | `string` | Text prepended before content |
| `footer` | `string` | Text appended after content |
| `botJid` | `string` | Custom bot JID |
| `responseId` | `string` | Custom response UUID |
| `forwarded` | `boolean` | Set `false` to disable forwarded context |
| `rawSections` | `Array` | Raw unified response sections (advanced) |
| `rawSubmessages` | `Array` | Matching submessages for `rawSections` |

</details>

<details>
<summary><strong>Builder — text, code, table, dividers, spacers</strong></summary>

```javascript
// Text, code and table
await sock.airich()
  .setTitle('zervonex Bot')
  .setFooter('Powered by @zervonex/baileys')
  .addText('*Welcome!*')
  .addCode('javascript', 'console.log("Hello from zervonex")')
  .addTable([
    ['Plan', 'Price', 'Sessions'],
    ['Basic', 'Free', '1'],
    ['Pro', '$9/mo', '10'],
    ['Enterprise', 'Custom', 'Unlimited']
  ])
  .send(jid)

// Dividers and spacers
await sock.airich()
  .addText('*Section A*')
  .addDivider()         // horizontal line
  .addText('*Section B*')
  .addDivider('DOT')    // dotted divider
  .addText('*Section C*')
  .addSpacer(3)         // 3-line blank gap
  .addText('*Section D*')
  .send(jid)

// Task queue
await sock.airich()
  .setTitle('Job Queue')
  .addTask({ taskId: 'task-1', title: 'Fetch data', subtitle: 'Calling API', status: 'DONE' })
  .addTask({ taskId: 'task-2', title: 'Process result', status: 'RUNNING' })
  .addTask({ taskId: 'task-3', title: 'Send response', status: 'PENDING' })
  .send(jid)

// Thinking / progress status
await sock.airich()
  .addThinkingStatus('Searching the web...', 'WEB_SEARCH')
  .addThinkingStatus('Thinking deeply...', 'THINKING')
  .addProgressStatus('Almost done — 80%', true)
  .addProgressStatus('Done!', false)
  .send(jid)
```

</details>

<details>
<summary><strong>LaTeX</strong></summary>

```javascript
// Via sendMessage
await sock.sendMessage(jid, {
  aiRich: {
    latexText: 'The quadratic formula:',
    latex: [
      { latexExpression: 'x = \\frac{-b \\pm \\sqrt{b^2 - 4ac}}{2a}', url: 'https://example.com/formula.png', width: 400, height: 80 }
    ]
  }
}, { quoted: message })

// Via builder
await sock.airich()
  .addText("Einstein's famous equation:")
  .addLatex({ expression: 'E = mc^2', imageUrl: 'https://example.com/emc2.png', width: 300, height: 60 })
  .send(jid)

// Via shorthand
await sock.sendLatex(jid, [
  { latexExpression: 'E = mc^2', url: 'https://example.com/emc2.png', width: 300, height: 60 }
], quoted, { text: 'Mass-energy equivalence:' })
```

> Note: LaTeX requires a pre-rendered image URL — WhatsApp does not render LaTeX client-side.

</details>

<details>
<summary><strong>Post & Product Cards, Map, Rich Map, Dynamic</strong></summary>

```javascript
// Post and product cards
await sock.airich()
  .addPost({
    title: 'zervonex v3.0.2 🚀',
    username: 'nexustechpro2',
    subtitle: 'GitHub',
    thumbnail_url: 'https://example.com/thumb.jpg',
    post_url: 'https://github.com/nexustechpro2',
    post_caption: 'New release — faster, smarter, better.',
    source_app: 'instagram',
    likes_count: 2048,
    comments_count: 128,
    is_verified: true
  })
  .addProduct({
    title: 'zervonex Premium',
    brand: 'zervonex',
    price: '$9.99/mo',
    sale_price: '$4.99/mo',
    product_url: 'https://github.com/nexustechpro2',
    image_url: 'https://example.com/product.jpg'
  })
  .send(jid)

// Map with markers
await sock.airich()
  .addText('Our location:')
  .addMap([{
    latitude: 6.5244,
    longitude: 3.3792,
    name: 'Lagos, Nigeria',
    address: 'Lagos Island, Lagos State'
  }])
  .send(jid)

// Rich map with annotations
await sock.airich()
  .addRichMap({
    centerLatitude: 6.5244,
    centerLongitude: 3.3792,
    annotations: [{ latitude: 6.5244, longitude: 3.3792, title: 'Here' }]
  })
  .send(jid)

// Or via shorthand
await sock.sendRichMap(jid, {
  centerLatitude: 6.5244,
  centerLongitude: 3.3792,
  annotations: [{ latitude: 6.5244, longitude: 3.3792, title: 'Here' }]
})

// Dynamic GIF
await sock.airich().addDynamic({ url: 'https://example.com/anim.gif', type: 'GIF' }).send(jid)
await sock.sendDynamic(jid, { url: 'https://example.com/anim.gif', type: 'GIF' })
```

</details>

<details>
<summary><strong>Suggest Prompts, Rich Label, Bot Plan</strong></summary>

```javascript
// Suggest prompts — pill row that sends a message when tapped
await sock.airich().addSuggestPrompts(['Tell me more', 'Show examples']).send(jid)
await sock.sendBotPromptSuggestions(jid, { text: 'What next?', suggestions: ['A', 'B'] })

// Rich label — status banner
await sock.sendRichLabel(jid, 'Success!', { variant: 'POSITIVE' })

// Bot plan / task breakdown
await sock.sendBotPlan(jid, {
  title: 'Plan',
  steps: [{ title: 'Step 1', status: 'executing' }, { title: 'Step 2', status: 'pending' }]
})

// Ask Meta AI directly
await sock.sendMetaAI(jid, 'What is Node.js?')
```

</details>

<details>
<summary><strong>Music Message</strong></summary>

```javascript
await sock.sendMessage(jid, {
  musicMessage: {
    embeddedMusic: {
      id: 'track_id',
      title: 'Song Title',
      artist: 'Artist Name',
      thumbnailUrl: 'https://example.com/thumb.jpg',
      streamUrl: 'https://example.com/stream.mp3',
    },
    songUri: 'spotify:track:xxx',
    artworkUri: 'https://example.com/artwork.jpg',
    style: 1,
    lyrics: {
      syncedLyrics: [
        { timeMs: 0, line: 'First line' },
        { timeMs: 3000, line: 'Second line' }
      ]
    },
  }
})
```

</details>

<details>
<summary><strong>Image Grid via AIRich</strong></summary>

```javascript
// Image grid via airich builder
await sock.airich().addGrid(['https://img1.jpg', 'https://img2.jpg', 'https://img3.jpg']).send(jid)
```

</details>

<details>
<summary><strong>Image Generation Placeholder</strong></summary>

```javascript
// Generation placeholder — shown while image is being created
await sock.airich()
  .addText('Generating your image...')
  .addImagine({ mediaType: 'image', status: 'GENERATING', estimatedMs: 5000 })
  .send(jid)

// Standalone generation message with itemId for later editing
const { msg, responseId, itemId } = await sock.sendRichGeneration(jid, {
  text: 'Generating...',
  mediaType: 'video',
  status: 'GENERATING',
  estimatedMs: 8000
})

// Later — edit that same message with the finished result
await sock.airich()
  .setResponseId(responseId)
  .addText('Here is your video!')
  .addImagine({ mediaType: 'video', url: 'https://example.com/result.mp4', status: 'READY' })
  .sendEdit(jid, msg.key.id)
```

</details>

<details>
<summary><strong>Load From / Edit / Capture / Relay</strong></summary>

```javascript
// Load an existing AIRich message back into the builder for editing
const r = sock.airich()
r.loadFrom(receivedMessage.message)
r.addText('Additional content added!')
await r.send(jid)

// Edit a sent AIRich message
const sent = await sock.airich().addText('Original text').send(jid)
await sock.airich()
  .addText('Updated text')
  .sendEdit(jid, sent.key.id)

// Capture a received AIRich message for forwarding
const captured = sock.captureAiRich(msg.message)

// Relay it to another JID
if (captured) await sock.relayAiRich(targetJid, captured)
```

</details>

<details>
<summary><strong>HTML Primitives</strong></summary>

#### `addHtml(html, trustedSources?, opts?)`

> [!WARNING] Uses an experimental primitive internally — treat as unstable.

```javascript
await sock.airich()
  .addText('Here is a live preview:')
  .addHtml('<h2>Hello</h2><p>This is <b>bold</b> and <em>italic</em>.</p>')
  .send(jid)
```

| Param | Type | Description |
|---|---|---|
| `html` | `string` | Raw HTML string to render |
| `trustedSources` | `string[]` | Allowed source origins for the HTML content |
| `opts` | `object` | `{ id, replace, insertAt }` |

#### `addRichHtml(tabs, title?, opts?)`

Renders a tabbed HTML panel.

```javascript
// Single string
await sock.airich()
  .addRichHtml('<p>Simple preview</p>')
  .send(jid)

// Single tab object
await sock.airich()
  .addRichHtml({ title: 'Result', html: '<h1>Done</h1>' }, 'Preview')
  .send(jid)

// Multi-tab panel
await sock.airich()
  .addRichHtml([
    { id: 'tab_preview', title: 'Preview', html: '<h1>Hello World</h1>' },
    { id: 'tab_code',    title: 'Source',  html: '<pre>&lt;h1&gt;Hello World&lt;/h1&gt;</pre>' },
    { id: 'tab_live',    title: 'Live',    html: '<p>Live</p>', url: 'https://example.com', trustedSources: ['https://example.com'] },
  ], 'My Panel')
  .send(jid)
```

</details>

<details>
<summary><strong>Named Node IDs</strong></summary>

```javascript
const r = sock.airich()
r.addText('Loading...', { id: 'status' })
r.addCode('js', '// placeholder', { id: 'code' })

// Later, replace specific nodes by id
r.addText('Done!', { replace: 'status' })
r.addCode('js', 'console.log("real code")', { replace: 'code' })

await r.send(jid)
```

</details>

<details>
<summary><strong>Full Combo Example</strong></summary>

```javascript
await sock.airich()
  .setTitle('zervonex Bot')
  .setFooter('Powered by @zervonex/baileys latest')
  .addText('*Welcome to zervonex!*')
  .addDivider()
  .addCode('python', 'print("Hello from zervonex")')
  .addTable([
    ['Plan', 'Price', 'Sessions'],
    ['Basic', 'Free', '1'],
    ['Pro', '$9/mo', '10'],
    ['Enterprise', 'Custom', 'Unlimited']
  ])
  .addTask({ taskId: 't1', title: 'Bot online', status: 'DONE' })
  .addMetadata('zervonex • v3.0.2 • 2026')
  .addSuggest(['View commands', 'Get support', 'Upgrade plan'])
  .addFooterAction({ cta_text: '📖 View Dashboard', cta_type: 'OPEN_URL', cta_url: 'https://github.com/nexustechpro2' })
  .addFOAText('_Reply with any message to continue_')
  .send(jid)
```

</details>

---

### Status & Stories

<details>
<summary><strong>Personal Status (status@broadcast)</strong></summary>

```javascript
// Text status
await sock.sendMessage('status@broadcast', { text: 'My status update!' })

// Image status
await sock.sendMessage('status@broadcast', { image: { url: 'https://example.com/image.jpg' }, caption: 'Caption' })

// Video status
await sock.sendMessage('status@broadcast', { video: { url: 'https://example.com/video.mp4' }, caption: 'Caption' })

// Audio status
await sock.sendMessage('status@broadcast', { audio: { url: 'https://example.com/audio.mp3' }, ptt: false })

// Send to specific contacts only
await sock.sendMessage('status@broadcast', {
  text: 'Private status',
  statusJidList: [
    '1234567890@s.whatsapp.net',
    '0987654321@s.whatsapp.net'
  ]
})

// sendStatus shorthand
await sock.sendStatus({ text: 'Good morning!' }, { statusJidList: ['jid@s.whatsapp.net'] })
await sock.sendStatus({ image: { url: 'https://...' }, caption: 'Caption' }, { statusJidList: [...] })
await sock.sendStatus({ video: { url: 'https://...' }, caption: 'Caption' }, { statusJidList: [...] })
```

</details>

<details>
<summary><strong>Audience Targeting, Add Yours, Status Reply</strong></summary>

```javascript
// Close friends / audience targeting
await sock.sendMessage('status@broadcast', {
  text: 'Close friends only',
  statusAudience: { audienceType: 1, listName: 'Close friends' }, // 1=CLOSE_FRIENDS
}, { broadcast: true, statusJidList: [...] })

// Add Yours response
await sock.sendMessage('status@broadcast', {
  image: { url: 'https://...' },
  addYours: parentStatus.key,
}, { broadcast: true, statusJidList: [...] })

// Status question answer
await sock.sendMessage(jid, {
  statusQuestionAnswer: { key: questionStatus.key, text: 'My answer' }
})

// Status quoted — reply to a status
await sock.sendMessage(jid, {
  statusQuoted: {
    originalStatusId: { id: 'statusMsgId', remoteJid: 'status@broadcast', fromMe: false },
    type: 1, // 1=QUESTION_ANSWER
    text: 'Reply text',
  }
})

// Status sticker interaction
await sock.sendMessage(jid, {
  statusStickerInteraction: {
    key: statusMsg.key,
    stickerKey: stickerMsg.key,
    type: 1, // 1=REACTION
  }
})
```

</details>

<details>
<summary><strong>React to a Status</strong></summary>

```javascript
// Via sendMessage
await sock.sendMessage('status@broadcast', {
  react: {
    text: '❤️',
    key: message.key // key of the status message
  }
}, {
  statusJidList: [message.key.participant] // person who posted the status
})

// Via sendReaction shorthand
await sock.sendReaction('status@broadcast', message.key, '❤️', {
  statusJidList: [message.key.participant]
})
```

</details>

<details>
<summary><strong>Status Mention (tag someone in your story)</strong></summary>

```javascript
// Text
await sock.sendStatusMentions({ text: 'Hey @someone check this out!' }, ['1234567890@s.whatsapp.net'])

// Image
await sock.sendStatusMentions({ image: { url: 'https://example.com/image.jpg' }, caption: 'Caption' }, ['1234567890@s.whatsapp.net'])

// Video
await sock.sendStatusMentions({ video: { url: 'https://example.com/video.mp4' } }, ['1234567890@s.whatsapp.net'])

// Audio
await sock.sendStatusMentions({ audio: { url: 'https://example.com/audio.mp3' }, ptt: true }, ['1234567890@s.whatsapp.net'])

// Tag an entire group — all members get notified
await sock.sendStatusMentions({ text: 'Hey group!' }, ['123456789@g.us'])
```

</details>

---

### Newsletter Messages

<details>
<summary><strong>Show newsletter message examples</strong></summary>

```javascript
// Newsletter follower invite
await sock.sendMessage(jid, {
  newsletterFollowerInvite: {
    newsletterJid: 'xxx@newsletter',
    newsletterName: 'My Channel',
    caption: 'Follow us!',
    jpegThumbnail: buffer,
  }
})

// Share newsletter on your status
await sock.sendMessage('status@broadcast', {
  text: 'Check this out',
  newsletterStatus: {
    newsletterJid: 'xxx@newsletter',
    messageId: 123,
    actionUrl: 'https://...',
  }
}, { broadcast: true, statusJidList: [...] })
```

</details>

---

### Comments

<details>
<summary><strong>Show comment examples</strong></summary>

Comment on a newsletter post or status message.

```javascript
// Text comment
await sock.sendMessage(jid, {
  comment: {
    targetMessageKey: msg.key,
    content: { text: 'Great post!' },
  }
})

// Comment with raw proto message
await sock.sendMessage(jid, {
  comment: {
    targetMessageKey: msg.key,
    message: { extendedTextMessage: { text: 'Great post!' } },
  }
})
```

</details>

---

### Sticker Pack

<details>
<summary><strong>Show sticker pack examples</strong></summary>

Send a full sticker pack. Supports buffers, file paths, and URLs. Packs over 60 stickers are automatically batched with a 2-second delay between batches.

```javascript
// Via sendMessage
await sock.sendMessage(jid, {
  stickerPack: {
    name: 'My Stickers',
    publisher: 'zervonex',
    stickers: [
      { data: buffer,                             emojis: ['😊'] },
      { data: './sticker.png',                    emojis: ['😂'] },
      { data: './sticker.webp',                   emojis: ['🎉'] },
      { data: './sticker.gif',                    emojis: ['✨'], isAnimated: true },
      { data: './sticker.webm',                   emojis: ['🎬'], isAnimated: true },
      { data: 'https://example.com/sticker.jpg',  emojis: ['❤️'] },
      { data: buffer, type: StickerTypes.ROUNDED, emojis: ['🔥'] },
    ],
    cover: coverBuffer // optional — defaults to first sticker
  }
}, { quoted: message })

// Via dedicated shorthand
await sock.stickerPackMessage(jid, {
  name: 'My Stickers',
  publisher: 'zervonex',
  stickers: [
    { data: buffer, emojis: ['😊'] },
    { data: './sticker.png', emojis: ['😂'] }
  ],
  cover: coverBuffer
}, { quoted: message })
```

**Premium Stickers:**

```javascript
// Single sticker as premium
await sock.sendMessage(jid, { sticker: buffer, premium: 1 })

// Per-sticker in a pack
await sock.sendMessage(jid, { stickerPack: { stickers: [{ data: buffer, emojis: ['🔥'], premium: 1 }] } })

// Whole pack as premium
await sock.sendMessage(jid, { stickerPack: { premium: 1, stickers: [...] } })
```

**Per-sticker options:**

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `data` | Buffer \| string | required | Buffer, file path, URL, or SVG string |
| `emojis` | string[] | `[]` | Associated emojis shown in sticker picker |
| `type` | StickerTypes | `ROUNDED` | Crop/shape style |
| `isAnimated` | boolean | `false` | Mark as animated (GIF/WebM inputs) |
| `isLottie` | boolean | `false` | Mark as Lottie animated (TGS inputs) |
| `accessibilityLabel` | string | `''` | Accessibility label |

**Sticker types (`StickerTypes`):**

| Value | Description |
|-------|-------------|
| `StickerTypes.DEFAULT` | Original aspect ratio, no crop |
| `StickerTypes.CROPPED` | Cropped to 512×512 |
| `StickerTypes.FULL` | Stretched to fill 512×512 |
| `StickerTypes.CIRCLE` | Circular mask |
| `StickerTypes.ROUNDED` | Rounded corners |

**Supported input formats:**

| Format | Support | Notes |
|--------|---------|-------|
| WebP | ✅ Full | Static and animated, passed through sharp |
| PNG | ✅ Full | Auto-converted to WebP |
| JPG/JPEG | ✅ Full | Auto-converted to WebP |
| BMP | ✅ Full | Auto-converted to WebP |
| SVG | ✅ Full | Rendered and converted to WebP |
| GIF | ✅ Animated | Converted to animated WebP via sharp |
| WebM (VP9) | ✅ Animated | Converted via ffmpeg → animated WebP |
| MP4 | ✅ Animated | Converted via ffmpeg → animated WebP |
| TGS | ✅ Animated | Telegram gzip-compressed Lottie — converted via rlottie WASM |

</details>

---

### Associated Flows

<details>
<summary><strong>Show associated flow examples</strong></summary>

Multi-message flows that send a parent message followed by linked child messages.
All media fields accept a `Buffer`, file path, URL string, or `{ url }` object.

```javascript
// Motion Photo — still image + short video clip
await sock.sendMessage(jid, {
  motionPhoto: {
    items: [
      { image: { url: 'https://example.com/still.jpg' } },
      { video: { url: 'https://example.com/motion.mp4' } }
    ]
  }
})

// Also supported — clean direct shape
await sock.sendMessage(jid, {
  motionPhoto: {
    image: { url: 'https://photo.jpg' },
    video: { url: 'https://motion.mp4' },
  }
})

// HD Video — SD version + HD version
await sock.sendMessage(jid, {
  hdVideoDualUpload: {
    items: [
      { video: { url: 'https://example.com/sd.mp4' } },
      { video: { url: 'https://example.com/hd.mp4' } }
    ]
  }
})

// HD Image — preview + HD version
await sock.sendMessage(jid, {
  hdImageDualUpload: {
    image: buffer,     // normal quality
    hdImage: buffer,   // HD version
  }
})

// Also supported — items[] shape
await sock.sendMessage(jid, {
  hdImageDualUpload: {
    items: [
      { image: { url: 'https://example.com/preview.jpg' } },
      { image: { url: 'https://example.com/hd.jpg' } }
    ]
  }
})

// HEVC Video — original + HEVC encoded
await sock.sendMessage(jid, {
  hevcVideoDualUpload: {
    items: [
      { video: { url: 'https://example.com/original.mp4' } },
      { video: { url: 'https://example.com/hevc.mp4' } }
    ]
  }
})

// AV1 Video — original + AV1 encoded
await sock.sendMessage(jid, {
  av1VideoDualUpload: {
    items: [
      { video: { url: 'https://example.com/original.mp4' } },
      { video: { url: 'https://example.com/av1.mp4' } }
    ]
  }
})

// Streamed HD Video — SD stream + HD stream
await sock.sendMessage(jid, {
  streamedHdVideoDualUpload: {
    items: [
      { video: { url: 'https://example.com/sd-stream.mp4' } },
      { video: { url: 'https://example.com/hd-stream.mp4' } }
    ]
  }
})

// Original Video — processed version + original
await sock.sendMessage(jid, {
  originalVideoDualUpload: {
    items: [
      { video: { url: 'https://example.com/processed.mp4' } },
      { video: { url: 'https://example.com/original.mp4' } }
    ]
  }
})

// Original Image — processed version + original
await sock.sendMessage(jid, {
  originalImageDualUpload: {
    items: [
      { image: { url: 'https://example.com/processed.jpg' } },
      { image: { url: 'https://example.com/original.jpg' } }
    ]
  }
})

// Media Album — group of images and videos
await sock.sendMessage(jid, {
  mediaAlbum: {
    items: [
      { image: { url: 'https://example.com/1.jpg' }, caption: 'First' },
      { image: { url: 'https://example.com/2.jpg' } },
      { video: { url: 'https://example.com/3.mp4' }, caption: 'Last' }
    ]
  }
})

// Image Poll — poll where each option has an image
await sock.sendMessage(jid, {
  poll: {
    name: 'Which looks better?',
    values: [
      { name: 'Option A', image: { url: 'https://example.com/a.jpg' } },
      { name: 'Option B', image: { url: 'https://example.com/b.jpg' } }
    ],
    selectableCount: 1
  }
})

// Event Cover Image — event message + cover photo
await sock.sendMessage(jid, {
  eventCoverImage: {
    items: [
      { event: { name: 'My Event', startDate: new Date(Date.now() + 86400_000), description: '...' } },
      { image: { url: 'https://example.com/cover.jpg' } }
    ]
  }
})

// Sticker Annotation — image with sticker overlaid
await sock.sendMessage(jid, {
  stickerAnnotation: {
    items: [
      { image: { url: 'https://example.com/photo.jpg' } },
      { sticker: { url: 'https://example.com/sticker.webp' } }
    ]
  }
})

// Status Poll — poll attached to a status
await sock.sendMessage('status@broadcast', {
  statusPoll: {
    items: [
      { poll: { name: 'Vote!', values: ['Yes', 'No'], selectableCount: 1 } },
      { image: { url: 'https://example.com/status-bg.jpg' } }
    ]
  }
})

// Status Add Yours — add yours sticker response
await sock.sendMessage('status@broadcast', {
  statusAddYours: {
    items: [
      { image: { url: 'https://example.com/status.jpg' } },
      { text: 'Add yours!' }
    ]
  }
})

// Attach child message to parent — manual association
await sock.sendMessage(jid, {
  text: 'Child message',
  messageAssociation: {
    parentMessageKey: parentMsg.key,
    associationType: 1, // 1=MEDIA_ALBUM
    messageIndex: 0,
  }
})
```

**Association Types:**

| Key | AssociationType | Description |
|-----|----------------|-------------|
| `motionPhoto` | 12 | Still image + short video clip |
| `hdVideoDualUpload` | 5 | SD video + HD version |
| `hdImageDualUpload` | 10 | Compressed image + HD version |
| `hevcVideoDualUpload` | 19 | Original video + HEVC encoded |
| `av1VideoDualUpload` | 21 | Original video + AV1 encoded |
| `streamedHdVideoDualUpload` | 22 | SD stream + HD stream |
| `originalVideoDualUpload` | 23 | Processed video + original |
| `originalImageDualUpload` | 24 | Processed image + original |
| `mediaAlbum` | 1 | Group of images and videos |
| `poll` (with images) | 7 | Poll where each option has an image |
| `eventCoverImage` | 3 | Event message + cover photo |
| `stickerAnnotation` | 11 | Image with sticker overlaid |
| `pollAddOptionMessage` | 20 | New option added to an existing poll |
| `statusPoll` | 4 | Poll attached to a status |
| `statusAddYours` | 8 | Add yours sticker response |
| `statusQuestion` | 16 | Question sticker on a status |
| `statusReaction` | 18 | Reaction to a status |
| `statusExternalReshare` | 6 | Reshared external content |
| `statusLinkAction` | 13 | Link action card on a status |
| `statusNotification` | 9 | Notification linked to a status |
| `statusAddYoursAiImagine` | 15 | AI-generated imagine response |
| `statusAddYoursDiwali` | 17 | Diwali themed add yours |
| `viewAllReplies` | 14 | Thread expansion |
| `botPlugin` | 2 | Bot plugin association |

</details>

---

### Fake Quoted Messages

<details>
<summary><strong>Show fake quote examples</strong></summary>

Fake a reply without an actual original message — useful for AI responses, status reposts, and custom UIs.

```javascript
// Text quote
await sock.sendMessage(jid, { text: 'Actual message' }, {
  quoted: {
    key: { remoteJid: jid, fromMe: false, id: 'FAKE_' + Date.now(), participant: '1234567890@s.whatsapp.net' },
    message: { conversation: 'Fake quoted text' }
  }
})

// Image quote
await sock.sendMessage(jid, { text: 'Replying to image' }, {
  quoted: {
    key: { remoteJid: jid, fromMe: false, id: 'FAKE_' + Date.now(), participant: '1234567890@s.whatsapp.net' },
    message: { imageMessage: { caption: 'Fake image caption' } }
  }
})

// Sticker quote
await sock.sendMessage(jid, { text: 'Replying to sticker' }, {
  quoted: {
    key: { remoteJid: jid, fromMe: false, id: 'FAKE_' + Date.now(), participant: '1234567890@s.whatsapp.net' },
    message: { stickerMessage: {} }
  }
})

// AI / Bot quote
await sock.sendMessage(jid, { text: 'My response' }, {
  quoted: {
    key: { remoteJid: jid, fromMe: true, id: 'FAKE_' + Date.now() },
    message: { extendedTextMessage: { text: 'AI generated this', title: 'NexusAI' } }
  }
})

// Status quote
await sock.sendMessage(jid, { text: 'Replying to your status!' }, {
  quoted: {
    key: { remoteJid: 'status@broadcast', fromMe: false, id: 'FAKE_' + Date.now(), participant: '1234567890@s.whatsapp.net' },
    message: { conversation: 'Original status text' }
  }
})
```

**Key Fields:**

| Field | Description |
|-------|-------------|
| `remoteJid` | Where the quoted message appears to be from (`jid`, `status@broadcast`, group, etc.) |
| `fromMe` | `true` = appears sent by you/bot, `false` = appears sent by someone else |
| `id` | Any unique string — `'FAKE_' + Date.now()` avoids collisions |
| `participant` | Required in groups/status — the person who appears to have sent it |

</details>

---

### Shorthand Wrappers

<details>
<summary><strong>Show all shorthand methods</strong></summary>

```javascript
// Basic message types
await sock.sendText(jid, 'Hello!', options)
await sock.sendImage(jid, { url: './image.jpg' }, 'Caption', options)
await sock.sendVideo(jid, buffer, 'Caption', options)
await sock.sendDocument(jid, { url: './file.pdf' }, 'Caption', options)
await sock.sendAudio(jid, { url: './audio.mp3' }, options)
await sock.sendLocation(jid, { degreesLatitude: 24.12, degreesLongitude: 55.11, name: 'Place' }, options)
await sock.sendPoll(jid, 'Question?', ['A', 'B', 'C'], false, options)
await sock.sendReaction(jid, message.key, '💖', options)
await sock.sendSticker(jid, { url: './sticker.webp' }, options)
await sock.sendContact(jid, { vcard }, options)
await sock.sendForward(jid, message, { force: true })

// AI Rich messages
await sock.sendCodeBlock(jid, code, quoted, { language, title, footer })
await sock.sendCodeBlockV2(jid, code, quoted, { language, title, text, footer })
await sock.sendTable(jid, title, headers, rows, quoted, { headerText, footer })
await sock.sendTableV2(jid, tableArray, quoted, { headerText, text, footer })
await sock.sendList(jid, title, items, quoted, { footer })
await sock.sendLink(jid, text, links, quoted, { headerText, footer, botJid })
await sock.sendLinkV2(jid, text, links, quoted, { headerText, footer, searchEngine })
await sock.sendLatex(jid, expressions, quoted, { text, headerText, footer })
await sock.sendRichMessage(jid, data, quoted)
await sock.sendAlbumMessage(jid, items, quoted)
await sock.sendGroupStatusMessage(jid, content)
await sock.sendRichGeneration(jid, { text, mediaType, status, estimatedMs })
await sock.sendUnifiedResponse(jid, sections, submessages, options)
await sock.sendVerticalAlbumMessage(jid, { items: [...] })
await sock.sendGridImageMessage(jid, { imageUrls: [...] })
await sock.sendVideoGridMessage(jid, { videos: [...] })
await sock.sendA2UI(jid, components, opts)
await sock.sendA2UIMessage(jid, { bloksWidget, nativeFlowMessage })
await sock.sendA2UICommandMenu(jid, { title, rows, buttons, footer, image })
```

</details>

---

## ✏️ Message Modifications

<details>
<summary><strong>Show message modification examples</strong></summary>

```javascript
// Edit a sent message
await sock.sendMessage(jid, { text: 'Updated text', edit: originalMessage.key })

// Delete for everyone
const sent = await sock.sendMessage(jid, { text: 'hello' })
await sock.sendMessage(jid, { delete: sent.key })

// Pin (time in seconds: 86400=24h, 604800=7d, 2592000=30d)
await sock.sendMessage(jid, { pin: { type: 1, time: 86400, key: message.key } })

// Unpin
await sock.sendMessage(jid, { pin: { type: 0, time: 0, key: message.key } })
```

</details>

---

## 📥 Media Download

<details>
<summary><strong>Show media download examples</strong></summary>

```javascript
import { downloadMediaMessage, getContentType } from '@zervonex/baileys'

sock.ev.on('messages.upsert', async ({ messages }) => {
  const msg = messages[0]
  if (!msg.message) return

  const type = getContentType(msg.message)

  if (type === 'imageMessage') {
    const buffer = await downloadMediaMessage(
      msg,
      'buffer',
      {},
      { logger, reuploadRequest: sock.updateMediaMessage }
    )
    fs.writeFileSync('./downloaded.jpg', buffer)
  }
})

// Re-upload expired media
await sock.updateMediaMessage(msg)
```

</details>

---

## 👥 Group Management

<details>
<summary><strong>Standard Groups</strong></summary>

```javascript
// Create group
const group = await sock.groupCreate('Group Name', ['1234567890@s.whatsapp.net'])

// Add / Remove / Promote / Demote participants
await sock.groupParticipantsUpdate(groupJid, ['1234567890@s.whatsapp.net'], 'add')
await sock.groupParticipantsUpdate(groupJid, ['1234567890@s.whatsapp.net'], 'remove')
await sock.groupParticipantsUpdate(groupJid, ['1234567890@s.whatsapp.net'], 'promote')
await sock.groupParticipantsUpdate(groupJid, ['1234567890@s.whatsapp.net'], 'demote')

// Update group info
await sock.groupUpdateSubject(groupJid, 'New Group Name')
await sock.groupUpdateDescription(groupJid, 'New description')

// Settings
await sock.groupSettingUpdate(groupJid, 'announcement')      // only admins can send
await sock.groupSettingUpdate(groupJid, 'not_announcement')  // everyone can send
await sock.groupSettingUpdate(groupJid, 'locked')            // only admins edit info
await sock.groupSettingUpdate(groupJid, 'unlocked')          // everyone edits info

// Metadata and invite management
const metadata = await sock.groupMetadata(groupJid)
const code = await sock.groupInviteCode(groupJid)
console.log(`https://chat.whatsapp.com/${code}`)

await sock.groupRevokeInvite(groupJid)
await sock.groupRevokeInviteV4(groupJid, '1234567890@s.whatsapp.net')
await sock.groupAcceptInvite('INVITE_CODE')
await sock.groupLeave(groupJid)
```

</details>

<details>
<summary><strong>AI Groups</strong></summary>

WhatsApp AI Groups are a special group type with Meta AI built-in as a participant.

```javascript
// Create an AI group
const group = await sock.aiGroupCreate('AI Study Group', ['1234567890@s.whatsapp.net'])

// Get AI group metadata
const metadata = await sock.aiGroupMetadata(groupJid)

// Add the Meta AI bot to an existing AI group
await sock.aiGroupAddBot(groupJid)

// Participant management
await sock.aiGroupParticipantsUpdate(groupJid, ['1234567890@s.whatsapp.net'], 'add')
await sock.aiGroupParticipantsUpdate(groupJid, ['1234567890@s.whatsapp.net'], 'remove')
await sock.aiGroupParticipantsUpdate(groupJid, ['1234567890@s.whatsapp.net'], 'promote')
await sock.aiGroupParticipantsUpdate(groupJid, ['1234567890@s.whatsapp.net'], 'demote')

// Update subject
await sock.aiGroupUpdateSubject(groupJid, 'New AI Group Name')

// Invite management
const code = await sock.aiGroupInviteCode(groupJid)
await sock.aiGroupRevokeInvite(groupJid)
await sock.aiGroupAcceptInvite('INVITE_CODE')
await sock.aiGroupLeave(groupJid)

// Settings
await sock.aiGroupSettingUpdate(groupJid, 'announcement')

// Ephemeral messages
await sock.aiGroupToggleEphemeral(groupJid, 86400) // 24h
await sock.aiGroupToggleEphemeral(groupJid, 0)     // disable
```

</details>

---

## 📱 User Operations

<details>
<summary><strong>Basic User Operations</strong></summary>

```javascript
// Check if a number exists on WhatsApp
const [result] = await sock.onWhatsApp('1234567890')
if (result?.exists) console.log(result.jid)

// Profile picture
const url = await sock.profilePictureUrl(jid, 'image') // 'image' = HD
await sock.updateProfilePicture(jid, { url: './profile.jpg' })
await sock.removeProfilePicture(jid)

// Status and name
const status = await sock.fetchStatus(jid)
await sock.updateProfileStatus('Available 24/7')
await sock.updateProfileName('My Bot')

// Business profile
const biz = await sock.getBusinessProfile(jid)

// Presence — composing, recording, online, etc.
await sock.presenceSubscribe(jid)
await sock.sendPresenceUpdate('composing', jid) // available | unavailable | composing | recording | paused

// Mark messages as read
await sock.readMessages([message.key])

// Block / Unblock a contact
await sock.updateBlockStatus(jid, 'block')
await sock.updateBlockStatus(jid, 'unblock')

// Fetch blocklist
const blocked = await sock.fetchBlocklist()
```

</details>

<details>
<summary><strong>Usernames</strong></summary>

```javascript
// Check if a username is available
const result = await sock.checkUsername('zervonex')
// { available: true, username: 'zervonex', session_id: '...' }
// { available: false, suggestions: ['zervonex1', 'zervonex_'], ... }

// Check multiple usernames at once
const results = await sock.checkUsernameMulti(['zervonex', 'zervonex2'])

// Set your username
await sock.setUsername('zervonex')
await sock.setUsername('zervonex', { pin: '1234' })

// Check availability then set in one call
await sock.checkAndSetUsername('zervonex')

// Get your current username
const username = await sock.getMyUsername()

// Delete your username
await sock.deleteUsername()

// Set a PIN on your username
await sock.setUsernamePin('1234')

// Find a user by their @username
const user = await sock.findUserByUsername('zervonex')
const userPinProtected = await sock.findUserByUsername('zervonex', '1234')

// Fetch usernames of multiple contacts
const list = await sock.fetchContactUsernames('1234567890@s.whatsapp.net', '0987654321@s.whatsapp.net')

// Get username suggestions from WhatsApp
const suggestions = await sock.getUsernameRecommendations()
```

</details>

<details>
<summary><strong>Extended Privacy (MEX-based)</strong></summary>

```javascript
// Update your About/bio text with optional emoji
await sock.updateTextStatus('Available for chats', '👋')

// Get About text of multiple contacts
const statuses = await sock.getTextStatusList(['1234567890@s.whatsapp.net'])

// Fetch profile picture info for a user
const info = await sock.fetchUserPictureInfo('1234567890@s.whatsapp.net')

// Set profile picture via MEX
await sock.setProfilePictureMex(imageBase64)

// Trusted devices
const devices = await sock.getTrustedDevices()
await sock.addTrustedDevice('device_id', 'My Laptop')
await sock.untrustTrustedDevice('device_id')
await sock.deleteTrustedDevice('device_id')

// Multi-account linking
await sock.addMultiAccountLink('1234567890')
await sock.revokeMultiAccount('1234567890@s.whatsapp.net')

// Check if contacts/businesses are valid WA users
const contacts = await sock.contactIntegrityQuery(['1234567890@s.whatsapp.net'])
const businesses = await sock.bizIntegrityQuery(['1234567890@s.whatsapp.net'])

// Link / unlink Facebook or Instagram profile
await sock.linkedProfilesSet([{ type: 'FB', username: 'myprofile' }])
await sock.linkedProfilesRemove(['FB'])
await sock.linkedProfilesUpdate([{ type: 'FB', showOnProfile: true }])

// Migrate blocklist to LID system
await sock.migrateBlocklistLid(['1234567890@s.whatsapp.net'])

// Notify group members of your push name
await sock.notifyPushName(groupJid, [{ jid: '1234567890@s.whatsapp.net', pushName: 'John' }])
```

</details>

---

## 🔍 Check Number Status

<details>
<summary><strong>Show number status checker examples</strong></summary>

```javascript
// Via socket instance
const result = await sock.checkStatusWA('1234567890')

// Or direct import — no socket needed
import { checkStatusWA } from '@zervonex/baileys'
const result = await checkStatusWA('1234567890')

// Active number response
// { number: '+1234567890', status: 'active', isBanned: false, isNeedOfficialWa: false, banInfo: null }

// Banned number response
{
  number: '+1234567890',
  status: 'banned',
  isBanned: true,
  banInfo: {
    banType: 'temporary',  // 'temporary' | 'permanent'
    violationType: '2',
    violationReason: 'Type 2',
    canAppeal: true,       // false if permanent ban
    appealToken: 'xxxxx',
    banTime: 1716840000,
    banDate: '2024-05-28T00:00:00.000Z',
    appealStatus: 'PENDING',
    appealCreatedAt: '2024-05-27T00:00:00.000Z'
  }
}

// Usage example
import { checkStatusWA } from '@zervonex/baileys'
const check = await checkStatusWA('1234567890')
if (check.isBanned) {
  console.log(`Banned: ${check.banInfo.banType}`)
  if (check.banInfo.canAppeal) console.log(`Appeal token: ${check.banInfo.appealToken}`)
} else {
  console.log(`Status: ${check.status}`)
}
```

</details>

---

## 🔒 Privacy Controls

<details>
<summary><strong>Show privacy control examples</strong></summary>

```javascript
const settings = await sock.fetchPrivacySettings()

// Last seen: 'all' | 'contacts' | 'contact_blacklist' | 'none'
await sock.updateLastSeenPrivacy('contacts')

// Online: 'all' | 'match_last_seen'
await sock.updateOnlinePrivacy('all')

// Profile picture: 'all' | 'contacts' | 'contact_blacklist' | 'none'
await sock.updateProfilePicturePrivacy('contacts')

// Status: 'all' | 'contacts' | 'contact_blacklist' | 'none'
await sock.updateStatusPrivacy('contacts')

// Read receipts: 'all' | 'none'
await sock.updateReadReceiptsPrivacy('all')

// Groups add: 'all' | 'contacts' | 'contact_blacklist'
await sock.updateGroupsAddPrivacy('contacts')
```

</details>

<details>
<summary><strong>Reporting</strong></summary>

```javascript
// Report spam — works on any JID (contact or group)
// Rich report with full message metadata — requires at least one received message
await sock.reportSpam(jid)

// Report spam with options
await sock.reportSpam(jid, {
  spamFlow: 'ACCOUNT_INFO_REPORT', // report flow type
  maxMessages: 5,                  // max messages to include in report
  messages: [...]                  // optional — manual message list, skips auto-lookup
})

// Report a contact — also blocks the contact automatically
await sock.reportContact(jid)
await sock.reportContact(jid, [message.key, message2.key])

// Report a group — also leaves the group automatically
await sock.reportGroup(groupJid)
await sock.reportGroup(groupJid, [message.key, message2.key])
```

| Method | Works On | Auto-Blocks | Auto-Leaves | Detailed Report |
|--------|----------|-------------|-------------|-----------------|
| `reportSpam` | Contacts & Groups | ❌ | ❌ | ✅ |
| `reportContact` | Contacts only | ✅ | ❌ | ❌ |
| `reportGroup` | Groups only | ❌ | ✅ | ❌ |

</details>

<details>
<summary><strong>Reporting Info Store</strong></summary>

```javascript
// Get stored reporting info for a JID (used internally by reportSpam)
const info = sock.getStoredReportingInfo(jid)
const limited = sock.getStoredReportingInfo(jid, 3) // max 3 entries

// Clear stored reporting info for a JID
sock.clearStoredReportingInfo(jid)

// Access available spam flow types
console.log(sock.SPAM_FLOWS)
```

</details>

---

## 💬 Chat Operations

<details>
<summary><strong>Show chat operation examples</strong></summary>

```javascript
const lastMsg = await getLastMessageInChat(jid) // implement with your store

// Archive / Unarchive
await sock.chatModify({ archive: true, lastMessages: [lastMsg] }, jid)

// Mute for 8 hours (in ms)
await sock.chatModify({ mute: 8 * 60 * 60 * 1000 }, jid)

// Unmute
await sock.chatModify({ mute: null }, jid)

// Pin / Unpin
await sock.chatModify({ pin: true }, jid)
await sock.chatModify({ pin: false }, jid)

// Delete chat
await sock.chatModify({ delete: true, lastMessages: [{ key: lastMsg.key, messageTimestamp: lastMsg.messageTimestamp }] }, jid)

// Mark read / unread
await sock.chatModify({ markRead: true }, jid)
await sock.chatModify({ markRead: false }, jid)
```

</details>

---

## 📢 Newsletter / Channels

<details>
<summary><strong>Create & Manage</strong></summary>

```javascript
// Create a channel
const channel = await sock.newsletterCreate('Channel Name', 'Channel description')
console.log(channel.id) // newsletter jid

// Fetch channel metadata by invite code or jid
const meta = await sock.newsletterMetadata('invite', 'INVITE_CODE')
const meta2 = await sock.newsletterMetadata('jid', newsletterJid)

// Update channel info
await sock.newsletterUpdate(newsletterJid, { name: 'New Name' })
await sock.newsletterUpdate(newsletterJid, { description: 'New description' })
await sock.newsletterUpdate(newsletterJid, { picture: buffer })

// Shorthand update helpers
await sock.newsletterUpdateName(newsletterJid, 'New Name')
await sock.newsletterUpdateDescription(newsletterJid, 'New description')
await sock.newsletterUpdatePicture(newsletterJid, buffer)
await sock.newsletterRemovePicture(newsletterJid)

// Update reaction settings — 'ALL' | 'BASIC' | 'NONE' | 'BLOCKLIST'
await sock.newsletterUpdateReactions(newsletterJid, 'ALL')

// Delete channel
await sock.newsletterDelete(newsletterJid)

// Change channel owner
await sock.newsletterChangeOwner(newsletterJid, newOwnerJid)

// Demote an admin
await sock.newsletterDemote(newsletterJid, userJid)
```

</details>

<details>
<summary><strong>Follow / Unfollow, Mute</strong></summary>

```javascript
await sock.newsletterFollow(newsletterJid)
await sock.newsletterUnfollow(newsletterJid)

// Get all subscribed channels
const subscribed = await sock.newsletterSubscribed()

// Subscribe to live updates for a channel
const sub = await sock.subscribeNewsletterUpdates(newsletterJid)
console.log(sub.duration)

// Mute / Unmute
await sock.newsletterMute(newsletterJid)
await sock.newsletterUnmute(newsletterJid)

// Fine-grained mute control
await sock.newsletterUpdateUserSetting(newsletterJid, 'FOLLOWER_NOTIFICATIONS', true)
await sock.newsletterUpdateUserSetting(newsletterJid, 'ADMIN_NOTIFICATIONS', false)
```

</details>

<details>
<summary><strong>Admin Management</strong></summary>

```javascript
// Get admin count and info
const count = await sock.newsletterAdminCount(newsletterJid)
const adminInfo = await sock.newsletterAdminInfo(newsletterJid)
console.log(adminInfo.adminCount, adminInfo.adminProfile, adminInfo.adminProfilesEnabled)

// Get admin capabilities
const capabilities = await sock.newsletterAdminCapabilities(newsletterJid)

// Check if you can post status
const { canPost, canPostMusic, capabilities: caps } = await sock.newsletterCanPostStatus(newsletterJid)

// Admin invites
await sock.newsletterCreateAdminInvite(newsletterJid, userJid)
await sock.newsletterRevokeAdminInvite(newsletterJid, userJid)
await sock.newsletterAcceptAdminInvite(newsletterJid)

// List pending admin invites
const pending = await sock.newsletterPendingAdminInvites(newsletterJid)
```

</details>

<details>
<summary><strong>Messages & Reactions</strong></summary>

```javascript
// Fetch recent messages
const messages = await sock.newsletterFetchMessages(newsletterJid, 20)

// Fetch with pagination
const older = await sock.newsletterFetchMessages(newsletterJid, 20, undefined, lastServerId)

// Fetch message updates (reactions, view counts, etc.)
const updates = await sock.newsletterFetchMessageUpdates(newsletterJid, { count: 20 })
const paged = await sock.newsletterFetchMessageUpdates(newsletterJid, { count: 20, before: serverId })

// Pin / unpin messages
await sock.newsletterPinMessages(newsletterJid, serverId)
await sock.newsletterPinMessages(newsletterJid, [serverId1, serverId2])
await sock.newsletterUnpinMessages(newsletterJid, serverId)

// Label AI-generated content
await sock.newsletterLabelAiContent(newsletterJid, serverId)

// Label paid partnership
await sock.newsletterLabelPaidPartnership(newsletterJid, serverId)

// Single reaction on a message
await sock.newsletterReactMessage(newsletterJid, serverId, '❤️')

// Remove a reaction
await sock.newsletterReactMessage(newsletterJid, serverId, null)

// Bulk reactions — single emoji, 10 times
await sock.newsletterBulkReactions(newsletterJid, serverId, '❤️', 10)

// Bulk reactions — cycle through multiple emojis (❤️ 🔥 ❤️ 🔥...), 20 total
await sock.newsletterBulkReactions(newsletterJid, serverId, ['❤️', '🔥'], 20)

// Bulk reactions — random emoji each time, 20 total
await sock.newsletterBulkReactions(newsletterJid, serverId, ['❤️', '🔥', '😂'], 20, { mode: 'random' })

// Bulk reactions — 10 of EACH emoji (30 total)
await sock.newsletterBulkReactions(newsletterJid, serverId, ['❤️', '🔥', '😂'], 10, { mode: 'each' })

// Fake reactions (local events only, not sent to server)
await sock.newsletterBulkReactions(newsletterJid, serverId, ['❤️', '🔥'], 100, { fake: true })

// Custom delay between reactions (default: 100ms)
await sock.newsletterBulkReactions(newsletterJid, serverId, '🔥', 50, { delayMs: 200 })

// Get who reacted to a message
const reactionSenders = await sock.newsletterReactionSenders(newsletterJid, serverId)
```

</details>

<details>
<summary><strong>Status Publishing & Management</strong></summary>

```javascript
// Send a text status
await sock.newsletterSendStatus(newsletterJid, { text: 'Hello from channel!' })

// Send an image status
await sock.newsletterSendStatus(newsletterJid, { image: buffer, caption: 'Caption here' })

// Send a video status
await sock.newsletterSendStatus(newsletterJid, { video: buffer, caption: 'Caption here' })

// Send an audio status
await sock.newsletterSendStatus(newsletterJid, { audio: buffer })

// Send a question on top of media
await sock.newsletterSendStatus(newsletterJid, { image: buffer, question: true })

// Send a question response (text reply to a question)
await sock.newsletterSendStatus(newsletterJid, { text: 'My answer' }, {
  interactionType: 'question_response',
  parentServerId: questionServerId
})

// Mark status as AI-generated
await sock.newsletterSendStatus(newsletterJid, { text: 'AI content' }, { aiContent: true })

// Access the server id from the result
const sent = await sock.newsletterSendStatus(newsletterJid, { text: 'Hello' })
console.log(sent.newsletterStatusServerId) // use this for reactions, pins, etc.

// React to a status
await sock.newsletterReactStatus(newsletterJid, serverId, '❤️')

// Remove a status reaction
await sock.newsletterReactStatus(newsletterJid, serverId, null)

// Revoke / delete a status
await sock.newsletterRevokeStatus(newsletterJid, statusId)

// Fetch published statuses
const statuses = await sock.newsletterFetchStatus(newsletterJid, { count: 20 })
const before = await sock.newsletterFetchStatus(newsletterJid, { count: 20, before: serverId })
const after = await sock.newsletterFetchStatus(newsletterJid, { count: 20, after: serverId })
```

</details>

<details>
<summary><strong>Poll Votes, Questions, Analytics, Discovery</strong></summary>

```javascript
// Vote on a poll
await sock.newsletterSendPollVote(newsletterJid, serverId, 'Option A')
await sock.newsletterSendPollVote(newsletterJid, serverId, ['Option A', 'Option B']) // multi-vote

// Get poll voters
const voters = await sock.newsletterPollVoters(newsletterJid, serverId, { limit: 100 })
const forOption = await sock.newsletterPollVoters(newsletterJid, serverId, { voteHash: 'abc123' })

// Fetch responses to a question status
const responses = await sock.newsletterQuestionResponses(newsletterJid, serverId, { count: 20 })
const filtered = await sock.newsletterQuestionResponses(newsletterJid, serverId, { filter: 'starred' })
const searched = await sock.newsletterQuestionResponses(newsletterJid, serverId, { searchText: 'hello' })

// Update response state — e.g. star, reply
await sock.newsletterQuestionResponseState(newsletterJid, serverId, responseServerId, 'STARRED')

// Analytics and insights
const insights = await sock.newsletterInsights(newsletterJid)
const custom = await sock.newsletterInsights(newsletterJid, { metrics: ['NET_FOLLOWS', 'UNFOLLOWS', 'IMPRESSIONS'] })

// Get enforcements (violations, suspensions, etc.)
const enforcements = await sock.newsletterEnforcements(newsletterJid)
const { adminProfiles, profilePictureDeletions, suspensions, violatingMessages, geoSuspensions } = enforcements

// Get all your channel reports
const reports = await sock.newsletterReports()

// Appeal a report
await sock.newsletterAppealReport(reportId, 'REASON_HERE')

// Browse recommended channels
const recommended = await sock.newsletterRecommended({ limit: 20 })
const local = await sock.newsletterRecommended({ countryCodes: ['NG', 'US'] })

// Search channels
const results = await sock.newsletterDirectorySearch('football', { limit: 20 })

// Browse directory
const directory = await sock.newsletterDirectoryList({ view: 'RECOMMENDED', limit: 20 })
const byCountry = await sock.newsletterDirectoryList({ countryCodes: ['NG'], categories: ['SPORTS'] })

// Browse categories
const categories = await sock.newsletterDirectoryCategories({ perCategoryLimit: 10 })

// Find similar channels
const similar = await sock.newsletterSimilar(newsletterJid, { limit: 20 })
```

</details>

---

## 🔧 Builder API

All builders can be used as a fluent chain. Call `.send(jid)` to send, or `.build(jid)` to get the proto message without sending.

<details>
<summary><strong>AIRich Builder</strong></summary>

```javascript
const r = sock.airich()           // create a new builder
r.setTitle('Title')               // shown in message metadata
r.setFooter('© zervonex')        // shown below content
r.setBotJid('867051314767696@bot') // custom bot JID
r.setResponseId('my-id')         // fix response ID (disables auto-refresh)
r.setContextInfo({ ... })        // custom contextInfo fields

// Content methods — all chainable, all accept { id, replace, insertAt } opts
r.addText('hello **world**')
r.addCode('javascript', 'console.log("hi")')
r.addTable([['Header1', 'Header2'], ['R1C1', 'R1C2']])
r.addImage('https://example.com/image.jpg')
r.addVideo('https://example.com/video.mp4')
r.addReels([{ creator, avatar_url, thumbnail_url, reels_url }])
r.addPost({ title, username, thumbnail_url, post_url, source_app, likes_count, is_verified })
r.addProduct({ title, brand, price, sale_price, product_url, image_url })
r.addSource([{ title, url, favicon }])
r.addMap([{ latitude, longitude, name, address }])
r.addWidget(ctas, title)         // ctas: [{ label, tool_call_id, kind, toast }]
r.addFooterAction({ cta_text, cta_type, cta_url })
r.addMetadata('small info text')
r.addFOAText('# Heading\n## Subheading')
r.addTip('Tip callout text')
r.addDivider()                   // or addDivider('DOT') for dotted line
r.addSpacer(2)                   // spacing: number of blank lines
r.addThinkingStatus('title', 'THINKING') // icons: THINKING | WEB_SEARCH | META_SEARCH
r.addProgressStatus('title', true)       // true = in progress, false = done
r.addTask({ taskId, title, subtitle, status })  // status: PENDING | RUNNING | DONE
r.addLatex({ expression, imageUrl, width, height, fontHeight, padding })
r.addGenerating('GENERATING')    // image generation placeholder
r.addInlineImage('url', 'center') // alignment: center | left | right
r.addHtml('<h2>Hello</h2>')      // trustedSources: optional string[]
r.addRichHtml('<p>Preview</p>', 'Preview')
r.addSuggest(['Pill 1', 'Pill 2'], false) // false = action row, true = hscroll
r.addSection(rawSectionObject)   // raw section for advanced use
r.addEmbeddedScreen(screenObject) // embedded tabbed panel
r.addRawSections(sections, submessages)  // escape hatch — raw unified sections

// Special methods
r.loadFrom(msg)                  // load existing AIRich message for editing
await r.send(jid, opts)          // send
await r.sendEdit(jid, targetId)  // edit a previously sent message

// Standalone helpers
await sock.sendRichGeneration(jid, { text, mediaType, url, status, estimatedMs, itemId, responseId })
await sock.sendUnifiedResponse(jid, sections, submessages, options)
```

</details>

<details>
<summary><strong>Button Builder</strong></summary>

```javascript
const b = sock.button()

// Text content
b.setTitle('Menu')
b.setSubtitle('Choose an option')
b.setBody('What would you like to do?')
b.setFooter('© Zervonex')

// Header — pick one
b.setImage('https://example.com/image.jpg')
b.setVideo('https://example.com/video.mp4')
b.setDocument('https://example.com/file.pdf', 'file.pdf')
b.setText('Header text')
b.setLocation(6.5244, 3.3792, 'Lagos', { address: 'Lagos Island', thumbnail: buffer })
b.setLocationHeader(6.5244, 3.3792, 'Lagos') // legacy header — buttons render horizontally

// Native-flow buttons
b.reply('Quick Reply', 'reply_id')
b.url('Visit Website', 'https://zervonex.com')
b.url('Visit Website', 'https://zervonex.com', 'https://merchant.com') // with merchant URL
b.call('Call Us', '+2341234567890')
b.copy('Copy Code', 'NEXUS2025')
b.openWebview('Open App', 'https://app.zervonex.com')
b.catalog('View Catalog')
b.flow('Start Flow', 'flow_id_here')
b.flow('Start Flow', 'flow_id_here', { token: 'custom_token' })
b.remind('Set Reminder')
b.cancelReminder('Cancel Reminder')
b.address('Share Address')
b.sendLocation('Share Location')
b.reviewAndPay('Review & Pay')
b.reviewOrder('Review Order')
b.orderDetails('Order Details')
b.paymentStatus('Payment Status')
b.transactionDetails('Transaction Details')
b.select('Choose Option', [
  { title: 'Section Title', rows: [{ title: 'Option 1', description: 'optional', id: 'opt1' }] }
])

// Legacy buttons — renders side by side, max 3
b.legacyButton('Button 1', 'btn1_id')
b.legacyButton('Button 2', 'btn2_id')
b.legacyButton('Button 3', 'btn3_id')

// Template buttons
b.templateReply('Quick Reply', 'reply_id')
b.templateUrl('Visit', 'https://zervonex.com')
b.templateCall('Call', '+2341234567890')

// Message-level params
b.setParams({ key: 'value' })
b.setLimitedTimeOffer(Date.now() + 3600000)
b.setBottomSheet({ title: 'Select' })
b.setTapTargetConfiguration({ dismissible: true })

// Convert to carousel card
const card = b.toCard()

// Send
await b.send(jid)
await b.send(jid, { messageId: 'custom_id' })
```

</details>

<details>
<summary><strong>Carousel Builder</strong></summary>

```javascript
const c = sock.carousel()

c.setCaption('Our Products')
c.setFooter('Powered by zervonex')
c.setCardType('HSCROLL_CARDS') // 'HSCROLL_CARDS' (default) | 'ALBUM_IMAGE'

// Add cards — pass a Button builder instance or a raw card object (max 10 cards)
c.card(sock.button().setBody('Card 1').reply('Select', 'card1').url('Learn More', 'https://example.com'))
c.card(sock.button().setImage('https://example.com/img.jpg').setBody('Card 2').reply('Select', 'card2'))

await c.send(jid)
```

</details>

<details>
<summary><strong>Album Builder</strong></summary>

```javascript
const a = sock.album()

// Add items — URLs, Buffers, or file paths
a.image('https://example.com/1.jpg', 'Caption for photo 1')
a.image(buffer, 'Caption for photo 2')
a.video('https://example.com/video.mp4', 'Caption for video')
a.add([  // add multiple at once
  { image: { url: 'https://example.com/3.jpg' }, caption: 'Photo 3' },
  { video: { url: 'https://example.com/4.mp4' }, caption: 'Video 2' }
])

a.setDelay(1500) // ms between each item send (default: 1500)

// Requires at least 2 items
await a.send(jid)
```

</details>

<details>
<summary><strong>VerticalAlbum Builder</strong></summary>

Sends a full-width stacked media album using the AIRich unified response format. Unlike the standard Album builder (which sends individual messages), this renders all items in a single rich message.

```javascript
await sock.sendMessage(jid, {
  verticalAlbumMessage: [
    { type: 'image', image: { url: 'https://example.com/1.jpg' } },
    { type: 'video', video: { url: 'https://example.com/2.mp4' }, duration: 10 },
    { type: 'image', image: { url: 'https://example.com/3.jpg' }, width: 1280, height: 720 }
  ]
})

// Via shorthand
await sock.sendVerticalAlbumMessage(jid, {
  items: [
    { type: 'image', image: { url: 'https://example.com/1.jpg' } },
    { type: 'video', video: { url: 'https://example.com/2.mp4' } }
  ]
})
```

</details>

<details>
<summary><strong>GridImage Builder</strong></summary>

```javascript
await sock.sendMessage(jid, {
  gridImageMessage: {
    imageUrls: [
      { url: 'https://example.com/1.jpg', width: 600, height: 400 },
      { url: 'https://example.com/2.jpg', width: 600, height: 400 },
      { url: 'https://example.com/3.jpg', width: 600, height: 400 }
    ]
  }
})

// Via shorthand
await sock.sendGridImageMessage(jid, {
  imageUrls: [
    'https://example.com/1.jpg',
    'https://example.com/2.jpg'
  ]
})
```

</details>

<details>
<summary><strong>VideoGrid Builder</strong></summary>

```javascript
await sock.sendMessage(jid, {
  videoGridMessage: {
    videos: [
      {
        url: 'https://example.com/1.mp4',
        title: 'Video 1',
        thumbnailUrl: 'https://example.com/thumb1.jpg',
        creator: 'Creator Name',
        likes: 1200,
        isVerified: true
      },
      {
        url: 'https://example.com/2.mp4',
        title: 'Video 2',
        thumbnailUrl: 'https://example.com/thumb2.jpg'
      }
    ]
  }
})

// Via shorthand
await sock.sendVideoGridMessage(jid, {
  videos: [
    { url: 'https://example.com/1.mp4', title: 'Clip 1' },
    { url: 'https://example.com/2.mp4', title: 'Clip 2' }
  ]
})
```

</details>

<details>
<summary><strong>A2UI Builder</strong></summary>

> [!WARNING] The A2UI catalog (`v0.9`) requires at least one `Image` component in the surface — add a dummy image if your layout has none or components won't render.

```javascript
import { A2UI } from '@zervonex/baileys'

// Static helpers
A2UI.text('id', 'Hello!', { variant: 'h1' })
// variants: h1 | h2 | h3 | h4 | h5 | caption | body

A2UI.image('id', 'https://example.com/img.jpg', { variant: 'header', fit: 'cover' })
// variants: icon | avatar | smallFeature | mediumFeature | largeFeature | header
// fits: contain | cover | fill | none | scaleDown

A2UI.icon('id', 'send')
A2UI.column('id', ['child1', 'child2'], { justify: 'start', align: 'stretch' })
A2UI.row('id', ['left', 'right'], { justify: 'spaceEvenly', align: 'center' })
A2UI.list('id', ['item1', 'item2'], { direction: 'vertical' })
A2UI.card('id', 'childId')
A2UI.tabs('id', [{ title: 'Tab 1', child: 'tab1_content' }, { title: 'Tab 2', child: 'tab2_content' }])
A2UI.modal('id', 'triggerButtonId', 'contentId')
A2UI.divider('id', { axis: 'horizontal' })
A2UI.button('id', 'childId', { call: 'openUrl', args: { url: 'https://example.com' } }, { variant: 'primary' })
A2UI.textField('id', 'Label', { value: '', variant: 'shortText' })
A2UI.checkBox('id', 'Label', false)
A2UI.choicePicker('id',
  [{ label: 'Option A', value: 'a' }, { label: 'Option B', value: 'b' }],
  ['a'],
  { label: 'Pick one', variant: 'mutuallyExclusive', displayStyle: 'chips' }
)
A2UI.slider('id', 5, 10, { label: 'Rating', min: 1 })
A2UI.dateTimeInput('id', '', { label: 'Date', enableDate: true, enableTime: false })
A2UI.surface(components, { surfaceId, catalogId, version })

// Fluent instance builder
await new A2UI(sock)
  .addColumn('root', ['img', 'title', 'dummy'])
  .addImage('img', 'https://example.com/img.jpg', { variant: 'header', fit: 'cover' })
  .addText('title', 'Hello!', { variant: 'h1' })
  .addDivider('div1')
  .addCard('card1', 'card_col')
  .addColumn('card_col', ['card_text'])
  .addText('card_text', 'Card content', { variant: 'body' })
  .addImage('dummy', 'https://example.com/img.jpg', { variant: 'avatar', fit: 'cover' })
  .addButton('quick_reply', { display_text: 'Reply', id: 'reply_id' })
  .setFallback('Fallback text for unsupported clients')
  .setSurfaceId('my-custom-surface-id')
  .setImage('https://example.com/header.jpg')
  .send(jid)

// sock.sendA2UI shortcut
await sock.sendA2UI(jid, [
  A2UI.column('root', ['img', 'title', 'dummy']),
  A2UI.image('img', 'https://example.com/img.jpg', { variant: 'header' }),
  A2UI.text('title', 'Hello!', { variant: 'h1' }),
  A2UI.image('dummy', 'https://example.com/img.jpg', { variant: 'avatar' })
], {
  buttons: [
    { name: 'quick_reply', buttonParamsJson: JSON.stringify({ display_text: 'Hi', id: 'hi' }) }
  ]
})

// Command Menu Preset
await sock.sendA2UICommandMenu(jid, {
  title: 'zervonex Menu',
  rows: [
    ['!help', 'Show all commands'],
    ['!ping', 'Check bot status'],
    ['!ai', 'Ask AI a question']
  ],
  buttons: [
    { text: 'GitHub', url: 'https://github.com/nexustechpro2' }
  ],
  footer: 'Powered by zervonex',
  image: 'https://example.com/header.jpg' // optional
})
```

</details>

<details>
<summary><strong>Poll Builder</strong></summary>

```javascript
const p = sock.poll()

p.name('What is your favorite color?')
p.options(['Red', 'Blue', 'Green', 'Yellow'])
p.addOption('Purple')           // add one more option
p.multiSelect(2)                // allow selecting up to 2 (0 = unlimited)
p.hideVoter()                   // hide who voted
p.announcement()                // for announcement groups

// Quiz mode — single correct answer
p.quiz('Blue')

// Timed poll
p.setEndTime(Math.floor(Date.now() / 1000) + 3600) // ends in 1 hour
p.hideParticipantName()         // hide voter names
p.allowAddOption()              // allow participants to add options

await p.send(jid)
```

</details>

<details>
<summary><strong>Event Builder</strong></summary>

```javascript
const e = sock.event()

e.setName('NexusTech Conference 2026')
e.setDescription('Annual developer meetup')
e.setLocation({ degreesLatitude: 6.5244, degreesLongitude: 3.3792, name: 'Lagos, Nigeria' })
e.setJoinLink('https://meet.example.com/nexusconf')
e.setStartTime(Math.floor(Date.now() / 1000) + 86400)
e.setEndTime(Math.floor(Date.now() / 1000) + 172800)
e.setCanceled(false)
e.setReminder(3600)             // remind 1 hour before (sets hasReminder + reminderOffsetSec)
e.setScheduledCall(true)        // marks as a scheduled call event

await e.send(jid)
```

</details>

<details>
<summary><strong>Payment Builder</strong></summary>

```javascript
const pay = sock.payment()

pay.setCurrency('NGN')
pay.setAmount(10000000)         // amount × 1000
pay.setFrom('1234567890@s.whatsapp.net')
pay.setNote('Payment for order #123')
pay.setExpiry(Date.now() + 86400000)

await pay.send(jid)
```

</details>

<details>
<summary><strong>Order Builder</strong></summary>

```javascript
const ord = sock.order()

ord.from({
  orderId: 'ORDER_001',
  itemCount: 3,
  totalAmount1000: 45000000,
  totalCurrencyCode: 'NGN',
  orderTitle: 'My Order',
  message: 'Thank you for your order',
  thumbnail: 'https://example.com/product.jpg'
})

await ord.send(jid)
```

</details>

---

## 🛠 Utility Methods

<details>
<summary><strong>Show utility method examples</strong></summary>

```javascript
// Refresh stale contacts — triggers WA to re-push contact data
await sock.requestContactRefresh(['1234567890@s.whatsapp.net', '0987654321@s.whatsapp.net'])

// Fetch message history on demand
await sock.fetchMessageHistory(50, oldestMessageKey, oldestMessageTimestamp)

// Request a placeholder message to be resent (for unavailable encrypted messages)
await sock.requestPlaceholderResend(messageKey)

// Capture an AIRich message for forwarding
const captured = sock.captureAiRich(msg.message)
// { submessages, sections, contextInfo, messageType }

// Relay a captured AIRich message to another JID
if (captured) await sock.relayAiRich(targetJid, captured)
```

</details>

---

## 📦 Exported Utilities

<details>
<summary><strong>Show all exports</strong></summary>

Everything exported from `@zervonex/baileys` that you can import directly:

```javascript
import {
  // Connection
  makeWASocket,
  useMultiFileAuthState,
  useKeyvAuthState,
  hasKeyvAuth,
  clearAdapterCache,
  makeCacheableSignalKeyStore,
  Browsers,
  DisconnectReason,

  // Message generation
  generateWAMessage,
  generateWAMessageFromContent,
  generateWAMessageContent,
  generateMessageIDV2,

  // Media
  downloadMediaMessage,
  downloadContentFromMessage,
  prepareWAMessageMedia,

  // Message utils
  getContentType,
  normalizeMessageContent,
  extractMessageContent,
  getAggregateVotesInPollMessage,

  // JID utils
  jidDecode,
  jidNormalizedUser,
  areJidsSameUser,
  isJidGroup,
  isJidNewsletterGroup,
  isJidUser,
  isLidUser,
  isJidBroadcast,
  isJidStatusBroadcast,

  // Types / Enums
  WAMessageStubType,
  WAMessageStatus,
  WAMessageAddressingMode,
  resolveStubType,          // resolveStubType(stubType) → name string
  WA_STUB_TYPE_NAMES,       // { 196: 'SUPPORT_AI_EDUCATION', 225: 'SCHEDULED_MESSAGE_CREATED', ... }
  AIProvenanceType,         // { NONE: 0, CREATED_WITH_GEN_AI: 1, EDITED_WITH_GEN_AI: 2 }
  DeviceCapabilityLevel,    // { NONE: 0, INFRA: 1, FULL: 2 }

  // Rich message helpers
  tokenizeCode,             // tokenizeCode(code, language) → { codeBlocks, unified_codeBlock }
  extractIE,                // extractIE(text, extraEntities?) → { text, inline_entities }
  waitAllPromises,          // deep async resolver
  generateVerificationMetadata,  // bot signature metadata

  // AIRich utilities
  hasVerifiableProofs,
  wrapToBotForwardedMessage,
  attachBotVerificationProofs,
  buildImaginePrimitive,
  prepareRichGenerationMessage,
  extractVerificationMetadata,

  // Status checker
  checkStatusWA,
} from '@zervonex/baileys'
```

</details>

---

## 📡 Events Reference

<details>
<summary><strong>Show events table</strong></summary>

| Event | Fields | Description |
|-------|--------|-------------|
| `connection.update` | `connection`, `qr`, `lastDisconnect`, `isNewLogin` | Connection state changed |
| `creds.update` | partial `AuthenticationCreds` | Auth credentials updated |
| `messaging-history.set` | `chats`, `contacts`, `messages`, `syncType`, `isLatest` | Initial history loaded |
| `messages.upsert` | `messages[]`, `type` | New message(s) received |
| `messages.update` | `[{ key, update }]` | Message status/content updated |
| `messages.delete` | `keys[]` or `{ jid, all }` | Message(s) deleted |
| `messages.reaction` | `[{ reaction, key }]` | Reaction added/removed |
| `messages.media-update` | `[{ key, media?, error? }]` | Media upload status updated |
| `message-receipt.update` | `[{ key, receipt }]` | Read/delivered receipts |
| `chats.set` | `{ chats[], isLatest }` | Initial chat list loaded |
| `chats.upsert` | `Chat[]` | New chat(s) appeared |
| `chats.update` | `Partial<Chat>[]` | Chat metadata updated |
| `chats.delete` | `string[]` | Chat(s) deleted |
| `contacts.set` | `{ contacts[] }` | Initial contacts loaded |
| `contacts.upsert` | `Contact[]` | New contact(s) added |
| `contacts.update` | `Partial<Contact>[]` | Contact info updated |
| `groups.upsert` | `GroupMetadata[]` | New group created/joined |
| `groups.update` | `Partial<GroupMetadata>[]` | Group metadata changed |
| `group-participants.update` | `{ id, author, authorPn, participants, action }` | Member added/removed/promoted/demoted |
| `blocklist.set` | `{ blocklist[] }` | Initial blocklist loaded |
| `blocklist.update` | `{ blocklist[], type }` | Block/unblock event |
| `presence.update` | `{ id, presences }` | User presence changed |
| `call` | `WACallEvent[]` | Incoming/outgoing call |
| `labels.edit` | `Label` | Label created/updated |
| `labels.association` | `[{ association, type }]` | Message/chat label assigned/removed |
| `settings.update` | `{ setting, value }` | Account setting changed |

**`group-participants.update` fields:**

| Field | Type | Description |
|-------|------|-------------|
| `id` | `string` | Group JID |
| `author` | `string` | JID of who performed the action |
| `authorPn` | `string` | Phone number of the actor (PN format) |
| `participants` | `string[]` | JIDs of affected participants |
| `action` | `string` | `add` \| `remove` \| `promote` \| `demote` |

</details>

---

## 🤖 Meta AI Messages

<details>
<summary><strong>Show Meta AI message handling</strong></summary>

Meta AI bot messages (`msmsg` encrypted responses) are automatically decrypted when received. They arrive as regular messages in `messages.upsert` once decrypted:

```javascript
sock.ev.on('messages.upsert', async ({ messages }) => {
  for (const msg of messages) {
    if (!msg.message) continue

    // Meta AI responses appear as regular extendedTextMessage or other content
    const content = extractMessageContent(msg.message)
    if (content?.extendedTextMessage?.text) {
      console.log('Message (possibly Meta AI):', content.extendedTextMessage.text)
    }
  }
})
```

If decryption fails (e.g. missing message secret), the message is gracefully NACKed and logged — it won't crash your session.

</details>

---

## 🎯 Best Practices

<details>
<summary><strong>Reconnection</strong></summary>

```javascript
sock.ev.on('connection.update', ({ connection, lastDisconnect }) => {
  if (connection === 'close') {
    const code = lastDisconnect?.error?.output?.statusCode
    const shouldReconnect = code !== DisconnectReason.loggedOut
    if (shouldReconnect) connectToWhatsApp()
    else console.log('Logged out — clear session and re-authenticate')
  }
})
```

</details>

<details>
<summary><strong>Cache Group Metadata</strong></summary>

```javascript
import NodeCache from '@cacheable/node-cache'

const groupCache = new NodeCache({ stdTTL: 5 * 60, useClones: false })

const sock = makeWASocket({
  cachedGroupMetadata: async (jid) => groupCache.get(jid)
})

sock.ev.on('groups.update', async ([event]) => {
  const metadata = await sock.groupMetadata(event.id)
  groupCache.set(event.id, metadata)
})
```

</details>

<details>
<summary><strong>Rate Limiting</strong></summary>

```javascript
const queue = []
let sending = false

const queueMessage = (jid, content) => {
  queue.push({ jid, content })
  if (!sending) processQueue()
}

const processQueue = async () => {
  sending = true
  while (queue.length > 0) {
    const { jid, content } = queue.shift()
    await sock.sendMessage(jid, content)
    await new Promise(r => setTimeout(r, 1000)) // 1s delay between messages
  }
  sending = false
}
```

</details>

<details>
<summary><strong>Error Handling</strong></summary>

```javascript
try {
  await sock.sendMessage(jid, { text: 'Hello' })
} catch (error) {
  if (error.output?.statusCode === 401) console.log('Unauthorized')
  else console.error('Send failed:', error)
}
```

</details>

<details>
<summary><strong>Poll Decryption</strong></summary>

```javascript
import { getAggregateVotesInPollMessage } from '@zervonex/baileys'

sock.ev.on('messages.update', async (event) => {
  for (const { key, update } of event) {
    if (update.pollUpdates) {
      const pollCreation = await getMessage(key)
      if (pollCreation) {
        const result = getAggregateVotesInPollMessage({
          message: pollCreation,
          pollUpdates: update.pollUpdates
        })
        console.log('Poll votes:', result)
      }
    }
  }
})
```

</details>

---

## ⚠️ Disclaimer

This project is **not** affiliated with WhatsApp or Meta. Use responsibly:

- Follow WhatsApp's Terms of Service
- Do not spam or send unsolicited messages
- Respect user privacy
- Be aware of WhatsApp's rate limits
- This library is for legitimate automation purposes only

---

## 🙏 Acknowledgments

- [WhiskeySockets](https://github.com/WhiskeySockets) for the original Baileys library
- All contributors and the open-source community

---

<div align="center">

**Made with ❤️ by [nexustechpro2](https://github.com/nexustechpro2)**

⭐ **Star us on GitHub!** ⭐

[GitHub](https://github.com/nexustechpro2/baileys) • [NPM](https://www.npmjs.com/package/@zervonex/baileys)

</div>