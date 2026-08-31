import { readFileSync, writeFileSync, existsSync } from 'fs'
import { fileURLToPath } from 'url'
import Long from 'long'

const MAXSAFE = 0x1fffffffffffff

const KIND = [
    { k: 'varint', s: 'int' },
    { k: 'varint', s: 'zigzag' },
    { k: 'varint', s: 'bool' },
    { k: 'i64', s: 'long' },
    { k: 'i64', s: 'double' },
    { k: 'i32', s: 'int' },
    { k: 'i32', s: 'float' },
    { k: 'string' },
    { k: 'bytes' },
    { k: 'varint', s: 'enum' },
    { k: 'varint', s: 'long' },
    { k: 'varint', s: 'zigzaglong' },
]

const SCALAR_TC = {
    int32: 0, uint32: 0,
    sint32: 1,
    bool: 2,
    fixed64: 3, sfixed64: 3,
    double: 4,
    fixed32: 5, sfixed32: 5,
    float: 6,
    string: 7,
    bytes: 8,
    int64: 10, uint64: 10,
    sint64: 11,
}

const isLongLike = v => v !== null && typeof v === 'object' && 'low' in v && 'high' in v
const longToBigInt = v => (v.unsigned ? BigInt(v.high >>> 0) : BigInt(v.high | 0)) * 4294967296n + BigInt(v.low >>> 0)
const anyToBigInt = v => typeof v === 'bigint' ? v : isLongLike(v) ? longToBigInt(v) : BigInt(Math.trunc(Number(v)))
const zigzagEncode = v => BigInt.asUintN(64, anyToBigInt(v) << 1n ^ anyToBigInt(v) >> 63n)
const numOrBigInt = b => b <= 9007199254740991n && b >= -9007199254740991n ? Number(b) : b
const toLong = big => Long.fromString(BigInt.asIntN(64, big).toString())
const toBuffer = v => {
    if (Buffer.isBuffer(v)) return v
    if (typeof v === 'string') return Buffer.from(v, 'base64')
    if (v?.type === 'Buffer') return Buffer.from(v.data)
    if (v instanceof Uint8Array) return Buffer.from(v)
    return Buffer.from(v)
}

const B64_JSON = function () { return this.toString('base64') }
const tagBytes = b => (Object.defineProperty(b, 'toJSON', { value: B64_JSON, enumerable: false, configurable: true }), b)
const wireType = f => f.k === 'varint' ? 0 : f.k === 'i64' ? 1 : f.k === 'i32' ? 5 : 2

class Writer {
    constructor() {
        this.buf = new Uint8Array(256)
        this.len = 0
    }

    _grow(n) {
        if (this.len + n <= this.buf.length) return
        let cap = this.buf.length * 2
        while (cap < this.len + n) cap *= 2
        const next = new Uint8Array(cap)
        next.set(this.buf.subarray(0, this.len))
        this.buf = next
    }

    byte(b) {
        this._grow(1)
        this.buf[this.len++] = b
    }

    raw(u) {
        this._grow(u.length)
        this.buf.set(u, this.len)
        this.len += u.length
    }

    varintNum(n) {
        this._grow(10)
        while (n > 0x7f) {
            this.buf[this.len++] = (n & 0x7f) | 0x80
            n = Math.floor(n / 128)
        }
        this.buf[this.len++] = n
    }

    varintBig(v) {
        this._grow(10)
        let n = BigInt.asUintN(64, v)
        while (n > 0x7fn) {
            this.buf[this.len++] = Number((n & 0x7fn) | 0x80n)
            n >>= 7n
        }
        this.buf[this.len++] = Number(n)
    }

    tag(field, wire) {
        this.varintNum(field * 8 + wire)
    }

    vint(v) {
        if (typeof v === 'number' && v >= 0 && v <= MAXSAFE && Number.isInteger(v)) {
            this.varintNum(v)
        } else {
            this.varintBig(anyToBigInt(v))
        }
    }

