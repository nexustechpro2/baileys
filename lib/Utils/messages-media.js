import { Boom } from '@hapi/boom'
import { spawn } from 'child_process'
import * as Crypto from 'crypto'
import { once } from 'events'
import { createReadStream, createWriteStream, mkdirSync, promises as fs } from 'fs'
import { tmpdir as osTmpdir } from 'os'
import { join } from 'path'
import { Readable, Transform } from 'stream'
import { URL } from 'url'
import { proto } from '../../WAProto/index.js'
import { DEFAULT_ORIGIN, MEDIA_HKDF_KEY_MAPPING, MEDIA_PATH_MAP } from '../Defaults/index.js'
import { getBinaryNodeChild, getBinaryNodeChildBuffer, jidNormalizedUser } from '../WABinary/index.js'
import { aesDecryptGCM, aesEncryptGCM, hkdf } from './crypto.js'
import { generateMessageIDV2 } from './generics.js'
import { fileTypeFromBuffer } from 'file-type'
// ─── IMAGE PROCESSING ─────────────────────────────────────────────────────────
export const getImageProcessingLibrary = async () => {
    const [jimp, sharp] = await Promise.all([
        import('jimp').catch(() => null),
        import('sharp').catch(() => null)
    ])
    if (sharp) return { sharp }
    if (jimp) return { jimp }
    throw new Boom('No image processing library available')
}

// ─── CUSTOM TMPDIR (real disk, fall back to tmpfs if cwd isnt writable (e.g, read-only Docker containers)) ─────────────────────────────────────
const BAILEYS_TMP_DIR = (() => {
    const candidates = [
        join(process.cwd(), '.b-tmp'),
        join(osTmpdir(), 'b-tmp'),
    ]
    for (const dir of candidates) {
        try {
            mkdirSync(dir, { recursive: true, mode: 0o700 })
            return dir
        } catch { }
    }
    return osTmpdir()
})()
export const tmpdir = () => BAILEYS_TMP_DIR

// ─── FFMPEG ───────────────────────────────────────────────────────────────────
let ffmpegPathResolved = null
const getFfmpegPath = async () => {
    if (ffmpegPathResolved) return ffmpegPathResolved
    try {
        const { default: staticPath } = await import('ffmpeg-static')
        if (staticPath) { ffmpegPathResolved = staticPath; return staticPath }
    } catch { }
    ffmpegPathResolved = 'ffmpeg'
    return 'ffmpeg'
}

// ─── HKDF ─────────────────────────────────────────────────────────────────────
export const hkdfInfoKey = (type) => `WhatsApp ${MEDIA_HKDF_KEY_MAPPING[type]} Keys`

export const getMediaKeys = async (buffer, mediaType) => {
    if (!buffer) throw new Boom('Cannot derive from empty media key')
    if (typeof buffer === 'string') buffer = Buffer.from(buffer.replace('data:;base64,', ''), 'base64')
    const expandedMediaKey = hkdf(buffer, 112, { info: hkdfInfoKey(mediaType) })
    return {
        iv: expandedMediaKey.slice(0, 16),
        cipherKey: expandedMediaKey.slice(16, 48),
        macKey: expandedMediaKey.slice(48, 80)
    }
}

// ─── RAW UPLOAD ───────────────────────────────────────────────────────────────
export const getRawMediaUploadData = async (media, mediaType, logger) => {
    const { stream } = await getStream(media)
    const hasher = Crypto.createHash('sha256')
    const filePath = join(tmpdir(), mediaType + generateMessageIDV2())
    const fileWriteStream = createWriteStream(filePath)
    let fileLength = 0
    try {
        for await (const data of stream) {
            fileLength += data.length
            hasher.update(data)
            if (!fileWriteStream.write(data)) await once(fileWriteStream, 'drain')
        }
        fileWriteStream.end()
        await once(fileWriteStream, 'finish')
        stream.destroy()
        logger?.debug('hashed data for raw upload')
        return { filePath, fileSha256: hasher.digest(), fileLength }
    } catch (error) {
        fileWriteStream.destroy()
        stream.destroy()
        try { await fs.unlink(filePath) } catch { }
        throw error
    }
}

