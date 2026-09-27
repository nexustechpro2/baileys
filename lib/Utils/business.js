import { Boom } from '@hapi/boom'
import { createHash } from 'crypto'
import { getBinaryNodeChild, getBinaryNodeChildren, getBinaryNodeChildString } from '../WABinary/index.js'
import { getStream, getUrlFromDirectPath, toReadable } from './messages-media.js'

export const parseCatalogNode = node => {
    const catalogNode = getBinaryNodeChild(node, 'product_catalog')
    const paging = getBinaryNodeChild(catalogNode, 'paging')
    return { products: getBinaryNodeChildren(catalogNode, 'product').map(parseProductNode), nextPageCursor: paging ? getBinaryNodeChildString(paging, 'after') : undefined }
}

export const parseCollectionsNode = node => {
    const collectionsNode = getBinaryNodeChild(node, 'collections')
    return { collections: getBinaryNodeChildren(collectionsNode, 'collection').map(collectionNode => ({ id: getBinaryNodeChildString(collectionNode, 'id'), name: getBinaryNodeChildString(collectionNode, 'name'), products: getBinaryNodeChildren(collectionNode, 'product').map(parseProductNode), status: parseStatusInfo(collectionNode) })) }
}

export const parseOrderDetailsNode = node => {
    const orderNode = getBinaryNodeChild(node, 'order')
    const priceNode = getBinaryNodeChild(orderNode, 'price')
    const products = getBinaryNodeChildren(orderNode, 'product').map(productNode => {
        const imageNode = getBinaryNodeChild(productNode, 'image')
        return { id: getBinaryNodeChildString(productNode, 'id'), name: getBinaryNodeChildString(productNode, 'name'), imageUrl: getBinaryNodeChildString(imageNode, 'url'), price: +getBinaryNodeChildString(productNode, 'price'), currency: getBinaryNodeChildString(productNode, 'currency'), quantity: +getBinaryNodeChildString(productNode, 'quantity') }
    })
    return { price: { total: +getBinaryNodeChildString(priceNode, 'total'), currency: getBinaryNodeChildString(priceNode, 'currency') }, products }
}

export const toProductNode = (productId, product) => {
    const attrs = {}
    const content = []
    const push = (tag, value) => content.push({ tag, attrs: {}, content: Buffer.from(value) })
    if (productId !== undefined) push('id', productId)
    if (product.name !== undefined) push('name', product.name)
    if (product.description !== undefined) push('description', product.description)
    if (product.retailerId !== undefined) push('retailer_id', product.retailerId)
    if (product.images?.length) {
        content.push({
            tag: 'media', attrs: {}, content: product.images.map(img => {
                if (!('url' in img)) throw new Boom('Expected img for product to already be uploaded', { statusCode: 400 })
                return { tag: 'image', attrs: {}, content: [{ tag: 'url', attrs: {}, content: Buffer.from(img.url.toString()) }] }
            })
        })
    }
    if (product.price !== undefined) push('price', product.price.toString())
    if (product.currency !== undefined) push('currency', product.currency)
    if ('originCountryCode' in product) {
        if (product.originCountryCode === undefined) attrs['compliance_category'] = 'COUNTRY_ORIGIN_EXEMPT'
        else content.push({ tag: 'compliance_info', attrs: {}, content: [{ tag: 'country_code_origin', attrs: {}, content: Buffer.from(product.originCountryCode) }] })
    }
    if (product.isHidden !== undefined) attrs['is_hidden'] = product.isHidden.toString()
    return { tag: 'product', attrs, content }
}

export const parseProductNode = productNode => {
    const mediaNode = getBinaryNodeChild(productNode, 'media')
    const statusInfoNode = getBinaryNodeChild(productNode, 'status_info')
    return { id: getBinaryNodeChildString(productNode, 'id'), imageUrls: parseImageUrls(mediaNode), reviewStatus: { whatsapp: getBinaryNodeChildString(statusInfoNode, 'status') }, availability: 'in stock', name: getBinaryNodeChildString(productNode, 'name'), retailerId: getBinaryNodeChildString(productNode, 'retailer_id'), url: getBinaryNodeChildString(productNode, 'url'), description: getBinaryNodeChildString(productNode, 'description'), price: +getBinaryNodeChildString(productNode, 'price'), currency: getBinaryNodeChildString(productNode, 'currency'), isHidden: productNode.attrs.is_hidden === 'true' }
}

export const uploadingNecessaryImagesOfProduct = async (product, waUploadToServer, timeoutMs = 30000) =>
    ({ ...product, images: product.images ? await uploadingNecessaryImages(product.images, waUploadToServer, timeoutMs) : product.images })

export const uploadingNecessaryImages = (images, waUploadToServer, timeoutMs = 30000) =>
    Promise.all(images.map(async img => {
        if ('url' in img && img.url.toString().includes('.whatsapp.net')) return { url: img.url.toString() }
        const { stream } = await getStream(img)
        const hasher = createHash('sha256')
        const blocks = []
        for await (const block of stream) { hasher.update(block); blocks.push(block) }
        const sha = hasher.digest('base64')
        const { directPath } = await waUploadToServer(toReadable(Buffer.concat(blocks)), { mediaType: 'product-catalog-image', fileEncSha256B64: sha, timeoutMs })
        return { url: getUrlFromDirectPath(directPath) }
    }))

const parseImageUrls = mediaNode => { const imgNode = getBinaryNodeChild(mediaNode, 'image'); return { requested: getBinaryNodeChildString(imgNode, 'request_image_url'), original: getBinaryNodeChildString(imgNode, 'original_image_url') } }
const parseStatusInfo = mediaNode => { const node = getBinaryNodeChild(mediaNode, 'status_info'); return { status: getBinaryNodeChildString(node, 'status'), canAppeal: getBinaryNodeChildString(node, 'can_appeal') === 'true' } }