"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.isEmptySet = exports.unionSet = exports.perCharacterGroupOf = exports.PER_CHARACTER_SCOPES = void 0;
exports.cleanOptional = cleanOptional;
exports.exactOptional = exactOptional;
exports.optionalKeys = optionalKeys;
exports.fromKeys = fromKeys;
exports.minusSet = minusSet;
exports.intersectSet = intersectSet;
exports.optionalOf = optionalOf;
// Optional permission items (option A, plan 2026-11-09): the items of a manifest that a plugin can run without, as sets and as keys. Pure (no
// Electron). It imports no value from grants.ts (grants.ts imports this module); the helpers that read a `Granted` live there.
// Kinds in v1: ESI scopes, network origins, clipboard read and notifications. Keys: 'esi:<scope>', 'network:<origin>', 'clipboard:read', 'notifications'.
const esi_scopes_json_1 = __importDefault(require("./schemas/esi-scopes.json"));
const manifest_1 = require("./manifest");
/**
 * The optional ESI scopes the host asks per character (Assets M3, host item H9): the registry's `perCharacter` list (esi-scopes.json, kept in
 * cynod/tools/genroutes), today the corporation scopes, the character's blueprints, structure_markets (Assets M4; a portal read scope outside allRead)
 * and (Fit L8, coordinator ruling CD-5) write_fittings, the one write scope a character grants on its own. The mark is the host's, never a
 * manifest's. A plugin that holds one as a granted scope, optional or required (D14 amended,
 * coordinator 2026-11-11), gets it asked only of the characters the user turns it on for (vaultservice.ts). Every other optional ESI scope is asked of
 * every covered character once allowed.
 */
exports.PER_CHARACTER_SCOPES = new Set(esi_scopes_json_1.default.perCharacter);
const GROUPS = esi_scopes_json_1.default.perCharacterGroups;
/**
 * The host's name for the group of a per-character scope (the registry's `perCharacterGroups`: "corporation data" for the six, "saving fittings" for
 * write_fittings): the Characters line, the turn-on button and the prompt note. A plugin gets one Characters line per group it holds. undefined for a
 * scope the registry does not mark.
 */
const perCharacterGroupOf = (scope) => (exports.PER_CHARACTER_SCOPES.has(scope) && Object.hasOwn(GROUPS, scope) ? GROUPS[scope] : undefined);
exports.perCharacterGroupOf = perCharacterGroupOf;
// The bounds and the item rule of the required lists (schemas/manifest.v1.json `permissions.esi` and `permissions.network`).
const ESI_MAX = 64;
const NETWORK_MAX = 32;
const SCOPE = /^esi[-.][A-Za-z0-9_.:-]+$/;
const isObj = (v) => typeof v === 'object' && v !== null && !Array.isArray(v);
const own = (o, k) => (Object.hasOwn(o, k) ? o[k] : undefined);
const isScope = (s) => typeof s === 'string' && s.length <= 100 && SCOPE.test(s);
// An origin only in its canonical form: an item is never rewritten, so no two spellings of one origin can stand side by side.
const isOrigin = (s) => {
    if (typeof s !== 'string' || s.length > 255)
        return false;
    try {
        return (0, manifest_1.canonicalOrigin)(s) === s;
    }
    catch {
        return false;
    }
};
const list = (v, ok, max) => (Array.isArray(v) ? [...new Set(v.filter(x => ok(x)))].slice(0, max) : []);
/**
 * The set as stored or declared: own keys only, unknown kinds and bad items dropped, duplicates once (first place kept), at most 64 scopes and 32
 * origins, `notifications` only when exactly true, an empty kind left out. `{}` for anything that is not a plain object.
 */
function cleanOptional(v) {
    if (!isObj(v))
        return {};
    const esi = list(own(v, 'esi'), isScope, ESI_MAX);
    const network = list(own(v, 'network'), isOrigin, NETWORK_MAX);
    const clip = own(v, 'clipboard');
    return {
        ...(esi.length > 0 ? { esi } : {}), ...(network.length > 0 ? { network } : {}),
        ...(Array.isArray(clip) && clip.includes('read') ? { clipboard: ['read'] } : {}), ...(own(v, 'notifications') === true ? { notifications: true } : {}),
    };
}
/**
 * The set when `v` is written exactly as the host keeps one (what a caller names, and the `declined` of a prompt's answer): a plain object whose own keys
 * are known kinds only, each list an array, `notifications` only as true, and every raw item one that cleanOptional keeps (no bad or non-canonical item,
 * no duplicate, within the bounds). null for anything else, so a reader fails closed instead of reading the part of it that cleans up.
 * A list longer than its kind's bound is null before any item is looked at (review M1): a caller's list costs at most the bound in item checks.
 */
const EXACT_MAX = { esi: ESI_MAX, network: NETWORK_MAX, clipboard: 1 };
function exactOptional(v) {
    if (!isObj(v))
        return null;
    let n = 0;
    for (const [k, x] of Object.entries(v)) {
        if (k === 'notifications') {
            if (x !== true)
                return null;
            n++;
        }
        else if (k === 'esi' || k === 'network' || k === 'clipboard') {
            if (!Array.isArray(x) || x.length > EXACT_MAX[k])
                return null;
            n += x.length;
        }
        else
            return null;
    }
    const set = cleanOptional(v);
    return n === optionalKeys(set).length ? set : null;
}
/** One key per item, in the fixed kind order esi, network, clipboard, notifications and the set's order inside a kind. */
function optionalKeys(s) {
    const c = cleanOptional(s);
    return [...(c.esi ?? []).map(x => `esi:${x}`), ...(c.network ?? []).map(x => `network:${x}`), ...(c.clipboard ? ['clipboard:read'] : []), ...(c.notifications ? ['notifications'] : [])];
}
/** The set the keys name; an unknown or malformed key is dropped. */
function fromKeys(keys) {
    const esi = [], network = [];
    let clipboard = false, notifications = false;
    for (const k of keys) {
        if (typeof k !== 'string')
            continue;
        if (k === 'clipboard:read')
            clipboard = true;
        else if (k === 'notifications')
            notifications = true;
        else if (k.startsWith('esi:'))
            esi.push(k.slice('esi:'.length));
        else if (k.startsWith('network:'))
            network.push(k.slice('network:'.length));
    }
    return cleanOptional({ esi, network, clipboard: clipboard ? ['read'] : [], notifications });
}
const unionSet = (a, b) => fromKeys([...optionalKeys(a), ...optionalKeys(b)]);
exports.unionSet = unionSet;
function minusSet(a, b) {
    const drop = new Set(optionalKeys(b));
    return fromKeys(optionalKeys(a).filter(k => !drop.has(k)));
}
function intersectSet(a, b) {
    const keep = new Set(optionalKeys(b));
    return fromKeys(optionalKeys(a).filter(k => keep.has(k)));
}
const isEmptySet = (s) => optionalKeys(s).length === 0;
exports.isEmptySet = isEmptySet;
/**
 * The manifest's optional items (`permissions.optional`, API 1.17.0), minus any item its required part already holds (an item is in one list only).
 * parseManifest refuses such an item already; the field is read through cleanOptional all the same, so a manifest built by hand (a test, a listing
 * that never went through the parser) cannot widen the set.
 */
function optionalOf(m) {
    const p = m.permissions;
    const required = cleanOptional({ esi: p.esi, network: p.network, clipboard: p.clipboard, notifications: p.notifications === true });
    return minusSet(cleanOptional(p.optional), required);
}
