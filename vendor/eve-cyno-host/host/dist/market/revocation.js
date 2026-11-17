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
exports.Revocations = void 0;
exports.revocationAmong = revocationAmong;
// Revocation (R28; plan Task 7): plugins and theme packages the marketplace revoked, by id, over every root (marketplace, manual and bundled
// plugins), for the versions listed or '*'. Pure: the index client, the registry, the theme service and the notice center come in as deps.
//  - Where a revocation comes from. The verified catalog the index client holds (fresh, stale, or kept after a failed check) and the
//    revocations applied before, kept in market/state.json `revocations` with the head they came from (3b review ruling a). Only a FRESH
//    verified catalog (installGate ok: held, not past `expires`, no failed verify or rollback since) whose head is at least as new as that
//    record is the one source; a revocation it does not list is lifted. In every other case (no catalog held because the cache was refused
//    or lost between its writes, a stale index, a rollback, an older cache after a failed cache write) the record applies too, so nothing
//    lifts a revocation: a stale or rolled-back state never undoes one, and `held` null never does.
//  - apply() runs on every index change (MarketClient.onChange) and once after the registry's discovery (main.ts). The registry hook
//    (RegistryDeps.revoked = revocationOf) stops a plugin registered at a revoked version before anything starts it; applyRevocations
//    disables a running one at once (the egress proxy first, then the page) and lifts one no longer revoked.
//  - The record is the catalog's list as parseRevocation accepts it: every entry of an id (merged into one, its versions uncut), each
//    reason by the catalog's rule, so a restart that holds no catalog applies exactly what was applied.
//  - One notice per id and version (state.json `notifiedRevoked`): a refresh or a restart does not repeat it; a lift forgets it, so the same
//    version revoked again is told again. The notice is posted even when the file cannot be written (the user must hear it); the write is
//    tried again at the next apply.
//  - A revoked theme package that was added is removed (ThemeService.remove: the stored theme falls back to Cyno). A bundled theme package
//    is never revocable (values only; it changes with the app).
//  - Nothing of a revoked plugin's data is removed: no A5 wipe, no storage, no grant, no files. It stays installed and disabled.
//  - state.json held by another process (Windows) is no empty record (final review CORE I1): the catalog alone applies, nothing is written,
//    and the next apply() reads it again.
// Versions match by semver equality (build metadata does not count); a version that is not semver matches only '*'.
// Log lines: `MARKET revoked <id> <version>`, `MARKET revoked_theme <id> <version>` and write failures by code; never a path or a reason.
const semver = __importStar(require("semver"));
const hostnotices_1 = require("../hostnotices");
const log = (line) => { console.log(line); };
const codeOf = (e) => { const c = e?.code; return typeof c === 'string' && /^[A-Za-z_]{1,32}$/.test(c) ? c : 'error'; };
/** The revocation in `list` of `id` at `version` ('*' or a version listed, by semver equality), or null. */
function revocationAmong(list, id, version) {
    const v = semver.valid(version);
    return list.find(r => r.id === id && (r.versions === '*' || (v !== null && r.versions.some(x => semver.valid(x) !== null && semver.eq(x, v))))) ?? null;
}
const toList = (rec) => rec ? Object.keys(rec).map(id => ({ id, versions: rec[id].versions, reason: rec[id].reason, date: rec[id].date })) : [];
const recorded = (r) => ({ versions: r.versions === '*' ? '*' : [...r.versions], reason: r.reason, date: r.date });
/**
 * One id's two revocations as one: every version of either, uncut ('*' when either says so); the reason and date of `text`. Two entries
 * of one id in one catalog, or the record and a catalog that is not the authority.
 */
function merged(a, b, text) {
    const versions = a.versions === '*' || b.versions === '*' ? '*' : [...new Set([...a.versions, ...b.versions])];
    return { versions, reason: text.reason, date: text.date };
}
const isNewer = (a, b) => Date.parse(a.generated) > Date.parse(b.generated);
const sameRecord = (a, b) => a !== null && a.generated === b.generated && a.catalog === b.catalog
    && JSON.stringify(Object.keys(a.list).sort().map(k => [k, a.list[k]])) === JSON.stringify(Object.keys(b.list).sort().map(k => [k, b.list[k]]));
