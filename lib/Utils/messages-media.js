import { Boom } from '@hapi/boom';
import { exec } from 'child_process';
import * as Crypto from 'crypto';
import { once } from 'events';
import { createReadStream, createWriteStream, promises as fs } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { Readable, Transform } from 'stream';
import { URL } from 'url';
import { proto } from '../../WAProto/index.js';
import { DEFAULT_ORIGIN, MEDIA_HKDF_KEY_MAPPING, MEDIA_PATH_MAP } from '../Defaults/index.js';
import { getBinaryNodeChild, getBinaryNodeChildBuffer, jidNormalizedUser } from '../WABinary/index.js';
import { aesDecryptGCM, aesEncryptGCM, hkdf } from './crypto.js';
import { generateMessageIDV2 } from './generics.js';

export const getImageProcessingLibrary = async () => {
    const [jimp, sharp] = await Promise.all([
        import('jimp').catch(() => null),
        import('sharp').catch(() => null)
    ]);
    if (sharp) return { sharp };
    if (jimp) return { jimp };
    throw new Boom('No image processing library available');
};

export const hkdfInfoKey = (type) => `WhatsApp ${MEDIA_HKDF_KEY_MAPPING[type]} Keys`;

export const getRawMediaUploadData = async (media, mediaType, logger) => {
    const { stream } = await getStream(media);
    const hasher = Crypto.createHash('sha256');
    const filePath = join(tmpdir(), mediaType + generateMessageIDV2());
    const fileWriteStream = createWriteStream(filePath);
    let fileLength = 0;
    try {
        for await (const data of stream) {
            fileLength += data.length;
            hasher.update(data);
            if (!fileWriteStream.write(data)) await once(fileWriteStream, 'drain');
        }
        fileWriteStream.end();
        await once(fileWriteStream, 'finish');
        stream.destroy();
        logger?.debug('hashed data for raw upload');
        return { filePath, fileSha256: hasher.digest(), fileLength };
    } catch (error) {
        fileWriteStream.destroy();
        stream.destroy();
        try { await fs.unlink(filePath); } catch { }
        throw error;
    }
};

export async function getMediaKeys(buffer, mediaType) {
    if (!buffer) throw new Boom('Cannot derive from empty media key');
    if (typeof buffer === 'string') buffer = Buffer.from(buffer.replace('data:;base64,', ''), 'base64');
    const expandedMediaKey = hkdf(buffer, 112, { info: hkdfInfoKey(mediaType) });
    return {
        iv: expandedMediaKey.slice(0, 16),
        cipherKey: expandedMediaKey.slice(16, 48),
        macKey: expandedMediaKey.slice(48, 80)
    };
}

const extractVideoThumb = (path, destPath, time, size) => new Promise((resolve, reject) => {
    exec(`ffmpeg -ss ${time} -i ${path} -y -vf scale=${size.width}:-1 -vframes 1 -f image2 ${destPath}`, err => err ? reject(err) : resolve());
});

export const extractImageThumb = async (bufferOrFilePath, width = 32) => {
    if (bufferOrFilePath instanceof Readable) bufferOrFilePath = await toBuffer(bufferOrFilePath);
    const lib = await getImageProcessingLibrary();
    if ('sharp' in lib && typeof lib.sharp?.default === 'function') {
        const img = lib.sharp.default(bufferOrFilePath);
        const dimensions = await img.metadata();
        const buffer = await img.resize(width).jpeg({ quality: 50 }).toBuffer();
        return { buffer, original: { width: dimensions.width, height: dimensions.height } };
    } else if ('jimp' in lib && typeof lib.jimp?.Jimp === 'object') {
        const jimp = await lib.jimp.Jimp.read(bufferOrFilePath);
        const buffer = await jimp.resize({ w: width, mode: lib.jimp.ResizeStrategy.BILINEAR }).getBuffer('image/jpeg', { quality: 50 });
        return { buffer, original: { width: jimp.width, height: jimp.height } };
    }
    throw new Boom('No image processing library available');
};

export const encodeBase64EncodedStringForUpload = (b64) => encodeURIComponent(b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''));

