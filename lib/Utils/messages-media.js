import { Boom } from '@hapi/boom'
import { spawn } from 'child_process'
import * as Crypto from 'crypto'
import { once } from 'events'
import { createReadStream, createWriteStream, mkdirSync, unlinkSync, promises as fs } from 'fs'
import { tmpdir as osTmpdir } from 'os'
import { join } from 'path'
import { Readable, Transform } from 'stream'
import { URL } from 'url'
import { fileTypeFromBuffer } from 'file-type'
import https from 'node:https'
import http from 'node:http'
import { proto } from '../../WAProto/index.js'
import { DEFAULT_ORIGIN, MEDIA_HKDF_KEY_MAPPING, MEDIA_PATH_MAP } from '../Defaults/index.js'
import { getBinaryNodeChild, getBinaryNodeChildBuffer, jidNormalizedUser } from '../WABinary/index.js'
import { aesDecryptGCM, aesEncryptGCM, hkdf } from './crypto.js'
import { generateMessageIDV2 } from './generics.js'

// ─── TMP REGISTRY ─────────────────────────────────────────────────────────────

const _tmpRegistry = new Set()
process.on('exit', () => { for (const p of _tmpRegistry) try { unlinkSync(p) } catch { } })
const _trackTmp = p => { _tmpRegistry.add(p); return p }
const _untrackTmp = p => _tmpRegistry.delete(p)

const BAILEYS_TMP_DIR = (() => {
    for (const dir of [join(process.cwd(), '.b-tmp'), join(osTmpdir(), 'b-tmp')]) {
        try {
            mkdirSync(dir, { recursive: true, mode: 0o700 })
            process.env.TMPDIR = dir
            process.env.VIPS_TMPDIR = dir
            process.env.VIPS_DISC_THRESHOLD = '999999999999'
            return dir
        } catch { }
    }
    throw new Error('No writable tmp directory found')
})()

export const tmpdir = () => BAILEYS_TMP_DIR

// ─── FFMPEG ───────────────────────────────────────────────────────────────────

let _ffmpegPath = null
const getFfmpegPath = async () => {
    if (_ffmpegPath) return _ffmpegPath
    try { const { default: p } = await import('ffmpeg-static'); if (p) return (_ffmpegPath = p) } catch { }
    return (_ffmpegPath = 'ffmpeg')
}

const _spawnFfmpeg = (ffmpegPath, args) => new Promise((resolve, reject) => {
    const ff = spawn(ffmpegPath, args, { stdio: ['ignore', 'ignore', 'pipe'] })
    let stderr = ''
    ff.stderr.on('data', d => { stderr += d })
    ff.on('close', code => code === 0 ? resolve() : reject(new Error(`FFmpeg exited ${code}: ${stderr.slice(-500)}`)))
    ff.on('error', reject)
})

// ─── IMAGE PROCESSING ─────────────────────────────────────────────────────────

export const getImageProcessingLibrary = async () => {
    const [jimp, sharp] = await Promise.all([import('jimp').catch(() => null), import('sharp').catch(() => null)])
    if (sharp) return { sharp }
    if (jimp) return { jimp }
    throw new Boom('No image processing library available')
}

export const extractImageThumb = async (bufferOrFilePath, width = 32) => {
    if (bufferOrFilePath instanceof Readable) bufferOrFilePath = await toBuffer(bufferOrFilePath)
    const lib = await getImageProcessingLibrary()
    if ('sharp' in lib && typeof lib.sharp?.default === 'function') {
        const img = lib.sharp.default(bufferOrFilePath)
        const { width: w, height: h } = await img.metadata()
        return { buffer: await img.resize(width).jpeg({ quality: 95 }).toBuffer(), original: { width: w, height: h } }
    }
    if ('jimp' in lib && typeof lib.jimp?.Jimp === 'object') {
        const jimp = await lib.jimp.Jimp.read(bufferOrFilePath)
        return { buffer: await jimp.resize({ w: width, mode: lib.jimp.ResizeStrategy.BILINEAR }).getBuffer('image/jpeg', { quality: 95 }), original: { width: jimp.width, height: jimp.height } }
    }
    throw new Boom('No image processing library available')
}

