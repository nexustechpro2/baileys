import { createHash } from 'crypto';
import { createRequire } from 'module';
import { proto } from '../../WAProto/index.js';
import { makeLibSignalRepository } from '../Signal/libsignal.js';
import { Browsers } from '../Utils/browser-utils.js';
import logger from '../Utils/logger.js';
import urlRegexSafe from 'url-regex-safe';
const require = createRequire(import.meta.url);
const PHONENUMBER_MCC = require('./phonenumber-mcc.json');
export { PHONENUMBER_MCC };
const version = [2, 3000, 1040069233];

export const UNAUTHORIZED_CODES = [401, 403, 419];

export const DEFAULT_ORIGIN = 'https://web.whatsapp.com';
export const CALL_VIDEO_PREFIX = 'https://call.whatsapp.com/video/';
export const CALL_AUDIO_PREFIX = 'https://call.whatsapp.com/voice/';
export const DEF_CALLBACK_PREFIX = 'CB:';
export const DEF_TAG_PREFIX = 'TAG:';
export const PHONE_CONNECTION_CB = 'CB:Pong';

export const WA_ADV_ACCOUNT_SIG_PREFIX = Buffer.from([6, 0]);
export const WA_ADV_DEVICE_SIG_PREFIX = Buffer.from([6, 1]);
export const WA_ADV_HOSTED_ACCOUNT_SIG_PREFIX = Buffer.from([6, 5]);
export const WA_ADV_HOSTED_DEVICE_SIG_PREFIX = Buffer.from([6, 6]);

export const WA_DEFAULT_EPHEMERAL = 7 * 24 * 60 * 60;

export const STATUS_EXPIRY_SECONDS = 24 * 60 * 60;

export const PLACEHOLDER_MAX_AGE_SECONDS = 14 * 24 * 60 * 60;

export const BATCH_SIZE = 500;

export const NOISE_MODE = 'Noise_XX_25519_AESGCM_SHA256\0\0\0\0';
export const DICT_VERSION = 3;
export const KEY_BUNDLE_TYPE = Buffer.from([5]);
export const NOISE_WA_HEADER = Buffer.from([87, 65, 6, DICT_VERSION]);

export const URL_REGEX = urlRegexSafe({ strict: true, re2: false });
export const WA_CERT_DETAILS = {
    SERIAL: 0,
    ISSUER: 'WhatsAppLongTerm1',
    PUBLIC_KEY: Buffer.from('142375574d0a587166aae71ebe516437c4a28b73e3695c6ce1f7f9545da8ee6b', 'hex')
};

export const PROCESSABLE_HISTORY_TYPES = [
    proto.HistorySync.HistorySyncType.INITIAL_BOOTSTRAP,
    proto.HistorySync.HistorySyncType.PUSH_NAME,
    proto.HistorySync.HistorySyncType.RECENT,
    proto.HistorySync.HistorySyncType.FULL,
    proto.HistorySync.HistorySyncType.ON_DEMAND,
    proto.HistorySync.HistorySyncType.NON_BLOCKING_DATA,
    proto.HistorySync.HistorySyncType.INITIAL_STATUS_V3
];
export const MOBILE_ENDPOINT = 'g.whatsapp.net';
export const MOBILE_PORT = 443;
export const WA_VERSION = '2.2413.51'
export const WA_VERSION_HASH = createHash('md5').update(WA_VERSION).digest('hex');
export const MOBILE_TOKEN = Buffer.from('0a1mLfGUIBVrMKF1RdvLI5lkRBvof6vn0fD2QRSM' + WA_VERSION_HASH);
export const MOBILE_REGISTRATION_ENDPOINT = 'https://v.whatsapp.net/v2';
export const MOBILE_USERAGENT = `WhatsApp/${WA_VERSION} iOS/17.5.1 Device/Apple-iPhone_13`;
export const GRAPHQL_ENDPOINT = 'https://graph.whatsapp.com/graphql'
export const GRAPHQL_ACCESS_TOKEN = 'WA|1015890928915437|3201f239340c1c8ec6262a6dad04200e'
export const GRAPHQL_BAN_STATUS_DOC_ID = '25573756098908502'
export const REGISTRATION_PUBLIC_KEY = Buffer.from([
    5, 142, 140, 15, 116, 195, 235, 197, 215, 166, 134, 92, 108, 60, 132, 56, 86, 176, 97, 33, 204, 232, 234, 119, 77,
    34, 251, 111, 18, 37, 18, 48, 45,
]);


export const PROTOCOL_VERSION = [5, 2];
export const MOBILE_NOISE_HEADER = Buffer.concat([Buffer.from('WA'), Buffer.from(PROTOCOL_VERSION)]);


export const DEFAULT_CONNECTION_CONFIG = {
    version,
    browser: Browsers.macOS('Safari'),
    waWebSocketUrl: 'wss://web.whatsapp.com/ws/chat',
    connectTimeoutMs: 600000,
    keepAliveIntervalMs: 30000,
    logger: logger.child({ class: 'baileys' }),
    emitOwnEvents: true,
    defaultQueryTimeoutMs: 60000,
    customUploadHosts: [],
    retryRequestDelayMs: 250,
    maxMsgRetryCount: 5,
    fireInitQueries: true,
    auth: undefined,
    markOnlineOnConnect: true,
    syncFullHistory: true,
    patchMessageBeforeSending: msg => msg,
    shouldSyncHistoryMessage: ({ syncType }) => {
        return syncType !== proto.HistorySync.HistorySyncType.FULL;
    },
    shouldIgnoreJid: () => false,
    linkPreviewImageThumbnailWidth: 192,
    transactionOpts: { maxCommitRetries: 10, delayBetweenTriesMs: 3000 },
    generateHighQualityLinkPreview: false,
    enableAutoSessionRecreation: true,
    enableRecentMessageCache: true,
    options: {},
    appStateMacVerification: {
        patch: false,
        snapshot: false
    },
    countryCode: 'US',
    getMessage: async () => undefined,
    cachedGroupMetadata: async () => undefined,
    makeSignalRepository: makeLibSignalRepository
};

