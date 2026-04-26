// ===== CONSTANTS =====
export const S_WHATSAPP_NET = '@s.whatsapp.net';
export const OFFICIAL_BIZ_JID = '16505361212@c.us';
export const SERVER_JID = 'server@c.us';
export const PSA_WID = '0@c.us';
export const STORIES_JID = 'status@broadcast';
export const META_AI_JID = '13135550002@c.us';

// ===== DOMAIN TYPES =====
export var WAJIDDomains;
(function (WAJIDDomains) {
    WAJIDDomains[WAJIDDomains["WHATSAPP"] = 0] = "WHATSAPP";
    WAJIDDomains[WAJIDDomains["LID"] = 1] = "LID";
    WAJIDDomains[WAJIDDomains["HOSTED"] = 128] = "HOSTED";
    WAJIDDomains[WAJIDDomains["HOSTED_LID"] = 129] = "HOSTED_LID";
})(WAJIDDomains || (WAJIDDomains = {}));

export const getServerFromDomainType = (initialServer, domainType) => {
    switch (domainType) {
        case WAJIDDomains.LID: return 'lid';
        case WAJIDDomains.HOSTED: return 'hosted';
        case WAJIDDomains.HOSTED_LID: return 'hosted.lid';
        case WAJIDDomains.WHATSAPP:
        default: return initialServer;
    }
};

// ===== CORE ENCODE / DECODE =====
export const jidEncode = (user, server, device, agent) => {
    return `${user || ''}${!!agent ? `_${agent}` : ''}${!!device ? `:${device}` : ''}@${server}`;
};

export const jidDecode = (jid) => {
    const sepIdx = typeof jid === 'string' ? jid.indexOf('@') : -1;
    if (sepIdx < 0) return undefined;
    const server = jid.slice(sepIdx + 1);
    const userCombined = jid.slice(0, sepIdx);
    const [userAgent, device] = userCombined.split(':');
    const [user, agent] = userAgent.split('_');
    let domainType = WAJIDDomains.WHATSAPP;
    if (server === 'lid') domainType = WAJIDDomains.LID;
    else if (server === 'hosted') domainType = WAJIDDomains.HOSTED;
    else if (server === 'hosted.lid') domainType = WAJIDDomains.HOSTED_LID;
    else if (agent) domainType = parseInt(agent);
    return {
        server: server,
        user: user,
        domainType,
        device: device ? +device : undefined
    };
};

// ===== JID PREDICATES =====
/** is the jid a user */
export const areJidsSameUser = (jid1, jid2) => jidDecode(jid1)?.user === jidDecode(jid2)?.user;
/** is the jid Meta AI (@bot server) */
export const isJidMetaAI = (jid) => jid?.endsWith('@bot');
/** is the jid a PN user (@s.whatsapp.net) */
export const isPnUser = (jid) => jid?.endsWith('@s.whatsapp.net');
/** is the jid a user — alias for isPnUser for back-compat */
export const isJidUser = isPnUser;
/** is the jid a LID */
export const isLidUser = (jid) => jid?.endsWith('@lid');
/** is the jid a broadcast */
export const isJidBroadcast = (jid) => jid?.endsWith('@broadcast');
/** is the jid a group */
export const isJidGroup = (jid) => jid?.endsWith('@g.us');
/** is the jid the status broadcast */
export const isJidStatusBroadcast = (jid) => jid === 'status@broadcast';
/** is the jid a newsletter */
export const isJidNewsletter = (jid) => jid?.endsWith('@newsletter');
/** is the jid a hosted PN */
export const isHostedPnUser = (jid) => jid?.endsWith('@hosted');
/** is the jid a hosted LID */
export const isHostedLidUser = (jid) => jid?.endsWith('@hosted.lid');

const botRegexp = /^1313555\d{4}$|^131655500\d{2}$/;
export const isJidBot = (jid) => jid && botRegexp.test(jid.split('@')[0]) && jid.endsWith('@c.us');

export const jidNormalizedUser = (jid) => {
    const result = jidDecode(jid);
    if (!result) return '';
    const { user, server } = result;
    return jidEncode(user, server === 'c.us' ? 's.whatsapp.net' : server);
};

export const transferDevice = (fromJid, toJid) => {
    const fromDecoded = jidDecode(fromJid);
    const deviceId = fromDecoded?.device || 0;
    const { server, user } = jidDecode(toJid);
    return jidEncode(user, server, deviceId);
};

