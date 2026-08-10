import { unfurl } from 'unfurl.js'
import { prepareWAMessageMedia } from './messages.js'
import { extractImageThumb, getHttpStream } from './messages-media.js'

const THUMBNAIL_WIDTH = 192
const TIMEOUT = 8_000
const MAX_INFLIGHT = 1000

const _inflight = new Map()

const _normalize = text => {
    const t = text.trim()
    return /^https?:\/\//i.test(t) ? t : `https://${t}`
}

const _extractImage = data =>
    data?.open_graph?.images?.[0]?.url
    ?? data?.twitter_card?.images?.[0]?.url
    ?? data?.oEmbed?.thumbnails?.[0]?.url
    ?? data?.favicon
    ?? null

const _previewType = image => image ? 5 : 0

const _compressedThumb = async (url, opts) => {
    const stream = await getHttpStream(url, opts.fetchOpts)
    return (await extractImageThumb(stream, opts.thumbnailWidth ?? THUMBNAIL_WIDTH)).buffer
}

const _resolveThumbnail = async (image, opts) => {
    if (!image) return {}
    let thumbs = {}
    if (opts.uploadImage) {
        try {
            const { imageMessage } = await prepareWAMessageMedia(
                { image: { url: image } },
                { upload: opts.uploadImage, mediaTypeOverride: 'thumbnail-link', options: opts.fetchOpts }
            )
            const jpeg = imageMessage?.jpegThumbnail
                ? Buffer.from(imageMessage.jpegThumbnail)
                : await _compressedThumb(image, opts).catch(() => undefined)
            thumbs = { jpegThumbnail: jpeg, highQualityThumbnail: imageMessage ?? undefined }
        } catch {
            try { thumbs = { jpegThumbnail: await _compressedThumb(image, opts) } } catch { }
        }
    } else {
        try { thumbs = { jpegThumbnail: await _compressedThumb(image, opts) } } catch { }
    }
    return thumbs
}

const _fetchMeta = async (url, opts) => {
    try {
        const data = await unfurl(url, { timeout: opts.fetchOpts?.timeout ?? TIMEOUT })
        const htmlTitle = data?.title
        const ogTitle = data?.open_graph?.title
        const title = (ogTitle && ogTitle !== htmlTitle ? ogTitle : htmlTitle) ?? data?.oEmbed?.title
        if (!title) return undefined
        return {
            url: data?.open_graph?.url ?? url,
            title,
            description: data?.open_graph?.description ?? data?.description ?? data?.oEmbed?.author_name ?? '',
            image: _extractImage(data),
        }
    } catch (err) {
        opts.logger?.warn({ err: err?.message || err, url }, 'unfurl failed')
        return undefined
    }
}

const _buildResult = async (meta, text, opts) => ({
    'canonical-url': meta.url,
    'matched-text': text,
    title: meta.title,
    description: meta.description,
    originalThumbnailUrl: meta.image,
    previewType: _previewType(meta.image),
    ...await _resolveThumbnail(meta.image, opts),
})

export const getUrlInfo = (text, opts = {}) => {
    const url = _normalize(text)
    if (_inflight.has(url)) return _inflight.get(url)
    if (_inflight.size >= MAX_INFLIGHT) return Promise.resolve(undefined)
    const o = {
        fetchOpts: { timeout: TIMEOUT, ...opts.fetchOpts },
        thumbnailWidth: opts.thumbnailWidth ?? THUMBNAIL_WIDTH,
        uploadImage: opts.uploadImage,
        logger: opts.logger,
    }
    const promise = (async () => {
        const meta = await _fetchMeta(url, o)
        if (!meta) return undefined
        return _buildResult(meta, text, o)
    })().finally(() => _inflight.delete(url))
    _inflight.set(url, promise)
    return promise
}