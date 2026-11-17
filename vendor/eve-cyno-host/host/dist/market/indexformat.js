"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.isRevocationReason = exports.catalogUrl = exports.indexComment = exports.ARCHIVE_NAME_RE = exports.MAX_FLAGS = exports.MAX_CATEGORIES = exports.MAX_VERSIONS = exports.MAX_REVOCATIONS = exports.MAX_LISTINGS = exports.CATEGORIES = exports.INDEX_RETRY_MS = exports.INDEX_EVERY_MS = exports.ARCHIVE_IDLE_MS = exports.INDEX_TIMEOUT_MS = exports.DEFAULT_INDEX_LIFETIME_DAYS = exports.MAX_INDEX_LIFETIME_MS = exports.MAX_ARCHIVE_BYTES = exports.MAX_CATALOG_BYTES = exports.MAX_INDEX_SIG_BYTES = exports.MAX_HEAD_BYTES = exports.INDEX_URL = exports.MARKET_URL_PREFIX = void 0;
exports.isIndexTime = isIndexTime;
exports.parseIndexHead = parseIndexHead;
exports.verifyIndexHead = verifyIndexHead;
exports.catalogMatches = catalogMatches;
exports.listingProblem = listingProblem;
exports.parseCatalog = parseCatalog;
exports.permissionsKey = permissionsKey;
exports.listingDifference = listingDifference;
exports.themeListingDifference = themeListingDifference;
// The marketplace index, format v1 (R20-R23): a small signed head that names a content-addressed catalog by URL, size and SHA-256.
// Pure: no Electron, no I/O, no clock (freshness and anti-rollback are the client's, market/client.ts).
// - The head `index.json` (at most 16 KiB) is signed with minisign by an `index` key, with the trusted comment
//   `eve-cyno-index v1 <generated>`. verifyIndexHead checks, in this order: the size caps, the signature (with the keys the caller passes:
//   the index keys, never a release key), the head parser, and that the trusted comment equals indexComment() of the parsed `generated`.
//   Nothing of the head is used before its signature verified.
// - The catalog (at most 4 MiB) is never signed directly: parseCatalog checks its size and SHA-256 against a verified head before it
//   decodes one byte of it.
// - Evolution (R4): unknown keys are ignored at every level, every known field is strict, `schema` must be 1; an incompatible format
//   moves to v2/. Every URL in a head or catalog is compared in its canonical form (`new URL(u).href === u`) and starts with the prefix:
//   MARKET_URL_PREFIX in the product, `<fake origin>/v1/` in a test build.
// - Failure rule (R22): a broken head, a broken catalog structure, a `generated` later than the head's, duplicate ids or ANY malformed
//   revocation refuse the whole index (`bad_index`); one malformed listing is dropped and counted (`dropped`), so one bad entry cannot hide
//   every other plugin or a revocation; an unknown `type` is ignored; an unknown category is removed from its listing.
// - Errors are coded `bad_index` or `too_large`; their messages name a field, never a value from the index.
const crypto = __importStar(require("node:crypto"));
const semver = __importStar(require("semver"));
const errors_1 = require("../errors");
const manifest_1 = require("../manifest");
const minisign_1 = require("../minisign");
// ---- R21 and R23 constants ("Exact values") -------------------------------------------------------------------------------------------
exports.MARKET_URL_PREFIX = 'https://plugins.eve-cyno.dev/v1/';
exports.INDEX_URL = exports.MARKET_URL_PREFIX + 'index.json'; // its signature: INDEX_URL + '.minisig'
exports.MAX_HEAD_BYTES = 16_384;
exports.MAX_INDEX_SIG_BYTES = 16_384;
exports.MAX_CATALOG_BYTES = 4_194_304;
exports.MAX_ARCHIVE_BYTES = 33_554_432;
/** 90 days: `generated < expires <= generated + MAX_INDEX_LIFETIME_MS` (D36). */
exports.MAX_INDEX_LIFETIME_MS = 7_776_000_000;
/** What scripts/index-build.mjs writes (D36). */
exports.DEFAULT_INDEX_LIFETIME_DAYS = 60;
exports.INDEX_TIMEOUT_MS = 30_000;
exports.ARCHIVE_IDLE_MS = 60_000;
exports.INDEX_EVERY_MS = 14_400_000;
exports.INDEX_RETRY_MS = 600_000;
exports.CATEGORIES = ['intel', 'industry', 'fleet', 'fitting', 'logistics', 'tools', 'themes'];
// R22 caps.
exports.MAX_LISTINGS = 2000;
exports.MAX_REVOCATIONS = 2000;
exports.MAX_VERSIONS = 50;
exports.MAX_CATEGORIES = 4;
exports.MAX_FLAGS = 32;
/** The `<name>` of an archive URL, `prefix + 'archives/' + <name>`. */
exports.ARCHIVE_NAME_RE = /^[a-z0-9][a-z0-9.-]{0,120}\.zip$/;
const FLAG_KEY = /^[a-z][a-z0-9-]{0,31}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const MAX_SOURCE = 300, MAX_RANGE = 64, MAX_VERSION = 64;
const TEXT = { name: 60, author: 60, summary: 120, description: 4000, changes: 2000, reason: 200 };
/** The trusted comment an index head's signature carries. */
const indexComment = (generated) => `eve-cyno-index v1 ${generated}`;
exports.indexComment = indexComment;
const catalogUrl = (prefix, sha256) => `${prefix}catalog/${sha256}.json`;
exports.catalogUrl = catalogUrl;
const isObj = (v) => typeof v === 'object' && v !== null && !Array.isArray(v);
const bad = (what) => { throw (0, errors_1.coded)('bad_index', `index: ${what}`); };
const isSize = (v) => typeof v === 'number' && Number.isSafeInteger(v) && v >= 1;
const sha256Of = (b) => crypto.createHash('sha256').update(b).digest('hex');
/** `YYYY-MM-DDTHH:MM:SSZ` naming a real instant: no fraction, no offset, no month 13, no February 30. */
const STAMP = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})Z$/;
function isIndexTime(v) {
    const m = typeof v === 'string' ? STAMP.exec(v) : null;
    if (!m)
        return false;
    const d = new Date(Date.parse(v));
    return Number.isFinite(d.getTime()) && d.getUTCFullYear() === Number(m[1]) && d.getUTCMonth() + 1 === Number(m[2]) && d.getUTCDate() === Number(m[3])
        && d.getUTCHours() === Number(m[4]) && d.getUTCMinutes() === Number(m[5]) && d.getUTCSeconds() === Number(m[6]);
}
/** `YYYY-MM-DD` naming a real day. */
const DAY = /^(\d{4})-(\d{2})-(\d{2})$/;
function isDay(v) {
    const m = typeof v === 'string' ? DAY.exec(v) : null;
    if (!m)
        return false;
    const d = new Date(Date.parse(`${v}T00:00:00Z`));
    return Number.isFinite(d.getTime()) && d.getUTCFullYear() === Number(m[1]) && d.getUTCMonth() + 1 === Number(m[2]) && d.getUTCDate() === Number(m[3]);
}
/** A URL in its canonical form only (what the URL parser gives back), without credentials, query or fragment. */
function canonical(u) {
    if (typeof u !== 'string' || u.length > 2048)
        return false;
    let x;
    try {
        x = new URL(u);
    }
    catch {
        return false;
    }
    return x.href === u && !x.username && !x.password && !x.search && !x.hash && !u.includes('?') && !u.includes('#');
}
/** The prefix every URL of the index starts with: a canonical http(s) folder URL (the product's is MARKET_URL_PREFIX). */
function checkPrefix(prefix) {
    if (!canonical(prefix) || !/^https?:$/.test(new URL(prefix).protocol) || !prefix.endsWith('/'))
        bad('the URL prefix is not a canonical http(s) folder URL');
}
function archiveUrlOk(u, prefix) {
    const base = `${prefix}archives/`;
    return canonical(u) && u.startsWith(base) && exports.ARCHIVE_NAME_RE.test(u.slice(base.length));
}
// Display text: one line, trimmed, the manifest's display rule (manifest.ts displayProblem). Printable ASCII takes a fast path that
// gives the same answer (every printable ASCII character but the space is a letter, digit, symbol or punctuation mark).
const ASCII_LINE = /^[\x21-\x7e](?:[\x20-\x7e]*[\x21-\x7e])?$/;
function displayOk(v, max) {
    if (typeof v !== 'string')
        return false;
    if (ASCII_LINE.test(v))
        return v.length <= max;
    return v === v.trim() && (0, manifest_1.displayProblem)(v, max) === null;
}
// Long text (description, changes): may be empty; lines split on `\n`, each empty, spaces only, or display text by the same rule; no
// other control character (no `\r`, no tab), at most `max` code points in all.
const ASCII_TEXT = /^[\x20-\x7e\n]*$/;
function longTextOk(v, max) {
    if (typeof v !== 'string')
        return false;
    if (ASCII_TEXT.test(v))
        return v.length <= max;
    if ([...v].length > max)
        return false;
    return v.split('\n').every(l => l === '' || /^ +$/.test(l) || (0, manifest_1.displayProblem)(l, max) === null);
}
/**
 * A listing's `source` link (market.openSource opens it): canonical, `https:`, at most 300 characters, on the default port, and its
 * host a plain DNS name by the manifest's network-origin rules (canonicalOrigin: no IP literal, no localhost, no trailing dot, LDH).
 */