// ─── THUMBNAILS ───────────────────────────────────────────────────────────────
const extractVideoThumb = async (path, destPath, time, size) => {
    const ffmpegPath = await getFfmpegPath()
    return new Promise((resolve, reject) => {
        const ff = spawn(ffmpegPath, ['-ss', time, '-i', path, '-y', '-vf', `scale=${size.width}:-1`, '-vframes', '1', '-f', 'image2', destPath])
        ff.on('close', code => code === 0 ? resolve() : reject(new Error(`FFmpeg thumb exited with code ${code}`)))
        ff.on('error', reject)
    })
}

export const extractImageThumb = async (bufferOrFilePath, width = 32) => {
    if (bufferOrFilePath instanceof Readable) bufferOrFilePath = await toBuffer(bufferOrFilePath)
    const lib = await getImageProcessingLibrary()
    if ('sharp' in lib && typeof lib.sharp?.default === 'function') {
        const img = lib.sharp.default(bufferOrFilePath)
        const dimensions = await img.metadata()
        const buffer = await img.resize(width).jpeg({ quality: 95 }).toBuffer()
        return { buffer, original: { width: dimensions.width, height: dimensions.height } }
    }
    if ('jimp' in lib && typeof lib.jimp?.Jimp === 'object') {
        const jimp = await lib.jimp.Jimp.read(bufferOrFilePath)
        const buffer = await jimp.resize({ w: width, mode: lib.jimp.ResizeStrategy.BILINEAR }).getBuffer('image/jpeg', { quality: 95 })
        return { buffer, original: { width: jimp.width, height: jimp.height } }
    }
    throw new Boom('No image processing library available')
}

export async function generateThumbnail(file, mediaType, options) {
    let thumbnail, originalImageDimensions
    if (mediaType === 'image') {
        const { buffer, original } = await extractImageThumb(file)
        thumbnail = buffer.toString('base64')
        if (original.width && original.height) originalImageDimensions = original
    } else if (mediaType === 'video') {
        const imgFilename = join(tmpdir(), generateMessageIDV2() + '.jpg')
        try {
            await extractVideoThumb(file, imgFilename, '00:00:00', { width: 32, height: 32 })
            thumbnail = (await fs.readFile(imgFilename)).toString('base64')
            await fs.unlink(imgFilename)
        } catch (err) {
            options.logger?.debug('could not generate video thumb: ' + err)
        }
    }
    return { thumbnail, originalImageDimensions }
}

// ─── PROFILE PICTURE ──────────────────────────────────────────────────────────
export const encodeBase64EncodedStringForUpload = (b64) => encodeURIComponent(b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''))

export const generateProfilePicture = async (mediaUpload) => {
    const bufferOrFilePath = Buffer.isBuffer(mediaUpload) ? mediaUpload : 'url' in mediaUpload ? mediaUpload.url.toString() : await toBuffer(mediaUpload.stream)
    const lib = await getImageProcessingLibrary()
    if ('sharp' in lib && typeof lib.sharp?.default === 'function') {
        const img = await lib.sharp.default(bufferOrFilePath).resize(720, 720, { fit: 'inside' }).jpeg({ quality: 80 }).toBuffer()
        return { img }
    }
    if ('jimp' in lib && typeof lib.jimp?.read === 'function') {
        const { read, MIME_JPEG } = lib.jimp
        const image = await read(bufferOrFilePath)
        const img = await image.crop(0, 0, image.getWidth(), image.getHeight()).scaleToFit(720, 720).getBufferAsync(MIME_JPEG)
        return { img }
    }
    throw new Boom('No image processing library available')
}

// ─── AUDIO ────────────────────────────────────────────────────────────────────
export const mediaMessageSHA256B64 = (message) => {
    const media = Object.values(message)[0]
    return media?.fileSha256 && Buffer.from(media.fileSha256).toString('base64')
}