export const generateProfilePicture = async (mediaUpload) => {
    let bufferOrFilePath = Buffer.isBuffer(mediaUpload) ? mediaUpload : 'url' in mediaUpload ? mediaUpload.url.toString() : await toBuffer(mediaUpload.stream);
    const lib = await getImageProcessingLibrary();
    if ('sharp' in lib && typeof lib.sharp?.default === 'function') {
        const img = await lib.sharp.default(bufferOrFilePath).resize(720, 720, { fit: 'inside' }).jpeg({ quality: 50 }).toBuffer();
        return { img };
    } else if ('jimp' in lib && typeof lib.jimp?.read === 'function') {
        const { read, MIME_JPEG } = lib.jimp;
        const image = await read(bufferOrFilePath);
        const min = image.getWidth(), max = image.getHeight();
        const img = await image.crop(0, 0, min, max).scaleToFit(720, 720).getBufferAsync(MIME_JPEG);
        return { img };
    }
    throw new Boom('No image processing library available');
};

export const mediaMessageSHA256B64 = (message) => {
    const media = Object.values(message)[0];
    return media?.fileSha256 && Buffer.from(media.fileSha256).toString('base64');
};

export async function getAudioDuration(buffer) {
    const musicMetadata = await import('music-metadata');
    if (Buffer.isBuffer(buffer)) return (await musicMetadata.parseBuffer(buffer, undefined, { duration: true })).format.duration;
    if (typeof buffer === 'string') return (await musicMetadata.parseFile(buffer, { duration: true })).format.duration;
    return (await musicMetadata.parseStream(buffer, undefined, { duration: true })).format.duration;
}

export async function getAudioWaveform(buffer, logger) {
    try {
        const { default: decoder } = await import('audio-decode');
        let audioData = Buffer.isBuffer(buffer) ? buffer : typeof buffer === 'string' ? await toBuffer(createReadStream(buffer)) : await toBuffer(buffer);
        const audioBuffer = await decoder(audioData);
        const rawData = audioBuffer.getChannelData(0);
        const samples = 64, blockSize = Math.floor(rawData.length / samples);
        const filteredData = [];
        for (let i = 0; i < samples; i++) {
            let sum = 0;
            for (let j = 0; j < blockSize; j++) sum += Math.abs(rawData[i * blockSize + j]);
            filteredData.push(sum / blockSize);
        }
        const multiplier = Math.pow(Math.max(...filteredData), -1);
        return new Uint8Array(filteredData.map(n => Math.floor(100 * n * multiplier)));
    } catch (e) {
        logger?.debug('Failed to generate waveform: ' + e);
        return new Uint8Array([0,99,0,99,0,99,0,99,88,99,0,99,0,55,0,99,0,99,0,99,0,99,0,99,88,99,0,99,0,55,0,99]);
    }
}

const convertToOpusBuffer = (buffer, logger) => new Promise((resolve, reject) => {
    const ffmpeg = exec('ffmpeg -i pipe:0 -c:a libopus -b:a 64k -vbr on -compression_level 10 -frame_duration 20 -application voip -f ogg pipe:1');
    const chunks = [];
    ffmpeg.stdin.write(buffer);
    ffmpeg.stdin.end();
    ffmpeg.stdout.on('data', chunk => chunks.push(chunk));
    ffmpeg.stderr.on('data', () => {});
    ffmpeg.on('close', code => code === 0 ? resolve(Buffer.concat(chunks)) : reject(new Error(`FFmpeg Opus conversion exited with code ${code}`)));
    ffmpeg.on('error', reject);
});

const convertToMp4Buffer = (buffer, logger) => new Promise((resolve, reject) => {
    const ffmpeg = exec('ffmpeg -i pipe:0 -c:v libx264 -preset veryfast -crf 23 -c:a aac -b:a 128k -movflags faststart -f mp4 pipe:1');
    const chunks = [];
    ffmpeg.stdin.write(buffer);
    ffmpeg.stdin.end();
    ffmpeg.stdout.on('data', chunk => chunks.push(chunk));
    ffmpeg.stderr.on('data', () => {});
    ffmpeg.on('close', code => code === 0 ? resolve(Buffer.concat(chunks)) : reject(new Error(`FFmpeg MP4 conversion exited with code ${code}`)));
    ffmpeg.on('error', reject);
});

export const toReadable = (buffer) => {
    const readable = new Readable({ read: () => {} });
    readable.push(buffer);
    readable.push(null);
    return readable;
};

export const toBuffer = async (stream) => {
    const chunks = [];
    for await (const chunk of stream) chunks.push(chunk);
    stream.destroy();
    return Buffer.concat(chunks);
};