function sourceOk(v) {
    if (!canonical(v) || v.length > MAX_SOURCE)
        return false;
    const u = new URL(v);
    if (u.protocol !== 'https:' || u.port !== '')
        return false;
    try {
        (0, manifest_1.canonicalOrigin)(u.origin);
        return true;
    }
    catch {
        return false;
    }
}
/** Listing and revocation ids: the plugin id rule, without the host's reserved prefix (theme packages follow the same rule). */
const isListingId = (v) => typeof v === 'string' && (0, manifest_1.isPluginId)(v) && !v.startsWith(manifest_1.HOST_ID_PREFIX);
const isVersion = (v) => typeof v === 'string' && v.length <= MAX_VERSION && manifest_1.SEMVER.test(v);
function decodeJson(bytes, what) {
    let text;
    try {
        text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes);
    }
    catch {
        return bad(`${what}: not UTF-8`);
    }
    try {
        return JSON.parse(text);
    }
    catch {
        return bad(`${what}: not JSON`);
    }
}
/** Runs `f`; anything thrown that is not already bad_index or too_large (a RangeError, say) is a refused index. */
function guard(f) {
    try {
        return f();
    }
    catch (e) {
        const code = e?.code;
        if (code === 'bad_index' || code === 'too_large')
            throw e;
        return bad('malformed');
    }
}
// ---- the head ---------------------------------------------------------------------------------------------------------------------------
function parseFlags(v) {
    if (v === undefined)
        return Object.create(null);
    if (!isObj(v))
        return bad('head: flags');
    const entries = Object.entries(v);
    if (entries.length > exports.MAX_FLAGS)
        bad(`head: more than ${exports.MAX_FLAGS} flags`);
    const flags = Object.create(null); // no inherited member answers a lookup by flag name
    for (const [k, b] of entries) {
        if (!FLAG_KEY.test(k) || typeof b !== 'boolean')
            bad('head: flags');
        flags[k] = b;
    }
    return flags;
}
/**
 * Parses a head. Run it only on bytes whose signature verified (verifyIndexHead). Throws coded `bad_index`, or `too_large` for a head
 * over MAX_HEAD_BYTES or a catalog declared over MAX_CATALOG_BYTES (every other field is checked first: a broken head is bad_index).
 */