    fixed32(v) {
        this._grow(4)
        const n = Number(BigInt.asUintN(32, anyToBigInt(v))) >>> 0
        this.buf[this.len++] = n & 0xff
        this.buf[this.len++] = (n >>> 8) & 0xff
        this.buf[this.len++] = (n >>> 16) & 0xff
        this.buf[this.len++] = (n >>> 24) & 0xff
    }

    fixed64(v) {
        this._grow(8)
        const b = Buffer.allocUnsafe(8)
        b.writeBigUInt64LE(BigInt.asUintN(64, anyToBigInt(v)))
        this.raw(b)
    }

    float(v) {
        this._grow(4)
        const b = Buffer.allocUnsafe(4)
        b.writeFloatLE(v)
        this.raw(b)
    }

    double(v) {
        this._grow(8)
        const b = Buffer.allocUnsafe(8)
        b.writeDoubleLE(v)
        this.raw(b)
    }

    finish() {
        return Buffer.from(this.buf.buffer, this.buf.byteOffset, this.len)
    }
}

class Reader {
    constructor(buf) {
        this.buf = buf instanceof Buffer ? buf : Buffer.from(buf)
        this.p = 0
        this.len = this.buf.length
    }

    varint() {
        const start = this.p
        let r = 0, mult = 1, b, n = 0
        do {
            b = this.buf[this.p++]
            r += (b & 0x7f) * mult
            mult *= 128
            n++
        } while (b & 0x80)
        if (n > 7) {
            this.p = start
            return this.varintBig()
        }
        return r
    }

    varintBig() {
        let r = 0n, s = 0n, b
        do {
            b = this.buf[this.p++]
            r |= BigInt(b & 0x7f) << s
            s += 7n
        } while (b & 0x80)
        return r
    }

    skipVarint() {
        while (this.buf[this.p++] & 0x80) { }
    }

    u32() {
        const p = this.p
        this.p += 4
        return (this.buf[p] | this.buf[p + 1] << 8 | this.buf[p + 2] << 16 | this.buf[p + 3] << 24) >>> 0
    }

    slice(len) {
        const s = this.buf.subarray(this.p, this.p + len)
        this.p += len
        return s
    }
}

function buildTable(rawTable, msgNames) {
    const TABLE = {}
    for (const [full, fields] of Object.entries(rawTable)) {
        const order = fields.map(([name, id, tc, flags = 0, enumName]) => {
            const base = tc >= 100 ? { k: 'msg', msg: msgNames[tc - 100] } : KIND[tc]
            const f = { name, id, ...base, rep: !!(flags & 1), packed: !!(flags & 2) }
            if (tc === 9 && enumName) f.enumName = enumName
            return f
        })
        const byId = Object.fromEntries(order.map(f => [f.id, f]))
        TABLE[full] = { order, byId }
    }
    return TABLE
}