export async function getAudioDuration(buffer, logger) {
    try {
        const musicMetadata = await import('music-metadata')
        if (Buffer.isBuffer(buffer)) return (await musicMetadata.parseBuffer(buffer, undefined, { duration: true })).format.duration
        if (typeof buffer === 'string') return (await musicMetadata.parseFile(buffer, { duration: true })).format.duration
        return (await musicMetadata.parseStream(buffer, undefined, { duration: true })).format.duration
    } catch (e) {
        logger?.debug({ trace: e?.stack || e }, 'failed to determine audio duration')
        return undefined
    }
}

export async function getAudioWaveform(buffer, logger) {
    const bars = 64
    const fallback = new Uint8Array([0, 99, 0, 99, 0, 99, 0, 99, 88, 99, 0, 99, 0, 55, 0, 99, 0, 99, 0, 99, 0, 99, 0, 99, 88, 99, 0, 99, 0, 55, 0, 99, 0, 99, 0, 99, 0, 99, 88, 99, 0, 99, 0, 55, 0, 99, 0, 99, 0, 99, 0, 99, 0, 99, 88, 99, 0, 99, 0, 55, 0, 99, 0, 99])
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
            ff.stdin.end(Buffer.isBuffer(buffer) ? buffer : await toBuffer(buffer))
        })
        if (!rawPCM.length) throw new Error('empty PCM output')

        const samples = rawPCM.length >> 1
        const blockSize = Math.max(1, Math.floor(samples / bars))
        const blockSums = new Float64Array(bars)
        for (let i = 0; i < samples; i++) {
            const block = Math.min(bars - 1, Math.floor(i / blockSize))
            blockSums[block] += Math.abs(rawPCM.readInt16LE(i * 2))
        }
        const avg = Array.from(blockSums, sum => sum / blockSize / 32768)
        const max = Math.max(...avg, 0.0001)
        return new Uint8Array(avg.map(v => Math.max(0, Math.min(100, Math.round((v / max) * 100)))))
    } catch (e) {
        logger?.debug({ trace: e?.stack || e }, 'failed to generate waveform, using fallback')
        return fallback
    }
}

// ─── FFMPEG CONVERTERS ────────────────────────────────────────────────────────
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
        await new Promise((resolve, reject) => {
            const ff = spawn(ffmpegPath, ['-y', '-f', 'concat', '-safe', '0', '-i', concatFile, '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18', '-pix_fmt', 'yuv420p', '-vf', 'scale=trunc(iw/2)*2:trunc(ih/2)*2', '-movflags', '+faststart', '-map_metadata', '-1', outputPath], { stdio: ['ignore', 'ignore', 'pipe'] })
            let stderr = ''
            ff.stderr.on('data', d => { stderr += d })
            ff.on('close', code => code === 0 ? resolve() : reject(new Error(`FFmpeg animated WebP exit ${code}:\n${stderr.slice(-500)}`)))
            ff.on('error', reject)
        })
        return await fs.readFile(outputPath)
    } finally {
        const files = await fs.readdir(frameDir).catch(() => [])
        await Promise.all(files.map(f => fs.unlink(join(frameDir, f)).catch(() => { })))
        await fs.rmdir(frameDir).catch(() => { })
        await fs.unlink(concatFile).catch(() => { })
        await fs.unlink(outputPath).catch(() => { })
    }
}

