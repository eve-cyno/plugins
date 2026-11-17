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
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.HOST_ID_PREFIX = exports.isDisplayText = exports.AI_NUMBER_API = exports.OPTIONAL_API = exports.SEMVER = exports.INTERFACE_ID = exports.isPluginId = exports.PLUGIN_ID_RE = exports.DEFAULT_STORAGE_MB = exports.MAX_MANIFEST_BYTES = exports.SHARED_HOSTS = exports.ACTIVATION = exports.HOST_API = void 0;
exports.optionalEnginesOk = optionalEnginesOk;
exports.aiNumberApi = aiNumberApi;
exports.displayProblem = displayProblem;
exports.newPluginAjv = newPluginAjv;
exports.canonicalOrigin = canonicalOrigin;
exports.parsePermissions = parsePermissions;
exports.parseManifest = parseManifest;
exports.sameRegularFile = sameRegularFile;
exports.readRegularFile = readRegularFile;
exports.readManifestFile = readManifestFile;
exports.parseManifestJson = parseManifestJson;
// Plugin manifest v1: parse, validate, canonicalise. Pure (no Electron). A hostile manifest is refused here, before
// any directory, partition or origin is created from it.
const _2020_1 = __importDefault(require("ajv/dist/2020"));
const fs = __importStar(require("node:fs"));
const semver = __importStar(require("semver"));
const manifest_v1_json_1 = __importDefault(require("./schemas/manifest.v1.json"));
const esi_scopes_json_1 = __importDefault(require("./schemas/esi-scopes.json"));
const errors_1 = require("./errors");
const dataallow_1 = require("./dataallow");
exports.HOST_API = { version: '1.27.0', majors: [1] };
exports.ACTIVATION = ['onStartup', 'onCommand:', 'onService:'];
exports.SHARED_HOSTS = [
    'discord.com', 'discordapp.com', 'hooks.slack.com', 'api.telegram.org', 'webhook.site', 'pastebin.com', 'gist.github.com', 'api.github.com',
];
exports.MAX_MANIFEST_BYTES = 256 * 1024; // plugin.json on disk (checked by the reader) and its serialised parse
const MAX_SCHEMA_BYTES = 64 * 1024; // one contributed schema
const MAX_SCHEMAS_TOTAL_BYTES = 128 * 1024; // all contributed schemas of one manifest
/** The storage quota (MB) of a plugin that asks for none; it needs no consent, only a larger one does. */
exports.DEFAULT_STORAGE_MB = 5;
/** The manifest `id` rule (schema pattern + maxLength); anything that builds a path from an id checks it again. */
exports.PLUGIN_ID_RE = /^[a-z][a-z0-9-]*(\.[a-z][a-z0-9-]*){2,}$/;
const isPluginId = (s) => s.length <= 100 && exports.PLUGIN_ID_RE.test(s);
exports.isPluginId = isPluginId;
/** The ESI scopes the app registration holds; generated into schemas/esi-scopes.json from ESI's OpenAPI document. */
const REGISTERED_ESI_SCOPES = new Set(esi_scopes_json_1.default.registered);
const ITEM_ID = /^[a-z][A-Za-z0-9.-]{0,63}$/;
/** The service interface id rule (with a length of at most 64). */
exports.INTERFACE_ID = /^[a-z][a-z0-9-]*(\.[a-z][a-z0-9-]*)+$/;
const isInterfaceId = (s) => s.length <= 64 && exports.INTERFACE_ID.test(s);
// The official SemVer 2.0.0 regex (semver.org), anchored; no leading v, no whitespace.
exports.SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+([0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*))?$/;
const MAIN_PATH = /^[A-Za-z0-9._-]+(\/[A-Za-z0-9._-]+)*$/;
// A host name that is safe to put into a CSP source list: LDH labels, at least two of them (so no `*`, `;`, `,`, `'`, `_`).
const LDH_HOST = /^(?=.{1,253}$)[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/;
/** The plugin API version that brought `permissions.optional`: a manifest that writes the key needs an engines range whose lowest version is at least this one. */
exports.OPTIONAL_API = '1.17.0';
/** Whether an engines range admits only hosts that know `permissions.optional` (its lowest version is at least OPTIONAL_API, prereleases of it below). */
function optionalEnginesOk(range) {
    try {
        const min = semver.validRange(range) === null ? null : semver.minVersion(range);
        return min !== null && semver.gte(min, exports.OPTIONAL_API);
    }
    catch {
        return false;
    }
}
/**
 * The plugin API version whose `AiLimits.turnsPerAsk` is any whole number from 1 to 30 and whose `ai` stream has the `tool` event (1.26.0). A plugin whose engines
 * range starts below it was typed against `turnsPerAsk: 6 | 12 | 16` and an event list without `tool`: the host answers it in that shape (AiService.limitsFor,
 * registerAiMethods).
 */
exports.AI_NUMBER_API = '1.26.0';
/** Whether an engines range admits only hosts of API 1.26.0 or later (its lowest version is at least AI_NUMBER_API). Absent, not a range or unreadable: false, the older shape. */
function aiNumberApi(range) {
    if (typeof range !== 'string')
        return false;
    try {
        const min = semver.validRange(range) === null ? null : semver.minVersion(range);
        return min !== null && semver.gte(min, exports.AI_NUMBER_API);
    }
    catch {
        return false;
    }
}
const bad = (msg) => (0, errors_1.coded)('bad_manifest', msg);
// Display text shown in the consent prompt: trimmed, 1-60 characters, no control characters (so no newline, no bell).
const CONTROL = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\p{Co}\p{Cs}\p{Cn}\u2800\p{Default_Ignorable_Code_Point}]/u; // controls, format (bidi, zero-width), separators, private use, lone surrogates, unassigned code points, braille blank and invisible fillers (U+3164)
const VISIBLE = /[\p{L}\p{N}\p{S}\p{P}]/u; // at least one character a reader can see (marks and spaces alone are not a name)
const PICT = /\p{Extended_Pictographic}/u;
const BASE = /[\p{L}\p{N}\p{S}\p{P}\p{Extended_Pictographic}]/u;
const MARK = /\p{M}/u;
const MAX_MARKS = 2;
// Emoji need two format characters the plain rule refuses; they are allowed only in these positions:
//  - U+FE0E / U+FE0F (text and emoji presentation) directly after a base character, once;
//  - U+200D (zero width joiner) between two Extended_Pictographic characters (the first may carry a U+FE0F);
//  - at most MAX_MARKS combining marks in a row (stacked marks make unbounded vertical "zalgo" text).
// Everything else goes through CONTROL as before.
function displayProblem(t, max) {
    const cps = [...t];
    if (cps.length < 1 || cps.length > max)
        return `must be 1-${max} characters`;
    const kept = [];
    let prevBase = false; // the last kept character is a base that may take a variation selector
    let prevPict = false; // the last kept character is pictographic (possibly with its selector): a ZWJ may follow
    let marks = 0;
    for (let i = 0; i < cps.length; i++) {
        const c = cps[i];
        if (c === '\uFE0E' || c === '\uFE0F') {
            if (!prevBase)
                return 'control, format, separator, private-use and invisible characters are not allowed';
            prevBase = false;
            continue;
        }
        if (c === '\u200D') {
            if (!prevPict || !PICT.test(cps[i + 1] ?? ''))
                return 'control, format, separator, private-use and invisible characters are not allowed';
            prevBase = false;
            prevPict = false;
            continue;
        }
        if (MARK.test(c)) {
            if (++marks > MAX_MARKS)
                return 'too many combining marks in a row';
            prevBase = false;
        }
        else {
            marks = 0;
            prevBase = BASE.test(c);
            prevPict = PICT.test(c);
        }
        kept.push(c);
    }
    const rest = kept.join('');
    if (CONTROL.test(rest))
        return 'control, format, separator, private-use and invisible characters are not allowed';
    if (!VISIBLE.test(rest))
        return 'must contain a letter, number, symbol or punctuation mark';
    return null;
}
/**
 * The one display-text rule of the host: 1 to `max` code points, no control, format (bidi, zero-width), separator,
 * private-use or invisible characters (so no newline), and at least one visible character. The manifest's names use it
 * (max 60), and so do the texts a plugin sets at run time (status 80, tile context 30, which is refused when longer; the tile title 40, line 60 and badge 8 are cut instead, see tiles.ts).
 */