export const generateProfilePicture = async mediaUpload => {
    const src = Buffer.isBuffer(mediaUpload) ? mediaUpload : 'url' in mediaUpload ? mediaUpload.url.toString() : await toBuffer(mediaUpload.stream)
    const lib = await getImageProcessingLibrary()
    if ('sharp' in lib && typeof lib.sharp?.default === 'function') return { img: await lib.sharp.default(src).resize(720, 720, { fit: 'inside' }).jpeg({ quality: 80 }).toBuffer() }
    if ('jimp' in lib && typeof lib.jimp?.read === 'function') {
        const { read, MIME_JPEG } = lib.jimp
        const image = await read(src)
        return { img: await image.crop(0, 0, image.getWidth(), image.getHeight()).scaleToFit(720, 720).getBufferAsync(MIME_JPEG) }
    }
    throw new Boom('No image processing library available')
}

export const generateThumbnail = async (file, mediaType, options) => {
    if (mediaType === 'image') {
        const { buffer, original } = await extractImageThumb(file)
        return { thumbnail: buffer.toString('base64'), originalImageDimensions: (original.width && original.height) ? original : undefined }
    }
    if (mediaType === 'video') {
        const imgFilename = join(tmpdir(), generateMessageIDV2() + '.jpg')
        try {
            const ff = await getFfmpegPath()
            await new Promise((resolve, reject) => {
                const proc = spawn(ff, ['-ss', '00:00:00', '-i', file, '-y', '-vf', 'scale=32:-1', '-vframes', '1', '-f', 'image2', imgFilename])
                proc.on('close', code => code === 0 ? resolve() : reject(new Error(`FFmpeg thumb exit ${code}`)))
                proc.on('error', reject)
            })
            const thumbnail = (await fs.readFile(imgFilename)).toString('base64')
            await fs.unlink(imgFilename).catch(() => { })
            return { thumbnail, originalImageDimensions: undefined }
        } catch (err) { options.logger?.debug('could not generate video thumb: ' + err) }
    }
    return { thumbnail: undefined, originalImageDimensions: undefined }
}

// ─── HKDF ─────────────────────────────────────────────────────────────────────

export const hkdfInfoKey = type => `WhatsApp ${MEDIA_HKDF_KEY_MAPPING[type]} Keys`

export const getMediaKeys = async (buffer, mediaType) => {
    if (!buffer) throw new Boom('Cannot derive from empty media key')
    if (typeof buffer === 'string') buffer = Buffer.from(buffer.replace('data:;base64,', ''), 'base64')
    const k = hkdf(buffer, 112, { info: hkdfInfoKey(mediaType) })
    return { iv: k.slice(0, 16), cipherKey: k.slice(16, 48), macKey: k.slice(48, 80) }
}

// ─── STREAM UTILS ─────────────────────────────────────────────────────────────

export const toReadable = buffer => { const r = new Readable({ read: () => { } }); r.push(buffer); r.push(null); return r }

export const toBuffer = async stream => {
    if (Buffer.isBuffer(stream)) return stream
    const chunks = []
    for await (const chunk of stream) chunks.push(chunk)
    stream.destroy?.()
    return Buffer.concat(chunks)
}

const _isHttpUrl = str => { try { const { protocol } = new URL(str); return protocol === 'http:' || protocol === 'https:' } catch { return false } }

export const getStream = async (item, opts) => {
    if (!item) throw new Boom('Item is required for getStream', { statusCode: 400 })
    if (Buffer.isBuffer(item)) return { stream: toReadable(item), type: 'buffer' }
    if (item?.stream?.pipe) return { stream: item.stream, type: 'readable' }
    if (item?.pipe) return { stream: item, type: 'readable' }
    if (item && typeof item === 'object' && 'url' in item) {
        const urlStr = item.url.toString()
        if (Buffer.isBuffer(item.url)) return { stream: toReadable(item.url), type: 'buffer' }
        if (urlStr.startsWith('data:')) return { stream: toReadable(Buffer.from(urlStr.split(',')[1], 'base64')), type: 'buffer' }
        if (_isHttpUrl(urlStr)) return { stream: await getHttpStream(item.url, opts), type: 'remote' }
        return { stream: createReadStream(item.url), type: 'file' }
    }
    if (typeof item === 'string') {
        if (item.startsWith('data:')) return { stream: toReadable(Buffer.from(item.split(',')[1], 'base64')), type: 'buffer' }
        if (_isHttpUrl(item)) return { stream: await getHttpStream(item, opts), type: 'remote' }
        return { stream: createReadStream(item), type: 'file' }
    }
    throw new Boom(`Invalid input type for getStream: ${typeof item}`, { statusCode: 400 })
}

