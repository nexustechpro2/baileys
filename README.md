<div align="center">

<p>
  <!-- Banner -->
  <img src="https://files.catbox.moe/gzkpf8.jpg" alt="NexusTechPro Banner" />
</p>

# @nexustechpro/baileys

<p>
<img src="https://user-images.githubusercontent.com/74038190/212284100-561aa473-3905-4a80-b561-0d28506553ee.gif" width="100%">
</p>


**Advanced WhatsApp Web API — Built on WhiskeySockets/Baileys**

<p>
  <!-- NPM Version -->
  <a href="https://www.npmjs.com/package/@nexustechpro/baileys">
    <img src="https://img.shields.io/npm/v/@nexustechpro/baileys?color=success&logo=npm&style=flat-square" alt="NPM Version" />
  </a>
  <!-- Downloads -->
  <a href="https://www.npmjs.com/package/@nexustechpro/baileys">
    <img src="https://img.shields.io/npm/dt/@nexustechpro/baileys?color=blue&logo=npm&style=flat-square" alt="Downloads" />
  </a>
  <!-- License -->
  <a href="https://github.com/nexustechpro2/baileys/blob/main/LICENSE">
    <img src="https://img.shields.io/npm/l/@nexustechpro/baileys?color=yellow&style=flat-square" alt="License" />
  </a>
  <!-- Node Version -->
  <a href="https://nodejs.org">
    <img src="https://img.shields.io/node/v/@nexustechpro/baileys?style=flat-square" alt="Node Version" />
  </a>
  <!-- Socket Badge -->
  <a href="https://socket.dev/npm/package/@nexustechpro/baileys">
    <img src="https://socket.dev/api/badge/npm/package/@nexustechpro/baileys" alt="Socket Badge" />
  </a>
</p>
<p>
  <!-- WhatsApp Channel -->
  <a href="https://www.whatsapp.com/channel/0029VbBK53XBvvslYeZlBe0V">
    <img src="https://img.shields.io/badge/Join-WhatsApp%20Channel-25D366?logo=whatsapp&logoColor=white" alt="WhatsApp Channel" />
  </a>
</p>

*Modern, feature-rich, and developer-friendly WhatsApp automation library*

</div>

---

## 📋 Table of Contents

