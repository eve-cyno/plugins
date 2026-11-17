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
exports.MarketClient = exports.MarketStateFile = void 0;
exports.indexErrorOf = indexErrorOf;
exports.marketLogLine = marketLogLine;
// The marketplace index client (R20-R24): fetches the signed head, verifies it with the index keys, fetches the catalog it names, caches
// the three files and re-verifies them at every load. No Electron: every effect goes through MarketClientDeps (wire.ts passes the real
// ones; selftest-market-client.ts fakes the clock and the timers and runs the real fetch and fs against test/fake-release/server.mjs).
// Trust, in this order, on every check (nothing here skips a step):
//  1. GET the head and its signature (fetchBounded: a byte cap and a time limit each, no query, no cookie, the fixed User-Agent);
//  2. verifyIndexHead: the minisign signature with the keys given (the index keys only: trustedKeys('index', ...)), the head parser, the
//     trusted comment against the parsed `generated` (indexformat.ts). Only now is any field of the head used;
//  3. anti-rollback (R23) against state.json `seen` and the head held in memory: an older `generated`, or the same `generated` with
//     another catalog hash, is `rollback`;
//  4. the catalog: the held one when the head names its hash and catalog.json on disk is it (CORE M1), else downloaded with the declared
//     size as the byte cap and checked against the head's size and SHA-256 (a mismatch is `verify_failed`) before one byte of it is parsed;
//     a catalog `generated` older than the newest one seen is `rollback` too;
//  5. the cache: catalog.json, then the signature and the head, then state.json `seen` last. Nothing is written before step 4 passed.
// At load() (local, synchronous, no request) the cached head and its signature are verified again with the keys and the cached catalog is
// matched to the head and parsed again: a cached file is never used on trust. A cache older than `seen` is not held.
// The ETag sent as If-None-Match is the held head's, kept in memory: set when a commit of that head succeeded, or at load from state.json
// when its `seen` names the head load verified. A 304 therefore confirms only the head the client holds (never one a failed write left).
// The held catalog is frozen all the way down: no consumer can drop or change a revocation.
// Freshness (R23): a held head past `expires` (local clock) is stale: still held and still shown, its revocations still apply, installs
// are off. After `verify_failed`, `rollback`, `bad_index` or `too_large` (an index that fails a check of the trust chain: 10-fix2 ruling 1)
// installs and updates stay off until a head verifies again (installGate); the block is kept in state.json `blocked` (restored by load(), so
// a restart does not lift it; a state.json held by another process at load keeps installs off until it reads, CORE I1) and cleared by a
// verified head or a 304 for the held one, never by a check that holds nothing.
// `admit` (wire.ts listingAdmit: the names rule and device-name ids) drops listings from every catalog parsed, downloaded or cached.
// Schedule (R21): one check when start() runs, then every 4 h after each check ends; after `verify_failed` one retry 10 min later, then 4 h.
// checkOn() false (R31, the one "Check for updates" switch) sends nothing: no request from checkNow, no first check, a scheduled check skipped.
// checkChanged() (Task 9 m2: main.ts calls it when the app updater's setCheck changed the switch) acts at once: off ends a check in flight
// (nothing of it is written) and cancels the schedule; on runs one check now and arms the schedule again. Either way the listeners hear it
// (10-fix2 ruling 2: the Marketplace's "update checks are off" state comes and goes without a reload).
// Log (Global Constraints): `MARKET <phase> [<reason>]` once per change, plus `MARKET catalog dropped=<n>` and write failures by code;
// never a URL, a path or a value from the index.
const fs = __importStar(require("node:fs"));
const path = __importStar(require("node:path"));
const atomicfile_1 = require("../atomicfile");
const manifest_1 = require("../manifest");
const records_1 = require("./records");
const indexformat_1 = require("./indexformat");
const BLOCKS = ['verify_failed', 'rollback', 'bad_index', 'too_large'];
const isBlock = (v) => BLOCKS.includes(v);
const log = (line) => { console.log(line); };
const codeOf = (e) => { const c = e?.code; return typeof c === 'string' && /^[A-Z0-9_]{1,24}$/.test(c) ? c : 'error'; };
const isObj = (v) => typeof v === 'object' && v !== null && !Array.isArray(v);
const SHA = /^[0-9a-f]{64}$/;
/** An entity tag as RFC 9110 writes it (strong or weak): never a control character, so it is safe to send back as If-None-Match. */
const ETAG = /^(?:W\/)?"[\x21\x23-\x7e]{0,200}"$/;
const isVersion = (v) => typeof v === 'string' && v.length <= 64 && manifest_1.SEMVER.test(v);
const isId = (v) => (0, manifest_1.isPluginId)(v);
/** The ETag a response carried, when it is one that may be sent back. */
const etagOf = (v) => (typeof v === 'string' && ETAG.test(v) ? v : null);
/** Freezes a parsed JSON value and everything in it (no cycles: it came from JSON). */
function deepFreeze(v) {
    if (typeof v === 'object' && v !== null) {
        Object.freeze(v);
        for (const x of Object.values(v))
            deepFreeze(x);
    }
    return v;
}
/** The fetch results as the index client names them (B5a's updateErrorOf, with `bad_url` read as a broken index). */
function indexErrorOf(e) {
    switch (e) {
        case 'offline':
        case 'timeout': return 'offline';
        case 'http_status': return 'unavailable';
        case 'bad_url': return 'bad_index';
        case 'too_large': return 'too_large';
    }
}
/** One log line per phase change: the phase and a reason, never a URL, a path or a value from the index. */
function marketLogLine(s) {
    return s.phase === 'error' ? `MARKET error ${s.reason}` : `MARKET ${s.phase}`;
}
function readRecord(v, ok) {
    if (!isObj(v))
        return undefined;
    const out = Object.create(null); // no inherited member answers a lookup by plugin id
    for (const [k, x] of Object.entries(v))
        if (isId(k) && ok(k, x))
            out[k] = x;
    return Object.keys(out).length > 0 ? out : undefined;
}
// A folder identity as market/records.ts keeps it (decimal strings; device 0 on Windows, inode never 0).
const isDev = (v) => typeof v === 'string' && /^(0|[1-9]\d{0,19})$/.test(v);
const isIno = (v) => typeof v === 'string' && /^[1-9]\d{0,19}$/.test(v);
const isStaged = (_k, x) => isObj(x) && isVersion(x.version) && typeof x.sha256 === 'string' && SHA.test(x.sha256) && typeof x.dir === 'string' && x.dir.length > 0 && x.dir.length <= 255 && !x.dir.includes('\0')
    && ((x.dev === undefined && x.ino === undefined) || (isDev(x.dev) && isIno(x.ino)));