export const getHttpStream = (url, options = {}) => new Promise((resolve, reject) => {
    const urlObj = new URL(url.toString())
    const isHttps = urlObj.protocol === 'https:'
    const mod = isHttps ? https : http
    const req = mod.request({ hostname: urlObj.hostname, port: urlObj.port || (isHttps ? 443 : 80), path: urlObj.pathname + urlObj.search, method: 'GET', family: 4, headers: { ...(options.headers ?? {}), Origin: DEFAULT_ORIGIN } }, res => {
        if (res.statusCode < 200 || res.statusCode >= 300) { res.destroy(); return reject(new Boom(`Failed to fetch stream from ${url}`, { statusCode: res.statusCode, data: { url } })) }
        resolve(res)
    })
    req.on('error', reject)
    req.end()
})

// ─── RAW UPLOAD ───────────────────────────────────────────────────────────────

export const getRawMediaUploadData = async (media, mediaType, logger) => {
    const { stream } = await getStream(media)
    const hasher = Crypto.createHash('sha256')
    const filePath = join(tmpdir(), mediaType + generateMessageIDV2())
    const fileWriteStream = createWriteStream(filePath)
    let fileLength = 0
    try {
        for await (const data of stream) { fileLength += data.length; hasher.update(data); if (!fileWriteStream.write(data)) await once(fileWriteStream, 'drain') }
        fileWriteStream.end()
        await once(fileWriteStream, 'finish')
        stream.destroy()
        return { filePath, fileSha256: hasher.digest(), fileLength }
    } catch (error) {
        fileWriteStream.destroy(); stream.destroy()
        await fs.unlink(filePath).catch(() => { })
        throw error
    }
}

// ─── AUDIO / VIDEO ────────────────────────────────────────────────────────────

export const mediaMessageSHA256B64 = message => { const media = Object.values(message)[0]; return media?.fileSha256 && Buffer.from(media.fileSha256).toString('base64') }

export const getAudioDuration = async (buffer, logger) => {
    try {
        const mm = await import('music-metadata')
        if (Buffer.isBuffer(buffer)) return (await mm.parseBuffer(buffer, undefined, { duration: true })).format.duration
        if (typeof buffer === 'string') return (await mm.parseFile(buffer, { duration: true })).format.duration
        return (await mm.parseStream(buffer, undefined, { duration: true })).format.duration
    } catch (e) { logger?.debug({ trace: e?.stack || e }, 'failed to determine audio duration'); return undefined }
}

export const getAudioWaveform = async (buffer, logger) => {
    const fallback = new Uint8Array([0, 99, 0, 99, 0, 99, 0, 99, 88, 99, 0, 99, 0, 55, 0, 99, 0, 99, 0, 99, 0, 99, 0, 99, 88, 99, 0, 99, 0, 55, 0, 99, 0, 99, 0, 99, 0, 99, 88, 99, 0, 99, 0, 55, 0, 99, 0, 99, 0, 99, 0, 99, 0, 99, 88, 99, 0, 99, 0, 55, 0, 99, 0, 99])
    const bars = 64
    try {
        const ffmpegPath = await getFfmpegPath()
        const rawPCM = await new Promise(async (resolve, reject) => {
            const chunks = []
            let stderr = ''
            const ff = spawn(ffmpegPath, ['-i', 'pipe:0', '-f', 's16le', '-ac', '1', '-ar', '16000', 'pipe:1'], { stdio: ['pipe', 'pipe', 'pipe'] })
            ff.stdout.on('data', d => chunks.push(d))
            ff.stderr.on('data', d => { stderr += d })
            ff.on('close', code => code === 0 ? resolve(Buffer.concat(chunks)) : reject(new Error(`FFmpeg waveform exit ${code}: ${stderr.slice(-300)}`)))
            ff.on('error', reject)
            ff.stdin.end(Buffer.isBuffer(buffer) ? buffer : typeof buffer === 'string' ? await fs.readFile(buffer) : await toBuffer(buffer))
        })
        if (!rawPCM.length) throw new Error('empty PCM output')
        const samples = rawPCM.length >> 1
        const blockSize = Math.max(1, Math.floor(samples / bars))
        const blockSums = new Float64Array(bars)
        for (let i = 0; i < samples; i++) blockSums[Math.min(bars - 1, Math.floor(i / blockSize))] += Math.abs(rawPCM.readInt16LE(i * 2))
        const avg = Array.from(blockSums, sum => sum / blockSize / 32768)
        const max = Math.max(...avg, 0.0001)
        return new Uint8Array(avg.map(v => Math.max(0, Math.min(100, Math.round((v / max) * 100)))))
    } catch (e) { logger?.debug({ trace: e?.stack || e }, 'failed to generate waveform, using fallback'); return fallback }
}

