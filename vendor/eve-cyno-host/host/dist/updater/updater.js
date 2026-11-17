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
exports.Updater = exports.RELAUNCH_SH = exports.DOWNLOAD_IDLE_MS = exports.MANIFEST_TIMEOUT_MS = void 0;
exports.updateErrorOf = updateErrorOf;
exports.updaterLogLine = updaterLogLine;
// The app updater (R1-R5): checks the signed release manifest, downloads the file for this platform, verifies it and installs it at quit.
// No Electron: every effect goes through UpdaterDeps (wire.ts passes the real ones; selftest-updater.ts fakes the clock, the notices and
// the installer spawn, and runs the real fetch, download and fs against test/fake-release/server.mjs).
// Trust chain, in this order, every time (nothing here skips a step):
//  1. GET latest.json and latest.json.minisig (HTTPS, a byte cap and a time limit each; fetchBounded);
//  2. the minisign signature over the manifest bytes, with the release purpose keys only (`keys`: trustedKeys('release', ...));
//  3. the trusted comment `eve-cyno-desktop release stable <version>`, then the strict parser, then the comment against the parsed
//     channel and version: only now is any field used;
//  4. no downgrade, no rollback (R4); 5. the file's size and SHA-256 from the verified manifest, checked on download, at reuse (read again
//     only when its size or mtime changed) and, in full, at quit.
// State lives in <state>/updates.json (<state> = UpdaterDeps.userData: the profile, or its test-updater/ for a test build; wire.ts): `check` and `auto` (the user's; default true), `seen` (the highest verified release), `staged`
// (the verified download waiting), `installing` (set right before an install) and `notified` (each notice once per version).
// B5b (R30, R31): `setCheck` is the "Check for updates" switch and its only writer (the plugin index checks and the plugin updates follow it
// too: `onCheck` tells market/wire.ts's UpdateCheckSwitch, which MarketClient and PluginUpdates read), `info()` what Settings > Updates shows
// beside the state, and `restartNow` the "Restart now" that main.ts follows with the app's quit (hostui/updates.ts).
// dp1-check-fixes item 3: `downloadNow` is the page's "Download now" with "Update automatically" off. It runs one Check now in which the
// release it holds takes the automatic path (the same trust chain, rules, download, verification and staging; nothing here is a second
// verifier), and the file it stages installs at quit with auto off too.
const crypto = __importStar(require("node:crypto"));
const fs = __importStar(require("node:fs"));
const path = __importStar(require("node:path"));
const minisign_1 = require("../minisign");
const atomicfile_1 = require("../atomicfile");
const hostnotices_1 = require("../hostnotices");
const manifest_1 = require("./manifest");
const apply_1 = require("./apply");
exports.MANIFEST_TIMEOUT_MS = 30_000;
exports.DOWNLOAD_IDLE_MS = 60_000;
const PROGRESS_EVERY_MS = 250;
/** The fetch and download results as the updater names them (the brief's table). */
function updateErrorOf(e) {
    switch (e) {
        case 'offline':
        case 'timeout': return 'offline';
        case 'http_status': return 'unavailable';
        case 'bad_url': return 'bad_manifest';
        case 'too_large': return 'too_large';
        case 'size_mismatch':
        case 'hash_mismatch': return 'hash_mismatch';
        case 'disk': return 'disk';
    }
}
/** One log line per phase change: the phase and a version or a reason, never a path, a URL or a number of bytes. */
function updaterLogLine(s) {
    switch (s.phase) {
        case 'available':
        case 'downloading':
        case 'ready': return `UPDATER ${s.phase} ${s.version}`;
        case 'manual': return `UPDATER manual ${s.version} ${s.reason}`;
        case 'error': return `UPDATER error ${s.reason}`;
        default: return `UPDATER ${s.phase}`;
    }
}
const log = (line) => { console.log(line); };
/**
 * The Linux relaunch after "Restart now" (R30, review m5), run as `/bin/sh -c RELAUNCH_SH sh <pid> <target>`: it waits for process `<pid>`
 * (this app) to end, at most 10 s in 0.1 s steps, so the new instance never loses the single-instance lock to the old one, then `exec`s
 * the target. The target is the script's second argument, never part of its text, so no character of the path is ever read as shell.
 */
