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
exports.PluginUpdates = void 0;
// Staged plugin updates (R29, D28, D29; plan Task 8). Pure Node, no Electron: main.ts wires the real parts, the self-test fakes the network.
//
// Candidate: the newest version the verified catalog lists above the installed one whose `engines` admits HOST_API.version (never across an
// API major) and that is not revoked. Only plugins registered from the installed root (marketplace or manual), never a bundled id; theme
// packages that were added (never a bundled one, never an older version: no downgrade). Checked after every catalog change and every registry
// change (`refresh`).
//
// Review: an update whose manifest asks for more than the plugin's grant, whose Allow would fire the A5 reset, or that would newly run in the
// background (grants.ts reviewNeeded); and, failing closed (Task 8 review I3), every update of a copy that is not the marketplace's (records
// sourceOf: manual) or whose name or author is not the installed one's (`identity` on the row says what changed). Before it is staged the
// listing's permissions, name and author stand in for the manifest's (the catalog check makes them equal); once staged, the staged manifest
// decides (it also says whether the new version provides a service or runs in the background, which the listing does not). A review update
// never prompts by itself: it is listed with `review` and the prompt opens on the user's `update(id)` (with `previous`, "Keep <installed>", the
// new author and the marketplace as the source). Keep: the staged copy goes, `skipped[id] = version` in market/state.json, no grant is
// written. A newer version clears the skip; `force` prompts again.
//
// Plain update with "Update plugins automatically" on (default): downloaded and staged at once (Installer.stage: the catalog's own version, its
// size and SHA-256 checked, the manifest compared with the listing), then swapped while the plugin is not running (stopped, suspended or
// disabled) and no grant decision of it is open, else when it next stops, or at the next start by `applyStaged()`, before any plugin is
// registered. One notice per update applied by itself. With the switch off, or the app's "Check for updates" off (R31: plugin updates stop
// too), nothing is fetched or applied by itself, at a start included, until the user's `update(id)`. Switching "Check for updates" off ends an
// automatic download in flight at once (`checkChanged`, Task 9 m2: the copy goes, nothing is staged, the row stays available; on: a new look,
// which fetches it again). Nothing is fetched while the install gate
// is closed (no verified index, stale, a failed verify or a rollback). A version the registry refused once it was swapped in (a service another
// plugin provides, the names rule) is rolled back and remembered (`refused[id] = version`): not fetched by itself again until a newer one.
//
// The swap (PluginRegistry.replaceFiles): the plugin stopped and its pages closed; the preconditions again (the gate, the same catalog version,
// not revoked, no uninstall pending, and for a plain update still no review: the grant may have changed meanwhile); the staged folder's
// identity taken BEFORE the journaled rename (swap.ts swapPluginDir) and compared with the one kept when it was staged (a folder replaced
// since is not swapped in, at a start neither: final review CORE M4), the install record written after it; the new folder registered (on
// refusal the record and then the swap roll back, and the old version is registered again). Then market/state.json loses the entry and the
// staging folder goes (with the parked `<id>.old`). A swap step that could not be undone leaves the journal, the entry and the staging folder
// for the next start (Installer.recover, then applyStaged). A failure of any other kind removes the staged copy.
// At a start the same swap runs before any plugin is registered; the parked old version stays until `confirmStarted()` (right after startAll
// registered every plugin) sees the registry hold the new one, else it is put back, registered and started as startAll would.
// Right before every swap its staged entry gets the install record it replaces (`prev`) and whether it applies by itself (`auto`), and no
// swap runs when that cannot be written: a crash after the swap leaves the next start's repair the record to put back with the old version
// and the notice it owes (8-fix2 Minors 1, 3). While the old version is parked the repair never removes it: one that cannot finish (the
// installed folder unreadable for a moment, the record not written) leaves the entry and the folder for the next start (Minor 2).
// State: market/state.json `staged[id] = {version, sha256, dir: '<random>/<id>', dev, ino, prev?, auto?}` (relative to the staging root; the
// staged folder's identity), `skipped`, `refused`, `autoPlugins`.
// Log lines: `MARKET update_<what> <id> [<version>|<code>]`; never a path, a URL or a value from an archive.
const path = __importStar(require("node:path"));
const semver = __importStar(require("semver"));
const grants_1 = require("../grants");
const hostnotices_1 = require("../hostnotices");
const manifest_1 = require("../manifest");
const loader_1 = require("../loader");
const names_1 = require("./names");
const records_1 = require("./records");
const stagecheck_1 = require("./stagecheck");
const swap_1 = require("./swap");
const STAGE_DIR = /^i-[A-Za-z0-9]{1,32}$/; // Installer.makeStaging's <random>
const log = (line) => { console.log(line); };
const codeOf = (e) => { const c = e?.code; return typeof c === 'string' && /^[A-Za-z_]{1,32}$/.test(c) ? c : 'error'; };
const samePath = (a, b) => path.relative(a, b) === '';
class UpdateFail extends Error {
    error;
    constructor(error) {
        super(`update: ${error}`);
        this.error = error;
    }
}
class NeedsReview extends Error {
    constructor() { super('update: needs review'); }
}
const gt = (a, b) => { try {
    return semver.gt(a, b);
}
catch {
    return false;
} };
/**
 * CORE M4, ORCH m2: the staged folder is still the one that was staged and checked (the identity state.json kept for it). What the record
 * then calls the marketplace's ("signed") is a folder installed from the marketplace by identity, not its files checked again (platform-notes).
 */