// ─── FFMPEG CONVERTERS ────────────────────────────────────────────────────────

const _cleanupFiles = async (...paths) => Promise.all(paths.map(p => p ? fs.unlink(p).catch(() => { }) : Promise.resolve()))

const _animatedWebpToMp4 = async (buffer, ffmpegPath) => {
    const { default: sharp } = await import('sharp')
    const meta = await sharp(buffer, { animated: true }).metadata()
    const pages = meta.pages ?? 1, pageH = meta.pageHeight ?? Math.round(meta.height / pages)
    const delays = meta.delay?.length === pages ? meta.delay : Array(pages).fill(100)
    const uid = generateMessageIDV2()
    const frameDir = join(tmpdir(), `webp-frames-${uid}`), concatFile = join(tmpdir(), `webp-concat-${uid}.txt`), outputPath = join(tmpdir(), `webp-out-${uid}.mp4`)
    await fs.mkdir(frameDir, { recursive: true })
    try {
        const { data, info } = await sharp(buffer, { animated: true }).raw().toBuffer({ resolveWithObject: true })
        const frameSize = info.width * pageH * info.channels
        const framePaths = []
        for (let i = 0; i < pages; i++) {
            const fp = join(frameDir, `f${i}.png`)
            await sharp(data.slice(i * frameSize, (i + 1) * frameSize), { raw: { width: info.width, height: pageH, channels: info.channels } }).png().toFile(fp)
            framePaths.push(fp)
        }
        const lines = framePaths.flatMap((p, i) => [`file '${p}'`, `duration ${(delays[i] / 1000).toFixed(6)}`])
        lines.push(`file '${framePaths[framePaths.length - 1]}'`)
        await fs.writeFile(concatFile, lines.join('\n'))
        await _spawnFfmpeg(ffmpegPath, ['-y', '-f', 'concat', '-safe', '0', '-i', concatFile, '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18', '-pix_fmt', 'yuv420p', '-vf', 'scale=trunc(iw/2)*2:trunc(ih/2)*2', '-movflags', '+faststart', '-map_metadata', '-1', outputPath])
        return await fs.readFile(outputPath)
    } finally {
        const files = await fs.readdir(frameDir).catch(() => [])
        await Promise.all(files.map(f => fs.unlink(join(frameDir, f)).catch(() => { })))
        await fs.rmdir(frameDir).catch(() => { })
        await _cleanupFiles(concatFile, outputPath)
    }
}

const _tmpConvert = async (buffer, inSuffix, outSuffix, ffmpegArgs, logger) => {
    const inputPath = _trackTmp(join(tmpdir(), `in-${generateMessageIDV2()}${inSuffix}`))
    const outputPath = _trackTmp(join(tmpdir(), `out-${generateMessageIDV2()}${outSuffix}`))
    await fs.writeFile(inputPath, buffer)
    try { await _spawnFfmpeg(await getFfmpegPath(), ['-y', '-i', inputPath, ...ffmpegArgs, outputPath]); return await fs.readFile(outputPath) }
    finally { await _cleanupFiles(inputPath, outputPath); _untrackTmp(inputPath); _untrackTmp(outputPath) }
}

