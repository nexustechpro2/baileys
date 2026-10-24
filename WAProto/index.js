import { existsSync, unlinkSync, readFileSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import { Worker, isMainThread, workerData, parentPort } from 'worker_threads'
import logger from '../lib/Utils/logger.js'
import { fetchProtoBundle } from './fetcher.js'
import { generateTable, _reloadProto } from './WAProtoCompile.js'
import { parseBundle } from './parser.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const PROTO_FILE = join(__dirname, 'WAProto.proto')
const TABLE_FILE = join(__dirname, 'WAProto.json')
const SELF = new URL(import.meta.url)

const log = msg => logger.info(msg)
const err = msg => logger.error(msg)
const del = (...files) => { for (const f of files) { try { if (existsSync(f)) unlinkSync(f) } catch { } } }
const isJsonValid = () => { try { const { m, t } = JSON.parse(readFileSync(TABLE_FILE, 'utf8')); return Array.isArray(m) && m.length > 0 && typeof t === 'object' && Object.keys(t).length > 0 } catch { return false } }

function runInWorker(data) {
    return new Promise((resolve, reject) => {
        const w = new Worker(SELF, { workerData: data })
        w.once('message', msg => { w.terminate(); msg.ok ? resolve() : reject(new Error(msg.error)) })
        w.once('error', reject)
    })
}

async function regenerateFromProto() {
    log('Regenerating WAProto.json from existing WAProto.proto...')
    await runInWorker({ bundlePath: null, version: null, protoPath: PROTO_FILE, tablePath: TABLE_FILE })
    _reloadProto()
    log('Regenerated successfully')
}

async function refetch() {
    log('Fetching proto bundle from GitHub...')
    const { bundle, bundlePath, version } = await fetchProtoBundle()
    if (!bundle && !bundlePath) throw new Error('fetchProtoBundle returned no bundle')
    await runInWorker({ bundlePath: bundlePath ?? null, bundle: bundle ?? null, version, protoPath: PROTO_FILE, tablePath: TABLE_FILE })
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
    if (hasJson && !hasProto) { err('WAProto.proto missing but WAProto.json exists — cannot trust JSON, refetching...'); del(TABLE_FILE); await refetch(); return }

    log('No proto files found — fetching from GitHub...')
    await refetch()
}

if (!isMainThread) {
    const { bundlePath, bundle, version, protoPath, tablePath } = workerData
    try {
        if (bundlePath || bundle) {
            const src = bundlePath ? readFileSync(bundlePath, 'utf8') : bundle
            if (bundlePath) unlinkSync(bundlePath)
            const { writeFileSync, renameSync } = await import('fs')
            const tmp = protoPath + '.tmp'
            writeFileSync(tmp, parseBundle(src, version), 'utf8')
            renameSync(tmp, protoPath)
        }
        await generateTable(protoPath, tablePath)
        parentPort.postMessage({ ok: true })
    } catch (e) {
        parentPort.postMessage({ ok: false, error: e.message })
    }
} else {
    await boot()
}

export { proto, codec, generateTable, _reloadProto } from './WAProtoCompile.js'
export { getWAVersion, fetchProtoBundle } from './fetcher.js'
export { default } from './WAProtoCompile.js'