function parseIndexHead(bytes, prefix = exports.MARKET_URL_PREFIX) {
    return guard(() => {
        if (!Buffer.isBuffer(bytes))
            return bad('head: not bytes');
        if (bytes.length > exports.MAX_HEAD_BYTES)
            throw (0, errors_1.coded)('too_large', `index head: too large (over ${exports.MAX_HEAD_BYTES} bytes)`);
        checkPrefix(prefix);
        const v = decodeJson(bytes, 'head');
        if (!isObj(v))
            return bad('head: not an object');
        if (v.schema !== 1)
            bad('head: schema');
        if (!isIndexTime(v.generated))
            bad('head: generated');
        if (!isIndexTime(v.expires))
            bad('head: expires');
        const generated = v.generated, expires = v.expires;
        const g = Date.parse(generated), e = Date.parse(expires);
        if (!(g < e && e - g <= exports.MAX_INDEX_LIFETIME_MS))
            bad('head: expires must be after generated and at most 90 days later');
        const c = v.catalog;
        if (!isObj(c))
            return bad('head: catalog');
        if (typeof c.sha256 !== 'string' || !SHA256.test(c.sha256))
            bad('head: catalog.sha256');
        const sha256 = c.sha256;
        if (!canonical(c.url) || c.url !== (0, exports.catalogUrl)(prefix, sha256))
            bad('head: catalog.url');
        if (!isSize(c.size))
            bad('head: catalog.size');
        const flags = parseFlags(v.flags);
        if (c.size > exports.MAX_CATALOG_BYTES)
            throw (0, errors_1.coded)('too_large', `index head: the catalog is declared over ${exports.MAX_CATALOG_BYTES} bytes`);
        return { schema: 1, generated, expires, catalog: { url: c.url, sha256, size: c.size }, flags };
    });
}
/**
 * Verifies a downloaded head: the size caps (head and signature), the minisign signature with `keys` (pass the index keys:
 * trustedKeys('index', …); a release key never verifies an index), the parser, and the trusted comment, which must be exactly
 * indexComment() of the parsed `generated`. Never throws.
 */
