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
exports.installRecordsFile = exports.appUpdateCheck = exports.UpdateCheckSwitch = exports.marketDir = void 0;
exports.marketConfig = marketConfig;
exports.updatesCheckOn = updatesCheckOn;
exports.wireUpdateCheck = wireUpdateCheck;
exports.appMarketDeps = appMarketDeps;
exports.listingAdmit = listingAdmit;
exports.revocationIn = revocationIn;
exports.revocationThemes = revocationThemes;
exports.marketThemeOf = marketThemeOf;
exports.installedPluginRules = installedPluginRules;
exports.freeBytesOf = freeBytesOf;
exports.appInstaller = appInstaller;
exports.appPluginUpdates = appPluginUpdates;
// The index client and the installer in the product (main.ts): the client's configuration from the build kind (R24), the real
// dependencies, the one "Check for updates" switch it follows from the app updater (R31, UpdateCheckSwitch), the listing admission (R27, R26 device names),
// and the source rule of an installed plugin that the registry's admit hook and its grant requests share (D30). No Electron import:
// main.ts passes the app's values in.
const fs = __importStar(require("node:fs"));
const path = __importStar(require("node:path"));
const fetchbounded_1 = require("../fetchbounded");
const trustkeys_1 = require("../trustkeys");
const wire_1 = require("../updater/wire");
const indexformat_1 = require("./indexformat");
const client_1 = require("./client");
const installer_1 = require("./installer");
const names_1 = require("./names");
const revocation_1 = require("./revocation");
const updates_1 = require("./updates");
const zipread_1 = require("./zipread");
/**
 * R24: a product build pins the product index keys (PRODUCT_KEYS.index: the primary and the standby) and asks INDEX_URL over HTTPS. A
 * test build holds only the test index key and asks only `EVECYNO_TEST_INDEX_URL`, exactly `http://127.0.0.1:<port>/v1/index.json`
 * (canonical, no query, fragment or credentials); without it the client is `unconfigured` and sends nothing, so a test build never asks
 * the real host. The prefix every URL of the index must start with is the folder of the index URL. A product build ignores the variable.
 * The release keys are never passed: an index verifies only with `index` keys.
 */
function marketConfig(o) {
    if (!o.testBuild)
        return { keys: (0, trustkeys_1.trustedKeys)('index', false), indexUrl: indexformat_1.INDEX_URL, prefix: indexformat_1.MARKET_URL_PREFIX, allowLoopbackHttp: false };
    const raw = o.env.EVECYNO_TEST_INDEX_URL;
    let url = null;
    try {
        const u = new URL(raw ?? '');
        if (u.protocol === 'http:' && u.hostname === '127.0.0.1' && u.port !== '' && u.pathname === '/v1/index.json' && !u.search && !u.hash
            && !u.username && !u.password && u.href === raw)
            url = u.href;
    }
    catch { /* unset or not a URL: unconfigured */ }
    return { keys: (0, trustkeys_1.trustedKeys)('index', true), indexUrl: url, prefix: url !== null ? new URL('./', url).href : indexformat_1.MARKET_URL_PREFIX, allowLoopbackHttp: url !== null };
}
/** The client's folder: the cached head, its signature, the catalog and state.json (the Persistence table). */
const marketDir = (userData) => path.join(userData, 'market');
exports.marketDir = marketDir;
/**
 * R31: the switch as the updater persisted it, `check` in updates.json (default on, as the updater reads it). Read only: a missing file or
 * one that is not JSON is "on" and is left exactly as it is (the updater owns it and quarantines it itself). A file that is there but
 * cannot be read (held by another process, denied: EBUSY, EPERM, EACCES on Windows) is "off": the switch may be off, so nothing is sent.
 * Final review ORCH m3: the file is read again only when its mtime or size changed (the switch is asked per row and per progress tick), and
 * a read that fails after one succeeded keeps that value (a scanner holding the file for a moment must not flip the rows to "off").
 * UpdateCheckSwitch reads it until the updater sets the switch in this run.
 */
