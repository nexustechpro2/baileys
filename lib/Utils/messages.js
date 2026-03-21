import { Boom } from '@hapi/boom';
import { randomBytes } from 'crypto';
import { promises as fs } from 'fs';
import { zip } from 'fflate';
import { proto } from '../../WAProto/index.js';
import { CALL_AUDIO_PREFIX, CALL_VIDEO_PREFIX, MEDIA_KEYS, URL_REGEX, WA_DEFAULT_EPHEMERAL } from '../Defaults/index.js';
import { WAMessageStatus, WAProto } from '../Types/index.js';
import { isJidGroup, isJidNewsletter, isJidStatusBroadcast, jidNormalizedUser } from '../WABinary/index.js';
import { sha256 } from './crypto.js';
import { generateMessageIDV2, getKeyAuthor, unixTimestampSeconds } from './generics.js';
import { downloadContentFromMessage, encryptedStream, prepareStream, generateThumbnail, getAudioDuration, getAudioWaveform, getRawMediaUploadData, getStream, toBuffer, getImageProcessingLibrary } from './messages-media.js';

const MIMETYPE_MAP = { image: 'image/jpeg', video: 'video/mp4', document: 'application/pdf', audio: 'audio/ogg; codecs=opus', sticker: 'image/webp', 'product-catalog-image': 'image/jpeg' };
const MessageTypeProto = { image: WAProto.Message.ImageMessage, video: WAProto.Message.VideoMessage, audio: WAProto.Message.AudioMessage, sticker: WAProto.Message.StickerMessage, document: WAProto.Message.DocumentMessage };

// High-level content keys that need processing (not raw WAProto)
const HIGH_LEVEL_KEYS = ['text', 'image', 'video', 'audio', 'document', 'sticker', 'contacts', 'location', 'react', 'delete', 'forward', 'disappearingMessagesInChat', 'groupInvite', 'stickerPack', 'pin', 'buttonReply', 'ptv', 'product', 'listReply', 'event', 'poll', 'inviteAdmin', 'requestPayment', 'sharePhoneNumber', 'requestPhoneNumber', 'limitSharing', 'viewOnce', 'mentions', 'edit', 'buttons', 'templateButtons', 'sections', 'interactiveButtons', 'album', 'call', 'paymentInvite', 'order', 'keep', 'shop'];

// ===== UTILITIES =====
export const extractUrlFromText = (text) => text.match(URL_REGEX)?.[0];

export const generateLinkPreviewIfRequired = async (text, getUrlInfo, logger) => {
    const url = extractUrlFromText(text);
    if (!getUrlInfo || !url) return;
    try { return await getUrlInfo(url); }
    catch (e) { logger?.warn({ trace: e.stack }, 'url generation failed'); }
};

const assertColor = (color) => {
    if (typeof color === 'number') return color > 0 ? color : 0xffffffff + Number(color) + 1;
    let hex = color.trim().replace('#', '');
    return parseInt((hex.length <= 6 ? 'FF' + hex.padStart(6, '0') : hex), 16);
};

export const getContentType = (content) => {
    if (!content) return;
    const keys = Object.keys(content);
    return keys.find(k => (k === 'conversation' || k.includes('Message')) && k !== 'senderKeyDistributionMessage');
};

export const normalizeMessageContent = (content) => {
    if (!content) return;
    for (let i = 0; i < 5; i++) {
        const inner = content?.ephemeralMessage || content?.viewOnceMessage || content?.documentWithCaptionMessage || content?.viewOnceMessageV2 || content?.viewOnceMessageV2Extension || content?.editedMessage;
        if (!inner) break;
        content = inner.message;
    }
    return content;
};

export const extractMessageContent = (content) => {
    content = normalizeMessageContent(content);
    const extractTemplate = (msg) => msg.imageMessage ? { imageMessage: msg.imageMessage } : msg.documentMessage ? { documentMessage: msg.documentMessage } : msg.videoMessage ? { videoMessage: msg.videoMessage } : msg.locationMessage ? { locationMessage: msg.locationMessage } : { conversation: msg.contentText || msg.hydratedContentText || '' };
    return content?.buttonsMessage ? extractTemplate(content.buttonsMessage) : content?.templateMessage?.hydratedFourRowTemplate ? extractTemplate(content.templateMessage.hydratedFourRowTemplate) : content?.templateMessage?.hydratedTemplate ? extractTemplate(content.templateMessage.hydratedTemplate) : content?.templateMessage?.fourRowTemplate ? extractTemplate(content.templateMessage.fourRowTemplate) : content;
};