/** A staged entry isStaged accepted, with its known fields only: a `prev` that is no install record (nor null) or an `auto` that is no boolean reads as absent. */
function stagedCopy(x) {
    const prev = x.prev === null ? null : (0, records_1.recordOf)(x.prev);
    return {
        version: x.version, sha256: x.sha256, dir: x.dir, ...(x.dev !== undefined && x.ino !== undefined ? { dev: x.dev, ino: x.ino } : {}),
        ...(x.prev === null || prev !== null ? { prev } : {}), ...(typeof x.auto === 'boolean' ? { auto: x.auto } : {}),
    };
}
// Every revocation parseRevocation accepts reads back (Task 7 review I1): no cap on the versions (the catalog's size bounds them), the reason
// by the catalog's own rule (code points, not UTF-16 units).
const isRecordedRevocation = (_k, x) => isObj(x) && (x.versions === '*' || (Array.isArray(x.versions) && x.versions.length >= 1 && x.versions.every(isVersion)))
    && (0, indexformat_1.isRevocationReason)(x.reason) && typeof x.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(x.date);
/** state.json `revocations`: a malformed head reads as absent; an entry that is malformed is left out (its key or its value). */
function readRevocations(v) {
    if (!isObj(v) || !(0, indexformat_1.isIndexTime)(v.generated) || typeof v.catalog !== 'string' || !SHA.test(v.catalog) || !isObj(v.list))
        return undefined;
    const list = readRecord(v.list, isRecordedRevocation) ?? Object.create(null);
    for (const k of Object.keys(list)) {
        const r = list[k];
        list[k] = { versions: r.versions === '*' ? '*' : [...r.versions], reason: r.reason, date: r.date };
    }
    return { generated: v.generated, catalog: v.catalog, list };
}
/** `<dir>/state.json`: read with every known field checked (a malformed field reads as absent), patched atomically. */
class MarketStateFile {
    file;
    io;
    /** `io`: the read seam (tests: a file held by another process on Windows). */
    constructor(file, io) {
        this.file = file;
        this.io = io;
    }
    read() {
        const r = (0, atomicfile_1.readJsonDetailed)(this.file, isObj, this.io);
        const v = r.status === 'ok' && isObj(r.value) ? r.value : {};
        const out = { status: r.status };
        if (typeof v.etag === 'string' && ETAG.test(v.etag))
            out.etag = v.etag;
        const s = v.seen;
        if (isObj(s) && (0, indexformat_1.isIndexTime)(s.generated) && typeof s.catalog === 'string' && SHA.test(s.catalog)) {
            out.seen = { generated: s.generated, catalog: s.catalog };
            if ((0, indexformat_1.isIndexTime)(s.catalogGenerated))
                out.seen.catalogGenerated = s.catalogGenerated;
        }
        if (typeof v.verifiedAt === 'number' && Number.isFinite(v.verifiedAt))
            out.verifiedAt = v.verifiedAt;
        if (isBlock(v.blocked))
            out.blocked = v.blocked;
        if (typeof v.autoPlugins === 'boolean')
            out.autoPlugins = v.autoPlugins;
        const skipped = readRecord(v.skipped, (_k, x) => isVersion(x));
        if (skipped)
            out.skipped = skipped;
        const refused = readRecord(v.refused, (_k, x) => isVersion(x));
        if (refused)
            out.refused = refused;
        const notified = readRecord(v.notifiedRevoked, (_k, x) => isVersion(x) || x === '*');
        if (notified)
            out.notifiedRevoked = notified;
        const staged = readRecord(v.staged, isStaged);
        if (staged) {
            for (const k of Object.keys(staged))
                staged[k] = stagedCopy(staged[k]);
            out.staged = staged;
        }
        const revocations = readRevocations(v.revocations);
        if (revocations)
            out.revocations = revocations;
        return out;
    }
    /**
     * Merges `p` into the file (keys it does not know are kept; a key given as undefined is removed) and writes it atomically. False when
     * it could not be written, or when the file is held by another process (Windows): a good file is never replaced by a partial one.
     */
    patch(p) {
        try {
            const r = (0, atomicfile_1.readJsonDetailed)(this.file, isObj, this.io);
            if (r.status === 'busy')
                return false;
            const v = { ...(r.status === 'ok' && isObj(r.value) ? r.value : {}), ...p }; // JSON leaves out a key set to undefined
            fs.mkdirSync(path.dirname(this.file), { recursive: true });
            (0, atomicfile_1.writeFileAtomic)(this.file, JSON.stringify(v, null, 2) + '\n');
            return true;
        }
        catch (e) {
            log(`MARKET state_write_failed ${codeOf(e)}`);
            return false;
        }
    }
}
exports.MarketStateFile = MarketStateFile;
/** A cached file, read with its cap (no link followed, a regular file only), or null. */
function readCached(file, max) {
    try {
        const b = (0, manifest_1.readRegularFile)(file, 'market cache', max, m => new Error(m));
        return b.length > 0 ? b : null;
    }
    catch {
        return null;
    }
}
const seenOf = (head, catalog) => ({ generated: head.generated, catalog: head.catalog.sha256, catalogGenerated: catalog.generated });
/** 'rollback' when the head is behind `floor`, 'same' when it is the floor's index, 'newer' otherwise (R23). */
function headVersus(head, floor) {
    if (!floor)
        return 'newer';
    const g = Date.parse(head.generated), f = Date.parse(floor.generated);
    if (g < f)
        return 'rollback';
    if (g === f)
        return head.catalog.sha256 === floor.catalog ? 'same' : 'rollback';
    return 'newer';
}
/** A catalog older than the newest catalog seen (t2 carry 2: a re-signed head may name an older catalog, never one older than seen). */
const catalogBehind = (catalog, floor) => !!floor?.catalogGenerated && Date.parse(catalog.generated) < Date.parse(floor.catalogGenerated);
class MarketClient {
    d;
    st = { phase: 'idle', held: null };
    held = null;
    cat = null;
    heldSeen = null; // `seen` of the held index (the floor when state.json lost it)
    etag = null; // the held head's ETag: sent as If-None-Match, so a 304 can confirm only the head held
    blocked = null; // installs off until a head verifies again (R23)
    blockUnsaved = false; // state.json `blocked` may differ from `blocked` (its write failed): written again at the next set()
    blockUnknown = false; // CORE I1: state.json was held by another process at load: its `blocked` is read again (installGate) before installs open
    blockTriedAt = 0;
    loaded = false;
    started = false;
    stopped = false;
    retryUsed = false;
    cycleP = null;
    cycleGen = 0; // the checkGen the check in flight started under
    checkGen = 0; // goes up when the switch goes off: a check started before changes nothing after its fetch
    tickCancel = null; // the next scheduled check
    fetchAbort = null;
    cancels = new Set();
    listeners = new Set();
    told = 0; // how many times the listeners were told (checkChanged tells them once when no check did)
    store;
    files;
    constructor(d) {
        this.d = d;
        this.store = new MarketStateFile(path.join(d.dir, 'state.json'), d.stateIO);
        this.files = { head: path.join(d.dir, 'index.json'), sig: path.join(d.dir, 'index.json.minisig'), catalog: path.join(d.dir, 'catalog.json') };
    }
    /** The state; a held head that expired since it was last checked reads as stale. */
    state() {
        const s = this.st;
        if ((s.phase === 'ok' || s.phase === 'idle') && s.held && this.expired(s.held))
            return copy({ phase: 'stale', held: s.held, checkedAt: s.phase === 'ok' ? s.checkedAt : null });
        return copy(s);
    }
    /** The verified catalog held (fresh, stale, or kept after a failed check), or null; frozen. Its revocations apply in every one of those. */
    catalog() { return this.cat; }
    /** R24: the marketplace shows only while a verified catalog is held. */
    visible() { return this.held !== null; }
    onChange(fn) { this.listeners.add(fn); return () => { this.listeners.delete(fn); }; }
    /** R31: the "Check for updates" switch as this client reads it (off: no request; a switch that throws reads as off). */
    checksOn() { return this.checkOn(); }
    /** R26's first precondition: a verified catalog, no failed verify, rollback, broken or oversized index since, not past `expires`. */
    installGate() {
        if (!this.held)
            return { ok: false, reason: 'none' };
        if (this.blockUnknown && !this.readBlock())
            return { ok: false, reason: 'none' }; // fail closed until state.json reads (CORE I1)
        if (this.blocked)
            return { ok: false, reason: this.blocked };
        if (this.expired(this.held))
            return { ok: false, reason: 'stale' };
        return { ok: true };
    }
    /** The cache, verified again (local only, no request). Runs once; main.ts calls it before any plugin starts (R28). */
    load() {
        if (this.loaded)
            return;
        this.loaded = true;
        if (this.d.keys.length > 0)
            this.loadCache();
        this.blockUnknown = true;
        this.readBlock(); // a block of an earlier run still holds (3b review ruling b; any InstallBlock, 10-fix2)
        if (!this.configured())
            this.set({ phase: 'error', reason: 'unconfigured', held: this.held, checkedAt: null });
        else if (this.held && this.expired(this.held))
            this.set({ phase: 'stale', held: this.held, checkedAt: null });
        else
            this.set({ phase: 'idle', held: this.held });
    }
    /** The first check now (R21: main.ts calls it right after the registry's discovery), then the schedule. Nothing when unconfigured or off. */
    start() {
        if (this.started || this.stopped)
            return;
        this.started = true;
        this.load();
        if (!this.configured() || !this.checkOn())
            return;
        this.tick();
    }
    /**
     * R31, Task 9 m2: the "Check for updates" switch changed (main.ts: the app updater's setCheck, through market/wire.ts UpdateCheckSwitch);
     * checkOn() tells which way. Off: the schedule is cancelled and a check in flight ends at once (its requests are aborted, nothing of it is
     * written, the held index stays); checkNow sends nothing until it is on. On: one check now, then the schedule (also when start() found the
     * switch off). No check before start(), after stop() or while unconfigured. The listeners hear every call but after stop() (10-fix2 ruling
     * 2): the state a check set, or else the state as it is (no log line: the phase did not change), so a view that shows the switch is drawn again.
     */
    checkChanged() {
        if (this.stopped)
            return;
        const told = this.told;
        if (this.started && !this.checkOn()) {
            this.checkGen++;
            this.tickCancel?.();
            this.tickCancel = null;
            this.fetchAbort?.abort();
            if (this.st.phase === 'checking')
                this.set({ phase: 'idle', held: this.held });
        }
        else if (this.started && this.configured())
            this.tick();
        if (this.told === told)
            this.tell(this.st);
    }
    /** Cancels the schedule and ends a check in flight at once (nothing of it is written). The held index stays. */
    stop() {
        if (this.stopped)
            return;
        this.stopped = true;
        for (const c of this.cancels) {
            try {
                c();
            }
            catch { /* gone */ }
        }
        this.cancels.clear();
        this.fetchAbort?.abort();
        if (this.st.phase === 'checking')
            this.set({ phase: 'idle', held: this.held });
    }
    /** One check now; concurrent calls share one run. Sends nothing when stopped, unconfigured or switched off (R31). */
    async checkNow() {
        this.load();
        if (this.stopped || !this.configured() || !this.checkOn())
            return this.state();
        return this.cycle();
    }
    // ---- internals ---------------------------------------------------------------------------------------------------------------
    parseOpts() {
        return { prefix: this.d.prefix, ...(this.d.admit ? { admit: this.d.admit } : {}) };
    }
    configured() {
        return this.d.keys.length > 0 && this.d.indexUrl !== null && this.d.indexUrl === `${this.d.prefix}index.json`;
    }
    checkOn() { try {
        return this.d.checkOn() === true;
    }
    catch {
        return false;
    } }
    expired(h) { return this.d.now() > Date.parse(h.expires); }
    set(s) {
        if (this.blockUnsaved)
            this.saveBlock(); // 6c review m6: a block (or its lift) that could not be written is tried again
        this.st = s;
        log(marketLogLine(s)); // every set() is a change of phase or reason
        this.tell(s);
    }
    /** The listeners, with a copy of `s`. */
    tell(s) {
        this.told++;
        for (const fn of [...this.listeners]) {
            try {
                fn(copy(s));
            }
            catch { /* a listener must not break the client */ }
        }
    }
    /**
     * state.json `blocked` into memory while it is unknown (CORE I1: a busy read is no lifted block). True once read (ok, missing, or
     * quarantined: what a corrupt file held is gone). While it is held, one read a second at most (each busy read waits for the file).
     */
    readBlock() {
        if (!this.blockUnknown)
            return true;
        const now = this.d.now();
        if (this.blockTriedAt !== 0 && now - this.blockTriedAt < 1000)
            return false;
        this.blockTriedAt = now;
        const r = this.store.read();
        if (r.status === 'busy') {
            log('MARKET state_busy');
            return false;
        }
        this.blocked = r.blocked ?? null;
        this.blockUnknown = false;
        return true;
    }
    /** `blocked` to state.json (a lift removes the key) with `extra`; a failed write leaves it pending for the next set(). */
    saveBlock(extra = {}) {
        this.blockUnsaved = !this.store.patch({ ...extra, blocked: this.blocked ?? undefined });
    }
    /** A timer that stop() cancels; the returned function cancels it alone. */
    schedule(fn, ms) {
        if (this.stopped)
            return () => { };
        let cancel = () => { };
        cancel = this.d.later(() => { this.cancels.delete(cancel); fn(); }, ms);
        this.cancels.add(cancel);
        return () => { this.cancels.delete(cancel); cancel(); };
    }
    /**
     * One check now, then the next 4 h after it ended (10 min after a first verify_failed). Switched off by the time it comes (without
     * checkChanged: the switch read again), it sends nothing and the schedule goes on. Never two schedules: a pending tick goes first, and a
     * check the switch ended sets none.
     */
    tick() {
        this.tickCancel?.();
        this.tickCancel = null;
        if (this.stopped)
            return;
        if (!this.checkOn()) {
            this.next(indexformat_1.INDEX_EVERY_MS);
            return;
        }
        const g = this.checkGen;
        void this.cycle().then(s => {
            if (this.stopped || g !== this.checkGen)
                return; // switched off meanwhile: checkChanged cancelled the schedule (on again: a new tick)
            const failed = s.phase === 'error' && s.reason === 'verify_failed';
            let ms = indexformat_1.INDEX_EVERY_MS;
            if (failed && !this.retryUsed) {
                this.retryUsed = true;
                ms = indexformat_1.INDEX_RETRY_MS;
            }
            else if (!failed)
                this.retryUsed = false;
            this.next(ms);
        });
    }
    next(ms) { this.tickCancel?.(); this.tickCancel = this.schedule(() => { this.tickCancel = null; this.tick(); }, ms); }
    /** The cached head, signature and catalog, verified as on a download; held only when not behind `seen`. */
    loadCache() {
        const head = readCached(this.files.head, indexformat_1.MAX_HEAD_BYTES), sig = readCached(this.files.sig, indexformat_1.MAX_INDEX_SIG_BYTES), cat = readCached(this.files.catalog, indexformat_1.MAX_CATALOG_BYTES);
        if (!head && !sig && !cat)
            return; // no cache yet
        const refuse = () => { log('MARKET cache_refused'); };
        if (!head || !sig || !cat)
            return refuse();
        const v = (0, indexformat_1.verifyIndexHead)(head, sig.toString('utf8'), this.d.keys, this.d.prefix);
        if (!v.ok)
            return refuse();
        let catalog;
        try {
            catalog = (0, indexformat_1.parseCatalog)(cat, v.head, this.parseOpts());
        }
        catch {
            return refuse();
        } // its size and SHA-256 against the head first
        const s = this.store.read();
        if (headVersus(v.head, s.seen ?? null) === 'rollback' || catalogBehind(catalog, s.seen ?? null))
            return refuse();
        const seen = seenOf(v.head, catalog);
        // The cache is newer than `seen` (a run ended between the cache and state.json): `seen` catches up, so the floor never falls back.
        // state.json's ETag stands for this head only when its `seen` already named it (commit clears the ETag before it writes a new head).
        // The same `generated` is the same head: headVersus refused one with another catalog above.
        const named = s.seen?.generated === seen.generated;
        if (!s.seen || s.seen.generated !== seen.generated || s.seen.catalogGenerated !== seen.catalogGenerated)
            this.store.patch({ seen });
        let verifiedAt = s.verifiedAt;
        if (verifiedAt === undefined) {
            try {
                verifiedAt = fs.statSync(this.files.head).mtimeMs;
            }
            catch {
                verifiedAt = this.d.now();
            }
        }
        this.adopt(v.head, catalog, verifiedAt, named ? etagOf(s.etag) : null);
    }
    /** Holds a verified head and its catalog (frozen); `etag` is that head's, or null when none was stored for it. */
    adopt(head, catalog, verifiedAt, etag) {
        if (catalog.dropped > 0 && (!this.cat || this.held?.catalogSha256 !== head.catalog.sha256))
            log(`MARKET catalog dropped=${catalog.dropped}`);
        this.held = { generated: head.generated, expires: head.expires, verifiedAt, catalogSha256: head.catalog.sha256, catalogSize: head.catalog.size };
        this.cat = deepFreeze(catalog);
        this.heldSeen = seenOf(head, catalog);
        this.etag = etag;
    }
    cycle() {
        if (this.cycleP) {
            if (this.cycleGen === this.checkGen)
                return this.cycleP;
            // The check in flight is one the switch ended (off, then on again before it settled): a new one runs once it has.
            return this.cycleP.then(() => (this.stopped || !this.checkOn() ? this.state() : this.cycle()));
        }
        const g = this.checkGen;
        this.cycleGen = g;
        const p = this.runCheck(g).catch((e) => {
            log(`MARKET check_failed ${codeOf(e)}`); // a bug or an fs throw: never a crash, never a message (it may carry a path)
            if (!this.stopped && g === this.checkGen)
                this.set({ phase: 'error', reason: 'disk', held: this.held, checkedAt: this.d.now() });
            return this.state();
        }).finally(() => { if (this.cycleP === p)
            this.cycleP = null; });
        this.cycleP = p;
        return p;
    }
    async runCheck(g) {
        this.set({ phase: 'checking', held: this.held });
        const ac = new AbortController();
        this.fetchAbort = ac;
        let r;
        try {
            r = await this.fetchIndex(ac.signal);
        }
        finally {
            if (this.fetchAbort === ac)
                this.fetchAbort = null;
        }
        if (this.stopped || g !== this.checkGen)
            return this.state(); // stop() or the switch turned off ended it: nothing changes, nothing is written
        const now = this.d.now();
        if (r.kind === 'error') {
            if (isBlock(r.reason)) {
                this.blocked = r.reason;
                this.blockUnknown = false; // a check decided it: what state.json held before no longer matters
                if (this.held)
                    this.saveBlock(); // with nothing held there is nothing to install from (and nothing is written)
            }
            this.set({ phase: 'error', reason: r.reason, held: this.held, checkedAt: now });
            return this.state();
        }
        if (r.kind === 'not_modified') {
            // A 304 answers only a request that named the held head's ETag: the server still serves the head this client verified.
            const h = this.held;
            this.held = { ...h, verifiedAt: now };
            this.blocked = null;
            this.blockUnknown = false; // a check decided it: what state.json held before no longer matters
            this.saveBlock({ verifiedAt: now });
            return this.settle(now);
        }
        const written = this.commit(r.x, now);
        // Verified: its revocations apply even when the cache could not be written. Its ETag only when stored with it: after a failed write
        // state.json may still carry the previous head's ETag, and the next request sends none.
        this.adopt(r.x.head, r.x.catalog, now, written ? etagOf(r.x.etag) : null);
        this.blocked = null;
        this.blockUnknown = false; // a check decided it: what state.json held before no longer matters
        // The commit wrote the lift with the head; a commit that failed leaves state.json as it was, so a block written before holds at the next
        // start (it fails closed) until a head is committed, and no block that is still pending is written over the head just verified.
        this.blockUnsaved = false;
        if (!written) {
            this.set({ phase: 'error', reason: 'disk', held: this.held, checkedAt: now });
            return this.state();
        }
        return this.settle(now);
    }
    settle(now) {
        const h = this.held;
        this.set(this.expired(h) ? { phase: 'stale', held: h, checkedAt: now } : { phase: 'ok', held: h, checkedAt: now });
        return this.state();
    }
    /** Steps 1-4 of the trust chain: a verified head and its catalog, a 304 for the held head, or the error to show. */
    async fetchIndex(signal) {
        const url = this.d.indexUrl;
        const opts = (maxBytes) => ({ maxBytes, timeoutMs: indexformat_1.INDEX_TIMEOUT_MS, userAgent: this.d.userAgent, allowLoopbackHttp: this.d.allowLoopbackHttp, signal });
        const st = this.store.read();
        const etag = this.held ? this.etag : null; // the held head's own (memory, never state.json): a 304 must stand for the head held
        const hr = await this.d.fetch(url, { ...opts(indexformat_1.MAX_HEAD_BYTES), etag });
        if (!hr.ok)
            return { kind: 'error', reason: indexErrorOf(hr.error) };
        if (hr.status === 304)
            return etag && this.held ? { kind: 'not_modified' } : { kind: 'error', reason: 'unavailable' };
        const sr = await this.d.fetch(`${url}.minisig`, opts(indexformat_1.MAX_INDEX_SIG_BYTES));
        if (!sr.ok)
            return { kind: 'error', reason: indexErrorOf(sr.error) };
        if (sr.status !== 200)
            return { kind: 'error', reason: 'unavailable' };
        const sigText = sr.body.toString('utf8');
        const v = (0, indexformat_1.verifyIndexHead)(hr.body, sigText, this.d.keys, this.d.prefix);
        if (!v.ok)
            return { kind: 'error', reason: v.reason };
        const head = v.head;
        const floors = [st.seen ?? null, this.heldSeen];
        if (floors.some(f => headVersus(head, f) === 'rollback'))
            return { kind: 'error', reason: 'rollback' };
        let catalog, catBytes = null;
        // The same catalog (its SHA-256 and its declared size): not downloaded again, while catalog.json on disk is that catalog. A copy that is
        // not (a write that failed, a file lost or damaged since) is fetched again, so the commit writes it (final review CORE M1).
        if (this.held && this.cat && this.held.catalogSha256 === head.catalog.sha256 && this.held.catalogSize === head.catalog.size && this.catalogCached(head))
            catalog = this.cat;
        else {
            const cr = await this.d.fetch(head.catalog.url, opts(head.catalog.size)); // the declared size is the cap: a longer body is too_large
            if (!cr.ok)
                return { kind: 'error', reason: indexErrorOf(cr.error) };
            if (cr.status !== 200)
                return { kind: 'error', reason: 'unavailable' };
            if (!(0, indexformat_1.catalogMatches)(cr.body, head))
                return { kind: 'error', reason: 'verify_failed' };
            try {
                catalog = (0, indexformat_1.parseCatalog)(cr.body, head, this.parseOpts());
            }
            catch (e) {
                return { kind: 'error', reason: e?.code === 'too_large' ? 'too_large' : 'bad_index' };
            }
            catBytes = cr.body;
        }
        if (floors.some(f => catalogBehind(catalog, f)))
            return { kind: 'error', reason: 'rollback' };
        return { kind: 'fresh', x: { head, headBytes: hr.body, sigText, catalog, catBytes, etag: hr.etag } };
    }
    /** catalog.json on disk is the catalog `head` names (its size and SHA-256). */
    catalogCached(head) {
        const b = readCached(this.files.catalog, indexformat_1.MAX_CATALOG_BYTES);
        return b !== null && (0, indexformat_1.catalogMatches)(b, head);
    }
    /** Step 5: the old ETag goes first (it must never stand for the new head), then catalog.json, the signature, the head, `seen` last. */
    commit(x, now) {
        try {
            fs.mkdirSync(this.d.dir, { recursive: true });
            if (this.store.read().etag !== undefined && !this.store.patch({ etag: undefined }))
                return false;
            if (x.catBytes)
                (0, atomicfile_1.writeFileAtomic)(this.files.catalog, x.catBytes);
            (0, atomicfile_1.writeFileAtomic)(this.files.sig, x.sigText);
            (0, atomicfile_1.writeFileAtomic)(this.files.head, x.headBytes);
        }
        catch (e) {
            log(`MARKET cache_write_failed ${codeOf(e)}`);
            return false;
        }
        return this.store.patch({ seen: seenOf(x.head, x.catalog), etag: etagOf(x.etag) ?? undefined, verifiedAt: now, blocked: undefined });
    }
}
exports.MarketClient = MarketClient;
function copy(s) { return { ...s, held: s.held ? { ...s.held } : null }; }