const convertToOpusBuffer = async (buffer, logger) => {
    const detected = await fileTypeFromBuffer(buffer)
    if (detected?.ext === 'opus') return buffer
    const ffmpegPath = await getFfmpegPath()
    const inputExt = detected?.ext ? `.${detected.ext}` : ''
    const inputPath = join(tmpdir(), 'opus-in-' + generateMessageIDV2() + inputExt)
    const outputPath = join(tmpdir(), 'opus-out-' + generateMessageIDV2() + '.ogg')
    await fs.writeFile(inputPath, buffer)
    try {
        await new Promise((resolve, reject) => {
            const ff = spawn(ffmpegPath, ['-y', '-i', inputPath, '-c:a', 'libopus', '-b:a', '128k', '-ar', '48000', '-ac', '1', '-vbr', 'on', '-compression_level', '10', '-frame_duration', '20', '-application', 'audio', '-map_metadata', '-1', outputPath], { stdio: ['ignore', 'ignore', 'pipe'] })
            ff.on('close', code => code === 0 ? resolve() : reject(new Error(`FFmpeg Opus exited with code ${code}`)))
            ff.on('error', reject)
        })
        return await fs.readFile(outputPath)
    } finally {
        try { await fs.unlink(inputPath) } catch { }
        try { await fs.unlink(outputPath) } catch { }
    }
}

const convertToMp4Buffer = async (buffer, logger) => {
    const ffmpegPath = await getFfmpegPath()
    try {
        const { default: sharp } = await import('sharp')
        const meta = await sharp(buffer, { animated: true }).metadata()
        if (meta.format === 'webp' && (meta.pages ?? 1) > 1) return await _animatedWebpToMp4(buffer, ffmpegPath)
    } catch { }
    const detected = await fileTypeFromBuffer(buffer)
    const inputExt = detected?.ext ? `.${detected.ext}` : ''
    const inputPath = join(tmpdir(), 'mp4-in-' + generateMessageIDV2() + inputExt)
    const outputPath = join(tmpdir(), 'mp4-out-' + generateMessageIDV2() + '.mp4')
    await fs.writeFile(inputPath, buffer)
    try {
        await new Promise((resolve, reject) => {
            const ff = spawn(ffmpegPath, ['-y', '-i', inputPath, '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-pix_fmt', 'yuv420p', '-vf', 'scale=trunc(iw/2)*2:trunc(ih/2)*2', '-c:a', 'aac', '-b:a', '128k', '-movflags', '+faststart', '-map_metadata', '-1', outputPath], { stdio: ['ignore', 'ignore', 'pipe'] })
            let stderr = ''
            ff.stderr.on('data', d => { stderr += d.toString() })
            ff.on('close', code => code === 0 ? resolve() : reject(new Error(`FFmpeg MP4 exited with code ${code}:\n${stderr.slice(-500)}`)))
            ff.on('error', reject)
        })
        return await fs.readFile(outputPath)
    } finally {
        try { await fs.unlink(inputPath) } catch { }
        try { await fs.unlink(outputPath) } catch { }
    }
}

// ─── STREAM UTILS ─────────────────────────────────────────────────────────────
export const toReadable = (buffer) => {
    const readable = new Readable({ read: () => { } })
    readable.push(buffer)
    readable.push(null)
    return readable
}

export const toBuffer = async (stream) => {
    const chunks = []
    for await (const chunk of stream) chunks.push(chunk)
    stream.destroy()
    return Buffer.concat(chunks)
}

export const getStream = async (item, opts) => {
    if (!item) throw new Boom('Item is required for getStream', { statusCode: 400 })
    if (Buffer.isBuffer(item)) return { stream: toReadable(item), type: 'buffer' }
    if (item?.stream?.pipe) return { stream: item.stream, type: 'readable' }
    if (item?.pipe) return { stream: item, type: 'readable' }
    const isHttpUrl = (str) => { try { const u = new URL(str); return u.protocol === 'http:' || u.protocol === 'https:' } catch { return false } }

    if (item && typeof item === 'object' && 'url' in item) {
        const urlStr = item.url.toString()
        if (Buffer.isBuffer(item.url)) return { stream: toReadable(item.url), type: 'buffer' }
        if (urlStr.startsWith('data:')) return { stream: toReadable(Buffer.from(urlStr.split(',')[1], 'base64')), type: 'buffer' }
        if (isHttpUrl(urlStr)) return { stream: await getHttpStream(item.url, opts), type: 'remote' }
        return { stream: createReadStream(item.url), type: 'file' }
    }
    if (typeof item === 'string') {
        if (item.startsWith('data:')) return { stream: toReadable(Buffer.from(item.split(',')[1], 'base64')), type: 'buffer' }
        if (isHttpUrl(item)) return { stream: await getHttpStream(item, opts), type: 'remote' }
        return { stream: createReadStream(item), type: 'file' }
    }
    throw new Boom(`Invalid input type for getStream: ${typeof item}`, { statusCode: 400 })
}