function updatesCheckOn(stateDir, read = f => fs.readFileSync(f, 'utf8'), stat = f => fs.statSync(f)) {
    const file = path.join(stateDir, 'updates.json');
    let last = null;
    const failed = (e) => {
        if (e?.code === 'ENOENT') {
            last = null;
            return true;
        }
        return last !== null ? last.on : false;
    };
    return () => {
        let key;
        try {
            const st = stat(file);
            key = `${st.mtimeMs}:${st.size}`;
        }
        catch (e) {
            return failed(e);
        }
        if (last !== null && last.key === key)
            return last.on;
        let text;
        try {
            text = read(file);
        }
        catch (e) {
            return failed(e);
        }
        let on = true;
        try {
            const v = JSON.parse(text);
            on = !(typeof v === 'object' && v !== null && v.check === false);
        }
        catch { /* not JSON: on */ }
        last = { key, on };
        return on;
    };
}
/**
 * R31, Task 9 m2: the one "Check for updates" switch as the index client and the plugin updates read it. The app updater owns it:
 * Updater.setCheck is its only writer and updates.json `check` its persistence. Once the updater set it in this run (`follow`: every
 * setCheck reaches this through Updater.onCheck), on() is that value; before, and in a run without an updater (every --test= mode, whose
 * `updates.setCheck` answers `unavailable`), the persisted one (`read`: updatesCheckOn, a file it cannot read is off). A setCheck that
 * changes it reaches the onChange listeners at once (wireUpdateCheck: MarketClient.checkChanged and PluginUpdates.checkChanged).
 */
class UpdateCheckSwitch {
    read;
    mem = null;
    fns = new Set();
    constructor(read) {
        this.read = read;
    }
    on() {
        if (this.mem !== null)
            return this.mem;
        try {
            return this.read() === true;
        }
        catch {
            return false;
        }
    }
    onChange(fn) { this.fns.add(fn); return () => { this.fns.delete(fn); }; }
    /**
     * The first setCheck of the run always reaches the listeners: the file it was read from already holds the new value (the updater writes
     * before it tells), so what they acted on before cannot be told. After that, only a change.
     */
    follow(updater) {
        return updater.onCheck(on => {
            const was = this.mem;
            this.mem = on === true;
            if (this.mem === was)
                return;
            for (const fn of [...this.fns]) {
                try {
                    fn(this.mem);
                }
                catch { /* a listener must not break the switch */ }
            }
        });
    }
}
exports.UpdateCheckSwitch = UpdateCheckSwitch;
/** The product's switch: updates.json in the updater's state folder (wire.ts updaterStateDir: a test build's own test-updater/). */
const appUpdateCheck = (userData, testBuild) => new UpdateCheckSwitch(updatesCheckOn((0, wire_1.updaterStateDir)(userData, testBuild)));
exports.appUpdateCheck = appUpdateCheck;
/**
 * main.ts's R31 wiring, once the updater exists (null: a run without one): the switch follows the updater, and each change reaches the index
 * client (off: its check in flight ends, its schedule stops; on: one check now) and the plugin updates (off: an automatic download ends,
 * nothing new is staged; on: a new look). Returns the unsubscribe.
 */
function wireUpdateCheck(o) {
    const offs = [o.check.onChange(() => { o.market.checkChanged(); o.updates?.checkChanged(); })];
    if (o.updater)
        offs.push(o.check.follow(o.updater));
    return () => { for (const f of offs)
        f(); };
}
/**
 * The product's dependencies: the build-kind config, the real fetch, the switch (`checkOn`; main.ts passes its UpdateCheckSwitch, without
 * it the persisted value alone) and unref'd timers.
 */
function appMarketDeps(o) {
    return {
        dir: (0, exports.marketDir)(o.userData), ...marketConfig({ testBuild: o.testBuild, env: o.env }), userAgent: `EVE-Cyno/${o.version}`, fetch: fetchbounded_1.fetchBounded,
        checkOn: o.checkOn ?? updatesCheckOn((0, wire_1.updaterStateDir)(o.userData, o.testBuild)), now: Date.now,
        later: (fn, ms) => { const t = setTimeout(fn, ms); t.unref(); return () => clearTimeout(t); }, admit: listingAdmit,
    };
}
/**
 * parseCatalog's `admit` (R27, R26): a listing whose id starts with a Windows device name (its folder could not exist there) or whose name or
 * author reads as the host's (unless the listing is first-party) is dropped from the catalog, for plugins and theme packages alike.
 */
function listingAdmit(l) {
    return !(0, zipread_1.isDeviceNameId)(l.id) && (0, names_1.nameAllowed)({ name: l.name, author: l.author }, 'market', l.firstParty === true) === true;
}
/**
 * The catalog's revocation of `id` at `version` ('*' or a version listed), or null. Versions match by semver equality (build metadata does
 * not count), as the catalog's own duplicate check compares them; a version that is not semver matches only '*'.
 */