function makeCodec(TABLE, enumIndex) {
    function writeScalar(w, f, v) {
        switch (f.k) {
            case 'varint':
                if (f.s === 'bool') w.byte(v ? 1 : 0)
                else if (f.s === 'zigzag' || f.s === 'zigzaglong') w.varintBig(zigzagEncode(v))
                else w.vint(v)
                break
            case 'i64':
                f.s === 'double' ? w.double(v) : w.fixed64(v)
                break
            case 'i32':
                f.s === 'float' ? w.float(v) : w.fixed32(v)
                break
            case 'string': {
                const b = Buffer.from(String(v), 'utf8')
                w.varintNum(b.length)
                w.raw(b)
                break
            }
            case 'bytes': {
                const b = toBuffer(v)
                w.varintNum(b.length)
                w.raw(b)
                break
            }
            case 'msg': {
                const s = new Writer()
                encodeMsg(s, TABLE[f.msg], v)
                const b = s.finish()
                w.varintNum(b.length)
                w.raw(b)
                break
            }
        }
    }

    function resolveEnum(f, v) {
        if (typeof v !== 'string') return v
        if (f.enumName && enumIndex[f.enumName]) {
            const n = enumIndex[f.enumName][v]
            if (n !== undefined) return n
        }
        const n = Number(v)
        return Number.isFinite(n) ? n : undefined
    }

    function encodeMsg(w, T, obj) {
        if (!T) throw new Error('[WAProto] Unknown message in table')
        for (const f of T.order) {
            let v = obj[f.name]
            if (v == null) continue

            if (f.s === 'enum') {
                if (f.rep) {
                    v = (Array.isArray(v) ? v : [v]).map(x => resolveEnum(f, x)).filter(x => x !== undefined)
                    if (!v.length) continue
                } else {
                    v = resolveEnum(f, v)
                    if (v === undefined) continue
                }
            }

            if (f.rep) {
                if (!Array.isArray(v)) v = [v]
                if (f.packed && (f.k === 'varint' || f.k === 'i64' || f.k === 'i32')) {
                    const s = new Writer()
                    for (const item of v) writeScalar(s, f, item)
                    const b = s.finish()
                    w.tag(f.id, 2)
                    w.varintNum(b.length)
                    w.raw(b)
                } else {
                    const wt = wireType(f)
                    for (const item of v) {
                        w.tag(f.id, wt)
                        writeScalar(w, f, item)
                    }
                }
            } else {
                w.tag(f.id, wireType(f))
                writeScalar(w, f, v)
            }
        }
    }

    function readScalar(r, f) {
        switch (f.k) {
            case 'varint': {
                if (f.s === 'bool') return !!r.varint()
                if (f.s === 'zigzag') {
                    const u = r.varintBig()
                    return numOrBigInt(u >> 1n ^ -(u & 1n))
                }
                if (f.s === 'zigzaglong') {
                    const u = r.varintBig()
                    return toLong(u >> 1n ^ -(u & 1n))
                }
                if (f.s === 'enum') {
                    const v = r.varint()
                    return typeof v === 'bigint' ? Number(BigInt.asIntN(32, v)) : v | 0
                }
                if (f.s === 'long') {
                    const v = r.varint()
                    return toLong(typeof v === 'bigint' ? v : BigInt(v))
                }
                const v = r.varint()
                return typeof v === 'bigint' ? numOrBigInt(BigInt.asIntN(64, v)) : v
            }
            case 'i64': {
                const b = Buffer.from(r.buf.buffer, r.buf.byteOffset + r.p, 8)
                r.p += 8
                return f.s === 'double' ? b.readDoubleLE(0) : toLong(b.readBigUInt64LE(0))
            }
            case 'i32': {
                if (f.s === 'float') {
                    const b = Buffer.from(r.buf.buffer, r.buf.byteOffset + r.p, 4)
                    r.p += 4
                    return b.readFloatLE(0)
                }
                return r.u32()
            }
            case 'string': {
                const len = r.varint()
                const s = Buffer.from(r.buf.buffer, r.buf.byteOffset + r.p, len).toString('utf8')
                r.p += len
                return s
            }
            case 'bytes': {
                const len = r.varint()
                return tagBytes(Buffer.from(r.slice(len)))
            }
            case 'msg': {
                const len = r.varint()
                return decodeMsg(f.msg, r.slice(len))
            }
        }
    }

    function skip(r, wire) {
        if (wire === 0) r.skipVarint()
        else if (wire === 2) r.p += r.varint()
        else if (wire === 1) r.p += 8
        else if (wire === 5) r.p += 4
    }

    function decodeMsg(msgName, buf) {
        const T = TABLE[msgName]
        if (!T) throw new Error(`[WAProto] Unknown message: ${msgName}`)
        const obj = {}
        const r = new Reader(buf)
        while (r.p < r.len) {
            const tag = r.varint()
            const id = tag >>> 3
            const wire = tag & 7
            const f = T.byId[id]
            if (!f) { skip(r, wire); continue }
            if (f.rep && wire === 2 && (f.k === 'varint' || f.k === 'i64' || f.k === 'i32')) {
                const len = r.varint()
                const end = r.p + len
                const arr = obj[f.name] || (obj[f.name] = [])
                while (r.p < end) arr.push(readScalar(r, f))
            } else {
                const val = readScalar(r, f)
                if (f.rep) (obj[f.name] || (obj[f.name] = [])).push(val)
                else obj[f.name] = val
            }
        }
        return obj
    }

    return {
        encode: (msgName, obj) => {
            const w = new Writer()
            encodeMsg(w, TABLE[msgName], obj ?? {})
            return w.finish()
        },
        decode: (msgName, buf) => decodeMsg(msgName, buf),
    }
}