export const getHttpStream = async (url, options = {}) => {
    const response = await fetch(url.toString(), { dispatcher: options.dispatcher, method: 'GET', headers: options.headers })
    if (!response.ok) throw new Boom(`Failed to fetch stream from ${url}`, { statusCode: response.status, data: { url } })
    const body = response.body
    if (body && typeof body === 'object' && 'pipeTo' in body && typeof body.pipeTo === 'function') return Readable.fromWeb(body)
    if (body && typeof body.pipe === 'function' && typeof body.read === 'function') return body
    throw new Error('Response body is not a readable stream')
}

// ─── ENCRYPT / PREPARE STREAM ─────────────────────────────────────────────────
export const prepareStream = async (media, mediaType, { logger, saveOriginalFileIfRequired, opts, convertVideo } = {}) => {
    const { stream, type } = await getStream(media, opts)
    logger?.debug('fetched media stream')
    let buffer = await toBuffer(stream)
    if (mediaType === 'video' && convertVideo) {
        try { buffer = await convertToMp4Buffer(buffer, logger); logger?.debug('converted video to mp4') }
        catch (e) { logger?.error('failed to convert video:', e) }
    }
    let bodyPath, didSaveToTmpPath = false
    try {
        if (type === 'file') bodyPath = media.url
        else if (saveOriginalFileIfRequired) {
            bodyPath = join(tmpdir(), mediaType + generateMessageIDV2())
            await fs.writeFile(bodyPath, buffer)
            didSaveToTmpPath = true
        }
        return { mediaKey: undefined, encWriteStream: buffer, fileLength: buffer.length, fileSha256: Crypto.createHash('sha256').update(buffer).digest(), fileEncSha256: undefined, bodyPath, didSaveToTmpPath }
    } catch (error) {
        if (didSaveToTmpPath && bodyPath) try { await fs.unlink(bodyPath) } catch { }
        throw error
    }
}