function verifyIndexHead(bytes, sigText, keys, prefix = exports.MARKET_URL_PREFIX) {
    if (!Buffer.isBuffer(bytes))
        return { ok: false, reason: 'bad_index' };
    if (typeof sigText !== 'string')
        return { ok: false, reason: 'verify_failed' };
    if (bytes.length > exports.MAX_HEAD_BYTES || Buffer.byteLength(sigText, 'utf8') > exports.MAX_INDEX_SIG_BYTES)
        return { ok: false, reason: 'too_large' };
    const v = (0, minisign_1.verifyMinisign)(bytes, sigText, keys);
    if (!v.ok)
        return { ok: false, reason: 'verify_failed' };
    let head;
    try {
        head = parseIndexHead(bytes, prefix);
    }
    catch (e) {
        return { ok: false, reason: e?.code === 'too_large' ? 'too_large' : 'bad_index' };
    }
    if (v.trusted !== (0, exports.indexComment)(head.generated))
        return { ok: false, reason: 'verify_failed' };
    return { ok: true, head, keyId: v.keyId };
}
// ---- the catalog ------------------------------------------------------------------------------------------------------------------------
/** True when `bytes` are exactly the catalog the (verified) head names: its size and its SHA-256. */
function catalogMatches(bytes, head) {
    return Buffer.isBuffer(bytes) && bytes.length === head.catalog.size && sha256Of(bytes) === head.catalog.sha256;
}
class Drop extends Error {
}
const drop = (why) => { throw new Drop(why); };
const KNOWN_TYPES = new Set(['plugin', 'theme']);
const CATEGORY_SET = new Set(exports.CATEGORIES);
function parseVersion(x, type, prefix, i) {
    const at = `versions[${i}]`;
    if (!isObj(x))
        return drop(at);
    if (!isVersion(x.version))
        drop(`${at}.version`);
    if (!isDay(x.released))
        drop(`${at}.released`);
    if (!longTextOk(x.changes, TEXT.changes))
        drop(`${at}.changes`);
    const a = x.archive;
    if (!isObj(a))
        return drop(`${at}.archive`);
    if (!archiveUrlOk(a.url, prefix))
        drop(`${at}.archive.url`);
    if (typeof a.sha256 !== 'string' || !SHA256.test(a.sha256))
        drop(`${at}.archive.sha256`);
    if (!isSize(a.size) || a.size > exports.MAX_ARCHIVE_BYTES)
        drop(`${at}.archive.size`);
    const out = { version: x.version, released: x.released, changes: x.changes,
        archive: { url: a.url, sha256: a.sha256, size: a.size } };
    if (type === 'theme')
        return out; // a theme package carries values only: no engines, no permissions
    if (typeof x.engines !== 'string' || x.engines.length > MAX_RANGE || semver.validRange(x.engines) === null)
        drop(`${at}.engines`);
    if (!isObj(x.permissions))
        drop(`${at}.permissions`);
    let permissions;
    try {
        permissions = (0, manifest_1.parsePermissions)(x.permissions);
    }
    catch {
        return drop(`${at}.permissions`);
    }
    // API 1.17.0: a version that writes `permissions.optional` names an engines range no older host satisfies, as its manifest must (parseManifest).
    if (Object.hasOwn(x.permissions, 'optional') && !(0, manifest_1.optionalEnginesOk)(x.engines))
        drop(`${at}.engines`);
    return { ...out, engines: x.engines, permissions };
}
/** A listing of a known type, or a Drop naming the first field that is wrong. */
function parseListing(x, prefix) {
    const type = x.type;
    if (!isListingId(x.id))
        drop('id');
    if (!displayOk(x.name, TEXT.name))
        drop('name');
    if (!displayOk(x.author, TEXT.author))
        drop('author');
    if (x.firstParty !== undefined && typeof x.firstParty !== 'boolean')
        drop('firstParty');
    if (!displayOk(x.summary, TEXT.summary))
        drop('summary');
    if (!longTextOk(x.description, TEXT.description))
        drop('description');
    const cats = x.categories;
    if (!Array.isArray(cats) || cats.length > exports.MAX_CATEGORIES || cats.some(c => typeof c !== 'string') || new Set(cats).size !== cats.length)
        drop('categories');
    const categories = cats.filter((c) => CATEGORY_SET.has(c));
    if (x.source !== null && !sourceOk(x.source))
        drop('source');
    const vs = x.versions;
    if (!Array.isArray(vs) || vs.length < 1 || vs.length > exports.MAX_VERSIONS)
        return drop('versions');
    const versions = vs.map((v, i) => parseVersion(v, type, prefix, i));
    versions.sort((a, b) => semver.rcompare(a.version, b.version));
    for (let i = 1; i < versions.length; i++)
        if (semver.eq(versions[i - 1].version, versions[i].version))
            drop('versions: a version is listed twice');
    return { id: x.id, type, name: x.name, author: x.author, firstParty: x.firstParty === true, summary: x.summary,
        description: x.description, categories, source: x.source, versions };
}
/** A revocation's `reason` as the catalog may give it: display text of at most 200 code points (state.json's record reads it by this rule). */
const isRevocationReason = (v) => displayOk(v, TEXT.reason);
exports.isRevocationReason = isRevocationReason;
function parseRevocation(x, i) {
    const at = `catalog: revoked[${i}]`;
    if (!isObj(x))
        return bad(at);
    if (!isListingId(x.id))
        bad(`${at}.id`);
    let versions;
    if (x.versions === '*')
        versions = '*';
    else if (Array.isArray(x.versions) && x.versions.length >= 1 && x.versions.every(isVersion) && new Set(x.versions).size === x.versions.length)
        versions = [...x.versions];
    else
        return bad(`${at}.versions`);
    if (!(0, exports.isRevocationReason)(x.reason))
        bad(`${at}.reason`);
    if (!isDay(x.date))
        bad(`${at}.date`);
    return { id: x.id, versions, reason: x.reason, date: x.date };
}
/**
 * Why a raw catalog entry would be dropped (the field it fails on), or null when it would be kept or ignored (an unknown type). The
 * publishing tools use it to name a dropped listing; the client counts drops only.
 */