const isDisplayText = (s, max) => typeof s === 'string' && displayProblem(s, max) === null;
exports.isDisplayText = isDisplayText;
function displayText(field, v, max = 60) {
    const t = v.trim();
    const problem = displayProblem(t, max);
    if (problem)
        throw bad(`${field}: ${problem}`);
    return t;
}
// The manifest schema has its own strict instance. Contributed schemas are compiled on a fresh instance per parse (no
// loadSchema), so nothing one plugin contributes can be seen by another.
const validateManifest = new _2020_1.default({ strict: true }).compile(manifest_v1_json_1.default);
// The one set of options for every instance that compiles a contributed schema: here, and wherever settings or service
// calls are validated against one. inlineRefs false: each `$defs` entry compiles once, as its own function, instead of
// being copied into every place that references it (copies made the parse at the old cap take 2.8 s and multiplied the
// generated code). loopEnum and loopRequired 8: a longer `enum` or `required` list compiles to a loop, not to one
// `(((a) || b) || c)` expression that V8 parses one recursion per term (199 terms cost the stack of ~110 schema nodes).
// logger false: on a failed compile ajv would print the generated code, which embeds plugin strings, into the host log.
function newPluginAjv() {
    return new _2020_1.default({ strict: true, inlineRefs: false, loopEnum: 8, loopRequired: 8, logger: false })
        .addKeyword({ keyword: 'x-unit', schemaType: 'string' }).addKeyword({ keyword: 'x-enumLabels', schemaType: 'array' })
        .addKeyword({ keyword: 'x-multiline', schemaType: 'boolean' }).addKeyword({ keyword: 'x-preview', schemaType: 'boolean' }); // annotations only
}
function describe(e) {
    const where = e.instancePath || '/';
    if (e.keyword === 'additionalProperties')
        return `${where}/${String(e.params.additionalProperty)}: unknown key`;
    if (e.keyword === 'propertyNames')
        return `${where}: invalid key (${String(e.params.propertyName)})`;
    return `${where}: ${e.message ?? 'invalid'}`;
}
// Canonical https origin: lowercase, default port dropped, no path/query/fragment/userinfo, no IP literal, no localhost.
function canonicalOrigin(s) {
    if (typeof s !== 'string')
        throw bad('network: not a string');
    let u;
    try {
        u = new URL(s);
    }
    catch {
        throw bad(`network: not a URL (${s})`);
    }
    if (u.protocol !== 'https:')
        throw bad(`network: only https origins are allowed (${s})`);
    if (u.username || u.password)
        throw bad(`network: userinfo is not allowed (${s})`);
    if (u.pathname !== '/' || u.search || u.hash || s.includes('?') || s.includes('#'))
        throw bad(`network: path, query and fragment are not allowed (${s})`);
    const h = u.hostname;
    if (!h || h.endsWith('.'))
        throw bad(`network: bad host (${s})`);
    if (h.startsWith('[') || /^\d+\.\d+\.\d+\.\d+$/.test(h))
        throw bad(`network: IP literals are not allowed (${s})`);
    if (h === 'localhost' || h.endsWith('.localhost'))
        throw bad(`network: localhost is not allowed (${s})`);
    if (!LDH_HOST.test(h))
        throw bad(`network: not a plain DNS host name (${s})`);
    return `https://${u.host}`;
}
function checkMain(main, field = 'main') {
    if (!MAIN_PATH.test(main))
        throw bad(`${field}: must be a relative path of [A-Za-z0-9._-] segments with forward slashes (no query, fragment, escapes or backslashes)`);
    if (main.split('/').some(seg => seg === '.' || seg === '..'))
        throw bad(`${field}: must not contain "." or ".." segments`);
}
// Contributed schemas are checked against a keyword ALLOWLIST at every schema position (the plugin's regexes would run
// in the main process: no `pattern`, `patternProperties`, `format`; no ids or anchors: no registry; no `dependencies`,
// `definitions`, `$dynamicRef` and the rest of the unlisted keywords). `default`, `examples`, `const` and `enum` hold
// data, are never walked as schemas, and nothing may `$ref` into them: the only reference form is `#/$defs/<name>`.
const ALLOWED = new Set([
    'type', 'enum', 'const', 'properties', 'required', 'additionalProperties', 'items', 'prefixItems', 'minItems', 'maxItems',
    'uniqueItems', 'contains', 'minContains', 'maxContains', 'minLength', 'maxLength', 'minimum', 'maximum', 'exclusiveMinimum',
    'exclusiveMaximum', 'multipleOf', 'minProperties', 'maxProperties', 'propertyNames', 'dependentRequired', 'dependentSchemas',
    'anyOf', 'oneOf', 'allOf', 'not', 'if', 'then', 'else', 'unevaluatedProperties', 'unevaluatedItems', '$defs', '$ref', '$schema',
    '$comment', 'title', 'description', 'default', 'examples', 'deprecated', 'readOnly', 'writeOnly',
    'x-unit', 'x-enumLabels', 'x-multiline', 'x-preview', // display annotations of the settings form (R21): the validator ignores them
]);
const MAX_UNIT = 12;
const SUB_ONE = new Set(['additionalProperties', 'items', 'contains', 'propertyNames', 'not', 'if', 'then', 'else', 'unevaluatedProperties', 'unevaluatedItems']);
const SUB_ARR = new Set(['prefixItems', 'anyOf', 'oneOf', 'allOf']);
const SUB_MAP = new Set(['properties', 'dependentSchemas', '$defs']);
const DRAFT_2020 = 'https://json-schema.org/draft/2020-12/schema';
const DEF_NAME = /^[A-Za-z0-9_-]{1,64}$/;
const REF_FORM = /^#\/\$defs\/([A-Za-z0-9_-]{1,64})$/;
const esc = (k) => k.replace(/~/g, '~0').replace(/\//g, '~1');
const isMap = (v) => typeof v === 'object' && v !== null && !Array.isArray(v);
// Stack. ajv generates one function per contributed schema (a `$ref` is a call into the def's own function, see
// newPluginAjv) in which every schema node opens nested blocks; generating that code, and V8 parsing it on the first
// call, recurse once per level, and a cold process (startup) uses the most stack. Windows has less of it to spare than
// Linux: the round-3 at-cap shapes (1990 sibling nodes; 5 inlined copies of a 1000-node def) overflowed there, and on
// Linux a cold process already overflowed on the first call at about 1390 siblings. With the caps below the costliest
// accepted shapes (selftest-manifest M-stack-*: 16 levels of unevaluatedProperties chains with siblings, a 126-name
// unevaluatedProperties check, 64 refs) compile and run in a cold process at a 200 KiB stack on Linux, a fifth of
// Node's default 984 KiB; they fail at 150 KiB.
const MAX_SCHEMA_DEPTH = 16;
const MAX_SCHEMA_NODES = 128; // one contributed schema, $defs included; a `dependentRequired` entry and each name in it count too
const MAX_NODES = 2000; // all contributed schemas of one manifest: bounds the parse time
const MAX_DEFS = 200; // $defs entries, all contributed schemas of one manifest
const MAX_REFS = 64; // $ref occurrences in one contributed schema
const MAX_ENUM_ITEMS = 256;
const MAX_CONST_BYTES = 4096; // serialised
// Validation work. A `$ref` runs the whole def it points at, so a schema weighs its own serialised bytes plus, for every
// `$ref`, the serialised bytes of that def. Capped per manifest: 400 refs to a 3500-item enum took 14.3 s for 1000 items.
const MAX_EXPANDED_BYTES = 256 * 1024;
class SchemaBudget {
    bytes = 0;
    nodes = 0;
    expanded = 0;
    defCount = 0;
    ajv = newPluginAjv(); // fresh per parse; no ids or anchors are allowed, so nothing registers in it
    count(w, n = 1) {
        w.nodes += n;
        this.nodes += n;
        if (w.nodes > MAX_SCHEMA_NODES)
            throw bad(`${w.field}: schema has more than ${MAX_SCHEMA_NODES} nodes`);
        if (this.nodes > MAX_NODES)
            throw bad(`${w.field}: contributed schemas have more than ${MAX_NODES} nodes`);
    }
    walk(w, node, ptr, depth, inDef) {
        const f = w.field;
        if (typeof node !== 'boolean' && !isMap(node))
            return; // not a schema: the compile refuses it
        if (depth > MAX_SCHEMA_DEPTH)
            throw bad(`${f}: schema nested too deeply (more than ${MAX_SCHEMA_DEPTH} levels)`);
        this.count(w); // true and false are schemas too, and generate code
        if (typeof node === 'boolean')
            return;
        const sub = (v, p, d = inDef) => this.walk(w, v, p, depth + 1, d);
        for (const [k, v] of Object.entries(node)) {
            if (!ALLOWED.has(k))
                throw bad(`${f}${ptr}: keyword "${k}" is not allowed in a contributed schema`);
            if (k === '$schema' && v !== DRAFT_2020)
                throw bad(`${f}${ptr}: keyword "$schema" must be ${DRAFT_2020}`);
            if (k === 'enum' && Array.isArray(v) && v.length > MAX_ENUM_ITEMS)
                throw bad(`${f}${ptr}: enum has more than ${MAX_ENUM_ITEMS} items`);
            // Data keywords hold JSON primitives only: an object or array there is a schema-shaped payload the validator would walk.
            if (k === 'enum' && Array.isArray(v) && v.some(x => typeof x === 'object' && x !== null))
                throw bad(`${f}${ptr}: keyword "enum" values must be strings, numbers, booleans or null`);
            if (k === 'x-unit' && !((0, exports.isDisplayText)(v, MAX_UNIT)))
                throw bad(`${f}${ptr}: keyword "x-unit" must be 1-${MAX_UNIT} printable characters on one line`);
            if (k === 'x-multiline' && !(v === true && node.type === 'string'))
                throw bad(`${f}${ptr}: keyword "x-multiline" must be true on a property of type "string"`);
            if (k === 'x-preview' && !(v === true && Array.isArray(node.enum)))
                throw bad(`${f}${ptr}: keyword "x-preview" must be true on a property with an "enum"`);
            if (k === 'x-enumLabels') {
                const en = node.enum;
                if (!Array.isArray(en) || !Array.isArray(v) || v.length !== en.length)
                    throw bad(`${f}${ptr}: keyword "x-enumLabels" needs an "enum" of the same length`);
                if (v.some(x => !(0, exports.isDisplayText)(x, 60)))
                    throw bad(`${f}${ptr}: keyword "x-enumLabels" values must be 1-60 printable characters on one line`);
            }
            if (k === 'const' && typeof v === 'object' && v !== null)
                throw bad(`${f}${ptr}: keyword "const" value must be a string, number, boolean or null`);
            if (k === 'const' && Buffer.byteLength(JSON.stringify(v) ?? '') > MAX_CONST_BYTES)
                throw bad(`${f}${ptr}: const larger than ${MAX_CONST_BYTES} bytes`);
            if (k === 'dependentRequired' && isMap(v))
                for (const names of Object.values(v))
                    this.count(w, 1 + (Array.isArray(names) ? names.length : 0));
            if (k === '$ref') {
                const m = typeof v === 'string' ? REF_FORM.exec(v) : null;
                if (!m)
                    throw bad(`${f}${ptr}: ${typeof v === 'string' && !v.startsWith('#') ? 'remote ' : ''}$ref refused (${String(v).slice(0, 80)}): only #/$defs/<name> is allowed`);
                // Refs go from outside $defs into $defs only: a def that references anything could loop or fan out exponentially.
                if (inDef !== null)
                    throw bad(`${f}${ptr}: $defs entry "${inDef}" contains a $ref; references between definitions are not allowed`);
                if (w.refs.length >= MAX_REFS)
                    throw bad(`${f}${ptr}: more than ${MAX_REFS} $ref in one schema`);
                w.refs.push(m[1]);
            }
            else if (SUB_MAP.has(k) && isMap(v)) {
                for (const [name, child] of Object.entries(v)) {
                    if (k === '$defs') {
                        if (!DEF_NAME.test(name))
                            throw bad(`${f}${ptr}: $defs name "${name.slice(0, 40)}" must match [A-Za-z0-9_-]{1,64}`);
                        if (++this.defCount > MAX_DEFS)
                            throw bad(`${f}: contributed schemas have more than ${MAX_DEFS} $defs entries`);
                    }
                    sub(child, `${ptr}/${k}/${esc(name)}`, k === '$defs' ? name : inDef);
                }
            }
            else if (SUB_ARR.has(k) && Array.isArray(v))
                v.forEach((child, i) => sub(child, `${ptr}/${k}/${i}`));
            else if (SUB_ONE.has(k))
                sub(v, `${ptr}/${k}`);
        }
    }
    check(field, s) {
        const size = Buffer.byteLength(JSON.stringify(s));
        if (size > MAX_SCHEMA_BYTES)
            throw bad(`${field}: schema larger than 64 KiB`);
        this.bytes += size;
        if (this.bytes > MAX_SCHEMAS_TOTAL_BYTES)
            throw bad(`${field}: contributed schemas total more than 128 KiB`);
        const w = { field, nodes: 0, refs: [] };
        this.walk(w, s, '', 0, null);
        const defs = s.$defs;
        const defBytes = new Map();
        let weight = size;
        for (const r of w.refs) {
            if (!defs || !Object.hasOwn(defs, r))
                throw bad(`${field}: $ref to a missing $defs entry (${r})`);
            let b = defBytes.get(r);
            if (b === undefined)
                defBytes.set(r, b = Buffer.byteLength(JSON.stringify(defs[r])));
            weight += b;
        }
        this.expanded += weight;
        if (this.expanded > MAX_EXPANDED_BYTES)
            throw bad(`${field}: contributed schemas weigh more than ${MAX_EXPANDED_BYTES} bytes once every $ref counts as the definition it points at`);
        try {
            this.ajv.compile(s);
        }
        catch (e) {
            throw bad(`${field}: invalid schema (${e.message})`);
        }
    }
}
// A property's `default` must satisfy that property's own schema (the settings are served from it). Checked here, on the main
// thread, in ONE compile: the defaults form one object validated against the properties that have one (plus the root $defs).
// The schema already passed the size, depth and node caps, and a default is part of the same capped manifest.
function checkDefaults(settings) {
    const root = settings;
    if (!isMap(root.properties))
        return;
    const props = {};
    const data = {};
    for (const [k, sub] of Object.entries(root.properties)) {
        if (!isMap(sub) || !Object.hasOwn(sub, 'default'))
            continue;
        Object.defineProperty(props, k, { value: sub, enumerable: true, writable: true, configurable: true }); // a key named __proto__ stays a plain key
        Object.defineProperty(data, k, { value: sub.default, enumerable: true, writable: true, configurable: true });
    }
    if (Object.keys(props).length === 0)
        return;
    let fn;
    try {
        fn = newPluginAjv().compile({ type: 'object', properties: props, ...(root.$defs !== undefined ? { $defs: root.$defs } : {}) });
    }
    catch (e) {
        throw bad(`contributes.settings: invalid schema (${e.message})`);
    }
    if (fn(data))
        return;
    const at = (fn.errors?.[0]?.instancePath ?? '').split('/')[1] ?? '';
    const name = at.replace(/~1/g, '/').replace(/~0/g, '~').slice(0, 40);
    throw bad(`contributes.settings.properties.${name}.default: does not satisfy the property's schema`);
}
// Settings are flat (host UI rule): the root names the settable properties and nothing else. Cross-property rules,
// open objects and conditionals at the root are refused; the properties themselves may use the whole allowlist.
const SETTINGS_ROOT = new Set(['type', 'properties', 'title', 'description', '$defs', '$schema', '$comment']);
function checkSettingsRoot(settings) {
    const r = settings;
    for (const k of Object.keys(r))
        if (!SETTINGS_ROOT.has(k))
            throw bad(`contributes.settings: keyword "${k.slice(0, 40)}" is not allowed at the root of a settings schema (settings are flat: type, properties, title, description, $defs)`);
    if (r.type !== 'object' || !isMap(r.properties))
        throw bad('contributes.settings: the root must be {"type":"object","properties":{...}}');
    if (Object.hasOwn(r.properties, '__proto__'))
        throw bad('contributes.settings.properties: a property cannot be named __proto__');
}
function requireUnique(field, items) {
    const seen = new Set();
    for (const it of items ?? []) {
        if (!ITEM_ID.test(it.id))
            throw bad(`${field}: bad id (${it.id})`);
        if (seen.has(it.id))
            throw bad(`${field}: duplicate id (${it.id})`);
        seen.add(it.id);
    }
}
/** Ids the host uses for itself (its own ESI identity, R2); no plugin may take one. */
exports.HOST_ID_PREFIX = 'eve-cyno.host.';
// The manifest schema's `permissions` part on its own (no $ref in it), for parsePermissions.
const validatePermissions = new _2020_1.default({ strict: true }).compile(manifest_v1_json_1.default.properties.permissions);
/**
 * A manifest `permissions` object, validated and normalised exactly as parseManifest does it, so a marketplace listing's permissions
 * (market/indexformat.ts) compare with a manifest's: network origins canonical (lower case, no default port) and deduplicated, no
 * shared host; `esi` and game logs only with characters (`chatlogs` alone needs none: it reads the channels the user picks, not a character's data); registered ESI scopes only; the default storage quota filled in;
 * `optional` (API 1.17.0) by the same rules, with no item that the required part holds, and left out when it holds no item. The engines rule of `optional`
 * (optionalEnginesOk) is the caller's: parseManifest and the listing parser check it. Throws coded `bad_manifest` or `shared_host`.
 */
function parsePermissions(raw) {
    if (!validatePermissions(raw)) {
        throw bad((validatePermissions.errors ?? []).slice(0, 3).map(e => describe({ ...e, instancePath: `/permissions${e.instancePath}` })).join('; '));
    }
    const permissions = { ...raw };
    if (permissions.network) {
        const origins = permissions.network.map(canonicalOrigin);
        for (const o of origins) {
            const host = new URL(o).hostname;
            if (exports.SHARED_HOSTS.some(s => host === s || host.endsWith('.' + s)))
                throw (0, errors_1.coded)('shared_host', `permissions.network: shared host refused (${o})`);
        }
        permissions.network = [...new Set(origins)];
    }
    // `esi` and game logs read a character's data: without any character they would be requests that can never be served. `chatlogs` is exempt: `chat` reads what the user picked.
    if ((permissions.characters ?? 'none') === 'none') {
        if ((permissions.esi?.length ?? 0) > 0)
            throw bad("permissions.esi: needs permissions.characters to be 'selected' or 'all'");
        if ((permissions.logs ?? []).some(k => k !== 'chatlogs'))
            throw bad("permissions.logs: needs permissions.characters to be 'selected' or 'all'");
    }
    // A plugin may ask only for scopes the app registration holds (generated list; see cynod/tools/genroutes).
    for (const scope of permissions.esi ?? []) {
        if (!REGISTERED_ESI_SCOPES.has(scope))
            throw bad(`permissions.esi: unknown or unregistered ESI scope (${scope.slice(0, 100)})`);
    }
    permissions.storage = { quotaMB: permissions.storage?.quotaMB ?? exports.DEFAULT_STORAGE_MB };
    if (permissions.optional !== undefined) {
        const optional = parseOptional(permissions.optional, permissions);
        if (optional === null)
            delete permissions.optional;
        else
            permissions.optional = optional;
    }
    return permissions;
}
// `permissions.optional` (API 1.17.0) after the schema: each kind by the rules of its required list (origins canonical, no shared host; registered scopes only, and
// only with characters), every list without repeats, and no item that the required part (`req`, already normalised) holds. null when no item is left.
function parseOptional(o, req) {
    const out = {};
    if ((o.esi?.length ?? 0) > 0) {
        if ((req.characters ?? 'none') === 'none')
            throw bad("permissions.optional.esi: needs permissions.characters to be 'selected' or 'all'");
        const esi = [...new Set(o.esi)];
        for (const scope of esi) {
            if (!REGISTERED_ESI_SCOPES.has(scope))
                throw bad(`permissions.optional.esi: unknown or unregistered ESI scope (${scope.slice(0, 100)})`);
            if (req.esi?.includes(scope))
                throw bad(`permissions.optional.esi: also in permissions.esi (${scope.slice(0, 100)})`);
        }
        out.esi = esi;
    }
    if ((o.network?.length ?? 0) > 0) {
        const origins = [...new Set(o.network.map(canonicalOrigin))];
        for (const origin of origins) {
            const host = new URL(origin).hostname;
            if (exports.SHARED_HOSTS.some(s => host === s || host.endsWith('.' + s)))
                throw (0, errors_1.coded)('shared_host', `permissions.optional.network: shared host refused (${origin})`);
            if (req.network?.includes(origin))
                throw bad(`permissions.optional.network: also in permissions.network (${origin})`);
        }
        out.network = origins;
    }
    if (o.clipboard?.includes('read')) {
        if (req.clipboard?.includes('read'))
            throw bad('permissions.optional.clipboard: also in permissions.clipboard');
        out.clipboard = ['read'];
    }
    if (o.notifications === true) {
        if (req.notifications === true)
            throw bad('permissions.optional.notifications: also in permissions.notifications');
        out.notifications = true;
    }
    return Object.keys(out).length > 0 ? out : null;
}
// Any failure without a code (a RangeError from a very deep structure, say) is still a refused manifest.
function parseManifest(raw) {
    try {
        return parseInner(raw);
    }
    catch (e) {
        if (typeof e.code === 'string')
            throw e;
        throw bad(`manifest: ${e.message}`);
    }
}
function parseInner(raw) {
    if (Buffer.byteLength(JSON.stringify(raw) ?? '') > exports.MAX_MANIFEST_BYTES)
        throw bad(`plugin.json: larger than ${exports.MAX_MANIFEST_BYTES} bytes`);
    if (!validateManifest(raw))
        throw bad((validateManifest.errors ?? []).slice(0, 3).map(describe).join('; '));
    const m = raw;
    if (m.suspendUnderPressure === true && m.background !== true)
        throw bad('suspendUnderPressure: needs background: true');
    if (m.id.startsWith(exports.HOST_ID_PREFIX))
        throw bad(`id: the prefix ${exports.HOST_ID_PREFIX} is reserved for the host`);
    const name = displayText('name', m.name);
    const author = m.author === undefined ? undefined : displayText('author', m.author);
    if (!exports.SEMVER.test(m.version))
        throw bad(`version: not a semver version (${m.version})`);
    checkMain(m.main);
    const description = m.description === undefined ? undefined : displayText('description', m.description, 200);
    const events = m.activationEvents ?? ['onStartup'];
    for (const ev of events) {
        const [startup, cmd, svc] = exports.ACTIVATION;
        const ok = ev === startup ||
            (ev.startsWith(cmd) && ITEM_ID.test(ev.slice(cmd.length))) ||
            (ev.startsWith(svc) && isInterfaceId(ev.slice(svc.length)));
        if (!ok)
            throw bad(`activationEvents: unknown or malformed event (${ev})`);
    }
    const permissions = parsePermissions(m.permissions ?? {});
    if (permissions.data !== undefined) {
        const allowed = dataallow_1.DATA_ALLOWLIST.get(m.id) ?? [];
        if (!permissions.data.every(p => allowed.includes(p)))
            throw bad('permissions.data is reserved for built-in plugins');
    }
    const c = m.contributes ?? {};
    for (const f of ['commands', 'statusItems', 'views', 'windows', 'overlays', 'themes'])
        requireUnique(`contributes.${f}`, c[f]);
    (c.overlays ?? []).forEach((o, i) => {
        checkMain(o.entry, `contributes.overlays[${i}].entry`);
        if (!o.entry.endsWith('.html'))
            throw bad(`contributes.overlays[${i}].entry: must end in .html`);
    });
    // Titles reach the command palette and the status bar: the same display rule as the plugin name.
    const commands = c.commands?.map((x, i) => ({ ...x, title: displayText(`contributes.commands[${i}].title`, x.title) }));
    const statusItems = c.statusItems?.map((x, i) => (x.title === undefined ? x : { ...x, title: displayText(`contributes.statusItems[${i}].title`, x.title) }));
    let tile = c.tile;
    if (tile?.action) {
        const a = tile.action;
        if (!(c.commands ?? []).some(x => x.id === a.command))
            throw bad(`contributes.tile.action.command: not a declared command (${a.command.slice(0, 64)})`);
        tile = { ...tile, action: { command: a.command, label: displayText('contributes.tile.action.label', a.label, 20) } };
    }
    const budget = new SchemaBudget();
    if (c.settings) {
        checkSettingsRoot(c.settings);
        budget.check('contributes.settings', c.settings);
        checkDefaults(c.settings);
    }
    const svcIds = new Set();
    (c.services ?? []).forEach((s, i) => {
        if (!exports.SEMVER.test(s.version))
            throw bad(`contributes.services[${i}].version: not a semver version (${s.version})`);
        if (svcIds.has(s.id))
            throw bad(`contributes.services[${i}].id: duplicate interface (${s.id})`);
        svcIds.add(s.id);
        for (const [name, meth] of Object.entries(s.methods)) {
            budget.check(`contributes.services[${i}].methods.${name}.params`, meth.params);
            budget.check(`contributes.services[${i}].methods.${name}.result`, meth.result);
        }
    });
    // Last, so that a structurally broken manifest reports bad_manifest rather than a misleading version error.
    const range = m.engines['eve-cyno-api'];
    if (semver.validRange(range) === null)
        throw bad(`engines.eve-cyno-api: not a semver range (${range})`);
    // API 1.17.0: the key itself is what an older host refuses, so a manifest that writes it (even with no item) names a range no older host satisfies.
    if (Object.hasOwn(m.permissions ?? {}, 'optional') && !optionalEnginesOk(range)) {
        throw bad(`permissions.optional needs engines.eve-cyno-api with a lowest version of at least ${exports.OPTIONAL_API}, such as ^${exports.OPTIONAL_API.split('.').slice(0, 2).join('.')} (${range})`);
    }
    if (!semver.satisfies(exports.HOST_API.version, range))
        throw (0, errors_1.coded)('incompatible_api', `engines.eve-cyno-api: ${range} does not include host API ${exports.HOST_API.version}`);
    return {
        id: m.id, name, ...(author !== undefined ? { author } : {}), version: m.version, engines: { 'eve-cyno-api': range },
        ...(m.esiCompatibilityDate ? { esiCompatibilityDate: m.esiCompatibilityDate } : {}),
        main: m.main, activationEvents: [...events], ...(m.background ? { background: true } : {}), ...(m.suspendUnderPressure ? { suspendUnderPressure: true } : {}),
        ...(m.color !== undefined ? { color: m.color.toLowerCase() } : {}), ...(m.icon !== undefined ? { icon: m.icon } : {}), ...(description !== undefined ? { description } : {}),
        permissions, contributes: { ...c, ...(commands ? { commands } : {}), ...(statusItems ? { statusItems } : {}), ...(tile ? { tile } : {}) },
    };
}
function sameRegularFile(seen, opened) {
    return seen.isFile() && opened.isFile() && seen.ino !== 0n && seen.ino === opened.ino &&
        seen.birthtimeNs === opened.birthtimeNs && seen.size === opened.size &&
        (seen.dev === 0n || opened.dev === 0n || seen.dev === opened.dev);
}
// Reads a small untrusted file (plugin.json, theme.json, a licence) with the size cap enforced on the open file (no stat/read
// race): at most `max` + 1 bytes are read. Symlinks are not followed and only regular files are read (a FIFO would block the
// host); no fs error text (which carries paths) reaches the message, which starts with `label`. `fail` builds the error
// (default: a bad_manifest one).
function readRegularFile(file, label, max, fail = bad) {
    const notFile = () => fail(`${label}: not a readable regular file`);
    const tooBig = () => fail(`${label}: larger than ${max} bytes`);
    const own = new WeakSet();
    const mark = (e) => { own.add(e); return e; };
    const C = fs.constants;
    // Windows has no O_NOFOLLOW: lstat refuses a link or a non-file up front, and after the open the file must still be
    // the one lstat saw (sameRegularFile), so a name swapped for a link between the two calls is refused too.
    let seen;
    if (C.O_NOFOLLOW === undefined) {
        try {
            seen = fs.lstatSync(file, { bigint: true });
        }
        catch {
            throw notFile();
        }
        if (!seen.isFile())
            throw notFile();
    }
    let fd;
    try {
        fd = fs.openSync(file, C.O_RDONLY | (C.O_NOFOLLOW ?? 0) | (C.O_NONBLOCK ?? 0));
    }
    catch {
        throw notFile();
    }
    try {
        const st = fs.fstatSync(fd, { bigint: true });
        if (!st.isFile() || (seen && !sameRegularFile(seen, st)))
            throw mark(notFile());
        if (st.size > BigInt(max))
            throw mark(tooBig());
        const buf = Buffer.alloc(max + 1);
        let n = 0;
        for (;;) {
            const r = fs.readSync(fd, buf, n, buf.length - n, null);
            if (r === 0)
                break;
            n += r;
            if (n > max)
                throw mark(tooBig());
        }
        return buf.subarray(0, n);
    }
    catch (e) {
        if (typeof e === 'object' && e !== null && own.has(e))
            throw e;
        throw notFile();
    }
    finally {
        fs.closeSync(fd);
    }
}
// plugin.json as text (the loader's reader).
function readManifestFile(file) {
    return readRegularFile(file, 'plugin.json', exports.MAX_MANIFEST_BYTES).toString('utf8');
}
// JSON.parse errors quote the input; nothing of it may reach a log line.
function parseManifestJson(text) {
    try {
        return JSON.parse(text);
    }
    catch {
        throw bad('plugin.json: not valid JSON');
    }
}