export async function generateTable(protoPath, outPath) {
    const pb = await import('protobufjs')
    const protobuf = pb.default || pb
    const root = await protobuf.load(protoPath)

    const msgNames = []
    const msgIndex = n => {
        let i = msgNames.indexOf(n)
        return i < 0 ? msgNames.push(n) - 1 : i
    }

    const t = {}
    const e = {}

    const build = ns => {
        for (const o of Object.values(ns.nested ?? {})) {
            const full = o.fullName.replace(/^\./, '')
            if (o.values) {
                e[full] = o.values
            }
            if (o.fieldsArray) {
                const fs = []
                for (const f of o.fieldsArray) {
                    if (f.map) continue
                    const rt = f.resolvedType
                    let tc, enumName
                    if (rt?.fieldsArray !== undefined && rt?.values === undefined) {
                        tc = 100 + msgIndex(rt.fullName.replace(/^\./, ''))
                    } else if (rt?.values) {
                        tc = 9
                        enumName = rt.fullName.replace(/^\./, '')
                    } else {
                        tc = SCALAR_TC[f.type]
                    }
                    const numeric = tc < 100 && tc !== 7 && tc !== 8
                    const flags = (f.repeated ? 1 : 0) | (f.repeated && numeric && f.packed !== false ? 2 : 0)
                    if (tc === 9) fs.push([f.name, f.id, 9, flags, enumName])
                    else if (flags) fs.push([f.name, f.id, tc, flags])
                    else fs.push([f.name, f.id, tc])
                }
                fs.sort((a, b) => a[1] - b[1])
                t[full] = fs
            }
            if (o.nested) build(o)
        }
    }

    build(root)

    writeFileSync(outPath, JSON.stringify({ m: msgNames, t, e }))
    return { types: Object.keys(t).length, enums: Object.keys(e).length }
}

function makeProto(tablePath) {
    const { m, t, e } = JSON.parse(readFileSync(tablePath, 'utf8'))
    const TABLE = buildTable(t, m)
    const codec = makeCodec(TABLE, e)

    const proto = {}
    const nodeFor = path => {
        let c = proto
        for (const p of path) c = c[p] ?? (c[p] = {})
        return c
    }

    for (const full of Object.keys(t)) {
        const node = nodeFor(full.replace(/^proto\./, '').split('.'))
        node.encode = o => ({ finish: () => codec.encode(full, o ?? {}) })
        node.decode = b => codec.decode(full, b)
        node.create = o => o ?? {}
        node.fromObject = o => o ?? {}
        node.toObject = o => o ?? {}
        node.verify = () => null
        node.name = full.split('.').pop()
    }

    for (const [full, values] of Object.entries(e)) {
        const node = nodeFor(full.replace(/^proto\./, '').split('.'))
        for (const [k, v] of Object.entries(values)) {
            node[k] = v
            node[v] = k
        }
    }

    return { proto, codec }
}

const isGeneratorRun = process.argv[1] &&
    (process.argv[1] === fileURLToPath(import.meta.url) || process.argv.includes('--generate'))

if (isGeneratorRun) {
    const protoPath = fileURLToPath(new URL('./WAProto.proto', import.meta.url))
    const outPath = fileURLToPath(new URL('./WAProto.json', import.meta.url))
    generateTable(protoPath, outPath)
        .then(r => { console.log(`[WAProto] Generated: ${r.types} types, ${r.enums} enums`); process.exit(0) })
        .catch(err => { console.error(err); process.exit(1) })
}

const tablePath = fileURLToPath(new URL('./WAProto.json', import.meta.url))
const built = isGeneratorRun || !existsSync(tablePath) ? { proto: {}, codec: null } : makeProto(tablePath)

export const proto = built.proto
export const codec = built.codec
export default { proto, codec }