export const MEDIA_PATH_MAP = {
    image: '/mms/image',
    video: '/mms/video',
    document: '/mms/document',
    audio: '/mms/audio',
    sticker: '/mms/image',
    'sticker-pack': '/mms/sticker-pack',
    'thumbnail-link': '/mms/image',
    'thumbnail-sticker-pack': '/mms/thumbnail-sticker-pack',
    'product-catalog-image': '/product/image',
    'md-app-state': '',
    'md-msg-hist': '/mms/md-app-state',
    'biz-cover-photo': '/pps/biz-cover-photo'
};

export const PRIVACY_MEX_IDS = {
    GET_SETTINGS: '32774292262215380',
    SET_SETTING: '26887749497493184',
    UPDATE_CONTACT_LIST: '26375158178762800',
    GET_CONTACT_LIST: '25700444246275824',
    UPDATE_TEXT_STATUS: '25863197129975892',
    GET_TEXT_STATUS_LIST: '25741205615468936',
    UPDATE_USER_STATUS: '7452341274886724',
    FETCH_USER_PICTURE: '24983561624604410',
    PROFILE_PICTURE_MUT: '24714239711610700',
    ACCOUNT_LOGIN: '27298465499757130',
    ACCOUNT_LOGOUT: '26863447609979190',
    MULTI_ACCOUNT_REVOKE: '25846242091639660',
    ADD_MULTI_ACCOUNT: '25502812266025190',
    ADD_TRUSTED_DEVICE: '24522952587403290',
    GET_TRUSTED_DEVICES: '25123358920671964',
    UNTRUST_DEVICE: '26574930682133620',
    DELETE_TRUSTED_DEVICE: '33867503889559536',
    MOBILE_CONFIG_FETCH: '25676911271914596',
    NOTIFY_PUSH_NAME: '25900490552974544',
    CONTACT_INTEGRITY: '25924358997169496',
    BIZ_INTEGRITY: '25975613018777536',
    LINKED_PROFILES_SET: '25013968611531010',
    LINKED_PROFILES_REMOVE: '24537675509265524',
    LINKED_PROFILES_UPDATE: '24876967165297616',
    MIGRATE_BLOCKLIST_LID: '25028600226770430',
    QR_CODE_SCAN: '26287165600869744'
}

export const USERNAME_QUERY_IDS = {
    CHECK: '26124072630599518',
    CHECK_MULTI: '27134626522840286',
    SET: '27108705368767936',
    GET: '32618050064506055',
    GET_RECOMMENDATIONS: '26077456248616957',
    PIN_SET: '25529696019976770'
}

export const USERNAME_CHECK_RESULT = {
    SUCCESS: 'SUCCESS',
    INVALID: 'INVALID'
}

export const USERNAME_SOURCE = {
    FB: 'FB',
    IG: 'IG',
    USER_INPUT: 'USER_INPUT',
    SUGGESTION: 'SUGGESTION'
}

export const MEDIA_HKDF_KEY_MAPPING = {
    audio: 'Audio',
    document: 'Document',
    gif: 'Video',
    image: 'Image',
    ppic: '',
    product: 'Image',
    ptt: 'Audio',
    'sticker-pack-publisher': 'Sticker Pack Publisher',
    sticker: 'Image',
    'sticker-pack': 'Sticker Pack',
    'thumbnail-sticker-pack': 'Sticker Pack Thumbnail',
    video: 'Video',
    'thumbnail-document': 'Document Thumbnail',
    'thumbnail-image': 'Image Thumbnail',
    'thumbnail-video': 'Video Thumbnail',
    'thumbnail-link': 'Link Thumbnail',
    'md-msg-hist': 'History',
    'md-app-state': 'App State',
    'product-catalog-image': '',
    'payment-bg-image': 'Payment Background',
    ptv: 'Video',
    'biz-cover-photo': 'Image'
};

export const MEDIA_KEYS = Object.keys(MEDIA_PATH_MAP);
export const MIN_PREKEY_COUNT = 5;
export const INITIAL_PREKEY_COUNT = 95;
export const UPLOAD_TIMEOUT = 30000;
export const MIN_UPLOAD_INTERVAL = 5000;
export const HISTORY_SYNC_PAUSED_TIMEOUT_MS = 120000;
export const DEFAULT_CACHE_TTLS = {
    SIGNAL_STORE: 5 * 60,
    MSG_RETRY: 60 * 60,
    CALL_OFFER: 5 * 60,
    USER_DEVICES: 5 * 60
};

export const TimeMs = {
    Minute: 60 * 1000,
    Hour: 60 * 60 * 1000,
    Day: 24 * 60 * 60 * 1000,
    Week: 7 * 24 * 60 * 60 * 1000
};