// ===== LRU CACHE =====
class SimpleLRU {
    constructor(maxSize = 2000, ttl = 5 * 60 * 1000) {
        this.maxSize = maxSize;
        this.ttl = ttl;
        this.map = new Map();
    }
    get(key) {
        const entry = this.map.get(key);
        if (!entry) return undefined;
        if (Date.now() - entry.ts > this.ttl) { this.map.delete(key); return undefined; }
        this.map.delete(key);
        this.map.set(key, entry);
        return entry.value;
    }
    set(key, value) {
        if (this.map.has(key)) this.map.delete(key);
        this.map.set(key, { value, ts: Date.now() });
        if (this.map.size > this.maxSize) {
            const lru = this.map.keys().next().value;
            if (lru) this.map.delete(lru);
        }
    }
}

const lidToJidCache = new SimpleLRU(2000, 5 * 60 * 1000);

// ===== SHARED LID ↔ PHONE CACHE =====
// Bidirectional runtime map populated from sender_pn / participant_pn / phone_number attributes.
// Used by lidToJid() and messages-recv for resolving LIDs to phone JIDs.
const _sharedLidPhoneMap = new Map();
const SHARED_MAP_MAX_SIZE = 3000;

export const sharedLidPhoneCache = {
    set(lid, phoneJid) {
        if (!lid || !phoneJid || typeof lid !== 'string' || typeof phoneJid !== 'string') return;
        if (!phoneJid.includes('@')) phoneJid = phoneJid + '@s.whatsapp.net';
        if (_sharedLidPhoneMap.size > SHARED_MAP_MAX_SIZE * 2) {
            const it = _sharedLidPhoneMap.keys();
            const toRemove = Math.floor(_sharedLidPhoneMap.size * 0.25);
            for (let i = 0; i < toRemove; i++) {
                const k = it.next().value;
                if (k === undefined) break;
                _sharedLidPhoneMap.delete(k);
            }
        }
        _sharedLidPhoneMap.set(lid, phoneJid);
        _sharedLidPhoneMap.set(phoneJid, lid);
        lidToJidCache.set(lid, phoneJid);
    },
    get(key) { return _sharedLidPhoneMap.get(key); },
    getLidForPhone(phoneJid) {
        if (!phoneJid) return undefined;
        const val = _sharedLidPhoneMap.get(phoneJid);
        return val && val.endsWith('@lid') ? val : undefined;
    },
    getPhoneForLid(lid) {
        if (!lid) return undefined;
        const val = _sharedLidPhoneMap.get(lid);
        return val && val.endsWith('@s.whatsapp.net') ? val : undefined;
    },
    get size() { return _sharedLidPhoneMap.size; }
};