export const encryptedStream = async (media, mediaType, { logger, saveOriginalFileIfRequired, opts, mediaKey: providedMediaKey, isPtt, forceOpus, convertVideo } = {}) => {
    const { stream, type } = await getStream(media, opts)
    let finalStream = stream, opusConverted = false
    if (mediaType === 'audio' && (isPtt === true || forceOpus === true)) {
        try {
            finalStream = toReadable(await convertToOpusBuffer(await toBuffer(stream), logger))
            opusConverted = true
            logger?.debug('converted audio to Opus')
        } catch (error) {
            logger?.error('failed to convert audio to Opus, using original')
            finalStream = (await getStream(media, opts)).stream
        }
    }
    if (mediaType === 'video' && convertVideo === true) {
        finalStream = toReadable(await convertToMp4Buffer(await toBuffer(finalStream), logger))
        logger?.debug('converted video to mp4')
    }

    const mediaKey = providedMediaKey || Crypto.randomBytes(32)
    const { cipherKey, iv, macKey } = await getMediaKeys(mediaKey, mediaType)

    const aes = Crypto.createCipheriv('aes-256-cbc', cipherKey, iv)
    const hmac = Crypto.createHmac('sha256', macKey).update(iv)
    const sha256Plain = Crypto.createHash('sha256')
    const sha256Enc = Crypto.createHash('sha256')
    const encChunks = []
    const plainChunks = saveOriginalFileIfRequired ? [] : null
    let fileLength = 0

    try {
        for await (const data of finalStream) {
            fileLength += data.length
            if (type === 'remote' && opts?.maxContentLength && fileLength > opts.maxContentLength) {
                throw new Boom('content length exceeded', { data: { media, type } })
            }
            if (plainChunks) plainChunks.push(data)
            sha256Plain.update(data)
            const encrypted = aes.update(data)
            sha256Enc.update(encrypted)
            hmac.update(encrypted)
            encChunks.push(encrypted)
        }

        const finalData = aes.final()
        sha256Enc.update(finalData)
        hmac.update(finalData)
        encChunks.push(finalData)

        const mac = hmac.digest().slice(0, 10)
        sha256Enc.update(mac)
        encChunks.push(mac)

        finalStream.destroy()
        logger?.debug('encrypted data in memory')

        const encBuffer = Buffer.concat(encChunks)
        const fileEncSha256 = sha256Enc.digest()
        const fileSha256 = sha256Plain.digest()

        let originalFilePath = null
        if (plainChunks) {
            try {
                originalFilePath = join(tmpdir(), mediaType + generateMessageIDV2() + '-original')
                await fs.writeFile(originalFilePath, Buffer.concat(plainChunks))
                logger?.debug('saved original file for processing')
            } catch (err) {
                logger?.warn({ err: err.message }, 'failed to save original file, bodyPath will be null')
                originalFilePath = null
            }
        }
        let encFilePath = null
        let useMemory = false

        try {
            encFilePath = join(tmpdir(), mediaType + generateMessageIDV2() + '-enc')
            await fs.writeFile(encFilePath, encBuffer)
            logger?.debug('wrote enc file to disk')
        } catch (err) {
            logger?.warn({ err: err.message, code: err.code }, 'failed to write enc file to disk, falling back to memory upload')
            if (encFilePath) {
                try { await fs.unlink(encFilePath) } catch { }
                encFilePath = null
            }
            useMemory = true
        }

        const cleanup = async () => {
            if (encFilePath) try { await fs.unlink(encFilePath) } catch { }
            if (originalFilePath) try { await fs.unlink(originalFilePath) } catch { }
        }

        return {
            mediaKey,
            bodyPath: originalFilePath,
            encFilePath,
            encBuffer: useMemory ? encBuffer : null,
            mac,
            fileEncSha256,
            fileSha256,
            fileLength,
            opusConverted,
            cleanup
        }
    } catch (error) {
        aes.destroy()
        hmac.destroy()
        sha256Plain.destroy()
        sha256Enc.destroy()
        finalStream.destroy()
        if (encFilePath) try { await fs.unlink(encFilePath) } catch { }
        if (originalFilePath) try { await fs.unlink(originalFilePath) } catch { }
        throw error
    }
}

// ─── DOWNLOAD ─────────────────────────────────────────────────────────────────
const DEF_HOST = 'mmg.whatsapp.net'
const AES_CHUNK_SIZE = 16
const toSmallestChunkSize = (num) => Math.floor(num / AES_CHUNK_SIZE) * AES_CHUNK_SIZE

export const getUrlFromDirectPath = (directPath) => `https://${DEF_HOST}${directPath}`

export const downloadContentFromMessage = async ({ mediaKey, directPath, url }, type, opts = {}) => {
    const isValidMediaUrl = url?.startsWith('https://mmg.whatsapp.net/')
    const downloadUrl = isValidMediaUrl ? url : getUrlFromDirectPath(directPath)
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
            push(bytes.slice(start, end))
            bytesFetched += bytes.length
        } else {
            push(bytes)
        }
    }
    const output = new Transform({
        transform(chunk, _, callback) {
            let data = Buffer.concat([remainingBytes, chunk])
            const decryptLength = toSmallestChunkSize(data.length)
            remainingBytes = data.slice(decryptLength)
            data = data.slice(0, decryptLength)
            if (!aes) {
                let ivValue = iv
                if (firstBlockIsIV) { ivValue = data.slice(0, AES_CHUNK_SIZE); data = data.slice(AES_CHUNK_SIZE) }
                aes = Crypto.createDecipheriv('aes-256-cbc', cipherKey, ivValue)
                if (endByte) aes.setAutoPadding(false)
            }
            try { pushBytes(aes.update(data), b => this.push(b)); callback() } catch (error) { callback(error) }
        },
        final(callback) {
            try { pushBytes(aes.final(), b => this.push(b)); callback() } catch (error) { callback(error) }
        }
    })
    return fetched.pipe(output, { end: true })
}