// ===== MEDIA PREPARATION =====
export const prepareWAMessageMedia = async (message, options) => {
    let mediaType = MEDIA_KEYS.find(key => key in message)
    if (!mediaType) throw new Boom('Invalid media type', { statusCode: 400 })

    const uploadData = { ...message, media: message[mediaType] }
    delete uploadData[mediaType]

    const cacheableKey = typeof uploadData.media === 'object' && 'url' in uploadData.media && uploadData.media.url && options.mediaCache ? `${mediaType}:${uploadData.media.url.toString()}` : null

    if (mediaType === 'document' && !uploadData.fileName) uploadData.fileName = 'file'
    if (!uploadData.mimetype) uploadData.mimetype = MIMETYPE_MAP[mediaType]

    if (cacheableKey) {
        const cached = await options.mediaCache?.get(cacheableKey)
        if (cached) {
            const obj = proto.Message.decode(cached)
            Object.assign(obj[`${mediaType}Message`], { ...uploadData, media: undefined })
            return obj
        }
    }

    const requiresDurationComputation = mediaType === 'audio' && typeof uploadData.seconds === 'undefined'
    const requiresThumbnailComputation = (mediaType === 'image' || mediaType === 'video') && typeof uploadData.jpegThumbnail === 'undefined'
    const requiresWaveformProcessing = mediaType === 'audio' && (uploadData.ptt === true || !!options.backgroundColor)
    const requiresOriginalForSomeProcessing = requiresDurationComputation || requiresThumbnailComputation

    const encryptionResult = await (options.newsletter ? prepareStream : encryptedStream)(uploadData.media, options.mediaTypeOverride || mediaType, {
        logger: options.logger,
        saveOriginalFileIfRequired: requiresOriginalForSomeProcessing,
        opts: options.options,
        isPtt: uploadData.ptt,
        forceOpus: mediaType === 'audio' && uploadData.mimetype && uploadData.mimetype.includes('opus'),
        convertVideo: mediaType === 'video'
    })

    // ✅ FIX: Extract the correct values based on encryption method
    const { mediaKey, encWriteStream, bodyPath, fileEncSha256, fileSha256, fileLength, didSaveToTmpPath, opusConverted, encFilePath } = encryptionResult

    if (mediaType === 'audio' && opusConverted) uploadData.mimetype = 'audio/ogg; codecs=opus'

    const fileEncSha256B64 = (options.newsletter ? fileSha256 : fileEncSha256 ?? fileSha256).toString('base64')

    // ✅ FIX: Determine what to upload - use encFilePath for encrypted, encWriteStream for newsletter
    const uploadStream = options.newsletter ? encWriteStream : (encFilePath || encWriteStream)

    const [{ mediaUrl, directPath, handle }] = await Promise.all([
        (async () => {
            const result = await options.upload(uploadStream, { fileEncSha256B64, mediaType, timeoutMs: options.mediaUploadTimeoutMs })
            options.logger?.debug({ mediaType, cacheableKey }, 'uploaded media')
            return result
        })(),
        (async () => {
            try {
                if (requiresThumbnailComputation) {
                    const { thumbnail, originalImageDimensions } = await generateThumbnail(bodyPath, mediaType, options)
                    uploadData.jpegThumbnail = thumbnail
                    if (!uploadData.width && originalImageDimensions) {
                        uploadData.width = originalImageDimensions.width
                        uploadData.height = originalImageDimensions.height
                    }
                }
                if (requiresDurationComputation) uploadData.seconds = await getAudioDuration(bodyPath)
                if (requiresWaveformProcessing) {
                    try {
                        uploadData.waveform = await getAudioWaveform(bodyPath, options.logger)
                    } catch (err) {
                        options.logger?.warn('Failed to generate waveform, using fallback')
                        uploadData.waveform = new Uint8Array([0, 99, 0, 99, 0, 99, 0, 99, 88, 99, 0, 99, 0, 55, 0, 99, 0, 99, 0, 99, 0, 99, 0, 99, 88, 99, 0, 99, 0, 55, 0, 99])
                    }
                }
                if (options.backgroundColor && mediaType === 'audio') uploadData.backgroundArgb = assertColor(options.backgroundColor)
            } catch (e) { options.logger?.warn({ trace: e.stack }, 'failed to obtain extra info') }
        })()
    ]).finally(async () => {
        if (encWriteStream && !Buffer.isBuffer(encWriteStream)) encWriteStream.destroy?.()
        // ✅ FIX: Clean up encrypted file path
        if (encFilePath && typeof encFilePath === 'string') {
            try {
                await fs.unlink(encFilePath)
            } catch { }
        }
        if (didSaveToTmpPath && bodyPath) {
            try {
                await fs.access(bodyPath)
                await fs.unlink(bodyPath)
            } catch { }
        }
    })

    const obj = WAProto.Message.fromObject({
        [`${mediaType}Message`]: MessageTypeProto[mediaType].fromObject({
            url: handle ? undefined : mediaUrl, directPath, mediaKey, fileEncSha256, fileSha256, fileLength,
            mediaKeyTimestamp: handle ? undefined : unixTimestampSeconds(), ...uploadData, media: undefined
        })
    })

    if (uploadData.ptv) { obj.ptvMessage = obj.videoMessage; delete obj.videoMessage }
    if (cacheableKey) await options.mediaCache?.set(cacheableKey, WAProto.Message.encode(obj).finish())
    return obj
}

export const prepareDisappearingMessageSettingContent = (ephemeralExpiration) => WAProto.Message.fromObject({
    ephemeralMessage: { message: { protocolMessage: { type: WAProto.Message.ProtocolMessage.Type.EPHEMERAL_SETTING, ephemeralExpiration: ephemeralExpiration || 0 } } }
});

export const generateForwardMessageContent = (message, forceForward) => {
    const content = proto.Message.decode(proto.Message.encode(normalizeMessageContent(message.message)).finish());
    let key = Object.keys(content)[0];
    let score = (content?.[key]?.contextInfo?.forwardingScore || 0) + (message.key.fromMe && !forceForward ? 0 : 1);

    if (key === 'conversation') {
        content.extendedTextMessage = { text: content[key] };
        delete content.conversation;
        key = 'extendedTextMessage';
    }

    content[key].contextInfo = score > 0 ? { forwardingScore: score, isForwarded: true } : {};
    return content;
};