class Revocations {
    d;
    rec = null;
    recUnsaved = false;
    unread = true; // CORE I1: state.json not read yet (held by another process): nothing of it is written over, apply() reads it again
    notified = Object.create(null);
    notifiedUnsaved = false;
    removing = new Set();
    fns = new Set();
    applying = false;
    again = false;
    constructor(d) {
        this.d = d;
        this.load();
        d.client.onChange(() => this.apply());
    }
    /**
     * The record and the notices told from state.json, once it reads (ok, missing, or corrupt and moved aside). A busy read (Windows: another
     * process holds the file) is no empty record: until a later apply() reads it, the catalog alone applies and nothing is written. Notices
     * told meanwhile are kept with the ones read.
     */
    load() {
        const s = this.d.state.read();
        if (s.status === 'busy') {
            log('MARKET revocation_state_busy');
            return;
        }
        this.unread = false;
        this.rec = s.revocations ?? null;
        const told = Object.keys(this.notified).length > 0;
        for (const [id, v] of Object.entries(s.notifiedRevoked ?? {}))
            if (!Object.hasOwn(this.notified, id))
                this.notified[id] = v;
        if (told)
            this.notifiedUnsaved = true;
    }
    /** The revocation that covers `version` of `id`, or null: the registry's hook, the installer's check, the Marketplace page's marker. */
    revocationOf(id, version) {
        const s = this.sources();
        return (s.catalog ? revocationAmong(s.catalog.revoked, id, version) : null) ?? revocationAmong(toList(s.record), id, version);
    }
    /** `fn` runs after an apply() that changed what is revoked (a plugin named, a revocation recorded or lifted, a theme package removed). */
    onChange(fn) { this.fns.add(fn); return () => { this.fns.delete(fn); }; }
    /** Applies the revocations now (see the header). Never throws; a call made while one runs is folded into it. */
    apply() {
        if (this.applying) {
            this.again = true;
            return;
        }
        this.applying = true;
        let changed = false;
        try {
            do {
                this.again = false;
                try {
                    changed = this.applyOnce() || changed;
                }
                catch (e) {
                    log(`MARKET revocation_failed ${codeOf(e)}`);
                }
            } while (this.again);
        }
        finally {
            this.applying = false;
        }
        if (changed)
            for (const fn of [...this.fns]) {
                try {
                    fn();
                }
                catch { /* a listener must not stop the others */ }
            }
    }
    // ---- internals ---------------------------------------------------------------------------------------------------------------
    /** The catalog held, and the record when it still applies (see the header); `authority`: the fresh head that alone decides now. */
    sources() {
        const catalog = this.d.client.catalog();
        const held = this.d.client.state().held;
        const fresh = catalog !== null && held !== null && this.d.client.installGate().ok;
        const authority = fresh && (this.rec === null || isNewer(held, this.rec) || (held.generated === this.rec.generated && held.catalogSha256 === this.rec.catalog))
            ? { generated: held.generated, catalog: held.catalogSha256 } : null;
        return { catalog, record: authority ? null : this.rec?.list ?? null, authority };
    }
    applyOnce() {
        let changed = false;
        if (this.unread)
            this.load();
        // The record and the theme side each in their own try: a throw there never skips the registry (Task 7 review m1).
        try {
            changed = this.record();
        }
        catch (e) {
            log(`MARKET revocation_record_failed ${codeOf(e)}`);
        }
        const ids = this.d.registry.applyRevocations();
        for (const id of ids) {
            const m = this.d.registry.manifestOf(id);
            if (!m)
                continue;
            log(`MARKET revoked ${id} ${m.version}`);
            changed = true;
            if (this.notified[id] === m.version)
                continue; // told already (this run or an earlier one)
            this.notified[id] = m.version;
            this.notifiedUnsaved = true;
            try {
                this.d.notice((0, hostnotices_1.revokedNotice)(this.d.nameOf(id)));
            }
            catch (e) {
                log(`MARKET revoked_notice_failed ${codeOf(e)}`);
            }
        }
        // A lifted revocation forgets its notice (m2): the same version revoked again later is told again.
        for (const id of Object.keys(this.notified)) {
            if (this.revocationOf(id, this.notified[id]) !== null)
                continue;
            delete this.notified[id];
            this.notifiedUnsaved = true;
        }
        if (this.notifiedUnsaved && !this.unread)
            this.notifiedUnsaved = !this.d.state.patch({ notifiedRevoked: { ...this.notified } });
        try {
            for (const id of this.d.themes.addedIds()) {
                const v = this.d.themes.versionOf(id);
                if (v === null || this.removing.has(id) || this.revocationOf(id, v) === null)
                    continue;
                this.removing.add(id);
                changed = true;
                log(`MARKET revoked_theme ${id} ${v}`);
                void this.d.themes.remove(id).catch(e => log(`MARKET revoked_theme_remove_failed ${codeOf(e)}`)).finally(() => { this.removing.delete(id); });
            }
        }
        catch (e) {
            log(`MARKET revoked_theme_failed ${codeOf(e)}`);
        }
        return changed;
    }
    /**
     * Keeps the revocations that apply to what is here (a registered plugin, an added theme package, or an id recorded before) in state.json
     * with the newest head they came from. The fresh authority replaces the record (a revocation it does not list is gone); otherwise the
     * record only grows. True when the record changed.
     */
    record() {
        if (this.unread)
            return false; // the record on disk is unknown: never written over (CORE I1)
        const s = this.sources();
        const here = new Set(this.d.themes.addedIds());
        const relevant = (id) => here.has(id) || this.d.registry.manifestOf(id) !== undefined || (this.rec !== null && Object.hasOwn(this.rec.list, id));
        const list = Object.create(null);
        if (!s.authority && this.rec)
            for (const k of Object.keys(this.rec.list))
                list[k] = this.rec.list[k];
        const fromCatalog = new Set();
        for (const r of s.catalog?.revoked ?? []) {
            if (!relevant(r.id))
                continue;
            const add = recorded(r);
            if (!Object.hasOwn(list, r.id))
                list[r.id] = add;
            // A second entry of one id in this catalog: both kept, the first entry's text (the one revocationAmong finds first). The record and a
            // catalog that is not the authority: both kept, the catalog's text.
            else if (fromCatalog.has(r.id))
                list[r.id] = merged(list[r.id], add, list[r.id]);
            else
                list[r.id] = merged(list[r.id], add, add);
            fromCatalog.add(r.id);
        }
        const held = this.d.client.state().held;
        let stamp = s.authority ?? (this.rec ? { generated: this.rec.generated, catalog: this.rec.catalog } : null);
        if (!s.authority && held && s.catalog && (!stamp || isNewer(held, stamp)))
            stamp = { generated: held.generated, catalog: held.catalogSha256 };
        if (!stamp)
            return false; // nothing held, nothing recorded: nothing to keep
        const next = { generated: stamp.generated, catalog: stamp.catalog, list };
        if (sameRecord(this.rec, next)) {
            if (this.recUnsaved)
                this.recUnsaved = !this.save(next);
            return false;
        }
        const lifted = this.rec !== null && Object.keys(this.rec.list).some(k => !Object.hasOwn(list, k));
        const added = Object.keys(list).some(k => this.rec === null || !Object.hasOwn(this.rec.list, k));
        this.rec = next;
        this.recUnsaved = !this.save(next);
        return lifted || added;
    }
    save(r) {
        return this.d.state.patch({ revocations: { generated: r.generated, catalog: r.catalog, list: { ...r.list } } });
    }
}
exports.Revocations = Revocations;
