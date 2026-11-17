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
exports.pollIntervalMs = exports.canSendOut = exports.characterKey = void 0;
exports.loadHostKey = loadHostKey;
exports.toWindowInfo = toWindowInfo;
exports.pxToDipLinux = pxToDipLinux;
// What a plugin sees of the EVE windows: the cynod snapshot turned into WindowInfo. Pure (no Electron, no OS); the one place that
// decides who gets a character name, a per-plugin key and a character id.
const node_crypto_1 = require("node:crypto");
const fs = __importStar(require("node:fs"));
const KEY_BYTES = 32;
/**
 * An opaque per-plugin identifier of a character: the first 32 hex characters of HMAC-SHA256(hostKey, `${pluginId}\n${name}`).
 * Stable for one plugin across windows and restarts (the host key is persisted); another plugin cannot match it to its own.
 */
const characterKey = (hostKey, pluginId, name) => (0, node_crypto_1.createHmac)('sha256', hostKey).update(`${pluginId}\n${name}`).digest('hex').slice(0, 32);
exports.characterKey = characterKey;
/** The host's secret for `characterKey`: 32 random bytes in `file` (mode 0600). A file of another length is replaced. */
function loadHostKey(file) {
    try {
        const b = fs.readFileSync(file);
        if (b.length === KEY_BYTES)
            return b;
    }
    catch (e) {
        const code = e.code;
        if (code !== 'ENOENT') {
            // Locked or unreadable: never replace a key we could not read, and never stop the app. This session uses a key of its own
            // (names are keyed differently until the file can be read again). Only the error code is logged.
            console.warn(`os-key unreadable (${code ?? 'error'}); using a session key`);
            return (0, node_crypto_1.randomBytes)(KEY_BYTES);
        }
    }
    const key = (0, node_crypto_1.randomBytes)(KEY_BYTES);
    const tmp = `${file}.tmp`;
    try {
        try {
            fs.unlinkSync(tmp);
        }
        catch (e) {
            if (e.code !== 'ENOENT')
                throw e;
        } // a stale temp may have a wider mode
        const fd = fs.openSync(tmp, 'wx', 0o600);
        try {
            fs.writeFileSync(fd, key);
        }
        finally {
            fs.closeSync(fd);
        }
        fs.renameSync(tmp, file);
    }
    catch (e) {
        console.warn(`os-key not saved (${e.code ?? 'error'}); using a session key`);
    }
    return key;
}
/**
 * Whether a plugin has a way to pass data on: a network host, a consumed service, a provided service (the broker relays to other
 * plugins, which may have a network), the AI or the account. R2' extended with ai and account (B2 routing). The one predicate for
 * window names here and for the permission text (permtext.ts). `files` (API 1.1.0) is deliberately not a way out (owner ruling P3): the
 * user picks every file in a host dialog, so a plugin with it keeps `WindowInfo.character`, and its prompt line says a saved file can hold names.
 * `gameEvents` (API 1.2.0) is input, like `windowThumbnails`: it is not a way out either, so a plugin with it and none of the above keeps
 * `WindowInfo.character` (spec 4.3); other players' names in its events follow this same predicate (spec 4.4).
 * R2 as amended for chat (API 1.5.0): A plugin that can send data out gets chat only when it is built in, only from channels the user picked; other players' names in a line reach it, and it keeps them in its page.
 */
const canSendOut = (g, providesServices) => g.network.length > 0 || Object.keys(g.services).length > 0 || providesServices || g.flags.ai || g.flags.account;
exports.canSendOut = canSendOut;
// R2 (amended). `character` only for a plugin that cannot send data out: no network host, no consumed service, no provided service
// (the services broker relays data to other plugins, which may have a network), and no `ai` or `account` permission (canSendOut above); `key` for every plugin, `client` windows only;
// `characterId` only for a vault character the grant allows. `login` and `other` windows carry no name and no key.
function toWindowInfo(w, c) {
    const info = {
        id: w.id, kind: w.kind, key: null, active: w.id === c.active, minimized: w.minimized,
        bounds: c.toDip({ x: w.x, y: w.y, width: w.w, height: w.h }),
    };
    if (w.kind !== 'client' || w.character === '')
        return info;
    info.key = (0, exports.characterKey)(c.hostKey, c.pluginId, w.character);
    if (!(0, exports.canSendOut)(c.granted, c.providesServices))
        info.character = w.character;
    const id = c.vault?.get(w.character);
    if (id !== undefined && c.granted.characters !== 'none' && (c.granted.characters === 'all' || c.granted.selected.includes(id)))
        info.characterId = id;
    return info;
}
/** R11: not at all without a subscriber; every 250 ms while a client is listed; every 2 s while none is. */
const pollIntervalMs = (subscribers, clients) => subscribers <= 0 ? 0 : clients > 0 ? 250 : 2000;
exports.pollIntervalMs = pollIntervalMs;
/**
 * Linux reports X11 coordinates in physical pixels; plugins get DIP. The display holding the rectangle's centre decides the scale
 * (a display's physical origin is its DIP origin times its scale factor); with no display, the rectangle is returned unscaled.
 */
function pxToDipLinux(r, displays) {
    if (displays.length === 0)
        return { ...r };
    const cx = r.x + r.width / 2, cy = r.y + r.height / 2;
    const phys = (d) => ({ x: d.bounds.x * d.scaleFactor, y: d.bounds.y * d.scaleFactor, w: d.bounds.width * d.scaleFactor, h: d.bounds.height * d.scaleFactor });
    const dist = (d) => {
        const p = phys(d);
        return Math.hypot(Math.max(p.x - cx, 0, cx - (p.x + p.w)), Math.max(p.y - cy, 0, cy - (p.y + p.h)));
    };
    const d = displays.reduce((best, x) => dist(x) < dist(best) ? x : best, displays[0]);
    const s = d.scaleFactor > 0 ? d.scaleFactor : 1;
    const p = phys(d);
    return {
        x: Math.round((r.x - p.x) / s + d.bounds.x), y: Math.round((r.y - p.y) / s + d.bounds.y),
        width: Math.round(r.width / s), height: Math.round(r.height / s),
    };
}
