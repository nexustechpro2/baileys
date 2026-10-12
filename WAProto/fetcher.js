import { fetch, Agent } from 'undici'
import { createHash } from 'crypto'
import { readFileSync, writeFileSync, existsSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const CACHE_FILE = join(__dirname, '.cache.json')
const PROTO_FILE = join(__dirname, 'WAProto.proto')

const SW_URL = 'https://web.whatsapp.com/sw.js'
const WA_URL = 'https://web.whatsapp.com'
const GITHUB_RAW = 'https://raw.githubusercontent.com/nexustechpro2/baileys/main/.wa-cache'
const CACHE_TTL = 24 * 60 * 60 * 1000

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'

const SCRIPT_HEADERS = {
    'User-Agent': UA, 'Accept': '*/*', 'Accept-Language': 'en-US,en;q=0.9',
    'Cache-Control': 'no-cache', 'Referer': WA_URL,
    'Sec-Fetch-Dest': 'script', 'Sec-Fetch-Mode': 'no-cors', 'Sec-Fetch-Site': 'same-origin',
}

const PAGE_HEADERS = {
    'User-Agent': UA, 'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.9', 'Cache-Control': 'no-cache',
    'Sec-Fetch-Dest': 'document', 'Sec-Fetch-Mode': 'navigate',
    'Sec-Fetch-Site': 'none', 'Sec-Fetch-User': '?1', 'Upgrade-Insecure-Requests': '1',
}

const agent = new Agent({ connect: { family: 4 } })
const TRANSIENT_ERRORS = new Set(['ETIMEDOUT', 'ECONNREFUSED', 'ENETUNREACH', 'ENOTFOUND', 'EAI_AGAIN'])

const isCacheValid = (cache) => cache.version && cache.timestamp && (Date.now() - cache.timestamp) < CACHE_TTL
const readCache = () => { try { return existsSync(CACHE_FILE) ? JSON.parse(readFileSync(CACHE_FILE, 'utf8')) : {} } catch { return {} } }
const writeCache = (data) => writeFileSync(CACHE_FILE, JSON.stringify({ ...data, timestamp: Date.now() }, null, 2), 'utf8')

async function withRetry(fn, retries = 3) {
    let delay = 1000
    for (let i = 0; i <= retries; i++) {
        try { return await fn() } catch (err) {
            if (i === retries || !TRANSIENT_ERRORS.has(err.cause?.code)) throw err
            await new Promise(r => setTimeout(r, delay))
            delay = Math.min(delay * 2, 30000)
        }
    }
}

const fetchText = (url, headers) => withRetry(async () => {
    const res = await fetch(url, { method: 'GET', headers, dispatcher: agent })
    if (!res.ok) throw new Error(`[WAProto] HTTP ${res.status} fetching ${url}`)
    return res.text()
})

async function fetchFromGitHub(file) {
    const res = await fetch(`${GITHUB_RAW}/${file}`, { method: 'GET', dispatcher: agent })
    if (!res.ok) throw new Error(`[WAProto] GitHub fetch failed: ${res.status}`)
    return file.endsWith('.json') ? res.json() : res.text()
}

let versionFetchPromise = null

async function fetchClientRevision() {
    if (versionFetchPromise) return versionFetchPromise
    versionFetchPromise = (async () => {
        try {
            const text = await fetchText(SW_URL, SCRIPT_HEADERS)
            const match = text.match(/client_revision[^\d]*(\d+)/)
            if (!match?.[1]) throw new Error('[WAProto] client_revision not found in sw.js')
            return match[1]
        } catch (err) {
            console.warn('[WAProto] sw.js fetch failed, falling back to GitHub:', err.message)
            const data = await fetchFromGitHub('wa-version.json')
            if (!data?.version) throw new Error('[WAProto] GitHub fallback missing version')
            return data.version
        } finally {
            versionFetchPromise = null
        }
    })()
    return versionFetchPromise
}

async function fetchBundleUrls() {
    const html = await fetchText(WA_URL, PAGE_HEADERS)
    const urls = new Set()
    for (const m of html.matchAll(/src="(https?:\/\/[^"]+\.js[^"]*)"/g)) urls.add(m[1])
    for (const m of html.matchAll(/(https:\/\/static\.whatsapp\.net\/rsrc\.php\/[^"'\s]+\.js)/g)) urls.add(m[1])
    return [...urls]
}

async function fetchCombinedBundle(bundleUrls) {
    const chunks = []
    for (const url of bundleUrls) {
        try {
            const text = await fetchText(url, SCRIPT_HEADERS)
            if (text.includes('internalSpec')) chunks.push(text)
        } catch { }
    }
    if (chunks.length) return chunks.join('\n')
    console.warn('[WAProto] No proto bundles from WA, falling back to GitHub')
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
    const bundleUrls = await fetchBundleUrls()
    let bundle = await fetchCombinedBundle(bundleUrls)
    const hash = createHash('sha256').update(bundle).digest('hex')
    if (cache.hash === hash) { writeCache({ version, hash }); return { changed: false, bundle: null, version } }
    writeCache({ version, hash })
    const result = { changed: true, bundle, version }
    bundle = null
    return result
}

export async function getWAVersion() {
    const cache = readCache()
    if (isCacheValid(cache) && cache.version) return [2, 3000, parseInt(cache.version)]
    try {
        const rev = await fetchClientRevision()
        return [2, 3000, parseInt(rev)]
    } catch {
        const data = await fetchFromGitHub('wa-version.json')
        return [2, 3000, parseInt(data.version)]
    }
}