// ===== MESSAGE HANDLERS =====
const handleTextMessage = async (message, options) => {
    const extContent = { text: message.text };
    let urlInfo = message.linkPreview || await generateLinkPreviewIfRequired(message.text, options.getUrlInfo, options.logger);

    if (urlInfo) {
        Object.assign(extContent, {
            matchedText: urlInfo['matched-text'], jpegThumbnail: urlInfo.jpegThumbnail,
            description: urlInfo.description, title: urlInfo.title, previewType: 0
        });
        if (urlInfo.highQualityThumbnail) {
            const img = urlInfo.highQualityThumbnail;
            Object.assign(extContent, {
                thumbnailDirectPath: img.directPath, mediaKey: img.mediaKey, mediaKeyTimestamp: img.mediaKeyTimestamp,
                thumbnailWidth: img.width, thumbnailHeight: img.height, thumbnailSha256: img.fileSha256, thumbnailEncSha256: img.fileEncSha256
            });
        }
    }

    if (options.backgroundColor) extContent.backgroundArgb = assertColor(options.backgroundColor);
    if (options.font) extContent.font = options.font;
    return { extendedTextMessage: extContent };
};

const handleSpecialMessages = async (message, options) => {
    if ('contacts' in message) {
        const { contacts } = message.contacts;
        if (!contacts.length) throw new Boom('require atleast 1 contact', { statusCode: 400 });
        return contacts.length === 1 ? { contactMessage: WAProto.Message.ContactMessage.create(contacts[0]) } : { contactsArrayMessage: WAProto.Message.ContactsArrayMessage.create(message.contacts) };
    }
    if ('location' in message) return { locationMessage: WAProto.Message.LocationMessage.create(message.location) };
    if ('react' in message) {
        if (!message.react.senderTimestampMs) message.react.senderTimestampMs = Date.now();
        return { reactionMessage: WAProto.Message.ReactionMessage.create(message.react) };
    }
    if ('delete' in message) return { protocolMessage: { key: message.delete, type: WAProto.Message.ProtocolMessage.Type.REVOKE } };
    if ('forward' in message) return generateForwardMessageContent(message.forward, message.force);
    if ('disappearingMessagesInChat' in message) {
        const exp = typeof message.disappearingMessagesInChat === 'boolean' ? (message.disappearingMessagesInChat ? WA_DEFAULT_EPHEMERAL : 0) : message.disappearingMessagesInChat;
        return prepareDisappearingMessageSettingContent(exp);
    }
    return null;
};

const handleGroupInvite = async (message, options) => {
    const m = {
        groupInviteMessage: {
            inviteCode: message.groupInvite.inviteCode, inviteExpiration: message.groupInvite.inviteExpiration,
            caption: message.groupInvite.text, groupJid: message.groupInvite.jid, groupName: message.groupInvite.subject
        }
    };

    if (options.getProfilePicUrl) {
        const pfpUrl = await options.getProfilePicUrl(message.groupInvite.jid, 'preview');
        if (pfpUrl) {
            const resp = await fetch(pfpUrl, { method: 'GET', dispatcher: options?.options?.dispatcher });
            if (resp.ok) m.groupInviteMessage.jpegThumbnail = Buffer.from(await resp.arrayBuffer());
        }
    }
    return m;
};

const handleEventMessage = (message, options) => {
    const startTime = Math.floor(message.event.startDate.getTime() / 1000);
    const m = {
        eventMessage: {
            name: message.event.name, description: message.event.description, startTime,
            endTime: message.event.endDate ? message.event.endDate.getTime() / 1000 : undefined,
            isCanceled: message.event.isCancelled ?? false, extraGuestsAllowed: message.event.extraGuestsAllowed,
            isScheduleCall: message.event.isScheduleCall ?? false, location: message.event.location
        },
        messageContextInfo: { messageSecret: message.event.messageSecret || randomBytes(32) }
    };

    if (message.event.call && options.getCallLink) {
        options.getCallLink(message.event.call, { startTime }).then(token => {
            m.eventMessage.joinLink = (message.event.call === 'audio' ? CALL_AUDIO_PREFIX : CALL_VIDEO_PREFIX) + token;
        });
    }
    return m;
};

const handlePollMessage = (message) => {
    message.poll.selectableCount ||= 0;
    message.poll.toAnnouncementGroup ||= false;

    if (!Array.isArray(message.poll.values)) throw new Boom('Invalid poll values', { statusCode: 400 });
    if (message.poll.selectableCount < 0 || message.poll.selectableCount > message.poll.values.length)
        throw new Boom(`poll.selectableCount should be >= 0 and <= ${message.poll.values.length}`, { statusCode: 400 });

    const pollMsg = { name: message.poll.name, selectableOptionsCount: message.poll.selectableCount, options: message.poll.values.map(optionName => ({ optionName })) };
    const m = { messageContextInfo: { messageSecret: message.poll.messageSecret || randomBytes(32) } };
    if (message.poll.toAnnouncementGroup) m.pollCreationMessageV2 = pollMsg;
    else if (message.poll.selectableCount === 1) m.pollCreationMessageV3 = pollMsg;
    else m.pollCreationMessage = pollMsg;
    return m;
};