export const getStream = async (item, opts) => {
    if (!item) throw new Boom('Item is required for getStream', { statusCode: 400 });
    if (Buffer.isBuffer(item)) return { stream: toReadable(item), type: 'buffer' };
    if (item?.stream?.pipe) return { stream: item.stream, type: 'readable' };
    if (item?.pipe) return { stream: item, type: 'readable' };
    if (item && typeof item === 'object' && 'url' in item) {
        const urlStr = item.url.toString();
        if (Buffer.isBuffer(item.url)) return { stream: toReadable(item.url), type: 'buffer' };
        if (urlStr.startsWith('data:')) return { stream: toReadable(Buffer.from(urlStr.split(',')[1], 'base64')), type: 'buffer' };
        if (urlStr.startsWith('http')) return { stream: await getHttpStream(item.url, opts), type: 'remote' };
        return { stream: createReadStream(item.url), type: 'file' };
    }
    if (typeof item === 'string') {
        if (item.startsWith('data:')) return { stream: toReadable(Buffer.from(item.split(',')[1], 'base64')), type: 'buffer' };
        if (item.startsWith('http')) return { stream: await getHttpStream(item, opts), type: 'remote' };
        return { stream: createReadStream(item), type: 'file' };
    }
    throw new Boom(`Invalid input type for getStream: ${typeof item}`, { statusCode: 400 });
};

export async function generateThumbnail(file, mediaType, options) {
    let thumbnail, originalImageDimensions;
    if (mediaType === 'image') {
        const { buffer, original } = await extractImageThumb(file);
        thumbnail = buffer.toString('base64');
        if (original.width && original.height) originalImageDimensions = original;
    } else if (mediaType === 'video') {
        const imgFilename = join(tmpdir(), generateMessageIDV2() + '.jpg');
        try {
            await extractVideoThumb(file, imgFilename, '00:00:00', { width: 32, height: 32 });
            thumbnail = (await fs.readFile(imgFilename)).toString('base64');
            await fs.unlink(imgFilename);
        } catch (err) {
            options.logger?.debug('could not generate video thumb: ' + err);
        }
    }
    return { thumbnail, originalImageDimensions };
}

export const getHttpStream = async (url, options = {}) => {
    const response = await fetch(url.toString(), { dispatcher: options.dispatcher, method: 'GET', headers: options.headers });
    if (!response.ok) throw new Boom(`Failed to fetch stream from ${url}`, { statusCode: response.status, data: { url } });
    const body = response.body;
    if (body && typeof body === 'object' && 'pipeTo' in body && typeof body.pipeTo === 'function') return Readable.fromWeb(body);
    if (body && typeof body.pipe === 'function' && typeof body.read === 'function') return body;
    throw new Error('Response body is not a readable stream');
};

export const prepareStream = async (media, mediaType, { logger, saveOriginalFileIfRequired, opts, convertVideo } = {}) => {
    const { stream, type } = await getStream(media, opts);
    logger?.debug('fetched media stream');
    let buffer = await toBuffer(stream);
    if (mediaType === 'video' && convertVideo) {
        try { buffer = await convertToMp4Buffer(buffer, logger); logger?.debug('converted video to mp4 for newsletter'); }
        catch (e) { logger?.error('failed to convert video for newsletter:', e); }
    }
    let bodyPath, didSaveToTmpPath = false;
    try {
        if (type === 'file') bodyPath = media.url;
        else if (saveOriginalFileIfRequired) {
            bodyPath = join(tmpdir(), mediaType + generateMessageIDV2());
            await fs.writeFile(bodyPath, buffer);
            didSaveToTmpPath = true;
        }
        return { mediaKey: undefined, encWriteStream: buffer, fileLength: buffer.length, fileSha256: Crypto.createHash('sha256').update(buffer).digest(), fileEncSha256: undefined, bodyPath, didSaveToTmpPath };
    } catch (error) {
        if (didSaveToTmpPath && bodyPath) try { await fs.unlink(bodyPath); } catch { }
        throw error;
    }
};