// ─── UPLOAD ───────────────────────────────────────────────────────────────────
export function extensionForMediaMessage(message) {
    const getExtension = (mimetype) => mimetype.split(';')[0]?.split('/')[1]
    const type = Object.keys(message)[0]
    if (type === 'locationMessage' || type === 'liveLocationMessage' || type === 'productMessage') return '.jpeg'
    return getExtension(message[type].mimetype)
}

export const getWAUploadToServer = ({ customUploadHosts, fetchAgent, logger, options }, refreshMediaConn) => {
    return async (stream, { mediaType, fileEncSha256B64, newsletter, timeoutMs }) => {
        const toUploadBody = async (input) => {
            if (!input) throw new Boom('Upload input is null or undefined', { statusCode: 400 })
            if (Buffer.isBuffer(input)) return input
            if (typeof input === 'string') {
                const stream = createReadStream(input)
                stream.on('end', () => stream.destroy())
                stream.on('error', () => stream.destroy())
                return stream
            }
            if (typeof ReadableStream !== 'undefined' && input instanceof ReadableStream) return Readable.fromWeb(input)
            if (typeof input.pipe === 'function' || typeof input[Symbol.asyncIterator] === 'function') return input
            throw new Boom(`Unsupported upload input type: ${Object.prototype.toString.call(input)}`, { statusCode: 400 })
        }
        let reqBody
        try { reqBody = await toUploadBody(stream) }
        catch (err) { logger?.error({ err: err.message }, 'failed to prepare upload body'); throw err }
        fileEncSha256B64 = encodeBase64EncodedStringForUpload(fileEncSha256B64)
        let media = MEDIA_PATH_MAP[mediaType]
        if (newsletter) media = media?.replace('/mms/', '/newsletter/newsletter-')
        if (!media) throw new Boom(`No media path found for type: ${mediaType}`, { statusCode: 400 })
        let uploadInfo = await refreshMediaConn(false)
        const hosts = [...(customUploadHosts ?? []), ...(uploadInfo.hosts ?? [])]
        if (!hosts.length) throw new Boom('No upload hosts available', { statusCode: 503 })
        const MAX_RETRIES = 2
        let urls, lastError
        for (const { hostname, maxContentLengthBytes } of hosts) {
            for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
                try {
                    if (attempt > 1) { uploadInfo = await refreshMediaConn(true); reqBody = await toUploadBody(stream) }
                    if (maxContentLengthBytes && Buffer.isBuffer(reqBody) && reqBody.length > maxContentLengthBytes) {
                        logger?.warn({ hostname, maxContentLengthBytes }, 'body too large for host, skipping')
                        break
                    }
                    const auth = encodeURIComponent(uploadInfo.auth)
                    const url = `https://${hostname}${media}/${fileEncSha256B64}?auth=${auth}&token=${fileEncSha256B64}`
                    const controller = new AbortController()
                    const timer = timeoutMs ? setTimeout(() => controller.abort(), timeoutMs) : null
                    let response
                    try {
                        response = await fetch(url, {
                            dispatcher: fetchAgent,
                            method: 'POST',
                            body: reqBody,
                            headers: {
                                ...(Array.isArray(options?.headers) ? Object.fromEntries(options.headers) : (options?.headers ?? {})),
                                'Content-Type': 'application/octet-stream',
                                Origin: DEFAULT_ORIGIN
                            },
                            duplex: 'half',
                            signal: controller.signal
                        })
                    } finally {
                        if (timer) clearTimeout(timer)
                    }
                    let result
                    try { result = await response.json() } catch { result = null }
                    if (result?.url || result?.directPath) {
                        urls = { mediaUrl: result.url, directPath: result.direct_path, handle: result.handle }
                        break
                    }
                    lastError = new Error(`${hostname} rejected upload (HTTP ${response.status}): ${JSON.stringify(result)}`)
                    logger?.warn({ hostname, attempt, status: response.status, result }, 'upload rejected')
                } catch (err) {
                    lastError = err
                    logger?.warn({ hostname, attempt, err: err.message, timedOut: err.name === 'AbortError' }, 'upload attempt failed')
                    if (attempt < MAX_RETRIES) await new Promise(r => setTimeout(r, 500 * attempt))
                }
            }
            if (urls) break
        }
        if (!urls) {
            const msg = `Media upload failed on all hosts. Last error: ${lastError?.message ?? 'unknown'}`
            logger?.error({ hosts: hosts.map(h => h.hostname), lastError: lastError?.message }, msg)
            throw new Boom(msg, { statusCode: 500, data: { lastError: lastError?.message } })
        }
        return urls
    }
}