function listingProblem(raw, prefix = exports.MARKET_URL_PREFIX) {
    if (!isObj(raw))
        return 'not an object';
    if (!KNOWN_TYPES.has(raw.type))
        return typeof raw.type === 'string' ? null : 'type';
    try {
        parseListing(raw, prefix);
        return null;
    }
    catch (e) {
        return e instanceof Drop ? e.message : 'malformed';
    }
}
/**
 * Parses the catalog a verified head names. Its size and SHA-256 must match the head before one byte is decoded (else bad_index, so
 * nothing of a substituted catalog is read). Throws coded `bad_index` or `too_large` (over MAX_CATALOG_BYTES). `admit` (Task 5's
 * reserved names) may refuse a listing: it is dropped and counted like a malformed one, and so is one it throws on.
 */
function parseCatalog(bytes, head, o = {}) {
    const prefix = o.prefix ?? exports.MARKET_URL_PREFIX;
    return guard(() => {
        if (!Buffer.isBuffer(bytes))
            return bad('catalog: not bytes');
        if (bytes.length > exports.MAX_CATALOG_BYTES)
            throw (0, errors_1.coded)('too_large', `index catalog: too large (over ${exports.MAX_CATALOG_BYTES} bytes)`);
        if (!catalogMatches(bytes, head))
            bad('catalog: its size or SHA-256 does not match the head');
        checkPrefix(prefix);
        const v = decodeJson(bytes, 'catalog');
        if (!isObj(v))
            return bad('catalog: not an object');
        if (v.schema !== 1)
            bad('catalog: schema');
        // Not later than the head's: a re-signed head names the catalog it signed before (R23; the client also keeps the newest catalog
        // `generated` it saw, so an older one cannot come back).
        if (!isIndexTime(v.generated) || Date.parse(v.generated) > Date.parse(head.generated))
            bad('catalog: generated is after the head\'s');
        if (!Array.isArray(v.plugins) || v.plugins.length > exports.MAX_LISTINGS)
            bad('catalog: plugins');
        if (!Array.isArray(v.revoked) || v.revoked.length > exports.MAX_REVOCATIONS)
            bad('catalog: revoked');
        const entries = v.plugins;
        // Ids are unique across both types; a duplicate refuses the index even when one of the two entries is malformed (which of them
        // would be meant cannot be known).
        const seen = new Set();
        for (const e of entries) {
            if (!isObj(e) || !KNOWN_TYPES.has(e.type) || typeof e.id !== 'string')
                continue;
            if (seen.has(e.id))
                bad('catalog: an id is listed twice');
            seen.add(e.id);
        }
        const revoked = v.revoked.map(parseRevocation);
        const plugins = [];
        let dropped = 0;
        for (const e of entries) {
            if (isObj(e) && typeof e.type === 'string' && !KNOWN_TYPES.has(e.type))
                continue; // a type of a later format: ignored, not counted
            let l;
            try {
                if (!isObj(e) || !KNOWN_TYPES.has(e.type))
                    drop('type');
                l = parseListing(e, prefix);
            }
            catch {
                dropped++;
                continue;
            }
            let admitted = false;
            try {
                admitted = o.admit ? o.admit(l) === true : true;
            }
            catch {
                admitted = false;
            }
            if (admitted)
                plugins.push(l);
            else
                dropped++;
        }
        return { schema: 1, generated: v.generated, plugins, revoked, dropped };
    });
}
/**
 * A permissions object in one canonical form: lists as sets (sorted, no repeats, empty as absent), `false` and `characters: 'none'` as
 * absent, keys sorted, the storage quota as a number (the default when unset). Both sides went through parsePermissions first (the
 * manifest parser and the catalog's listing parser: network origins canonical, the default quota filled in).
 */