const convertToOpusBuffer = async (buffer, logger) => {
    const detected = await fileTypeFromBuffer(buffer)
    if (detected?.ext === 'opus') return buffer
    return _tmpConvert(buffer, detected?.ext ? `.${detected.ext}` : '', '.ogg', ['-vn', '-c:a', 'libopus', '-b:a', '128k', '-ar', '48000', '-ac', '1', '-vbr', 'on', '-compression_level', '10', '-frame_duration', '20', '-application', 'audio', '-map_metadata', '-1'], logger)
}

const convertToMp4Buffer = async (buffer, logger) => {
    try {
        const { default: sharp } = await import('sharp')
        const meta = await sharp(buffer, { animated: true }).metadata()
        if (meta.format === 'webp' && (meta.pages ?? 1) > 1) return await _animatedWebpToMp4(buffer, await getFfmpegPath())
    } catch { }
    const detected = await fileTypeFromBuffer(buffer)
    return _tmpConvert(buffer, detected?.ext ? `.${detected.ext}` : '', '.mp4', ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-pix_fmt', 'yuv420p', '-vf', 'scale=trunc(iw/2)*2:trunc(ih/2)*2', '-c:a', 'aac', '-b:a', '128k', '-movflags', '+faststart', '-map_metadata', '-1'], logger)
}

// ─── PREPARE / ENCRYPT STREAM ─────────────────────────────────────────────────

export const prepareStream = async (media, mediaType, { logger, saveOriginalFileIfRequired, opts, convertVideo } = {}) => {
    const { stream, type } = await getStream(media, opts)
    let buffer = await toBuffer(stream)
    if (mediaType === 'video' && convertVideo) {
        try { buffer = await convertToMp4Buffer(buffer, logger) } catch (e) { logger?.error('failed to convert video:', e) }
    }
    let bodyPath, didSaveToTmpPath = false
    try {
        if (type === 'file') bodyPath = media.url
        else if (saveOriginalFileIfRequired) { bodyPath = join(tmpdir(), mediaType + generateMessageIDV2()); await fs.writeFile(bodyPath, buffer); didSaveToTmpPath = true }
        return { mediaKey: undefined, encWriteStream: buffer, fileLength: buffer.length, fileSha256: Crypto.createHash('sha256').update(buffer).digest(), fileEncSha256: undefined, bodyPath, didSaveToTmpPath }
    } catch (error) {
        if (didSaveToTmpPath && bodyPath) await fs.unlink(bodyPath).catch(() => { })
        throw error
    }
}

export const encryptedStream = async (media, mediaType, { logger, saveOriginalFileIfRequired, opts, mediaKey: providedMediaKey, isPtt, forceOpus, convertVideo } = {}) => {
    const { stream, type } = await getStream(media, opts)
    let finalStream = stream, opusConverted = false
    if (mediaType === 'audio' && (isPtt === true || forceOpus === true)) {
        try { finalStream = toReadable(await convertToOpusBuffer(await toBuffer(stream), logger)); opusConverted = true }
        catch { finalStream = (await getStream(media, opts)).stream }
    }
    if (mediaType === 'video' && convertVideo === true) finalStream = toReadable(await convertToMp4Buffer(await toBuffer(finalStream), logger))

    const mediaKey = providedMediaKey || Crypto.randomBytes(32)
    const { cipherKey, iv, macKey } = await getMediaKeys(mediaKey, mediaType)
    const aes = Crypto.createCipheriv('aes-256-cbc', cipherKey, iv)
    const hmac = Crypto.createHmac('sha256', macKey).update(iv)
    const sha256Plain = Crypto.createHash('sha256'), sha256Enc = Crypto.createHash('sha256')
    const encChunks = [], plainChunks = saveOriginalFileIfRequired ? [] : null
    let fileLength = 0, encFilePath = null, originalFilePath = null

    try {
        for await (const data of finalStream) {
            fileLength += data.length
            if (type === 'remote' && opts?.maxContentLength && fileLength > opts.maxContentLength) throw new Boom('content length exceeded', { data: { media, type } })
            plainChunks?.push(data)
            sha256Plain.update(data)
            const encrypted = aes.update(data)
            sha256Enc.update(encrypted); hmac.update(encrypted); encChunks.push(encrypted)
        }
        const finalData = aes.final()
        sha256Enc.update(finalData); hmac.update(finalData); encChunks.push(finalData)
        const mac = hmac.digest().slice(0, 10)
        sha256Enc.update(mac); encChunks.push(mac)
        finalStream.destroy()

        const encBuffer = Buffer.concat(encChunks)
        const fileEncSha256 = sha256Enc.digest()
        const fileSha256 = sha256Plain.digest()

        if (plainChunks) {
            try { originalFilePath = join(tmpdir(), mediaType + generateMessageIDV2() + '-original'); await fs.writeFile(originalFilePath, Buffer.concat(plainChunks)) }
            catch { originalFilePath = null }
        }
        let useMemory = false
        try { encFilePath = join(tmpdir(), mediaType + generateMessageIDV2() + '-enc'); await fs.writeFile(encFilePath, encBuffer) }
        catch { encFilePath = null; useMemory = true }

        const cleanup = async () => _cleanupFiles(encFilePath, originalFilePath)
        return { mediaKey, bodyPath: originalFilePath, encFilePath, encBuffer: useMemory ? encBuffer : null, mac, fileEncSha256, fileSha256, fileLength, opusConverted, cleanup }
    } catch (error) {
        aes.destroy(); hmac.destroy(); sha256Plain.destroy(); sha256Enc.destroy(); finalStream.destroy()
        await _cleanupFiles(encFilePath, originalFilePath)
        throw error
    }
}

// ─── DOWNLOAD ─────────────────────────────────────────────────────────────────

const DEF_HOST = 'mmg.whatsapp.net'
const AES_CHUNK_SIZE = 16
const toSmallestChunkSize = num => Math.floor(num / AES_CHUNK_SIZE) * AES_CHUNK_SIZE

export const getUrlFromDirectPath = directPath => directPath ? (directPath.startsWith('http') ? directPath : `https://${DEF_HOST}${directPath.startsWith('/') ? '' : '/'}${directPath}`) : undefined

export const downloadContentFromMessage = async ({ mediaKey, directPath, url }, type, opts = {}) => {
    const downloadUrl = url?.startsWith('https://mmg.whatsapp.net/') ? url : getUrlFromDirectPath(directPath)
    if (!downloadUrl) throw new Boom('No valid media URL or directPath present', { statusCode: 400 })
    return downloadEncryptedContent(downloadUrl, await getMediaKeys(mediaKey, type), opts)
}

export const downloadEncryptedContent = async (downloadUrl, { cipherKey, iv }, { startByte, endByte, options } = {}) => {
    let bytesFetched = 0, startChunk = 0, firstBlockIsIV = false
    if (startByte) {
        const chunk = toSmallestChunkSize(startByte || 0)
        if (chunk) { startChunk = chunk - AES_CHUNK_SIZE; bytesFetched = chunk; firstBlockIsIV = true }
    }
    const endChunk = endByte ? toSmallestChunkSize(endByte || 0) + AES_CHUNK_SIZE : undefined
    const headers = { ...(options?.headers ? (Array.isArray(options.headers) ? Object.fromEntries(options.headers) : options.headers) : {}), Origin: DEFAULT_ORIGIN }
    if (startChunk || endChunk) headers.Range = `bytes=${startChunk}-${endChunk || ''}`
    const fetched = await getHttpStream(downloadUrl, { ...(options || {}), headers })
    let remainingBytes = Buffer.from([]), aes
    const pushBytes = (bytes, push) => {
        if (startByte || endByte) {
            const start = bytesFetched >= startByte ? undefined : Math.max(startByte - bytesFetched, 0)
            const end = bytesFetched + bytes.length < endByte ? undefined : Math.max(endByte - bytesFetched, 0)
            push(bytes.slice(start, end)); bytesFetched += bytes.length
        } else push(bytes)
    }
    return fetched.pipe(new Transform({
        transform(chunk, _, callback) {
            let data = Buffer.concat([remainingBytes, chunk])
            const decryptLength = toSmallestChunkSize(data.length)
            remainingBytes = data.slice(decryptLength); data = data.slice(0, decryptLength)
            if (!aes) {
                let ivValue = iv
                if (firstBlockIsIV) { ivValue = data.slice(0, AES_CHUNK_SIZE); data = data.slice(AES_CHUNK_SIZE) }
                aes = Crypto.createDecipheriv('aes-256-cbc', cipherKey, ivValue)
                if (endByte) aes.setAutoPadding(false)
            }
            try { pushBytes(aes.update(data), b => this.push(b)); callback() } catch (error) { callback(error) }
        },
        final(callback) { try { pushBytes(aes.final(), b => this.push(b)); callback() } catch (error) { callback(error) } }
    }), { end: true })
}

// ─── UPLOAD ───────────────────────────────────────────────────────────────────

export const encodeBase64EncodedStringForUpload = b64 => encodeURIComponent(b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''))

