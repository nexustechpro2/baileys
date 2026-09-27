import { unfurl } from 'unfurl.js'
import { prepareWAMessageMedia } from './messages.js'
import { extractImageThumb, getHttpStream } from './messages-media.js'

const THUMBNAIL_WIDTH = 192
const TIMEOUT = 8_000
const MAX_INFLIGHT = 1000
const _inflight = new Map()

const _normalize = text => { const t = text.trim(); return /^https?:\/\//i.test(t) ? t : `https://${t}` }
const _extractImage = data => data?.open_graph?.images?.[0]?.url ?? data?.twitter_card?.images?.[0]?.url ?? data?.oEmbed?.thumbnails?.[0]?.url ?? data?.favicon ?? null
const _previewType = image => image ? 5 : 0
const _compressedThumb = async (url, opts) => (await extractImageThumb(await getHttpStream(url, opts.fetchOpts), opts.thumbnailWidth ?? THUMBNAIL_WIDTH)).buffer

const _resolveThumbnail = async (image, opts) => {
    if (!image) return {}
    if (opts.uploadImage) {
        try {
            const { imageMessage } = await prepareWAMessageMedia({ image: { url: image } }, { upload: opts.uploadImage, mediaTypeOverride: 'thumbnail-link', options: opts.fetchOpts })
            const jpeg = imageMessage?.jpegThumbnail ? Buffer.from(imageMessage.jpegThumbnail) : await _compressedThumb(image, opts).catch(() => undefined)
            return { jpegThumbnail: jpeg, highQualityThumbnail: imageMessage ?? undefined }
        } catch { }
    }
    try { return { jpegThumbnail: await _compressedThumb(image, opts) } } catch { return {} }
}

const _fetchMeta = async (url, opts) => {
    try {
        const data = await unfurl(url, { timeout: opts.fetchOpts?.timeout ?? TIMEOUT })
        const title = (data?.open_graph?.title !== data?.title ? data?.open_graph?.title : data?.title) ?? data?.oEmbed?.title
        if (!title) return undefined
        return { url: data?.open_graph?.url ?? url, title, description: data?.open_graph?.description ?? data?.description ?? data?.oEmbed?.author_name ?? '', image: _extractImage(data) }
    } catch (err) { opts.logger?.warn({ err: err?.message || err, url }, 'unfurl failed'); return undefined }
}

const _buildResult = async (meta, text, opts) => ({
    'canonical-url': meta.url, 'matched-text': text,
    title: meta.title, description: meta.description,
    originalThumbnailUrl: meta.image, previewType: _previewType(meta.image),
    ...await _resolveThumbnail(meta.image, opts)
})

export const getUrlInfo = (text, opts = {}) => {
    const url = _normalize(text)
    if (_inflight.has(url)) return _inflight.get(url)
    if (_inflight.size >= MAX_INFLIGHT) return Promise.resolve(undefined)
    const o = { fetchOpts: { timeout: TIMEOUT, ...opts.fetchOpts }, thumbnailWidth: opts.thumbnailWidth ?? THUMBNAIL_WIDTH, uploadImage: opts.uploadImage, logger: opts.logger }
    const promise = (async () => { const meta = await _fetchMeta(url, o); return meta ? _buildResult(meta, text, o) : undefined })().finally(() => _inflight.delete(url))
    _inflight.set(url, promise)
    return promise
}