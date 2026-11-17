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
exports.Installer = exports.INSTALL_DISK_MARGIN = void 0;
// The archive installer (R26; plan Task 6). One run per id at a time; every check passes before the next step uses the bytes:
//  1. preconditions: installGate (a verified index, not stale, no failed verify or rollback since), the id listed and not a Windows device
//     name, not bundled (`built_in`), no pending uninstall and nothing of the id installed (`busy`), the newest version whose engines
//     admit HOST_API (`incompatible_api`) and not revoked, the names rule (`reserved_name`), room for a theme package (`theme_full`), and
//     room on disk for the archive plus 16 MiB;
//  2. downloadVerified (the listing's size and SHA-256) into <plugins>/staging/<random>/archive.zip; the file is read back with its cap and
//     hashed again, so the bytes used are the bytes checked;
//  3. readZip (R25) and the root layout; room for the unpacked size plus 16 MiB; extractTo staging/<random>/<id>/;
//  4. parseManifest of the staged plugin.json, compared with the listing (id, version, name, author, engines and permissions, both sides
//     normalised the same way first: `listing_mismatch`), then the loader's own checks of the staged folder (steps 3 and 4 after readZip:
//     market/stagecheck.ts, which scripts/index-verify.mjs --archives runs too);
//  5. the prompt on the staged manifest (`source: 'market'`, `recordDeny: false`: a Deny writes no grant record; the request carries the
//     staged manifest, which the product's prompt view is built from; `fresh`: nothing of the id is registered, so a grant record of it is
//     stale and the ask is an install's, with no previous version, the record deciding only the A5 reset); a prompt that could not be shown
//     fails the install `unavailable`;
//  6. Allow: the preconditions once more (the index, a revocation, an uninstall or a folder of the id may have come during the prompt), then
//     one rename into <installed>/<id> (never a copy: a rename across file systems is refused `disk`), the install record with the identity
//     the folder had before the rename (records.ts dirIdentity), addPluginDir, and the start per its activation events (startAdded).
// Nothing is under the installed root before Allow. A failure after the rename moves the folder back to staging, removes the record and
// takes the grant back; the staging folder goes in every case. A theme listing has no prompt: the two files' bytes go to
// ThemePackages.addBytes. Staging is <userData>/plugins/staging, the sibling of the installed root (the swap's layout, swap.ts); an
// installed root elsewhere (a test seam's temp folder) installs nothing, and nothing outside <userData>/plugins is ever cleaned.
// recover() at start, before any plugin is registered: a journaled swap is finished (recoverSwap); then every staging entry goes except the
// staged updates market/state.json names (Task 8), and the grant of an install cut short after Allow goes with its entry when nothing of the
// id is installed, bundled or staged. When recoverSwap throws, or state.json cannot be read (held by another process, or corrupt: final review
// CORE I1), the staging folder is left exactly as it is.
// stage() and stageTheme() (Task 8, an update's steps 2 to 4): the version must be the verified catalog's own entry of the listing (by version,
// archive URL, size and SHA-256), and that entry is what is fetched; anything else is `not_found` with no request.
// Log lines: `INSTALL <id> <phase> [<code>|<version>]` and `INSTALL <what> <code>`; never a path, a URL or a value from an archive.
const crypto = __importStar(require("node:crypto"));
const fs = __importStar(require("node:fs"));
const path = __importStar(require("node:path"));
const semver = __importStar(require("semver"));
const grants_1 = require("../grants");
const manifest_1 = require("../manifest");
const package_1 = require("../themes/package");
const client_1 = require("./client");
const indexformat_1 = require("./indexformat");
const names_1 = require("./names");
const records_1 = require("./records");
const stagecheck_1 = require("./stagecheck");
const swap_1 = require("./swap");
const zipread_1 = require("./zipread");
/** R26: the room an install keeps free on the disk of the profile, above the archive and above its unpacked size. */
exports.INSTALL_DISK_MARGIN = 16_777_216;
/** A `downloading` state at most every 256 KiB (and at the last byte). */
const PROGRESS_STEP = 262_144;
const log = (line) => { console.log(line); };
const codeOf = (e) => { const c = e?.code; return typeof c === 'string' && /^[A-Za-z_]{1,32}$/.test(c) ? c : 'error'; };
const installError = (error, detail) => Object.assign(new Error(`install: ${error}`), { error, ...(detail ? { detail } : {}) });
const isFail = (e) => typeof e?.error === 'string';
const sha256 = (b) => crypto.createHash('sha256').update(b).digest('hex');
/** The download's result as an install names it: a body that is not the listed one (size or hash) is `hash_mismatch`. */
function downloadError(e) {
    switch (e) {
        case 'offline':
        case 'timeout': return 'offline';
        case 'http_status':
        case 'bad_url': return 'unavailable';
        case 'too_large': return 'too_large';
        case 'size_mismatch':
        case 'hash_mismatch': return 'hash_mismatch';
        case 'disk': return 'disk';
    }
}
class Installer {
    d;
    states = new Map();
    flights = new Map();
    fns = new Set();
    fs;
    staging;
    constructor(d) {
        this.d = d;
        this.fs = d.fs ?? (0, swap_1.productSwapFs)();
        this.staging = path.join(d.userData, 'plugins', 'staging');
    }
    /** At start, before any plugin is registered (main.ts): a journaled swap finished, then the staging leftovers removed. Never throws. */
    recover() {
        try {
            const r = (0, swap_1.recoverSwap)(path.join(this.staging, 'swap.json'), this.fs);
            if (r !== 'none')
                log(`INSTALL recover ${r}`);
        }
        catch (e) {
            log(`INSTALL recover_failed ${codeOf(e)}`);
            return;
        } // the journal names folders in staging: all of it stays
        let names;
        try {
            if (!fs.lstatSync(this.staging).isDirectory()) {
                log('INSTALL staging_not_folder');
                return;
            }
            names = fs.readdirSync(this.staging);
        }
        catch (e) {
            if (codeOf(e) !== 'ENOENT')
                log(`INSTALL staging_unreadable ${codeOf(e)}`);
            return;
        }
        const staged = this.stagedUpdates();
        // CORE I1: what state.json names is unknown (held by another process, corrupt and moved aside): nothing goes, the parked old version of a
        // swap cut short at a start included; the next start that reads it cleans up.
        if (staged === null)
            return;
        const { dirs: keep, ids: stagedIds } = staged;
        for (const name of names) {
            if (keep.has(name))
                continue;
            const ids = this.leftoverIds(path.join(this.staging, name));
            try {
                this.fs.rm(path.join(this.staging, name));
            }
            catch (e) {
                log(`INSTALL staging_clean_failed ${codeOf(e)}`);
            }
            for (const id of ids)
                if (!stagedIds.has(id))
                    this.forgetLeftoverGrant(id);
        }
    }
    /** The plugin ids a staging entry holds a folder of (`<random>/<id>`); none for a file or a theme's staging (only its archive). */
    leftoverIds(entry) {
        try {
            if (!fs.lstatSync(entry).isDirectory())
                return [];
            return fs.readdirSync(entry).filter(n => (0, manifest_1.isPluginId)(n) && fs.lstatSync(path.join(entry, n)).isDirectory());
        }
        catch {
            return [];
        }
    }
    /**
     * An install cut short after Allow (the grant was written, the folder never reached the installed root): the grant goes too, unless
     * something of the id is still there (an installed folder, a bundled copy, a registered plugin). In doubt the grant stays.
     */
    forgetLeftoverGrant(id) {
        try {
            if (this.d.grants.get(id) === undefined || this.there(path.join(this.d.installedDir, id)) || this.d.isBuiltIn(id) || this.d.registry.manifestOf(id) !== undefined)
                return;
        }
        catch {
            return;
        }
        log(`INSTALL ${id} leftover_grant_forgotten`);
        void (0, grants_1.forgetGrant)(this.d.grants, id).then(r => { if (!r.saved)
            log(`INSTALL ${id} grant_forget_unsaved`); }, e => log(`INSTALL ${id} grant_forget_failed ${codeOf(e)}`));
    }
    /**
     * What market/state.json `staged` names (`dir` = `<random>/<id>`, relative to the staging root): the staging folders recover() keeps,
     * and the ids of those staged updates (an installed plugin's: its grant is never a leftover). Null when state.json could not be read
     * (`busy`, `quarantined`: CORE I1): then it names something unknown, and nothing of the staging folder may go.
     */
    stagedUpdates() {
        const dirs = new Set(), ids = new Set();
        try {
            const st = (this.d.state ?? new client_1.MarketStateFile(path.join(this.d.userData, 'market', 'state.json'))).read();
            if (st.status !== 'ok' && st.status !== 'missing') {
                log(`INSTALL staging_kept state_${st.status}`);
                return null;
            }
            for (const [id, s] of Object.entries(st.staged ?? {})) {
                ids.add(id);
                const first = s.dir.split('/')[0];
                if (first !== '' && first !== '.' && first !== '..' && !/[\\:]/.test(first))
                    dirs.add(first);
            }
        }
        catch (e) {
            log(`INSTALL staging_kept ${codeOf(e)}`);
            return null;
        } // unreadable: only what a journal named was acted on
        return { dirs, ids };
    }
    /** Installs the listing `id` (R26). A second call while one runs shares it. An id that is not a plugin id is `not_found`, with no state kept. */
    install(id) {
        if (typeof id !== 'string' || !(0, manifest_1.isPluginId)(id))
            return Promise.resolve({ id: typeof id === 'string' ? id : '', phase: 'failed', error: 'not_found' });
        const running = this.flights.get(id);
        if (running)
            return running;
        const p = this.run(id)
            .catch((e) => { log(`INSTALL ${id} bug ${codeOf(e)}`); return this.fail(id, isFail(e) ? e : { error: 'disk' }); })
            .finally(() => { if (this.flights.get(id) === p)
            this.flights.delete(id); });
        this.flights.set(id, p);
        return p;
    }
    /** The last state of an install of `id` in this run of the app, or undefined. */
    state(id) { const s = this.states.get(id); return s ? { ...s } : undefined; }
    onState(fn) { this.fns.add(fn); return () => { this.fns.delete(fn); }; }
    /**
     * Steps 2 to 4 for the listed plugin `id` at `v` (Task 8 reuses it for an update): the staged folder, its manifest and the archive's
     * SHA-256, or the failed state (nothing left on disk). `v` must be one of the verified catalog's versions of the listing, by value (its
     * version, archive URL, size and SHA-256), and the catalog's own entry is what is used: an update is never fetched from anywhere else
     * (`not_found`, with no request). `emit` hears the `downloading` and `checking` states (no install state is kept); `cleanup` removes the
     * staging folder. `signal` (an automatic update: "Check for updates" switched off, R31) aborts the download: `offline`, nothing left.
     */
    async stage(id, v, emit, signal) {
        const l = this.d.client.catalog()?.plugins.find(x => x.id === id);
        if (!(0, manifest_1.isPluginId)(id) || !l || l.type !== 'plugin' || (0, zipread_1.isDeviceNameId)(id))
            return { id, phase: 'failed', error: 'not_found' };
        const cv = catalogVersion(l, v);
        if (!cv)
            return { id, phase: 'failed', error: 'not_found' };
        try {
            return await this.stagePlugin(l, cv, s => { try {
                emit?.(s);
            }
            catch { /* a listener must not stop the stage */ } }, signal);
        }
        catch (e) {
            const f = isFail(e) ? e : { error: 'disk' };
            return { id, phase: 'failed', error: f.error, ...(f.detail ? { detail: f.detail } : {}) };
        }
    }
    /**
     * A theme listing's `theme.json` (and `LICENSE`) at `v` (Task 8: a theme package update), downloaded and checked as an install checks them,
     * for ThemePackages.addBytes; or the failed state. `v` is matched against the verified catalog as `stage` matches it. Nothing stays on disk.
     * `signal` as for `stage`.
     */
    async stageTheme(id, v, emit, signal) {
        const l = this.d.client.catalog()?.plugins.find(x => x.id === id);
        if (!(0, manifest_1.isPluginId)(id) || !l || l.type !== 'theme' || (0, zipread_1.isDeviceNameId)(id))
            return { id, phase: 'failed', error: 'not_found' };
        const cv = catalogVersion(l, v);
        if (!cv)
            return { id, phase: 'failed', error: 'not_found' };
        let dir = null;
        try {
            dir = this.makeStaging();
            return await this.themeBytes(l, cv, dir, s => { try {
                emit?.(s);
            }
            catch { /* a listener must not stop the stage */ } }, signal);
        }
        catch (e) {
            const f = isFail(e) ? e : { error: 'disk' };
            return { id, phase: 'failed', error: f.error, ...(f.detail ? { detail: f.detail } : {}) };
        }
        finally {
            if (dir)
                this.removeStaging(dir);
        }
    }
    // ---- internals ---------------------------------------------------------------------------------------------------------------
    emit(s) {
        this.states.set(s.id, s);
        if (s.phase !== 'downloading' || s.received === 0) {
            log(`INSTALL ${s.id} ${s.phase}${s.phase === 'failed' ? ` ${s.error}${s.detail ? ` ${s.detail}` : ''}` : s.phase === 'installed' ? ` ${s.version}` : ''}`);
        }
        for (const fn of [...this.fns]) {
            try {
                fn({ ...s });
            }
            catch { /* a listener must not stop an install */ }
        }
    }
    fail(id, f) {
        const s = { id, phase: 'failed', error: f.error, ...(f.detail ? { detail: f.detail } : {}) };
        this.emit(s);
        return s;
    }
    async run(id) {
        const pre = this.preconditions(id);
        if ('error' in pre)
            return this.fail(id, pre);
        return pre.l.type === 'theme' ? this.installTheme(pre.l, pre.v) : this.installPlugin(pre.l, pre.v);
    }
    /** Step 1 (and, with `again`, the check after Allow): the listing and version to install, or why not. */
    preconditions(id, again) {
        if (!this.d.client.installGate().ok)
            return { error: 'not_allowed' };
        const l = this.d.client.catalog()?.plugins.find(x => x.id === id);
        if (!l || (0, zipread_1.isDeviceNameId)(id))
            return { error: 'not_found' };
        if (this.d.isBuiltIn(id) || (l.type === 'theme' && this.d.themes.hasBundled(id)))
            return { error: 'built_in' }; // a theme package the app ships too
        if (l.type === 'plugin' && (this.d.pendingUninstall(id) || this.d.registry.manifestOf(id) !== undefined || this.there(path.join(this.d.installedDir, id))))
            return { error: 'busy' };
        const newest = [...l.versions].sort((a, b) => semver.rcompare(a.version, b.version));
        const v = l.type === 'theme' ? newest[0] : newest.find(x => x.engines !== undefined && semver.satisfies(manifest_1.HOST_API.version, x.engines));
        if (!v)
            return { error: 'incompatible_api' };
        if (again && (v.version !== again.version || v.archive.sha256.toLowerCase() !== again.sha256))
            return { error: 'not_found' }; // the listing changed during the prompt
        if (this.d.revocationOf(id, v.version) !== null)
            return { error: 'revoked' };
        if ((0, names_1.nameAllowed)({ name: l.name, author: l.author }, 'market', l.firstParty) !== true)
            return { error: 'reserved_name' };
        if (l.type === 'theme' && !this.d.themes.hasRoomFor(id))
            return { error: 'theme_full' };
        if (!again && !this.room(v.archive.size))
            return { error: 'disk' };
        return { l, v };
    }
    /** `exists` that answers true when it cannot tell (an install never goes over something it could not see). */
    there(p) { try {
        return this.fs.exists(p);
    }
    catch {
        return true;
    } }
    room(bytes) {
        let free;
        try {
            free = this.d.freeBytes(this.d.userData);
        }
        catch {
            return true;
        } // unknown: the write itself fails `disk` if it must
        return !(free < bytes + exports.INSTALL_DISK_MARGIN);
    }
    /** A new <staging>/<random> folder, on the installed root's file system (a rename between them must never become a copy). */
    makeStaging() {
        try {
            if (path.relative(path.dirname(this.staging), path.dirname(this.d.installedDir)) !== '') {
                log('INSTALL staging not_sibling');
                throw installError('disk');
            }
            fs.mkdirSync(this.staging, { recursive: true, mode: 0o700 });
            fs.mkdirSync(this.d.installedDir, { recursive: true });
            const st = fs.lstatSync(this.staging, { bigint: true }), it = fs.statSync(this.d.installedDir, { bigint: true });
            if (!st.isDirectory() || !it.isDirectory())
                throw installError('disk');
            if (st.dev !== it.dev) {
                log('INSTALL staging cross_device');
                throw installError('disk');
            }
            return fs.mkdtempSync(path.join(this.staging, 'i-'));
        }
        catch (e) {
            if (isFail(e))
                throw e;
            log(`INSTALL staging ${codeOf(e)}`);
            throw installError('disk');
        }
    }
    removeStaging(dir) {
        try {
            this.fs.rm(dir);
        }
        catch (e) {
            log(`INSTALL staging_clean_failed ${codeOf(e)}`);
        } // the next start removes it
    }
    /** Step 2: the archive at `v` downloaded into `dir`, read back with its cap and hashed again. Throws a Fail. */
    async fetchArchive(id, v, dir, emit, signal) {
        const file = path.join(dir, 'archive.zip'), total = v.archive.size;
        let shown = 0;
        emit({ id, phase: 'downloading', received: 0, total });
        const r = await this.d.download(v.archive.url, file, {
            size: total, sha256: v.archive.sha256, idleTimeoutMs: indexformat_1.ARCHIVE_IDLE_MS, userAgent: this.d.userAgent, allowLoopbackHttp: this.d.allowLoopbackHttp, ...(signal ? { signal } : {}),
            onProgress: n => { if (n === total || n - shown >= PROGRESS_STEP) {
                shown = n;
                emit({ id, phase: 'downloading', received: n, total });
            } },
        });
        if (!r.ok)
            throw installError(downloadError(r.error));
        let buf;
        try {
            buf = (0, manifest_1.readRegularFile)(file, 'archive', total, m => new Error(m));
        }
        catch {
            throw installError('disk');
        }
        if (buf.length !== total || sha256(buf) !== v.archive.sha256.toLowerCase())
            throw installError('hash_mismatch');
        return buf;
    }
    /** readZip, or the refusal as an `archive` failure naming it. */
    entries(buf) {
        const z = (0, zipread_1.readZip)(buf);
        if (!z.ok)
            throw installError('archive', z.reason);
        return z.entries;
    }
    /** Steps 2 to 4 for a plugin listing; the staging folder is removed when a step fails. */
    async stagePlugin(l, v, emit, signal) {
        const id = l.id;
        if (!this.room(v.archive.size))
            throw installError('disk');
        const dir = this.makeStaging();
        try {
            const buf = await this.fetchArchive(id, v, dir, emit, signal);
            emit({ id, phase: 'checking' });
            // R25 root layout, the unpacked folder, its manifest against the listing, the loader's checks: the checks index-verify runs too (stagecheck.ts)
            const c = (0, stagecheck_1.checkStagedPlugin)(this.entries(buf), dir, l, v, n => this.room(n));
            if (!c.ok) {
                if (c.error === 'disk' && c.code !== undefined)
                    log(`INSTALL ${id} extract ${c.code}`);
                throw installError(c.error);
            }
            return { dir: path.join(dir, id), manifest: c.manifest, sha256: v.archive.sha256.toLowerCase(), cleanup: () => this.removeStaging(dir) };
        }
        catch (e) {
            this.removeStaging(dir);
            throw e;
        }
    }
    async installPlugin(l, v) {
        let st;
        try {
            st = await this.stagePlugin(l, v, s => this.emit(s));
        }
        catch (e) {
            if (isFail(e))
                return this.fail(l.id, e);
            throw e;
        }
        try {
            return await this.allowAndMove(l, v, st);
        }
        finally {
            st.cleanup();
        }
    }
    /**
     * Steps 5 and 6. The grant the prompt wrote is taken back when the install does not end installed, a throw after Allow included. The A5
     * reset the prompt announces (a grant record an earlier copy of the id left could see names, this version can send data out) runs on
     * Allow, before the new grant is stored (grants.ts `hooks.wipe`); a failed wipe stores no grant and installs nothing (`disk`).
     */
    async allowAndMove(l, v, st) {
        const id = l.id, m = st.manifest;
        let providers;
        try {
            providers = this.d.providersFor(m);
        }
        catch {
            return this.fail(id, { error: 'unavailable' });
        }
        this.emit({ id, phase: 'prompt' });
        const before = this.d.grants.get(id);
        let wipeFailed = false;
        const hooks = { wipe: async (prompted) => { try {
                await this.d.resetPlugin(m, prompted);
            }
            catch (e) {
                wipeFailed = true;
                log(`INSTALL ${id} reset_failed ${codeOf(e)}`);
                throw e;
            } } };
        // m4: a prompt that could not be shown (its view failed, the queue dropped it) is not the user's answer: a failed install, not `denied`.
        let promptFailed = false;
        const prompter = {
            ask: async (req) => { try {
                return await this.d.prompter.ask(req);
            }
            catch (e) {
                promptFailed = true;
                log(`INSTALL ${id} prompt_failed ${codeOf(e)}`);
                throw e;
            } },
        };
        // m2: nothing of the id is registered (the preconditions refuse `busy` otherwise), so a grant record of it is stale: an install's ask.
        const fresh = this.d.registry.manifestOf(id) === undefined;
        const granted = await (0, grants_1.ensureGrant)(this.d.grants, prompter, m, providers, hooks, { recordDeny: false, source: 'market', fresh }).catch(() => null);
        if (granted === null && wipeFailed)
            return this.fail(id, { error: 'disk' });
        if (granted === null && promptFailed)
            return this.fail(id, { error: 'unavailable' });
        if (granted === null) {
            const s = { id, phase: 'denied' };
            this.emit(s);
            return s;
        }
        // E7: nothing of the id is registered, so a database under its data folder belongs to an earlier copy (the allowed install is the first start of this one): it goes first.
        if (fresh && this.d.ownerDeletes) {
            try {
                await this.d.ownerDeletes.freshInstall(id, false);
            }
            catch (e) {
                log(`INSTALL ${id} fresh_delete_failed ${codeOf(e)}`);
                await this.undoGrant(id, before);
                return this.fail(id, { error: 'disk' });
            }
        }
        try {
            return await this.moveIn(v, st, before);
        }
        catch (e) {
            await this.undoGrant(id, before);
            throw e;
        } // install() reports it (`disk`)
    }
    /** Step 6 after Allow: the preconditions again, the rename, the record (firstParty from the listing read after Allow) and the registry. */
    async moveIn(v, st, before) {
        const id = st.manifest.id;
        const undo = async (f) => { await this.undoGrant(id, before); return this.fail(id, f); };
        const again = this.preconditions(id, { version: v.version, sha256: st.sha256 });
        if ('error' in again)
            return undo(again);
        this.emit({ id, phase: 'installing' });
        const T = path.join(this.d.installedDir, id);
        const idn = (0, records_1.dirIdentity)(st.dir); // before the rename (6b carry 2): the record names the folder that was checked
        if (idn === null)
            return undo({ error: 'disk' });
        try {
            this.fs.rename(st.dir, T);
        }
        catch (e) {
            log(`INSTALL ${id} rename ${codeOf(e)}`);
            return undo({ error: 'disk' });
        } // EXDEV included: never a copy
        const back = () => { try {
            this.fs.rename(T, st.dir);
        }
        catch (e) {
            log(`INSTALL ${id} move_back_failed ${codeOf(e)}`);
        } };
        try {
            this.d.records.set(id, { version: v.version, sha256: st.sha256, firstParty: again.l.firstParty === true, dev: idn.dev, ino: idn.ino, at: new Date().toISOString() });
        }
        catch (e) {
            log(`INSTALL ${id} record ${codeOf(e)}`);
            back();
            return undo({ error: 'disk' });
        }
        let added;
        try {
            added = this.d.registry.addPluginDir(T);
        }
        catch (e) {
            added = { ok: false, code: codeOf(e) };
        }
        if (!added.ok) {
            log(`INSTALL ${id} register ${added.code}`);
            try {
                this.d.records.delete(id);
            }
            catch (e) {
                log(`INSTALL ${id} record_delete_failed ${codeOf(e)}`);
            }
            back();
            return undo({ error: (0, stagecheck_1.refusalCode)(added.code) });
        }
        const s = { id, phase: 'installed', version: v.version };
        this.emit(s);
        void this.d.registry.startAdded(id).catch(e => log(`INSTALL ${id} start ${codeOf(e)}`));
        return s;
    }
    async undoGrant(id, before) {
        try {
            if (before)
                this.d.grants.set(before);
            else
                await (0, grants_1.forgetGrant)(this.d.grants, id);
        }
        catch (e) {
            log(`INSTALL ${id} grant_undo_failed ${codeOf(e)}`);
        }
    }
    /** A theme archive at `v` fetched into `dir` and checked: `theme.json` and an optional `LICENSE` at the root and nothing else (R25), matching its listing. */
    async themeBytes(l, v, dir, emit, signal) {
        const buf = await this.fetchArchive(l.id, v, dir, emit, signal);
        emit({ id: l.id, phase: 'checking' });
        const entries = this.entries(buf);
        const json = entries.find(e => e.name === 'theme.json' && !e.dir)?.data ?? null;
        const license = entries.find(e => e.name === 'LICENSE' && !e.dir)?.data ?? null;
        if (json === null || entries.some(e => e.dir || (e.name !== 'theme.json' && e.name !== 'LICENSE')))
            throw installError('archive');
        let pkg;
        try {
            pkg = (0, package_1.parsePackage)(json);
        }
        catch {
            throw installError('archive');
        }
        if ((0, indexformat_1.themeListingDifference)(pkg, l, v) !== null)
            throw installError('listing_mismatch');
        return { json, license };
    }
    /** A theme listing: values only, no prompt; `theme.json` and an optional `LICENSE` at the archive root and nothing else (R25). */
    async installTheme(l, v) {
        const id = l.id;
        let dir = null;
        try {
            dir = this.makeStaging();
            const { json, license } = await this.themeBytes(l, v, dir, s => this.emit(s));
            const again = this.preconditions(id, { version: v.version, sha256: v.archive.sha256.toLowerCase() });
            if ('error' in again)
                throw installError(again.error);
            this.emit({ id, phase: 'installing' });
            let result;
            try {
                result = (await this.d.themes.addBytes(json, license)).result;
            }
            catch (e) {
                const c = codeOf(e);
                throw installError(c === 'too_large' ? 'theme_full' : c === 'bad_params' ? 'archive' : 'disk');
            }
            if (result === 'already')
                throw installError('busy'); // that version or a newer one is there already
            const s = { id, phase: 'installed', version: v.version };
            this.emit(s);
            return s;
        }
        catch (e) {
            if (isFail(e))
                return this.fail(id, e);
            throw e;
        }
        finally {
            if (dir)
                this.removeStaging(dir);
        }
    }
}
exports.Installer = Installer;
/** The verified catalog's own entry of the listing that is `v` by value (version, archive URL, size, SHA-256), or undefined. */
function catalogVersion(l, v) {
    if (typeof v !== 'object' || v === null || typeof v.archive !== 'object' || v.archive === null)
        return undefined;
    return l.versions.find(x => x.version === v.version && x.archive.url === v.archive.url && x.archive.size === v.archive.size
        && typeof v.archive.sha256 === 'string' && x.archive.sha256.toLowerCase() === v.archive.sha256.toLowerCase());
}