export const extensionForMediaMessage = message => {
    const type = Object.keys(message)[0]
    if (type === 'locationMessage' || type === 'liveLocationMessage' || type === 'productMessage') return '.jpeg'
    return message[type].mimetype.split(';')[0]?.split('/')[1]
}

const httpsPost = (url, body, headers, signal) => new Promise((resolve, reject) => {
    const urlObj = new URL(url)
    const isHttps = urlObj.protocol === 'https:'
    const buf = Buffer.isBuffer(body) ? body : null
    const req = (isHttps ? https : http).request({ hostname: urlObj.hostname, port: urlObj.port || (isHttps ? 443 : 80), path: urlObj.pathname + urlObj.search, method: 'POST', family: 4, headers: { ...headers, ...(buf ? { 'Content-Length': buf.length } : {}) } }, res => {
        const chunks = []
        res.on('data', d => chunks.push(d))
        res.on('end', () => { let json = null; try { json = JSON.parse(Buffer.concat(chunks).toString()) } catch { }; resolve({ status: res.statusCode, ok: res.statusCode >= 200 && res.statusCode < 300, json: async () => json }) })
        res.on('error', reject)
    })
    req.on('error', reject)
    if (signal) {
        if (signal.aborted) { req.destroy(); return reject(new Error('Upload aborted')) }
        const onAbort = () => { req.destroy(); reject(new Error('Upload aborted')) }
        signal.addEventListener('abort', onAbort, { once: true })
        req.on('close', () => signal.removeEventListener('abort', onAbort))
    }
    buf ? req.end(buf) : body.pipe(req)
})

