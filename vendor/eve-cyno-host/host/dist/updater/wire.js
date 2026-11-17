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
exports.CYNOD_EXIT_WAIT_MS = exports.CYNOD_STOP_WAIT_MS = exports.updaterStateDir = void 0;
exports.updaterConfig = updaterConfig;
exports.appUpdaterDeps = appUpdaterDeps;
exports.startAppUpdater = startAppUpdater;
exports.quitInstall = quitInstall;
// The updater in the product (main.ts): its configuration from the build kind, the real dependencies, and the quit step that installs
// after the sidecar exited. No Electron import: main.ts passes the app's values in.
const node_child_process_1 = require("node:child_process");
const path = __importStar(require("node:path"));
const cynod_1 = require("../cynod");
const fetchbounded_1 = require("../fetchbounded");
const trustkeys_1 = require("../trustkeys");
const manifest_1 = require("./manifest");
const apply_1 = require("./apply");
const updater_1 = require("./updater");
/**
 * R2/R3: a product build pins the product release keys (PRODUCT_KEYS.release: the primary and the standby; with none it would be `unconfigured` and send no request) and
 * asks MANIFEST_URL over HTTPS. A test build holds only the test release key and asks only `EVECYNO_TEST_UPDATE_URL`, an
 * http://127.0.0.1:<port>/ URL (without it: unconfigured, so a test build never asks the real host); `EVECYNO_TEST_APPIMAGE` stands in
 * for $APPIMAGE (the executable's own directory then counts as the mount). A product build ignores both variables.
 */
function updaterConfig(o) {
    const { EVECYNO_TEST_UPDATE_URL: testUrl, EVECYNO_TEST_APPIMAGE: testImage, ...rest } = o.env;
    if (!o.testBuild)
        return { keys: (0, trustkeys_1.trustedKeys)('release', false), manifestUrl: manifest_1.MANIFEST_URL, allowLoopbackHttp: false, env: rest };
    let url = null;
    try {
        const u = new URL(testUrl ?? '');
        if (u.protocol === 'http:' && u.hostname === '127.0.0.1' && u.port !== '' && !u.search && !u.hash && !u.username && !u.password && u.href === testUrl)
            url = u.href;
    }
    catch { /* unset or not a URL: unconfigured */ }
    const env = { ...rest };
    if (testImage && path.isAbsolute(testImage)) {
        env.APPIMAGE = testImage;
        env.APPDIR = path.dirname(o.execPath);
    }
    else {
        delete env.APPIMAGE;
        delete env.APPDIR;
    } // a test run never updates a real AppImage it was not pointed at
    return { keys: (0, trustkeys_1.trustedKeys)('release', true), manifestUrl: url, allowLoopbackHttp: url !== null, env };
}
const nodeSpawn = (file, args, opts) => (0, node_child_process_1.spawn)(file, args, opts);
/**
 * The updater's state folder (updates.json, and updates/ on Windows). A test build's userData is already its own profile (paths.ts
 * profileFor); as a second guard it keeps the state under <userData>/test-updater too, so a test-key-verified `seen`, `notified`,
 * `installing` or `staged` never steers the product, and the product's never steers a test run (review I1).
 */
const updaterStateDir = (userData, testBuild) => (testBuild ? path.join(userData, 'test-updater') : userData);
exports.updaterStateDir = updaterStateDir;
/** The product's dependencies: the build-kind config, the real fetch, download, fs and spawn, and unref'd timers. */
function appUpdaterDeps(o) {
    const cfg = updaterConfig({ testBuild: o.testBuild, env: o.env, execPath: o.execPath });
    return {
        version: o.version, productName: o.testBuild ? 'EVE-Cyno Test' : 'EVE-Cyno', platform: o.platform, arch: o.arch, env: cfg.env,
        execPath: o.execPath, userData: (0, exports.updaterStateDir)(o.userData, o.testBuild), sessionType: o.sessionType, keys: cfg.keys, manifestUrl: cfg.manifestUrl, allowLoopbackHttp: cfg.allowLoopbackHttp,
        fetch: fetchbounded_1.fetchBounded, download: fetchbounded_1.downloadVerified, fs: apply_1.nodeUpdaterFs, spawn: nodeSpawn, now: Date.now,
        later: (fn, ms) => { const t = setTimeout(fn, ms); t.unref(); return () => clearTimeout(t); },
        notice: o.notice,
    };
}
/** The product's updater, started: checks 60 s after start and every 6 h; one log line per phase change. */
function startAppUpdater(o) {
    const u = new updater_1.Updater(appUpdaterDeps(o));
    let last = '';
    u.onChange((s) => { const l = (0, updater_1.updaterLogLine)(s); if (l !== last) {
        last = l;
        console.log(l);
    } });
    u.start({ cynodUp: o.cynodUp });
    return u;
}
/** Windows, a quit without an update: how long the app waits for the sidecar's own stop (Cynod.stop kills it STOP_GRACE_MS in). */
exports.CYNOD_STOP_WAIT_MS = cynod_1.STOP_GRACE_MS + 1_000;
/**
 * A quit with an update ready, on both systems: how long the app waits for the sidecar's exit before it skips the install. Longer than
 * STOP_GRACE_MS (B5b review m6), so it never races the stop: Windows kills the sidecar then, and on Linux the SIGTERM'd sidecar drains a
 * token rotation for about as long (serve's handler grace, then the rotation drain) before it exits.
 */
