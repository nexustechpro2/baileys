import { fetch, Agent } from 'undici'
import { createHash } from 'crypto'
import { readFileSync, writeFileSync, existsSync, createWriteStream, unlinkSync } from 'fs'
import { pipeline } from 'stream/promises'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const CACHE_FILE = join(__dirname, '.cache.json')
const PROTO_FILE = join(__dirname, 'WAProto.proto')
const BUNDLE_TMP = join(__dirname, 'WAProto.bundle.tmp')
const GITHUB_RAW = 'https://raw.githubusercontent.com/nexustechpro2/baileys/wa-cache'
const CACHE_TTL = 24 * 60 * 60 * 1000
const agent = new Agent({ connect: { family: 4 } })

const isCacheValid = (cache) => cache.version && cache.timestamp && (Date.now() - cache.timestamp) < CACHE_TTL
const readCache = () => { try { return existsSync(CACHE_FILE) ? JSON.parse(readFileSync(CACHE_FILE, 'utf8')) : {} } catch { return {} } }
const writeCache = (data) => writeFileSync(CACHE_FILE, JSON.stringify({ ...data, timestamp: Date.now() }, null, 2), 'utf8')
const removeTmp = () => { try { if (existsSync(BUNDLE_TMP)) unlinkSync(BUNDLE_TMP) } catch { } }

async function fetchFromGitHub(file) {
    const res = await fetch(`${GITHUB_RAW}/${file}`, { method: 'GET', dispatcher: agent })
    if (!res.ok) throw new Error(`[WAProto] GitHub fetch failed: ${res.status} for ${file}`)
    if (file.endsWith('.json')) return res.json()
    const hash = createHash('sha256')
    const writer = createWriteStream(BUNDLE_TMP)
    await pipeline(res.body, async function* (source) { for await (const chunk of source) { hash.update(chunk); yield chunk } }, writer)
    return hash.digest('hex')
}

async function fetchClientRevision() {
    const data = await fetchFromGitHub('wa-version.json')
    if (!data?.version) throw new Error('[WAProto] wa-version.json missing version field')
    return String(data.version)
}

export async function fetchProtoBundle() {
    const cache = readCache()
    if (isCacheValid(cache) && existsSync(PROTO_FILE)) return { changed: false, bundle: null, version: cache.version }
    const version = await fetchClientRevision()
    if (cache.version === version && existsSync(PROTO_FILE)) { writeCache({ ...cache, version }); return { changed: false, bundle: null, version } }
    const hash = await fetchFromGitHub('WAProto.bundle.js')
    if (cache.hash === hash) { writeCache({ version, hash }); removeTmp(); return { changed: false, bundle: null, version } }
    writeCache({ version, hash })
    const bundle = readFileSync(BUNDLE_TMP, 'utf8')
    removeTmp()
    return { changed: true, bundle, version }
}

export async function getWAVersion() {
    const cache = readCache()
    if (isCacheValid(cache) && cache.version) return [2, 3000, parseInt(cache.version)]
    const version = await fetchClientRevision()
    return [2, 3000, parseInt(version)]
}