exports.RELAUNCH_SH = 'i=0; while [ "$i" -lt 100 ] && kill -0 "$1" 2>/dev/null; do sleep 0.1; i=$((i + 1)); done; exec "$2"';
const isObj = (v) => typeof v === 'object' && v !== null && !Array.isArray(v);
const SHA = /^[0-9a-f]{64}$/;
const sha256 = (b) => crypto.createHash('sha256').update(b).digest('hex');
class Updater {
    d;
    st = { phase: 'idle' };
    listeners = new Set();
    checkListeners = new Set(); // onCheck: every setCheck, after the updater acted on it
    cancels = new Set();
    cycleP = null;
    cycleManual = false; // the check in flight is a Check now (true) or the schedule's (false)
    cycleGen = 0; // the checkGen it started under
    forcedP = null; // review item 8: the forced check that follows a scheduled one a Check now joined
    checkGen = 0; // goes up when "Check for updates" goes off: a check started before changes nothing after its next await
    checkMem = null; // the switch as set in this run (it holds even when updates.json could not be written)
    tickCancel = null; // the next scheduled check
    abort = null; // the download in flight
    fetchAbort = null; // the manifest fetch in flight (review m7)
    inited = false;
    started = false;
    stopped = false;
    sessionEnded = false;
    relaunch = false;
    ready = null; // the verified staged file (matches a manifest verified in this session)
    candidate = null; // a staged file from an earlier run, used only once a fresh manifest names it
    blocked = null; // R5 install_failed: the version auto mode does not download again
    lastAvailable = null;
    pressed = null; // the release "Download now" was pressed for, while its run lasts ("Update automatically" off clears it)
    downloadP = null; // that run: every press meanwhile shares it
    noticed = new Set();
    cynodUp = () => true;
    progressAt = 0;
    kind;
    target; // $APPIMAGE (appimage kind only)
    file;
    constructor(d) {
        this.d = d;
        const exists = (f) => { try {
            d.fs.stat(f);
            return true;
        }
        catch {
            return false;
        } };
        this.kind = (0, apply_1.installKind)(d.env, d.execPath, d.platform, exists, d.productName);
        this.target = this.kind === 'appimage' && d.env.APPIMAGE ? d.env.APPIMAGE : null;
        this.file = path.join(d.userData, 'updates.json');
    }
    state() { return { ...this.st }; }
    onChange(fn) { this.listeners.add(fn); return () => { this.listeners.delete(fn); }; }
    auto() { return this.cfg().auto; }
    /**
     * The start-up work (local only), then the schedule: a check 60 s after start and every 6 h after the end of each check. `cynodUp`
     * says whether the sidecar runs: the clean start (R5) waits for 60 s with it up.
     */
    start(o = {}) {
        if (this.started || this.stopped)
            return;
        this.started = true;
        if (o.cynodUp)
            this.cynodUp = o.cynodUp;
        this.init();
        this.schedule(() => this.cleanStart(), manifest_1.CLEAN_START_MS);
        if (!this.configured())
            return;
        if (!this.checkOn())
            return; // D33: checks off entirely, not even a scheduled one
        this.scheduleChecks(manifest_1.CHECK_DELAY_MS);
    }
    /** Cancels the schedule and aborts a running download (its `.part` goes with it). A ready update stays ready for the quit. */
    stop() {
        this.stopped = true;
        for (const c of this.cancels) {
            try {
                c();
            }
            catch { /* gone */ }
        }
        this.cancels.clear();
        this.abort?.abort();
        this.fetchAbort?.abort();
        if (this.st.phase === 'checking' || this.st.phase === 'downloading')
            this.set({ phase: 'idle' });
    }
    /**
     * One check now (and, in auto mode, the download). Concurrent calls share one run. A check also retries an install_failed version. One
     * that comes while a scheduled check runs waits for it and then runs one forced check (review item 8: the scheduled one does not retry an
     * install_failed version, and it may have asked before the user did); every Check now meanwhile shares that one.
     */
    async checkNow() {
        this.init();
        if (this.stopped || !this.configured() || !this.checkOn())
            return this.state();
        if (this.cycleP && !this.cycleManual && this.cycleGen === this.checkGen) {
            const scheduled = this.cycleP;
            this.forcedP ??= scheduled.then(() => { this.forcedP = null; return this.checkNow(); });
            return this.forcedP;
        }
        return this.cycle(true);
    }
    /**
     * "Download now" (dp1-check-fixes item 3): the release `available` shows, with "Update automatically" off, through the automatic path. It
     * acts only in `available` with "Check for updates" on and no check running; anything else changes nothing and answers the state as it is.
     * It runs one Check now (`cycle(true)`: the whole trust chain and R4 again, as a check does, and an install_failed version is retried as
     * Check now retries it) in which the release it was pressed for, `lastAvailable` (the updater's own, never a caller's), takes the path
     * `auto` takes: reuse of a verified staged file, else the download, verified (size, SHA-256) and staged by `download`. When the fresh
     * manifest names another release, that one is only shown (`available`), never downloaded. Every press meanwhile shares the run; a Check
     * now, the schedule or "Update automatically" switched on join it (`cycle`), so there is never a second download. "Update automatically"
     * switched off or "Check for updates" off end it as they end an automatic download. The file it stages is `chosen`: it stays ready, and
     * Restart now and the quit install it, with auto off.
     */
    async downloadNow() {
        this.init();
        if (this.downloadP)
            return this.downloadP;
        const s = this.st, held = this.lastAvailable;
        if (this.stopped || this.cycleP || s.phase !== 'available' || !held || s.version !== held.version || !this.configured() || !this.checkOn())
            return this.state();
        this.pressed = held.version;
        const p = this.cycle(true).finally(() => { if (this.downloadP === p) {
            this.downloadP = null;
            this.pressed = null;
        } });
        this.downloadP = p;
        return p;
    }
    /**
     * "Check for updates" (R30, R31, D37). Off: the schedule is cancelled and a check in flight ends at once (its manifest fetch and its
     * download are aborted: the sockets close and a `.part` goes); nothing is asked again until it is on, and a ready update stays ready for
     * the quit. On (from off): one check now, then the 6 h schedule. Kept in updates.json `check`. Every call then reaches the `onCheck`
     * listeners with `on` (R31, Task 9 m2: the plugin index checks and the plugin updates follow this switch).
     */
    setCheck(on) {
        const was = this.checkOn();
        this.checkMem = on;
        this.writeCfg({ check: on });
        if (on !== was && !on) {
            this.checkGen++;
            this.tickCancel?.();
            this.tickCancel = null;
            this.fetchAbort?.abort();
            this.abort?.abort();
            if (this.st.phase === 'checking' || this.st.phase === 'downloading')
                this.set({ phase: 'idle' });
        }
        else if (on !== was && this.started && !this.stopped && this.configured())
            this.scheduleChecks(0);
        for (const fn of [...this.checkListeners]) {
            try {
                fn(on);
            }
            catch { /* a listener must not break the updater */ }
        }
    }
    /** Hears every setCheck (its value, once the updater acted on it): market/wire.ts UpdateCheckSwitch.follow. */
    onCheck(fn) { this.checkListeners.add(fn); return () => { this.checkListeners.delete(fn); }; }
    /** What Settings > Updates shows beside the state (R30): this build, its install kind, the two switches and `latest` = `seen` (D25). */
    info() {
        const c = this.cfg();
        return { version: this.d.version, kind: this.kind, auto: c.auto, check: this.checkMem ?? c.check, latest: c.seen ? { version: c.seen.version, released: c.seen.released } : null };
    }
    /**
     * "Update automatically" (D6). On: with a release `available`, its download starts (a run in flight, a Download now's included, is joined:
     * never a second download). Off (from on): the download in flight ends and a ready file goes, a Download now's too; the release is
     * `available` again. Off when it already was off changes nothing (a Download now in flight or its ready file stays).
     */
    setAuto(on) {
        const was = this.cfg().auto;
        this.writeCfg({ auto: on });
        if (on) {
            if (this.st.phase === 'available' && this.started && !this.stopped && this.checkOn())
                void this.cycle(false);
            return;
        } // checks off: nothing is asked (R31)
        if (!was)
            return;
        this.pressed = null; // a Download now whose run has not reached its download yet does not start it
        this.abort?.abort();
        if (this.ready) {
            this.drop(this.ready);
            this.ready = null;
        }
        if (this.lastAvailable && (this.st.phase === 'ready' || this.st.phase === 'downloading')) {
            this.set({ phase: 'available', ...this.lastAvailable });
            this.noticeOnce('available', this.lastAvailable.version);
        }
    }
    /** A Windows session end or a Linux shutdown: no install this time (a detached installer killed by logoff breaks the install). */
    sessionEnding() { this.sessionEnded = true; }
    /**
     * "Restart now" (R30, review m5): true when the install at the coming quit will run, and then that install also starts the new version
     * (Linux: RELAUNCH_SH; Windows: the installer's `--force-run`); the caller quits next (main.ts: the tray's quitApp). False, and nothing
     * is marked, when no update is ready (a kind that does not install itself never is), after a session end, with "Update automatically"
     * off (unless Download now staged the file: `chosen`), or when the staged file changed since it was verified: that file then goes and the
     * state says `hash_mismatch` (the quit would drop it).
     */
    async restartNow() {
        const s = this.ready;
        if (this.st.phase !== 'ready' || !s)
            return false; // only `appimage` and `nsis` ever reach ready
        if (!(await this.stillVerified(s))) { // the size and mtime it was verified with: not read again unless they moved
            if (this.ready === s) {
                this.drop(s);
                this.ready = null;
                this.set({ phase: 'error', reason: 'hash_mismatch', checkedAt: this.d.now() });
            }
            return false;
        }
        // After the check, which may have hashed for a while: what installOnQuit asks too, so true means the install will run.
        if (this.st.phase !== 'ready' || this.ready !== s || this.sessionEnded || !this.installs(s))
            return false;
        this.relaunch = true;
        return true;
    }
    /**
     * Called in the quit path after the sidecar exited. Re-hashes the staged file, writes `installing`, then swaps the AppImage or starts the
     * installer. False when nothing was installed (nothing ready, auto off and the file not one Download now staged, a session end, a changed
     * file, a failed step). After "Restart now" on Linux, an install that does not happen (a changed file, the state file, a failed swap) still
     * starts the unchanged AppImage again, so the user gets the app back (B5b review m6; a failed swap then shows install_failed); a session
     * end starts nothing.
     */
    installOnQuit() {
        const s = this.ready;
        if (this.st.phase !== 'ready' || !s)
            return false;
        if (this.sessionEnded) {
            log('UPDATER install_skipped session_end');
            return false;
        }
        if (!this.installs(s)) {
            log('UPDATER install_skipped auto_off');
            return false;
        }
        const back = () => { if (this.relaunch && this.kind === 'appimage' && this.target)
            this.relaunchAppImage(this.target); return false; };
        if (!this.rehash(s)) {
            this.drop(s);
            this.ready = null;
            log('UPDATER install_skipped changed');
            return back();
        }
        if (!this.writeCfg({ installing: s.version })) {
            log('UPDATER install_skipped state');
            return back();
        }
        if (this.kind === 'appimage' && this.target) {
            const r = (0, apply_1.swapAppImage)(s.file, this.target, this.d.fs);
            if (!r.ok) {
                log(`UPDATER install_failed ${r.step} ${r.code}`);
                return back();
            }
            this.writeCfg({ staged: null });
            if (this.relaunch)
                this.relaunchAppImage(this.target);
            log(`UPDATER installed ${s.version}`);
            return true;
        }
        if (this.kind === 'nsis') {
            const ok = (0, apply_1.runInstaller)(s.file, this.d.spawn, { relaunch: this.relaunch });
            log(ok ? `UPDATER installer_started ${s.version}` : 'UPDATER install_failed spawn');
            return ok;
        }
        return false;
    }
    // ---- internals ---------------------------------------------------------------------------------------------------------------
    /** A ready file installs at quit with "Update automatically" on, or when Download now staged it in this run (`chosen`). */
    installs(s) { return this.cfg().auto || s.chosen === true; }
    set(s) {
        this.st = s;
        for (const fn of [...this.listeners]) {
            try {
                fn({ ...s });
            }
            catch { /* a listener must not break the updater */ }
        }
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
    /** The check schedule: a check `ms` from now (0: at once), then one 6 h after the end of each. Checks switched off end it (checkGen). */
    scheduleChecks(ms) {
        const g = this.checkGen;
        // Never two schedules (review m7): a check timer still pending goes first, and so does one set meanwhile when this check ends.
        const next = (fn, after) => { this.tickCancel?.(); this.tickCancel = this.schedule(fn, after); };
        const tick = () => {
            this.tickCancel = null;
            void this.cycle(false).finally(() => { if (!this.stopped && g === this.checkGen)
                next(tick, manifest_1.CHECK_EVERY_MS); });
        };
        this.tickCancel?.();
        this.tickCancel = null;
        if (ms === 0)
            tick();
        else
            next(tick, ms);
    }
    /** "Check for updates": the switch as set in this run, else updates.json (absent: on). */
    checkOn() { return this.checkMem ?? this.cfg().check; }
    configured() {
        const ok = this.d.keys.length > 0 && this.d.manifestUrl !== null && (0, manifest_1.isVersion)(this.d.version);
        if (!ok && !(this.st.phase === 'error' && this.st.reason === 'unconfigured'))
            this.set({ phase: 'error', reason: 'unconfigured', checkedAt: null });
        return ok;
    }
    platformKey() {
        const k = `${this.d.platform}-${this.d.arch}`;
        return manifest_1.PLATFORM_KEYS.includes(k) ? k : null;
    }
    cfg() {
        const r = (0, atomicfile_1.readJsonDetailed)(this.file, isObj);
        const v = r.status === 'ok' && isObj(r.value) ? r.value : {};
        const c = { check: v.check !== false, auto: v.auto !== false, notified: {} };
        if (isObj(v.seen) && (0, manifest_1.isVersion)(v.seen.version) && (0, manifest_1.isReleased)(v.seen.released))
            c.seen = { version: v.seen.version, released: v.seen.released };
        if ((0, manifest_1.isVersion)(v.installing))
            c.installing = v.installing;
        if (isObj(v.staged) && (0, manifest_1.isVersion)(v.staged.version) && typeof v.staged.sha256 === 'string' && SHA.test(v.staged.sha256) && Number.isSafeInteger(v.staged.size) && v.staged.size > 0) {
            c.staged = { version: v.staged.version, sha256: v.staged.sha256, size: v.staged.size };
        }
        if (isObj(v.notified)) {
            if ((0, manifest_1.isVersion)(v.notified.ready))
                c.notified.ready = v.notified.ready;
            if ((0, manifest_1.isVersion)(v.notified.manual))
                c.notified.manual = v.notified.manual;
        }
        return c;
    }
    /** Merges into updates.json (keys it does not know are kept) and writes it atomically; false when it could not be written. */
    writeCfg(p) {
        try {
            const r = (0, atomicfile_1.readJsonDetailed)(this.file, isObj);
            const v = r.status === 'ok' && isObj(r.value) ? { ...r.value } : {};
            for (const [k, x] of Object.entries(p)) {
                if (x === null)
                    delete v[k];
                else if (x !== undefined)
                    v[k] = x;
            }
            fs.mkdirSync(path.dirname(this.file), { recursive: true });
            (0, atomicfile_1.writeFileAtomic)(this.file, JSON.stringify(v, null, 2) + '\n');
            return true;
        }
        catch (e) {
            log(`UPDATER state_write_failed ${codeOf(e)}`);
            return false;
        }
    }
    exists(f) { try {
        this.d.fs.stat(f);
        return true;
    }
    catch {
        return false;
    } }
    rm(f) { try {
        this.d.fs.unlink(f);
    }
    catch { /* not there */ } }
    drop(s) {
        this.rm(s.file);
        const c = this.cfg().staged;
        if (c && c.version === s.version)
            this.writeCfg({ staged: null });
    }
    /** The staged file is still the verified one: a regular file (not a link) of the verified size with the verified SHA-256. Reads it whole. */
    rehash(s) {
        try {
            const st = this.d.fs.stat(s.file);
            if (!st.isFile() || st.size !== s.size)
                return false;
            if (sha256(this.d.fs.readFile(s.file)) !== s.sha256)
                return false;
            s.seen = { size: st.size, mtimeMs: st.mtimeMs };
            return true;
        }
        catch {
            return false;
        }
    }
    /**
     * In-session form of `rehash` (review m3): a file whose size and mtime are what they were when it last hashed right is not read again. Any
     * other file (a staged file of an earlier run, or one touched since) is hashed once, streamed and async (review n3: never a blocking read of
     * up to 512 MiB on the main thread), and counts only when its size and mtime did not move while it was read. The quit path always calls
     * `rehash` (R5 step 1).
     */
    async stillVerified(s) {
        let before;
        try {
            const st = this.d.fs.stat(s.file);
            if (!st.isFile() || st.size !== s.size)
                return false;
            if (s.seen && s.seen.size === st.size && s.seen.mtimeMs === st.mtimeMs)
                return true;
            before = { size: st.size, mtimeMs: st.mtimeMs };
            if ((await this.d.fs.hashFile(s.file)) !== s.sha256)
                return false;
            const after = this.d.fs.stat(s.file);
            if (!after.isFile() || after.size !== before.size || after.mtimeMs !== before.mtimeMs)
                return false;
        }
        catch {
            return false;
        }
        s.seen = before;
        return true;
    }
    stagedPath(version) {
        if (this.kind === 'appimage' && this.target)
            return (0, apply_1.appImageStaged)(this.target);
        if (this.kind === 'nsis')
            return path.join((0, apply_1.updatesDir)(this.d.userData), (0, apply_1.installerName)(this.d.productName, version));
        return null;
    }
    /** R5 at start: `.part` files and staged files for versions <= the running one go; a newer staged file waits for a fresh manifest. */
    init() {
        if (this.inited)
            return;
        this.inited = true;
        const c = this.cfg(), running = this.d.version;
        if (!(0, manifest_1.isVersion)(running))
            return;
        const rec = c.staged;
        if (this.kind === 'appimage' && this.target) {
            const staged = (0, apply_1.appImageStaged)(this.target);
            this.rm(staged + '.part');
            if (rec && (0, manifest_1.cmpVersion)(rec.version, running) > 0 && this.exists(staged))
                this.candidate = { ...rec, file: staged };
            else {
                this.rm(staged);
                if (rec)
                    this.writeCfg({ staged: null });
            }
        }
        if (this.d.platform === 'win32') {
            const dir = (0, apply_1.updatesDir)(this.d.userData);
            let names = [];
            try {
                if (this.d.fs.stat(dir).isDirectory())
                    names = fs.readdirSync(dir);
            }
            catch { /* none yet */ } // never through a link
            for (const n of names) {
                const f = path.join(dir, n);
                if (/\.part$/i.test(n)) {
                    this.rm(f);
                    continue;
                }
                const v = (0, apply_1.installerVersion)(this.d.productName, n);
                if (v === null)
                    continue;
                if (this.kind === 'nsis' && rec && rec.version === v && (0, manifest_1.cmpVersion)(v, running) > 0 && !this.candidate)
                    this.candidate = { ...rec, file: f };
                else
                    this.rm(f);
            }
            if (rec && !this.candidate && this.kind === 'nsis')
                this.writeCfg({ staged: null });
        }
        if (c.installing && (0, manifest_1.cmpVersion)(c.installing, running) > 0) {
            this.blocked = c.installing;
            // The install did not happen, so `$APPIMAGE` still holds this version: a `.previous` beside it is a copy of it, maybe cut short by a
            // kill during the copy, and never the way back (review n2).
            if (this.kind === 'appimage' && this.target)
                this.rm((0, apply_1.appImagePrevious)(this.target));
            this.set({ phase: 'error', reason: 'install_failed', checkedAt: null });
        }
    }
    /** R5 clean start: after 60 s with the sidecar up, `installing` is cleared and `.<basename>.previous` deleted. Retried while cynod is down. */
    cleanStart() {
        if (!this.cynodUp()) {
            this.schedule(() => this.cleanStart(), manifest_1.CLEAN_START_MS);
            return;
        }
        if (this.blocked)
            return; // the install did not happen: nothing of it to clean
        const c = this.cfg();
        if (c.installing && (0, manifest_1.isVersion)(this.d.version) && (0, manifest_1.cmpVersion)(c.installing, this.d.version) <= 0)
            this.writeCfg({ installing: null });
        if (this.kind === 'appimage' && this.target)
            this.rm((0, apply_1.appImagePrevious)(this.target));
    }
    /**
     * One notice per version and slot (updates.json `notified`): `ready`, or `manual` for a release this copy does not install by itself. That
     * slot holds two texts: `manual` (a `manual` state: get it from Discord) and `available` ("Update automatically" off: Download now in
     * Settings > Updates); a version gets one of the two, whichever came first.
     */
    noticeOnce(kind, version) {
        const slot = kind === 'ready' ? 'ready' : 'manual';
        const key = `${slot}:${version}`;
        if (this.noticed.has(key))
            return;
        this.noticed.add(key);
        const c = this.cfg();
        if (c.notified[slot] === version)
            return;
        this.writeCfg({ notified: { ...c.notified, [slot]: version } });
        const n = kind === 'ready' ? (0, hostnotices_1.UPDATE_READY)(version) : kind === 'available' ? (0, hostnotices_1.UPDATE_AVAILABLE)(version) : (0, hostnotices_1.UPDATE_MANUAL)(version);
        try {
            this.d.notice(n);
        }
        catch { /* the notice is a courtesy */ }
    }
    cycle(manual) {
        if (this.cycleP) {
            if (this.cycleGen === this.checkGen)
                return this.cycleP;
            // A check that "Check for updates" off ended is still unwinding (it changes nothing more): this one starts once it is gone.
            return this.cycleP.then(() => (this.stopped || !this.checkOn() ? this.state() : this.cycle(manual)));
        }
        const g = this.checkGen;
        this.cycleGen = g;
        this.cycleManual = manual;
        const p = this.runCycle(manual, g).catch((e) => {
            log(`UPDATER cycle_failed ${codeOf(e)}`); // review m6: the code only, never a message (it may carry a path)
            if (this.live(g))
                this.set({ phase: 'error', reason: 'disk', checkedAt: this.d.now() }); // a bug or an fs throw: never a crash; after stop() or checks off nothing changes (n5)
            return this.state();
        }).finally(() => { if (this.cycleP === p)
            this.cycleP = null; });
        this.cycleP = p;
        return p;
    }
    /** The check started under `g` may still change the state: not stopped, and "Check for updates" not switched off since. */
    live(g) { return !this.stopped && g === this.checkGen; }
    /** Steps 1-3 of the trust chain. Returns the verified manifest, or the error to show. */
    async verifiedManifest() {
        const url = this.d.manifestUrl;
        const ac = new AbortController(); // stop() ends the fetch in flight (review m7)
        this.fetchAbort = ac;
        const o = { maxBytes: manifest_1.MAX_MANIFEST_BYTES, timeoutMs: exports.MANIFEST_TIMEOUT_MS, userAgent: `EVE-Cyno/${this.d.version}`, allowLoopbackHttp: this.d.allowLoopbackHttp, signal: ac.signal };
        try {
            return await this.verifiedWith(url, o);
        }
        finally {
            if (this.fetchAbort === ac)
                this.fetchAbort = null;
        }
    }
    async verifiedWith(url, o) {
        const mr = await this.d.fetch(url, o);
        if (!mr.ok)
            return { ok: false, reason: updateErrorOf(mr.error) };
        if (mr.status !== 200)
            return { ok: false, reason: 'unavailable' };
        const sr = await this.d.fetch(`${url}.minisig`, o);
        if (!sr.ok)
            return { ok: false, reason: updateErrorOf(sr.error) };
        if (sr.status !== 200)
            return { ok: false, reason: 'unavailable' };
        const v = (0, minisign_1.verifyMinisign)(mr.body, sr.body.toString('utf8'), this.d.keys);
        if (!v.ok)
            return { ok: false, reason: 'verify_failed' };
        let m;
        // A product build's files must sit under RELEASE_URL_PREFIX; a test build's fake server names its own origin's /desktop/.
        const prefix = this.d.allowLoopbackHttp ? new URL('../', url).href : manifest_1.RELEASE_URL_PREFIX; // <origin>/desktop/ of <origin>/desktop/stable/latest.json
        try {
            m = (0, manifest_1.parseReleaseManifest)(mr.body, prefix);
        }
        catch (e) {
            return { ok: false, reason: e?.code === 'too_large' ? 'too_large' : 'bad_manifest' };
        }
        if (v.trusted !== (0, manifest_1.releaseComment)(m.channel, m.version))
            return { ok: false, reason: 'verify_failed' };
        return { ok: true, m };
    }
    async runCycle(manual, g) {
        const quiet = this.st.phase === 'ready' && this.ready !== null; // a recheck while ready keeps showing ready unless the answer changes it
        if (!quiet)
            this.set({ phase: 'checking' });
        const r = await this.verifiedManifest();
        if (!this.live(g))
            return this.state();
        const now = this.d.now();
        if (!r.ok) {
            if (quiet)
                return this.state(); // a failed recheck: the update verified earlier in this run stays ready
            this.set({ phase: 'error', reason: r.reason, checkedAt: now }); // verify_failed included: no notice, the next check retries (R5)
            return this.state();
        }
        const m = r.m, running = this.d.version, c = this.cfg();
        const dropStaged = () => {
            for (const s of [this.ready, this.candidate])
                if (s)
                    this.drop(s);
            this.ready = null;
            this.candidate = null;
        };
        // R4's rollback rule comes first (review m1): a manifest older than a release already seen is `rollback` even when it is not newer than
        // the running version, so a mirror turned back to the running release after a newer one was seen never reads "Up to date".
        if (c.seen && ((0, manifest_1.cmpVersion)(m.version, c.seen.version) < 0 || (m.version === c.seen.version && Date.parse(m.released) < Date.parse(c.seen.released)))) {
            dropStaged(); // R5: a staged file is used only when a fresh verified manifest names it
            this.set({ phase: 'error', reason: 'rollback', checkedAt: now });
            return this.state();
        }
        if ((0, manifest_1.cmpVersion)(m.version, running) <= 0) {
            this.remember(m, c.seen);
            dropStaged();
            this.set({ phase: 'current', checkedAt: now });
            return this.state();
        }
        this.remember(m, c.seen);
        const key = this.platformKey(), file = key ? m.files[key] : undefined;
        const manualState = (reason) => {
            dropStaged();
            this.set({ phase: 'manual', version: m.version, reason });
            this.noticeOnce('manual', m.version);
            return this.state();
        };
        if (!file)
            return manualState('unsupported');
        if (this.kind === 'dev' || this.kind === 'portable')
            return manualState(this.kind);
        if (this.kind === 'appimage' && !this.appImageWritable())
            return manualState('not_writable');
        this.lastAvailable = { version: m.version, notes: m.notes, checkedAt: now };
        const autoOff = () => {
            dropStaged(); // auto off downloads or installs only what Download now asked for (D6), so nothing else waits on disk either
            this.set({ phase: 'available', version: m.version, notes: m.notes, checkedAt: now });
            this.noticeOnce('available', m.version);
            return this.state();
        };
        // With auto off, the automatic path below is taken only by the release a Download now in flight was pressed for (`asked`), or kept for
        // the ready file Download now staged for this very release (`kept`: rechecked, never downloaded again unasked). Read again after each await.
        const asked = () => this.pressed === m.version;
        const kept = () => this.ready?.chosen === true && this.ready.version === m.version;
        if (!c.auto && !asked() && !kept())
            return autoOff();
        if (this.blocked === m.version && !manual) {
            dropStaged(); // R5: the install of this version failed; auto mode does not try it again, checkNow does
            this.set({ phase: 'error', reason: 'install_failed', checkedAt: now });
            return this.state();
        }
        if (manual && this.blocked) {
            this.blocked = null;
            this.writeCfg({ installing: null });
        }
        const have = this.ready ?? this.candidate;
        if (have) {
            const same = have.version === m.version && have.sha256 === file.sha256 && have.size === file.size;
            const verified = same && await this.stillVerified(have);
            // The hash may have taken a while: stop(), "Check for updates" off or "Update automatically" off may have run meanwhile (setAuto(false)
            // drops a ready file).
            if (!this.live(g))
                return this.state();
            if (!this.cfg().auto && !asked() && !kept())
                return autoOff();
            if (verified) {
                this.candidate = null;
                this.ready = have;
                this.set({ phase: 'ready', version: m.version });
                this.noticeOnce('ready', m.version);
                return this.state();
            }
            dropStaged();
            if (!this.cfg().auto && !asked())
                return autoOff(); // a Download now file that changed goes; it is fetched again only when asked
        }
        this.set({ phase: 'available', version: m.version, notes: m.notes, checkedAt: now });
        return this.download(m, file);
    }
    remember(m, seen) {
        if (!seen || (0, manifest_1.cmpVersion)(m.version, seen.version) > 0 || (m.version === seen.version && Date.parse(m.released) > Date.parse(seen.released))) {
            this.writeCfg({ seen: { version: m.version, released: m.released } });
        }
    }
    appImageWritable() {
        if (!this.target)
            return false;
        try {
            this.d.fs.access(path.dirname(this.target), fs.constants.W_OK);
            this.d.fs.access(this.target, fs.constants.W_OK);
            return true;
        }
        catch {
            return false;
        }
    }
    async download(m, file) {
        const dest = this.stagedPath(m.version);
        const fail = (reason) => { this.set({ phase: 'error', reason, checkedAt: this.d.now() }); return this.state(); };
        if (!dest)
            return fail('disk');
        if (this.kind === 'nsis') {
            const dir = path.dirname(dest);
            try {
                fs.mkdirSync(dir, { recursive: true });
            }
            catch {
                return fail('disk');
            }
            try {
                if (!this.d.fs.stat(dir).isDirectory())
                    return fail('disk');
            }
            catch {
                return fail('disk');
            } // a link or a file there: never written through
        }
        const ac = new AbortController();
        this.abort = ac;
        this.progressAt = 0;
        this.set({ phase: 'downloading', version: m.version, received: 0, total: file.size });
        const r = await this.d.download(file.url, dest, {
            size: file.size, sha256: file.sha256, idleTimeoutMs: exports.DOWNLOAD_IDLE_MS, userAgent: `EVE-Cyno/${this.d.version}`,
            allowLoopbackHttp: this.d.allowLoopbackHttp, signal: ac.signal,
            onProgress: n => {
                const t = this.d.now();
                if (this.st.phase !== 'downloading' || (t - this.progressAt < PROGRESS_EVERY_MS && n < file.size))
                    return;
                this.progressAt = t;
                this.set({ phase: 'downloading', version: m.version, received: n, total: file.size });
            },
        });
        if (this.abort === ac)
            this.abort = null;
        if (ac.signal.aborted) {
            this.rm(dest);
            return this.state();
        } // stopped, or auto switched off: nothing is staged
        if (!r.ok)
            return fail(updateErrorOf(r.error));
        const staged = { version: m.version, sha256: file.sha256, size: file.size, file: dest, chosen: this.pressed === m.version };
        try {
            if (this.kind === 'appimage')
                this.d.fs.chmod(dest, 0o755);
            const st = this.d.fs.stat(dest); // its bytes hashed right while they streamed in: remembered, not read again (m3)
            staged.seen = { size: st.size, mtimeMs: st.mtimeMs };
        }
        catch {
            this.rm(dest);
            return fail('disk');
        }
        if (!this.writeCfg({ staged: { version: staged.version, sha256: staged.sha256, size: staged.size } })) {
            this.rm(dest);
            return fail('disk');
        }
        if (this.kind === 'nsis')
            this.removeOtherInstallers(dest);
        this.ready = staged;
        this.set({ phase: 'ready', version: m.version });
        this.noticeOnce('ready', m.version);
        return this.state();
    }
    removeOtherInstallers(keep) {
        const dir = path.dirname(keep), own = path.basename(keep);
        // Windows file names are case-insensitive: a name that differs from the staged one only in case is that file (review m8).
        const same = (n) => (this.d.platform === 'win32' ? n.toLowerCase() === own.toLowerCase() : n === own);
        let names = [];
        try {
            names = fs.readdirSync(dir);
        }
        catch {
            return;
        }
        for (const n of names)
            if (!same(n) && (0, apply_1.installerVersion)(this.d.productName, n) !== null)
                this.rm(path.join(dir, n));
    }
    /**
     * "Restart now" on Linux (R30): `/bin/sh` runs RELAUNCH_SH detached, which starts the AppImage once this process ended (at most 10 s on).
     * It is spawned here, in the quit's install, so only after the sidecar exited and right before the app exits. Its environment is this
     * process's with the real session type put back (sessionEnv; B5b review m1), so the new instance does not take main.ts's x11 for it.
     */
    relaunchAppImage(target) {
        try {
            const p = this.d.spawn('/bin/sh', ['-c', exports.RELAUNCH_SH, 'sh', String(process.pid), target], { detached: true, stdio: 'ignore', env: (0, apply_1.sessionEnv)(process.env, this.d.sessionType) });
            p.on('error', () => { });
            p.unref();
        }
        catch {
            log('UPDATER relaunch_failed');
        }
    }
}
exports.Updater = Updater;
const codeOf = (e) => { const c = e?.code; return typeof c === 'string' && /^[A-Z0-9_]{1,24}$/.test(c) ? c : 'error'; };