exports.CYNOD_EXIT_WAIT_MS = exports.CYNOD_STOP_WAIT_MS;
/**
 * The last step of the quit path (makeQuit's `exit`): with an update ready, waits for the sidecar to exit (at most CYNOD_EXIT_WAIT_MS: a
 * running cynod holds files the install replaces; past that the install is skipped this time), installs, then exits. Without one it exits at
 * once, as before, except with `waitExit` (Windows): a child process ends with a Windows app, so the app waits for the sidecar to finish its
 * own stop first (a token rotation it drains, vault.Drain), at most CYNOD_STOP_WAIT_MS. The update wait was 5 s before (T6 carry B on
 * Windows, B5b review m6 on Linux) and raced the sidecar's own stop. `onWait` runs when a wait starts (main.ts
 * hides every window, so the app looks gone at once); a throw from it changes nothing. Runs once. After "Restart now" the install is also what
 * starts the new version (Linux: RELAUNCH_SH, which first waits for this process to end), so nothing is started while this waits, and a
 * wait that runs out installs and starts nothing.
 */
function quitInstall(o) {
    const later = o.later ?? ((fn, ms) => { const t = setTimeout(fn, ms); return () => clearTimeout(t); });
    const log = o.log ?? (l => console.log(l));
    const waiting = () => { try {
        o.onWait?.();
    }
    catch { /* the wait and the exit go on */ } };
    let done = false;
    return code => {
        if (done)
            return;
        done = true;
        const u = o.updater();
        let ready = false;
        try {
            ready = u?.state().phase === 'ready';
        }
        catch { /* no update then */ }
        if (!u || !ready) {
            const c = o.waitExit ? o.cynod() : undefined;
            if (!c || !c.running) {
                o.exit(code);
                return;
            }
            let settled = false;
            const gone = () => { if (settled)
                return; settled = true; cancel(); o.exit(code); };
            const cancel = later(() => {
                if (settled)
                    return;
                settled = true;
                try {
                    c.removeListener('cynod.exited', gone);
                }
                catch { /* gone */ }
                o.exit(code);
            }, exports.CYNOD_STOP_WAIT_MS);
            c.once('cynod.exited', gone);
            waiting();
            if (!c.running)
                gone(); // it exited between the check and the subscription
            return;
        }
        const install = () => {
            try {
                u.installOnQuit();
            }
            catch {
                try {
                    log('UPDATER install_failed error');
                }
                catch { /* exit anyway */ }
            }
            o.exit(code);
        };
        const c = o.cynod();
        if (!c || !c.running) {
            install();
            return;
        }
        let settled = false;
        const onExit = () => { if (settled)
            return; settled = true; cancel(); install(); };
        const cancel = later(() => {
            if (settled)
                return;
            settled = true;
            try {
                c.removeListener('cynod.exited', onExit);
            }
            catch { /* gone */ }
            try {
                log('UPDATER install_skipped cynod_running');
            }
            catch { /* exit anyway */ }
            o.exit(code);
        }, exports.CYNOD_EXIT_WAIT_MS);
        c.once('cynod.exited', onExit);
        waiting();
        if (!c.running)
            onExit(); // it exited between the check and the subscription
    };
}
