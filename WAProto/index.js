import { existsSync, unlinkSync, readFileSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import logger from '../lib/Utils/logger.js'
import { fetchProtoBundle } from './fetcher.js'
import { generateTable, _reloadProto } from './WAProtoCompile.js'
import { parseBundle } from './parser.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const PROTO_FILE = join(__dirname, 'WAProto.proto')
const TABLE_FILE = join(__dirname, 'WAProto.json')

const log = msg => logger.info(msg)
const err = msg => logger.error(msg)

const isJsonValid = () => {
    try {
        const { m, t } = JSON.parse(readFileSync(TABLE_FILE, 'utf8'))
        return Array.isArray(m) && m.length > 0 && typeof t === 'object' && Object.keys(t).length > 0
    } catch { return false }
}

const del = (...files) => { for (const f of files) { try { if (existsSync(f)) unlinkSync(f) } catch { } } }

async function regenerateFromProto() {
    log('Regenerating WAProto.json from existing WAProto.proto...')
    await generateTable(PROTO_FILE, TABLE_FILE)
    _reloadProto()
    log('Regenerated successfully')
}

async function refetch() {
    log('Fetching proto bundle from WhatsApp Web...')
    const { bundle, version } = await fetchProtoBundle()
    if (!bundle) throw new Error('fetchProtoBundle returned no bundle')
    const protoText = parseBundle(bundle, version)
    const { writeFileSync } = await import('fs')
    const tmp = PROTO_FILE + '.tmp'
    writeFileSync(tmp, protoText, 'utf8')
    const { renameSync } = await import('fs')
    renameSync(tmp, PROTO_FILE)
    await generateTable(PROTO_FILE, TABLE_FILE)
    _reloadProto()
    log(`Fetched and compiled — WA version ${version}`)
}

async function boot() {
    const hasProto = existsSync(PROTO_FILE)
    const hasJson = existsSync(TABLE_FILE)

    if (hasProto && hasJson) {
        if (isJsonValid()) { _reloadProto(); return }
        err('WAProto.json is invalid or corrupt — regenerating from proto...')
        del(TABLE_FILE)
        try { await regenerateFromProto(); return } catch (e) {
            err(`Regeneration failed: ${e.message} — refetching from WA Web...`)
            del(PROTO_FILE, TABLE_FILE)
            await refetch()
        }
        return
    }

    if (hasProto && !hasJson) {
        log('WAProto.json missing — generating from existing proto...')
        try { await regenerateFromProto(); return } catch (e) {
            err(`Generation failed: ${e.message} — refetching from WA Web...`)
            del(PROTO_FILE, TABLE_FILE)
            await refetch()
        }
        return
    }

    if (hasJson && !hasProto) {
        err('WAProto.proto missing but WAProto.json exists — cannot trust JSON, refetching...')
        del(TABLE_FILE)
        await refetch()
        return
    }

    log('No proto files found — fetching from WA Web...')
    await refetch()
}

await boot()

export { proto, codec, generateTable, _reloadProto } from './WAProtoCompile.js'
export { getWAVersion } from './fetcher.js'
export { default } from './WAProtoCompile.js'