import { Boom } from '@hapi/boom'
import { Sticker, StickerTypes } from 'wa-sticker-formatter'
import sharp from 'sharp'
import { fileTypeFromBuffer } from 'file-type'
import ffmpegStatic from 'ffmpeg-static'
import { randomBytes } from 'crypto'
import { promises as fs, readFileSync, mkdtempSync, writeFileSync, rmSync } from 'fs'
import { gunzipSync } from 'zlib'
import path from 'path'
import { tmpdir } from './messages-media.js'
import { execFile } from 'child_process'
import { zip } from 'fflate'
import { createRequire } from 'module'
import { proto } from '../../WAProto/index.js'
import { CALL_AUDIO_PREFIX, CALL_VIDEO_PREFIX, MEDIA_KEYS, URL_REGEX, WA_DEFAULT_EPHEMERAL } from '../Defaults/index.js'
import { WAMessageStatus, WAProto } from '../Types/index.js'
import { isJidGroup, isJidNewsletter, isJidStatusBroadcast, jidNormalizedUser } from '../WABinary/index.js'
import { sha256 } from './crypto.js'
import { generateMessageIDV2, getKeyAuthor, unixTimestampSeconds } from './generics.js'
import { downloadContentFromMessage, encryptedStream, prepareStream, generateThumbnail, getAudioDuration, getAudioWaveform, getStream, toBuffer } from './messages-media.js'
import { shouldIncludeReportingToken } from './reporting-utils.js'

const require = createRequire(import.meta.url)
if (ffmpegStatic) process.env.FFMPEG_PATH = ffmpegStatic

// ─── CONSTANTS ────────────────────────────────────────────────────────────────

// Default mimetypes — these are WA protocol constants, not proto schema, so a small map is correct
const MIMETYPE_DEFAULTS = { image: 'image/jpeg', video: 'video/mp4', document: 'application/pdf', audio: 'audio/ogg; codecs=opus', sticker: 'image/webp', 'product-catalog-image': 'image/jpeg' }

// High-level user-facing send keys that are NOT proto field names — used only to detect pass-through
const HIGH_LEVEL_KEYS = new Set(['text', 'image', 'video', 'audio', 'document', 'sticker', 'contacts', 'location', 'react', 'delete', 'forward', 'disappearingMessagesInChat', 'groupInvite', 'stickerPack', 'pin', 'buttonReply', 'ptv', 'product', 'listReply', 'event', 'poll', 'inviteAdmin', 'requestPayment', 'sharePhoneNumber', 'requestPhoneNumber', 'limitSharing', 'viewOnce', 'mentions', 'edit', 'buttons', 'templateButtons', 'sections', 'interactiveButtons', 'album', 'call', 'paymentInvite', 'order', 'keep', 'shop', 'payment', 'collection'])

// Wrapper field names for normalizeMessageContent — derived from what WA wraps messages in
const WRAPPER_KEYS = ['ephemeralMessage', 'viewOnceMessage', 'documentWithCaptionMessage', 'viewOnceMessageV2', 'viewOnceMessageV2Extension', 'editedMessage', 'groupMentionedMessage', 'botInvokeMessage', 'lottieStickerMessage', 'eventCoverImage', 'statusMentionMessage', 'pollCreationOptionImageMessage', 'associatedChildMessage', 'groupStatusMentionMessage', 'pollCreationMessageV4', 'pollCreationMessageV5', 'statusAddYours', 'groupStatusMessage', 'limitSharingMessage', 'botTaskMessage', 'questionMessage', 'botForwardedMessage']

const REUPLOAD_REQUIRED_STATUS = [410, 404]
const STICKER_MAX_BYTES = 1_000_000
const CIRCLE_GEQ = `clip(256-hypot(X-W/2\\,Y-H/2)\\,0\\,1)*255`
const ROUNDED_GEQ = `st(0\\,abs(X-W/2)-W/2+50);st(1\\,abs(Y-H/2)-H/2+50);st(2\\,hypot(max(ld(0)\\,0)\\,max(ld(1)\\,0))+min(max(ld(0)\\,ld(1))\\,0)-50);clip(-ld(2)\\,0\\,1)*255`
const BASE_CROP_VF = 'scale=512:512:force_original_aspect_ratio=increase,crop=512:512:(iw-512)/2:(ih-512)/2,fps=8'
const BASE_FULL_VF = 'scale=512:512,fps=8'
const WEBP_ANIM_CODEC = ['-vcodec', 'libwebp_anim', '-lossless', '0', '-compression_level', '4', '-q:v', '35', '-loop', '0', '-preset', 'default']
const WEBP_STATIC_CODEC = (q) => ['-vcodec', 'libwebp', '-lossless', '0', '-compression_level', '6', '-q:v', String(q), '-loop', '0', '-preset', 'picture']

// ─── STICKER ──────────────────────────────────────────────────────────────────

const ffmpegRun = (args) => new Promise((resolve, reject) => execFile(ffmpegStatic, args, { timeout: 120_000 }, (err) => err ? reject(err) : resolve()))

const buildArgs = async (stickerType, inPath, outPath, extraIn = [], codecArgs = []) => {
    const isShape = stickerType === StickerTypes.CIRCLE || stickerType === StickerTypes.ROUNDED
    if (isShape) {
        const geq = stickerType === StickerTypes.CIRCLE ? CIRCLE_GEQ : ROUNDED_GEQ
        return ['-y', '-threads', '0', ...extraIn, '-i', inPath, '-filter_complex', `[0:v]${BASE_CROP_VF},format=rgba,geq=r='r(X\\,Y)':g='g(X\\,Y)':b='b(X\\,Y)':a='${geq}'[out]`, '-map', '[out]', ...codecArgs, '-an', outPath]
    }
    const vf = stickerType === StickerTypes.DEFAULT ? null : stickerType === StickerTypes.FULL ? BASE_FULL_VF : BASE_CROP_VF
    return ['-y', '-threads', '0', ...extraIn, '-i', inPath, ...(vf ? ['-vf', vf] : []), ...codecArgs, '-an', outPath]
}

const compressWebp = async (buf, { animated, quality = 80, stickerType = StickerTypes.ROUNDED, packName, authorName } = {}) => {
    const detected = await fileTypeFromBuffer(buf)
    const cuid = generateMessageIDV2()
    const videoExts = new Set(['mp4', 'webm', 'mkv', 'avi', 'mov', 'flv', 'gif'])
    if (detected && videoExts.has(detected.ext)) {
        const tmpIn = path.join(tmpdir(), `stk_in_${cuid}.${detected.ext}`)
        const tmpOut = path.join(tmpdir(), `stk_out_${cuid}.webp`)
        try {
            writeFileSync(tmpIn, buf)
            await ffmpegRun(await buildArgs(stickerType, tmpIn, tmpOut, ['-t', '10'], WEBP_ANIM_CODEC))
            const out = readFileSync(tmpOut)
            return { buffer: packName ? await tagExif(await shrinkToLimit(out, { animated: true }), packName, authorName) : out, isAnimated: true }
        } finally { fs.unlink(tmpIn).catch(() => { }); fs.unlink(tmpOut).catch(() => { }) }
    }
    if (detected?.mime === 'image/webp') {
        const meta = await sharp(buf, { animated: true }).metadata()
        const isAnim = animated ?? ((meta.pages || 1) > 1)
        const tmpOut = path.join(tmpdir(), `stk_out_${cuid}.webp`)
        if (isAnim) {
            try {
                await sharp(buf, { animated: true }).webp({ quality, effort: 1, loop: 0 }).toFile(tmpOut)
                const out = readFileSync(tmpOut)
                return { buffer: packName ? await tagExif(await shrinkToLimit(out, { animated: true }), packName, authorName) : out, isAnimated: true }
            } finally { fs.unlink(tmpOut).catch(() => { }) }
        }
        const tmpIn = path.join(tmpdir(), `stk_in_${cuid}.webp`)
        try {
            writeFileSync(tmpIn, buf)
            await ffmpegRun(await buildArgs(stickerType, tmpIn, tmpOut, [], WEBP_STATIC_CODEC(quality)))
            const out = readFileSync(tmpOut)
            return { buffer: packName ? await tagExif(await shrinkToLimit(out, { animated: false }), packName, authorName) : out, isAnimated: false }
        } finally { fs.unlink(tmpIn).catch(() => { }); fs.unlink(tmpOut).catch(() => { }) }
    }
    const converted = await new Sticker(buf, { pack: packName, author: authorName, type: stickerType, quality }).toBuffer()
    return { buffer: converted.length <= STICKER_MAX_BYTES ? converted : await shrinkToLimit(converted, { animated: false }), isAnimated: false }
}

