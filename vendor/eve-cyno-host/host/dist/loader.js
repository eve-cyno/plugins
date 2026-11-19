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
exports.PluginRegistry = exports.isSourceHold = exports.contentType = exports.startFailure = void 0;
exports.inspectPluginDir = inspectPluginDir;
exports.sameDirAsScanned = sameDirAsScanned;
exports.isInstalledRoot = isInstalledRoot;
exports.scanPlugins = scanPlugins;
exports.scanIdOf = scanIdOf;
exports.openPluginFile = openPluginFile;
exports.readPluginFile = readPluginFile;
exports.watchDir = watchDir;
// Plugin loader: finds plugins on disk, refuses hostile ones before anything is created from them, and starts them lazily.
// Pure Node (no Electron): the Electron side (views, sessions, the eve-plugin:// scheme) is a `Runtime` the registry drives, and
// the egress proxy is made by an injected factory, so the lifecycle (activation, reload races) is tested under plain node.
const fs = __importStar(require("node:fs"));
const path = __importStar(require("node:path"));
const buildinfo_1 = require("./buildinfo");
const errors_1 = require("./errors");
const servebudget_1 = require("./servebudget");
const grants_1 = require("./grants");
const manifest_1 = require("./manifest");
const zipread_1 = require("./market/zipread");
const refuse = (dir, code = 'bad_manifest') => ({ refused: { dir, code } });
/** The log line of a failed start: a code-less error (not a manifest problem) names its class and a short message with no path in it. */
const startFailure = (e) => {
    const code = e?.code;
    if (typeof code === 'string')
        return code === 'bad_manifest' ? 'bad_manifest' : 'start failed';
    const name = e instanceof Error ? e.name : typeof e;
    const msg = (e instanceof Error ? e.message : String(e)).replace(/(?:[A-Za-z]:)?[\\/]\S*/g, '<path>').replace(/\s+/g, ' ').slice(0, 80);
    return `start failed ${name}${msg ? ': ' + msg : ''}`;
};
exports.startFailure = startFailure;
const codeOf = (e) => (typeof e?.code === 'string' ? e.code : 'bad_manifest');
/**
 * Reads one plugin directory `<root>/<name>`. Nothing is created: no partition, origin or directory is named from the manifest
 * until every check here has passed. Returns null for an entry that is not a plugin candidate at all (a stray file).
 *  - the directory name must be a valid plugin id and equal the manifest id; `folder` (D20, a folder the user picked, HT-M4) skips that:
 *    the folder name is free and the manifest id must be a valid plugin id that is not a device name instead;
 *  - the directory must not be a link (a link could lead anywhere); its manifest is read by readManifestFile (bounded, no links);
 *  - `main` is resolved with realpath and must be a regular file inside the real plugin directory.
 */
function inspectPluginDir(root, name, strict = false, folder = false) {
    const dir = path.join(root, name);
    let st;
    try {
        st = fs.lstatSync(dir, { bigint: true });
    }
    catch {
        return refuse(dir);
    }
    if (st.isSymbolicLink())
        return refuse(dir);
    if (!st.isDirectory())
        return null;
    if (!folder && (!(0, manifest_1.isPluginId)(name) || (0, zipread_1.isDeviceNameId)(name)))
        return refuse(dir); // `nul.evecyno.x` could not exist on Windows: refused on every OS
    let manifest;
    try {
        manifest = (0, manifest_1.parseManifest)((0, manifest_1.parseManifestJson)((0, manifest_1.readManifestFile)(path.join(dir, 'plugin.json'))));
    }
    catch (e) {
        return refuse(dir, codeOf(e));
    }
    if (folder ? !(0, manifest_1.isPluginId)(manifest.id) || (0, zipread_1.isDeviceNameId)(manifest.id) : manifest.id !== name)
        return refuse(dir);
    let real, native;
    try {
        real = fs.realpathSync(dir);
        native = fs.realpathSync.native(dir);
        const file = path.join(real, manifest.main);
        const main = fs.realpathSync(file);
        const ml = fs.lstatSync(file); // main itself is never a link, not even one that stays inside the directory
        if (!main.startsWith(real + path.sep) || !ml.isFile() || (strict && ml.nlink > 1))
            return refuse(dir);
    }
    catch {
        return refuse(dir);
    }
    return { dir, manifest, real, native, dev: st.dev, ino: st.ino, strict, ...(folder ? { folder: true } : {}) };
}
/** True while `f.dir` is still the directory the scan saw: not a link, same device and inode. */
function sameDirAsScanned(f) {
    try {
        const st = fs.lstatSync(f.dir, { bigint: true });
        return st.isDirectory() && !st.isSymbolicLink() && st.dev === f.dev && st.ino === f.ino;
    }
    catch {
        return false;
    }
}
/**
 * True when `root` is the INSTALLED root in any spelling (B4c carry): a trailing or doubled separator, a link or junction to it, the
 * installed root itself named through a link, another case on Windows. Compared on the resolved real paths (fs.realpathSync.native,
 * case-folded on win32), never on the spelling. A root that cannot be resolved has nothing to load, so it is not strict.
 */