export const encryptedStream = async (media, mediaType, { logger, saveOriginalFileIfRequired, opts, mediaKey: providedMediaKey, isPtt, forceOpus, convertVideo } = {}) => {
    const { stream, type } = await getStream(media, opts);
    let finalStream = stream, opusConverted = false;

    if (mediaType === 'audio' && (isPtt === true || forceOpus === true)) {
        try {
            finalStream = toReadable(await convertToOpusBuffer(await toBuffer(stream), logger));
            opusConverted = true;
            logger?.debug('converted audio to Opus');
        } catch (error) {
            logger?.error('failed to convert audio to Opus, using original');
            finalStream = (await getStream(media, opts)).stream;
        }
    }

    if (mediaType === 'video' && convertVideo === true) {
        try {
            finalStream = toReadable(await convertToMp4Buffer(await toBuffer(finalStream), logger));
            logger?.debug('converted video to mp4');
        } catch (error) {
            logger?.error('failed to convert video to mp4, using original');
            finalStream = (await getStream(media, opts)).stream;
        }
    }

    const mediaKey = providedMediaKey || Crypto.randomBytes(32);
    const { cipherKey, iv, macKey } = await getMediaKeys(mediaKey, mediaType);
    const encFilePath = join(tmpdir(), mediaType + generateMessageIDV2() + '-enc');
    const encFileWriteStream = createWriteStream(encFilePath);
    let originalFileStream, originalFilePath;

    if (saveOriginalFileIfRequired) {
        originalFilePath = join(tmpdir(), mediaType + generateMessageIDV2() + '-original');
        originalFileStream = createWriteStream(originalFilePath);
    }

    let fileLength = 0;
    const aes = Crypto.createCipheriv('aes-256-cbc', cipherKey, iv);
    const hmac = Crypto.createHmac('sha256', macKey).update(iv);
    const sha256Plain = Crypto.createHash('sha256');
    const sha256Enc = Crypto.createHash('sha256');

    try {
        for await (const data of finalStream) {
            fileLength += data.length;
            if (type === 'remote' && opts?.maxContentLength && fileLength > opts.maxContentLength) throw new Boom('content length exceeded', { data: { media, type } });
            if (originalFileStream && !originalFileStream.write(data)) await once(originalFileStream, 'drain');
            sha256Plain.update(data);
            const encrypted = aes.update(data);
            sha256Enc.update(encrypted);
            hmac.update(encrypted);
            encFileWriteStream.write(encrypted);
        }
        const finalData = aes.final();
        sha256Enc.update(finalData);
        hmac.update(finalData);
        encFileWriteStream.write(finalData);
        const mac = hmac.digest().slice(0, 10);
        sha256Enc.update(mac);
        encFileWriteStream.write(mac);
        encFileWriteStream.end();
        originalFileStream?.end?.();
        finalStream.destroy();
        logger?.debug('encrypted data successfully');
        return { mediaKey, bodyPath: originalFilePath, encFilePath, mac, fileEncSha256: sha256Enc.digest(), fileSha256: sha256Plain.digest(), fileLength, opusConverted };
    } catch (error) {
        encFileWriteStream.destroy();
        originalFileStream?.destroy?.();
        aes.destroy();
        hmac.destroy();
        sha256Plain.destroy();
        sha256Enc.destroy();
        finalStream.destroy();
        try { await fs.unlink(encFilePath); if (originalFilePath) await fs.unlink(originalFilePath); } catch (err) { logger?.error({ err }, 'failed deleting tmp files'); }
        throw error;
    }
};

const DEF_HOST = 'mmg.whatsapp.net';
const AES_CHUNK_SIZE = 16;
const toSmallestChunkSize = (num) => Math.floor(num / AES_CHUNK_SIZE) * AES_CHUNK_SIZE;

export const getUrlFromDirectPath = (directPath) => `https://${DEF_HOST}${directPath}`;

export const downloadContentFromMessage = async ({ mediaKey, directPath, url }, type, opts = {}) => {
    const isValidMediaUrl = url?.startsWith('https://mmg.whatsapp.net/');
    const downloadUrl = isValidMediaUrl ? url : getUrlFromDirectPath(directPath);
    if (!downloadUrl) throw new Boom('No valid media URL or directPath present', { statusCode: 400 });
    return downloadEncryptedContent(downloadUrl, await getMediaKeys(mediaKey, type), opts);
};