const shrinkToLimit = async (buf, { animated } = {}) => {
    if (buf.length <= STICKER_MAX_BYTES) return buf
    const ratio = STICKER_MAX_BYTES / buf.length
    const q = Math.max(10, Math.min(60, Math.floor(ratio * 80 * 0.85)))
    const out = (await compressWebp(buf, { animated, quality: q })).buffer
    if (out.length <= STICKER_MAX_BYTES) return out
    const q2 = Math.max(10, Math.floor(q * (STICKER_MAX_BYTES / out.length) * 0.85))
    const out2 = (await compressWebp(buf, { animated, quality: q2 })).buffer
    return out.length < out2.length ? out : out2
}

const tagExif = async (buf, packName, authorName) => new require('wa-sticker-formatter').Exif({ pack: packName, author: authorName }).add(buf)

let _rlottieApi = null
const getRlottieApi = async () => {
    if (_rlottieApi) return _rlottieApi
    const { init } = await import('rlottie')
    const wasmBuf = readFileSync(require.resolve('rlottie/wasm'))
    _rlottieApi = await init('data:application/wasm;base64,' + wasmBuf.toString('base64'))
    return _rlottieApi
}

const tgsToWebp = async (tgsBuffer, { quality = 80, fps = 30 } = {}) => {
    const lottieJson = JSON.parse(gunzipSync(tgsBuffer).toString())
    const api = await getRlottieApi()
    const W = 512, H = 512, handle = api.lottie_init()
    const jsonBuf = Buffer.from(JSON.stringify(lottieJson) + '\0')
    const ptr = api._malloc(jsonBuf.length)
    api.HEAPU8.set(jsonBuf, ptr)
    const totalFrames = api.lottie_load_from_data(handle, ptr)
    api.lottie_resize(handle, W, H)
    const bufPtr = api.lottie_buffer(handle)
    const tgsTmpDir = mkdtempSync(path.join(tmpdir(), 'tgs_'))
    try {
        for (let i = 0; i < totalFrames; i++) {
            api.lottie_render(handle, i)
            const rgba = Buffer.from(api.HEAPU8.buffer, bufPtr, W * H * 4)
            await sharp(Buffer.from(rgba), { raw: { width: W, height: H, channels: 4 } }).png().toFile(path.join(tgsTmpDir, `f${String(i).padStart(4, '0')}.png`))
        }
        api.lottie_destroy(handle)
        const outPath = path.join(tgsTmpDir, 'out.webp')
        await ffmpegRun(['-y', '-framerate', String(fps), '-i', path.join(tgsTmpDir, 'f%04d.png'), '-vcodec', 'libwebp', '-vf', `scale=${W}:${H}`, '-lossless', '0', '-compression_level', '6', '-q:v', String(quality), '-loop', '0', '-preset', 'default', '-an', '-vsync', '0', outPath])
        return readFileSync(outPath)
    } finally { rmSync(tgsTmpDir, { recursive: true, force: true }) }
}

// ─── EXPORTS: URL / LINK PREVIEW ─────────────────────────────────────────────

export const extractUrlFromText = (text) => text.match(URL_REGEX)?.[0]

export const generateLinkPreviewIfRequired = async (text, getUrlInfo, logger) => {
    const url = extractUrlFromText(text)
    if (!getUrlInfo || !url) return
    try { return await getUrlInfo(url) } catch (e) { logger?.warn({ trace: e.stack }, 'url generation failed') }
}

// ─── EXPORTS: MESSAGE HELPERS ─────────────────────────────────────────────────

export const getContentType = (content) => {
    if (!content) return
    return Object.keys(content).find(k => (k === 'conversation' || k.includes('Message')) && k !== 'senderKeyDistributionMessage')
}

export const normalizeMessageContent = (content) => {
    if (!content) return
    for (let i = 0; i < 5; i++) {
        const inner = WRAPPER_KEYS.reduce((found, k) => found || content?.[k], null)
        if (!inner) break
        content = inner.message
    }
    return content
}

export const extractMessageContent = (content) => {
    content = normalizeMessageContent(content)
    for (const t of ['image', 'video', 'audio', 'document']) { if (content?.[`${t}Message`]?.viewOnce) return { [`${t}Message`]: content[`${t}Message`] } }
    const fromButtons = (msg) => {
        for (const t of ['image', 'document', 'video', 'location', 'product']) { if (msg[`${t}Message`]) return { [`${t}Message`]: msg[`${t}Message`] } }
        return { conversation: msg.contentText || msg.hydratedContentText || msg.body?.text || '' }
    }
    if (content?.buttonsMessage) return fromButtons(content.buttonsMessage)
    if (content?.interactiveMessage) return fromButtons(content.interactiveMessage)
    for (const v of ['interactiveMessageTemplate', 'hydratedFourRowTemplate', 'hydratedTemplate', 'fourRowTemplate']) {
        if (content?.templateMessage?.[v]) return fromButtons(content.templateMessage[v])
    }
    return content
}

export const generateForwardMessageContent = (message, forceForward) => {
    let content = normalizeMessageContent(message.message)
    if (!content) throw new Boom('no content in message', { statusCode: 400 })
    content = proto.Message.decode(proto.Message.encode(content).finish())
    let key = Object.keys(content)[0]
    const score = (content?.[key]?.contextInfo?.forwardingScore || 0) + (message.key.fromMe && !forceForward ? 0 : 1)
    if (key === 'conversation') { content.extendedTextMessage = { text: content[key] }; delete content.conversation; key = 'extendedTextMessage' }
    content[key].contextInfo = score > 0 ? { forwardingScore: score, isForwarded: true } : {}
    return content
}

export const prepareDisappearingMessageSettingContent = (ephemeralExpiration) => WAProto.Message.fromObject({
    ephemeralMessage: { message: { protocolMessage: { type: WAProto.Message.ProtocolMessage.Type.EPHEMERAL_SETTING, ephemeralExpiration: ephemeralExpiration || 0 } } }
})

// ─── EXPORTS: MEDIA ───────────────────────────────────────────────────────────

