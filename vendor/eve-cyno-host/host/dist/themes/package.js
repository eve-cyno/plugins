"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.isPackageId = exports.isThemeId = exports.VARIANT_ID_RE = exports.THEME_ID_RE = exports.MAX_PACKAGES = exports.MAX_VARIANTS = exports.MAX_THEMES = exports.MAX_LICENSE_BYTES = exports.MAX_THEME_JSON_BYTES = void 0;
exports.parsePackage = parsePackage;
exports.isThemeKey = isThemeKey;
exports.resolvePackage = resolvePackage;
const theme_package_v1_json_1 = __importDefault(require("../schemas/theme-package.v1.json"));
const errors_1 = require("../errors");
const manifest_1 = require("../manifest");
const contrast_1 = require("./contrast");
const roles_1 = require("./roles");
exports.MAX_THEME_JSON_BYTES = 262_144;
exports.MAX_LICENSE_BYTES = 65_536;
exports.MAX_THEMES = 8;
exports.MAX_VARIANTS = 16;
exports.MAX_PACKAGES = 16;
exports.THEME_ID_RE = /^[a-z][a-z0-9-]{0,31}$/;
exports.VARIANT_ID_RE = /^[a-z][a-z0-9-]{0,23}$/;
/** Names every object inherits; refused as theme and variant ids so no lookup keyed by an id can meet an inherited member. */
const RESERVED_IDS = new Set(['constructor', 'prototype', '__proto__']);
const isThemeId = (s) => exports.THEME_ID_RE.test(s) && !RESERVED_IDS.has(s);
exports.isThemeId = isThemeId;
/** A package id follows the plugin id rule, without the host's reserved prefix. */
const isPackageId = (s) => (0, manifest_1.isPluginId)(s) && !s.startsWith(manifest_1.HOST_ID_PREFIX);
exports.isPackageId = isPackageId;
const MAX_MESSAGE = 200;
const bad = (msg) => (0, errors_1.coded)('bad_params', msg.length > MAX_MESSAGE ? msg.slice(0, MAX_MESSAGE - 1) + '…' : msg);
const refuse = (path, problem) => bad(`theme.json: ${path ? path + ': ' : ''}${problem}`);
/** A key from the package, safe to show: printable ASCII only, cut at 40. */
const shown = (k) => k.replace(/[^\x20-\x7e]/g, '?').slice(0, 40);
class ProtoKey extends Error {
}
let validate = null;
const validator = () => (validate ??= (0, manifest_1.newPluginAjv)().compile(theme_package_v1_json_1.default));
/** `/themes/0/roles/--c-fg` becomes `themes[0].roles.--c-fg`. */
function dotted(instancePath) {
    return instancePath.split('/').slice(1).map(s => shown(s.replace(/~1/g, '/').replace(/~0/g, '~')))
        .reduce((acc, seg) => (/^\d+$/.test(seg) ? `${acc}[${seg}]` : acc ? `${acc}.${seg}` : seg), '');
}
function describe(e) {
    const where = dotted(e.instancePath);
    const join = (key) => (where ? `${where}.${shown(key)}` : shown(key));
    switch (e.keyword) {
        case 'additionalProperties': return refuse(join(String(e.params.additionalProperty)), 'unknown key').message;
        case 'required': return refuse(join(String(e.params.missingProperty)), 'required').message;
        case 'pattern': {
            const key = where.slice(where.lastIndexOf('.') + 1);
            if (where.endsWith('.id') || where === 'id')
                return refuse(where, 'not a valid id').message;
            if (key === 'license')
                return refuse(where, 'not an SPDX-style licence id').message;
            return refuse(where, roles_1.ALPHA_KEYS.has(key) ? 'must be #rrggbb or #rrggbbaa' : 'must be #rrggbb').message;
        }
        default: return refuse(where, e.message ?? 'invalid').message;
    }
}
function parseJson(bytes) {
    let text;
    try {
        text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    }
    catch {
        throw bad('theme.json: not valid JSON');
    }
    try {
        // A reviver sees every key, including an own `__proto__` that JSON.parse creates; refusing it keeps every later copy safe.
        return JSON.parse(text, (k, v) => { if (k === '__proto__')
            throw new ProtoKey(); return v; });
    }
    catch (e) {
        if (e instanceof ProtoKey)
            throw refuse('__proto__', 'keys are not allowed');
        throw bad('theme.json: not valid JSON');
    }
}
const display = (path, v, max) => {
    const t = v.trim();
    const problem = (0, manifest_1.displayProblem)(t, max);
    if (problem)
        throw refuse(path, problem);
    return t;
};
const FONT_LIST = Object.keys(roles_1.FONT_NAMES).join(', ');
const FONT_ROLES = ['display', 'body', 'mono'];
const RADII = ['base', 'sm', 'md', 'lg'];
/** Colours (lower-cased) and the glow of one roles object; the schema already allowed only known keys and shapes. */
function readRoles(raw) {
    const roles = {};
    if (raw === undefined)
        return { roles };
    for (const k of roles_1.ROLE_KEYS) {
        const v = raw[k];
        if (typeof v === 'string')
            roles[k] = v.toLowerCase();
    }
    const g = raw['--k-glow'];
    return typeof g === 'number' ? { roles, glow: g } : { roles };
}
function parsePackage(bytes) {
    if (bytes.length > exports.MAX_THEME_JSON_BYTES)
        throw refuse('', `larger than ${exports.MAX_THEME_JSON_BYTES} bytes`);
    const raw = parseJson(bytes);
    if (typeof raw === 'object' && raw !== null && !Array.isArray(raw)) {
        const s = raw.schema;
        if (typeof s === 'number' && s !== 1)
            throw bad(`unsupported theme.json schema ${Number.isFinite(s) ? String(s).slice(0, 20) : '?'}`);
    }
    const v = validator();
    if (!v(raw))
        throw bad(describe((v.errors ?? [])[0]));
    const m = raw;
    if (m.id.startsWith(manifest_1.HOST_ID_PREFIX))
        throw refuse('id', `the prefix ${manifest_1.HOST_ID_PREFIX} is reserved for the host`);
    if (!(0, exports.isPackageId)(m.id))
        throw refuse('id', 'not a valid id (three or more dot-separated lowercase parts, at most 100 characters)');
    const name = display('name', m.name, 40);
    const author = display('author', m.author, 80);
    if (!manifest_1.SEMVER.test(m.version))
        throw refuse('version', 'not a semver version');
    const seen = new Set();
    const themes = m.themes.map((t, i) => {
        const at = `themes[${i}]`;
        if (!(0, exports.isThemeId)(t.id))
            throw refuse(`${at}.id`, 'must be 1-32 characters: a lowercase letter, then lowercase letters, digits or -');
        if (seen.has(t.id))
            throw refuse(`${at}.id`, 'duplicate theme id');
        seen.add(t.id);
        const themeName = display(`${at}.name`, t.name, 32);
        const fonts = {};
        for (const role of FONT_ROLES) {
            const f = t.fonts?.[role];
            if (f === undefined)
                continue;
            if (!Object.hasOwn(roles_1.FONT_NAMES, f))
                throw refuse(`${at}.fonts.${role}`, `must be one of ${FONT_LIST}`);
            fonts[role] = roles_1.FONT_NAMES[f];
        }
        const radius = {};
        for (const k of RADII)
            if (t.radius?.[k] !== undefined)
                radius[k] = t.radius[k];
        const { roles, glow } = readRoles(t.roles);
        let accents = null;
        if (t.accents) {
            const entries = Object.entries(t.accents.variants);
            for (const [vid] of entries) {
                if (RESERVED_IDS.has(vid))
                    throw refuse(`${at}.accents.variants.${vid}`, 'this variant id is reserved');
                if (!exports.VARIANT_ID_RE.test(vid))
                    throw refuse(`${at}.accents.variants.${shown(vid)}`, 'variant id must be 1-24 characters: a lowercase letter, then lowercase letters, digits or -');
            }
            if (!Object.hasOwn(t.accents.variants, t.accents.default))
                throw refuse(`${at}.accents.default`, 'must name one of the variants');
            accents = {
                default: t.accents.default,
                variants: entries.map(([vid, vr]) => {
                    const r = readRoles(vr);
                    return r.glow === undefined ? { id: vid, roles: r.roles } : { id: vid, roles: r.roles, glow: r.glow };
                }),
            };
        }
        const decl = { id: t.id, name: themeName, scheme: t.scheme, fonts, radius, roles, accents };
        if (glow !== undefined)
            decl.glow = glow;
        return decl;
    });
    return { id: m.id, name, author, version: m.version, license: m.license ?? null, themes };
}
/** `cyno`, or `pkg:<package id>/<theme id>`: the only strings a stored or requested theme may be. */
function isThemeKey(s) {
    if (s === 'cyno')
        return true;
    const m = /^pkg:([^/]+)\/([^/]+)$/.exec(s);
    return m !== null && (0, exports.isPackageId)(m[1]) && (0, exports.isThemeId)(m[2]);
}
/** `base` overlaid with `roles` and `glow`; a fresh object, `base` is untouched. */
function overlay(base, roles, glow) {
    return { ...base, roles: { ...base.roles, ...roles }, fonts: { ...base.fonts }, radius: { ...base.radius }, glow: glow ?? base.glow };
}
/** Sets, in place, each fallback role (roles.ts ROLE_FALLBACKS) that the theme and variant leave unset (per `isSet`) from its source role,
 *  when they set that one; with neither set, the role keeps Cyno's own value. */