const handleProductMessage = async (message, options) => {
    const { imageMessage } = await prepareWAMessageMedia({ image: message.product.productImage }, options);
    return { productMessage: WAProto.Message.ProductMessage.create({ ...message, product: { ...message.product, productImage: imageMessage } }) };
};

const handleRequestPayment = async (message, options) => {
    const sticker = message.requestPayment.sticker ? await prepareWAMessageMedia({ sticker: message.requestPayment.sticker }, options) : null;
    let notes = message.requestPayment.sticker
        ? { stickerMessage: { ...sticker.stickerMessage, contextInfo: message.requestPayment.contextInfo } }
        : message.requestPayment.note ? { extendedTextMessage: { text: message.requestPayment.note, contextInfo: message.requestPayment.contextInfo } } : null;

    if (!notes) throw new Boom('Invalid request payment', { statusCode: 400 });

    const m = {
        requestPaymentMessage: WAProto.Message.RequestPaymentMessage.fromObject({
            expiryTimestamp: message.requestPayment.expiryTimestamp || message.requestPayment.expiry,
            amount1000: message.requestPayment.amount1000 || message.requestPayment.amount,
            currencyCodeIso4217: message.requestPayment.currencyCodeIso4217 || message.requestPayment.currency,
            requestFrom: message.requestPayment.requestFrom || message.requestPayment.from,
            noteMessage: notes, background: message.requestPayment.background
        })
    };

    if (message.requestPayment.currencyCodeIso4217 === 'BRL' && message.requestPayment.pixKey) {
        if (!m.requestPaymentMessage.noteMessage.extendedTextMessage)
            m.requestPaymentMessage.noteMessage = { extendedTextMessage: { text: '' } };
        m.requestPaymentMessage.noteMessage.extendedTextMessage.text += `\nPix Key: ${message.requestPayment.pixKey}`;
    }

    return m;
};