export const downloadEncryptedContent = async (downloadUrl, { cipherKey, iv }, { startByte, endByte, options } = {}) => {
    let bytesFetched = 0, startChunk = 0, firstBlockIsIV = false;
    if (startByte) {
        const chunk = toSmallestChunkSize(startByte || 0);
        if (chunk) { startChunk = chunk - AES_CHUNK_SIZE; bytesFetched = chunk; firstBlockIsIV = true; }
    }
    const endChunk = endByte ? toSmallestChunkSize(endByte || 0) + AES_CHUNK_SIZE : undefined;
    const headers = { ...(options?.headers ? (Array.isArray(options.headers) ? Object.fromEntries(options.headers) : options.headers) : {}), Origin: DEFAULT_ORIGIN };
    if (startChunk || endChunk) headers.Range = `bytes=${startChunk}-${endChunk || ''}`;

    const fetched = await getHttpStream(downloadUrl, { ...(options || {}), headers });
    let remainingBytes = Buffer.from([]), aes;

    const pushBytes = (bytes, push) => {
        if (startByte || endByte) {
            const start = bytesFetched >= startByte ? undefined : Math.max(startByte - bytesFetched, 0);
            const end = bytesFetched + bytes.length < endByte ? undefined : Math.max(endByte - bytesFetched, 0);
            push(bytes.slice(start, end));
            bytesFetched += bytes.length;
        } else {
            push(bytes);
        }
    };

    const output = new Transform({
        transform(chunk, _, callback) {
            let data = Buffer.concat([remainingBytes, chunk]);
            const decryptLength = toSmallestChunkSize(data.length);
            remainingBytes = data.slice(decryptLength);
            data = data.slice(0, decryptLength);
            if (!aes) {
                let ivValue = iv;
                if (firstBlockIsIV) { ivValue = data.slice(0, AES_CHUNK_SIZE); data = data.slice(AES_CHUNK_SIZE); }
                aes = Crypto.createDecipheriv('aes-256-cbc', cipherKey, ivValue);
                if (endByte) aes.setAutoPadding(false);
            }
            try { pushBytes(aes.update(data), b => this.push(b)); callback(); } catch (error) { callback(error); }
        },
        final(callback) {
            try { pushBytes(aes.final(), b => this.push(b)); callback(); } catch (error) { callback(error); }
        }
    });
    return fetched.pipe(output, { end: true });
};

export function extensionForMediaMessage(message) {
    const getExtension = (mimetype) => mimetype.split(';')[0]?.split('/')[1];
    const type = Object.keys(message)[0];
    if (type === 'locationMessage' || type === 'liveLocationMessage' || type === 'productMessage') return '.jpeg';
    return getExtension(message[type].mimetype);
}

export const getWAUploadToServer = ({ customUploadHosts, fetchAgent, logger, options }, refreshMediaConn) => {
    return async (stream, { mediaType, fileEncSha256B64, newsletter, timeoutMs }) => {
        // Accepts Buffer, file path, Node stream, Web ReadableStream, or async iterable.
        // File paths are streamed directly from disk — no RAM cost for large files.
        const toUploadBody = async (input) => {
            if (!input) throw new Boom('Upload input is null or undefined', { statusCode: 400 });
            if (Buffer.isBuffer(input)) return input;
            if (typeof input === 'string') return createReadStream(input);
            if (typeof ReadableStream !== 'undefined' && input instanceof ReadableStream) return Readable.fromWeb(input);
            if (typeof input.pipe === 'function' || typeof input[Symbol.asyncIterator] === 'function') return input;
            throw new Boom(`Unsupported upload input type: ${Object.prototype.toString.call(input)}`, { statusCode: 400 });
        };

        let reqBody;
        try { reqBody = await toUploadBody(stream); }
        catch (err) { logger?.error({ err: err.message }, 'failed to prepare upload body'); throw err; }

        fileEncSha256B64 = encodeBase64EncodedStringForUpload(fileEncSha256B64);

        let media = MEDIA_PATH_MAP[mediaType];
        if (newsletter) media = media?.replace('/mms/', '/newsletter/newsletter-');
        if (!media) throw new Boom(`No media path found for type: ${mediaType}`, { statusCode: 400 });

        // Force-refresh auth upfront to avoid stale token failures
        let uploadInfo = await refreshMediaConn(true);
        const hosts = [...(customUploadHosts ?? []), ...(uploadInfo.hosts ?? [])];
        if (!hosts.length) throw new Boom('No upload hosts available', { statusCode: 503 });

        const MAX_RETRIES = 2;
        let urls, lastError;

        for (const { hostname, maxContentLengthBytes } of hosts) {
            for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
                try {
                    if (attempt > 1) {
                        uploadInfo = await refreshMediaConn(true);
                        reqBody = await toUploadBody(stream);
                    }

                    if (maxContentLengthBytes && Buffer.isBuffer(reqBody) && reqBody.length > maxContentLengthBytes) {
                        logger?.warn({ hostname, maxContentLengthBytes }, 'body too large for host, skipping');
                        break;
                    }

                    const auth = encodeURIComponent(uploadInfo.auth);
                    const url = `https://${hostname}${media}/${fileEncSha256B64}?auth=${auth}&token=${fileEncSha256B64}`;
                    const controller = new AbortController();
                    const timer = timeoutMs ? setTimeout(() => controller.abort(), timeoutMs) : null;

                    let response;
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
                        });
                    } finally {
                        if (timer) clearTimeout(timer);
                    }

                    let result;
                    try { result = await response.json(); } catch { result = null; }

                    if (result?.url || result?.directPath) {
                        urls = { mediaUrl: result.url, directPath: result.direct_path, handle: result.handle };
                        break;
                    }

                    lastError = new Error(`${hostname} rejected upload (HTTP ${response.status}): ${JSON.stringify(result)}`);
                    logger?.warn({ hostname, attempt, status: response.status, result }, 'upload rejected');

                } catch (err) {
                    lastError = err;
                    logger?.warn({ hostname, attempt, err: err.message, timedOut: err.name === 'AbortError' }, 'upload attempt failed');
                    if (attempt < MAX_RETRIES) await new Promise(r => setTimeout(r, 500 * attempt));
                }
            }
            if (urls) break;
        }

        if (!urls) {
            const msg = `Media upload failed on all hosts. Last error: ${lastError?.message ?? 'unknown'}`;
            logger?.error({ hosts: hosts.map(h => h.hostname), lastError: lastError?.message }, msg);
            throw new Boom(msg, { statusCode: 500, data: { lastError: lastError?.message } });
        }

        return urls;
    };
};