const sameStaged = (s, now) => s.dev === undefined || s.ino === undefined || (s.dev === now.dev && s.ino === now.ino);
class PluginUpdates {
    d;
    fs;
    staging;
    fns = new Set();
    tracks = new Map();
    ups = new Map();
    chains = new Map(); // one update of an id at a time (a background stage, the user's update)
    work = new Set();
    atStart = new Map();
    repairs = new Set(); // crash repairs that could not finish at this start: their entry and parked old version wait for the next one
    // `busy`: state.json was held by another process when it was read (CORE I1): the view is empty for now, nothing is written from it, and the
    // next look reads the file again.
    mem = null;
    loaded = false; // the staged entries of state.json read into `ups`
    queued = false;
    sig = '';
    bg = new AbortController(); // the automatic downloads': aborted when "Check for updates" goes off (R31)
    constructor(d) {
        this.d = d;
        this.fs = d.fs ?? (0, swap_1.productSwapFs)();
        this.staging = path.dirname(d.journal);
        d.client.onChange(() => {
            for (const [id, t] of this.tracks)
                if (t.phase === 'failed')
                    this.tracks.delete(id);
            this.refresh();
        });
        d.registry.onState(() => this.refresh());
    }
    // ---- the view --------------------------------------------------------------------------------------------------------------------
    /** Looks again (coalesced): rows, stale staged copies and skips, and the background work of the automatic updates. */
    refresh() {
        if (this.queued)
            return;
        this.queued = true;
        const p = Promise.resolve().then(() => { this.queued = false; this.check(); }).catch(e => log(`MARKET update_check_failed ${codeOf(e)}`));
        this.hold(p);
    }
    view() {
        const rows = [];
        let upToDate = 0;
        for (const l of this.d.client.catalog()?.plugins ?? []) {
            if (!this.eligible(l))
                continue;
            const c = this.candidateIn(l);
            if (c)
                rows.push(this.rowFor(c));
            else
                upToDate++;
        }
        rows.sort((a, b) => a.name.localeCompare(b.name) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
        return { index: this.d.client.state(), auto: this.auto(), rows, upToDate };
    }
    /** The update on offer for the plugin (not one the user kept the old version over), or null: the tile's and the Plugins row's "Update". */
    updateOf(id) {
        const c = this.candidateOf(id);
        if (!c)
            return null;
        const r = this.rowFor(c);
        return r.skipped ? null : { version: r.to, review: r.review };
    }
    auto() { return this.state().auto; }
    setAuto(on) {
        const s = this.state();
        s.auto = on === true;
        if (!this.d.state.patch({ autoPlugins: s.auto }))
            log('MARKET update_auto_unsaved');
        this.refresh();
        this.changed();
    }
    onChange(fn) { this.fns.add(fn); return () => { this.fns.delete(fn); }; }
    /**
     * R31, Task 9 m2: the app's "Check for updates" switch changed (main.ts, through market/wire.ts UpdateCheckSwitch); `checkOn` tells which
     * way. Off: an automatic download in flight ends at once and nothing it fetched is staged (the user's own Update goes on). Either way a new
     * look: off, nothing new is fetched or applied by itself; on, the automatic updates resume (the index client's check that follows brings
     * a newer index).
     */
    checkChanged() {
        if (!this.checkOnNow()) {
            this.bg.abort();
            this.bg = new AbortController();
        }
        this.refresh();
    }
    /** Resolves once no look and no update is running (tests). */
    async settled() {
        for (let i = 0; i < 1000 && this.work.size > 0; i++)
            await Promise.all([...this.work]);
    }
    // ---- the user's update -----------------------------------------------------------------------------------------------------------
    /**
     * The user's Update (or Review). A plain one is applied now (a running plugin restarts with it); a review one opens the prompt on the staged
     * manifest. A version the user kept the old one over is left alone unless `force` ("Update anyway"). Answers `updated`, or the row as it is.
     */
    update(id, o = {}) {
        if (typeof id !== 'string' || !(0, manifest_1.isPluginId)(id))
            return Promise.resolve(this.failRow(typeof id === 'string' ? id : '', 'not_found'));
        const force = o?.force === true;
        return this.run(id, () => this.userUpdate(id, force));
    }
    async userUpdate(id, force) {
        const c = this.candidateOf(id);
        const gate = this.d.client.installGate().ok;
        if (!c)
            return this.failRow(id, gate ? 'not_found' : 'not_allowed');
        const row = this.rowFor(c);
        if (row.skipped && !force)
            return row; // kept: nothing asked, nothing fetched
        if (!gate)
            return this.failed(c, 'not_allowed');
        if (c.type === 'theme')
            return this.themeUpdate(c, true);
        let up = this.upFor(c);
        if (!up) {
            const r = await this.stageFor(c);
            if ('error' in r)
                return this.rowFor(c);
            up = r;
        }
        const now = this.candidateOf(id);
        if (!now || now.v.version !== up.version) {
            this.drop(id);
            return this.failed(c, 'not_found');
        } // the catalog moved during the download
        return this.reviewOf(up) ? this.review(now, up) : this.swapIn(now, up, { restart: false, notice: false });
    }
    /**
     * The review prompt (`recordDeny: false`: a Deny writes nothing; `keep`: the installed version, unless it is revoked). Its `current` is the preconditions of the
     * swap, so an uninstall, a revocation or a closed gate that came while it was open leaves no grant behind. Allow: the A5 wipe (when announced)
     * after the plugin stopped and its pages closed, then the swap; nothing of the old version is stopped before the answer.
     */
    async review(c, up) {
        const id = c.id;
        const prev = this.d.registry.manifestOf(id);
        if (!prev)
            return this.failed(c, 'not_found');
        let providers;
        try {
            providers = this.d.providersFor(up.manifest);
        }
        catch {
            return this.failed(c, 'unavailable');
        }
        const before = this.d.grants.get(id);
        const identity = this.identityOf(id, prev, up.manifest); // Minor 4: the prompt shows what the row shows
        // 11-fix I1: a revoked installed version cannot run, so the prompt offers no "Keep <old>" ("Don't allow"; the plugin stays off). In doubt: none.
        const keep = this.revoked(id, prev.version) ? {} : { keep: prev.version };
        let answered = null, promptFailed = false, wipeFailed = false, stoppedLive = false;
        const prompter = {
            ask: async (req) => {
                // An optional-only ask (plan 2026-11-09, section 3.8) has no Keep: its refusal, "Not now", applies the update with the items declined, so it counts as an
                // Allow here. A Not now that ends with no grant is a failed update, never a kept (skipped) version.
                try {
                    const a = await this.d.prompter.ask(req);
                    answered = a.decision === 'allow' || req.optionalOnly === true ? 'allow' : 'deny';
                    return a;
                }
                catch (e) {
                    promptFailed = true;
                    log(`MARKET update_prompt_failed ${id} ${codeOf(e)}`);
                    throw e;
                }
            },
        };
        const hooks = {
            wipe: async (prompted) => {
                const s = this.d.registry.state(id);
                if (s === 'running' || s === 'starting')
                    stoppedLive = true;
                await this.d.registry.stopAndWait(id); // the wipe meets no live page of the plugin
                try {
                    await this.d.reset(id, prompted);
                }
                catch (e) {
                    wipeFailed = true;
                    log(`MARKET update_reset_failed ${id} ${codeOf(e)}`);
                    throw e;
                }
            },
            ...(this.d.ownerDeletes ? { narrow: async (keep) => {
                    const s = this.d.registry.state(id);
                    if (s === 'running' || s === 'starting')
                        stoppedLive = true;
                    await this.d.registry.stopAndWait(id);
                    try {
                        await this.d.ownerDeletes.narrow(id, keep, { restart: false });
                    }
                    catch (e) {
                        wipeFailed = true;
                        log(`MARKET update_narrow_failed ${id} ${codeOf(e)}`);
                        throw e;
                    }
                } } : {}),
        };
        let granted = null;
        try {
            granted = await (0, grants_1.ensureGrant)(this.d.grants, prompter, up.manifest, providers, hooks, { recordDeny: false, source: 'market', ...keep, ...(identity ? { identity } : {}), current: () => this.applyCheck(id, up) === null });
        }
        catch {
            granted = null;
        }
        // No await between the answer and replaceFiles: a start of the old version queued behind this prompt is no longer current once it begins.
        if (granted !== null)
            return this.swapIn(c, up, { restart: stoppedLive, notice: false, reviewed: true, undoGrant: { before } });
        if (stoppedLive)
            void this.d.registry.activate(id).catch(e => log(`MARKET update_restart_failed ${id} ${codeOf(e)}`)); // the old grant stands
        if (wipeFailed) {
            this.drop(id);
            return this.failed(c, 'disk');
        }
        if (promptFailed) {
            this.drop(id);
            return this.failed(c, 'unavailable');
        }
        if (answered !== 'deny') {
            this.drop(id);
            return this.failed(c, this.applyCheck(id, up) ?? 'not_found');
        } // the preconditions failed: nothing written
        // Keep: the old version stays as it is, the staged copy goes, this version is not offered by itself again.
        this.drop(id);
        this.setMark('skipped', id, up.version);
        this.tracks.delete(id);
        log(`MARKET update_kept ${id} ${up.version}`);
        this.changed();
        return this.rowFor(c);
    }
    // ---- the background --------------------------------------------------------------------------------------------------------------
    check() {
        if (this.mem?.busy) {
            this.mem = null;
            this.loaded = false;
        } // read again: what it names must not be lost or written over (CORE I1)
        const st = this.state();
        if (st.busy) {
            this.changed();
            return;
        } // still held: nothing dropped, cleared, fetched or applied until it reads (the next look)
        this.loadUps();
        const cands = new Map();
        for (const l of this.d.client.catalog()?.plugins ?? []) {
            const c = this.candidateIn(l);
            if (c)
                cands.set(c.id, c);
        }
        // A staged copy that is no longer the update on offer (a newer version, a revocation, the update applied another way) goes. An id the
        // registry does not hold (not registered yet, or uninstalled) is left to the next start.
        for (const id of new Set([...Object.keys(st.staged), ...this.ups.keys()])) {
            if (this.chains.has(id) || this.repairs.has(id) || this.d.registry.manifestOf(id) === undefined)
                continue;
            const c = cands.get(id), up = this.ups.get(id), s = Object.hasOwn(st.staged, id) ? st.staged[id] : undefined;
            const version = up?.version ?? s?.version, sha = up?.sha256 ?? s?.sha256;
            if (!c || c.type !== 'plugin' || c.v.version !== version || c.v.archive.sha256.toLowerCase() !== sha) {
                log(`MARKET update_dropped ${id}`);
                this.drop(id);
            }
        }
        // A skip (or a refusal) ends when a newer version is on offer or the installed one reached it.
        for (const key of ['skipped', 'refused']) {
            for (const [id, v] of Object.entries(st[key])) {
                const c = cands.get(id);
                const installed = this.d.registry.manifestOf(id)?.version ?? this.d.themes.list().find(p => p.id === id && p.source === 'added')?.version;
                if ((c && gt(c.v.version, v)) || (installed !== undefined && !gt(v, installed)))
                    this.setMark(key, id, undefined);
            }
        }
        if (this.autoOk()) {
            for (const c of cands.values()) {
                const now = this.state();
                if (this.chains.has(c.id) || now.skipped[c.id] === c.v.version || now.refused[c.id] === c.v.version)
                    continue; // kept, or refused by the registry (M6)
                const t = this.tracks.get(c.id);
                if (t && t.to === c.v.version)
                    continue; // downloading, applying, or failed: tried again at the next look at the index
                if (c.type === 'theme') {
                    const sig = this.bg.signal;
                    void this.run(c.id, () => this.themeUpdate(c, false, sig));
                    continue;
                }
                const up = this.upFor(c);
                if (!up) {
                    if (!this.previewReview(c))
                        void this.run(c.id, () => this.autoStage(c));
                    continue;
                }
                if (!this.reviewOf(up) && this.mayApplyNow(c.id))
                    void this.run(c.id, () => this.applyPlain(c.id));
            }
        }
        this.changed();
    }
    /** "Update plugins automatically" and the app's "Check for updates" (R31) both on: updates are fetched and applied by themselves. */
    autoOn() { return this.checkOnNow() && this.auto(); }
    /** The app's "Check for updates" (absent: on; a throw: off). */
    checkOnNow() {
        try {
            return this.d.checkOn?.() !== false;
        }
        catch {
            return false;
        }
    }
    autoOk() { return this.autoOn() && this.d.client.installGate().ok; }
    /** Not running and no grant decision of it open: a plain update may be swapped in now. */
    mayApplyNow(id) {
        const s = this.d.registry.state(id);
        return (s === 'stopped' || s === 'suspended' || s === 'disabled') && !(0, grants_1.grantPending)(this.d.grants, id);
    }
    async autoStage(c0) {
        const c = this.candidateOf(c0.id);
        if (!this.autoOk() || !c || c.type !== 'plugin' || c.v.version !== c0.v.version || this.previewReview(c))
            return null;
        const r = await this.stageFor(c, this.bg.signal);
        return 'error' in r ? null : this.applyPlain(c.id);
    }
    /**
     * A staged update applied by itself, when it needs no review (the staged manifest decides: it may provide a service the listing could not
     * show) and the plugin is (still) not running. One that needs review waits for the user's Review.
     */
    async applyPlain(id) {
        const c = this.candidateOf(id);
        const up = c ? this.upFor(c) : undefined;
        if (!c || !up)
            return null;
        if (this.reviewOf(up)) {
            log(`MARKET update_review ${id} ${up.version}`);
            this.changed();
            return null;
        }
        if (!this.autoOk() || !this.mayApplyNow(id))
            return null;
        return this.swapIn(c, up, { restart: false, notice: true });
    }
    // ---- staging and the swap --------------------------------------------------------------------------------------------------------
    /** `signal`: an automatic update's (this.bg); once it aborted ("Check for updates" off) nothing is staged, even a download that finished. */
    async stageFor(c, signal) {
        if (signal?.aborted) {
            this.stopped(c);
            return { error: 'offline' };
        }
        if (this.ups.has(c.id) || Object.hasOwn(this.state().staged, c.id))
            this.drop(c.id); // an older staged copy
        this.setTrack(c, { phase: 'downloading', progress: { received: 0, total: c.v.archive.size } });
        let s;
        try {
            s = await this.d.installer.stage(c.id, c.v, (x) => {
                if (x.phase === 'downloading')
                    this.setTrack(c, { phase: 'downloading', progress: { received: x.received, total: x.total } });
            }, signal);
        }
        catch (e) {
            log(`MARKET update_stage_bug ${c.id} ${codeOf(e)}`);
            s = { id: c.id, phase: 'failed', error: 'disk' };
        }
        if (signal?.aborted) {
            if (!('phase' in s))
                s.cleanup();
            this.stopped(c);
            return { error: 'offline' };
        }
        if ('phase' in s) {
            const error = s.phase === 'failed' ? s.error : 'disk';
            this.failed(c, error);
            return { error };
        }
        const rel = path.relative(this.staging, s.dir).split(path.sep);
        if (rel.length !== 2 || !STAGE_DIR.test(rel[0]) || rel[1] !== c.id) {
            s.cleanup();
            this.failed(c, 'disk');
            return { error: 'disk' };
        }
        const idn = (0, records_1.dirIdentity)(s.dir); // the crash repair at a start asks the installed folder for it (M2); every swap asks the staged one (M4)
        const up = { version: c.v.version, sha256: s.sha256, rel: rel.join('/'), dir: s.dir, manifest: s.manifest, ...(idn ? { dev: idn.dev, ino: idn.ino } : {}) };
        this.ups.set(c.id, up);
        const st = this.state();
        st.staged = { ...st.staged, [c.id]: { version: up.version, sha256: up.sha256, dir: up.rel, ...(idn ? { dev: idn.dev, ino: idn.ino } : {}) } };
        if (st.busy || !this.d.state.patch({ staged: st.staged }))
            log(`MARKET update_staged_unsaved ${c.id}`); // this run keeps it; the next start cleans it
        this.tracks.delete(c.id);
        log(`MARKET update_staged ${c.id} ${up.version}`);
        this.changed();
        return up;
    }
    /** The preconditions of the swap, checked after the prompt and again inside replaceFiles: null, or why not. */
    applyCheck(id, up) {
        if (!this.d.client.installGate().ok)
            return 'not_allowed';
        if (this.pending(id))
            return 'busy';
        if (this.builtIn(id))
            return 'built_in';
        const m = this.d.registry.manifestOf(id), dir = this.d.registry.dirOf(id);
        if (!m || !dir || !samePath(dir, path.join(this.d.installedDir, id)))
            return 'busy'; // uninstalled or replaced meanwhile
        const l = this.listing(id);
        const v = l?.type === 'plugin' ? l.versions.find(x => x.version === up.version && x.archive.sha256.toLowerCase() === up.sha256) : undefined;
        if (!v)
            return 'not_found';
        if (v.engines === undefined || !semver.satisfies(manifest_1.HOST_API.version, v.engines))
            return 'incompatible_api';
        if (this.revoked(id, up.version))
            return 'revoked';
        if (!gt(up.version, m.version))
            return 'not_found';
        return null;
    }
    /**
     * The swap through the registry. `restart`: the plugin was stopped for the A5 wipe and runs again with the new files. `reviewed`: the user
     * allowed it in the review prompt (a plain update is checked again inside the swap: it may need review by then, M5). `undoGrant`: the grant
     * the prompt wrote, taken back when the update does not end installed, before the old version is started again (ORCH I1).
     */
    async swapIn(c, up, o) {
        const id = c.id, T = path.join(this.d.installedDir, id);
        this.setTrack(c, { phase: 'applying' });
        let held = false; // a step could not be undone: the journal, the entry and the staging folder stay for the next start
        // ORCH I1: the review's grant goes back before the old version starts again (replaceFiles `failed`), never after: read against the new
        // version's grant, the old version's start could fire the A5 reset and wipe its own data. Once only (a throw before the stop: the catch).
        let undone = false;
        const undoGrant = async () => { if (!o.undoGrant || undone)
            return; undone = true; await this.undoGrant(id, o.undoGrant.before); };
        try {
            await this.d.registry.replaceFiles(id, async () => {
                const why = this.applyCheck(id, up);
                if (why !== null)
                    throw new UpdateFail(why);
                if (o.reviewed !== true && this.reviewOf(up))
                    throw new NeedsReview(); // the grant or the record changed while the plugin stopped
                const idn = (0, records_1.dirIdentity)(up.dir); // before the rename (6b carry): the record names the folder that was checked
                if (idn === null)
                    throw new UpdateFail('disk');
                if (!sameStaged(up, idn)) {
                    log(`MARKET update_staged_replaced ${id}`);
                    throw new UpdateFail('disk');
                } // not the folder staged (M4)
                const prev = this.d.records.get(id);
                if (!this.markSwap(id, { version: up.version, sha256: up.sha256, dir: up.rel, dev: idn.dev, ino: idn.ino }, prev, o.notice))
                    throw new UpdateFail('disk');
                const r = (0, swap_1.swapPluginDir)(up.dir, T, this.d.journal, this.fs);
                if (!r.ok) {
                    if (r.code === 'undo_failed' || this.journalThere())
                        held = true;
                    log(`MARKET update_swap_failed ${id} ${r.step} ${r.code}`);
                    throw new UpdateFail('disk');
                }
                try {
                    this.d.records.set(id, { version: up.version, sha256: up.sha256, firstParty: this.listing(id)?.firstParty === true, dev: idn.dev, ino: idn.ino, at: new Date().toISOString() });
                }
                catch (e) {
                    log(`MARKET update_record_failed ${id} ${codeOf(e)}`);
                    try {
                        r.rollback();
                    }
                    catch (u) {
                        held = true;
                        log(`MARKET update_rollback_failed ${id} ${codeOf(u)}`);
                    }
                    throw new UpdateFail('disk');
                }
                return {
                    rollback: () => {
                        // The record first: a crash inside the folder rollback leaves the record of the folder the journal puts back at the next start.
                        try {
                            if (prev)
                                this.d.records.set(id, prev);
                            else
                                this.d.records.delete(id);
                        }
                        catch (e) {
                            log(`MARKET update_record_restore_failed ${id} ${codeOf(e)}`);
                        }
                        try {
                            r.rollback();
                        }
                        catch (u) {
                            held = true;
                            log(`MARKET update_rollback_failed ${id} ${codeOf(u)}`);
                            throw u;
                        }
                    },
                };
            }, { restart: o.restart, failed: undoGrant });
        }
        catch (e) {
            if (e instanceof NeedsReview) { // nothing moved: the staged copy stays for the user's Review
                this.tracks.delete(id);
                log(`MARKET update_review ${id} ${up.version}`);
                this.changed();
                return this.rowFor(c);
            }
            const code = codeOf(e);
            // The registry refused the new folder (replaceFiles rolled it back): not fetched by itself again until a newer version (M6).
            const refused = !(e instanceof UpdateFail) && (code === 'service_conflict' || code === 'bad_manifest');
            const error = e instanceof UpdateFail ? e.error : refused ? 'refused' : code === 'not_found' ? 'not_found' : code === 'unavailable' ? 'busy' : (0, stagecheck_1.refusalCode)(code);
            if (refused) {
                this.setMark('refused', id, up.version);
                log(`MARKET update_refused ${id} ${up.version}`);
            }
            await undoGrant();
            if (held || this.journalThere())
                log(`MARKET update_held ${id}`);
            else
                this.drop(id);
            return this.failed(c, error);
        }
        this.tracks.delete(id);
        this.drop(id); // the entry and the staging folder, with the old version parked in it
        this.setMark('skipped', id, undefined);
        this.setMark('refused', id, undefined);
        log(`MARKET update_applied ${id} ${up.version}`);
        if (o.notice)
            this.notify(c.name, up.version);
        this.changed();
        return { id, phase: 'updated', version: up.version };
    }
    async undoGrant(id, before) {
        try {
            if (before)
                this.d.grants.set(before);
            else
                await (0, grants_1.forgetGrant)(this.d.grants, id);
        }
        catch (e) {
            log(`MARKET update_grant_undo_failed ${id} ${codeOf(e)}`);
        }
    }
    /** A theme package update: its bytes checked as an install checks them, then added over the old package (values only, no prompt). */
    /** `signal` as for stageFor: an automatic theme update stops before it applies once "Check for updates" went off. */
    async themeUpdate(c, user, signal) {
        if (signal?.aborted)
            return this.stopped(c);
        this.setTrack(c, { phase: 'downloading', progress: { received: 0, total: c.v.archive.size } });
        let r;
        try {
            r = await this.d.installer.stageTheme(c.id, c.v, (x) => {
                if (x.phase === 'downloading')
                    this.setTrack(c, { phase: 'downloading', progress: { received: x.received, total: x.total } });
            }, signal);
        }
        catch (e) {
            log(`MARKET update_stage_bug ${c.id} ${codeOf(e)}`);
            r = { id: c.id, phase: 'failed', error: 'disk' };
        }
        if (signal?.aborted)
            return this.stopped(c);
        if ('phase' in r)
            return this.failed(c, r.phase === 'failed' ? r.error : 'disk');
        const now = this.candidateOf(c.id);
        if (!this.d.client.installGate().ok)
            return this.failed(c, 'not_allowed');
        if (!now || now.v.version !== c.v.version)
            return this.failed(c, 'not_found');
        this.setTrack(c, { phase: 'applying' });
        let result;
        try {
            result = (await this.d.themes.addBytes(r.json, r.license)).result;
        }
        catch (e) {
            const k = codeOf(e);
            return this.failed(c, k === 'too_large' ? 'theme_full' : k === 'bad_params' ? 'archive' : 'disk');
        }
        if (result !== 'updated')
            return this.failed(c, 'busy');
        this.tracks.delete(c.id);
        this.setMark('skipped', c.id, undefined);
        log(`MARKET update_applied ${c.id} ${c.v.version}`);
        if (!user)
            this.notify(c.name, c.v.version);
        this.changed();
        return { id: c.id, phase: 'updated', version: c.v.version };
    }
    // ---- at start --------------------------------------------------------------------------------------------------------------------
    /**
     * At start, after Installer.recover() and before any plugin is registered (main.ts): every staged update that still applies, needs no review
     * and may apply by itself ("Update plugins automatically" and "Check for updates" on) is swapped in directly and recorded; its parked old
     * version stays until `confirmStarted()`. A review update, one waiting for the switches or for a verified index stays; every other entry goes
     * (a bundled id, an uninstall pending, nothing installed, a version that is not newer, refused before, no longer the catalog's, across an API
     * major or revoked). A swap journal still there (recover failed) leaves everything as it is. Never throws.
     */
    async applyStaged() {
        try {
            if (this.journalThere()) {
                log('MARKET update_staged_held journal');
                return;
            }
            const st = this.state();
            for (const [id, s] of Object.entries(st.staged)) {
                let what;
                try {
                    what = this.applyAtStart(id, s);
                }
                catch (e) {
                    log(`MARKET update_start_failed ${id} ${codeOf(e)}`);
                    what = this.journalThere() ? 'keep' : this.parked(id, s) ? this.waitRepair(id) : 'drop'; // Minor 2: never the parked old version
                }
                if (what === 'drop')
                    this.drop(id);
                else if (what === 'keep')
                    this.loadUp(id, s);
                // 'applied': confirmStarted() keeps it or puts the old version back
            }
            this.loaded = true;
        }
        catch (e) {
            log(`MARKET update_start_failed ${codeOf(e)}`);
        }
    }
    /**
     * At start, right after startAll registered every plugin (main.ts; it registers synchronously, I1): an update applyStaged put in place stays
     * when the registry holds its new version from the installed folder (then its staging folder goes, with the old version parked in it, and
     * one notice). One the registry refused (a service another plugin provides, the names rule) is undone before anything of it runs: the record
     * first, then the folder (journaled), and the old version is registered and started as startAll starts a plugin; the version is remembered
     * as refused. A rollback that fails leaves the journal for the next start. Never throws.
     */
    confirmStarted() {
        for (const [id, a] of [...this.atStart]) {
            this.atStart.delete(id);
            try {
                this.confirmOne(id, a);
            }
            catch (e) {
                log(`MARKET update_start_failed ${id} ${codeOf(e)}`);
            }
        }
        this.changed();
    }
    confirmOne(id, a) {
        const T = path.join(this.d.installedDir, id), dir = this.d.registry.dirOf(id);
        if (this.d.registry.manifestOf(id)?.version === a.version && dir !== undefined && samePath(dir, T)) {
            this.drop(id);
            if (a.notice) {
                log(`MARKET update_applied ${id} ${a.version}`);
                this.notify(a.name, a.version);
            }
            return;
        }
        log(`MARKET update_refused ${id} ${a.version}`);
        this.setMark('refused', id, a.version);
        try {
            if (a.prev)
                this.d.records.set(id, a.prev);
            else
                this.d.records.delete(id);
        }
        catch (e) {
            log(`MARKET update_record_restore_failed ${id} ${codeOf(e)}`);
        }
        if (!a.rollback) {
            this.drop(id);
            return;
        } // the old version is no longer parked: nothing to put back
        try {
            a.rollback();
        }
        catch (e) {
            log(`MARKET update_rollback_failed ${id} ${codeOf(e)}`);
            return;
        } // the journal finishes it at the next start
        this.drop(id);
        const r = this.d.registry.addPluginDir(T);
        if (!r.ok) {
            log(`MARKET update_restore_refused ${id} ${r.code}`);
            return;
        }
        void this.d.registry.startAdded(id).catch(e => log(`MARKET update_restart_failed ${id} ${codeOf(e)}`));
    }
    applyAtStart(id, s) {
        const parts = s.dir.split('/');
        if (!(0, manifest_1.isPluginId)(id) || parts.length !== 2 || !STAGE_DIR.test(parts[0]) || parts[1] !== id)
            return 'drop';
        if (this.builtIn(id) || this.pending(id))
            return 'drop';
        const F = path.join(this.staging, parts[0], id), O = F + '.old', T = path.join(this.d.installedDir, id);
        const there = (p) => { try {
            return this.fs.exists(p);
        }
        catch {
            return true;
        } };
        if (!there(T))
            return 'drop';
        const repair = !there(F), parked = repair && there(O);
        const inst = (0, loader_1.inspectPluginDir)(this.d.installedDir, id, true);
        if (inst === null || 'refused' in inst)
            return parked ? this.waitRepair(id) : 'drop'; // Minor 2: a plugin.json held for a moment never costs the old version
        if (repair)
            return this.repairAtStart(id, s, F, T, parked, inst.manifest);
        if (this.state().refused[id] === s.version)
            return 'drop';
        const staged = (0, loader_1.inspectPluginDir)(path.dirname(F), id, true);
        if (staged === null || 'refused' in staged || staged.manifest.version !== s.version)
            return 'drop';
        if (!gt(s.version, inst.manifest.version))
            return 'drop';
        if (!this.d.client.installGate().ok)
            return 'keep'; // waits for a verified index
        const l = this.listing(id);
        const v = l?.type === 'plugin' ? l.versions.find(x => x.version === s.version && x.archive.sha256.toLowerCase() === s.sha256) : undefined;
        if (!v || v.engines === undefined || !semver.satisfies(manifest_1.HOST_API.version, v.engines) || this.revoked(id, s.version))
            return 'drop';
        // Review (in doubt: yes), or a switch off (M1, R31): it waits for the user.
        if (!this.autoOn() || this.needsReview(staged.manifest, inst.manifest))
            return 'keep';
        const idn = (0, records_1.dirIdentity)(F);
        if (idn === null)
            return 'drop';
        if (!sameStaged(s, idn)) {
            log(`MARKET update_staged_replaced ${id}`);
            return 'drop';
        } // not the folder staged and checked (M4)
        const prev = this.d.records.get(id);
        if (!this.markSwap(id, { version: s.version, sha256: s.sha256, dir: s.dir, dev: idn.dev, ino: idn.ino }, prev, true))
            return 'keep'; // Minor 1: no swap a repair could not undo
        const r = (0, swap_1.swapPluginDir)(F, T, this.d.journal, this.fs);
        if (!r.ok) {
            log(`MARKET update_swap_failed ${id} ${r.step} ${r.code}`);
            return r.code === 'undo_failed' || this.journalThere() ? 'keep' : 'drop';
        }
        try {
            this.d.records.set(id, { version: s.version, sha256: s.sha256, firstParty: l?.firstParty === true, dev: idn.dev, ino: idn.ino, at: new Date().toISOString() });
        }
        catch (e) {
            log(`MARKET update_record_failed ${id} ${codeOf(e)}`);
            try {
                r.rollback();
            }
            catch (u) {
                log(`MARKET update_rollback_failed ${id} ${codeOf(u)}`);
                return 'keep';
            }
            return 'drop';
        }
        this.atStart.set(id, { version: s.version, name: staged.manifest.name, notice: true, prev, rollback: () => r.rollback() });
        return 'applied';
    }
    /**
     * The staged folder is gone but its entry is there: a swap of an earlier run that went past step 2 and stopped before its commit. The
     * installed folder is recorded as the marketplace's only when it is the folder that was staged (the identity state.json kept, M2); while
     * the old version is still parked it waits for confirmStarted like a swap of this start, with the record the swap replaced (the entry's
     * `prev`, Minor 1; an entry without one: the record now, unless it already names the new folder) and the notice an automatic swap owes
     * (`auto`, Minor 3). A repair that cannot finish while the old version is parked (the folder's identity unreadable) or whose record cannot
     * be written leaves the entry, and the parked folder, for the next start (Minor 2).
     */
    repairAtStart(id, s, F, T, parked, m) {
        if (m.version !== s.version || s.dev === undefined || s.ino === undefined)
            return 'drop';
        const idn = (0, records_1.dirIdentity)(T);
        if (idn === null)
            return parked ? this.waitRepair(id) : 'drop';
        if (idn.dev !== s.dev || idn.ino !== s.ino)
            return 'drop';
        const before = this.d.records.get(id);
        const named = before !== undefined && before.version === s.version && before.dev === s.dev && before.ino === s.ino;
        const prev = s.prev !== undefined ? s.prev ?? undefined : named ? undefined : before;
        try {
            this.d.records.set(id, { version: s.version, sha256: s.sha256, firstParty: this.listing(id)?.firstParty === true, dev: idn.dev, ino: idn.ino, at: new Date().toISOString() });
        }
        catch (e) {
            log(`MARKET update_record_failed ${id} ${codeOf(e)}`);
            return this.waitRepair(id);
        }
        log(`MARKET update_repaired ${id} ${s.version}`);
        if (!parked)
            return 'drop';
        this.atStart.set(id, { version: s.version, name: m.name, notice: s.auto === true, prev, rollback: () => (0, swap_1.rollbackSwap)(F, T, this.d.journal, this.fs) });
        return 'applied';
    }
    /** Minor 2: a crash repair waits for the next start; this run leaves its entry and its staging folder (the parked old version) alone. */
    waitRepair(id) {
        this.repairs.add(id);
        log(`MARKET update_repair_waits ${id}`);
        return 'keep';
    }
    /** The old version of the staged entry is parked at `<staging>/<random>/<id>.old` (in doubt: yes). */
    parked(id, s) {
        const parts = s.dir.split('/');
        if (parts.length !== 2 || !STAGE_DIR.test(parts[0]) || parts[1] !== id)
            return false;
        try {
            return this.fs.exists(path.join(this.staging, parts[0], `${id}.old`));
        }
        catch {
            return true;
        }
    }
    /**
     * Minor 1: right before a swap its staged entry takes the install record the swap replaces (`prev`, null for none) and whether the update
     * applies by itself (`auto`). False, and nothing is swapped, when state.json could not be written.
     */
    markSwap(id, entry, prev, auto) {
        const st = this.state();
        const next = { ...st.staged, [id]: { ...entry, prev: prev ?? null, auto } };
        if (st.busy || !this.d.state.patch({ staged: next })) {
            log(`MARKET update_staged_unsaved ${id}`);
            return false;
        }
        st.staged = next;
        return true;
    }
    // ---- candidates and rows ---------------------------------------------------------------------------------------------------------
    listing(id) { return this.d.client.catalog()?.plugins.find(x => x.id === id); }
    candidateOf(id) {
        const l = this.listing(id);
        return l ? this.candidateIn(l) : null;
    }
    /** The listing names something this module updates: a plugin registered from the installed root, or an added theme package. */
    eligible(l) {
        if (!(0, manifest_1.isPluginId)(l.id) || this.builtIn(l.id))
            return false;
        if (l.type === 'theme')
            return this.d.themes.list().some(p => p.id === l.id && p.source === 'added');
        const dir = this.d.registry.manifestOf(l.id) ? this.d.registry.dirOf(l.id) : undefined;
        return dir !== undefined && samePath(dir, path.join(this.d.installedDir, l.id));
    }
    candidateIn(l) {
        if (!this.eligible(l))
            return null;
        if (l.type === 'theme') {
            const p = this.d.themes.list().find(x => x.id === l.id && x.source === 'added');
            const v = p ? this.newestAbove(l, p.version, false) : undefined;
            return p && v ? { id: l.id, type: 'theme', name: p.name, from: p.version, v } : null;
        }
        const m = this.d.registry.manifestOf(l.id);
        const v = m ? this.newestAbove(l, m.version, true) : undefined;
        return m && v ? { id: l.id, type: 'plugin', name: m.name, from: m.version, v } : null;
    }
    /** The newest listed version above `installed` whose engines admit the host API (plugins) and that is not revoked. */
    newestAbove(l, installed, plugin) {
        const vs = l.versions.filter(x => semver.valid(x.version) !== null).sort((a, b) => semver.rcompare(a.version, b.version));
        for (const x of vs) {
            if (!gt(x.version, installed))
                return undefined;
            if (plugin && (x.engines === undefined || !semver.satisfies(manifest_1.HOST_API.version, x.engines)))
                continue;
            if (this.revoked(l.id, x.version))
                continue;
            return x;
        }
        return undefined;
    }
    rowFor(c) {
        const up = c.type === 'plugin' ? this.upFor(c) : undefined;
        const review = c.type === 'plugin' && (up ? this.reviewOf(up) : this.previewReview(c));
        const t = this.tracks.get(c.id);
        const tr = t && t.to === c.v.version ? t : undefined;
        const refused = c.type === 'plugin' && this.state().refused[c.id] === c.v.version; // M6: shown as failed until a newer version or the user's Update
        const installed = c.type === 'plugin' ? this.d.registry.manifestOf(c.id) : undefined;
        const next = up?.manifest ?? this.listing(c.id);
        const identity = installed && next ? this.identityOf(c.id, installed, next) : undefined;
        // 11-fix m3: what the version asks for needs the user apart from who it is (the page keeps "asks for new permissions" beside an identity change)
        const asksMore = c.type === 'plugin' && review && this.asksMore(up?.manifest ?? this.previewOf(c));
        let colorClass = '';
        try {
            colorClass = this.d.colorClass(c.id);
        }
        catch { /* none */ }
        const error = tr ? tr.error : refused ? 'refused' : undefined;
        return {
            id: c.id, type: c.type, name: c.name, colorClass, from: c.from, to: c.v.version, review, skipped: this.state().skipped[c.id] === c.v.version,
            // `staged` only for a copy that applies by itself (when the plugin stops, or at the next start): with a switch off it waits for Update (M1).
            phase: tr ? tr.phase : refused ? 'failed' : up && !review && this.autoOn() ? 'staged' : 'available', ...(error ? { error } : {}),
            ...(tr?.progress ? { progress: { ...tr.progress } } : {}), ...(identity ? { identity } : {}), ...(asksMore ? { newPermissions: true } : {}),
        };
    }
    /** A failed update of an id that is no update candidate (unknown, bundled, up to date, the gate closed). */
    failRow(id, error) {
        const m = id ? this.d.registry.manifestOf(id) : undefined;
        let name = 'A plugin', colorClass = '';
        try {
            name = id ? this.d.nameOf(id) : name;
            colorClass = id ? this.d.colorClass(id) : '';
        }
        catch { /* the defaults */ }
        return { id, type: 'plugin', name, colorClass, from: m?.version ?? '', to: '', review: false, skipped: false, phase: 'failed', error };
    }
    failed(c, error) {
        this.setTrack(c, { phase: 'failed', error });
        log(`MARKET update_failed ${c.id} ${error}`);
        return this.rowFor(c);
    }
    /** An automatic download "Check for updates" ended (R31): no error on the row (it is available again), nothing staged. */
    stopped(c) {
        this.tracks.delete(c.id);
        log(`MARKET update_stopped ${c.id}`);
        this.changed();
        return this.rowFor(c);
    }
    /** The staged copy of exactly the version on offer (the catalog's SHA-256), or undefined. */
    upFor(c) {
        this.loadUps();
        const up = this.ups.get(c.id);
        return up && up.version === c.v.version && up.sha256 === c.v.archive.sha256.toLowerCase() ? up : undefined;
    }
    /** What the staged manifest asks, and who it is, decide (in doubt: review). */
    reviewOf(up) {
        const m = this.d.registry.manifestOf(up.manifest.id);
        return m ? this.needsReview(up.manifest, m) : true;
    }
    /** Review for an update from `installed` to `next`: it changes who the plugin is (I3), or what it asks needs the user (reviewNeeded). */
    needsReview(next, installed) {
        return this.identityOf(next.id, installed, next) !== undefined || this.asksMore(next);
    }
    /** What `next` asks needs the user (new permissions, the A5 reset, running in the background: grants.ts reviewNeeded). In doubt (no manifest): yes. */
    asksMore(next) {
        if (!next)
            return true;
        try {
            return (0, grants_1.reviewNeeded)(this.d.grants, next, this.d.providersFor(next));
        }
        catch {
            return true;
        }
    }
    /** Before staging: the registered manifest with the listing's version, name, author, permissions and engines stands in for the new one. */
    previewOf(c) {
        const m = this.d.registry.manifestOf(c.id), l = this.listing(c.id);
        if (!m || !l)
            return undefined;
        return { ...m, version: c.v.version, name: l.name, author: l.author, permissions: c.v.permissions ?? {}, engines: { 'eve-cyno-api': c.v.engines ?? '' } };
    }
    previewReview(c) {
        const m = this.d.registry.manifestOf(c.id), preview = this.previewOf(c);
        return m && preview ? this.needsReview(preview, m) : true;
    }
    /**
     * I3, failing closed: undefined when the update is the installed plugin's own next version as far as the app can tell (the installed copy is
     * the marketplace's, the same name and author); else what differs. A manual copy (or one the records cannot tell) is never updated by itself.
     */
    identityOf(id, installed, next) {
        let manual = true;
        try {
            manual = this.d.records.sourceOf(id, installed.version, path.join(this.d.installedDir, id)) !== 'market';
        }
        catch { /* in doubt: not the market's */ }
        const from = installed.author ?? null, to = next.author ?? null;
        if (!manual && from === to && installed.name === next.name)
            return undefined;
        // Minor 4: another text that reads like the old one (the names rule's fold) is said so; the page shows it apart from a plain rename.
        const look = (a, b) => (a !== null && b !== null && a !== b && (0, names_1.foldName)(a) === (0, names_1.foldName)(b) ? { lookalike: true } : {});
        return {
            manual, ...(from !== to ? { author: { from, to, ...look(from, to) } } : {}),
            ...(installed.name !== next.name ? { name: { from: installed.name, to: next.name, ...look(installed.name, next.name) } } : {}),
        };
    }
    // ---- the little things -----------------------------------------------------------------------------------------------------------
    state() {
        if (!this.mem) {
            let s = {};
            try {
                s = this.d.state.read();
            }
            catch { /* unreadable: nothing staged, nothing skipped or refused, automatic */ }
            this.mem = { staged: { ...(s.staged ?? {}) }, skipped: { ...(s.skipped ?? {}) }, refused: { ...(s.refused ?? {}) }, auto: s.autoPlugins !== false };
            if (s.status === 'busy') {
                this.mem.busy = true;
                log('MARKET update_state_busy');
            }
        }
        return this.mem;
    }
    /** The kept staged entries of state.json, read into `ups` once (a run that did not go through applyStaged). */
    loadUps() {
        if (this.loaded)
            return;
        this.loaded = true;
        for (const [id, s] of Object.entries(this.state().staged))
            this.loadUp(id, s);
    }
    loadUp(id, s) {
        if (this.ups.has(id))
            return;
        const parts = s.dir.split('/');
        if (parts.length !== 2 || !STAGE_DIR.test(parts[0]) || parts[1] !== id)
            return;
        const f = (0, loader_1.inspectPluginDir)(path.join(this.staging, parts[0]), id, true);
        if (f === null || 'refused' in f || f.manifest.version !== s.version)
            return;
        this.ups.set(id, { version: s.version, sha256: s.sha256, rel: s.dir, dir: f.dir, manifest: f.manifest, ...(s.dev !== undefined && s.ino !== undefined ? { dev: s.dev, ino: s.ino } : {}) });
    }
    /** The staged entry of `id` goes: from state.json, from this run, and its staging folder (never while a swap journal is there). */
    drop(id) {
        const up = this.ups.get(id);
        this.ups.delete(id);
        const st = this.state();
        const s = Object.hasOwn(st.staged, id) ? st.staged[id] : undefined;
        if (s) {
            const next = { ...st.staged };
            delete next[id];
            st.staged = next;
            if (st.busy || !this.d.state.patch({ staged: Object.keys(next).length > 0 ? next : undefined }))
                log(`MARKET update_staged_unsaved ${id}`);
        }
        for (const first of new Set([up?.rel.split('/')[0], s?.dir.split('/')[0]])) {
            if (first === undefined || !STAGE_DIR.test(first) || this.journalThere())
                continue;
            try {
                this.fs.rm(path.join(this.staging, first));
            }
            catch (e) {
                log(`MARKET update_staging_clean_failed ${id} ${codeOf(e)}`);
            } // the next start removes it
        }
    }
    /** `skipped[id]` (the user kept the old version over it) or `refused[id]` (the registry refused it, M6): the version, or undefined to clear. */
    setMark(key, id, version) {
        const st = this.state();
        if (st[key][id] === version)
            return;
        const next = { ...st[key] };
        if (version === undefined)
            delete next[id];
        else
            next[id] = version;
        st[key] = next;
        if (st.busy || !this.d.state.patch({ [key]: Object.keys(next).length > 0 ? next : undefined }))
            log(`MARKET update_${key}_unsaved ${id}`);
    }
    setTrack(c, t) { this.tracks.set(c.id, { to: c.v.version, ...t }); this.changed(); }
    journalThere() { try {
        return this.fs.exists(this.d.journal);
    }
    catch {
        return true;
    } }
    pending(id) { try {
        return this.d.pendingUninstall?.(id) === true;
    }
    catch {
        return true;
    } }
    builtIn(id) { try {
        return this.d.isBuiltIn(id);
    }
    catch {
        return true;
    } }
    revoked(id, v) { try {
        return this.d.revocationOf(id, v) !== null;
    }
    catch {
        return true;
    } }
    notify(name, version) {
        try {
            this.d.notice((0, hostnotices_1.pluginUpdatedNotice)(name, version));
        }
        catch (e) {
            log(`MARKET update_notice_failed ${codeOf(e)}`);
        }
    }
    /** One update of an id at a time; every run ends with a look. */
    run(id, fn) {
        const prev = this.chains.get(id) ?? Promise.resolve();
        const p = prev.then(fn, fn);
        const tail = p.then(() => undefined, e => { log(`MARKET update_bug ${id} ${codeOf(e)}`); });
        this.chains.set(id, tail);
        this.hold(tail.then(() => { if (this.chains.get(id) === tail)
            this.chains.delete(id); this.refresh(); }));
        return p;
    }
    hold(p) {
        this.work.add(p);
        void p.finally(() => this.work.delete(p));
    }
    changed() {
        let sig;
        try {
            sig = JSON.stringify(this.view());
        }
        catch {
            return;
        }
        if (sig === this.sig)
            return;
        this.sig = sig;
        for (const fn of [...this.fns]) {
            try {
                fn();
            }
            catch { /* a listener must not stop the updates */ }
        }
    }
}
exports.PluginUpdates = PluginUpdates;
