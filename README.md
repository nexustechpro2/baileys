<div align="center">

![NexusTechPro Banner](https://files.catbox.moe/1rjzor.jpeg)

# @nexustechpro/baileys

**Advanced WhatsApp Web API — Built on WhiskeySockets/Baileys**

[![NPM Version](https://img.shields.io/npm/v/@nexustechpro/baileys?color=success&logo=npm&style=flat-square)](https://www.npmjs.com/package/@nexustechpro/baileys)
[![Downloads](https://img.shields.io/npm/dt/@nexustechpro/baileys?color=blue&logo=npm&style=flat-square)](https://www.npmjs.com/package/@nexustechpro/baileys)
[![License](https://img.shields.io/npm/l/@nexustechpro/baileys?color=yellow&style=flat-square)](./LICENSE)
[![Node Version](https://img.shields.io/node/v/@nexustechpro/baileys?style=flat-square)](https://nodejs.org)
[![Socket Badge](https://socket.dev/api/badge/npm/package/@nexustechpro/baileys)](https://socket.dev/npm/package/@nexustechpro/baileys)

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
- [Sending Messages](#-sending-messages)
  - [Text Messages](#text-messages)
  - [Media Messages](#media-messages)
  - [Buttons & Interactive](#buttons--interactive-messages)
  - [Extended Types](#extended-message-types)
  - [Status & Stories](#personal-status--story-statusbroadcast)
  - [Sticker Pack](#sticker-pack)
  - [Shorthand Wrappers](#shorthand-wrappers)
- [Message Modifications](#️-message-modifications)
- [Media Download](#-media-download)
- [Group Management](#-group-management)
- [User Operations](#-user-operations)
- [Privacy Controls](#-privacy-controls)
- [Chat Operations](#-chat-operations)
- [Newsletter / Channels](#-newsletter--channels)
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

//OR

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

```javascript
import { useMultiFileAuthState } from '@nexustechpro/baileys'

const { state, saveCreds } = await useMultiFileAuthState('auth_session')
const sock = makeWASocket({ auth: state })

sock.ev.on('creds.update', saveCreds)
```

> 💡 For production, store credentials in a database (MongoDB, Redis, PostgreSQL) rather than the filesystem. The `useMultiFileAuthState` helper is for development only.

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
await sock.sendMessage(jid, {
  poll: {
    name: 'Favorite Color?',
    values: ['Red', 'Blue', 'Green'],
    selectableOptionsCount: 1,
    toAnnouncementGroup: false
  }
})
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
| List/Select | `single_select` | `title`, `sections[].rows[]` |
| Call Permission | `call_permission_request` | `has_multiple_buttons` |

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
await sock.sendMessage(jid, {
  albumMessage: [
    { image: { url: 'https://example.com/1.jpg' }, caption: 'Photo 1' },
    { video: { url: 'https://example.com/2.mp4' }, caption: 'Video 1' }
  ]
}, { quoted: message })

// Shorthand
await sock.sendAlbumMessage(jid, [
  { image: { url: 'https://example.com/1.jpg' }, caption: 'Photo 1' }
], message)
```

#### Carousel
```javascript
await sock.sendMessage(jid, {
  carouselMessage: {
    caption: 'Our Products',
    footer: 'Powered by NexusTechPro',
    cards: [
      {
        headerTitle: 'Card 1',
        imageUrl: 'https://example.com/1.jpg',
        bodyText: 'Description',
        buttons: [{ name: 'cta_url', params: { display_text: 'Visit', url: 'https://nexustechpro.com' } }]
      },
      {
        headerTitle: 'Product Card',
        imageUrl: 'https://example.com/2.jpg',
        productTitle: 'Premium Bot',
        productDescription: 'Get access',
        bodyText: 'Details here',
        buttons: [{ name: 'cta_call', params: { display_text: 'Call', phone_number: '+1234567890' } }]
      }
    ]
  }
})
```

#### Event
```javascript
await sock.sendMessage(jid, {
  event: {
    isCanceled: false,
    name: 'Event Name',
    description: 'Event Description',
    location: { degreesLatitude: 0, degreesLongitude: 0, name: 'Venue' },
    joinLink: 'https://meet.example.com/event',
    startTime: Math.floor(Date.now() / 1000),
    endTime: Math.floor(Date.now() / 1000) + 86400,
    extraGuestsAllowed: true
  }
}, { quoted: message })
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

#### Request Payment
```javascript
// With note
await sock.sendMessage(jid, {
  requestPayment: {
    currency: 'IDR',
    amount: '10000000',
    from: '123456@s.whatsapp.net',
    note: 'Payment for order #123'
  }
}, { quoted: message })

// With sticker (URL or Buffer)
await sock.sendMessage(jid, {
  requestPayment: {
    currency: 'IDR',
    amount: '10000000',
    from: '123456@s.whatsapp.net',
    sticker: { url: 'https://example.com/sticker.webp' }
  }
})
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
// Text
await sock.sendMessage(jid, { groupStatus: { text: 'Hello group!' } })

// Image
await sock.sendMessage(jid, { groupStatus: { image: { url: 'https://example.com/image.jpg' }, caption: 'Caption' } })

// Video
await sock.sendMessage(jid, { groupStatus: { video: { url: 'https://example.com/video.mp4' }, caption: 'Caption' } })

// Audio
await sock.sendMessage(jid, { groupStatus: { audio: { url: 'https://example.com/audio.mp3' }, ptt: false } })

// Via shorthand
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
    description: 'Custom sticker collection',
    stickers: [
      { data: buffer, emojis: ['😊'] },
      { data: './sticker.png', emojis: ['😂'] },
      { data: './sticker.webp', emojis: ['🎉'] },
      { data: 'https://example.com/sticker.jpg', emojis: ['❤️'] }
    ],
    cover: coverBuffer  // optional cover image
  }
}, { quoted: message })

// Method 2 — dedicated shorthand
await sock.stickerPackMessage(jid, {
  name: 'My Stickers',
  publisher: 'NexusTechPro',
  description: 'A collection',
  stickers: [
    { data: buffer, emojis: ['😊'] },
    { data: './sticker.png', emojis: ['😂'] }
  ],
  cover: coverBuffer
}, { quoted: message })
```

**Supported formats:**

| Format | Support | Notes |
|--------|---------|-------|
| WebP | ✅ Full | Used as-is |
| PNG | ✅ Full | Auto-converted to WebP |
| JPG/JPEG | ✅ Full | Auto-converted to WebP |
| GIF | ✅ Limited | Converts to static WebP |
| BMP | ✅ Full | Auto-converted to WebP |
| Video | ❌ | Not supported |

**Key behaviours:**
- Packs >60 stickers are auto-batched
- Stickers >1MB are auto-compressed
- Invalid stickers are gracefully skipped
- 2-second delay between batches to avoid rate limiting

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
// Create
await sock.newsletterCreate('Channel Name', { description: 'Description', picture: buffer })

// Update
await sock.newsletterUpdateMetadata(newsletterJid, { name: 'New Name', description: 'New Desc' })
await sock.newsletterUpdatePicture(newsletterJid, buffer)

// React to a message
await sock.newsletterReactMessage(newsletterJid, messageId, '👍')

// Follow / Unfollow / Mute / Unmute
await sock.newsletterFollow(newsletterJid)
await sock.newsletterUnfollow(newsletterJid)
await sock.newsletterMute(newsletterJid)
await sock.newsletterUnmute(newsletterJid)
```

---

## 📡 Events Reference

| Event | Trigger |
|-------|---------|
| `connection.update` | Connection state changed |
| `creds.update` | Auth credentials updated |
| `messages.upsert` | New message(s) received |
| `messages.update` | Message status/content updated |
| `messages.delete` | Message(s) deleted |
| `message-receipt.update` | Read/delivered receipts |
| `chats.set` | Initial chat list loaded |
| `chats.upsert` | New chat(s) appeared |
| `chats.update` | Chat metadata updated |
| `chats.delete` | Chat(s) deleted |
| `contacts.set` | Initial contacts loaded |
| `contacts.upsert` | New contact(s) added |
| `contacts.update` | Contact info updated |
| `groups.upsert` | New group created/joined |
| `groups.update` | Group metadata changed |
| `group-participants.update` | Member added/removed/promoted |
| `presence.update` | User presence changed |
| `call` | Incoming call |
| `blocklist.set` | Initial blocklist loaded |
| `blocklist.update` | Block/unblock event |

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