export const getWAUploadToServer = ({ customUploadHosts, logger, options }, refreshMediaConn) => async (stream, { mediaType, fileEncSha256B64, newsletter, timeoutMs }) => {
    const toUploadBody = async input => {
        if (!input) throw new Boom('Upload input is null or undefined', { statusCode: 400 })
        if (Buffer.isBuffer(input)) return input
        if (typeof input === 'string') return fs.readFile(input)
        if (typeof ReadableStream !== 'undefined' && input instanceof ReadableStream) return Readable.fromWeb(input)
        if (typeof input.pipe === 'function' || typeof input[Symbol.asyncIterator] === 'function') return input
        throw new Boom(`Unsupported upload input type: ${Object.prototype.toString.call(input)}`, { statusCode: 400 })
    }
    let reqBody
    try { reqBody = await toUploadBody(stream) } catch (err) { logger?.error({ err: err.message }, 'failed to prepare upload body'); throw err }
    fileEncSha256B64 = encodeBase64EncodedStringForUpload(fileEncSha256B64)
    let media = MEDIA_PATH_MAP[mediaType]
    if (newsletter) media = media?.replace('/mms/', '/newsletter/newsletter-')
    if (!media) throw new Boom(`No media path found for type: ${mediaType}`, { statusCode: 400 })
    let uploadInfo = await refreshMediaConn(false)
    const hosts = [...(customUploadHosts ?? []), ...(uploadInfo.hosts ?? [])]
    if (!hosts.length) throw new Boom('No upload hosts available', { statusCode: 503 })
    let urls, lastError
    for (const { hostname, maxContentLengthBytes } of hosts) {
        for (let attempt = 1; attempt <= 2; attempt++) {
            try {
                if (attempt > 1) { uploadInfo = await refreshMediaConn(true); reqBody = await toUploadBody(stream) }
                if (maxContentLengthBytes && Buffer.isBuffer(reqBody) && reqBody.length > maxContentLengthBytes) break
                const auth = encodeURIComponent(uploadInfo.auth)
                const url = `https://${hostname}${media}/${fileEncSha256B64}?auth=${auth}&token=${fileEncSha256B64}`
                const controller = new AbortController()
                const timer = timeoutMs ? setTimeout(() => controller.abort(), timeoutMs) : null
                let response
                try { response = await httpsPost(url, reqBody, { ...(Array.isArray(options?.headers) ? Object.fromEntries(options.headers) : (options?.headers ?? {})), 'Content-Type': 'application/octet-stream', Origin: DEFAULT_ORIGIN }, controller.signal) }
                finally { if (timer) clearTimeout(timer) }
                const result = await response.json().catch(() => null)
                if (result?.url || result?.directPath) { urls = { mediaUrl: result.url, directPath: result.direct_path, handle: result.handle }; break }
                lastError = new Error(`${hostname} rejected upload (HTTP ${response.status}): ${JSON.stringify(result)}`)
            } catch (err) { lastError = err; if (attempt < 2) await new Promise(r => setTimeout(r, 500 * attempt)) }
        }
        if (urls) break
    }
    if (!urls) throw new Boom(`Media upload failed on all hosts. Last error: ${lastError?.message ?? 'unknown'}`, { statusCode: 500, data: { lastError: lastError?.message } })
    return urls
}

