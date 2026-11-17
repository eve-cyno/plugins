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
exports.SWAP_COPY_MARGIN = exports.installerName = exports.updatesDir = exports.appImagePrevious = exports.appImageStaged = exports.nodeUpdaterFs = void 0;
exports.sessionEnv = sessionEnv;
exports.installKind = installKind;
exports.installerVersion = installerVersion;
exports.fsyncDir = fsyncDir;
exports.swapAppImage = swapAppImage;
exports.runInstaller = runInstaller;
// Applying a verified update (R5): how this copy was installed, where a download is staged, and the two ways to apply it at quit.
// No Electron. Every apply step is synchronous: it runs in the quit path, after the sidecar exited, right before the app exits. (`hashFile`
// is the one async member of the fs seam: the in-session re-hash of a staged file streams, so it never blocks the main thread.)
// - Linux AppImage: the new file was written next to the AppImage (and fsynced) before; here `.<basename>.previous` is made from the current
//   file (a hard link, or a copy), then one atomic rename puts the staged file at `$APPIMAGE`. The path always holds the old or the new
//   file, whatever step a kill lands on, and it stays the same, so the desktop entry stays valid.
// - Windows NSIS: the verified installer runs detached and silent, per user (no UAC: the installer is per-user and never elevates).
// Log lines carry codes and versions only, never a path.
const crypto = __importStar(require("node:crypto"));
const fs = __importStar(require("node:fs"));
const path = __importStar(require("node:path"));
const desktopentry_1 = require("../desktopentry");
exports.nodeUpdaterFs = {
    rename: (a, b) => fs.renameSync(a, b),
    unlink: f => fs.unlinkSync(f),
    chmod: (f, m) => fs.chmodSync(f, m),
    stat: f => fs.lstatSync(f),
    readFile: f => fs.readFileSync(f),
    access: (f, m) => fs.accessSync(f, m),
    link: (a, b) => fs.linkSync(a, b),
    copyFile: (a, b) => fs.copyFileSync(a, b, fs.constants.COPYFILE_EXCL),
    freeBytes: dir => { try {
        const s = fs.statfsSync(dir);
        const n = Number(s.bavail) * Number(s.bsize);
        return Number.isFinite(n) && n >= 0 ? n : null;
    }
    catch {
        return null;
    } },
    hashFile: file => new Promise((resolve, reject) => {
        const h = crypto.createHash('sha256');
        fs.createReadStream(file).on('error', reject).on('data', c => h.update(c)).on('end', () => resolve(h.digest('hex')));
    }),
};
/**
 * The environment of a process the app starts in the user's session (the relaunch after "Restart now", a link opened in the browser): a copy
 * of `env` with XDG_SESSION_TYPE as the session gave it, `sessionType` (main.ts puts x11 into its own environment on Linux for
 * desktopCapturer); undefined leaves it unset. `env` itself is not changed.
 */
function sessionEnv(env, sessionType) {
    const out = { ...env };
    if (sessionType === undefined)
        delete out.XDG_SESSION_TYPE;
    else
        out.XDG_SESSION_TYPE = sessionType;
    return out;
}
/** An unpackaged run starts Electron's own binary (node_modules/electron/dist/electron[.exe]); a package names it after the product. */
const isDevExe = (execPath) => /^electron(\.exe)?$/i.test(execPath.split(/[\\/]/).pop() ?? '');
/**
 * R5: `appimage` for an AppImage run (APPIMAGE set and the executable inside APPDIR); `nsis` when a packaged Windows run has
 * `Uninstall <productName>.exe` beside its exe (so the test build, `EVE-Cyno Test`, is found too); otherwise `dev` (Electron's own binary)
 * or `portable`. Only `appimage` and `nsis` update themselves; the other two end in `manual`.
 */
