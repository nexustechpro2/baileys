import { existsSync } from 'fs'
import { fileURLToPath } from 'url'
import { join, dirname } from 'path'
import { fetchProtoBundle, getWAVersion as fetchVersion } from './fetcher.js'
import { parseAndWriteProto } from './parser.js'
import { generateTable } from './WAProtoCompile.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const PROTO_FILE = join(__dirname, 'WAProto.proto')
const TABLE_FILE = join(__dirname, 'WAProto.json')

let _proto = null
let _codec = null
let _version = null
let _initPromise = null

async function initialize() {
    const protoExists = existsSync(PROTO_FILE)
    let version = null

    try {
        const { changed, bundle, version: v } = await fetchProtoBundle()
        version = v

        if (changed && bundle) {
            await parseAndWriteProto(bundle, version)
            await generateTable(PROTO_FILE, TABLE_FILE)
        }
    } catch (err) {
        if (!protoExists) throw err
    }

    if (!existsSync(PROTO_FILE)) {
        throw new Error('[WAProto] WAProto.proto does not exist and could not be generated')
    }

    if (!existsSync(TABLE_FILE)) {
        await generateTable(PROTO_FILE, TABLE_FILE)
    }

    const { proto: builtProto, codec: builtCodec } = await import('./WAProtoCompile.js?t=' + Date.now())
    _proto = builtProto
    _codec = builtCodec

    if (version) {
        _version = [2, 3000, parseInt(version, 10)]
    } else {
        try {
            const v = await fetchVersion()
            _version = [2, 3000, parseInt(v, 10)]
        } catch {
            _version = [2, 3000, 0]
        }
    }
}

async function initProto() {
    if (_proto) return
    if (_initPromise) { await _initPromise; return }
    _initPromise = initialize()
    await _initPromise
}

await initProto()

export { _proto as proto, _codec as codec }

export function getWAVersion() {
    if (!_version) throw new Error('[WAProto] Not initialized')
    return _version
}

export default new Proxy({}, {
    get(_, prop) {
        if (!_proto) throw new Error('[WAProto] Not initialized')
        if (prop === 'proto') return _proto
        return _proto[prop]
    },
})