function revocationIn(c, id, version) {
    return c ? (0, revocation_1.revocationAmong)(c.revoked, id, version) : null;
}
/**
 * R28's theme side of Revocations: the theme packages that were added (a bundled package is never revocable: values only, it changes with
 * the app; an added copy that shadows a bundled id is an added package) with their versions, and ThemeService.remove, which puts the stored
 * theme back to Cyno when it was in the package.
 */
function revocationThemes(parts) {
    const added = () => parts().packages.list().filter(p => p.source === 'added');
    return {
        addedIds: () => added().map(p => p.id),
        versionOf: id => added().find(p => p.id === id)?.version ?? null,
        remove: id => parts().service.remove(id),
    };
}
/**
 * The Marketplace's theme side (10-fix2 ruling 3): the added theme package of `id` (the same `added` packages as revocationThemes: never a
 * bundled one), its version and its theme count, or null.
 */
function marketThemeOf(parts) {
    return id => {
        const p = parts().packages.list().find(x => x.source === 'added' && x.id === id);
        return p ? { version: p.version, themes: p.themes.length } : null;
    };
}
/** `<userData>/market/installed.json`: the install records (R26). */
const installRecordsFile = (userData) => path.join((0, exports.marketDir)(userData), 'installed.json');
exports.installRecordsFile = installRecordsFile;
/**
 * D30, one rule for the registry's two hooks: a plugin outside the installed root (`strict` false) that is also built-in (`isBuiltIn`, when the caller passes it) is `bundled`; one inside is `market`
 * while its install record matches its folder and version (records.ts sourceOf), else `manual`. `admit` is the names rule (R27) with that
 * same source and the record's firstParty, so the hook that admits a plugin and the prompt's "signed" marker never disagree.
 */
function installedPluginRules(d) {
    const of = (id, version, strict) => {
        if (!strict)
            return { source: 'bundled', firstParty: false };
        const source = d.records.sourceOf(id, version, path.join(d.installedDir, id));
        return { source, firstParty: source === 'market' && d.records.get(id)?.firstParty === true };
    };
    return {
        // `bundled` also needs the host's own built-in rule (the id is in a scanned root that is not the installed one, a string compare that does not depend on realpath): a
        // plugin that is only "not strict" (the installed root could not be resolved) is `manual`, since `bundled` pre-grants Background (grants.ts basisOf).
        sourceOf: (id, m, strict) => { const s = of(id, m.version, strict).source; return s === 'bundled' && d.isBuiltIn !== undefined && !d.isBuiltIn(id) ? 'manual' : s; },
        admit: (id, m, strict) => {
            const s = of(id, m.version, strict);
            const ok = (0, names_1.nameAllowed)({ name: m.name, ...(m.author !== undefined ? { author: m.author } : {}) }, s.source, s.firstParty);
            return ok === true ? null : ok;
        },
    };
}
/** Free bytes for an unprivileged writer on the volume of `dir` (statfs; throws when it cannot tell, which the installer reads as room). */
function freeBytesOf(dir) {
    const st = fs.statfsSync(dir);
    return Number(st.bavail) * Number(st.bsize);
}
/**
 * The product's installer: the real download, statfs, the index client's catalog, the market config's loopback rule, and the revocations
 * (`revocationOf`: main.ts passes Revocations.revocationOf, the rule the registry applies; without it the catalog's own list).
 */
function appInstaller(o) {
    const { version, testBuild, env, revocationOf, ...rest } = o;
    return new installer_1.Installer({
        ...rest, revocationOf: revocationOf ?? ((id, v) => revocationIn(o.client.catalog(), id, v)), download: fetchbounded_1.downloadVerified, freeBytes: freeBytesOf,
        userAgent: `EVE-Cyno/${version}`, allowLoopbackHttp: marketConfig({ testBuild, env }).allowLoopbackHttp,
    });
}
/**
 * The product's plugin updates (R29): market/state.json, the swap journal in the installer's staging folder (<userData>/plugins/staging, the
 * sibling of the installed root) and the app's "Check for updates" switch (`checkOn`: main.ts's UpdateCheckSwitch; R31: off, no update is
 * fetched or applied by itself).
 */
function appPluginUpdates(o) {
    const { userData, checkOn, ...rest } = o;
    return new updates_1.PluginUpdates({
        ...rest, state: new client_1.MarketStateFile(path.join((0, exports.marketDir)(userData), 'state.json')), journal: path.join(userData, 'plugins', 'staging', 'swap.json'), checkOn,
    });
}