// ─── MEDIA RETRY ──────────────────────────────────────────────────────────────
const getMediaRetryKey = (mediaKey) => hkdf(mediaKey, 32, { info: 'WhatsApp Media Retry Notification' })

export const encryptMediaRetryRequest = async (key, mediaKey, meId) => {
    const recpBuffer = proto.ServerErrorReceipt.encode({ stanzaId: key.id }).finish()
    const iv = Crypto.randomBytes(12)
    const retryKey = await getMediaRetryKey(mediaKey)
    const ciphertext = aesEncryptGCM(recpBuffer, retryKey, iv, Buffer.from(key.id))
    return {
        tag: 'receipt',
        attrs: { id: key.id, to: jidNormalizedUser(meId), type: 'server-error' },
        content: [
            { tag: 'encrypt', attrs: {}, content: [{ tag: 'enc_p', attrs: {}, content: ciphertext }, { tag: 'enc_iv', attrs: {}, content: iv }] },
            { tag: 'rmr', attrs: { jid: key.remoteJid, from_me: (!!key.fromMe).toString(), participant: key.participant } }
        ]
    }
}

export const decodeMediaRetryNode = (node) => {
    const rmrNode = getBinaryNodeChild(node, 'rmr')
    const event = { key: { id: node.attrs.id, remoteJid: rmrNode.attrs.jid, fromMe: rmrNode.attrs.from_me === 'true', participant: rmrNode.attrs.participant } }
    const errorNode = getBinaryNodeChild(node, 'error')
    if (errorNode) {
        event.error = new Boom(`Failed to re-upload media (${+errorNode.attrs.code})`, { data: errorNode.attrs, statusCode: getStatusCodeForMediaRetry(+errorNode.attrs.code) })
    } else {
        const encNode = getBinaryNodeChild(node, 'encrypt')
        const ciphertext = getBinaryNodeChildBuffer(encNode, 'enc_p')
        const iv = getBinaryNodeChildBuffer(encNode, 'enc_iv')
        if (ciphertext && iv) event.media = { ciphertext, iv }
        else event.error = new Boom('Failed to re-upload media (missing ciphertext)', { statusCode: 404 })
    }
    return event
}

export const decryptMediaRetryData = async ({ ciphertext, iv }, mediaKey, msgId) => {
    const plaintext = aesDecryptGCM(ciphertext, await getMediaRetryKey(mediaKey), iv, Buffer.from(msgId))
    return proto.MediaRetryNotification.decode(plaintext)
}

export const getStatusCodeForMediaRetry = (code) => MEDIA_RETRY_STATUS_MAP[code]

const MEDIA_RETRY_STATUS_MAP = {
    [proto.MediaRetryNotification.ResultType.SUCCESS]: 200,
    [proto.MediaRetryNotification.ResultType.DECRYPTION_ERROR]: 412,
    [proto.MediaRetryNotification.ResultType.NOT_FOUND]: 404,
    [proto.MediaRetryNotification.ResultType.GENERAL_ERROR]: 418
}