"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.releaseComment = exports.isVersion = exports.PLATFORM_KEYS = exports.MAX_NOTES = exports.CLEAN_START_MS = exports.MAX_FILE_BYTES = exports.MAX_MANIFEST_BYTES = exports.CHECK_EVERY_MS = exports.CHECK_DELAY_MS = exports.RELEASE_URL_PREFIX = exports.MANIFEST_URL = void 0;
exports.cmpVersion = cmpVersion;
exports.isReleased = isReleased;
exports.parseReleaseManifest = parseReleaseManifest;
// The app's release manifest (R4): its constants, the strict parser and the version order. Pure: no Electron, no I/O.
// - Schema 1: {schema: 1, channel: 'stable', version, released, notes, files: {'win32-x64'?, 'linux-x64'?: {url, sha256, size}}}.
// - Evolution: unknown top-level keys and unknown platform keys are ignored (the fields are signed, so ignoring costs no trust); every
//   known field is validated strictly and `schema` must be 1. An incompatible schema gets its own URL (stable/latest.v<N>.json).
// - The parser runs only on bytes whose minisign signature was already verified (updater.ts); it never trusts a field before that.
const errors_1 = require("../errors");
exports.MANIFEST_URL = 'https://downloads.eve-cyno.dev/desktop/stable/latest.json';
/** Every file URL of a product manifest starts with this. */
exports.RELEASE_URL_PREFIX = 'https://downloads.eve-cyno.dev/desktop/';
exports.CHECK_DELAY_MS = 60_000;
exports.CHECK_EVERY_MS = 21_600_000;
exports.MAX_MANIFEST_BYTES = 65_536;
exports.MAX_FILE_BYTES = 536_870_912;
exports.CLEAN_START_MS = 60_000;
exports.MAX_NOTES = 2000;
exports.PLATFORM_KEYS = ['win32-x64', 'linux-x64'];
/** A strict x.y.z (no v prefix, no leading zeros, no pre-release or build part), as scripts/set-version.mjs writes it. */
const VERSION = /^(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})$/;
const isVersion = (v) => typeof v === 'string' && VERSION.test(v);
exports.isVersion = isVersion;
/** -1, 0 or 1; both must be strict versions (isVersion). */
function cmpVersion(a, b) {
    const x = a.split('.').map(Number), y = b.split('.').map(Number);
    for (let i = 0; i < 3; i++)
        if (x[i] !== y[i])
            return x[i] < y[i] ? -1 : 1;
    return 0;
}
/** ISO-8601 UTC with seconds (optional milliseconds) and a Z, that names a real instant (no month 13, no February 30). */
const RELEASED = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,3})?Z$/;
function isReleased(v) {
    if (typeof v !== 'string')
        return false;
    const m = RELEASED.exec(v);
    if (!m)
        return false;
    const t = Date.parse(v);
    if (!Number.isFinite(t))
        return false;
    const d = new Date(t);
    return d.getUTCFullYear() === Number(m[1]) && d.getUTCMonth() + 1 === Number(m[2]) && d.getUTCDate() === Number(m[3])
        && d.getUTCHours() === Number(m[4]) && d.getUTCMinutes() === Number(m[5]) && d.getUTCSeconds() === Number(m[6]);
}
/** The trusted comment a release manifest's signature must carry (R2): purpose, channel and version. */
const releaseComment = (channel, version) => `eve-cyno-desktop release ${channel} ${version}`;
exports.releaseComment = releaseComment;
const isObj = (v) => typeof v === 'object' && v !== null && !Array.isArray(v);
const bad = (what) => { throw (0, errors_1.coded)('bad_manifest', `release manifest: ${what}`); };
const SHA256 = /^[0-9a-f]{64}$/;
// No control character but tab, newline and carriage return; no lone surrogate (the notes are shown as text).
const NOTES_BAD = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]|[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;
/**
 * A file URL is accepted only in its canonical form (what the URL parser gives back, so no `..`, `%2e%2e`, default port, case or
 * backslash trick moves it), under `prefix`, with no query, fragment or credentials, naming a file (not a directory). The URL never
 * names a local path: the updater stages every download under a name it makes itself.
 */
function checkUrl(raw, prefix) {
    if (typeof raw !== 'string' || raw.length > 2048)
        return bad('file url');
    let u;
    try {
        u = new URL(raw);
    }
    catch {
        return bad('file url');
    }
    if (u.href !== raw || u.search || u.hash || u.username || u.password || !raw.startsWith(prefix) || raw.length === prefix.length || raw.endsWith('/'))
        return bad('file url');
    return raw;
}
/**
 * Parses and validates a verified manifest (R4's evolution rule). Throws coded `bad_manifest`, or `too_large` for a manifest over
 * MAX_MANIFEST_BYTES or a file over MAX_FILE_BYTES. `urlPrefix` is RELEASE_URL_PREFIX for the product (a test build's fake server
 * passes its own origin's /desktop/).
 */
function parseReleaseManifest(json, urlPrefix = exports.RELEASE_URL_PREFIX) {
    if (!Buffer.isBuffer(json))
        return bad('not bytes');
    if (json.length > exports.MAX_MANIFEST_BYTES)
        throw (0, errors_1.coded)('too_large', 'release manifest: too large');
    let text, v;
    try {
        text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(json);
    }
    catch {
        return bad('not UTF-8');
    }
    try {
        v = JSON.parse(text);
    }
    catch {
        return bad('not JSON');
    }
    if (!isObj(v))
        return bad('not an object');
    if (v.schema !== 1)
        return bad('schema');
    if (v.channel !== 'stable')
        return bad('channel');
    if (!(0, exports.isVersion)(v.version))
        return bad('version');
    if (!isReleased(v.released))
        return bad('released');
    if (typeof v.notes !== 'string' || Array.from(v.notes).length > exports.MAX_NOTES || NOTES_BAD.test(v.notes))
        return bad('notes');
    if (!isObj(v.files))
        return bad('files');
    const files = {};
    let tooLarge = false;
    for (const key of exports.PLATFORM_KEYS) {
        if (!Object.hasOwn(v.files, key))
            continue;
        const f = v.files[key];
        if (!isObj(f))
            return bad('file entry');
        const url = checkUrl(f.url, urlPrefix);
        if (typeof f.sha256 !== 'string' || !SHA256.test(f.sha256))
            return bad('sha256');
        if (typeof f.size !== 'number' || !Number.isSafeInteger(f.size) || f.size < 1)
            return bad('size');
        if (f.size > exports.MAX_FILE_BYTES)
            tooLarge = true; // every other field is still checked first: a broken manifest is bad_manifest
        files[key] = { url, sha256: f.sha256, size: f.size };
    }
    if (tooLarge)
        throw (0, errors_1.coded)('too_large', 'release manifest: file too large');
    return { schema: 1, channel: 'stable', version: v.version, released: v.released, notes: v.notes, files };
}
