import { fetch, Agent } from 'undici'
import { createHash } from 'crypto'
import { readFileSync, writeFileSync, existsSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const CACHE_FILE = join(__dirname, '.cache.json')
const PROTO_FILE = join(__dirname, 'WAProto.proto')

const GITHUB_RAW = 'https://raw.githubusercontent.com/nexustechpro2/baileys/main/.wa-cache'
const CACHE_TTL = 24 * 60 * 60 * 1000

const agent = new Agent({ connect: { family: 4 } })

const isCacheValid = (cache) => cache.version && cache.timestamp && (Date.now() - cache.timestamp) < CACHE_TTL
const readCache = () => { try { return existsSync(CACHE_FILE) ? JSON.parse(readFileSync(CACHE_FILE, 'utf8')) : {} } catch { return {} } }
const writeCache = (data) => writeFileSync(CACHE_FILE, JSON.stringify({ ...data, timestamp: Date.now() }, null, 2), 'utf8')

async function fetchFromGitHub(file) {
    const res = await fetch(`${GITHUB_RAW}/${file}`, { method: 'GET', dispatcher: agent })
    if (!res.ok) throw new Error(`[WAProto] GitHub fetch failed: ${res.status} for ${file}`)
    return file.endsWith('.json') ? res.json() : res.text()
}

async function fetchClientRevision() {
    const data = await fetchFromGitHub('wa-version.json')
    if (!data?.version) throw new Error('[WAProto] GitHub wa-version.json missing version field')
    return String(data.version)
}

async function fetchCombinedBundle() {
    return fetchFromGitHub('WAProto.bundle.js')
}

export async function fetchProtoBundle() {
    const cache = readCache()
    if (isCacheValid(cache) && existsSync(PROTO_FILE)) return { changed: false, bundle: null, version: cache.version }

    const version = await fetchClientRevision()

    if (cache.version === version && existsSync(PROTO_FILE)) {
        writeCache({ ...cache, version })
        return { changed: false, bundle: null, version }
    }

    let bundle = await fetchCombinedBundle()
    const hash = createHash('sha256').update(bundle).digest('hex')

    if (cache.hash === hash) {
        writeCache({ version, hash })
        return { changed: false, bundle: null, version }
    }

    writeCache({ version, hash })
    const result = { changed: true, bundle, version }
    bundle = null
    return result
}

export async function getWAVersion() {
    const cache = readCache()
    if (isCacheValid(cache) && cache.version) return [2, 3000, parseInt(cache.version)]

    const data = await fetchFromGitHub('wa-version.json')
    if (!data?.version) throw new Error('[WAProto] GitHub wa-version.json missing version field')

    return [2, 3000, parseInt(data.version)]
}