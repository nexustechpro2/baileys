import * as constants from './constants.js'
import { jidDecode } from './jid-utils.js'

export const encodeBinaryNode = (node, opts = constants, buffer = [0]) => {
    encodeBinaryNodeInner(node, opts, buffer)
    return Buffer.from(buffer)
}

const encodeBinaryNodeInner = ({ tag, attrs, content }, opts, buffer) => {
    const { TAGS, TOKEN_MAP } = opts

    const pushByte = (v) => buffer.push(v & 0xff)
    const pushBytes = (bytes) => {
        if (bytes.length > 1000) { for (let i = 0; i < bytes.length; i++) buffer.push(bytes[i]) }
        else buffer.push(...bytes)
    }
    const pushInt = (v, n, le = false) => {
        for (let i = 0; i < n; i++) buffer.push((v >> ((le ? i : n - 1 - i) * 8)) & 0xff)
    }
    const pushInt16 = (v) => pushBytes([(v >> 8) & 0xff, v & 0xff])
    const pushInt20 = (v) => pushBytes([(v >> 16) & 0x0f, (v >> 8) & 0xff, v & 0xff])

    const writeByteLength = (length) => {
        if (length >= 4294967296) throw new Error('string too large to encode: ' + length)
        if (length >= 1 << 20) { pushByte(TAGS.BINARY_32); pushInt(length, 4) }
        else if (length >= 256) { pushByte(TAGS.BINARY_20); pushInt20(length) }
        else { pushByte(TAGS.BINARY_8); pushByte(length) }
    }

    const writeStringRaw = (str) => {
        const bytes = Buffer.from(str, 'utf-8')
        writeByteLength(bytes.length)
        pushBytes(bytes)
    }

    const writeJid = ({ domainType, device, user, server }) => {
        if (device !== undefined) {
            pushByte(TAGS.AD_JID)
            pushByte(domainType || 0)
            pushByte(device || 0)
            writeString(user)
        } else {
            pushByte(TAGS.JID_PAIR)
            if (user.length) writeString(user)
            else pushByte(TAGS.LIST_EMPTY)
            writeString(server)
        }
    }

    const packNibble = (char) => {
        if (char >= '0' && char <= '9') return char.charCodeAt(0) - 48
        if (char === '-') return 10
        if (char === '.') return 11
        if (char === '\0') return 15
        throw new Error(`invalid byte for nibble "${char}"`)
    }

    const packHex = (char) => {
        if (char >= '0' && char <= '9') return char.charCodeAt(0) - 48
        if (char >= 'A' && char <= 'F') return 10 + char.charCodeAt(0) - 65
        if (char >= 'a' && char <= 'f') return 10 + char.charCodeAt(0) - 97
        if (char === '\0') return 15
        throw new Error(`invalid hex char "${char}"`)
    }

    const writePackedBytes = (str, type) => {
        if (str.length > TAGS.PACKED_MAX) throw new Error('too many bytes to pack')
        pushByte(type === 'nibble' ? TAGS.NIBBLE_8 : TAGS.HEX_8)
        const odd = str.length % 2 !== 0
        pushByte(odd ? (Math.ceil(str.length / 2) | 128) : Math.ceil(str.length / 2))
        const pack = type === 'nibble' ? packNibble : packHex
        for (let i = 0; i < Math.floor(str.length / 2); i++)
            buffer.push((pack(str[2 * i]) << 4) | pack(str[2 * i + 1]))
        if (odd) buffer.push((pack(str[str.length - 1]) << 4) | pack('\x00'))
    }

    const isNibble = (str) => {
        if (!str || str.length > TAGS.PACKED_MAX) return false
        for (const c of str) if (!(c >= '0' && c <= '9') && c !== '-' && c !== '.') return false
        return true
    }

    const isHex = (str) => {
        if (!str || str.length > TAGS.PACKED_MAX) return false
        for (const c of str) if (!(c >= '0' && c <= '9') && !(c >= 'A' && c <= 'F')) return false
        return true
    }

    const writeString = (str) => {
        if (str == null) { pushByte(TAGS.LIST_EMPTY); return }
        const tokenIndex = TOKEN_MAP[str]
        if (tokenIndex) {
            if (typeof tokenIndex.dict === 'number') pushByte(TAGS.DICTIONARY_0 + tokenIndex.dict)
            pushByte(tokenIndex.index)
        } else if (isNibble(str)) {
            writePackedBytes(str, 'nibble')
        } else if (isHex(str)) {
            writePackedBytes(str, 'hex')
        } else if (str) {
            const decoded = jidDecode(str)
            if (decoded) writeJid(decoded)
            else writeStringRaw(str)
        }
    }

    const writeListStart = (size) => {
        if (size === 0) pushByte(TAGS.LIST_EMPTY)
        else if (size < 256) pushBytes([TAGS.LIST_8, size])
        else { pushByte(TAGS.LIST_16); pushInt16(size) }
    }

    if (!tag) throw new Error('invalid node: tag cannot be undefined')

    const validAttrs = Object.keys(attrs || {}).filter(k => attrs[k] != null)
    writeListStart(2 * validAttrs.length + 1 + (content !== undefined ? 1 : 0))
    writeString(tag)

    for (const key of validAttrs) {
        if (typeof attrs[key] === 'string') { writeString(key); writeString(attrs[key]) }
    }

    if (typeof content === 'string') {
        writeString(content)
    } else if (Buffer.isBuffer(content) || content instanceof Uint8Array) {
        writeByteLength(content.length)
        // large buffers overflow spread operator stack; push manually above threshold
        if (content.length > 10_000_000) {
            pushBytes([...content.slice(0, Math.min(1000, content.length))])
            for (let i = 1000; i < content.length; i++) buffer.push(content[i])
        } else {
            pushBytes(content)
        }
    } else if (Array.isArray(content)) {
        const valid = content.filter(item => item && (item.tag || Buffer.isBuffer(item) || item instanceof Uint8Array || typeof item === 'string'))
        writeListStart(valid.length)
        for (const item of valid) encodeBinaryNodeInner(item, opts, buffer)
    } else if (content !== undefined) {
        throw new Error(`invalid children for header "${tag}": ${content} (${typeof content})`)
    }
}