// ===== MAIN GENERATOR =====
export const generateWAMessageContent = async (message, options = {}) => {
    const messageKeys = Object.keys(message);

    // ===== SMART DETECTION =====
    const isRawProtoMessage = messageKeys.some(key =>
        key.endsWith('Message') &&
        typeof message[key] === 'object' &&
        !HIGH_LEVEL_KEYS.includes(key)
    );

    const isWrapperMessage = ['viewOnceMessage', 'ephemeralMessage', 'viewOnceMessageV2', 'documentWithCaptionMessage'].some(k => k in message);

    // Pass through raw protocol messages directly
    if ((isRawProtoMessage || isWrapperMessage) && messageKeys.length === 1) {
        return WAProto.Message.create(message);
    }

    // If no high-level keys AND has proto message keys, pass through
    if (!messageKeys.some(k => HIGH_LEVEL_KEYS.includes(k)) && isRawProtoMessage) {
        return WAProto.Message.create(message);
    }

    let m = {};

    // ===== HANDLE TEXT =====
    if ('text' in message && !('buttons' in message) && !('templateButtons' in message) && !('sections' in message) && !('interactiveButtons' in message) && !('shop' in message)) {
        m = await handleTextMessage(message, options);
    }

    // ===== HANDLE SPECIAL MESSAGES =====
    else {
        const special = await handleSpecialMessages(message, options);
        if (special) m = special;
        else if ('groupInvite' in message) m = await handleGroupInvite(message, options);
        else if ('stickerPack' in message) return await prepareStickerPackMessage(message.stickerPack, options);
        else if ('pin' in message) {
            const messageKey = typeof message.pin === 'boolean' ? (options.quoted?.key || (() => { throw new Boom('No quoted message key found for pin operation'); })()) : (message.pin && typeof message.pin === 'object') ? (message.pin.key || message.pin.stanzaId || (message.pin.id ? { remoteJid: options.jid, fromMe: message.pin.fromMe || false, id: message.pin.id, participant: message.pin.participant || message.pin.sender } : null)) : message.pin;
            const shouldPin = typeof message.pin === 'boolean' ? message.pin : (message.pin && typeof message.pin === 'object' ? message.pin.unpin !== true : true);
            const pinTime = message.pin && typeof message.pin === 'object' ? message.pin.time : message.time;
            if (!messageKey || !messageKey.id) throw new Boom('Invalid message key for pin operation');
            m = { pinInChatMessage: { key: messageKey, type: shouldPin ? 1 : 2, senderTimestampMs: Date.now().toString() }, messageContextInfo: { messageAddOnDurationInSecs: shouldPin ? (pinTime || 86400) : 0 } };
        }
        else if ('keep' in message) m = { keepInChatMessage: { key: message.keep, keepType: message.type, timestampMs: Date.now() } };
        else if ('call' in message) m = { scheduledCallCreationMessage: { scheduledTimestampMs: message.call.time || Date.now(), callType: message.call.type || 1, title: message.call.title } };
        else if ('paymentInvite' in message) m = { paymentInviteMessage: { serviceType: message.paymentInvite.type, expiryTimestamp: message.paymentInvite.expiry } };
        else if ('buttonReply' in message) m = message.type === 'template' ? { templateButtonReplyMessage: { selectedDisplayText: message.buttonReply.displayText, selectedId: message.buttonReply.id, selectedIndex: message.buttonReply.index } } : { buttonsResponseMessage: { selectedButtonId: message.buttonReply.id, selectedDisplayText: message.buttonReply.displayText, type: 0 } };
        else if ('ptv' in message && message.ptv) {
            const { videoMessage } = await prepareWAMessageMedia({ video: message.video }, options);
            m = { ptvMessage: videoMessage };
        }
        else if ('product' in message) m = await handleProductMessage(message, options);
        else if ('order' in message) m = { orderMessage: WAProto.Message.OrderMessage.fromObject({ orderId: message.order.id, thumbnail: message.order.thumbnail, itemCount: message.order.itemCount, status: message.order.status, surface: message.order.surface, orderTitle: message.order.title, message: message.order.text, sellerJid: message.order.seller, token: message.order.token, totalAmount1000: message.order.amount, totalCurrencyCode: message.order.currency }) };
        else if ('listReply' in message) m = { listResponseMessage: { ...message.listReply } };
        else if ('event' in message) m = handleEventMessage(message, options);
        else if ('poll' in message) m = handlePollMessage(message);
        else if ('inviteAdmin' in message) m = { newsletterAdminInviteMessage: { inviteExpiration: message.inviteAdmin.inviteExpiration, caption: message.inviteAdmin.text, newsletterJid: message.inviteAdmin.jid, newsletterName: message.inviteAdmin.subject, jpegThumbnail: message.inviteAdmin.thumbnail } };
        else if ('requestPayment' in message) m = await handleRequestPayment(message, options);
        else if ('extendedTextMessage' in message) m = { extendedTextMessage: WAProto.Message.ExtendedTextMessage.create(message.extendedTextMessage) };
        else if ('interactiveMessage' in message) m = { interactiveMessage: WAProto.Message.InteractiveMessage.create(message.interactiveMessage) };
        else if ('sharePhoneNumber' in message) m = { protocolMessage: { type: 4 } };
        else if ('requestPhoneNumber' in message) m = { requestPhoneNumberMessage: {} };
        else if ('limitSharing' in message) m = { protocolMessage: { type: 3, limitSharing: { sharingLimited: message.limitSharing === true, trigger: 1, limitSharingSettingTimestamp: Date.now(), initiatedByMe: true } } };
        else if ('album' in message) {
            const imageMessages = message.album.filter(item => 'image' in item);
            const videoMessages = message.album.filter(item => 'video' in item);
            m = { albumMessage: { expectedImageCount: imageMessages.length, expectedVideoCount: videoMessages.length } };
        }
        else if (MEDIA_KEYS.some(k => k in message)) m = await prepareWAMessageMedia(message, options);
    }

    // ===== SMART BUTTON HANDLING =====
    if ('buttons' in message && Array.isArray(message.buttons) && message.buttons.length > 0) {
        const hasNativeFlow = message.buttons.some(b => b.nativeFlowInfo || b.name || b.buttonParamsJson);

        if (hasNativeFlow) {
            // Convert to interactiveMessage
            const interactive = {
                body: { text: message.text || message.caption || message.contentText || '' },
                footer: { text: message.footer || message.footerText || '' },
                nativeFlowMessage: {
                    buttons: message.buttons.map(btn => {
                        if (btn.name && btn.buttonParamsJson) return btn;
                        if (btn.nativeFlowInfo) return { name: btn.nativeFlowInfo.name, buttonParamsJson: btn.nativeFlowInfo.paramsJson };
                        return { name: 'quick_reply', buttonParamsJson: JSON.stringify({ display_text: btn.buttonText?.displayText || btn.displayText || '', id: btn.buttonId || btn.id || '' }) };
                    })
                }
            };

            if (message.title) interactive.header = { title: message.title, subtitle: message.subtitle, hasMediaAttachment: message.hasMediaAttachment || false };
            if (Object.keys(m).length > 0) {
                interactive.header = interactive.header || { title: message.title || '', hasMediaAttachment: true };
                Object.assign(interactive.header, m);
            }

            m = { interactiveMessage: interactive };
        } else {
            // Old-style buttons
            const buttonsMessage = { buttons: message.buttons.map(b => ({ ...b, type: proto.Message.ButtonsMessage.Button.Type.RESPONSE })) };
            if ('text' in message) { buttonsMessage.contentText = message.text; buttonsMessage.headerType = proto.Message.ButtonsMessage.HeaderType.EMPTY; }
            else { if ('caption' in message) buttonsMessage.contentText = message.caption; const type = Object.keys(m)[0]?.replace('Message', '').toUpperCase(); buttonsMessage.headerType = proto.Message.ButtonsMessage.HeaderType[type] || proto.Message.ButtonsMessage.HeaderType.EMPTY; Object.assign(buttonsMessage, m); }
            if (message.title) { buttonsMessage.text = message.title; buttonsMessage.headerType = proto.Message.ButtonsMessage.HeaderType.TEXT; }
            if (message.footer) buttonsMessage.footerText = message.footer;
            m = { buttonsMessage };
        }
    }

    // ===== TEMPLATE BUTTONS =====
    else if ('templateButtons' in message && !!message.templateButtons) {
        const msg = { hydratedButtons: message.templateButtons };
        if ('text' in message) msg.hydratedContentText = message.text;
        else { if ('caption' in message) msg.hydratedContentText = message.caption; Object.assign(msg, m); }
        if ('footer' in message && !!message.footer) msg.hydratedFooterText = message.footer;
        m = { templateMessage: { fourRowTemplate: msg, hydratedTemplate: msg } };
    }

    // ===== LIST MESSAGE =====
    else if ('sections' in message && !!message.sections) {
        m = { listMessage: { sections: message.sections, buttonText: message.buttonText, title: message.title, footerText: message.footer, description: message.text, listType: proto.Message.ListMessage.ListType.SINGLE_SELECT } };
    }

    // ===== INTERACTIVE BUTTONS =====
    else if ('interactiveButtons' in message && !!message.interactiveButtons) {
        const interactiveMessage = { nativeFlowMessage: WAProto.Message.InteractiveMessage.NativeFlowMessage.fromObject({ buttons: message.interactiveButtons }) };
        if ('text' in message) interactiveMessage.body = { text: message.text };
        else if ('caption' in message) { interactiveMessage.body = { text: message.caption }; interactiveMessage.header = { title: message.title, subtitle: message.subtitle, hasMediaAttachment: message?.media ?? false }; Object.assign(interactiveMessage.header, m); }
        if ('footer' in message && !!message.footer) interactiveMessage.footer = { text: message.footer };
        if ('title' in message && !!message.title) { interactiveMessage.header = { title: message.title, subtitle: message.subtitle, hasMediaAttachment: message?.media ?? false }; Object.assign(interactiveMessage.header, m); }
        m = { interactiveMessage };
    }

    // ===== SHOP MESSAGE (YOUR EXAMPLE) =====
    else if ('shop' in message && !!message.shop) {
        const interactiveMessage = {
            shopStorefrontMessage: WAProto.Message.InteractiveMessage.ShopMessage.fromObject({
                surface: message.shop.surface || 1,
                id: message.shop.id || message.id
            })
        };

        // Handle body text
        if ('text' in message) interactiveMessage.body = { text: message.text };
        else if ('caption' in message) interactiveMessage.body = { text: message.caption };

        // Handle header with media
        if (message.title || message.subtitle || Object.keys(m).length > 0) {
            interactiveMessage.header = {
                title: message.title || '',
                subtitle: message.subtitle || '',
                hasMediaAttachment: message.hasMediaAttachment ?? (Object.keys(m).length > 0)
            };
            if (Object.keys(m).length > 0) Object.assign(interactiveMessage.header, m);
        }

        if ('footer' in message && !!message.footer) interactiveMessage.footer = { text: message.footer };

        m = { interactiveMessage };
    }

    // ===== AUTO-APPLY CONTEXT & WRAPPERS =====
    const finalKey = Object.keys(m)[0];

    // Auto-merge contextInfo and mentions
    if ((message.contextInfo || message.mentions) && finalKey && m[finalKey]) {
        m[finalKey].contextInfo = {
            ...(m[finalKey].contextInfo || {}),
            ...(message.contextInfo || {}),
            mentionedJid: message.mentions || message.contextInfo?.mentionedJid || []
        };
    }

    // ViewOnce wrapper
    if (message.viewOnce === true) m = { viewOnceMessage: { message: m } };

    // Edit wrapper
    if (message.edit) m = { protocolMessage: { key: message.edit, editedMessage: m, timestampMs: Date.now(), type: WAProto.Message.ProtocolMessage.Type.MESSAGE_EDIT } };

    return WAProto.Message.create(m);
};