const getMediaRetryKey = (mediaKey) => hkdf(mediaKey, 32, { info: 'WhatsApp Media Retry Notification' });

export const encryptMediaRetryRequest = async (key, mediaKey, meId) => {
    const recp = { stanzaId: key.id };
    const recpBuffer = proto.ServerErrorReceipt.encode(recp).finish();
    const iv = Crypto.randomBytes(12);
    const retryKey = await getMediaRetryKey(mediaKey);
    const ciphertext = aesEncryptGCM(recpBuffer, retryKey, iv, Buffer.from(key.id));
    return {
        tag: 'receipt',
        attrs: { id: key.id, to: jidNormalizedUser(meId), type: 'server-error' },
        content: [
            { tag: 'encrypt', attrs: {}, content: [
                { tag: 'enc_p', attrs: {}, content: ciphertext },
                { tag: 'enc_iv', attrs: {}, content: iv }
            ]},
            { tag: 'rmr', attrs: { jid: key.remoteJid, from_me: (!!key.fromMe).toString(), participant: key.participant } }
        ]
    };
};

export const decodeMediaRetryNode = (node) => {
    const rmrNode = getBinaryNodeChild(node, 'rmr');
    const event = {
        key: { id: node.attrs.id, remoteJid: rmrNode.attrs.jid, fromMe: rmrNode.attrs.from_me === 'true', participant: rmrNode.attrs.participant }
    };
    const errorNode = getBinaryNodeChild(node, 'error');
    if (errorNode) {
        event.error = new Boom(`Failed to re-upload media (${+errorNode.attrs.code})`, { data: errorNode.attrs, statusCode: getStatusCodeForMediaRetry(+errorNode.attrs.code) });
    } else {
        const encryptedInfoNode = getBinaryNodeChild(node, 'encrypt');
        const ciphertext = getBinaryNodeChildBuffer(encryptedInfoNode, 'enc_p');
        const iv = getBinaryNodeChildBuffer(encryptedInfoNode, 'enc_iv');
        if (ciphertext && iv) event.media = { ciphertext, iv };
        else event.error = new Boom('Failed to re-upload media (missing ciphertext)', { statusCode: 404 });
    }
    return event;
};

export const decryptMediaRetryData = async ({ ciphertext, iv }, mediaKey, msgId) => {
    const plaintext = aesDecryptGCM(ciphertext, await getMediaRetryKey(mediaKey), iv, Buffer.from(msgId));
    return proto.MediaRetryNotification.decode(plaintext);
};

export const getStatusCodeForMediaRetry = (code) => MEDIA_RETRY_STATUS_MAP[code];

const MEDIA_RETRY_STATUS_MAP = {
    [proto.MediaRetryNotification.ResultType.SUCCESS]: 200,
    [proto.MediaRetryNotification.ResultType.DECRYPTION_ERROR]: 412,
    [proto.MediaRetryNotification.ResultType.NOT_FOUND]: 404,
    [proto.MediaRetryNotification.ResultType.GENERAL_ERROR]: 418
};