export const prepareWAMessageMedia = async (message, options) => {
    const mediaType = MEDIA_KEYS.find(k => k in message)
    if (!mediaType) throw new Boom('Invalid media type', { statusCode: 400 })
    const protoKey = `${mediaType}Message`
    const uploadData = { ...message, media: message[mediaType] }
    delete uploadData[mediaType]
    if (mediaType === 'document' && !uploadData.fileName) uploadData.fileName = 'file'
    if (!uploadData.mimetype) uploadData.mimetype = MIMETYPE_DEFAULTS[mediaType] || 'application/octet-stream'

    if (mediaType === 'sticker') {
        try {
            const rawBuf = await toBuffer((await getStream(uploadData.media)).stream)
            const packName = message.pack || message.packName || options?.pack || options?.packName || 'NexusStickers'
            const authorName = message.author || message.publisher || message.packPublisher || options?.author || options?.publisher || options?.packPublisher || 'NexusTechPro'
            const { buffer } = await compressWebp(rawBuf, { packName, authorName, stickerType: message.stickerType || options?.stickerType || StickerTypes.ROUNDED, quality: message.quality || options?.quality || 80 })
            uploadData.media = buffer
            uploadData.stickerSentTs = Date.now()
        } catch (e) { options.logger?.warn({ err: e }, 'sticker formatting failed, sending raw') }
    }

    const cacheableKey = typeof uploadData.media === 'object' && 'url' in uploadData.media && uploadData.media.url && options.mediaCache
        ? `${mediaType}:${uploadData.media.url.toString()}` : null
    if (cacheableKey) {
        const cached = await options.mediaCache?.get(cacheableKey)
        if (cached) {
            const obj = WAProto.Message.decode(cached)
            Object.assign(obj[protoKey], { ...uploadData, media: undefined })
            return obj
        }
    }

    const isNewsletter = !!options.jid && isJidNewsletter(options.jid)
    const requiresDuration = mediaType === 'audio' && typeof uploadData.seconds === 'undefined'
    const requiresThumbnail = (mediaType === 'image' || mediaType === 'video') && typeof uploadData.jpegThumbnail === 'undefined'
    const requiresWaveform = mediaType === 'audio' && (uploadData.ptt === true || !!options.backgroundColor)

    const enc = await (isNewsletter ? prepareStream : encryptedStream)(uploadData.media, options.mediaTypeOverride || mediaType, {
        logger: options.logger, saveOriginalFileIfRequired: requiresDuration || requiresThumbnail || requiresWaveform,
        opts: options.options, isPtt: uploadData.ptt, forceOpus: mediaType === 'audio' && uploadData.mimetype?.includes('opus'), convertVideo: mediaType === 'video',
    })
    const { mediaKey, encWriteStream, bodyPath, fileEncSha256, fileSha256, fileLength, opusConverted, encFilePath, encBuffer, cleanup } = enc
    if (mediaType === 'audio' && opusConverted) uploadData.mimetype = 'audio/ogg; codecs=opus'
    const fileEncSha256B64 = (isNewsletter ? fileSha256 : (fileEncSha256 ?? fileSha256)).toString('base64')

    const [{ mediaUrl, directPath, handle }] = await Promise.all([
        options.upload(encFilePath || encBuffer || encWriteStream, { fileEncSha256B64, mediaType, timeoutMs: options.mediaUploadTimeoutMs }),
        (async () => {
            try {
                if (requiresThumbnail) {
                    const { thumbnail, originalImageDimensions } = await generateThumbnail(bodyPath, mediaType, options)
                    uploadData.jpegThumbnail = thumbnail
                    if (!uploadData.width && originalImageDimensions) { uploadData.width = originalImageDimensions.width; uploadData.height = originalImageDimensions.height }
                }
                if (requiresDuration) uploadData.seconds = await getAudioDuration(bodyPath)
                if (requiresWaveform) {
                    try { uploadData.waveform = await getAudioWaveform(bodyPath, options.logger) } catch {
                        uploadData.waveform = new Uint8Array([0, 99, 0, 99, 0, 99, 0, 99, 88, 99, 0, 99, 0, 55, 0, 99, 0, 99, 0, 99, 0, 99, 0, 99, 88, 99, 0, 99, 0, 55, 0, 99])
                    }
                }
                if (options.backgroundColor && mediaType === 'audio') uploadData.backgroundArgb = assertColor(options.backgroundColor)
            } catch (e) { options.logger?.warn({ trace: e.stack }, 'failed to obtain extra info') }
        })()
    ]).finally(async () => {
        if (encWriteStream && !Buffer.isBuffer(encWriteStream)) encWriteStream.destroy?.()
        if (cleanup) await cleanup()
    })

    // Resolve proto constructor dynamically from proto.Message — no hardcoded map
    const CtorName = mediaType.charAt(0).toUpperCase() + mediaType.slice(1) + 'Message'
    const Ctor = WAProto.Message[CtorName] || { fromObject: o => o }
    const obj = WAProto.Message.fromObject({
        [protoKey]: Ctor.fromObject({ url: handle ? undefined : mediaUrl, directPath, mediaKey, fileEncSha256, fileSha256, fileLength, mediaKeyTimestamp: handle ? undefined : unixTimestampSeconds(), ...uploadData, media: undefined })
    })
    if (uploadData.ptv) { obj.ptvMessage = obj.videoMessage; delete obj.videoMessage }
    if (cacheableKey) await options.mediaCache?.set(cacheableKey, WAProto.Message.encode(obj).finish())
    return obj
}

const assertColor = (color) => {
    if (typeof color === 'number') return color > 0 ? color : 0xffffffff + Number(color) + 1
    const hex = color.trim().replace('#', '')
    return parseInt(hex.length <= 6 ? 'FF' + hex.padStart(6, '0') : hex, 16)
}

// ─── EXPORTS: STICKER PACK ────────────────────────────────────────────────────