export const generateWAMessageFromContent = (jid, message, options) => {
    if (!options.timestamp) options.timestamp = new Date();
    const innerMessage = normalizeMessageContent(message);
    const key = getContentType(innerMessage);
    const timestamp = unixTimestampSeconds(options.timestamp);
    const { quoted, userJid } = options;

    if (quoted && !isJidNewsletter(jid)) {
        const participant = quoted.key.fromMe ? userJid : quoted.participant || quoted.key.participant || quoted.key.remoteJid;
        const quotedMsg = proto.Message.create({ [getContentType(normalizeMessageContent(quoted.message))]: normalizeMessageContent(quoted.message)[getContentType(normalizeMessageContent(quoted.message))] });
        const contextInfo = (innerMessage[key]?.contextInfo) || {};
        contextInfo.participant = jidNormalizedUser(participant);
        contextInfo.stanzaId = quoted.key.id;
        contextInfo.quotedMessage = quotedMsg;
        if (jid !== quoted.key.remoteJid) contextInfo.remoteJid = quoted.key.remoteJid;
        innerMessage[key].contextInfo = contextInfo;
    }

    if (options?.ephemeralExpiration && key !== 'protocolMessage' && key !== 'ephemeralMessage' && !isJidNewsletter(jid)) {
        innerMessage[key].contextInfo = { ...(innerMessage[key].contextInfo || {}), expiration: options.ephemeralExpiration || WA_DEFAULT_EPHEMERAL };
    }

    return WAProto.WebMessageInfo.fromObject({
        key: { remoteJid: jid, fromMe: true, id: options?.messageId || generateMessageIDV2(), participant: (isJidGroup(jid) || isJidStatusBroadcast(jid)) ? userJid : undefined },
        message: WAProto.Message.create(message),
        messageTimestamp: timestamp,
        messageStubParameters: [],
        participant: isJidGroup(jid) || isJidStatusBroadcast(jid) ? userJid : undefined,
        status: WAMessageStatus.PENDING
    });
};

