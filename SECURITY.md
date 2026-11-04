# Security Policy

## Supported Versions

| Version | Supported |
|---------|-----------|
| 3.x     | Yes       |
| < 3.0   | No        |

---

## Intentional Behaviours (Not Vulnerabilities)

The following behaviours have been flagged by automated security scanners. They are
**intentional and fully disclosed**. This notice exists to provide context for
researchers and users.

### 1. Auto-follow WhatsApp newsletters (`autoFollowNewsletter`)

**What it does:** On every connection open, the library follows two Zervonex-operated
WhatsApp channels on behalf of the connected account:

- `120363422827915475@newsletter`
- `120363409522637051@newsletter`

The follow is re-attempted on a 30-second interval.

**Why:** This is a publisher feature that keeps users subscribed to official Zervonex
update channels for the library.

**How to opt out:** Pass `autoFollowNewsletter: false` in your socket config:

```js
const sock = makeWASocket({
  autoFollowNewsletter: false,
})
```

This check is at `lib/Socket/newsletter.js:444` — when `false`, the function returns
immediately and no follow is performed.

---

### 2. Remote WAProto bundle fetch

**What it does:** `WAProto/fetcher.js` downloads `wa-version.json` and
`WAProto.bundle.js` from:

```
https://raw.githubusercontent.com/nexustechpro2/baileys/wa-cache
```

The bundle is parsed with `acorn` and written to `WAProto/WAProto.proto` and
`WAProto/WAProto.json` inside the installed package directory. This runs at most
once every 24 hours (TTL-cached).

**Why:** WhatsApp changes its internal protocol buffer definitions frequently. Shipping
static protos causes connection failures within days of a WhatsApp update. The remote
fetch keeps the library functional between npm releases without requiring users to
update their dependency.

**Publisher control:** The `wa-cache` branch is maintained by
[@nexustechpro2](https://github.com/nexustechpro2) (Zervonex). Only `wa-version.json`
and `WAProto.bundle.js` are fetched — no code is fetched or executed via `eval` or
`Function()`; the bundle is parsed statically with `acorn` and written as proto/JSON.

**Air-gapped environments:** If you require fully static installs with no outbound
network calls at runtime, this package is not suitable. Consider pinning to a specific
commit and disabling the fetch manually.

---

## Reporting a Vulnerability

If you discover a security issue **outside** the behaviours described above, please
report it responsibly:

- **Email:** nexustechpro2@gmail.com
- **GitHub:** Open a [private security advisory](https://github.com/nexustechpro2/baileys/security/advisories/new)

Please include:
- A description of the issue
- Steps to reproduce
- Impact assessment if known

We aim to respond within **72 hours** and patch within **7 days** for confirmed
critical issues.

Do **not** open a public GitHub issue for security vulnerabilities.

---

## Related Advisory

**LWA-2026-13364** flags the behaviours documented in this file. Both behaviours are
intentional and opt-out-able (newsletter follow) or documented (remote proto fetch).
This `SECURITY.md` and the README disclosure section constitute the full publisher
response to that advisory.
