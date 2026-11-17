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
exports.refusalCode = void 0;
exports.checkStagedPlugin = checkStagedPlugin;
// The staged checks of a plugin archive (R25, R26 steps 3 and 4), one function for the installer (installer.ts stagePlugin) and for
// scripts/index-verify.mjs --archives (6d review m1), so a published index is checked exactly as the app installs it: plugin.json at the
// archive root, room for the unpacked size, the entries unpacked into <root>/<id>, the unpacked plugin.json read as the loader reads it
// (readManifestFile: at most 256 KiB, no link), parsed and compared with the listing (listingDifference), then the loader's own checks of
// the folder (inspectPluginDir, strict: `main` a regular file inside it, no link, no hard-linked file). `why` says what failed for a person
// and never names a path; `error` is the installer's code.
const path = __importStar(require("node:path"));
const loader_1 = require("../loader");
const manifest_1 = require("../manifest");
const indexformat_1 = require("./indexformat");
const zipread_1 = require("./zipread");
const codeOf = (e) => { const c = e?.code; return typeof c === 'string' && /^[A-Za-z_]{1,32}$/.test(c) ? c : 'error'; };
/** The installer's code for a refusal of the loader or the registry (loader.ts Refused.code). */
const refusalCode = (code) => code === 'uninstalling' ? 'busy' : code === 'reserved_name' || code === 'reserved_author' ? 'reserved_name' : code === 'incompatible_api' ? 'incompatible_api' : 'archive';
exports.refusalCode = refusalCode;
/**
 * The checks of the archive `entries` (readZip accepted them) against the listing `l` at `v`, unpacked into `<root>/<l.id>` (`root` an
 * empty folder of the caller's, which removes it). `room(bytes)`: whether the disk has room for the unpacked size (the installer's margin).
 */
function checkStagedPlugin(entries, root, l, v, room = () => true) {
    if (!entries.some(e => e.name === 'plugin.json' && !e.dir))
        return { ok: false, error: 'archive', why: 'no plugin.json at the archive root' };
    if (!room(entries.reduce((n, e) => n + e.size, 0)))
        return { ok: false, error: 'disk', why: 'no room on the disk for the unpacked archive' };
    try {
        (0, zipread_1.extractTo)(entries, path.join(root, l.id));
    }
    catch (e) {
        return { ok: false, error: 'disk', why: `it could not be unpacked (${codeOf(e)})`, code: codeOf(e) };
    }
    let m;
    try {
        m = (0, manifest_1.parseManifest)((0, manifest_1.parseManifestJson)((0, manifest_1.readManifestFile)(path.join(root, l.id, 'plugin.json'))));
    }
    catch (e) {
        const msg = e?.message;
        return { ok: false, error: codeOf(e) === 'incompatible_api' ? 'incompatible_api' : 'archive', why: `the app refuses its plugin.json (${typeof msg === 'string' ? msg : 'bad'})` };
    }
    const d = (0, indexformat_1.listingDifference)(m, l, v);
    if (d !== null)
        return { ok: false, error: 'listing_mismatch', why: `its plugin.json ${d} ${d === 'permissions' ? 'differ' : 'differs'} from the listing` };
    const found = (0, loader_1.inspectPluginDir)(root, l.id, true);
    if (found === null)
        return { ok: false, error: 'archive', why: 'the app\'s loader finds no plugin folder in it' };
    if ('refused' in found)
        return { ok: false, error: (0, exports.refusalCode)(found.refused.code), why: `the app's loader refuses the unpacked plugin (${codeOf(found.refused)})`, code: codeOf(found.refused) };
    return { ok: true, manifest: found.manifest };
}
