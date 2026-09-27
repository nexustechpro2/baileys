import { randomBytes } from 'crypto';
import { getBinaryNodeChild, getBinaryNodeChildren, isHostedLidUser, isHostedPnUser, isJidMetaAI, isLidUser, isPnUser, jidNormalizedUser } from '../WABinary/index.js';
import { unixTimestampSeconds } from './generics.js';
import { TC_TOKEN_INDEX_KEY } from './key-store.js';

const BOT_PHONE_REGEX = /^1313555\d{4}$|^131655500\d{2}$/;
const TC_TOKEN_BUCKET_DURATION = 604800; // 7 days in seconds
const TC_TOKEN_NUM_BUCKETS = 4;      // ~28-day rolling window

const currentBucket = () => Math.floor(Math.floor(Date.now() / 1000) / TC_TOKEN_BUCKET_DURATION);
const generateTcToken = () => Buffer.concat([Buffer.from([0x04, 0x01, (Math.floor(unixTimestampSeconds() / TC_TOKEN_BUCKET_DURATION) - 2900) & 0xff]), randomBytes(8)]);

export const isRegularUser = jid => {
    if (!jid) return false;
    const user = jid.split('@')[0] ?? '';
    if (user === '0' || BOT_PHONE_REGEX.test(user) || isJidMetaAI(jid)) return false;
    return !!(isPnUser(jid) || isLidUser(jid) || isHostedPnUser(jid) || isHostedLidUser(jid) || jid.endsWith('@c.us'));
};

export const isTcTokenExpired = timestamp => {
    if (timestamp == null) return true;
    const ts = typeof timestamp === 'string' ? parseInt(timestamp) : timestamp;
    return isNaN(ts) || ts < (currentBucket() - (TC_TOKEN_NUM_BUCKETS - 1)) * TC_TOKEN_BUCKET_DURATION;
};

export const shouldSendNewTcToken = senderTimestamp => {
    if (senderTimestamp === undefined) return true;
    return currentBucket() > Math.floor(senderTimestamp / TC_TOKEN_BUCKET_DURATION);
};

export const resolveTcTokenJid = async (jid, getLIDForPN) => isLidUser(jid) ? jid : (await getLIDForPN(jid) || null);

export const resolveIssuanceJid = async (jid, issueToLid, getLIDForPN, getPNForLID) => {
    if (issueToLid) return isLidUser(jid) ? jid : (await getLIDForPN(jid)) ?? jid;
    if (!isLidUser(jid)) return jid;
    return getPNForLID ? (await getPNForLID(jid)) ?? jid : jid;
};

export const readTcTokenIndex = async keys => {
    for (const key of [TC_TOKEN_INDEX_KEY, 'index']) {
        const entry = (await keys.get('tctoken', [key]))[key];
        if (!entry?.token?.length) continue;
        try {
            const parsed = JSON.parse(Buffer.from(entry.token).toString());
            if (!Array.isArray(parsed)) continue;
            return parsed.filter(j => typeof j === 'string' && j.length > 0 && j !== TC_TOKEN_INDEX_KEY && j !== 'index');
        } catch { continue; }
    }
    return [];
};

export const buildMergedTcTokenIndexWrite = async (keys, addedJids) => {
    const merged = new Set(await readTcTokenIndex(keys));
    for (const jid of addedJids) if (jid && jid !== TC_TOKEN_INDEX_KEY && jid !== 'index') merged.add(jid);
    return { [TC_TOKEN_INDEX_KEY]: { token: Buffer.from(JSON.stringify([...merged])) } };
};

export const preSeedTcToken = async ({ authState, jid, getLIDForPN, logger }) => {
    const tcTokenJid = await resolveTcTokenJid(jid, getLIDForPN);
    const existing = await authState.keys.get('tctoken', [tcTokenJid]);
    if (existing[tcTokenJid]?.token?.length) return { token: existing[tcTokenJid].token, storageJid: tcTokenJid };
    const token = generateTcToken();
    const timestamp = String(unixTimestampSeconds());
    const indexWrite = await buildMergedTcTokenIndexWrite(authState.keys, [tcTokenJid]);
    await authState.keys.set({ tctoken: { [tcTokenJid]: { ...(existing[tcTokenJid] || {}), token, timestamp }, ...indexWrite } });
    logger?.debug({ jid, tcTokenJid }, 'pre-seeded locally generated tctoken');
    return { token, storageJid: tcTokenJid };
};

export const buildTcTokenFromJid = async ({ authState, jid, baseContent = [], getLIDForPN }) => {
    try {
        const storageJid = await resolveTcTokenJid(jid, getLIDForPN);
        const entry = (await authState.keys.get('tctoken', [storageJid]))?.[storageJid];
        const { token: tcTokenBuffer, timestamp, senderTimestamp } = entry ?? {};
        if (!tcTokenBuffer?.length || timestamp === undefined || isTcTokenExpired(timestamp)) {
            if (tcTokenBuffer) {
                const cleared = senderTimestamp !== undefined ? { token: Buffer.alloc(0), senderTimestamp } : null;
                await authState.keys.set({ tctoken: { [storageJid]: cleared } });
            }
            return baseContent.length > 0 ? baseContent : undefined;
        }
        baseContent.push({ tag: 'tctoken', attrs: { t: String(timestamp) }, content: tcTokenBuffer });
        return baseContent;
    } catch { return baseContent.length > 0 ? baseContent : undefined; }
};

export const storeTcTokensFromIqResult = async ({ result, fallbackJid, keys, getLIDForPN, onNewJidStored }) => {
    const tokensNode = getBinaryNodeChild(result, 'tokens');
    if (!tokensNode) return;
    for (const tokenNode of getBinaryNodeChildren(tokensNode, 'token')) {
        if (tokenNode.attrs.type !== 'trusted_contact' || !(tokenNode.content instanceof Uint8Array)) continue;
        const rawJid = jidNormalizedUser(fallbackJid || tokenNode.attrs.jid);
        if (!isRegularUser(rawJid)) continue;
        const storageJid = await resolveTcTokenJid(rawJid, getLIDForPN);
        const existingEntry = (await keys.get('tctoken', [storageJid]))[storageJid];
        const existingTs = existingEntry?.timestamp ? Number(existingEntry.timestamp) : 0;
        const incomingTs = tokenNode.attrs.t ? Number(tokenNode.attrs.t) : 0;
        if (!incomingTs || (existingTs > 0 && existingTs > incomingTs)) continue;
        await keys.set({ tctoken: { [storageJid]: { ...existingEntry, token: Buffer.from(tokenNode.content), timestamp: tokenNode.attrs.t } } });
        onNewJidStored?.(storageJid);
    }
};