function installKind(env, execPath, platform, exists, productName) {
    if (platform === 'linux' && (0, desktopentry_1.isAppImageRun)(env, execPath))
        return 'appimage';
    if (isDevExe(execPath))
        return 'dev';
    if (platform === 'win32' && exists(path.join(path.dirname(execPath), `Uninstall ${productName}.exe`)))
        return 'nsis';
    return 'portable';
}
/** `.<basename>.update` beside the AppImage: the same directory, so the swap is a rename on one filesystem. */
const appImageStaged = (target) => path.join(path.dirname(target), `.${path.basename(target)}.update`);
exports.appImageStaged = appImageStaged;
const appImagePrevious = (target) => path.join(path.dirname(target), `.${path.basename(target)}.previous`);
exports.appImagePrevious = appImagePrevious;
/** <userData>/updates: the Windows installers. */
const updatesDir = (userData) => path.join(userData, 'updates');
exports.updatesDir = updatesDir;
const installerName = (productName, version) => `${productName}-${version}-setup.exe`;
exports.installerName = installerName;
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** The version of a staged installer's file name, or null. Case-insensitive: Windows file names are. */
function installerVersion(productName, name) {
    const m = new RegExp(`^${escapeRe(productName)}-((?:0|[1-9]\\d{0,8})\\.(?:0|[1-9]\\d{0,8})\\.(?:0|[1-9]\\d{0,8}))-setup\\.exe$`, 'i').exec(name);
    return m ? m[1] : null;
}
const codeOf = (e) => { const c = e?.code; return typeof c === 'string' && /^[A-Z0-9_]{1,24}$/.test(c) ? c : 'error'; };
/** A best-effort fsync of a directory, so a rename survives a power cut (Windows cannot open a directory: skipped there). */
function fsyncDir(dir) {
    if (process.platform === 'win32')
        return;
    try {
        const fd = fs.openSync(dir, 'r');
        try {
            fs.fsyncSync(fd);
        }
        finally {
            fs.closeSync(fd);
        }
    }
    catch { /* best effort */ }
}
/** Room the `.previous` copy needs beyond the target's own size (filesystem clusters and metadata), review n1. */
exports.SWAP_COPY_MARGIN = 16 * 1024 * 1024;
/**
 * Replaces `target` with `staged` and keeps the old file as `.<basename>.previous` (until a clean start). The target is never missing (review
 * m2): first `.previous` is made from it, a hard link (no bytes copied) or, on a filesystem without links (FAT, exFAT), a copy; an older
 * `.previous` goes first. Then one atomic rename replaces the target in place, mode 0755. A failed step leaves the old file at the target
 * (`space`, no room for the copy, and `previous`: nothing changed; `replace`: the new `.previous` is removed again).
 */
function swapAppImage(staged, target, f) {
    const previous = (0, exports.appImagePrevious)(target);
    const rm = (p) => { try {
        f.unlink(p);
    }
    catch { /* not there */ } };
    try {
        f.chmod(staged, 0o755);
    }
    catch (e) {
        return { ok: false, step: 'mode', code: codeOf(e) };
    }
    rm(previous);
    try {
        f.link(target, previous);
    }
    catch {
        // No hard links here (FAT, exFAT): the copy is a third file beside the target and the staged one. Without room for it nothing is copied
        // (a copy that fills the disk takes seconds on a slow stick, then fails); review n1. A filesystem that cannot tell gets the copy.
        let need = exports.SWAP_COPY_MARGIN;
        try {
            need += f.stat(target).size;
        }
        catch { /* the copy below fails on its own */ }
        const free = f.freeBytes(path.dirname(target));
        if (free !== null && free < need)
            return { ok: false, step: 'space', code: 'ENOSPC' };
        try {
            f.copyFile(target, previous);
        }
        catch (e) {
            rm(previous);
            return { ok: false, step: 'previous', code: codeOf(e) };
        }
    }
    try {
        f.rename(staged, target);
    }
    catch (e) {
        rm(previous);
        return { ok: false, step: 'replace', code: codeOf(e) };
    }
    fsyncDir(path.dirname(target));
    return { ok: true };
}
/**
 * Starts the verified NSIS installer detached and silent, in electron-builder's update mode (`--updated`: a shortcut the user deleted is
 * not recreated); `relaunch` (B5b's "Restart now") adds `--force-run`, which starts the app after the install. True when it was started.
 */
function runInstaller(file, spawn, o) {
    try {
        const p = spawn(file, ['/S', '--updated', ...(o.relaunch ? ['--force-run'] : [])], { detached: true, stdio: 'ignore' });
        p.on('error', () => { });
        p.unref();
        return true;
    }
    catch {
        return false;
    }
}