export const prepareStickerPackMessage = async (stickerPack, options) => {
    if (Array.isArray(stickerPack)) stickerPack = { stickers: stickerPack }
    else if (stickerPack && typeof stickerPack === 'object' && !stickerPack.stickers) {
        const keys = Object.keys(stickerPack)
        if (keys.length && keys.every(k => !isNaN(k))) stickerPack = { stickers: Object.values(stickerPack) }
    }
    const { stickers, cover, name, publisher, packId, packName: packNameAlias, packPublisher, author } = stickerPack
    if (!stickers?.length) throw new Boom('Sticker pack must contain at least one sticker', { statusCode: 400 })
    const stickerPackIdValue = packId || generateMessageIDV2()
    const packName = name || packNameAlias || options?.packName || options?.name || 'NexusStickers'
    const authorName = publisher || packPublisher || author || options?.packPublisher || options?.publisher || options?.author || 'NexusTechPro'
    const MAX_STICKERS_PER_PACK = 60, skippedStickers = []
    const runWithLimit = (() => {
        const limit = 6, queue = []
        let running = 0
        return (fn) => new Promise((resolve, reject) => {
            const run = () => { running++; fn().then(resolve, reject).finally(() => { running--; queue.shift()?.() }) }
            running < limit ? run() : queue.push(run)
        })
    })()

    const processSticker = async (s, i) => {
        const uid = generateMessageIDV2()
        const tmpOut = path.join(tmpdir(), `stk_out_${i}_${uid}.webp`)
        try {
            const raw = s.data || s.sticker || s.buffer || s.image || s.webp || s.file || s.path || s.url
            if (!raw) { skippedStickers.push({ index: i, reason: 'No sticker data found' }); return null }
            const buf = Buffer.isBuffer(raw) ? raw : await toBuffer((await getStream(raw)).stream)
            if (!buf?.length) { skippedStickers.push({ index: i, reason: 'Empty buffer' }); return null }
            const emojis = Array.isArray(s.emojis) ? s.emojis : Object.values(s.emojis || {})
            let finalBuf
            if (s.isLottie) {
                finalBuf = await tagExif(await shrinkToLimit(await tgsToWebp(buf, { quality: 80, fps: 30 }), { animated: true }), packName, authorName)
            } else if (s.isAnimated) {
                const tmpIn = path.join(tmpdir(), `stk_in_${i}_${uid}.webp`), tmpRaw = path.join(tmpdir(), `stk_raw_${i}_${uid}.webp`)
                writeFileSync(tmpIn, buf)
                try {
                    await ffmpegRun(await buildArgs(s.type || StickerTypes.ROUNDED, tmpIn, tmpRaw, ['-vcodec', 'vp9', '-t', '10'], WEBP_ANIM_CODEC))
                    finalBuf = await tagExif(await shrinkToLimit(readFileSync(tmpRaw), { animated: true }), packName, authorName)
                } finally { fs.unlink(tmpIn).catch(() => { }); fs.unlink(tmpRaw).catch(() => { }) }
            } else {
                finalBuf = await shrinkToLimit(await new Sticker(buf, { pack: packName, author: authorName, type: s.type || StickerTypes.ROUNDED, quality: 80 }).toBuffer(), { animated: false })
            }
            const hash = sha256(finalBuf).toString('base64').replace(/\//g, '-').replace(/=/g, '')
            const fileSize = finalBuf.length
            writeFileSync(tmpOut, finalBuf); finalBuf = null
            return { fileName: `${hash}.webp`, filePath: tmpOut, fileSize, mimetype: 'image/webp', isAnimated: s.isAnimated || false, isLottie: s.isLottie || false, emojis, accessibilityLabel: s.accessibilityLabel || '' }
        } catch (e) {
            options.logger?.warn({ err: e }, `failed processing sticker at index ${i}`)
            skippedStickers.push({ index: i, reason: e.message }); fs.unlink(tmpOut).catch(() => { }); return null
        }
    }

    const processBatch = async (batch, batchIdx, totalBatches, coverFilePath) => {
        const batchData = {}
        for (const s of batch) batchData[s.fileName] = [new Uint8Array(readFileSync(s.filePath)), { level: 0 }]
        const trayFile = totalBatches > 1 ? `${stickerPackIdValue}_batch${batchIdx}.webp` : `${stickerPackIdValue}.webp`
        batchData[trayFile] = [new Uint8Array(readFileSync(coverFilePath)), { level: 0 }]
        const zipBuf = await new Promise((resolve, reject) => zip(batchData, (err, data) => err ? reject(err) : resolve(Buffer.from(data))))
        const upload = await encryptedStream(zipBuf, 'sticker-pack', { logger: options.logger, opts: options.options })
        const uploadRes = await options.upload(upload.encFilePath || upload.encBuffer, { fileEncSha256B64: upload.fileEncSha256.toString('base64'), mediaType: 'sticker-pack', timeoutMs: options.mediaUploadTimeoutMs })
        if (upload.encFilePath) fs.unlink(upload.encFilePath).catch(() => { })
        let thumbRes = null
        try {
            const thumbTmpPath = path.join(tmpdir(), `stk_thumb_${generateMessageIDV2()}.jpg`)
            await sharp(coverFilePath).resize(252, 252).jpeg().toFile(thumbTmpPath)
            const thumbBuf = readFileSync(thumbTmpPath); fs.unlink(thumbTmpPath).catch(() => { })
            const thumbUpload = await encryptedStream(thumbBuf, 'thumbnail-sticker-pack', { logger: options.logger, opts: options.options, mediaKey: upload.mediaKey })
            thumbRes = await options.upload(thumbUpload.encFilePath || thumbUpload.encBuffer, { fileEncSha256B64: thumbUpload.fileEncSha256.toString('base64'), mediaType: 'thumbnail-sticker-pack', timeoutMs: options.mediaUploadTimeoutMs })
            if (thumbUpload.encFilePath) fs.unlink(thumbUpload.encFilePath).catch(() => { })
            thumbRes._enc = thumbUpload; thumbRes._thumbBuf = thumbBuf
        } catch (e) { options.logger?.warn({ err: e }, 'failed generating sticker pack thumbnail') }
        return {
            name: totalBatches > 1 ? `${packName} (${batchIdx + 1}/${totalBatches})` : packName, publisher: authorName,
            stickerPackId: totalBatches > 1 ? `${stickerPackIdValue}_${batchIdx}` : stickerPackIdValue,
            stickerPackOrigin: proto.Message.StickerPackMessage.StickerPackOrigin.USER_CREATED, stickerPackSize: zipBuf.length,
            stickers: batch.map(s => ({ fileName: s.fileName, mimetype: s.mimetype, isAnimated: s.isAnimated, isLottie: s.isLottie, emojis: s.emojis, accessibilityLabel: s.accessibilityLabel })),
            fileSha256: upload.fileSha256, fileEncSha256: upload.fileEncSha256, mediaKey: upload.mediaKey,
            directPath: uploadRes.directPath, fileLength: upload.fileLength, mediaKeyTimestamp: unixTimestampSeconds(), trayIconFileName: trayFile,
            ...(thumbRes && { thumbnailDirectPath: thumbRes.directPath, thumbnailHeight: 252, thumbnailWidth: 252, thumbnailSha256: thumbRes._enc?.fileSha256, thumbnailEncSha256: thumbRes._enc?.fileEncSha256, imageDataHash: thumbRes._thumbBuf ? sha256(thumbRes._thumbBuf).toString('base64') : undefined }),
        }
    }

    const coverTmpPath = path.join(tmpdir(), `stk_cover_${generateMessageIDV2()}.webp`)
    let coverFilePath
    try {
        if (cover) {
            const coverBuf = Buffer.isBuffer(cover) ? cover : await toBuffer((await getStream(cover)).stream)
            const isWebp = coverBuf[0] === 0x52 && coverBuf[1] === 0x49 && coverBuf[8] === 0x57 && coverBuf[9] === 0x45
            writeFileSync(coverTmpPath, isWebp ? coverBuf : await new Sticker(coverBuf, { pack: packName, author: authorName, type: StickerTypes.ROUNDED, quality: 95 }).toBuffer())
            coverFilePath = coverTmpPath
        }
        const allProcessed = (await Promise.all(stickers.map((s, j) => runWithLimit(() => processSticker(s, j))))).filter(Boolean)
        if (!coverFilePath && allProcessed.length) coverFilePath = allProcessed[0].filePath
        const sizeBatches = []
        let curBatch = []
        for (const s of allProcessed) { if (curBatch.length >= MAX_STICKERS_PER_PACK) { sizeBatches.push(curBatch); curBatch = [] }; curBatch.push(s) }
        if (curBatch.length) sizeBatches.push(curBatch)
        const totalBatches = sizeBatches.length
        const allResults = await Promise.all(sizeBatches.map((batch, idx) => processBatch(batch, idx, totalBatches, coverFilePath).finally(() => { for (const s of batch) fs.unlink(s.filePath).catch(() => { }) })))
        if (!allResults.length) throw new Boom('No valid stickers could be processed', { statusCode: 400 })
        return allResults.length > 1 ? { stickerPackMessage: allResults, isBatched: true, batchCount: allResults.length } : { stickerPackMessage: allResults[0], isBatched: false }
    } finally { fs.unlink(coverTmpPath).catch(() => { }) }
}

// ─── MESSAGE CONTENT GENERATION ───────────────────────────────────────────────

const applyContextInfoAndMentions = (interactive, msg) => {
    if (msg.contextInfo) interactive.contextInfo = { ...(interactive.contextInfo || {}), ...msg.contextInfo }
    if (msg.mentions?.length) interactive.contextInfo = { ...(interactive.contextInfo || {}), mentionedJid: msg.mentions }
}

const applyExtraInteractiveFields = (interactive, msg) => {
    const protoFields = new Set(Object.keys(WAProto.Message.InteractiveMessage.prototype))
    for (const [k, v] of Object.entries(msg)) {
        if (protoFields.has(k) && !(k in interactive) && v !== undefined && v !== null) {
            interactive[k] = v
        }
    }
}

// Handler dispatch: each key maps to an async fn(message, options) -> raw proto-compatible object.
// To add a new message type: add one entry here. No else-if chains, no declarations elsewhere.
// Proto enum values come directly from proto.Message.* — nothing is hardcoded.
const MESSAGE_HANDLERS = {
    text: async (msg, opts) => {
        const ext = { text: msg.text }
        let urlInfo = msg.linkPreview ?? await generateLinkPreviewIfRequired(msg.text, opts.getUrlInfo, opts.logger)
        if (urlInfo) {
            Object.assign(ext, { matchedText: urlInfo['matched-text'], jpegThumbnail: urlInfo.jpegThumbnail, description: urlInfo.description, title: urlInfo.title, previewType: urlInfo.previewType ?? 0 })
            const img = urlInfo.highQualityThumbnail
            if (img) Object.assign(ext, { thumbnailDirectPath: img.directPath, mediaKey: img.mediaKey, mediaKeyTimestamp: img.mediaKeyTimestamp, thumbnailWidth: img.width, thumbnailHeight: img.height, thumbnailSha256: img.fileSha256, thumbnailEncSha256: img.fileEncSha256 })
        }
        if (opts.backgroundColor) ext.backgroundArgb = assertColor(opts.backgroundColor)
        if (opts.font) ext.font = opts.font
        return { extendedTextMessage: ext }
    },
    contacts: async (msg) => {
        const { contacts } = msg.contacts
        if (!contacts.length) throw new Boom('require atleast 1 contact', { statusCode: 400 })
        return contacts.length === 1 ? { contactMessage: WAProto.Message.ContactMessage.create(contacts[0]) } : { contactsArrayMessage: WAProto.Message.ContactsArrayMessage.create(msg.contacts) }
    },
    location: async (msg) => ({ locationMessage: WAProto.Message.LocationMessage.create(msg.location) }),
    react: async (msg) => { if (!msg.react.senderTimestampMs) msg.react.senderTimestampMs = Date.now(); return { reactionMessage: WAProto.Message.ReactionMessage.create(msg.react) } },
    delete: async (msg) => ({ protocolMessage: { key: msg.delete, type: WAProto.Message.ProtocolMessage.Type.REVOKE } }),
    forward: async (msg) => generateForwardMessageContent(msg.forward, msg.force),
    disappearingMessagesInChat: async (msg) => prepareDisappearingMessageSettingContent(typeof msg.disappearingMessagesInChat === 'boolean' ? (msg.disappearingMessagesInChat ? WA_DEFAULT_EPHEMERAL : 0) : msg.disappearingMessagesInChat),
    groupInvite: async (msg, opts) => {
        const m = { groupInviteMessage: { inviteCode: msg.groupInvite.inviteCode, inviteExpiration: msg.groupInvite.inviteExpiration, caption: msg.groupInvite.text, groupJid: msg.groupInvite.jid, groupName: msg.groupInvite.subject } }
        if (opts.getProfilePicUrl) {
            const pfpUrl = await opts.getProfilePicUrl(msg.groupInvite.jid, 'preview')
            if (pfpUrl) { const resp = await fetch(pfpUrl, { method: 'GET', dispatcher: opts?.options?.dispatcher }); if (resp.ok) m.groupInviteMessage.jpegThumbnail = Buffer.from(await resp.arrayBuffer()) }
        }
        return m
    },
    stickerPack: async (msg, opts) => {
        const result = await prepareStickerPackMessage(msg.stickerPack, opts)
        if (result.isBatched) return { _batched: true, stickerPackMessage: result.stickerPackMessage, batchCount: result.batchCount }
        return { _finalize: true, stickerPackMessage: result.stickerPackMessage }
    },
    pin: async (msg, opts) => {
        const messageKey = typeof msg.pin === 'boolean' ? (opts.quoted?.key || (() => { throw new Boom('No quoted message key found for pin operation') })()) : typeof msg.pin === 'object' ? (msg.pin.key || (msg.pin.id ? { remoteJid: opts.jid, fromMe: msg.pin.fromMe || false, id: msg.pin.id, participant: msg.pin.participant } : null)) : msg.pin
        if (!messageKey?.id) throw new Boom('Invalid message key for pin operation')
        const shouldPin = typeof msg.pin === 'boolean' ? msg.pin : (msg.pin?.unpin !== true)
        return { pinInChatMessage: { key: messageKey, type: shouldPin ? 1 : 2, senderTimestampMs: Date.now().toString() }, messageContextInfo: { messageAddOnDurationInSecs: shouldPin ? (msg.pin?.time || msg.time || 86400) : 0 } }
    },
    keep: async (msg) => ({ keepInChatMessage: { key: msg.keep, keepType: msg.type, timestampMs: Date.now() } }),
    call: async (msg) => ({ scheduledCallCreationMessage: { scheduledTimestampMs: msg.call.time || Date.now(), callType: msg.call.type || 1, title: msg.call.title } }),
    paymentInvite: async (msg) => ({ paymentInviteMessage: { serviceType: msg.paymentInvite.type, expiryTimestamp: msg.paymentInvite.expiry } }),
    buttonReply: async (msg) => ({
        list: { listResponseMessage: { title: msg.buttonReply.title, description: msg.buttonReply.description, singleSelectReply: { selectedRowId: msg.buttonReply.rowId }, lisType: proto.Message.ListResponseMessage.ListType.SINGLE_SELECT } },
        template: { templateButtonReplyMessage: { selectedDisplayText: msg.buttonReply.displayText, selectedId: msg.buttonReply.id, selectedIndex: msg.buttonReply.index } },
        interactive: { interactiveResponseMessage: { body: { text: msg.buttonReply.displayText, format: proto.Message.InteractiveResponseMessage.Body.Format.EXTENSIONS_1 }, nativeFlowResponseMessage: { name: msg.buttonReply.nativeFlows?.name, paramsJson: msg.buttonReply.nativeFlows?.paramsJson, version: msg.buttonReply.nativeFlows?.version } } },
    }[msg.type] || { buttonsResponseMessage: { selectedButtonId: msg.buttonReply.id, selectedDisplayText: msg.buttonReply.displayText, type: proto.Message.ButtonsResponseMessage.Type.DISPLAY_TEXT } }),
    ptv: async (msg, opts) => { const { videoMessage } = await prepareWAMessageMedia({ video: msg.video }, opts); return { ptvMessage: videoMessage } },
    product: async (msg, opts) => { const { imageMessage } = await prepareWAMessageMedia({ image: msg.product.productImage }, opts); return { productMessage: WAProto.Message.ProductMessage.create({ ...msg, product: { ...msg.product, productImage: imageMessage } }) } },
    order: async (msg) => ({ orderMessage: WAProto.Message.OrderMessage.fromObject({ orderId: msg.order.id, thumbnail: msg.order.thumbnail, itemCount: msg.order.itemCount, status: msg.order.status, surface: msg.order.surface, orderTitle: msg.order.title, message: msg.order.text, sellerJid: msg.order.seller, token: msg.order.token, totalAmount1000: msg.order.amount, totalCurrencyCode: msg.order.currency }) }),
    sections: async (msg) => ({ listMessage: { title: msg.title, buttonText: msg.buttonText, footerText: msg.footer, description: msg.text, sections: msg.sections, listType: proto.Message.ListMessage.ListType.SINGLE_SELECT, contextInfo: { ...(msg.contextInfo || {}), ...(msg.mentions ? { mentionedJid: msg.mentions } : {}) } } }),
    listReply: async (msg) => ({ listResponseMessage: { ...msg.listReply } }),
    event: async (msg, opts) => {
        const startTime = Math.floor(msg.event.startDate.getTime() / 1000)
        const eventMessage = { name: msg.event.name, description: msg.event.description, startTime, isCanceled: msg.event.isCancelled ?? false, extraGuestsAllowed: msg.event.extraGuestsAllowed, isScheduleCall: msg.event.isScheduleCall ?? false, location: msg.event.location, ...(msg.event.endDate ? { endTime: msg.event.endDate.getTime() / 1000 } : {}) }
        if (msg.event.call && opts.getCallLink) eventMessage.joinLink = (msg.event.call === 'audio' ? CALL_AUDIO_PREFIX : CALL_VIDEO_PREFIX) + await opts.getCallLink(msg.event.call, { startTime })
        return { eventMessage, messageContextInfo: { messageSecret: msg.event.messageSecret || randomBytes(32) } }
    },
    poll: async (msg) => {
        msg.poll.selectableCount ||= 0; msg.poll.toAnnouncementGroup ||= false
        if (!Array.isArray(msg.poll.values)) throw new Boom('Invalid poll values', { statusCode: 400 })
        if (msg.poll.selectableCount < 0 || msg.poll.selectableCount > msg.poll.values.length) throw new Boom(`poll.selectableCount should be >= 0 and <= ${msg.poll.values.length}`, { statusCode: 400 })
        const pollMsg = { name: msg.poll.name, selectableOptionsCount: msg.poll.selectableCount, options: msg.poll.values.map(optionName => ({ optionName })) }
        const key = msg.poll.toAnnouncementGroup ? 'pollCreationMessageV2' : msg.poll.selectableCount === 1 ? 'pollCreationMessageV3' : 'pollCreationMessage'
        return { [key]: pollMsg, messageContextInfo: { messageSecret: msg.poll.messageSecret || randomBytes(32) } }
    },
    inviteAdmin: async (msg) => ({ newsletterAdminInviteMessage: { inviteExpiration: msg.inviteAdmin.inviteExpiration, caption: msg.inviteAdmin.text, newsletterJid: msg.inviteAdmin.jid, newsletterName: msg.inviteAdmin.subject, jpegThumbnail: msg.inviteAdmin.thumbnail } }),
    requestPayment: async (msg, opts) => {
        const data = msg.requestPayment || msg.payment
        const sticker = data.sticker ? await prepareWAMessageMedia({ sticker: data.sticker }, opts) : null
        const noteMessage = sticker ? { stickerMessage: { ...sticker.stickerMessage, contextInfo: data.contextInfo } } : { extendedTextMessage: { text: data.note || 'Notes', ...(data.contextInfo ? { contextInfo: data.contextInfo } : {}) } }
        const m = { requestPaymentMessage: WAProto.Message.RequestPaymentMessage.fromObject({ expiryTimestamp: data.expiryTimestamp || data.expiry || 0, amount1000: data.amount1000 || data.amount || 0, currencyCodeIso4217: data.currencyCodeIso4217 || data.currency || 'IDR', requestFrom: data.requestFrom || data.from || '0@s.whatsapp.net', noteMessage, background: data.background ?? { id: 'DEFAULT', placeholderArgb: 0xfff0f0f0 } }) }
        if ((data.currencyCodeIso4217 === 'BRL' || data.currency === 'BRL') && data.pixKey) { m.requestPaymentMessage.noteMessage.extendedTextMessage ??= { text: '' }; m.requestPaymentMessage.noteMessage.extendedTextMessage.text += `\nPix Key: ${data.pixKey}` }
        return m
    },
    album: async (msg) => ({ albumMessage: { expectedImageCount: msg.album.filter(i => 'image' in i).length, expectedVideoCount: msg.album.filter(i => 'video' in i).length } }),
    // Proto pass-throughs: one-liners using proto enum values directly
    sharePhoneNumber: async () => ({ protocolMessage: { type: proto.Message.ProtocolMessage.Type.SHARE_PHONE_NUMBER } }),
    requestPhoneNumber: async () => ({ requestPhoneNumberMessage: {} }),
    limitSharing: async (msg) => ({ protocolMessage: { type: proto.Message.ProtocolMessage.Type.LIMIT_SHARING, limitSharing: { sharingLimited: msg.limitSharing === true, trigger: 1, limitSharingSettingTimestamp: Date.now(), initiatedByMe: true } } }),
    payment: async (msg, opts) => MESSAGE_HANDLERS.requestPayment(msg, opts),
}

// Interactive overlays: keyed by the input field, each returns a complete replacement for m.
// Looked up dynamically — adding a new overlay type = one new entry, nothing else.
const OVERLAY_HANDLERS = {
    buttons: (m, msg) => {
        const hasNativeFlow = msg.buttons.some(b => b.nativeFlowInfo || b.name || b.buttonParamsJson)
        if (hasNativeFlow) {
            const interactive = { body: { text: msg.text || msg.caption || msg.contentText || '' }, footer: { text: msg.footer || msg.footerText || '' }, nativeFlowMessage: { buttons: msg.buttons.map(b => b.name && b.buttonParamsJson ? b : b.nativeFlowInfo ? { name: b.nativeFlowInfo.name, buttonParamsJson: b.nativeFlowInfo.paramsJson } : { name: 'quick_reply', buttonParamsJson: JSON.stringify({ display_text: b.buttonText?.displayText || b.displayText || '', id: b.buttonId || b.id || '' }) }) } }
            if (msg.title) interactive.header = { title: msg.title, subtitle: msg.subtitle || '', hasMediaAttachment: msg.hasMediaAttachment || false }
            if (Object.keys(m).length) { interactive.header ??= { title: msg.title || '', hasMediaAttachment: true }; Object.assign(interactive.header, m) }
            applyContextInfoAndMentions(interactive, msg)
            applyExtraInteractiveFields(interactive, msg)
            return { interactiveMessage: interactive }
        }
        const bm = { buttons: msg.buttons.map(b => ({ ...b, type: proto.Message.ButtonsMessage.Button.Type.RESPONSE })) }
        if ('text' in msg) { bm.contentText = msg.text; bm.headerType = proto.Message.ButtonsMessage.HeaderType.EMPTY }
        else {
            if ('caption' in msg) bm.contentText = msg.caption
            const type = Object.keys(m)[0]?.replace('Message', '').toUpperCase()
            bm.headerType = proto.Message.ButtonsMessage.HeaderType[type] || proto.Message.ButtonsMessage.HeaderType.EMPTY
            Object.assign(bm, m)
        }
        if (msg.title) { bm.text = msg.title; bm.headerType = proto.Message.ButtonsMessage.HeaderType.TEXT }
        if (msg.footer) bm.footerText = msg.footer
        if (msg.contextInfo) bm.contextInfo = { ...(bm.contextInfo || {}), ...msg.contextInfo }
        if (msg.mentions?.length) bm.contextInfo = { ...(bm.contextInfo || {}), mentionedJid: msg.mentions }
        return { buttonsMessage: bm }
    },
    templateButtons: (m, msg) => {
        const ht = { hydratedButtons: msg.templateButtons, ...('text' in msg ? { hydratedContentText: msg.text } : { ...('caption' in msg ? { hydratedContentText: msg.caption } : {}), ...m }) }
        if (msg.footer) ht.hydratedFooterText = msg.footer
        if (msg.contextInfo) ht.contextInfo = { ...(ht.contextInfo || {}), ...msg.contextInfo }
        if (msg.mentions?.length) ht.contextInfo = { ...(ht.contextInfo || {}), mentionedJid: msg.mentions }
        return { templateMessage: { fourRowTemplate: ht, hydratedTemplate: ht } }
    },
    interactiveButtons: (m, msg) => {
        const interactive = { nativeFlowMessage: WAProto.Message.InteractiveMessage.NativeFlowMessage.fromObject({ buttons: msg.interactiveButtons }) }
        if ('text' in msg) { interactive.body = { text: msg.text }; interactive.header = { title: msg.title || '', subtitle: msg.subtitle || '', hasMediaAttachment: false } }
        else if ('caption' in msg) { interactive.body = { text: msg.caption }; interactive.header = { title: msg.title || '', subtitle: msg.subtitle || '', hasMediaAttachment: msg.hasMediaAttachment ?? !!Object.keys(m).length }; if (Object.keys(m).length) Object.assign(interactive.header, m) }
        if (msg.footer) interactive.footer = { text: msg.footer }
        applyContextInfoAndMentions(interactive, msg)
        applyExtraInteractiveFields(interactive, msg)
        return { interactiveMessage: interactive, messageContextInfo: { messageSecret: randomBytes(32) } }
    },
    shop: (m, msg) => {
        const interactive = { shopStorefrontMessage: WAProto.Message.InteractiveMessage.ShopMessage.fromObject({ surface: msg.shop.surface || 1, id: msg.shop.id || msg.id }) }
        if ('text' in msg) interactive.body = { text: msg.text }
        else if ('caption' in msg) interactive.body = { text: msg.caption }
        if (msg.title || Object.keys(m).length) { interactive.header = { title: msg.title || '', subtitle: msg.subtitle || '', hasMediaAttachment: msg.hasMediaAttachment ?? !!Object.keys(m).length }; if (Object.keys(m).length) Object.assign(interactive.header, m) }
        if (msg.footer) interactive.footer = { text: msg.footer }
        applyContextInfoAndMentions(interactive, msg)
        applyExtraInteractiveFields(interactive, msg)
        return { interactiveMessage: interactive }
    },
    collection: (m, msg) => {
        const interactive = { collectionMessage: { bizJid: msg.collection.bizJid, id: msg.collection.id, messageVersion: msg.collection.version } }
        if ('text' in msg) { interactive.body = { text: msg.text }; interactive.header = { title: msg.title || '', hasMediaAttachment: false } }
        else if ('caption' in msg) { interactive.body = { text: msg.caption }; interactive.header = { title: msg.title || '', hasMediaAttachment: msg.hasMediaAttachment ?? false }; if (Object.keys(m).length) Object.assign(interactive.header, m) }
        if (msg.footer) interactive.footer = { text: msg.footer }
        applyContextInfoAndMentions(interactive, msg)
        applyExtraInteractiveFields(interactive, msg)
        return { interactiveMessage: interactive }
    },
}

export const generateWAMessageContent = async (message, options = {}) => {
    if (!message || typeof message !== 'object') return WAProto.Message.create({})
    const msgKeys = Object.keys(message)
    // Raw proto pass-through: no high-level keys and already has proto field names, or is a known wrapper
    const isWrapper = ['viewOnceMessage', 'ephemeralMessage', 'viewOnceMessageV2', 'documentWithCaptionMessage'].some(k => k in message)
    if (isWrapper || (!msgKeys.some(k => HIGH_LEVEL_KEYS.has(k)) && msgKeys.some(k => k.endsWith('Message') || k === 'conversation'))) return WAProto.Message.create(message)

    let m = {}
    // Text without interactive overlay keys goes straight to text handler
    const overlayKeys = Object.keys(OVERLAY_HANDLERS)
    if ('text' in message && !overlayKeys.some(k => k in message)) {
        m = await MESSAGE_HANDLERS.text(message, options)
    } else {
        // Find first matching handler key (skip 'text' here — handled above)
        const handlerKey = msgKeys.find(k => k !== 'text' && MESSAGE_HANDLERS[k])
        if (handlerKey) {
            const result = await MESSAGE_HANDLERS[handlerKey](message, options)
            if (result?._batched) return { stickerPackMessage: result.stickerPackMessage, isBatched: true, batchCount: result.batchCount }
            if (result?._finalize) return WAProto.Message.create({ stickerPackMessage: result.stickerPackMessage })
            m = result
        } else if (MEDIA_KEYS.some(k => k in message)) {
            m = await prepareWAMessageMedia(message, options)
        }
    }

    // Apply overlays: any overlay key present in message replaces m
    for (const key of overlayKeys) { if (key in message && message[key]) { m = OVERLAY_HANDLERS[key](m, message); break } }

    // Merge contextInfo / mentions onto the primary content key
    const finalKey = Object.keys(m)[0]
    if ((message.contextInfo || message.mentions?.length) && finalKey && m[finalKey] && typeof m[finalKey] === 'object') {
        m[finalKey].contextInfo = { ...(m[finalKey].contextInfo || {}), ...(message.contextInfo || {}), ...(message.mentions?.length ? { mentionedJid: message.mentions } : {}) }
    }

    if (('viewOnce' in message && message.viewOnce) || 'viewOnceMessage' in message) m = { viewOnceMessage: { message: m } }
    if ('edit' in message) m = { protocolMessage: { key: message.edit, editedMessage: m, timestampMs: Date.now(), type: WAProto.Message.ProtocolMessage.Type.MESSAGE_EDIT } }
    if ('contextInfo' in message && message.contextInfo) { const k = Object.keys(m)[0]; if (k && m[k]) m[k].contextInfo = { ...(m[k].contextInfo || {}), ...message.contextInfo } }

    if (shouldIncludeReportingToken(m)) { m.messageContextInfo ??= {}; m.messageContextInfo.messageSecret ??= randomBytes(32) }
    return WAProto.Message.create(m)
}

// ─── ASSEMBLE FULL WA MESSAGE ─────────────────────────────────────────────────

export const generateWAMessageFromContent = (jid, message, options) => {
    if (!options.timestamp) options.timestamp = new Date()
    const innerMessage = normalizeMessageContent(message)
    const key = getContentType(innerMessage)
    const { quoted, userJid } = options
    if (quoted && !isJidNewsletter(jid)) {
        const participant = quoted.key.fromMe ? userJid : (quoted.participant || quoted.key.participant || quoted.key.remoteJid)
        const normalizedQuoted = normalizeMessageContent(quoted.message)
        if (normalizedQuoted) {
            const quotedType = getContentType(normalizedQuoted)
            const quotedMsg = proto.Message.fromObject({ [quotedType]: normalizedQuoted[quotedType] })
            const quotedContent = quotedMsg[quotedType]
            if (typeof quotedContent === 'object' && quotedContent && 'contextInfo' in quotedContent) delete quotedContent.contextInfo
            const contextInfo = innerMessage[key]?.contextInfo || {}
            contextInfo.participant = jidNormalizedUser(participant)
            contextInfo.stanzaId = quoted.key.id
            contextInfo.quotedMessage = quotedMsg
            if (jid !== quoted.key.remoteJid) contextInfo.remoteJid = quoted.key.remoteJid
            if (innerMessage[key]) innerMessage[key].contextInfo = contextInfo
        }
    }
    if (options?.ephemeralExpiration && key !== 'protocolMessage' && key !== 'ephemeralMessage' && !isJidNewsletter(jid)) {
        innerMessage[key].contextInfo = { ...(innerMessage[key].contextInfo || {}), expiration: options.ephemeralExpiration || WA_DEFAULT_EPHEMERAL }
    }
    return WAProto.WebMessageInfo.fromObject({
        key: { remoteJid: jid, fromMe: true, id: options?.messageId || generateMessageIDV2() },
        message: WAProto.Message.create(message),
        messageTimestamp: unixTimestampSeconds(options.timestamp),
        messageStubParameters: [],
        participant: (isJidGroup(jid) || isJidStatusBroadcast(jid)) ? userJid : undefined,
        status: WAMessageStatus.PENDING,
    })
}

// Primary entry point. generateWAMessageContent returns a proto Message object.
// generateWAMessageFromContent wraps existing content into a WebMessageInfo.
// Call the wrong one by accident and it self-corrects rather than failing silently.
export const generateWAMessage = async (jid, content, options = {}) => {
    if (content?.key?.remoteJid && content?.message) return content
    options.logger = options?.logger?.child({ msgId: options.messageId })
    return generateWAMessageFromContent(jid, await generateWAMessageContent(content, { ...options, jid }), options)
}

// ─── UPDATE UTILITIES ─────────────────────────────────────────────────────────

export const updateMessageWithReceipt = (msg, receipt) => {
    msg.userReceipt ||= []
    const recp = msg.userReceipt.find(m => m.userJid === receipt.userJid)
    if (recp) Object.assign(recp, receipt)
    else msg.userReceipt.push(receipt)
}

export const updateMessageWithReaction = (msg, reaction) => {
    const authorID = getKeyAuthor(reaction.key)
    msg.reactions = (msg.reactions || []).filter(r => getKeyAuthor(r.key) !== authorID)
    reaction.text ||= ''
    msg.reactions.push(reaction)
}

export const updateMessageWithPollUpdate = (msg, update) => {
    const authorID = getKeyAuthor(update.pollUpdateMessageKey)
    msg.pollUpdates = (msg.pollUpdates || []).filter(r => getKeyAuthor(r.pollUpdateMessageKey) !== authorID)
    if (update.vote?.selectedOptions?.length) msg.pollUpdates.push(update)
}

export const updateMessageWithEventResponse = (msg, update) => {
    const authorID = getKeyAuthor(update.eventResponseMessageKey)
    msg.eventResponses = (msg.eventResponses || []).filter(r => getKeyAuthor(r.eventResponseMessageKey) !== authorID)
    msg.eventResponses.push(update)
}

export const getAggregateVotesInPollMessage = ({ message, pollUpdates }, meId) => {
    const opts = message?.pollCreationMessage?.options || message?.pollCreationMessageV2?.options || message?.pollCreationMessageV3?.options || []
    const voteHashMap = opts.reduce((acc, opt) => { acc[sha256(Buffer.from(opt.optionName || '')).toString()] = { name: opt.optionName || '', voters: [] }; return acc }, {})
    for (const update of pollUpdates || []) {
        if (!update.vote) continue
        for (const option of update.vote.selectedOptions || []) {
            const hash = option.toString()
            voteHashMap[hash] ||= { name: 'Unknown', voters: [] }
            voteHashMap[hash].voters.push(getKeyAuthor(update.pollUpdateMessageKey, meId))
        }
    }
    return Object.values(voteHashMap)
}

export const getAggregateResponsesInEventMessage = ({ eventResponses }, meId) => {
    const responseMap = { GOING: { response: 'GOING', responders: [] }, NOT_GOING: { response: 'NOT_GOING', responders: [] }, MAYBE: { response: 'MAYBE', responders: [] } }
    for (const update of eventResponses || []) { const type = update.eventResponse || 'UNKNOWN'; if (responseMap[type]) responseMap[type].responders.push(getKeyAuthor(update.eventResponseMessageKey, meId)) }
    return Object.values(responseMap)
}

export const aggregateMessageKeysNotFromMe = (keys) => {
    const keyMap = {}
    for (const { remoteJid, id, participant, fromMe } of keys) {
        if (!fromMe) { const uqKey = `${remoteJid}:${participant || ''}`; keyMap[uqKey] ||= { jid: remoteJid, participant, messageIds: [] }; keyMap[uqKey].messageIds.push(id) }
    }
    return Object.values(keyMap)
}

export const downloadMediaMessage = async (message, type, options, ctx) => {
    const downloadMsg = async () => {
        let normalized = message
        if (!message.message && message.key) normalized = { key: message.key, message: message.quoted?.message || message, messageTimestamp: message.messageTimestamp }
        const mContent = extractMessageContent(normalized.message)
        if (!mContent) throw new Boom('No message present', { statusCode: 400, data: message })
        const contentType = getContentType(mContent)
        let mediaType = contentType?.replace('Message', '')
        const media = mContent[contentType]
        if (!media || typeof media !== 'object' || (!('url' in media) && !('thumbnailDirectPath' in media))) throw new Boom(`"${contentType}" message is not a media message`)
        const download = ('thumbnailDirectPath' in media && !('url' in media)) ? { directPath: media.thumbnailDirectPath, mediaKey: media.mediaKey } : media
        if ('thumbnailDirectPath' in media && !('url' in media)) mediaType = 'thumbnail-link'
        const stream = await downloadContentFromMessage(download, mediaType, options)
        if (type === 'buffer') { const chunks = []; for await (const chunk of stream) chunks.push(chunk); return Buffer.concat(chunks) }
        return stream
    }
    return downloadMsg().catch(async (error) => {
        if (ctx && typeof error?.status === 'number' && REUPLOAD_REQUIRED_STATUS.includes(error.status)) { ctx.logger.info({ key: message.key }, 'sending reupload media request...'); message = await ctx.reuploadRequest(message); return downloadMsg() }
        throw error
    })
}

export const assertMediaContent = (content) => {
    content = extractMessageContent(content)
    const mediaContent = content?.documentMessage || content?.imageMessage || content?.videoMessage || content?.audioMessage || content?.stickerMessage || content?.stickerPackMessage
    if (!mediaContent) throw new Boom('given message is not a media message', { statusCode: 400, data: content })
    return mediaContent
}

export const getDevice = (id) => /^3A.{18}$/.test(id) ? 'ios' : /^3E.{20}$/.test(id) ? 'web' : /^(.{21}|.{32})$/.test(id) ? 'android' : /^(3F|.{18}$)/.test(id) ? 'desktop' : 'unknown'

export const patchMessageForMdIfRequired = (message) => {
    if (message?.buttonsMessage || message?.templateMessage || message?.listMessage || message?.interactiveMessage?.nativeFlowMessage) {
        message = { viewOnceMessageV2Extension: { message: { messageContextInfo: { deviceListMetadataVersion: 2, deviceListMetadata: {} }, ...message } } }
    }
    return message
}

export const hasNonNullishProperty = (message, key) => typeof message === 'object' && message !== null && key in message && message[key] !== null && message[key] !== undefined
export const hasOptionalProperty = (obj, key) => typeof obj === 'object' && obj !== null && key in obj && obj[key] !== null && obj[key] !== undefined
