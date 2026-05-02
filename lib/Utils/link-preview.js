import { prepareWAMessageMedia } from './messages.js'
import { extractImageThumb, getHttpStream } from './messages-media.js'

const THUMBNAIL_WIDTH_PX = 192
const MAX_REDIRECTS = 5
const PREVIEW_TIMEOUT = 5000
const MAX_CONCURRENT = 10
let _active = 0
const _queue = []
const _drain = () => {
    if (_queue.length === 0 || _active >= MAX_CONCURRENT) return
    _active++
    const { fn, resolve, reject } = _queue.shift()
    fn().then(resolve).catch(reject).finally(() => { _active--; _drain() })
}
const _enqueue = fn => new Promise((resolve, reject) => { _queue.push({ fn, resolve, reject }); _drain() })

// Lazy-load link-preview-js — handles ESM export map differences across versions
let _getLinkPreview
const loadLinkPreview = async () => {
    if (_getLinkPreview) return _getLinkPreview
    try {
        const mod = await import('link-preview-js')
        _getLinkPreview = mod.getLinkPreview ?? mod.default?.getLinkPreview
    } catch {
        _getLinkPreview = null
    }
    return _getLinkPreview
}

const _compressedThumb = async (url, opts) => {
    const stream = await getHttpStream(url, opts.fetchOpts)
    const result = await extractImageThumb(stream, opts.thumbnailWidth ?? THUMBNAIL_WIDTH_PX)
    return result.buffer
}

const _resolveThumbnail = async (image, opts) => {
    if (!image) return {}
    if (opts.uploadImage) {
        try {
            const { imageMessage } = await prepareWAMessageMedia(
                { image: { url: image } },
                { upload: opts.uploadImage, mediaTypeOverride: 'thumbnail-link', options: opts.fetchOpts }
            )
            return {
                jpegThumbnail: imageMessage?.jpegThumbnail ? Buffer.from(imageMessage.jpegThumbnail) : undefined,
                highQualityThumbnail: imageMessage ?? undefined
            }
        } catch (err) {
            opts.logger?.warn({ err: err.message, url: image }, 'upload failed, falling back to compressed thumb')
        }
    }
    try {
        return { jpegThumbnail: await _compressedThumb(image, opts) }
    } catch (err) {
        opts.logger?.debug({ err: err.stack }, 'compressed thumb failed')
        return {}
    }
}

export const getUrlInfo = (text, opts = {}) => _enqueue(async () => {
    const fetchOpts = opts.fetchOpts ?? { timeout: PREVIEW_TIMEOUT }
    const thumbnailWidth = opts.thumbnailWidth ?? THUMBNAIL_WIDTH_PX
    const resolvedOpts = { ...opts, fetchOpts, thumbnailWidth }
    try {
        const getLinkPreview = await loadLinkPreview()
        if (!getLinkPreview) return undefined

        let retries = 0
        const previewLink = (text.startsWith('https://') || text.startsWith('http://')) ? text : 'https://' + text
        const info = await getLinkPreview(previewLink, {
            ...fetchOpts,
            followRedirects: 'manual',
            handleRedirects: (baseURL, forwardedURL) => {
                if (retries >= MAX_REDIRECTS) return false
                const base = new URL(baseURL)
                const fwd = new URL(forwardedURL)
                const sameHost = fwd.hostname === base.hostname || fwd.hostname === 'www.' + base.hostname || 'www.' + fwd.hostname === base.hostname
                if (sameHost) { retries++; return true }
                return false
            },
            headers: fetchOpts.headers
        })
        if (!info || !('title' in info) || !info.title) return undefined
        const [image] = info.images ?? []
        const thumbs = await _resolveThumbnail(image, resolvedOpts)
        return {
            'canonical-url': info.url,
            'matched-text': text,
            title: info.title,
            description: info.description,
            originalThumbnailUrl: image,
            ...thumbs
        }
    } catch (err) {
        if (!err.message?.includes('receive a valid') && err.code !== 'ERR_MODULE_NOT_FOUND' && err.code !== 'MODULE_NOT_FOUND') {
            throw err
        }
    }
})
//# sourceMappingURL=link-preview.js.map