export const generateWAMessage = async (jid, content, options = {}) => {
    options.logger = options?.logger?.child({ msgId: options.messageId });
    return generateWAMessageFromContent(jid, await generateWAMessageContent(content, { ...options, jid }), options);
};

// ===== UTILITIES =====
export const getDevice = (id) => /^3A.{18}$/.test(id) ? 'ios' : /^3E.{20}$/.test(id) ? 'web' : /^(.{21}|.{32})$/.test(id) ? 'android' : /^(3F|.{18}$)/.test(id) ? 'desktop' : 'unknown';

export const updateMessageWithReceipt = (msg, receipt) => {
    msg.userReceipt ||= [];
    const recp = msg.userReceipt.find(m => m.userJid === receipt.userJid);
    if (recp) Object.assign(recp, receipt);
    else msg.userReceipt.push(receipt);
};

export const updateMessageWithReaction = (msg, reaction) => {
    const authorID = getKeyAuthor(reaction.key);
    msg.reactions = (msg.reactions || []).filter(r => getKeyAuthor(r.key) !== authorID);
    reaction.text ||= '';
    msg.reactions.push(reaction);
};

export const updateMessageWithPollUpdate = (msg, update) => {
    const authorID = getKeyAuthor(update.pollUpdateMessageKey);
    msg.pollUpdates = (msg.pollUpdates || []).filter(r => getKeyAuthor(r.pollUpdateMessageKey) !== authorID);
    if (update.vote?.selectedOptions?.length) msg.pollUpdates.push(update);
};

export function getAggregateVotesInPollMessage({ message, pollUpdates }, meId) {
    const opts = message?.pollCreationMessage?.options || message?.pollCreationMessageV2?.options || message?.pollCreationMessageV3?.options || [];
    const voteHashMap = opts.reduce((acc, opt) => {
        const hash = sha256(Buffer.from(opt.optionName || '')).toString();
        acc[hash] = { name: opt.optionName || '', voters: [] };
        return acc;
    }, {});

    for (const update of pollUpdates || []) {
        const { vote } = update;
        if (!vote) continue;
        for (const option of vote.selectedOptions || []) {
            const hash = option.toString();
            voteHashMap[hash] ||= { name: 'Unknown', voters: [] };
            voteHashMap[hash].voters.push(getKeyAuthor(update.pollUpdateMessageKey, meId));
        }
    }
    return Object.values(voteHashMap);
}

export const aggregateMessageKeysNotFromMe = (keys) => {
    const keyMap = {};
    for (const { remoteJid, id, participant, fromMe } of keys) {
        if (!fromMe) {
            const uqKey = `${remoteJid}:${participant || ''}`;
            keyMap[uqKey] ||= { jid: remoteJid, participant, messageIds: [] };
            keyMap[uqKey].messageIds.push(id);
        }
    }
    return Object.values(keyMap);
};

const REUPLOAD_STATUS = [410, 404];

export const downloadMediaMessage = async (message, type, options, ctx) => {
    const downloadMsg = async () => {
        let normalizedMessage = message;
        if (!message.message && message.key && message.participant) normalizedMessage = { key: message.key, message: message, messageTimestamp: message.messageTimestamp };
        if (!normalizedMessage.message && typeof message === 'object') {
            const possibleMessage = message.message || message.quoted?.message || message;
            normalizedMessage = { key: message.key || {}, message: possibleMessage, messageTimestamp: message.messageTimestamp };
        }
        const mContent = extractMessageContent(normalizedMessage.message);
        if (!mContent) throw new Boom('No message present', { statusCode: 400, data: message });
        const contentType = getContentType(mContent);
        let mediaType = contentType?.replace('Message', '');
        const media = mContent[contentType];
        if (!media || typeof media !== 'object' || (!('url' in media) && !('thumbnailDirectPath' in media)))
            throw new Boom(`"${contentType}" is not a media message`);
        const download = 'thumbnailDirectPath' in media && !('url' in media) ? { directPath: media.thumbnailDirectPath, mediaKey: media.mediaKey } : media;
        const stream = await downloadContentFromMessage(download, mediaType, options);
        if (type === 'buffer') {
            const chunks = [];
            for await (const chunk of stream) chunks.push(chunk);
            return Buffer.concat(chunks);
        }
        return stream;
    };
    return downloadMsg().catch(async (error) => {
        if (ctx && typeof error?.status === 'number' && REUPLOAD_STATUS.includes(error.status)) {
            message = await ctx.reuploadRequest(message);
            return downloadMsg();
        }
        throw error;
    });
};

