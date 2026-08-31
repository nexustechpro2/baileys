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

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'

const SCRIPT_HEADERS = {
    'User-Agent': UA,
    'Accept': '*/*',
    'Accept-Language': 'en-US,en;q=0.9',
    'Cache-Control': 'no-cache',
    'Referer': WA_URL,
    'Sec-Fetch-Dest': 'script',
    'Sec-Fetch-Mode': 'no-cors',
    'Sec-Fetch-Site': 'same-origin',
}

const PAGE_HEADERS = {
    'User-Agent': UA,
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.9',
    'Cache-Control': 'no-cache',
    'Sec-Fetch-Dest': 'document',
    'Sec-Fetch-Mode': 'navigate',
    'Sec-Fetch-Site': 'none',
    'Sec-Fetch-User': '?1',
    'Upgrade-Insecure-Requests': '1',
}

const agent = new Agent({ connect: { family: 4 } })

const TRANSIENT_ERRORS = new Set(['ETIMEDOUT', 'ECONNREFUSED', 'ENETUNREACH', 'ENOTFOUND', 'EAI_AGAIN'])

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

function readCache() {
    if (!existsSync(CACHE_FILE)) return {}
    try { return JSON.parse(readFileSync(CACHE_FILE, 'utf8')) } catch { return {} }
}

function writeCache(data) {
    writeFileSync(CACHE_FILE, JSON.stringify(data, null, 2), 'utf8')
}

async function fetchText(url, headers) {
    return withRetry(async () => {
        const res = await fetch(url, { method: 'GET', headers, dispatcher: agent })
        if (!res.ok) throw new Error(`[WAProto] HTTP ${res.status} fetching ${url}`)
        return res.text()
    })
}

async function fetchClientRevision() {
    const text = await fetchText(SW_URL, SCRIPT_HEADERS)
    const match = text.match(/client_revision[^\d]*(\d+)/)
    if (!match?.[1]) throw new Error('[WAProto] client_revision not found in sw.js')
    return match[1]
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
        let text
        try { text = await fetchText(url, SCRIPT_HEADERS) } catch { continue }
        if (text.includes('internalSpec')) chunks.push(text)
    }
    if (chunks.length === 0) throw new Error('[WAProto] No proto bundles found in WA Web JS files')
    return chunks.join('\n')
}

export async function fetchProtoBundle() {
    const cache = readCache()
    const version = await fetchClientRevision()

    if (cache.version === version && existsSync(PROTO_FILE)) {
        return { changed: false, bundle: null, version }
    }

    const bundleUrls = await fetchBundleUrls()
    let bundle = await fetchCombinedBundle(bundleUrls)

    const hash = createHash('sha256').update(bundle).digest('hex')

    if (cache.hash === hash) {
        writeCache({ version, hash })
        bundle = null
        return { changed: false, bundle: null, version }
    }

    writeCache({ version, hash })
    const result = { changed: true, bundle, version }
    bundle = null
    return result
}

export async function getWAVersion() {
    const cache = readCache()
    if (cache.version) return cache.version
    return fetchClientRevision()
}