- [Installation](#-installation)
- [Quick Start](#-quick-start)
- [Authentication](#-authentication)
- [Browser Options](#-browser-options)
- [Socket Configuration](#-socket-configuration)
- [Session Management](#-session-management)
  - [File-based](#file-based-default)
  - [Keyv-based (MongoDB, Redis, PostgreSQL, SQLite...)](#keyv-based-production)
  - [Per-type routing](#per-type-routing-advanced)
- [Sending Messages](#-sending-messages)
  - [Content Key Reference](#content-key-reference)
  - [Text Messages](#text-messages)
  - [Media Messages](#media-messages)
  - [Buttons & Interactive](#buttons--interactive-messages)
  - [Extended Types](#extended-message-types)
  - [AI Rich Messages](#ai-rich-messages)
  - [Status & Stories](#personal-status--story-statusbroadcast)
  - [Sticker Pack](#sticker-pack)
  - [Shorthand Wrappers](#shorthand-wrappers)
- [Message Modifications](#️-message-modifications)
- [Media Download](#-media-download)
- [Group Management](#-group-management)
  - [AI Groups](#ai-groups)
- [User Operations](#-user-operations)
  - [Usernames](#usernames)
- [Check Number Status](#ban-checker)
- [Privacy Controls](#-privacy-controls)
- [Chat Operations](#-chat-operations)
- [Newsletter / Channels](#-newsletter--channels)
- [Builder API](#-builder-api)
  - [AIRich Builder](#airich-builder)
  - [Button Builder](#button-builder)
  - [Carousel Builder](#carousel-builder)
  - [Album Builder](#album-builder)
  - [Poll Builder](#poll-builder)
  - [Event Builder](#event-builder)
  - [Payment Builder](#payment-builder)
  - [Order Builder](#order-builder)
- [Utility Methods](#-utility-methods)
- [Exported Utilities](#-exported-utilities)
- [Events Reference](#-events-reference)
- [Best Practices](#-best-practices)
- [Disclaimer](#️-disclaimer)

---

## 📦 Installation

```bash
# npm
npm install @nexustechpro/baileys

# yarn
yarn add @nexustechpro/baileys
```

**Drop-in replacement for `@whiskeysockets/baileys`** — add this to `package.json`:
```json
{
  "dependencies": {
    "@whiskeysockets/baileys": "npm:@nexustechpro/baileys"
  }
}

               // OR

{
    "dependencies": {
        "@nexustechpro/baileys": "latest"
    }
}
```

**Import:**
```javascript
// ESM (recommended)
import makeWASocket from '@nexustechpro/baileys'

// CommonJS
const { default: makeWASocket } = require('@nexustechpro/baileys')
```

---

## 🚀 Quick Start

```javascript
import makeWASocket, {
  useMultiFileAuthState,
  DisconnectReason,
  makeCacheableSignalKeyStore,
  Browsers
} from '@nexustechpro/baileys'
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
    logger
  })

  sock.ev.on('connection.update', ({ connection, lastDisconnect }) => {
    if (connection === 'close') {
      const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut
      if (shouldReconnect) connectToWhatsApp()
    } else if (connection === 'open') {
      console.log('✅ Connected!')
    }
  })

  sock.ev.on('creds.update', saveCreds)

  sock.ev.on('messages.upsert', async ({ messages }) => {
    for (const msg of messages) {
      if (!msg.key.fromMe && msg.message) {
        await sock.sendMessage(msg.key.remoteJid, { text: 'Hello!' })
      }
    }
  })
}

connectToWhatsApp()
```

---

## 🔐 Authentication

### Pairing Code (Recommended)

No QR scanning — just a phone number. Call `requestPairingCode` directly after creating the socket. The socket internally waits for the WebSocket to be ready before sending the request, so **no manual polling or delays needed on your end**.

```javascript
import makeWASocket, {
  useMultiFileAuthState,
  makeCacheableSignalKeyStore,
  Browsers
} from '@nexustechpro/baileys'
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

### Custom Pairing Code

```javascript
// Must be exactly 8 characters
const code = await sock.requestPairingCode('1234567890', 'NEXUS001')
console.log('Custom code:', code)
```

### QR Code

Scan the QR with your WhatsApp mobile app under **Linked Devices**.

```javascript
import makeWASocket, {
  useMultiFileAuthState,
  makeCacheableSignalKeyStore,
  Browsers
} from '@nexustechpro/baileys'
import qrcode from 'qrcode-terminal'
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

sock.ev.on('connection.update', ({ connection, qr, lastDisconnect }) => {
  if (qr) qrcode.generate(qr, { small: true })
  if (connection === 'open') console.log('✅ Connected!')
  if (connection === 'close') {
    const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut
    if (shouldReconnect) connectToWhatsApp()
  }
})

sock.ev.on('creds.update', saveCreds)
```

Install the QR renderer: `npm install qrcode-terminal`

---

## 🌐 Browser Options

The `browser` config tells WhatsApp what client you appear to be. This affects how WhatsApp treats your session and which features it enables.

| Option | Value | Notes |
|--------|-------|-------|
| `Browsers.ubuntu('Chrome')` | `['Ubuntu', 'Chrome', '22.04.4']` | ✅ Recommended — stable, widely used |
| `Browsers.macOS('Safari')` | `['Mac OS', 'Safari', '14.4.1']` | Good alternative |
| `Browsers.windows('Chrome')` | `['Windows', 'Chrome', '10.0.22631']` | Works well |
| `Browsers.baileys('Desktop')` | `['Baileys', 'Desktop', '6.5.0']` | Identifies as Baileys explicitly |
| `Browsers.appropriate('Chrome')` | Auto-detects your OS | Uses your actual platform |

```javascript
import { Browsers } from '@nexustechpro/baileys'

// Pass any browser string as the second argument (Chrome, Safari, Firefox, etc.)
const sock = makeWASocket({
  browser: Browsers.ubuntu('Chrome')   // recommended
  // browser: Browsers.macOS('Safari')
  // browser: Browsers.windows('Chrome')
  // browser: Browsers.appropriate('Chrome') // auto-detects your server OS
})
```

---

## ⚙️ Socket Configuration

Key options from `DEFAULT_CONNECTION_CONFIG`:

```javascript
const sock = makeWASocket({
  // Required
  auth: { creds, keys },

  // Browser identity
  browser: Browsers.ubuntu('Chrome'),

  // Link preview quality (true = upload full image, false = compressed local thumb)
  generateHighQualityLinkPreview: true,

  // Cache group metadata to avoid repeated fetches
  cachedGroupMetadata: async (jid) => groupCache.get(jid),

  // Suppress your online status when connecting
  markOnlineOnConnect: false,

  // Sync full message history on connect
  syncFullHistory: false,

  // Logger (use pino({ level: 'silent' }) to suppress logs)
  logger: pino({ level: 'silent' }),

  // Connection timeout in ms
  connectTimeoutMs: 60000,

  // Max retries for failed message sends
  maxMsgRetryCount: 5,

  // Custom message retrieval for retry/poll decryption
  getMessage: async (key) => store.loadMessage(key.remoteJid, key.id),
})
```
---

## 💾 Session Management

Two adapters are available. They do **not** share an identical return shape — see the differences noted below each.

### File-based (default)

Atomic writes, sha256 checksum integrity, per-file mutex locking, corrupt file recovery, and legacy file upgrade. Best for single-instance bots or local development.

```javascript
import { useMultiFileAuthState } from '@nexustechpro/baileys'

const { state, saveCreds, getStats } = await useMultiFileAuthState('auth_session', {
    preKeyRetention:   150,  // how many recent prekeys to keep (default: 150)
    cleanupThreshold:  50,   // new prekeys before a cleanup runs (default: 50)
    logger,                  // optional — logs checksum mismatches and cleanup events
})

const sock = makeWASocket({ auth: state })
sock.ev.on('creds.update', saveCreds)

// Diagnostics
const stats = await getStats()
// { totalFiles: 42, preKeyCount: 150, nextPreKeyId: 3200, lastCleanupAt: '2026-07-05T...' }
```

To fully log out and delete a session's files, remove the session folder directly (e.g. `fs.rm(folder, { recursive: true, force: true })`) — there is no `clearSession`/`close` method on this adapter.

### Keyv-based (production)

Universal adapter for any database backend via [Keyv](https://github.com/jaredwray/keyv). Pass a connection string — the matching backend driver is resolved and imported automatically, no manual adapter imports needed.

Storage format matches `useMultiFileAuthState` exactly: every value is wrapped as `{ data, __checksum }` with a sha256 integrity check, so corruption is detected and self-healed the same way on both adapters. Reads also auto-detect and repair values that were written by an older/buggy version of this adapter (including arbitrarily nested `{ value: { value: ... } }` wrapping) — no manual data-fixing needed if you're upgrading from an earlier release.

The first argument is the **session ID** — equivalent to the folder name in `useMultiFileAuthState`. It's used as the Keyv namespace, so multiple bots can safely share one backend. The second argument is a connection string, a pre-built `Keyv` instance, or a raw `KeyvStoreAdapter`:

```javascript
import { useKeyvAuthState } from '@nexustechpro/baileys'

// ── Redis ─────────────────────────────────────────────────────────────────────
const { state, saveCreds } = await useKeyvAuthState('bot1', 'redis://localhost:6379')

// ── PostgreSQL / Supabase / Neon ──────────────────────────────────────────────
const { state, saveCreds } = await useKeyvAuthState('bot1', 'postgresql://user:pass@localhost/db')

// ── MongoDB ───────────────────────────────────────────────────────────────────
const { state, saveCreds } = await useKeyvAuthState('bot1', 'mongodb://localhost/baileys')

// ── MySQL / PlanetScale ───────────────────────────────────────────────────────
const { state, saveCreds } = await useKeyvAuthState('bot1', 'mysql://user:pass@localhost/db')

// ── SQLite (local, zero-config) ───────────────────────────────────────────────
const { state, saveCreds } = await useKeyvAuthState('bot1', 'sqlite://auth.db')

// ── etcd ──────────────────────────────────────────────────────────────────────
const { state, saveCreds } = await useKeyvAuthState('bot1', 'etcd://localhost:2379')

// ── Memcache ──────────────────────────────────────────────────────────────────
const { state, saveCreds } = await useKeyvAuthState('bot1', 'memcache://localhost:11211')

// ── In-memory (testing / ephemeral — data lost on restart) ───────────────────
const { state, saveCreds } = await useKeyvAuthState('test')
```

Supported connection string protocols: `redis:`/`rediss:`, `mongodb:`/`mongodb+srv:`, `postgres:`/`postgresql:`, `mysql:`, `sqlite:`, `etcd:`, `memcache:`/`memcached:`. All matching driver packages (`@keyv/redis`, `@keyv/mongo`, `@keyv/postgres`, `@keyv/mysql`, `@keyv/sqlite`, `@keyv/etcd`, `@keyv/memcache`) ship as regular dependencies of this package — nothing extra to install.

For backends without a connection string (e.g. DynamoDB), or to reuse one connection across multiple `useKeyvAuthState` calls yourself, pass a pre-built adapter or `Keyv` instance instead of a string:

```javascript
import { useKeyvAuthState } from '@nexustechpro/baileys'
import KeyvMongo from '@keyv/mongo'

const backend = new KeyvMongo('mongodb://localhost/baileys') // build once, share across sessions
const { state, saveCreds } = await useKeyvAuthState('bot1', backend)
```

Same connection string passed as a plain string is automatically cached and reused across every `useKeyvAuthState` call in the process — you don't need to build the instance yourself just to avoid opening duplicate connections, but you can if you want the reference for other purposes.

By default, Mongo/Postgres/MySQL/SQLite store everything in a collection/table named `keyv` (each adapter's own default). Set `collectionName` to use your own name instead — it's mapped to whatever each backend actually calls it (`collection` for Mongo, `table` for Postgres/MySQL/SQLite):

```javascript
const { state, saveCreds } = await useKeyvAuthState('bot1', 'mongodb://localhost/baileys', {
    collectionName: 'baileys_auth', // instead of the default "keyv" collection
})
```

> Per-type backend routing (e.g. prekeys on SQLite, sessions on Postgres) is not currently supported — one `useKeyvAuthState` call uses one backend for every key type.

#### Clearing a session (logout)

```javascript
const { state, saveCreds, clearSession } = await useKeyvAuthState('bot1', 'redis://localhost:6379')

// on logout / when you want to wipe this session's auth entirely:
await clearSession()
```

`clearSession()` wipes every key belonging to that `sessionId` — creds, prekeys, sessions, sender keys, everything — using each backend's native namespace-scoped bulk delete (a real `deleteMany`/`DELETE WHERE`/`SCAN`+delete under the hood, not a per-key loop). It only affects this session; other sessions sharing the same backend are untouched. There's no equivalent method on `useMultiFileAuthState` — delete the session folder instead.

#### Options

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `preKeyRetention` | `number` | `150` | Number of recent prekeys to keep |
| `cleanupThreshold` | `number` | `50` | New prekeys generated before cleanup runs |
| `logger` | `object` | `undefined` | Logger with `.info` / `.warn` methods |
| `collectionName` | `string` | adapter's own default (`"keyv"`) | Custom collection/table name — Keyv-based adapter only, ignored for connection-string-less (in-memory) and pre-built adapter/`Keyv` instances |

#### Return values

| | `useMultiFileAuthState` | `useKeyvAuthState` |
|---|---|---|
| `state` | ✅ | ✅ |
| `saveCreds` | ✅ | ✅ |
| `getStats` | ✅ | ❌ |
| `clearSession` | ❌ (delete the folder instead) | ✅ |
| `close` | ❌ | ✅ (drops local listeners; safe to call, does not disconnect a shared backend) |

---

## 💬 Sending Messages

`sock.sendMessage(jid, content, options?)` handles **every message type**. The `jid` can be a user, group, status broadcast, or newsletter.

```javascript
// JID formats
'1234567890@s.whatsapp.net'     // personal chat
'123456789-987654321@g.us'      // group
'status@broadcast'               // story/status
'120363...@newsletter'           // newsletter channel
```

### Content Key Reference

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
| `statusMentionMessage` | Mention someone in a status |
| `pollResultMessage` | Poll result snapshot |

---

### Text Messages

```javascript
// Plain text
await sock.sendMessage(jid, { text: 'Hello World!' })

// With link preview (auto-detects URLs in text)
await sock.sendMessage(jid, { text: 'Check this out: https://github.com' })

// Quote/reply
await sock.sendMessage(jid, { text: 'This is a reply' }, { quoted: message })

// Mention users
await sock.sendMessage(jid, {
  text: '@1234567890 hey!',
  mentions: ['1234567890@s.whatsapp.net']
})

// AI-generated label
await sock.sendMessage(jid, { text: 'AI response here', ai: true })
```

### Media Messages

> You can pass `{ url: '...' }`, a `Buffer`, a file path string, or `{ stream: Stream }` for any media type.

#### Image
```javascript
// From URL
await sock.sendMessage(jid, {
  image: { url: 'https://example.com/image.jpg' },
  caption: 'Caption here'
})

// From Buffer
await sock.sendMessage(jid, { image: buffer, caption: 'From buffer' })

// From file
await sock.sendMessage(jid, { image: fs.readFileSync('./image.jpg') })

// View once
await sock.sendMessage(jid, { image: { url: './secret.jpg' }, viewOnce: true })
```

#### Video
```javascript
await sock.sendMessage(jid, {
  video: { url: './video.mp4' },
  caption: 'Watch this!',
  gifPlayback: false, // true for GIF
  ptv: false          // true for video note (circle)
})
```

#### Audio
```javascript
await sock.sendMessage(jid, {
  audio: { url: './audio.mp3' },
  mimetype: 'audio/mp4',
  ptt: true // true = voice message, false = audio file
})
```

> Convert to voice-compatible format: `ffmpeg -i input.mp4 -avoid_negative_ts make_zero -ac 1 output.ogg`

#### Document
```javascript
await sock.sendMessage(jid, {
  document: { url: './file.pdf' },
  fileName: 'document.pdf',
  mimetype: 'application/pdf',
  caption: 'Here is the file'
})
```

#### Sticker
```javascript
await sock.sendMessage(jid, { sticker: { url: './sticker.webp' } })
```

#### Location
```javascript
await sock.sendMessage(jid, {
  location: {
    degreesLatitude: 24.121231,
    degreesLongitude: 55.1121221,
    name: 'Location Name',
    address: 'Full Address Here'
  }
})
```

#### Contact
```javascript
const vcard = 'BEGIN:VCARD\nVERSION:3.0\nFN:John Doe\nORG:NexusTechPro;\nTEL;type=CELL;waid=1234567890:+1 234 567 890\nEND:VCARD'

await sock.sendMessage(jid, {
  contacts: {
    displayName: 'John Doe',
    contacts: [{ vcard }]
  }
})
```

#### Reaction
```javascript
await sock.sendMessage(jid, {
  react: {
    text: '💖',       // empty string removes reaction
    key: message.key
  }
})
```

#### Poll
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

// Quiz poll (single correct answer)
await sock.sendMessage(jid, {
  poll: {
    name: 'What is 2+2?',
    values: ['3', '4', '5'],
    selectableOptionsCount: 1,
    pollType: 1,        // 1 = quiz
    correctAnswer: '4'
  }
})

// Timed poll
await sock.sendMessage(jid, {
  poll: {
    name: 'Quick vote!',
    values: ['Yes', 'No'],
    endTime: Math.floor(Date.now() / 1000) + 3600, // 1 hour
    hideParticipantName: true,
    allowAddOption: false
  }
})

// Or use the Poll builder — see Builder API section
await sock.poll()
  .name('Favorite Color?')
  .options(['Red', 'Blue', 'Green'])
  .send(jid)
```

#### Pin Message
```javascript
await sock.sendMessage(jid, {
  pin: {
    type: 1,          // 0 to unpin
    time: 86400,      // 24h = 86400 | 7d = 604800 | 30d = 2592000
    key: message.key
  }
})
```

#### Keep Message
```javascript
await sock.sendMessage(jid, {
  keep: message.key,
  type: 1,  // 2 to unkeep
  time: 86400
})
```

#### Disappearing Messages
```javascript
// Enable (seconds: 86400 = 24h, 604800 = 7d, 7776000 = 90d)
await sock.sendMessage(jid, { disappearingMessagesInChat: 86400 })

// Disable
await sock.sendMessage(jid, { disappearingMessagesInChat: false })
```

#### Forward Message
```javascript
await sock.sendMessage(jid, { forward: message, force: true })
```

#### Edit Message
```javascript
await sock.sendMessage(jid, {
  text: 'Updated text',
  edit: originalMessage.key
})
```

#### Delete Message
```javascript
const sent = await sock.sendMessage(jid, { text: 'hello' })
await sock.sendMessage(jid, { delete: sent.key })
```

---

### 🎭 Fake Quoted Messages

Fake a reply without an actual original message — useful for AI responses, status reposts, custom UIs and more. Only the bare minimum fields are needed — WhatsApp fills in the rest visually.

#### Text Quote
```javascript
await sock.sendMessage(jid, { text: 'Actual message' }, {
  quoted: {
    key: { remoteJid: jid, fromMe: false, id: 'FAKE_' + Date.now(), participant: '1234567890@s.whatsapp.net' },
    message: { conversation: 'Fake quoted text' }
  }
})
```

#### Image Quote
```javascript
await sock.sendMessage(jid, { text: 'Replying to image' }, {
  quoted: {
    key: { remoteJid: jid, fromMe: false, id: 'FAKE_' + Date.now(), participant: '1234567890@s.whatsapp.net' },
    message: { imageMessage: { caption: 'Fake image caption' } }
  }
})
```

#### Sticker Quote
```javascript
await sock.sendMessage(jid, { text: 'Replying to sticker' }, {
  quoted: {
    key: { remoteJid: jid, fromMe: false, id: 'FAKE_' + Date.now(), participant: '1234567890@s.whatsapp.net' },
    message: { stickerMessage: {} }
  }
})
```

#### AI / Bot Quote
```javascript
await sock.sendMessage(jid, { text: 'My response' }, {
  quoted: {
    key: { remoteJid: jid, fromMe: true, id: 'FAKE_' + Date.now() },
    message: { extendedTextMessage: { text: 'AI generated this', title: 'NexusAI' } }
  }
})
```

#### Status Quote
```javascript
await sock.sendMessage(jid, { text: 'Replying to your status!' }, {
  quoted: {
    key: { remoteJid: 'status@broadcast', fromMe: false, id: 'FAKE_' + Date.now(), participant: '1234567890@s.whatsapp.net' },
    message: { conversation: 'Original status text' }
  }
})
```

#### Key Fields

| Field | Description |
|-------|-------------|
| `remoteJid` | Where the quoted message appears to be from (`jid`, `status@broadcast`, group etc.) |
| `fromMe` | `true` = appears sent by you/bot, `false` = appears sent by someone else |
| `id` | Any unique string — `'FAKE_' + Date.now()` avoids collisions |
| `participant` | Required in groups/status — the person who appears to have sent it |

---

### Buttons & Interactive Messages

#### Text with Buttons
```javascript
await sock.sendMessage(jid, {
  text: 'Choose an option',
  footer: '© NexusTechPro',
  buttons: [
    {
      name: 'quick_reply',
      buttonParamsJson: JSON.stringify({ display_text: 'Option 1', id: 'opt1' })
    },
    {
      name: 'cta_url',
      buttonParamsJson: JSON.stringify({
        display_text: 'Visit Website',
        url: 'https://nexustechpro.com',
        merchant_url: 'https://nexustechpro.com'
      })
    }
  ]
})
```

#### Image / Video / Document with Buttons
```javascript
await sock.sendMessage(jid, {
  image: { url: 'https://example.com/image.jpg' },
  caption: 'Description',
  footer: '© NexusTechPro',
  buttons: [
    {
      name: 'quick_reply',
      buttonParamsJson: JSON.stringify({ display_text: 'Reply', id: 'btn1' })
    }
  ]
})
```

#### All Button Types

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

#### List / Single Select
```javascript
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

#### Full Interactive Message
```javascript
await sock.sendMessage(jid, {
  interactiveMessage: {
    title: 'Interactive',
    footer: '© NexusTechPro',
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

#### interactiveButtons Shorthand

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
      buttonParamsJson: JSON.stringify({ display_text: 'Visit Website', url: 'https://nexustechpro.com' })
    }
  ]
}, { quoted: message })

// With image header
await sock.sendMessage(jid, {
  image: { url: 'https://example.jpg' }, // or buffer
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
      buttonParamsJson: JSON.stringify({ display_text: 'Visit Website', url: 'https://nexustechpro.com' })
    }
  ]
}, { quoted: message })

// With product header
await sock.sendMessage(jid, {
  product: {
    productImage: { url: 'https://example.jpg' }, // or buffer
    productImageCount: 1,
    title: 'Product Title',
    description: 'Product Description',
    priceAmount1000: 20000 * 1000,
    currencyCode: 'USD',
    retailerId: 'Retail',
    url: 'https://example.com'
  },
  businessOwnerJid: '1234@s.whatsapp.net',
  caption: 'Description of Message',
  title: 'Title of Message',
  footer: 'Footer Message',
  media: true,
  interactiveButtons: [
    {
      name: 'quick_reply',
      buttonParamsJson: JSON.stringify({ display_text: 'Quick Reply', id: 'button_1' })
    },
    {
      name: 'cta_url',
      buttonParamsJson: JSON.stringify({ display_text: 'Visit Website', url: 'https://nexustechpro.com' })
    }
  ]
}, { quoted: message })
```

#### Classic Buttons (Old Style)

For compatibility with older WhatsApp versions or specific use cases:

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
  headerType: 3
})
```

**Header Types:**

| Value | Type | Description |
|-------|------|-------------|
| `0` | EMPTY | No header |
| `1` | TEXT | Text header |
| `2` | DOCUMENT | Document header |
| `3` | IMAGE | Image header |
| `4` | VIDEO | Video header |
| `5` | LOCATION | Location header |

**Button Types:**

| Value | Type | Description |
|-------|------|-------------|
| `1` | RESPONSE | Standard clickable button |
| `2` | NATIVE_FLOW | Native flow button |

---

### Extended Message Types

All of these go through `sock.sendMessage` — the library detects the type automatically.

#### Album

```javascript
// via sendMessage
await sock.sendMessage(jid, {
  albumMessage: [
    { image: { url: 'https://example.com/1.jpg' }, caption: 'Photo 1' },
    { image: { url: 'https://example.com/2.jpg' }, caption: 'Photo 2' },
    { video: { url: 'https://example.com/3.mp4' }, caption: 'Video 1' }
  ]
}, { albumDelay: 1500 })

// via shorthand
await sock.sendAlbumMessage(jid, [
  { image: { url: 'https://example.com/1.jpg' }, caption: 'Photo 1' },
  { video: { url: 'https://example.com/2.mp4' }, caption: 'Video 1' }
], quoted)

// via builder — see Builder API section
await sock.album()
  .image('https://example.com/1.jpg', 'Photo 1')
  .image('https://example.com/2.jpg', 'Photo 2')
  .video('https://example.com/3.mp4', 'Video 1')
  .send(jid)
```

#### Carousel

```javascript
// via sendMessage
await sock.sendMessage(jid, {
  carouselMessage: {
    caption: 'Our Products',
    footer: 'Powered by NexusTechPro',
    cards: [
      {
        header: { title: 'Card 1', hasMediaAttachment: false },
        body: { text: 'Description of card 1' },
        footer: { text: 'Footer' },
        nativeFlowMessage: {
          buttons: [
            { name: 'quick_reply', buttonParamsJson: JSON.stringify({ display_text: 'Select', id: 'card1' }) },
            { name: 'cta_url', buttonParamsJson: JSON.stringify({ display_text: 'Learn More', url: 'https://nexustechpro.com' }) }
          ]
        }
      },
      {
        header: { title: 'Card 2', hasMediaAttachment: false },
        body: { text: 'Description of card 2' },
        footer: { text: 'Footer' },
        nativeFlowMessage: {
          buttons: [
            { name: 'quick_reply', buttonParamsJson: JSON.stringify({ display_text: 'Select', id: 'card2' }) }
          ]
        }
      }
    ]
  }
})

// via builder — see Builder API section
await sock.carousel()
  .setCaption('Our Products')
  .setFooter('Powered by NexusTechPro')
  .card(sock.button().setBody('Card 1 description').reply('Select', 'card1').url('Learn More', 'https://nexustechpro.com'))
  .card(sock.button().setBody('Card 2 description').reply('Select', 'card2'))
  .send(jid)
```

#### Event

```javascript
// via sendMessage
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
    reminderOffsetSec: 3600  // remind 1 hour before
  }
})

// via builder — see Builder API section
await sock.event()
  .setName('NexusTech Conference')
  .setDescription('Annual developer conference')
  .setLocation({ degreesLatitude: 6.5244, degreesLongitude: 3.3792, name: 'Lagos, Nigeria' })
  .setJoinLink('https://meet.example.com/nexusconf')
  .setStartTime(Math.floor(Date.now() / 1000) + 86400)
  .setEndTime(Math.floor(Date.now() / 1000) + 172800)
  .setReminder(3600)
  .send(jid)
```

#### Request Payment

```javascript
// via sendMessage
await sock.sendMessage(jid, {
  requestPaymentMessage: {
    currency: 'NGN',
    amount: 10000000,
    from: '1234567890@s.whatsapp.net',
    note: 'Payment for order #123'
  }
})

// via builder
await sock.payment()
  .setCurrency('NGN')
  .setAmount(10000000)
  .setFrom('1234567890@s.whatsapp.net')
  .setNote('Payment for order #123')
  .send(jid)
```

#### Order

```javascript
// via sendMessage
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

// via builder
await sock.order()
  .from({ orderId: 'ORDER_001', itemCount: 3, totalAmount1000: 45000000, totalCurrencyCode: 'NGN', orderTitle: 'My Order' })
  .send(jid)
```

#### Product Message
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

#### Poll Result (Newsletter Style)
```javascript
await sock.sendMessage(jid, {
  pollResult: {
    name: 'Poll Title',
    votes: [['Option A', 42], ['Option B', 17]]
  }
}, { quoted: message })
```

#### Group Story

Post a story/status visible only to a specific group.

> All media types accept a URL, Buffer, file path, or WhatsApp CDN URL — no manual download needed.

```javascript
// via sendMessage
await sock.sendMessage(jid, { groupStatus: { text: 'Hello group!' } })
await sock.sendMessage(jid, { groupStatus: { image: { url: 'https://example.com/image.jpg' }, caption: 'Caption' } })
await sock.sendMessage(jid, { groupStatus: { video: { url: 'https://example.com/video.mp4' }, caption: 'Caption' } })
await sock.sendMessage(jid, { groupStatus: { audio: { url: 'https://example.com/audio.mp3' }, ptt: false } })

// via shorthand
await sock.sendGroupStatusMessage(groupJid, { text: 'Hello group!' })
await sock.sendGroupStatusMessage(groupJid, { image: { url: 'https://example.com/image.jpg' }, caption: 'Caption' })
await sock.sendGroupStatusMessage(groupJid, { video: { url: 'https://example.com/video.mp4' }, caption: 'Caption' })
await sock.sendGroupStatusMessage(groupJid, { audio: { url: 'https://example.com/audio.mp3' }, ptt: false })

// Media also accepts Buffer or file path
await sock.sendGroupStatusMessage(groupJid, { image: buffer })
await sock.sendGroupStatusMessage(groupJid, { image: fs.readFileSync('./image.jpg') })
```

#### Personal Status / Story (status@broadcast)

Post a story visible to all your contacts or a specific list.

```javascript
// Text
await sock.sendMessage('status@broadcast', { text: 'My status update!' })

// Image
await sock.sendMessage('status@broadcast', { image: { url: 'https://example.com/image.jpg' }, caption: 'Caption' })

// Video
await sock.sendMessage('status@broadcast', { video: { url: 'https://example.com/video.mp4' }, caption: 'Caption' })

// Audio
await sock.sendMessage('status@broadcast', { audio: { url: 'https://example.com/audio.mp3' }, ptt: false })

// Send to specific contacts only
await sock.sendMessage('status@broadcast', {
  text: 'Private status',
  statusJidList: [
    '1234567890@s.whatsapp.net',
    '0987654321@s.whatsapp.net'
  ]
})
```

#### React to a Status
```javascript
// Method 1 — via sendMessage
await sock.sendMessage('status@broadcast', {
  react: {
    text: '❤️',
    key: message.key  // the key of the status message
  }
}, {
  statusJidList: [message.key.participant] // the person who posted the status
})

// Method 2 — via sendReaction shorthand
await sock.sendReaction('status@broadcast', message.key, '❤️', {
  statusJidList: [message.key.participant]
})
```

#### Status Mention (tag someone in your story)

Mention specific users or groups in a story. They get a private notification.

```javascript
// Text
await sock.sendStatusMentions({ text: 'Hey @someone check this out!' }, ['1234567890@s.whatsapp.net'])

// Image
await sock.sendStatusMentions({ image: { url: 'https://example.com/image.jpg' }, caption: 'Caption' }, ['1234567890@s.whatsapp.net'])

// Video
await sock.sendStatusMentions({ video: { url: 'https://example.com/video.mp4' } }, ['1234567890@s.whatsapp.net'])

// Audio
await sock.sendStatusMentions({ audio: { url: 'https://example.com/audio.mp3' }, ptt: true }, ['1234567890@s.whatsapp.net'])

// Tag a group (all members get notified)
await sock.sendStatusMentions({ text: 'Hey group!' }, ['123456789@g.us'])
```

#### Sticker Pack

Send a full sticker pack. Supports buffers, file paths, and URLs. Packs over 60 stickers are automatically batched with a 2-second delay between batches.

```javascript
// Method 1 — via sendMessage
await sock.sendMessage(jid, {
  stickerPack: {
    name: 'My Stickers',
    publisher: 'NexusTechPro',
    stickers: [
      { data: buffer,                              emojis: ['😊'] },
      { data: './sticker.png',                     emojis: ['😂'] },
      { data: './sticker.webp',                    emojis: ['🎉'] },
      { data: './sticker.gif',                     emojis: ['✨'], isAnimated: true },
      { data: './sticker.webm',                    emojis: ['🎬'], isAnimated: true },
      { data: 'https://example.com/sticker.jpg',  emojis: ['❤️'] },
      { data: buffer, type: StickerTypes.ROUNDED, emojis: ['🔥'] },
    ],
    cover: coverBuffer  // optional — defaults to first sticker
  }
}, { quoted: message })

// Method 2 — dedicated shorthand
await sock.stickerPackMessage(jid, {
  name: 'My Stickers',
  publisher: 'NexusTechPro',
  stickers: [
    { data: buffer, emojis: ['😊'] },
    { data: './sticker.png', emojis: ['😂'] }
  ],
  cover: coverBuffer
}, { quoted: message })
```

**Per-sticker options:**

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `data` | Buffer \| string | required | Buffer, file path, URL, or SVG string |
| `emojis` | string[] | `[]` | Associated emojis shown in WhatsApp sticker picker |
| `type` | StickerTypes | `ROUNDED` | Crop/shape style (see below) |
| `isAnimated` | boolean | `false` | Mark as animated (for GIF/WebM inputs) |
| `isLottie` | boolean | `false` | Mark as Lottie animated (for TGS inputs) |
| `accessibilityLabel` | string | `''` | Accessibility label for the sticker |

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
| TGS | ✅ Animated | Telegram gzip-compressed Lottie — converted via rlottie WASM → animated WebP |


**Key behaviours:**
- Packs >60 stickers are auto-batched with a 2-second delay between batches
- Animated stickers (WebM/MP4) are converted directly via ffmpeg for best quality; static formats go through wa-sticker-formatter. EXIF metadata is embedded automatically for all formats.
- Invalid or unprocessable stickers are gracefully skipped
- Cover defaults to the first sticker if not provided

---

---

### AI Rich Messages

All types can be sent two ways:
- **`sock.sendMessage`** with an `aiRich` content key
- **`sock.airich()`** fluent builder — chain methods and call `.send(jid)`

---

##### Code Block

```javascript
// via sendMessage
await sock.sendMessage(jid, {
  aiRich: {
    language: 'javascript',
    code: `async function fetchUser(id) {
  const res = await fetch(\`/api/users/\${id}\`)
  if (!res.ok) throw new Error('Not found')
  return res.json()
}`,
    header: '**Fetch User Example**',
    footer: '_Requires Node 18+_'
  }
}, { quoted: message })

// via builder
await sock.airich()
  .setTitle('Code Example')
  .addCode('javascript', `const greet = name => \`Hello, \${name}!\``)
  .send(jid)

// via shorthand
await sock.sendCodeBlock(jid, code, quoted, { language: 'javascript', title: 'Example', footer: '© NexusTechPro' })
await sock.sendCodeBlockV2(jid, code, quoted, { language: 'go', title: 'Go Example', text: 'Here is a Go snippet:', footer: '© NexusTechPro' })
```

**Supported languages:** Any of the 190+ languages supported by PrismJS — `javascript`, `typescript`, `python`, `rust`, `go`, `java`, `cpp`, `kotlin`, `swift`, `bash`, `sql`, `dockerfile`, `solidity`, `graphql`, and many more.

---

##### Table

```javascript
// via sendMessage
await sock.sendMessage(jid, {
  aiRich: {
    table: [
      'Java vs JavaScript',
      ['Feature', 'Java', 'JavaScript'],
      ['Type', 'Compiled', 'Interpreted'],
      ['Typing', 'Static', 'Dynamic'],
      ['Main Use', 'Enterprise', 'Web']
    ],
    footer: 'Hope this helps!'
  }
}, { quoted: message })

// via builder
await sock.airich()
  .setTitle('Comparison')
  .addTable([
    ['Feature', 'Java', 'JavaScript'],
    ['Type', 'Compiled', 'Interpreted'],
    ['Typing', 'Static', 'Dynamic']
  ])
  .send(jid)

// via shorthand
await sock.sendTable(jid, 'Java vs JavaScript', ['Feature', 'Java', 'JavaScript'], [
  ['Type', 'Compiled', 'Interpreted'],
  ['Typing', 'Static', 'Dynamic']
], quoted, { footer: 'Hope this helps!' })

// sendTableV2 — pipe-delimited string format
await sock.sendTableV2(jid, [
  'Java vs JavaScript',
  'Feature | Java | JavaScript',
  'Type | Compiled | Interpreted;;Typing | Static | Dynamic'
], quoted, { footer: 'Hope this helps!' })

// sendList — two-column key/value style
await sock.sendList(jid, 'Bot Info', [
  ['Name', 'NexusTechPro'],
  ['Version', '2.2.7'],
  ['Developer', 'NexusTechPro']
], quoted, { footer: '© NexusTechPro' })
```

---

##### Text

```javascript
// via sendMessage
await sock.sendMessage(jid, {
  aiRich: {
    text: '## Hello\n\nThis supports **markdown**:\n\n- Bold\n- Lists\n- Headers',
    footer: '_Powered by NexusTechPro_'
  }
}, { quoted: message })

// multiple text blocks
await sock.sendMessage(jid, {
  aiRich: {
    texts: ['## Title', 'First paragraph', 'Second paragraph'],
    footer: '_NexusTechPro_'
  }
}, { quoted: message })

// via builder
await sock.airich()
  .addText('## Hello World\nThis is *bold* and _italic_.')
  .addFOAText('# NexusTechPro\n## Powered by @nexustechpro/baileys')
  .addTip('Always validate user input before processing.')
  .addMetadata('Generated just now · NexusBot v2.2.7')
  .send(jid)
```

---

##### Links & Search Sources

```javascript
// via sendMessage
await sock.sendMessage(jid, {
  aiRich: {
    text: 'Upload complete:\n✅ Freeimage — {{IE_0}}view here{{/IE_0}}\n✅ Yardsansh — {{IE_1}}view here{{/IE_1}}',
    sources: [
      { url: 'https://freeimage.host', displayName: 'Freeimage', subtitle: 'freeimage.host' },
      { url: 'https://yardsansh.com', displayName: 'Yardsansh', subtitle: 'yardsansh.com' }
    ],
    footer: '✨ Done!'
  }
}, { quoted: message })

// via builder
await sock.airich()
  .addText('Top results:')
  .addSource([
    { title: 'MDN Web Docs', url: 'https://developer.mozilla.org', favicon: 'https://developer.mozilla.org/favicon.ico' },
    { title: 'NPM Registry', url: 'https://npmjs.com', favicon: 'https://static.npmjs.com/favicon.ico' }
  ])
  .send(jid)

// via shorthand
await sock.sendLink(jid, 'Results:\n🔗 {{IE_0}}link one{{/IE_0}}', ['https://example.com/1'], quoted, { headerText: '📁 Results' })
await sock.sendLinkV2(jid, 'Search results:', [{ url: 'https://npmjs.com', displayName: 'NPM', subtitle: 'npmjs.com' }], quoted)
```

---

##### Images, Video, Reels

```javascript
// via sendMessage
await sock.sendMessage(jid, {
  aiRich: {
    text: 'Here are some results:',
    images: [
      { url: 'https://example.com/img1.jpg', sourceUrl: 'https://example.com' },
      { url: 'https://example.com/img2.jpg', sourceUrl: 'https://example.com' }
    ]
  }
}, { quoted: message })

// via builder
await sock.airich()
  .setTitle('Image Preview')
  .addImage('https://example.com/image.jpg')
  .addVideo('https://example.com/clip.mp4')
  .addReels([{
    creator: 'Rick Astley',
    avatar_url: 'https://example.com/avatar.jpg',
    thumbnail_url: 'https://example.com/thumb.jpg',
    reels_url: 'https://youtube.com/watch?v=dQw4w9WgXcQ'
  }])
  .send(jid)
```

---

##### Suggestions, Widgets, Footer Actions

```javascript
// via builder
await sock.airich()
  .addText('What would you like to do?')
  .addSuggest(['📥 Download Video', '🎨 Generate Image', '🔍 Web Search'])
  .addWidget([
    { label: '📥 Download', tool_call_id: 'dl', kind: 'OTHER', toast: 'Downloading...' },
    { label: '✅ Confirm', tool_call_id: 'confirm', kind: 'CONFIRM', toast: 'Confirmed!' },
    { label: '❌ Cancel', tool_call_id: 'cancel', kind: 'CANCEL', toast: 'Cancelled.' }
  ])
  .addFooterAction({ cta_text: '🔗 Visit GitHub', cta_type: 'OPEN_URL', cta_url: 'https://github.com/nexustechpro2' })
  .send(jid)
```

---

##### Status Indicators

```javascript
// via builder
await sock.airich()
  .addText('Processing your request...')
  .addThinkingStatus('Searching the web...', 'WEB_SEARCH')
  .addThinkingStatus('Thinking deeply...', 'THINKING')
  .addProgressStatus('Almost done — 80%', true)
  .addProgressStatus('Done!', false)
  .send(jid)

// Task queue
await sock.airich()
  .setTitle('Job Queue')
  .addTask({ taskId: 'task-1', title: 'Fetch data', subtitle: 'Calling API', status: 'DONE' })
  .addTask({ taskId: 'task-2', title: 'Process result', status: 'RUNNING' })
  .addTask({ taskId: 'task-3', title: 'Send response', status: 'PENDING' })
  .send(jid)
```

---

##### Dividers & Spacers

```javascript
await sock.airich()
  .setTitle('Layout Test')
  .addText('*Section A*')
  .addDivider()                  // horizontal line
  .addText('*Section B*')
  .addDivider('DOT')             // dotted divider
  .addText('*Section C*')
  .addSpacer(3)                  // 3-line gap
  .addText('*Section D*')
  .send(jid)
```

---

##### LaTeX

```javascript
// via sendMessage
await sock.sendMessage(jid, {
  aiRich: {
    latexText: 'The quadratic formula:',
    latex: [
      { latexExpression: 'x = \\frac{-b \\pm \\sqrt{b^2 - 4ac}}{2a}', url: 'https://example.com/formula.png', width: 400, height: 80 }
    ]
  }
}, { quoted: message })

// via builder
await sock.airich()
  .addText("Einstein's famous equation:")
  .addLatex({ expression: 'E = mc^2', imageUrl: 'https://example.com/emc2.png', width: 300, height: 60 })
  .send(jid)

// via shorthand
await sock.sendLatex(jid, [
  { latexExpression: 'E = mc^2', url: 'https://example.com/emc2.png', width: 300, height: 60 }
], quoted, { text: 'Mass-energy equivalence:' })
```

> Note: LaTeX requires a pre-rendered image URL. WhatsApp does not render LaTeX client-side.

---

##### Post & Product Cards

```javascript
await sock.airich()
  .addPost({
    title: 'NexusBot v2.2.7 🚀',
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
    title: 'NexusBot Premium',
    brand: 'NexusTechPro',
    price: '$9.99/mo',
    sale_price: '$4.99/mo',
    product_url: 'https://github.com/nexustechpro2',
    image_url: 'https://example.com/product.jpg'
  })
  .send(jid)
```

---

##### Map

```javascript
await sock.airich()
  .addText('Our location:')
  .addMap([{
    latitude: 6.5244,
    longitude: 3.3792,
    name: 'Lagos, Nigeria',
    address: 'Lagos Island, Lagos State'
  }])
  .send(jid)
```

---

##### Generating Placeholder

```javascript
await sock.airich()
  .addText('Generating your image...')
  .addGenerating('GENERATING')  // shows a loading placeholder
  .send(jid)
```

---

##### Load From / Edit

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
```

---

##### Capture & Relay

```javascript
// Capture a received AIRich message for forwarding
const captured = sock.captureAiRich(msg.message)

// Relay it to another jid
if (captured) await sock.relayAiRich(targetJid, captured)
```

---

##### Full Combo Example

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
    footer: '_NexusTechPro_'
  }
}, { quoted: message })

// via builder — full combo
await sock.airich()
  .setTitle('NexusTechPro Bot')
  .setFooter('Powered by @nexustechpro/baileys v2.2.7')
  .addText('*Welcome to NexusTechPro!*')
  .addDivider()
  .addCode('python', 'print("Hello from NexusTechPro")')
  .addTable([
    ['Plan', 'Price', 'Sessions'],
    ['Basic', 'Free', '1'],
    ['Pro', '$9/mo', '10'],
    ['Enterprise', 'Custom', 'Unlimited']
  ])
  .addTask({ taskId: 't1', title: 'Bot online', status: 'DONE' })
  .addMetadata('NexusTechPro • v2.2.7 • 2026')
  .addSuggest(['View commands', 'Get support', 'Upgrade plan'])
  .addFooterAction({ cta_text: '📖 View Dashboard', cta_type: 'OPEN_URL', cta_url: 'https://github.com/nexustechpro2' })
  .addFOAText('_Reply with any message to continue_')
  .send(jid)

// via shorthand
await sock.sendRichMessage(jid, {
  text: 'Hello from sendRichMessage!',
  code: 'console.log("works!")',
  language: 'javascript',
  footer: '_NexusTechPro_'
}, quoted)
```

---

##### `aiRich` Options Reference

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

---

### Shorthand Wrappers

```javascript
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

// ── AI Rich Messages ──────────────────────────────────────────────────────────
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
```

---

## ✏️ Message Modifications

```javascript
// Edit
await sock.sendMessage(jid, { text: 'Updated text', edit: originalMessage.key })

// Delete for everyone
const sent = await sock.sendMessage(jid, { text: 'hello' })
await sock.sendMessage(jid, { delete: sent.key })

// Pin (time in seconds: 86400=24h, 604800=7d, 2592000=30d)
await sock.sendMessage(jid, { pin: { type: 1, time: 86400, key: message.key } })

// Unpin
await sock.sendMessage(jid, { pin: { type: 0, time: 0, key: message.key } })
```

---

## 📥 Media Download

```javascript
import { downloadMediaMessage, getContentType } from '@nexustechpro/baileys'

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

---

## 👥 Group Management

```javascript
// Create group
const group = await sock.groupCreate('Group Name', ['1234567890@s.whatsapp.net'])

// Add / Remove / Promote / Demote
await sock.groupParticipantsUpdate(groupJid, ['1234567890@s.whatsapp.net'], 'add')
await sock.groupParticipantsUpdate(groupJid, ['1234567890@s.whatsapp.net'], 'remove')
await sock.groupParticipantsUpdate(groupJid, ['1234567890@s.whatsapp.net'], 'promote')
await sock.groupParticipantsUpdate(groupJid, ['1234567890@s.whatsapp.net'], 'demote')

// Update group info
await sock.groupUpdateSubject(groupJid, 'New Group Name')
await sock.groupUpdateDescription(groupJid, 'New description')

// Settings
await sock.groupSettingUpdate(groupJid, 'announcement')     // only admins can send
await sock.groupSettingUpdate(groupJid, 'not_announcement') // everyone can send
await sock.groupSettingUpdate(groupJid, 'locked')           // only admins edit info
await sock.groupSettingUpdate(groupJid, 'unlocked')         // everyone edits info

// Metadata
const metadata = await sock.groupMetadata(groupJid)

// Invite link
const code = await sock.groupInviteCode(groupJid)
console.log(`https://chat.whatsapp.com/${code}`)

await sock.groupRevokeInvite(groupJid)        // revoke invite
await sock.groupAcceptInvite('INVITE_CODE')   // join group
await sock.groupLeave(groupJid)               // leave group
```

### AI Groups

WhatsApp AI Groups are a special group type with Meta AI built-in as a participant.

```javascript
// Create an AI group
const group = await sock.aiGroupCreate('AI Study Group', ['1234567890@s.whatsapp.net'])

// Get AI group metadata
const metadata = await sock.aiGroupMetadata(groupJid)

// Add the Meta AI bot to an existing AI group
await sock.aiGroupAddBot(groupJid)

// Add / Remove / Promote / Demote participants
await sock.aiGroupParticipantsUpdate(groupJid, ['1234567890@s.whatsapp.net'], 'add')
await sock.aiGroupParticipantsUpdate(groupJid, ['1234567890@s.whatsapp.net'], 'remove')
await sock.aiGroupParticipantsUpdate(groupJid, ['1234567890@s.whatsapp.net'], 'promote')
await sock.aiGroupParticipantsUpdate(groupJid, ['1234567890@s.whatsapp.net'], 'demote')

// Update subject
await sock.aiGroupUpdateSubject(groupJid, 'New AI Group Name')

// Invite link
const code = await sock.aiGroupInviteCode(groupJid)
await sock.aiGroupRevokeInvite(groupJid)
await sock.aiGroupAcceptInvite('INVITE_CODE')

// Leave
await sock.aiGroupLeave(groupJid)

// Settings (announcement, not_announcement, locked, unlocked)
await sock.aiGroupSettingUpdate(groupJid, 'announcement')

// Ephemeral messages
await sock.aiGroupToggleEphemeral(groupJid, 86400) // 24h
await sock.aiGroupToggleEphemeral(groupJid, 0)     // disable
```

---

## 📱 User Operations

```javascript
// Check if number exists on WhatsApp
const [result] = await sock.onWhatsApp('1234567890')
if (result?.exists) console.log(result.jid)

// Profile picture
const url = await sock.profilePictureUrl(jid, 'image') // 'image' = HD
await sock.updateProfilePicture(jid, { url: './profile.jpg' })
await sock.removeProfilePicture(jid)

// Status & name
const status = await sock.fetchStatus(jid)
await sock.updateProfileStatus('Available 24/7')
await sock.updateProfileName('My Bot')

// Business profile
const biz = await sock.getBusinessProfile(jid)

// Presence
await sock.presenceSubscribe(jid)
await sock.sendPresenceUpdate('composing', jid) // available | unavailable | composing | recording | paused

// Read messages
await sock.readMessages([message.key])

// Block / Unblock
await sock.updateBlockStatus(jid, 'block')
await sock.updateBlockStatus(jid, 'unblock')

// Blocklist
const blocked = await sock.fetchBlocklist()
```

### Usernames

```javascript
// Check if a username is available
const result = await sock.checkUsername('nexustechpro')
// { available: true, username: 'nexustechpro', session_id: '...' }
// { available: false, suggestions: ['nexustechpro1', 'nexustechpro_'], ... }

// Check multiple usernames at once
const results = await sock.checkUsernameMulti(['nexustechpro', 'nexustechpro'])

// Set your username
await sock.setUsername('nexustechpro')

// Set with options
await sock.setUsername('nexustechpro', { pin: '1234' })

// Check availability then set in one call
await sock.checkAndSetUsername('nexustechpro')

// Get your current username
const username = await sock.getMyUsername()

// Delete your username
await sock.deleteUsername()

// Set a PIN on your username
await sock.setUsernamePin('1234')

// Find a user by their @username
const user = await sock.findUserByUsername('nexustechpro')
// { jid: '1234567890@s.whatsapp.net', contact: true }

// Find a user with PIN-protected username
const user = await sock.findUserByUsername('nexustechpro', '1234')

// Fetch usernames of multiple contacts
const list = await sock.fetchContactUsernames('1234567890@s.whatsapp.net', '0987654321@s.whatsapp.net')

// Get username suggestions from WhatsApp
const suggestions = await sock.getUsernameRecommendations()
```

---

## 💬 Check Number Status

```javascript
// Via socket instance
const result = await sock.checkStatusWA('1234567890')

// Or direct import (no socket needed)
import { checkStatusWA } from '@nexustechpro/baileys'
const result = await checkStatusWA('1234567890')

// Response examples:
// Active number
{ number: '+1234567890', status: 'active', isBanned: false, isNeedOfficialWa: false, banInfo: null }

// Banned number
{
  number: '+1234567890',
  status: 'banned',
  isBanned: true,
  isNeedOfficialWa: false,
  banInfo: {
    banType: 'temporary',        // 'temporary' | 'permanent'
    violationType: '2',
    violationReason: 'Type 2',
    canAppeal: true,             // false if permanent
    appealToken: 'xxxxx',
    banTime: 1716840000,
    banDate: '2024-05-28T00:00:00.000Z',
    appealStatus: 'PENDING',
    appealCreatedAt: '2024-05-27T00:00:00.000Z'
  }
}

// Blocked by custom screen (needs official WhatsApp)
{ number: '+1234567890', status: 'blocked', isBanned: false, isNeedOfficialWa: true, banInfo: null }

// Rate limited
{ number: '+1234567890', status: 'rate_limited', isBanned: false, isNeedOfficialWa: false, banInfo: null }

// Usage example
import { checkStatusWA } from '@nexustechpro/baileys'
const check = await checkStatusWA('1234567890')
if (check.isBanned) {
  console.log(`Banned: ${check.banInfo.banType}`)
  if (check.banInfo.canAppeal) console.log(`Appeal token: ${check.banInfo.appealToken}`)
} else {
  console.log(`Status: ${check.status}`)
}
```

---

## 🔒 Privacy Controls

```javascript
const settings = await sock.fetchPrivacySettings()

// last seen: 'all' | 'contacts' | 'contact_blacklist' | 'none'
await sock.updateLastSeenPrivacy('contacts')

// online: 'all' | 'match_last_seen'
await sock.updateOnlinePrivacy('all')

// profile picture: 'all' | 'contacts' | 'contact_blacklist' | 'none'
await sock.updateProfilePicturePrivacy('contacts')

// status: 'all' | 'contacts' | 'contact_blacklist' | 'none'
await sock.updateStatusPrivacy('contacts')

// read receipts: 'all' | 'none'
await sock.updateReadReceiptsPrivacy('all')

// groups add: 'all' | 'contacts' | 'contact_blacklist'
await sock.updateGroupsAddPrivacy('contacts')
```

### Extended Privacy (MEX-based)

```javascript
// Update your About/bio text (with optional emoji)
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

// Multi-account
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

---

## 💬 Chat Operations

```javascript
const lastMsg = await getLastMessageInChat(jid) // implement with your store

// Archive / Unarchive
await sock.chatModify({ archive: true, lastMessages: [lastMsg] }, jid)

// Mute (ms) / Unmute
await sock.chatModify({ mute: 8 * 60 * 60 * 1000 }, jid)
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

---

## 📢 Newsletter / Channels

```javascript
// ── Create & Manage ───────────────────────────────────────────────────────────

// Create a channel
const channel = await sock.newsletterCreate('Channel Name', {
  description: 'Channel description',
  picture: buffer  // optional
})
console.log(channel.id) // newsletter jid

// Fetch channel metadata
const meta = await sock.newsletterMetadata('invite', 'INVITE_CODE')   // by invite code
const meta2 = await sock.newsletterMetadata('jid', newsletterJid)     // by jid

// Update channel info
await sock.newsletterUpdate(newsletterJid, {
  name: 'New Name',
  description: 'New description',
  picture: buffer,   // optional
  reaction_codes: { codes: ['👍', '❤️', '😂'] }  // optional
})

// Delete channel
await sock.newsletterDelete(newsletterJid)

// ── Follow / Unfollow ─────────────────────────────────────────────────────────

await sock.newsletterFollow(newsletterJid)
await sock.newsletterUnfollow(newsletterJid)

// ── Mute / Unmute ─────────────────────────────────────────────────────────────

await sock.newsletterMute(newsletterJid)
await sock.newsletterUnmute(newsletterJid)

// Toggle mute with more control
await sock.toggleNewsletterMuteV2(newsletterJid, true)   // mute
await sock.toggleNewsletterMuteV2(newsletterJid, false)  // unmute

// ── Sending Messages ─────────────────────────────────────────────────────────

// Send a text message to a channel
await sock.sendMessage(newsletterJid, { text: 'Hello from the channel!' })

// Send media to a channel
await sock.sendMessage(newsletterJid, {
  image: { url: 'https://example.com/image.jpg' },
  caption: 'Check this out!'
})

// Or use the newsletter-specific send method
await sock.newsletterSendMessage(newsletterJid, { text: 'Hello channel!' })
await sock.newsletterSendMessage(newsletterJid, { image: buffer, caption: 'Photo update' })

// ── React to a Newsletter Message ────────────────────────────────────────────

await sock.newsletterReactMessage(newsletterJid, serverMessageId, '👍')

// ── Fetch Messages ───────────────────────────────────────────────────────────

// Fetch recent messages from a channel
const messages = await sock.newsletterFetchMessages(
  newsletterJid,
  20,        // count (default: 20)
  undefined, // since — fetch messages after this server_id
  undefined  // after — fetch messages after this timestamp
)

// Fetch message updates (reactions, views)
const updates = await sock.newsletterFetchMessageUpdates(newsletterJid, serverMessageId)

// ── Subscribers ──────────────────────────────────────────────────────────────

// Get subscriber list
const subscribers = await sock.newsletterSubscribers(newsletterJid)
// Returns: [{ id, phoneNumber, displayName, username, role, followTime }]

// ── Notification Settings ────────────────────────────────────────────────────

// Control follower activity notifications
await sock.newsletterUserSetting(newsletterJid, 'FOLLOWER_NOTIFICATIONS', true)   // mute follower activity
await sock.newsletterUserSetting(newsletterJid, 'FOLLOWER_NOTIFICATIONS', false)  // unmute follower activity

// ── Admin Management ─────────────────────────────────────────────────────────

// Create an admin invite for another user
const invite = await sock.newsletterAdminCreate(newsletterJid, '1234567890@s.whatsapp.net')

// Revoke an admin invite
await sock.newsletterAdminRevoke(newsletterJid, '1234567890@s.whatsapp.net')

// Promote a subscriber to admin
await sock.newsletterPromoteAdmin(newsletterJid, '1234567890@s.whatsapp.net')

// Demote an admin back to subscriber
await sock.newsletterDemoteAdmin(newsletterJid, '1234567890@s.whatsapp.net')

// ── Groups linked to a Newsletter ────────────────────────────────────────────

// Get groups linked to a newsletter
const linked = await sock.groupLinkedNewsletters(groupJid)
```

---

## 🔧 Builder API

All builders can be used as a fluent chain. Call `.send(jid)` to send, or `.build(jid)` to get the proto message without sending.

### AIRich Builder

```javascript
const r = sock.airich()           // create a new builder
r.setTitle('Title')               // shown in message metadata
r.setFooter('© NexusTechPro')    // shown below content
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
r.addSuggest(['Pill 1', 'Pill 2'], false) // false = action row, true = hscroll
r.addSection(rawSectionObject)   // raw section for advanced use
r.addEmbeddedScreen(screenObject) // embedded tabbed panel

// Special methods
r.loadFrom(msg)                  // load existing AIRich message for editing
await r.send(jid, opts)          // send
await r.sendEdit(jid, targetId)  // edit a previously sent message
```

**Named node IDs** — update specific content after adding:

```javascript
const r = sock.airich()
r.addText('Loading...', { id: 'status' })
r.addCode('js', '// placeholder', { id: 'code' })

// Later, replace a specific node by id
r.addText('Done!', { replace: 'status' })
r.addCode('js', 'console.log("real code")', { replace: 'code' })

await r.send(jid)
```

---

### Button Builder

```javascript
const b = sock.button()

// Header / body / footer
b.setTitle('Menu')
b.setSubtitle('Choose an option')
b.setBody('What would you like to do?')
b.setFooter('© NexusTechPro')

// Media header (pick one)
b.setImage('https://example.com/image.jpg')
b.setVideo('https://example.com/video.mp4')
b.setDocument('https://example.com/file.pdf', 'file.pdf')
b.setLocation(6.5244, 3.3792, 'Lagos')

// Native-flow buttons (chainable)
b.reply('Quick Reply', 'reply_id')
b.url('Visit Website', 'https://nexustechpro.com')
b.call('Call Us', '+2341234567890')
b.copy('Copy Code', 'NEXUS2025')
b.openWebview('Open App', 'https://app.nexustechpro.com')
b.catalog('View Catalog')
b.flow('Start Flow', 'flow_id_here')
b.remind('Set Reminder')
b.cancelReminder('Cancel Reminder')
b.address('Share Address')
b.sendLocation('Share Location')
b.reviewAndPay('Review & Pay')
b.reviewOrder('Review Order')
b.orderDetails('Order Details')
b.paymentStatus('Payment Status')
b.transactionDetails('Transaction Details')
b.select('Choose Option', [{ title: 'Section', rows: [{ title: 'Option 1', id: 'opt1' }] }])

// Bloks widget (advanced UI with checkboxes, inputs etc)
b.setBloksWidget([{ __type__: 'Column', id: 'root', children: [{ __type__: 'Text', text: 'Hello' }] }])

// Message-level params
b.setLimitedTimeOffer(Date.now() + 3600000)
b.setBottomSheet({ title: 'Select' })
b.setTapTargetConfiguration({ dismissible: true })

// Legacy buttons (mode: 'legacy')
b.legacyButton('Button 1', 'btn1_id')
b.legacyButton('Button 2', 'btn2_id')

// Template buttons (mode: 'template')
b.templateReply('Quick Reply', 'reply_id')
b.templateUrl('Visit', 'https://nexustechpro.com')
b.templateCall('Call', '+2341234567890')

// Convert to a carousel card
const card = b.toCard()

await b.send(jid)
```

---

### Carousel Builder

```javascript
const c = sock.carousel()

c.setCaption('Our Products')
c.setFooter('Powered by NexusTechPro')
c.setCardType('HSCROLL_CARDS') // 'HSCROLL_CARDS' (default) | 'ALBUM_IMAGE'

// Add cards — pass a Button builder instance or a raw card object
c.card(sock.button().setBody('Card 1').reply('Select', 'card1').url('Learn More', 'https://example.com'))
c.card(sock.button().setImage('https://example.com/img.jpg').setBody('Card 2').reply('Select', 'card2'))

// Max 10 cards
await c.send(jid)
```

---

### Album Builder

```javascript
const a = sock.album()

// Add items — URLs, Buffers, or file paths
a.image('https://example.com/1.jpg', 'Caption for photo 1')
a.image(buffer, 'Caption for photo 2')
a.video('https://example.com/video.mp4', 'Caption for video')
a.add([   // add multiple at once
  { image: { url: 'https://example.com/3.jpg' }, caption: 'Photo 3' },
  { video: { url: 'https://example.com/4.mp4' }, caption: 'Video 2' }
])

a.setDelay(1500) // ms between each item send (default: 1500)

// Requires at least 2 items
await a.send(jid)
```

---

### Poll Builder

```javascript
const p = sock.poll()

p.name('What is your favorite color?')
p.options(['Red', 'Blue', 'Green', 'Yellow'])
p.addOption('Purple')             // add one more
p.multiSelect(2)                  // allow selecting up to 2 (0 = unlimited)
p.hideVoter()                     // hide who voted
p.announcement()                  // for announcement groups

// Quiz mode
p.quiz('Blue')                    // marks as quiz with correct answer

// Timed poll
p.setEndTime(Math.floor(Date.now() / 1000) + 3600) // ends in 1 hour
p.hideParticipantName()           // hide voter names
p.allowAddOption()                // allow participants to add options

await p.send(jid)
```

---

### Event Builder

```javascript
const e = sock.event()

e.setName('NexusTech Conference 2026')
e.setDescription('Annual developer meetup')
e.setLocation({ degreesLatitude: 6.5244, degreesLongitude: 3.3792, name: 'Lagos, Nigeria' })
e.setJoinLink('https://meet.example.com/nexusconf')
e.setStartTime(Math.floor(Date.now() / 1000) + 86400)
e.setEndTime(Math.floor(Date.now() / 1000) + 172800)
e.setCanceled(false)
e.setReminder(3600)               // remind 1 hour before (sets hasReminder + reminderOffsetSec)
e.setScheduledCall(true)          // marks as a scheduled call event

await e.send(jid)
```

---

### Payment Builder

```javascript
const pay = sock.payment()

pay.setCurrency('NGN')
pay.setAmount(10000000)           // amount × 1000
pay.setFrom('1234567890@s.whatsapp.net')
pay.setNote('Payment for order #123')
pay.setExpiry(Date.now() + 86400000)

await pay.send(jid)
```

---

### Order Builder

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

---

## 🛠 Utility Methods

```javascript
// Refresh stale contacts (triggers WA to re-push contact data)
await sock.requestContactRefresh(['1234567890@s.whatsapp.net', '0987654321@s.whatsapp.net'])

// Fetch message history on demand
await sock.fetchMessageHistory(50, oldestMessageKey, oldestMessageTimestamp)

// Request a placeholder message to be resent (for unavailable encrypted messages)
await sock.requestPlaceholderResend(messageKey)

// Capture an AIRich message for forwarding
const captured = sock.captureAiRich(msg.message)
// { submessages, sections, contextInfo, messageType }

// Relay a captured AIRich message to another jid
if (captured) await sock.relayAiRich(targetJid, captured)
```

---

## 📦 Exported Utilities

Everything exported from `@nexustechpro/baileys` that you can import directly:

```javascript
import {
  // Connection
  makeWASocket,
  useMultiFileAuthState,
  useKeyvAuthState,
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
  resolveStubType,         // resolveStubType(stubType) → name string
  WA_STUB_TYPE_NAMES,      // { 196: 'SUPPORT_AI_EDUCATION', 225: 'SCHEDULED_MESSAGE_CREATED', ... }
  AIProvenanceType,        // { NONE: 0, CREATED_WITH_GEN_AI: 1, EDITED_WITH_GEN_AI: 2 }
  DeviceCapabilityLevel,   // { NONE: 0, INFRA: 1, FULL: 2 }

  // Rich message helpers
  tokenizeCode,            // tokenizeCode(code, language) → { codeBlocks, unified_codeBlock }
  extractIE,               // extractIE(text, extraEntities?) → { text, inline_entities }
  waitAllPromises,         // deep async resolver
  generateVerificationMetadata, // bot signature metadata

  // Status checker
  checkStatusWA,
} from '@nexustechpro/baileys'
```

---

## 📡 Events Reference

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
| `settings.update` | `{ setting, value }` | Account setting changed (theme, AI thread rename, device capabilities, etc.) |

**`group-participants.update` fields:**

| Field | Type | Description |
|-------|------|-------------|
| `id` | `string` | Group JID |
| `author` | `string` | JID of who performed the action |
| `authorPn` | `string` | Phone number of the actor (PN format) |
| `participants` | `string[]` | JIDs of affected participants |
| `action` | `string` | `add` \| `remove` \| `promote` \| `demote` |

---

## 🤖 Meta AI Messages

Meta AI bot messages (`msmsg` encrypted responses) are now automatically decrypted when received. They arrive as regular messages in `messages.upsert` once decrypted:

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

---

## 🎯 Best Practices

### Reconnection

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

### Cache Group Metadata

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

### Rate Limiting

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
    await new Promise(r => setTimeout(r, 1000))
  }
  sending = false
}
```

### Error Handling

```javascript
try {
  await sock.sendMessage(jid, { text: 'Hello' })
} catch (error) {
  if (error.output?.statusCode === 401) console.log('Unauthorized')
  else console.error('Send failed:', error)
}
```

### Poll Decryption

```javascript
import { getAggregateVotesInPollMessage } from '@nexustechpro/baileys'

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

**Made with ❤️ by [NexusTechPro](https://github.com/nexustechpro2)**

⭐ **Star us on GitHub!** ⭐

[GitHub](https://github.com/nexustechpro2/baileys) • [NPM](https://www.npmjs.com/package/@nexustechpro/baileys)

</div>