function withFallbacks(values, isSet) {
    for (const [k, from] of roles_1.ROLE_FALLBACKS)
        if (!isSet(k) && isSet(from))
            values.roles[k] = values.roles[from];
    return values;
}
/** Applies the contrast, accent and request-state checks (R9) to a parsed package: failing variants and themes are listed in `refused`. */
function resolvePackage(p) {
    const refused = [];
    const themes = [];
    for (const t of p.themes) {
        const themeSets = (k) => t.roles[k] !== undefined;
        const base = withFallbacks(overlay({ ...roles_1.CYNO, scheme: t.scheme, fonts: { ...roles_1.CYNO.fonts, ...t.fonts }, radius: { ...roles_1.CYNO.radius, ...t.radius } }, t.roles, t.glow), themeSets);
        const touchedSet = new Set();
        for (const v of t.accents?.variants ?? [])
            for (const k of Object.keys(v.roles))
                touchedSet.add(k);
        // A fallback role the theme leaves unset follows its source role, so it moves with every variant that moves the source.
        for (const [k, from] of roles_1.ROLE_FALLBACKS)
            if (!themeSets(k) && touchedSet.has(from))
                touchedSet.add(k);
        const touched = roles_1.ROLE_KEYS.filter(k => touchedSet.has(k));
        const theme = {
            key: `pkg:${p.id}/${t.id}`, id: t.id, name: t.name, scheme: t.scheme, values: base, variants: [],
            defaultAccent: t.accents?.default ?? null, touched,
        };
        if (!t.accents) {
            const r = (0, contrast_1.checkValues)(base, true);
            if (r.fail) {
                refused.push({ theme: t.id, reason: r.fail });
                continue;
            }
            themes.push(theme);
            continue;
        }
        // The base needs the hard checks and the request rule too: a theme whose base ice borrows a palette or status colour is refused.
        const baseFail = (0, contrast_1.checkValues)(base, false).fail;
        if (baseFail) {
            refused.push({ theme: t.id, reason: baseFail });
            continue;
        }
        let themeFail = null;
        for (const v of t.accents.variants) {
            const values = withFallbacks(overlay(base, v.roles, v.glow), k => themeSets(k) || v.roles[k] !== undefined);
            const isDefault = v.id === t.accents.default;
            const r = (0, contrast_1.checkValues)(values, isDefault);
            if (r.fail) {
                if (isDefault) {
                    themeFail = r.fail;
                    break;
                }
                refused.push({ theme: t.id, variant: v.id, reason: r.fail });
                continue;
            }
            theme.variants.push({ id: v.id, name: v.id.charAt(0).toUpperCase() + v.id.slice(1), values, low: r.low });
        }
        if (themeFail) {
            for (let i = refused.length - 1; i >= 0; i--)
                if (refused[i].theme === t.id)
                    refused.splice(i, 1);
            refused.push({ theme: t.id, reason: themeFail });
            continue;
        }
        themes.push(theme);
    }
    return { id: p.id, name: p.name, author: p.author, version: p.version, license: p.license, themes, refused };
}
