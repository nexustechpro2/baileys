import { promisify } from 'util'
import { inflate } from 'zlib'
import * as constants from './constants.js'
import { jidEncode, WAJIDDomains } from './jid-utils.js'

const inflatePromise = promisify(inflate)

export const decompressingIfRequired = async (buffer) => {
    if (2 & buffer.readUInt8()) buffer = await inflatePromise(buffer.slice(1))
    else buffer = buffer.slice(1)
    return buffer
}

export const decodeBinaryNode = async (buff) =>
    decodeDecompressedBinaryNode(await decompressingIfRequired(buff), constants)

export const decodeDecompressedBinaryNode = (buffer, opts, indexRef = { index: 0 }) => {
    const { DOUBLE_BYTE_TOKENS, SINGLE_BYTE_TOKENS, TAGS } = opts

    const checkEOS = (n) => { if (indexRef.index + n > buffer.length) throw new Error('end of stream') }
    const next = () => { const v = buffer[indexRef.index]; indexRef.index += 1; return v }
    const readByte = () => { checkEOS(1); return next() }
    const readBytes = (n) => { checkEOS(n); const v = buffer.slice(indexRef.index, indexRef.index + n); indexRef.index += n; return v }
    const readStringFromChars = (n) => readBytes(n).toString('utf-8')

    const readInt = (n, le = false) => {
        checkEOS(n)
        let val = 0
        for (let i = 0; i < n; i++) val |= next() << ((le ? i : n - 1 - i) * 8)
        return val
    }

    const readInt20 = () => { checkEOS(3); return ((next() & 15) << 16) | (next() << 8) | next() }

    const unpackHex = (v) => {
        if (v >= 0 && v < 16) return v < 10 ? '0'.charCodeAt(0) + v : 'A'.charCodeAt(0) + v - 10
        throw new Error('invalid hex: ' + v)
    }

    const unpackNibble = (v) => {
        if (v >= 0 && v <= 9) return '0'.charCodeAt(0) + v
        if (v === 10) return '-'.charCodeAt(0)
        if (v === 11) return '.'.charCodeAt(0)
        if (v === 15) return '\0'.charCodeAt(0)
        throw new Error('invalid nibble: ' + v)
    }

    const unpackByte = (tag, v) => {
        if (tag === TAGS.NIBBLE_8) return unpackNibble(v)
        if (tag === TAGS.HEX_8) return unpackHex(v)
        throw new Error('unknown tag: ' + tag)
    }

    const readPacked8 = (tag) => {
        const startByte = readByte()
        let value = ''
        for (let i = 0; i < (startByte & 127); i++) {
            const cur = readByte()
            value += String.fromCharCode(unpackByte(tag, (cur & 0xf0) >> 4))
            value += String.fromCharCode(unpackByte(tag, cur & 0x0f))
        }
        if (startByte >> 7 !== 0) value = value.slice(0, -1)
        return value
    }

    const isListTag = (tag) => tag === TAGS.LIST_EMPTY || tag === TAGS.LIST_8 || tag === TAGS.LIST_16

    const readListSize = (tag) => {
        switch (tag) {
            case TAGS.LIST_EMPTY: return 0
            case TAGS.LIST_8: return readByte()
            case TAGS.LIST_16: return readInt(2)
            default: throw new Error('invalid tag for list size: ' + tag)
        }
    }

    const readJidPair = () => {
        const i = readString(readByte())
        const j = readString(readByte())
        if (j) return (i || '') + '@' + j
        throw new Error('invalid jid pair: ' + i + ', ' + j)
    }

    const readAdJid = () => {
        const domainType = Number(readByte())
        const device = readByte()
        const user = readString(readByte())
        const server =
            domainType === WAJIDDomains.LID ? 'lid' :
                domainType === WAJIDDomains.HOSTED ? 'hosted' :
                    domainType === WAJIDDomains.HOSTED_LID ? 'hosted.lid' :
                        's.whatsapp.net'
        return jidEncode(user, server, device)
    }

    const getTokenDouble = (i1, i2) => {
        const dict = DOUBLE_BYTE_TOKENS[i1]
        if (!dict) throw new Error(`invalid double token dict (${i1})`)
        const val = dict[i2]
        if (val === undefined) throw new Error(`invalid double token (${i2})`)
        return val
    }

    const readString = (tag) => {
        if (tag >= 1 && tag < SINGLE_BYTE_TOKENS.length) return SINGLE_BYTE_TOKENS[tag] ?? ''
        switch (tag) {
            case TAGS.DICTIONARY_0:
            case TAGS.DICTIONARY_1:
            case TAGS.DICTIONARY_2:
            case TAGS.DICTIONARY_3: return getTokenDouble(tag - TAGS.DICTIONARY_0, readByte())
            case TAGS.LIST_EMPTY: return ''
            case TAGS.BINARY_8: return readStringFromChars(readByte())
            case TAGS.BINARY_20: return readStringFromChars(readInt20())
            case TAGS.BINARY_32: return readStringFromChars(readInt(4))
            case TAGS.JID_PAIR: return readJidPair()
            case TAGS.AD_JID: return readAdJid()
            case TAGS.HEX_8:
            case TAGS.NIBBLE_8: return readPacked8(tag)
            default: throw new Error('invalid string with tag: ' + tag)
        }
    }

    const readList = (tag) => {
        const size = readListSize(tag)
        const items = []
        for (let i = 0; i < size; i++) items.push(decodeDecompressedBinaryNode(buffer, opts, indexRef))
        return items
    }

    const listSize = readListSize(readByte())
    const header = readString(readByte())
    if (!listSize || !header.length) throw new Error('invalid node')

    const attrs = {}
    const attributesLength = (listSize - 1) >> 1
    for (let i = 0; i < attributesLength; i++) attrs[readString(readByte())] = readString(readByte())

    let data
    if (listSize % 2 === 0) {
        const tag = readByte()
        data = isListTag(tag) ? readList(tag) : (() => {
            switch (tag) {
                case TAGS.BINARY_8: return readBytes(readByte())
                case TAGS.BINARY_20: return readBytes(readInt20())
                case TAGS.BINARY_32: return readBytes(readInt(4))
                default: return readString(tag)
            }
        })()
    }

    return { tag: header, attrs, content: data }
}