function isInstalledRoot(root, installedDir) {
    if (installedDir === undefined)
        return false;
    const real = (p) => { const r = fs.realpathSync.native(p); return process.platform === 'win32' ? r.toLowerCase() : r; };
    try {
        return real(root) === real(installedDir);
    }
    catch {
        return false;
    }
}
/** Scans the plugin roots (built-in, installed, fixtures in test builds). A root that does not exist has no plugins. */
function scanPlugins(dirs, installedDir) {
    const out = { ok: [], refused: [] };
    const seen = new Set();
    for (const root of dirs) {
        let names;
        try {
            names = fs.readdirSync(root);
        }
        catch {
            continue;
        }
        const strict = isInstalledRoot(root, installedDir);
        for (const name of names.sort()) {
            const r = inspectPluginDir(root, name, strict);
            if (r === null)
                continue;
            if ('refused' in r) {
                out.refused.push(r.refused);
                continue;
            }
            if (seen.has(r.manifest.id)) {
                out.refused.push({ dir: r.dir, code: 'bad_manifest' });
                continue;
            } // the first root wins
            seen.add(r.manifest.id);
            out.ok.push(r);
        }
    }
    return out;
}
// ---- serving files -------------------------------------------------------------------------------------------------
const TYPES = {
    '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.map': 'application/json; charset=utf-8',
    '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
    '.webp': 'image/webp', '.ico': 'image/x-icon', '.woff': 'font/woff', '.woff2': 'font/woff2', '.txt': 'text/plain; charset=utf-8',
    '.wasm': 'application/wasm',
};
const contentType = (file) => TYPES[path.extname(file).toLowerCase()] ?? 'application/octet-stream';
exports.contentType = contentType;
/** The identity of a root as it is now (tests; production takes it from the scan). */
function scanIdOf(root) {
    const st = fs.lstatSync(root, { bigint: true });
    return { dev: st.dev, ino: st.ino, native: fs.realpathSync.native(root) };
}
const normNative = (p) => (process.platform === 'win32' ? p.toLowerCase() : p).replace(/\\/g, '/');
function openPluginFile(root, urlPath, strict = false, scan) {
    let rel;
    try {
        rel = decodeURIComponent(urlPath);
    }
    catch {
        return null;
    }
    if (rel.includes('\0') || rel.includes('\\'))
        return null;
    const candidate = path.join(root, rel);
    if (!candidate.startsWith(root + path.sep))
        return null;
    const C = fs.constants;
    const linux = process.platform === 'linux' && !scan?.walk;
    let fd = -1;
    try {
        let id = scan;
        if (!linux) {
            if (!id)
                return null; // the scan's identity of the root is what makes the checks mean something
            if (!rootIsScanned(root, id) || !walkHasNoLinks(root, candidate))
                return null;
        }
        fd = fs.openSync(candidate, C.O_RDONLY | (C.O_NOFOLLOW ?? 0) | (C.O_NONBLOCK ?? 0));
        const opened = fs.fstatSync(fd, { bigint: true });
        if (!opened.isFile() || (strict && opened.nlink > 1n))
            throw new Error('refused');
        if (linux) {
            const where = fs.readlinkSync(`/proc/self/fd/${fd}`);
            if (!where.startsWith(root + path.sep))
                throw new Error('outside');
        }
        else {
            if (!(0, manifest_1.sameRegularFile)(fs.lstatSync(candidate, { bigint: true }), opened))
                throw new Error('not the same file');
            const nroot = normNative(id.native), served = normNative(fs.realpathSync.native(candidate));
            if (!served.startsWith(nroot.endsWith('/') ? nroot : nroot + '/'))
                throw new Error('outside (native)');
            if (!rootIsScanned(root, id) || !walkHasNoLinks(root, candidate))
                throw new Error('link');
        }
        return { fd, size: Number(opened.size), type: (0, exports.contentType)(candidate) };
    }
    catch {
        if (fd >= 0)
            try {
                fs.closeSync(fd);
            }
            catch { /* already closed */ }
        return null;
    }
}
// The plugin root is still the directory the scan saw: not a link, same device and inode.
function rootIsScanned(root, id) {
    const st = fs.lstatSync(root, { bigint: true });
    return st.isDirectory() && !st.isSymbolicLink() && st.dev === id.dev && st.ino === id.ino;
}
// Every component from `root` (exclusive) down to `file` exists, is not a link, and all but the last are directories.
function walkHasNoLinks(root, file) {
    const parts = path.relative(root, file).split(path.sep);
    let cur = root;
    for (let i = 0; i < parts.length; i++) {
        cur = path.join(cur, parts[i]);
        const st = fs.lstatSync(cur);
        if (st.isSymbolicLink() || (i < parts.length - 1 ? !st.isDirectory() : !st.isFile()))
            return false;
    }
    return true;
}
/**
 * Reads a served file completely from its checked descriptor (at most `maxBytes`, else null) and closes the descriptor in every
 * case, so an aborted request cannot leak it. With a `budget`, the file's bytes are reserved first: over the budget this throws
 * ServeBusy (nothing was read), and the caller calls `release()` of the result when the response is complete or aborted.
 */