// ===== BOT MAP =====
const BOT_MAP_STATIC = new Map([["867051314767696", "13135550002"], ["1061492271844689", "13135550005"], ["245886058483988", "13135550009"], ["3509905702656130", "13135550012"], ["1059680132034576", "13135550013"], ["715681030623646", "13135550014"], ["1644971366323052", "13135550015"], ["582497970646566", "13135550019"], ["645459357769306", "13135550022"], ["294997126699143", "13135550023"], ["1522631578502677", "13135550027"], ["719421926276396", "13135550030"], ["1788488635002167", "13135550031"], ["24232338603080193", "13135550033"], ["689289903143209", "13135550035"], ["871626054177096", "13135550039"], ["362351902849370", "13135550042"], ["1744617646041527", "13135550043"], ["893887762270570", "13135550046"], ["1155032702135830", "13135550047"], ["333931965993883", "13135550048"], ["853748013058752", "13135550049"], ["1559068611564819", "13135550053"], ["890487432705716", "13135550054"], ["240254602395494", "13135550055"], ["1578420349663261", "13135550062"], ["322908887140421", "13135550065"], ["3713961535514771", "13135550067"], ["997884654811738", "13135550070"], ["403157239387035", "13135550081"], ["535242369074963", "13135550082"], ["946293427247659", "13135550083"], ["3664707673802291", "13135550084"], ["1821827464894892", "13135550085"], ["1760312477828757", "13135550086"], ["439480398712216", "13135550087"], ["1876735582800984", "13135550088"], ["984025089825661", "13135550089"], ["1001336351558186", "13135550090"], ["3739346336347061", "13135550091"], ["3632749426974980", "13135550092"], ["427864203481615", "13135550093"], ["1434734570493055", "13135550094"], ["992873449225921", "13135550095"], ["813087747426445", "13135550096"], ["806369104931434", "13135550098"], ["1220982902403148", "13135550099"], ["1365893374104393", "13135550100"], ["686482033622048", "13135550200"], ["1454999838411253", "13135550201"], ["718584497008509", "13135550202"], ["743520384213443", "13135550301"], ["1147715789823789", "13135550302"], ["1173034540372201", "13135550303"], ["974785541030953", "13135550304"], ["1122200255531507", "13135550305"], ["899669714813162", "13135550306"], ["631880108970650", "13135550307"], ["435816149330026", "13135550308"], ["1368717161184556", "13135550309"], ["7849963461784891", "13135550310"], ["3609617065968984", "13135550312"], ["356273980574602", "13135550313"], ["1043447920539760", "13135550314"], ["1052764336525346", "13135550315"], ["2631118843732685", "13135550316"], ["510505411332176", "13135550317"], ["1945664239227513", "13135550318"], ["1518594378764656", "13135550319"], ["1378821579456138", "13135550320"], ["490214716896013", "13135550321"], ["1028577858870699", "13135550322"], ["308915665545959", "13135550323"], ["845884253678900", "13135550324"], ["995031308616442", "13135550325"], ["2787365464763437", "13135550326"], ["1532790990671645", "13135550327"], ["302617036180485", "13135550328"], ["723376723197227", "13135550329"], ["8393570407377966", "13135550330"], ["1931159970680725", "13135550331"], ["401073885688605", "13135550332"], ["2234478453565422", "13135550334"], ["814748673882312", "13135550335"], ["26133635056281592", "13135550336"], ["1439804456676119", "13135550337"], ["889851503172161", "13135550338"], ["1018283232836879", "13135550339"], ["1012781386779537", "13135559000"], ["823280953239532", "13135559001"], ["1597090934573334", "13135559002"], ["485965054020343", "13135559003"], ["1033381648363446", "13135559004"], ["491802010206446", "13135559005"], ["1017139033184870", "13135559006"], ["499638325922174", "13135559008"], ["468946335863664", "13135559009"], ["1570389776875816", "13135559010"], ["1004342694328995", "13135559011"], ["1012240323971229", "13135559012"], ["392171787222419", "13135559013"], ["952081212945019", "13135559016"], ["444507875070178", "13135559017"], ["1274819440594668", "13135559018"], ["1397041101147050", "13135559019"], ["425657699872640", "13135559020"], ["532292852562549", "13135559021"], ["705863241720292", "13135559022"], ["476449815183959", "13135559023"], ["488071553854222", "13135559024"], ["468693832665397", "13135559025"], ["517422564037340", "13135559026"], ["819805466613825", "13135559027"], ["1847708235641382", "13135559028"], ["716282970644228", "13135559029"], ["521655380527741", "13135559030"], ["476193631941905", "13135559031"], ["485600497445562", "13135559032"], ["440217235683910", "13135559033"], ["523342446758478", "13135559034"], ["514784864360240", "13135559035"], ["505790121814530", "13135559036"], ["420008964419580", "13135559037"], ["492141680204555", "13135559038"], ["388462787271952", "13135559039"], ["423473920752072", "13135559040"], ["489574180468229", "13135559041"], ["432360635854105", "13135559042"], ["477878201669248", "13135559043"], ["351656951234045", "13135559044"], ["430178036732582", "13135559045"], ["434537312944552", "13135559046"], ["1240614300631808", "13135559047"], ["473135945605128", "13135559048"], ["423669800729310", "13135559049"], ["3685666705015792", "13135559050"], ["504196509016638", "13135559051"], ["346844785189449", "13135559052"], ["504823088911074", "13135559053"], ["402669415797083", "13135559054"], ["490939640234431", "13135559055"], ["875124128063715", "13135559056"], ["468788962654605", "13135559057"], ["562386196354570", "13135559058"], ["372159285928791", "13135559059"], ["531017479591050", "13135559060"], ["1328873881401826", "13135559061"], ["1608363646390484", "13135559062"], ["1229628561554232", "13135559063"], ["348802211530364", "13135559064"], ["3708535859420184", "13135559065"], ["415517767742187", "13135559066"], ["479330341612638", "13135559067"], ["480785414723083", "13135559068"], ["387299107507991", "13135559069"], ["333389813188944", "13135559070"], ["391794130316996", "13135559071"], ["457893470576314", "13135559072"], ["435550496166469", "13135559073"], ["1620162702100689", "13135559074"], ["867491058616043", "13135559075"], ["816224117357759", "13135559076"], ["334065176362830", "13135559077"], ["489973170554709", "13135559078"], ["473060669049665", "13135559079"], ["1221505815643060", "13135559080"], ["889000703096359", "13135559081"], ["475235961979883", "13135559082"], ["3434445653519934", "13135559084"], ["524503026827421", "13135559085"], ["1179639046403856", "13135559086"], ["471563305859144", "13135559087"], ["533896609192881", "13135559088"], ["365443583168041", "13135559089"], ["836082305329393", "13135559090"], ["1056787705969916", "13135559091"], ["503312598958357", "13135559092"], ["3718606738453460", "13135559093"], ["826066052850902", "13135559094"], ["1033611345091888", "13135559095"], ["3868390816783240", "13135559096"], ["7462677740498860", "13135559097"], ["436288576108573", "13135559098"], ["1047559746718900", "13135559099"], ["1099299455255491", "13135559100"], ["1202037301040633", "13135559101"], ["1720619402074074", "13135559102"], ["1030422235101467", "13135559103"], ["827238979523502", "13135559104"], ["1516443722284921", "13135559105"], ["1174442747196709", "13135559106"], ["1653165225503842", "13135559107"], ["1037648777635013", "13135559108"], ["551617757299900", "13135559109"], ["1158813558718726", "13135559110"], ["2463236450542262", "13135559111"], ["1550393252501466", "13135559112"], ["2057065188042796", "13135559113"], ["506163028760735", "13135559114"], ["2065249100538481", "13135559115"], ["1041382867195858", "13135559116"], ["886500209499603", "13135559117"], ["1491615624892655", "13135559118"], ["486563697299617", "13135559119"], ["1175736513679463", "13135559120"], ["491811473512352", "13165550064"]]);