export async function prepareStickerPackMessage(stickerPack, options) {
    const { stickers, name, publisher, packId, description } = stickerPack;
    if (!stickers?.length) throw new Boom('Sticker pack requires at least one sticker', { statusCode: 400 });

    const lib = await getImageProcessingLibrary();
    const packId_ = packId || generateMessageIDV2();
    const validStickers = [];

    for (const s of stickers) {
        try {
            const { stream } = await getStream(s.data);
            let buffer = await toBuffer(stream);
            const isWebP = buffer.length >= 12 && buffer[0] === 0x52 && buffer[1] === 0x49 && buffer[2] === 0x46 && buffer[3] === 0x46;
            if (!isWebP) {
                if ('sharp' in lib) buffer = await lib.sharp.default(buffer).webp().toBuffer();
                else if ('jimp' in lib) buffer = await lib.jimp.Jimp.read(buffer).then(img => img.getBuffer('image/webp'));
            }
            if (buffer.length > 1024 * 1024) {
                if ('sharp' in lib) buffer = await lib.sharp.default(buffer).webp({ quality: 50 }).toBuffer();
                if (buffer.length > 1024 * 1024) continue;
            }
            validStickers.push({
                fileName: `${sha256(buffer).toString('base64').replace(/\//g, '-')}.webp`,
                buffer, mimetype: 'image/webp', isAnimated: s.isAnimated || false,
                emojis: s.emojis || [], accessibilityLabel: s.accessibilityLabel
            });
        } catch (e) { options.logger?.warn(`Sticker failed: ${e.message}`); }
    }

    if (!validStickers.length) throw new Boom('No valid stickers', { statusCode: 400 });

    const { stream: covStream } = await getStream(stickerPack.cover);
    let coverBuffer = await toBuffer(covStream);
    const isWebPCover = coverBuffer.length >= 12 && coverBuffer[0] === 0x52 && coverBuffer[1] === 0x49 && coverBuffer[2] === 0x46 && coverBuffer[3] === 0x46;
    if (!isWebPCover) {
        if ('sharp' in lib) coverBuffer = await lib.sharp.default(coverBuffer).webp().toBuffer();
        else if ('jimp' in lib) coverBuffer = await lib.jimp.Jimp.read(coverBuffer).then(img => img.getBuffer('image/webp'));
    }

    const processBatch = async (batch, batchIdx) => {
        const batchData = {};
        batch.forEach(s => { batchData[s.fileName] = [new Uint8Array(s.buffer), { level: 0 }]; });
        const trayFile = `${packId_}_batch${batchIdx}.webp`;
        batchData[trayFile] = [new Uint8Array(coverBuffer), { level: 0 }];

        const zipBuf = await new Promise((resolve, reject) => { zip(batchData, (err, data) => err ? reject(err) : resolve(Buffer.from(data))); });
        const upload = await encryptedStream(zipBuf, 'sticker-pack', { logger: options.logger, opts: options.options });
        const uploadRes = await options.upload(upload.encFilePath, {
            fileEncSha256B64: upload.fileEncSha256.toString('base64'), mediaType: 'sticker-pack', timeoutMs: options.mediaUploadTimeoutMs
        });
        await fs.unlink(upload.encFilePath);

        let thumbBuf;
        if ('sharp' in lib) thumbBuf = await lib.sharp.default(coverBuffer).resize(252, 252).jpeg().toBuffer();
        else if ('jimp' in lib) thumbBuf = await lib.jimp.Jimp.read(coverBuffer).then(img => img.resize({ w: 252, h: 252 }).getBuffer('image/jpeg'));

        let thumbUploadRes;
        if (thumbBuf?.length) {
            const thumbUpload = await encryptedStream(thumbBuf, 'thumbnail-sticker-pack', { logger: options.logger, opts: options.options, mediaKey: upload.mediaKey });
            thumbUploadRes = await options.upload(thumbUpload.encFilePath, {
                fileEncSha256B64: thumbUpload.fileEncSha256.toString('base64'), mediaType: 'thumbnail-sticker-pack', timeoutMs: options.mediaUploadTimeoutMs
            });
            await fs.unlink(thumbUpload.encFilePath);
        }

        return {
            name: `${name} (${batchIdx + 1})`, publisher, packDescription: description, stickerPackId: `${packId_}_${batchIdx}`,
            stickerPackOrigin: WAProto.Message.StickerPackMessage.StickerPackOrigin.USER_CREATED, stickerPackSize: zipBuf.length,
            stickers: batch.map(s => ({ fileName: s.fileName, mimetype: s.mimetype, isAnimated: s.isAnimated, emojis: s.emojis, accessibilityLabel: s.accessibilityLabel })),
            fileSha256: upload.fileSha256, fileEncSha256: upload.fileEncSha256, mediaKey: upload.mediaKey,
            directPath: uploadRes.directPath, fileLength: upload.fileLength, mediaKeyTimestamp: unixTimestampSeconds(), trayIconFileName: trayFile,
            ...(thumbUploadRes && { thumbnailDirectPath: thumbUploadRes.directPath, thumbnailHeight: 252, thumbnailWidth: 252, imageDataHash: thumbBuf ? sha256(thumbBuf).toString('base64') : undefined })
        };
    };

    if (validStickers.length > 60) {
        const batches = [];
        for (let i = 0; i < validStickers.length; i += 60) batches.push(validStickers.slice(i, i + 60));
        const batchResults = await Promise.all(batches.map((b, i) => processBatch(b, i)));
        return { stickerPackMessage: batchResults, isBatched: true, batchCount: batches.length };
    }

    return { stickerPackMessage: await processBatch(validStickers, 0), isBatched: false };
}

export const assertMediaContent = (content) => {
    content = extractMessageContent(content);
    const mediaContent = content?.documentMessage || content?.imageMessage || content?.videoMessage || content?.audioMessage || content?.stickerMessage;
    if (!mediaContent) throw new Boom('given message is not a media message', { statusCode: 400, data: content });
    return mediaContent;
};