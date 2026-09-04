import { fetchProtoBundle } from './fetcher.js'
import { parseAndWriteProto } from './parser.js'
import { generateTable, _reloadProto } from './WAProtoCompile.js'
import { fileURLToPath } from 'url'
import { existsSync, unlinkSync } from 'fs'

const PROTO_FILE = fileURLToPath(new URL('./WAProto.proto', import.meta.url))
const TABLE_FILE = fileURLToPath(new URL('./WAProto.json', import.meta.url))

// Wipe stale files on every cold start so we always regenerate from live WA bundle
try { unlinkSync(PROTO_FILE) } catch { }
try { unlinkSync(TABLE_FILE) } catch { }

const { bundle, version } = await fetchProtoBundle()
if (bundle) {
    await parseAndWriteProto(bundle, version)
    await generateTable(PROTO_FILE, TABLE_FILE)
    _reloadProto()
}

// Background: keep proto in sync with WA Web updates
; (async () => {
    try {
        const { changed, bundle, version } = await fetchProtoBundle()
        if (changed && bundle) {
            await parseAndWriteProto(bundle, version)
            await generateTable(PROTO_FILE, TABLE_FILE)
            _reloadProto()
        }
    } catch { }
})()

export { getWAVersion } from './fetcher.js'
export { proto, codec, generateTable, proto as default } from './WAProtoCompile.js'