let BOT_MAP = BOT_MAP_STATIC;

// ===== BOT MAP MANAGEMENT =====
export const setBotMap = (mapLike) => {
    if (!mapLike) return;
    BOT_MAP = mapLike instanceof Map ? mapLike : new Map(Object.entries(mapLike));
};

export const loadBotMapFromFile = async (filePath) => {
    const { promises: fsp } = await import('fs');
    const { join } = await import('path');
    const { fileURLToPath } = await import('url');
    const __dirname = fileURLToPath(new URL('.', import.meta.url));

    const candidates = [];
    if (filePath) candidates.push(filePath);
    candidates.push(join(process.cwd(), 'bot-map.json'));
    candidates.push(join(__dirname, 'bot-map.json'));

    for (const p of candidates) {
        try {
            const stat = await fsp.stat(p).catch(() => null);
            if (!stat?.isFile()) continue;
            const data = await fsp.readFile(p, 'utf8');
            const obj = JSON.parse(data);
            if (obj && typeof obj === 'object') { BOT_MAP = new Map(Object.entries(obj)); return BOT_MAP; }
        } catch { }
    }
    return BOT_MAP;
};

// ===== LID → JID RESOLUTION =====
export const lidToJid = (jid) => {
    try {
        if (!jid || typeof jid !== 'string') return jid;
        const cached = lidToJidCache.get(jid);
        if (cached) return cached;

        let result = jid;
        if (jid.endsWith('@lid')) {
            const lidPart = jid.replace('@lid', '');
            if (BOT_MAP.has(lidPart)) {
                result = BOT_MAP.get(lidPart) + '@s.whatsapp.net';
            } else {
                const phoneFromCache = sharedLidPhoneCache.getPhoneForLid(jid);
                if (phoneFromCache) result = phoneFromCache;
                // LID parts are opaque — never guess from digits
            }
        }

        if (result !== jid) lidToJidCache.set(jid, result);
        return result;
    } catch {
        return jid;
    }
};

export const resolveJid = (jid) => {
    if (typeof jid === 'string' && jid.endsWith('@lid')) return lidToJid(jid);
    return jid;
};

export const lidToJidEnhanced = (jid) => lidToJid(jid);

/**
 * Validates and cleans a JID. For LIDs, attempts resolution via BOT_MAP + sharedLidPhoneCache.
 * Never converts a resolved JID back to LID — that would corrupt stored message keys.
 */
export const validateAndCleanJid = (jid) => {
    if (!jid || typeof jid !== 'string') return jid;
    if (jid.endsWith('@lid')) return lidToJid(jid);
    return jid;
};

/**
 * Async LID → JID with optional WhatsApp existence validation.
 */
export const validateAndConvertLidToJid = async (jid, onWhatsApp) => {
    try {
        if (!jid || typeof jid !== 'string') return jid;
        const convertedJid = lidToJid(jid);

        // Still a LID after resolution — nothing to validate
        if (isLidUser(convertedJid)) return convertedJid;

        if (onWhatsApp) {
            try {
                const validation = await onWhatsApp(convertedJid);
                if (validation?.length > 0 && validation[0].exists) return convertedJid;
                // Validation says it doesn't exist — return original
                return jid;
            } catch {
                // Validation failed — return best-effort converted JID
                return convertedJid;
            }
        }

        return convertedJid;
    } catch {
        return jid;
    }
};

/**
 * Maps a @bot server JID to its phone JID using BOT_MAP.
 */
export const getBotJid = (jid) => {
    try {
        const sepIdx = typeof jid === 'string' ? jid.indexOf('@') : -1;
        if (sepIdx < 0) return jid;
        if (jid.slice(sepIdx + 1) !== 'bot') return jid;
        const user = jid.slice(0, sepIdx);
        const mappedNumber = BOT_MAP.get(user);
        return mappedNumber ? `${mappedNumber}@s.whatsapp.net` : jid;
    } catch {
        return jid;
    }
};

//# sourceMappingURL=jid-utils.js.map