// ─── MEDIA RETRY ──────────────────────────────────────────────────────────────

const getMediaRetryKey = mediaKey => hkdf(mediaKey, 32, { info: 'WhatsApp Media Retry Notification' })

export const encryptMediaRetryRequest = async (key, mediaKey, meId) => {
    const iv = Crypto.randomBytes(12)
    const ciphertext = aesEncryptGCM(proto.ServerErrorReceipt.encode({ stanzaId: key.id }).finish(), await getMediaRetryKey(mediaKey), iv, Buffer.from(key.id))
    return { tag: 'receipt', attrs: { id: key.id, to: jidNormalizedUser(meId), type: 'server-error' }, content: [{ tag: 'encrypt', attrs: {}, content: [{ tag: 'enc_p', attrs: {}, content: ciphertext }, { tag: 'enc_iv', attrs: {}, content: iv }] }, { tag: 'rmr', attrs: { jid: key.remoteJid, from_me: (!!key.fromMe).toString(), participant: key.participant } }] }
}

export const decodeMediaRetryNode = node => {
    const rmrNode = getBinaryNodeChild(node, 'rmr')
    const event = { key: { id: node.attrs.id, remoteJid: rmrNode.attrs.jid, fromMe: rmrNode.attrs.from_me === 'true', participant: rmrNode.attrs.participant } }
    const errorNode = getBinaryNodeChild(node, 'error')
    if (errorNode) { event.error = new Boom(`Failed to re-upload media (${+errorNode.attrs.code})`, { data: errorNode.attrs, statusCode: getStatusCodeForMediaRetry(+errorNode.attrs.code) }); return event }
    const encNode = getBinaryNodeChild(node, 'encrypt')
    const ciphertext = getBinaryNodeChildBuffer(encNode, 'enc_p')
    const iv = getBinaryNodeChildBuffer(encNode, 'enc_iv')
    event[ciphertext && iv ? 'media' : 'error'] = ciphertext && iv ? { ciphertext, iv } : new Boom('Failed to re-upload media (missing ciphertext)', { statusCode: 404 })
    return event
}

export const decryptMediaRetryData = async ({ ciphertext, iv }, mediaKey, msgId) => proto.MediaRetryNotification.decode(aesDecryptGCM(ciphertext, await getMediaRetryKey(mediaKey), iv, Buffer.from(msgId)))

export const getStatusCodeForMediaRetry = code => MEDIA_RETRY_STATUS_MAP[code]
const MEDIA_RETRY_STATUS_MAP = {
    [proto.MediaRetryNotification.ResultType.SUCCESS]: 200,
    [proto.MediaRetryNotification.ResultType.DECRYPTION_ERROR]: 412,
    [proto.MediaRetryNotification.ResultType.NOT_FOUND]: 404,
    [proto.MediaRetryNotification.ResultType.GENERAL_ERROR]: 418
}