function permissionsKey(p) {
    const absent = (x) => x === undefined || x === false || (Array.isArray(x) && x.length === 0)
        || (typeof x === 'object' && x !== null && !Array.isArray(x) && Object.keys(x).length === 0);
    const canon = (v) => {
        if (Array.isArray(v))
            return [...new Set(v.map(x => JSON.stringify(canon(x))))].sort();
        if (typeof v === 'object' && v !== null) {
            const o = v;
            return Object.fromEntries(Object.keys(o).sort().map(k => [k, canon(o[k])]).filter(([, x]) => !absent(x)));
        }
        return v;
    };
    const { characters, storage, ...rest } = p;
    return JSON.stringify(canon({ ...rest, characters: characters === 'none' ? undefined : characters, storage: storage?.quotaMB ?? manifest_1.DEFAULT_STORAGE_MB }));
}
/**
 * R26: the first field in which a parsed plugin manifest differs from its listing at version `v`, or null when it states the plugin as
 * listed: id, version, name, author, the engines range (both read as semver ranges) and the permissions (permissionsKey on both sides).
 * The installer refuses a difference `listing_mismatch`; index-verify --archives names it.
 */
function listingDifference(m, l, v) {
    const range = (r) => (r === undefined ? null : semver.validRange(r));
    if (m.id !== l.id)
        return 'id';
    if (m.version !== v.version)
        return 'version';
    if (m.name !== l.name)
        return 'name';
    if (m.author !== l.author)
        return 'author';
    if (range(v.engines) === null || range(m.engines['eve-cyno-api']) !== range(v.engines))
        return 'engines';
    if (v.permissions === undefined || permissionsKey(m.permissions) !== permissionsKey(v.permissions))
        return 'permissions';
    return null;
}
/** The same for a theme package's theme.json (id, version, name, author: a theme has no engines or permissions). */
function themeListingDifference(p, l, v) {
    return p.id !== l.id ? 'id' : p.version !== v.version ? 'version' : p.name !== l.name ? 'name' : p.author !== l.author ? 'author' : null;
}