function readPluginFile(root, urlPath, strict = false, maxBytes = servebudget_1.MAX_SERVED_FILE_BYTES, scan, budget) {
    const f = openPluginFile(root, urlPath, strict, scan);
    if (!f)
        return null;
    let release = null;
    try {
        if (f.size > maxBytes)
            return null;
        if (budget) {
            release = budget.take(f.size);
            if (!release)
                throw new servebudget_1.ServeBusy();
        }
        const data = Buffer.alloc(f.size);
        let n = 0;
        while (n < f.size) {
            const r = fs.readSync(f.fd, data, n, f.size - n, n);
            if (r === 0)
                break;
            n += r;
        }
        return { data: n === f.size ? data : data.subarray(0, n), type: f.type, release: release ?? (() => { }) };
    }
    catch (e) {
        release?.();
        if (e instanceof servebudget_1.ServeBusy)
            throw e;
        return null;
    }
    finally {
        try {
            fs.closeSync(f.fd);
        }
        catch { /* already closed */ }
    }
}
const SOURCE_HOLDS = new Set(['source_removed', 'source_unknown', 'source_busy']);
/** True for the causes of a source that is not live (DP3). */
const isSourceHold = (by) => by !== undefined && SOURCE_HOLDS.has(by);
exports.isSourceHold = isSourceHold;
/** The holds the user cannot switch on: a revocation (R28) and a source that is not live (DP3). */
const isHold = (by) => by === 'revoked' || (0, exports.isSourceHold)(by);
const noop = () => { };
class PluginRegistry {
    deps;
    entries = new Map();
    seq = 0; // monotonically increasing: every start and every stop takes a new token
    readyMs;
    stateFns = [];
    dropFns = [];
    closes = new Map(); // plugin id -> the pages of it still closing: every wipe awaits it (N4, T11 N1)
    swaps = new Map(); // plugin id -> its replaceFiles in progress (R29): an activate waits for it
    swappedOut = new WeakSet(); // entries an update replaced: a grant decision of theirs still queued writes nothing
    named = new Map(); // plugin id -> the revoked version applyRevocations last named (its notice is posted once)
    scanned = false; // the first scan told onFirstScan
    wiping = new Set(); // plugin ids whose grant decision runs a wipe or a narrow delete right now: their start has no page up (A4, `isLive`)
    constructor(deps) {
        this.deps = deps;
        this.readyMs = deps.readyMs ?? 15_000;
    }
    // ---- discovery ---------------------------------------------------------------------------------------------------
    /** Scans the roots and registers every plugin that passed (its services and contributions), without starting any. */
    discover() {
        const scan = scanPlugins(this.deps.dirs(), this.deps.installedDir);
        const ok = [];
        for (const f of scan.ok) {
            const code = this.register(f);
            if (code === null)
                ok.push(f);
            else
                scan.refused.push({ dir: f.dir, code });
        }
        for (const r of scan.refused)
            console.error('PLUGIN_NOT_LOADED', JSON.stringify(path.basename(r.dir)), r.code);
        if (!this.scanned) {
            this.scanned = true;
            try {
                this.deps.onFirstScan?.([...this.entries.keys()]);
            }
            catch { /* a listener must not stop the scan */ }
        }
        return { ok, refused: scan.refused };
    }
    /**
     * Adds one plugin directory (a test mode's copy, an install). Replaces a registered plugin of the same id.
     * `o.folder` (D20, a folder the user picked in Settings > Plugins): checked as an installed plugin is (strict: no hard-linked files; the
     * `skip` and R27 `admit` hooks), and an id that is registered already, from any directory, is refused with `id_taken` before that entry is
     * touched: a folder never shadows a built-in, installed or fixture plugin, and the folder's own plugin is read again with `reload`.
     */
    addPluginDir(dir, o = {}) {
        const folder = o.folder === true;
        const r = inspectPluginDir(path.dirname(dir), path.basename(dir), folder || this.strictRoot(path.dirname(dir)), folder);
        if (r === null)
            return { ok: false, code: 'bad_manifest' };
        if ('refused' in r)
            return { ok: false, code: r.refused.code };
        if (folder && this.entries.has(r.manifest.id))
            return { ok: false, code: 'id_taken' };
        const code = this.register(r);
        return code === null ? { ok: true, id: r.manifest.id } : { ok: false, code };
    }
    strictRoot(root) { return isInstalledRoot(root, this.deps.installedDir); }
    // Registers the manifest's services and contributions. Providers are registered at discovery, not at start: a lazy provider
    // must be known (and consentable) before it has ever run. null when registered, else the refusal code.
    register(f) {
        if (f.strict && this.deps.skip?.(f.manifest.id))
            return 'uninstalling'; // the installed root only: a bundled or fixture plugin is never hidden
        if (f.strict && this.deps.admit) { // R27, the installed root only; before the old entry is touched, so a refused update leaves it registered
            let code;
            try {
                code = this.deps.admit(f.manifest.id, f.manifest, f.strict);
            }
            catch (e) {
                code = codeOf(e);
            }
            if (code !== null)
                return typeof code === 'string' && code !== '' ? code : 'bad_manifest';
        }
        const old = this.entries.get(f.manifest.id);
        if (old) {
            this.teardown(old);
            this.dropped(old.id);
        }
        try {
            this.deps.services.addProvider(f.manifest);
        }
        catch (e) {
            if (old)
                this.unregister(old);
            return codeOf(e);
        }
        this.deps.contributions.add(f.manifest);
        // The new entry starts in the state the old one was left in, so listeners hear exactly the change (disabled -> stopped, or none).
        const e = { id: f.manifest.id, dir: f.dir, manifest: f.manifest, found: f, state: old?.state ?? 'stopped', disabledBy: old?.disabledBy, token: ++this.seq, tail: old?.tail ?? Promise.resolve() };
        if (old?.fresh === true && old.dir === f.dir)
            e.fresh = true; // D20: a reload of a folder plugin not allowed yet is still asked afresh
        this.entries.set(e.id, e);
        // R28: a revoked version is registered disabled (a cached revocation stops it before anything starts it); another version in its place
        // (a fix installed or copied over it) is not. DP3: so is a plugin whose source is not live. The user switched it off: never asked, never started.
        const hold = this.holdOf(e);
        if (hold)
            this.setState(e, 'disabled', hold);
        else if (this.deps.prefs?.isDisabled(e.id))
            this.setState(e, 'disabled', 'user');
        else
            this.setState(e, 'stopped');
        return null;
    }
    // R28: the hook's answer for the registered version; a throw is revoked (fail closed).
    isRevoked(e) {
        const r = this.deps.revoked;
        if (!r)
            return false;
        try {
            return r(e.id, e.manifest.version) === true;
        }
        catch {
            return true;
        }
    }
    // DP3 plan 7.5: the source hook's answer for a plugin of the installed root (only there can an install record bind one); a throw, or an
    // answer that is no SourceHold, is `source_busy` (fail closed).
    sourceHoldOf(e) {
        const f = this.deps.sourceHold;
        if (!f || !e.found.strict)
            return null;
        let r;
        try {
            r = f(e.id);
        }
        catch {
            return 'source_busy';
        }
        if (r === null || r === undefined)
            return null;
        return typeof r === 'string' && SOURCE_HOLDS.has(r) ? r : 'source_busy';
    }
    // What holds the plugin off now: a revocation first, then a source that is not live; null, nothing.
    holdOf(e) { return this.isRevoked(e) ? 'revoked' : this.sourceHoldOf(e); }
    held(e) { return e.state === 'disabled' && isHold(e.disabledBy); }
    // ---- lifecycle ---------------------------------------------------------------------------------------------------
    /**
     * Registers everything, then settles every consent concurrently (a denied plugin is listed as disabled) and starts each `onStartup`
     * plugin as soon as its own grant settles: a prompt nobody answers holds back only its own plugin. Resolves when every plugin has
     * settled (and started); product callers do not wait for it.
     */
    async startAll() {
        this.discover();
        await Promise.all([...this.entries.values()].map(async (e) => {
            await this.settleGrant(e);
            await this.startIfStartup(e);
        }));
    }
    async startIfStartup(e) {
        if (e.state === 'disabled' || this.entries.get(e.id) !== e || !e.manifest.activationEvents.includes('onStartup'))
            return;
        // A plugin held for a delete is no failure: the owner's replay starts it once the delete is done (PLUGIN_HELD_FOR_DELETE was logged by `run`).
        await this.activate(e.id).catch(err => { if (err?.held !== true)
            console.error('PLUGIN_NOT_LOADED', e.id, codeOf(err)); });
    }
    /** Why the plugin is disabled: the user switched it off, its consent is denied, it is revoked, or its source is not live. undefined when it is not disabled. */
    disabledBy(id) {
        const e = this.entries.get(id);
        return e && e.state === 'disabled' ? e.disabledBy : undefined;
    }
    /**
     * R28: applies the `revoked` hook's answers to every registered plugin, at once (Revocations.apply calls it on every index change).
     *  - Revoked now and not before: its egress proxy stops first (a dead port refuses every connection), then its page and everything that
     *    hangs on it; the state is `disabled` by `revoked`. Nothing of its data, grant or files is touched.
     *  - No longer revoked: it returns to the state it had. Switched off by the user: disabled by the user. Otherwise `stopped`, its consent
     *    settled as at a start (a denied version stays disabled by consent and is not asked again) and started when it starts at startup.
     * DP3 plan 7.5: the `sourceHold` hook's answers are applied in the same pass, the same way (a revocation wins): a plugin whose source is
     * no longer live is held by the source's cause (its proxy first, then its page; never named here), one whose source is live again returns
     * to the state it had, and a plugin held already only takes the new cause (nothing starts).
     * Returns the ids revoked now that it has not named yet at their registered version (revoked here, or registered revoked since the last
     * call: a cached revocation at a start); the notice is the caller's.
     */
    applyRevocations() {
        const out = [];
        for (const e of [...this.entries.values()]) {
            if (this.entries.get(e.id) !== e)
                continue; // replaced meanwhile (a listener reacted to a change)
            const revoked = this.isRevoked(e);
            const hold = revoked ? 'revoked' : this.sourceHoldOf(e);
            const was = this.held(e) ? e.disabledBy : null;
            if (hold && !was)
                this.holdNow(e, hold);
            else if (!hold && was)
                this.lift(e, was);
            else if (hold && was !== hold) {
                e.token = ++this.seq;
                this.setState(e, 'disabled', hold);
            } // off already: only its cause changes
            if (!revoked) {
                this.named.delete(e.id);
                continue;
            }
            if (this.named.get(e.id) !== e.manifest.version) {
                this.named.set(e.id, e.manifest.version);
                out.push(e.id);
            }
        }
        for (const id of [...this.named.keys()])
            if (!this.entries.has(id))
                this.named.delete(id);
        return out;
    }
    // The proxy before the page (R28): from the first step on, nothing the page still sends reaches a server. The same for a source's hold (DP3).
    holdNow(e, by) {
        this.dropProxy(e, e.proxy);
        this.teardown(e, 'disabled', by);
        console.warn('PLUGIN_DISABLED', JSON.stringify(e.id), `(${by})`);
    }
    // Back to the state it had before the revocation or the source's hold (see applyRevocations).
    lift(e, was) {
        e.token = ++this.seq;
        console.warn(was === 'revoked' ? 'PLUGIN_REVOCATION_LIFTED' : 'PLUGIN_SOURCE_LIVE', JSON.stringify(e.id));
        if (this.deps.prefs?.isDisabled(e.id)) {
            this.setState(e, 'disabled', 'user');
            return;
        }
        this.setState(e, 'stopped');
        void this.settleGrant(e).then(() => this.startIfStartup(e)).catch(noop);
    }
    /**
     * After `addPluginDir` (an install, Task 6): settles that one plugin's grant and starts it when its activation events include `onStartup`,
     * as `startAll` does for each entry. A denied plugin is disabled by consent and never started. Throws `not_found` for an id not registered.
     * `o.fresh` (D20, a folder plugin whose folder has no grant of its own): a grant record of the id is stale, left by another copy, so every
     * ask of this entry (and of its reloads) is an install's (`recordDeny: false`, `fresh`) until one is allowed: never the old record's grant.
     */
    async startAdded(id, o = {}) {
        const e = this.entries.get(id);
        if (!e)
            throw (0, errors_1.coded)('not_found', 'plugin');
        if (o.fresh === true)
            e.fresh = true;
        await this.settleGrant(e);
        await this.startIfStartup(e);
    }
    /** Called when a registered plugin is replaced (reload, a new directory of the same id) or removed: what was asked about the old one is moot. */
    onDropped(fn) { this.dropFns.push(fn); }
    /** Called on every state change of every plugin (including `disabled`, from any cause, and a new cause of it). */
    onState(fn) { this.stateFns.push(fn); }
    /**
     * The user's switch. Off: the plugin is stopped and listed as disabled (kept in the preferences). On: the flag is cleared, the
     * plugin is `stopped`, its consent is settled (a plugin whose consent is denied stays disabled, by consent) and it starts if it
     * would start at startup; otherwise it waits for its first command or service as usual. A revoked plugin (R28), or one whose source is not
     * live (DP3): On throws `not_permitted` and changes nothing; Off is kept in the preferences and the plugin stays disabled by that cause
     * until it is lifted.
     */
    async setEnabled(id, on) {
        const e = this.entries.get(id);
        if (!e)
            throw (0, errors_1.coded)('not_found', 'plugin');
        const revoked = this.held(e);
        if (on && revoked)
            throw (0, errors_1.coded)('not_permitted', e.disabledBy === 'revoked' ? 'plugin is revoked' : 'plugin source is not available'); // R28: while it holds; the preference stays as it is
        this.deps.prefs?.setDisabled(id, !on);
        if (!on) {
            if (revoked)
                return; // kept off by the user too: when the hold is lifted it stays disabled (by the user)
            if (e.state === 'disabled') {
                e.token = ++this.seq;
                this.setState(e, 'disabled', 'user');
                return;
            } // consent-disabled: same state, new cause
            this.teardown(e, 'disabled', 'user');
            return;
        }
        if (e.state !== 'disabled' || e.disabledBy !== 'user')
            return; // consent-disabled stays so until `reconsider`
        // Settle the consent while still disabled, then emit the final state once (no stopped -> disabled flicker for a denied version).
        const token = e.token;
        const g = await this.grantOf(e);
        if (e.token !== token || this.entries.get(e.id) !== e)
            return;
        if (g === null) {
            this.setState(e, 'disabled', 'consent');
            console.warn('PLUGIN_DISABLED', JSON.stringify(e.id), '(consent needed)');
            return;
        }
        this.setState(e, 'stopped');
        await this.startIfStartup(e);
    }
    /** Asks again about a denied version: clears the denial and settles the grant through the prompter. Allowed: the plugin leaves `disabled`. */
    async reconsider(id) {
        const e = this.entries.get(id);
        if (!e)
            throw (0, errors_1.coded)('not_found', 'plugin');
        if (e.state === 'disabled' && (e.disabledBy === 'user' || isHold(e.disabledBy)))
            return; // switched off by the user, revoked (R28) or its source not live (DP3): never asked, its stored denial stays
        this.deps.grants.clearDenied(id);
        const token = e.token;
        const g = await this.grantOf(e);
        if (e.token !== token || this.entries.get(e.id) !== e)
            return;
        if (g === null) {
            if (e.state !== 'disabled')
                this.teardown(e, 'disabled', 'consent');
            return;
        } // a running plugin loses its page
        if (e.state === 'disabled' && e.disabledBy === 'consent') {
            this.setState(e, 'stopped');
            await this.startIfStartup(e);
        }
    }
    /**
     * Starts the plugin if it is not running and resolves, with the way to message it, once its page can receive. Concurrent
     * calls share one start. `why` is the use that asks for it: a plugin whose activation events name neither that command nor
     * that service (and not `onStartup`) is not started for it.
     */
    async activate(id, why) {
        const swapping = this.swaps.get(id);
        if (swapping) {
            await swapping;
            return await this.activate(id, why);
        } // R29: its files are being replaced; what is registered after is used
        const e = this.entries.get(id);
        if (!e)
            throw (0, errors_1.coded)('not_found', 'plugin');
        let p = e.starting;
        for (let i = 0; i < 8; i++) {
            if (this.swaps.has(id))
                return await this.activate(id, why); // an update began while this call waited
            if (e.state === 'disabled')
                throw (0, errors_1.coded)('unavailable', 'plugin is disabled');
            if (this.entries.get(id) !== e)
                return await this.activate(id, why); // replaced (an update) while waiting
            if (e.state === 'running') {
                if (!this.deps.runtime.isReady(id)) {
                    try {
                        await this.deps.runtime.whenReady(id, this.readyMs);
                    }
                    catch {
                        if (this.swaps.has(id) || this.entries.get(id) !== e)
                            return await this.activate(id, why); // torn down for an update
                        throw (0, errors_1.coded)('unavailable', 'plugin is not ready');
                    }
                }
                return { send: msg => this.deps.runtime.send(id, msg) };
            }
            if (!p) {
                // A plugin stopped while this call waited stays stopped; only the first look may start it.
                if (i > 0)
                    throw (0, errors_1.coded)('unavailable', 'plugin was stopped');
                if (why && !this.mayStartFor(e, why))
                    throw (0, errors_1.coded)('unavailable', 'plugin is not activated by this');
                p = this.begin(e);
            }
            await p; // a start that was superseded returns quietly: the next round waits for the newer one, if there is one
            p = e.starting;
        }
        throw (0, errors_1.coded)('unavailable', 'plugin did not start');
    }
    mayStartFor(e, why) {
        const ev = e.manifest.activationEvents;
        if (ev.length === 0 || ev.includes('onStartup'))
            return true; // no events: loads on first use of anything it contributes
        return 'command' in why ? ev.includes(`onCommand:${why.command}`) : ev.includes(`onService:${why.service}`);
    }
    /** Stops the plugin's page now. Its registration stays: a later use starts it again. */
    stop(id) {
        const e = this.entries.get(id);
        if (e)
            this.teardown(e);
    }
    /** Idle plugin: the page is torn down like `stop`, the registration and its contributions stay, and the next use starts it again. */
    suspend(id) {
        const e = this.entries.get(id);
        if (!e)
            return;
        this.deps.onSuspending?.(id);
        this.teardown(e, 'suspended');
        this.deps.onSuspended?.(id);
    }
    /**
     * Suspends the running plugins that `tracker` reports idle, that `isHeld` does not hold, whose view is not visible and that do
     * not declare `background: true` (R9). Returns the ids suspended. Plugins that are starting, stopped or disabled are not looked at.
     */
    suspendIdle(tracker, isHeld, viewVisible) {
        const candidates = [...this.entries.values()].filter(e => e.state === 'running' && !this.keepsRunning(e) && !viewVisible(e.id)).map(e => e.id);
        const ids = tracker.idle(candidates, isHeld);
        for (const id of ids)
            this.suspend(id);
        return ids;
    }
    /** The page cannot be restarted (the runtime gave up): the plugin is stopped and the next use starts it afresh. */
    gone(id) { this.stop(id); }
    /** Re-reads the plugin from its directory (an update) and starts it again. */
    async reload(id) {
        const e = this.entries.get(id);
        if (!e)
            throw (0, errors_1.coded)('not_found', 'plugin');
        const r = inspectPluginDir(path.dirname(e.dir), path.basename(e.dir), e.found.strict, e.found.folder === true);
        // A refused reload leaves nothing registered: the old manifest must not start over a directory that no longer passes.
        if (r === null || 'refused' in r || r.manifest.id !== id) {
            this.unregister(e);
            throw (0, errors_1.coded)('bad_manifest', 'plugin.json: not loadable');
        }
        const code = this.register(r);
        if (code !== null) {
            this.unregister(e);
            throw (0, errors_1.coded)(code === 'service_conflict' ? 'service_conflict' : 'bad_manifest', 'plugin is not loadable');
        }
        await this.activate(id);
    }
    list() {
        return [...this.entries.values()].map(e => ({ id: e.id, state: e.state }));
    }
    /** Each registered plugin's state, `background` flag and, for a background plugin, whether its manifest lets memory pressure suspend it (the memory-pressure check). */
    snapshot() {
        return [...this.entries.values()].map(e => ({ id: e.id, state: e.state, background: this.keepsRunning(e), releasable: this.keepsRunning(e) && e.manifest.suspendUnderPressure === true }));
    }
    state(id) { return this.entries.get(id)?.state; }
    /**
     * Stops the plugin (its egress proxy, its page and everything that hangs on it, as `stop`) and resolves once no page of it is still closing.
     * Its registration stays. An unknown plugin: only the pending closes are waited for.
     */
    async stopAndWait(id) {
        const e = this.entries.get(id);
        if (e) {
            this.dropProxy(e, e.proxy);
            await Promise.resolve(this.teardown(e)).catch(noop);
        }
        await this.closed(id);
    }
    /**
     * R29: replaces the files of the registered plugin `id` with an update, in place. In order: the plugin is stopped and every page of it has
     * closed (`stopAndWait`); `swap` puts the new folder at the plugin's path; the new folder is scanned and registered in place of the old entry
     * (the same checks as a scan: `admit`, `skip`, the services). A `swap` that throws leaves the old entry registered. A new folder the registry
     * refuses is undone with the swap's `rollback()` and the old version is registered again (it stays registered when the refusal came before
     * it was touched); the call then throws `bad_manifest` (or `service_conflict`). The plugin starts again when it was running or starting (or
     * `o.restart`: a caller that stopped it itself), whichever folder it ends on; a revoked plugin whose new version is not revoked is settled and
     * started as a lifted revocation is. While this runs, `activate` of the id waits for it and then uses whatever is registered: never the old
     * files after the swap, never two copies. A second call for the same id while one runs throws `unavailable`.
     * `o.failed`: runs once when the call is about to throw after the plugin was stopped (the swap threw, or the new folder was refused), BEFORE
     * the old version starts again: a reviewed update takes back the grant its prompt wrote for the new version there, so the old version's start
     * never reads it (final review ORCH I1: read against the new grant, the old version's start could fire the A5 reset). A throw of it is logged.
     */
    async replaceFiles(id, swap, o = {}) {
        const e = this.entries.get(id);
        if (!e)
            throw (0, errors_1.coded)('not_found', 'plugin');
        if (this.swaps.has(id))
            throw (0, errors_1.coded)('unavailable', 'the plugin is being updated');
        let done;
        const marker = new Promise(r => { done = r; });
        this.swaps.set(id, marker);
        const finish = () => { if (this.swaps.get(id) === marker)
            this.swaps.delete(id); done(); };
        const live = o.restart === true || e.state === 'running' || e.state === 'starting';
        const wasRevoked = this.held(e); // revoked (R28) or its source not live (DP3)
        const startAgain = async () => {
            const now = this.entries.get(id);
            if (!now || now.state === 'disabled')
                return;
            if (live) {
                await this.activate(id).catch(err => { if (err?.held !== true)
                    console.error('PLUGIN_NOT_LOADED', JSON.stringify(id), codeOf(err)); });
                return;
            } // a held plugin is no failure: the owner's replay starts it (PLUGIN_HELD_FOR_DELETE was logged by `run`)
            if (wasRevoked && now !== e) {
                await this.settleGrant(now);
                await this.startIfStartup(now);
            } // the fix of a revoked version: as `lift`
        };
        const failed = async () => {
            try {
                await o.failed?.();
            }
            catch (err) {
                console.error('PLUGIN_UPDATE_UNDO_FAILED', JSON.stringify(id), codeOf(err));
            }
        };
        let undo;
        try {
            await this.stopAndWait(id);
            undo = await swap();
        }
        catch (err) {
            await failed(); // before finish(): an activate waiting for the swap must not read the grant it takes back
            finish();
            await startAgain(); // nothing was replaced: the old files run again as they did
            throw err;
        }
        const code = this.registerAt(e, id);
        if (code !== null) {
            console.error('PLUGIN_NOT_LOADED', JSON.stringify(id), code);
            let back = true;
            try {
                await undo.rollback();
            }
            catch (err) {
                back = false;
                console.error('PLUGIN_UPDATE_ROLLBACK_FAILED', JSON.stringify(id), codeOf(err));
            }
            const cur = this.entries.get(id);
            if (!back) {
                if (cur)
                    this.unregister(cur);
            } // the folder is in no known state: nothing of it runs (the journal is finished at the next start)
            else if (cur !== e) { // the old entry was let go (a refusal after the teardown): the old folder is registered again
                const again = this.registerAt(e, id);
                if (again !== null) {
                    const left = this.entries.get(id);
                    if (left)
                        this.unregister(left);
                    console.error('PLUGIN_NOT_LOADED', JSON.stringify(id), again);
                }
            }
            await failed();
            finish();
            await startAgain();
            throw (0, errors_1.coded)(code === 'service_conflict' ? 'service_conflict' : 'bad_manifest', 'the new files are not loadable');
        }
        this.swappedOut.add(e);
        finish(); // before the start: an activate waiting for the swap shares it
        await startAgain();
    }
    // Scans the folder of `e` again and registers what is there now: null, or the refusal code (nothing registered for it then).
    registerAt(e, id) {
        const r = inspectPluginDir(path.dirname(e.dir), path.basename(e.dir), e.found.strict, e.found.folder === true);
        if (r === null)
            return 'bad_manifest';
        if ('refused' in r)
            return r.refused.code;
        if (r.manifest.id !== id)
            return 'bad_manifest';
        return this.register(r);
    }
    /** The plugin's directory as scanned (the uninstall guard checks it); undefined for an unknown plugin. */
    dirOf(id) { return this.entries.get(id)?.dir; }
    /**
     * R20 step 1: the plugin is stopped and unregistered (page, overlays, hotkeys, services, contributions), and the call answers once its page is
     * destroyed and no close of it is pending, so a wipe or a delete that follows cannot meet a live page. Idempotent: an unknown plugin is done.
     */
    async remove(id) {
        const e = this.entries.get(id);
        if (e) {
            this.deps.contributions.clearTexts(id);
            this.unregister(e);
        }
        await this.closed(id);
    }
    /** The manifest asks to keep running with no view and the user has not revoked it (R17): the effective `background`. */
    keepsRunning(e) {
        return e.manifest.background === true && this.deps.grants.get(e.id)?.revoked?.includes('background') !== true;
    }
    /**
     * R17: takes one part of the plugin's grant back. A Characters revoke wipes first (the A5 filter). A running plugin is loaded again with the
     * narrowed grant, once (a Background revoke changes no page, so it only stops the plugin from outliving its view). Throws `bad_params` for a
     * kind that is not revocable or that the manifest does not declare, `not_found` for an unknown plugin, and `unavailable` when the permissions
     * file cannot keep the change (I1): then nothing was changed, the plugin is not loaded again (unless a wipe had stopped it) and `notSaved` hears it.
     */
    async revoke(id, kind, opts) {
        const e = this.entries.get(id);
        if (!e)
            throw (0, errors_1.coded)('not_found', 'plugin');
        if (!(0, grants_1.isRevokeKind)(kind))
            throw (0, errors_1.coded)('bad_params', 'kind');
        const wipe = this.wipeHooks(e, 'revoke');
        try {
            await (0, grants_1.revokeGrant)(this.deps.grants, e.manifest, kind, wipe.hooks, { ...opts, builtIn: this.isBuiltIn(id) });
        }
        catch (err) {
            if ((0, grants_1.isNotSaved)(err)) {
                console.warn('PLUGIN_REVOKE_NOT_SAVED');
                try {
                    this.deps.notSaved?.(id);
                }
                catch { /* the notice must not hide the refusal */ }
            }
            if (wipe.torn())
                await this.restart(id, true); // stopped for a wipe and refused after it: the old grant stands, so the plugin runs again (N1)
            throw err;
        }
        if (kind !== 'background')
            await this.restart(id, wipe.torn());
    }
    /**
     * Plugin API 1.22.0 `window.onClosed`: the plugin's own window is gone for the user (closed by the user, or dropped after its page gave up; PopoutManager calls
     * this). Its main page hears `window.closed` (`{}`), and only that
     * plugin's page; no permission is needed (`window` is always granted). A plugin with no ready page (stopped, starting, unknown) hears nothing, now or later.
     * API 1.23.0: every gesture grant the plugin gave as a consumer ends first, whatever its page's state (a page that is not ready still had a window), so a
     * provider's next Claude Code turn on it is refused; and its gesture credits go, so the press that closed the window cannot pay for a new grant.
     */
    windowClosed(id) {
        try {
            this.deps.gestureGrants.forgetConsumer(id);
        }
        catch { /* the store is pure; the event below must still go */ }
        try {
            this.deps.forgetPresses(id);
        }
        catch { /* the same */ }
        if (!this.entries.has(id) || !this.deps.runtime.isReady(id))
            return;
        try {
            this.deps.runtime.send(id, { event: 'window.closed', data: {} });
        }
        catch { /* the page went away meanwhile: nothing to tell */ }
    }
    /** The wipe hooks of a revoke or an Allow: the page is stopped before the data goes (a write during the clear must not outlive the A5 filter). */
    wipeHooks(e, mode) {
        let torn = false;
        const reset = this.deps.resetPlugin, owner = this.deps.owner?.();
        if (!reset && !owner)
            return { hooks: undefined, torn: () => false };
        const stopPage = async () => { if (e.state === 'running' || e.state === 'starting') {
            torn = true;
            await this.teardown(e);
        } await this.closed(e.id); };
        const hooks = { beforeWipe: stopPage };
        if (reset)
            hooks.wipe = prompted => reset(e.id, prompted, mode);
        if (owner) {
            hooks.ownerDelete = m => owner.revoke(e.id, m === 'file'); // E3, E4: the page is stopped (beforeWipe); the layer restarts nothing here, `revoke` and `allow` do
            hooks.narrow = async (keep) => { await stopPage(); await owner.narrow(e.id, keep, { restart: false }); }; // E2 (O6): the hook stops the page itself
        }
        return { hooks, torn: () => torn };
    }
    /** A4: whether the plugin's page may be up right now. `starting` counts, except while its own grant decision runs a wipe or a narrow delete (its page was stopped for it: stopping again would supersede the start). */
    isLive(id) {
        const st = this.entries.get(id)?.state;
        return st === 'running' || (st === 'starting' && !this.wiping.has(id));
    }
    /** Built-in by the host's own rule (deps.builtIn); a throwing or absent rule means not built-in. */
    isBuiltIn(id) { try {
        return this.deps.builtIn?.(id) === true;
    }
    catch {
        return false;
    } }
    /**
     * R18: asks again for the revoked `kinds` through the permission prompt. 'granted': the parts are back (a running plugin loads again);
     * 'kept': the user said no, so they stay revoked and the plugin keeps running as before (never the turn-off path of a denied escalation).
     * A plugin the marketplace revoked (R28): `not_permitted`, nothing asked, nothing changed.
     */
    async allow(id, kinds) {
        const e = this.entries.get(id);
        if (!e)
            throw (0, errors_1.coded)('not_found', 'plugin');
        if (!Array.isArray(kinds) || !kinds.every(grants_1.isRevokeKind))
            throw (0, errors_1.coded)('bad_params', 'kinds');
        if (this.held(e))
            throw (0, errors_1.coded)('not_permitted', 'plugin is revoked'); // R28 (and DP3, a source not live): nothing is asked while it holds
        const wipe = this.wipeHooks(e, 'reset');
        const was = this.deps.grants.get(id)?.revoked ?? [];
        const r = await (0, grants_1.allowGrant)(this.deps.grants, this.deps.prompter, e.manifest, this.deps.services.providersFor(e.manifest), kinds, wipe.hooks, this.isBuiltIn(id));
        if (r === 'kept' && wipe.torn())
            await this.restart(id, true); // only a reset that failed after the stop gets here with the page torn down (N1)
        if (r === 'granted' && (wipe.torn() || kinds.some(k => k !== 'background' && was.includes(k))))
            await this.restart(id, wipe.torn());
        return r;
    }
    /**
     * Optional permissions (plan 2026-11-09): asks for optional items through an optional-only prompt (grants.allowOptional). `by` is who asked, and the caller
     * passes a literal: 'user' for a Privacy switch, 'plugin' for permissions.request; it is never read from a page's or a plugin's params. 'granted': the items
     * are in the grant (a live plugin loads again with them; nothing is asked or reloaded when they were granted already). 'kept': a No, or a reset that failed
     * after the stop (then the plugin runs again, N1). A plugin the marketplace revoked (R28): `not_permitted`, nothing asked.
     */
    async allowOptional(id, items, by) {
        const e = this.entries.get(id);
        if (!e)
            throw (0, errors_1.coded)('not_found', 'plugin');
        if (by !== 'user' && by !== 'plugin')
            throw (0, errors_1.coded)('bad_params', 'by');
        if (this.held(e))
            throw (0, errors_1.coded)('not_permitted', 'plugin is revoked'); // R28 (and DP3, a source not live): nothing is asked while it holds
        const wipe = this.wipeHooks(e, 'reset');
        const was = JSON.stringify(this.deps.grants.get(id)?.granted);
        const r = await (0, grants_1.allowOptional)(this.deps.grants, this.deps.prompter, e.manifest, this.deps.services.providersFor(e.manifest), items, wipe.hooks, by);
        if (r === 'kept' && wipe.torn())
            await this.restart(id, true); // a reset that failed after the stop: the old grant stands, so the plugin runs again (N1)
        if (r === 'granted' && (wipe.torn() || JSON.stringify(this.deps.grants.get(id)?.granted) !== was))
            await this.restart(id, wipe.torn());
        return r;
    }
    /**
     * Optional permissions: switches optional items off (grants.declineOptional): they leave the grant and join `declined`, with no question and no wipe, and a
     * live plugin loads again without them. Like a revoke it takes a way out away, so it is not refused for a plugin the marketplace revoked (which stays off).
     * A change the permissions file cannot keep is refused `unavailable` (I1): nothing changed, nothing restarted, and `notSaved` hears it.
     */
    async declineOptional(id, items) {
        const e = this.entries.get(id);
        if (!e)
            throw (0, errors_1.coded)('not_found', 'plugin');
        try {
            await (0, grants_1.declineOptional)(this.deps.grants, e.manifest, items);
        }
        catch (err) {
            if ((0, grants_1.isNotSaved)(err)) {
                console.warn('PLUGIN_DECLINE_NOT_SAVED');
                try {
                    this.deps.notSaved?.(id);
                }
                catch { /* the notice must not hide the refusal */ }
            }
            throw err;
        }
        await this.restart(id, false);
    }
    // Loads the plugin again with the new grant, when it was live (or was stopped for a wipe). The grant change stands whatever the start does,
    // so a failed start is logged by code and does not fail the revoke.
    async restart(id, torn) {
        const st = this.entries.get(id)?.state;
        if (!torn && st !== 'running' && st !== 'starting')
            return;
        try {
            await this.reload(id);
        }
        catch (err) {
            console.warn('PLUGIN_RELOAD_FAILED', codeOf(err));
        }
    }
    /** The registered plugin's manifest (a copy is not made: callers read it only). */
    manifestOf(id) { return this.entries.get(id)?.manifest; }
    /**
     * True when the plugin was registered from a scanned root that is not the installed one (a built-in or fixture root, never the installed
     * root and never a dev folder: both are strict). The host's `data` rule uses it with the caller's own `isBuiltIn(id)` (main.ts).
     */
    fromBundledRoot(id) { return this.entries.get(id)?.found.strict === false; }
    /** The proxy of a running plugin (test hooks read its counters). */
    proxyOf(id) { return this.entries.get(id)?.proxy; }
    // ---- internals ---------------------------------------------------------------------------------------------------
    // Ends the plugin's page and everything that hangs on it; the registration stays. Takes a new token, so a start still in
    // progress finds itself superseded at its next await and undoes its own work.
    teardown(e, to = 'stopped', by) {
        e.token = ++this.seq;
        e.starting = undefined;
        const gone = this.stopPage(e.id);
        this.dropProxy(e, e.proxy);
        this.deps.services.providerGone(e.id);
        this.deps.services.forgetConsumer(e.id);
        this.deps.idle?.forget(e.id);
        if (e.state !== 'disabled' || to === 'disabled')
            this.setState(e, to, by);
        return gone;
    }
    // Stops the runtime's page of `id` and keeps its close pending until the page is destroyed. Only the call that closes a live page gets a
    // promise from the runtime; the pending map is what every later wipe waits on, whichever entry it holds.
    stopPage(id) {
        const gone = this.deps.runtime.stop(id);
        if (!gone)
            return gone;
        const prev = this.closes.get(id);
        const all = (prev ? Promise.all([prev, gone]).then(noop) : Promise.resolve(gone)).catch(noop);
        const p = all.then(() => { if (this.closes.get(id) === p)
            this.closes.delete(id); });
        this.closes.set(id, p);
        return gone;
    }
    /** Resolves once no page of `id` is still closing (never rejects). */
    async closed(id) {
        for (let p = this.closes.get(id); p; p = this.closes.get(id))
            await p;
    }
    // The plugin is gone until a rescan or reload passes: stopped, and its providers and contributions are unregistered.
    unregister(e) {
        this.teardown(e);
        this.dropped(e.id);
        this.deps.services.removeProvider(e.id);
        this.deps.contributions.remove(e.id);
        if (this.entries.get(e.id) === e)
            this.entries.delete(e.id);
    }
    // The one place a state changes: listeners hear every real transition, in order. `by` names the cause of `disabled`.
    setState(e, state, by) {
        const was = e.state, wasBy = e.disabledBy;
        e.state = state;
        // A switched-off plugin is no listed service provider (coordinator ruling 2026-11-12); stopped, starting or suspended it is: a call starts it.
        this.deps.services.setSwitchedOff(e.id, state === 'disabled');
        e.disabledBy = state === 'disabled' ? by ?? e.disabledBy : undefined;
        if (was === state && wasBy === e.disabledBy)
            return; // a new cause of `disabled` is a change too
        for (const fn of this.stateFns)
            try {
                fn(e.id, state);
            }
            catch { /* a listener must not stop the registry */ }
    }
    dropped(id) {
        for (const fn of this.dropFns)
            try {
                fn(id);
            }
            catch { /* a listener must not stop the registry */ }
    }
    dropProxy(e, p) {
        if (!p)
            return;
        p.stop();
        if (e.proxy === p)
            e.proxy = undefined;
    }
    begin(e) {
        const token = ++this.seq;
        e.token = token;
        if (e.state !== 'disabled')
            this.setState(e, 'starting');
        const p = e.tail.then(() => this.run(e, token));
        e.tail = p.catch(noop);
        e.starting = p;
        void p.catch(noop).then(() => { if (e.starting === p)
            e.starting = undefined; });
        return p;
    }
    // The A5 wipe waits for every page of the plugin that is still closing (N4).
    // R29: a decision of a version whose files are being replaced, or were (an update), is no longer current: it asks and writes nothing.
    async grantOf(e) {
        const reset = this.deps.resetPlugin;
        const current = () => !this.swaps.has(e.id) && !this.swappedOut.has(e);
        const fresh = e.fresh === true ? { recordDeny: false, fresh: true } : {}; // D20: an install's ask; a Deny writes nothing and keeps it fresh
        try {
            const owner = this.deps.owner?.();
            const during = async (fn) => { this.wiping.add(e.id); try {
                return await fn();
            }
            finally {
                this.wiping.delete(e.id);
            } };
            const hooks = reset || owner ? {
                ...(reset ? { wipe: async (prompted) => { await this.closed(e.id); await during(() => reset(e.id, prompted)); } } : {}),
                ...(owner ? { narrow: async (keep) => { await this.closed(e.id); await during(() => owner.narrow(e.id, keep, { restart: false })); } } : {}), // E2: no page is up at a start, a prompt or an update
            } : undefined;
            const g = await (0, grants_1.ensureGrant)(this.deps.grants, this.deps.prompter, e.manifest, this.deps.services.providersFor(e.manifest), hooks, { ...this.askOf(e), current, ...fresh });
            if (g !== null)
                e.fresh = undefined;
            return g;
        }
        catch {
            return null;
        }
    }
    /**
     * Where a registered plugin came from, as its grant requests say it. The kind only: never the index it is bound to (sourceIndexOf reads
     * the install record and the source store; every Settings > Plugins row reads this, DP3 re-review finding 4).
     */
    sourceOf(id) {
        const e = this.entries.get(id);
        return e === undefined ? undefined : this.kindOf(e);
    }
    /** The `sourceOf` dep's answer for the entry (`manual` when it throws or answers anything else); undefined without the dep. */
    kindOf(e) {
        const of = this.deps.sourceOf;
        if (!of)
            return undefined;
        try {
            const s = of(e.id, e.manifest, e.found.strict);
            if (s === 'bundled' || s === 'market')
                return s;
        }
        catch { /* manual: never "signed" by mistake */ }
        return 'manual';
    }
    askOf(e) {
        let builtIn = false;
        try {
            builtIn = this.deps.builtIn?.(e.id) === true;
        }
        catch { /* not built-in */ }
        const source = this.kindOf(e);
        if (source === undefined)
            return builtIn ? { builtIn } : {};
        let sourceIndex;
        if (source === 'market' && this.deps.sourceIndexOf) {
            try {
                sourceIndex = this.deps.sourceIndexOf(e.id);
            }
            catch {
                sourceIndex = undefined;
            }
        } // review finding 1: the host names the index
        return { source, ...(builtIn ? { builtIn } : {}), ...(sourceIndex ? { sourceIndex } : {}) };
    }
    // A plugin whose consent is denied is listed as disabled and never gets a view.
    async settleGrant(e) {
        if (e.state === 'disabled' && (e.disabledBy === 'user' || isHold(e.disabledBy)))
            return; // never asked (a revoked plugin: no prompt, R28; nor one whose source is not live, DP3)
        const token = e.token;
        const g = await this.grantOf(e);
        if (e.token !== token || this.entries.get(e.id) !== e)
            return;
        if (g === null) {
            this.setState(e, 'disabled', 'consent');
            console.warn('PLUGIN_DISABLED', JSON.stringify(e.id), '(consent needed)');
        }
    }
    heldForDelete(id) {
        try {
            return this.deps.owner?.()?.blocked(id) === true;
        }
        catch {
            return true;
        } // an unreadable record: hold (fail closed)
    }
    // One start. After every await a superseded token undoes its own work and returns.
    async run(e, token) {
        const cur = () => e.token === token && this.entries.get(e.id) === e;
        if (!cur())
            return;
        // A page left over from an earlier start is gone before this one begins. The runtime answers a second stop of the same page with nothing, so the
        // wipe waits on the registry's pending closes (`closes`), which hold every page of this plugin that is still closing.
        this.stopPage(e.id);
        this.dropProxy(e, e.proxy);
        // A4 (O1): a plugin with a delete owed (a character removed, a selection narrowed, a revoke or a reset not finished) is never started: it would read what the user took away.
        // Every start goes through here: the first scan, `begin`, a restart after a revoke or Allow, the update swap and a dev reload.
        if (this.heldForDelete(e.id)) {
            if (e.state !== 'disabled')
                this.setState(e, 'stopped');
            console.warn('PLUGIN_HELD_FOR_DELETE', JSON.stringify(e.id));
            throw Object.assign((0, errors_1.coded)('unavailable', 'a data delete is owed for the plugin'), { held: true }); // still `unavailable` to every caller; only the startup path tells the hold apart
        }
        const granted = await this.grantOf(e);
        if (!cur())
            return;
        if (granted === null) {
            this.setState(e, 'disabled', 'consent');
            console.warn('PLUGIN_DISABLED', JSON.stringify(e.id));
            throw (0, errors_1.coded)('unavailable', 'plugin is disabled');
        }
        this.setState(e, 'starting');
        const eg = this.deps.egress?.(e.id) ?? { mode: 'allow', watches: [] };
        let proxy;
        let proxyPort = null;
        if (eg.mode === 'allow' || eg.mode === 'deny') {
            proxy = this.deps.proxyFactory(e.id, eg.mode, granted);
            for (const w of eg.watches)
                proxy.watch(w);
            try {
                proxyPort = await proxy.start();
            }
            catch {
                proxy.stop();
                if (!cur())
                    return;
                this.setState(e, 'stopped');
                console.error('PLUGIN_NOT_LOADED', e.id, 'egress setup failed');
                throw (0, errors_1.coded)('unavailable', 'plugin could not be started');
            }
            if (!cur()) {
                proxy.stop();
                return;
            } // superseded while the proxy started: it never served anything
            e.proxy = proxy;
        }
        if (!sameDirAsScanned(e.found)) { // swapped for a link or another directory since the scan
            this.dropProxy(e, proxy);
            this.setState(e, 'stopped');
            console.error('PLUGIN_NOT_LOADED', JSON.stringify(e.id), 'directory changed since the scan');
            throw (0, errors_1.coded)('unavailable', 'plugin could not be started');
        }
        try {
            await this.deps.runtime.start({ id: e.id, dir: e.dir, real: e.found.real, native: e.found.native, dev: e.found.dev, ino: e.found.ino, strict: e.found.strict, manifest: e.manifest, granted }, { egress: { mode: eg.mode, proxyPort }, isCurrent: cur });
        }
        catch (err) {
            this.stopPage(e.id);
            this.dropProxy(e, proxy);
            if (!cur())
                return;
            this.setState(e, 'stopped');
            console.error('PLUGIN_NOT_LOADED', e.id, (0, exports.startFailure)(err));
            throw (0, errors_1.coded)('unavailable', 'plugin could not be started');
        }
        if (!cur()) {
            this.stopPage(e.id);
            this.dropProxy(e, proxy);
            return;
        }
        this.setState(e, 'running');
        this.deps.idle?.touch(e.id); // a plugin that never calls the API is idle from the moment it is ready
    }
}
exports.PluginRegistry = PluginRegistry;
/**
 * Watches a plugin directory (dev reload). Returns the stop function. Test builds only by default: in a product build nothing is
 * watched and the result is a no-op, unless `enabled` is passed (D20's folder plugin, behind its developer setting). The watcher gets an 'error' listener: on Windows deleting
 * the watched directory emits EPERM as 'error', which without a listener is an uncaught exception in the main process. The error
 * is logged by code only and the watcher closed. A watcher that cannot even be created (ENOSPC: no inotify watches left) is
 * logged by code and also leaves a no-op stop.
 */
function watchDir(dir, onChange, watchImpl = (d, fn) => fs.watch(d, { recursive: true }, fn), enabled = buildinfo_1.TEST_BUILD) {
    if (!enabled)
        return () => { };
    const watchCode = (e) => (typeof e?.code === 'string' ? e.code : 'error');
    let w;
    try {
        w = watchImpl(dir, onChange);
    }
    catch (e) {
        console.warn('plugin watcher not started', watchCode(e));
        return () => { };
    }
    w.on('error', e => {
        console.warn('plugin watcher stopped', watchCode(e));
        try {
            w.close();
        }
        catch { /* already closed */ }
    });
    return () => { try {
        w.close();
    }
    catch { /* already closed */ } };
}
