"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ScriptedPrompter = exports.DenyPrompter = exports.GrantStore = exports.isNotSaved = exports.optionalRequested = exports.emptyGranted = exports.isRevokeKind = exports.REVOKE_KINDS = exports.GAME_EVENT_FAMILIES = void 0;
exports.declaredKinds = declaredKinds;
exports.stripKind = stripKind;
exports.requested = requested;
exports.firstRunGrants = firstRunGrants;
exports.itemsIn = itemsIn;
exports.withItems = withItems;
exports.withoutItems = withoutItems;
exports.delta = delta;
exports.isEmpty = isEmpty;
exports.cleanPicks = cleanPicks;
exports.withProviders = withProviders;
exports.narrowedKeep = narrowedKeep;
exports.reviewNeeded = reviewNeeded;
exports.ensureGrant = ensureGrant;
exports.grantPending = grantPending;
exports.revokeGrant = revokeGrant;
exports.forgetGrant = forgetGrant;
exports.getChatChannels = getChatChannels;
exports.setChatChannels = setChatChannels;
exports.watchChatChannels = watchChatChannels;
exports.allowGrant = allowGrant;
exports.allowOptional = allowOptional;
exports.declineOptional = declineOptional;
// Persisted plugin permission grants and escalation. Pure (no Electron). A plugin runs with what the user granted, never
// with what its manifest asks for; an update that asks for more is an escalation and needs a new consent.
const buildinfo_1 = require("./buildinfo");
const atomicfile_1 = require("./atomicfile");
const manifest_1 = require("./manifest");
const reset_1 = require("./reset");
const windowsview_1 = require("./windowsview");
const errors_1 = require("./errors");
const optional_1 = require("./optional");
const RANK = { none: 0, selected: 1, all: 2 };
const FLAG_KEYS = ['overlays', 'hotkeys', 'windowThumbnails', 'windows', 'notifications', 'ai', 'account', 'files', 'fit'];
// Flags added after a record could already be on disk (API 1.1.0: `files`; API 1.7.0: `windows`; API 1.14.0: `fit`): a record without the key was written before it and granted none.
const LATER_FLAGS = new Set(['files', 'windows', 'fit']);
/** The game-event families of API 1.2.0, in the order the consent text and the Privacy row list them. */
exports.GAME_EVENT_FAMILIES = ['combat', 'ewar', 'mining', 'notice'];
exports.REVOKE_KINDS = ['characters', 'esi', 'network', 'ai', 'gamelogs', 'chatlogs', 'gameEvents', 'background', 'services'];
const isRevokeKind = (v) => typeof v === 'string' && exports.REVOKE_KINDS.includes(v);
exports.isRevokeKind = isRevokeKind;
/**
 * The revocable kinds the manifest declares (a row of the Privacy page exists only for these). HT-M1 (owner decision 2026-11-06): `chatlogs` is declared only when
 * `requested(m, builtIn)` asks for it, so a non-built-in plugin that can send data out has no Chat logs row (it never gets `chat`).
 */
function declaredKinds(m, builtIn = false) {
    const p = m.permissions;
    const out = [];
    if (p.characters !== undefined && p.characters !== 'none')
        out.push('characters');
    if ((p.esi?.length ?? 0) > 0)
        out.push('esi');
    if ((p.network?.length ?? 0) > 0)
        out.push('network');
    if (p.ai)
        out.push('ai');
    if (p.logs?.includes('gamelogs'))
        out.push('gamelogs');
    if (requested(m, builtIn).logs.includes('chatlogs'))
        out.push('chatlogs');
    if ((p.gameEvents?.length ?? 0) > 0)
        out.push('gameEvents');
    if (m.background === true)
        out.push('background');
    if (Object.keys(p.services ?? {}).length > 0)
        out.push('services'); // Fit manager L7: a consumed service; Privacy draws its row while the grant holds one with a provider (Revoke) or while the kind is revoked (Allow; privacy.ts)
    return out;
}
const copyGranted = (g) => ({
    ...g, selected: [...g.selected], esi: [...g.esi], logs: [...g.logs], clipboard: [...g.clipboard], network: [...g.network], gameEvents: [...g.gameEvents], flags: { ...g.flags },
    services: Object.fromEntries(Object.entries(g.services).map(([k, v]) => [k, { ...v }])),
});
/**
 * `g` without the part `kind` names (`background` is not a field of a grant). Rule R-K (optional permissions, plan 2026-11-09, section 3.6): a kind is its
 * required items only, so the items of `optional` (the manifest's optional set) stay; they have their own switches.
 */
function stripKind(g, kind, optional = {}) {
    const o = copyGranted(g);
    switch (kind) {
        case 'characters':
            o.characters = 'none';
            o.selected = [];
            break;
        case 'esi':
            o.esi = o.esi.filter(x => optional.esi?.includes(x) === true);
            break;
        case 'network':
            o.network = o.network.filter(x => optional.network?.includes(x) === true);
            break;
        case 'ai':
            o.flags.ai = false;
            break;
        case 'gamelogs':
            o.logs = o.logs.filter(l => l !== 'gamelogs');
            break;
        case 'chatlogs':
            o.logs = o.logs.filter(l => l !== 'chatlogs');
            break;
        case 'gameEvents':
            o.gameEvents = [];
            break;
        case 'background': break;
        case 'services':
            o.services = {};
            break;
    }
    return o;
}
/** `base` with the parts `kinds` name taken from `from`. R-K: the items of `optional` are neither taken from `from` nor dropped from `base`. */
function takeKinds(base, from, kinds, optional = {}) {
    const o = copyGranted(base);
    const opt = (list, x) => list?.includes(x) === true;
    for (const k of kinds) {
        switch (k) {
            case 'characters':
                o.characters = from.characters;
                o.selected = [...from.selected];
                break;
            case 'esi':
                o.esi = [...from.esi.filter(x => !opt(optional.esi, x)), ...o.esi.filter(x => opt(optional.esi, x))];
                break;
            case 'network':
                o.network = [...from.network.filter(x => !opt(optional.network, x)), ...o.network.filter(x => opt(optional.network, x))];
                break;
            case 'ai':
                o.flags.ai = from.flags.ai;
                break;
            case 'gamelogs':
                o.logs = [...o.logs.filter(l => l !== 'gamelogs'), ...from.logs.filter(l => l === 'gamelogs')];
                break;
            case 'chatlogs':
                o.logs = [...o.logs.filter(l => l !== 'chatlogs'), ...from.logs.filter(l => l === 'chatlogs')];
                break;
            case 'gameEvents':
                o.gameEvents = [...from.gameEvents];
                break;
            case 'background': break;
            case 'services':
                o.services = Object.fromEntries(Object.entries(from.services).map(([k, v]) => [k, { ...v }]));
                break;
        }
    }
    return o;
}
const stripKinds = (g, kinds, optional = {}) => kinds.reduce((acc, k) => stripKind(acc, k, optional), g);
/**
 * Whether `g` holds anything of `kind`, an optional item included (`background` is no field of a grant: never). `services`: an entry with a provider only (coordinator
 * ruling 2026-11-11): one granted while no provider was installed (provider null) gives the plugin nothing (the broker offers it no interface), so a grant of only such
 * entries holds no service and its provider appearing is a new kind for option e.
 */
function holdsKind(g, kind) {
    switch (kind) {
        case 'characters': return g.characters !== 'none';
        case 'esi': return g.esi.length > 0;
        case 'network': return g.network.length > 0;
        case 'ai': return g.flags.ai;
        case 'gamelogs': return g.logs.includes('gamelogs');
        case 'chatlogs': return g.logs.includes('chatlogs');
        case 'gameEvents': return g.gameEvents.length > 0;
        case 'background': return false;
        case 'services': return Object.values(g.services).some(s => s.provider !== null);
    }
}
/** Whether the delta `d` asks for anything of `kind`: holdsKind, except that every services entry counts, one with no provider too (a new interface whose provider is absent). */
const asksKind = (d, kind) => kind === 'services' ? Object.keys(d.services).length > 0 : holdsKind(d, kind);
/**
 * The kinds a Deny in a bundled plugin's update can leave revoked (option e). Not `gameEvents` and `chatlogs`: a revoked entry of either counts as "could see names" for
 * the A5 reset (reset.ts `couldSeeNames`), which a kind the plugin never held must not do; not `background`, which is pre-granted for a bundled plugin. `services`
 * (Fit manager L7, coordinator ruling 2026-11-11): a plugin that gains a consumed service keeps running without it, so the Fit manager and AI Chat stay on their AI-off path;
 * by the same ruling also when the provider of a service granted with none appears (holdsKind: that grant holds no service), so the Fit manager that first ran without AI Chat
 * is not turned off by a Deny once AI Chat is installed.
 */
const DENY_KEEPS = ['characters', 'esi', 'network', 'ai', 'gamelogs', 'services'];
const ordered = (kinds) => { const s = new Set(kinds); return exports.REVOKE_KINDS.filter(k => s.has(k)); };
const emptyGranted = () => ({
    characters: 'none', selected: [], esi: [], logs: [], clipboard: [], network: [], gameEvents: [],
    flags: { overlays: false, hotkeys: false, windowThumbnails: false, windows: false, notifications: false, ai: false, account: false, files: false, fit: false },
    storageMB: 0, databaseMB: 0, services: {},
});
exports.emptyGranted = emptyGranted;
// What the manifest asks for. Service providers are resolved by ensureGrant; here they are unknown.
// `builtIn` (owner call 2026-11-04, design note O1): `permissions.database` counts only for a built-in plugin, because the database process is not sandboxed. For any other plugin the
// field is ignored here, so it gets no consent line and no grant for it (namespaces.ts keeps `db` from it too). Default false.
// HT-M1 (owner decision 2026-11-06): `chatlogs` is not requested by a non-built-in plugin that can send data out (`canSendOut`, the rule namespaces.ts reads): it never gets `chat`,
// so the prompt must not ask for it and the grant must not store it. "Can send data out" reads the required part plus every optional item, declined or not
// (plan 2026-11-09, section 3.7): an optional origin the user switched off must never make a plugin look sealed.
// The result is the required part only (the first-run sign-in scopes, onboarding and the Marketplace lines read it); `optionalRequested` holds the rest.
function requested(m, builtIn = false) {
    const p = m.permissions;
    const services = {};
    for (const [iface, range] of Object.entries(p.services ?? {}))
        services[iface] = { range, provider: null };
    const g = {
        characters: p.characters ?? 'none', selected: [], esi: [...(p.esi ?? [])], logs: [...(p.logs ?? [])],
        clipboard: [...(p.clipboard ?? [])], network: [...(p.network ?? [])], gameEvents: [...(p.gameEvents ?? [])],
        flags: {
            overlays: !!p.overlays, hotkeys: !!p.hotkeys, windowThumbnails: !!p.windowThumbnails, windows: !!p.windows,
            notifications: !!p.notifications, ai: !!p.ai, account: !!p.account, files: !!p.files, fit: !!p.fit,
        },
        storageMB: p.storage?.quotaMB ?? 0, databaseMB: builtIn ? p.database?.quotaMB ?? 0 : 0, services,
    };
    const out = !builtIn && g.logs.includes('chatlogs') && (0, windowsview_1.canSendOut)(withItems(g, (0, optional_1.optionalOf)(m)), (m.contributes?.services?.length ?? 0) > 0);
    return out ? { ...g, logs: g.logs.filter(l => l !== 'chatlogs') } : g;
}
/**
 * What the first-run wizard's sign-in plans for (main.ts `planned`, read through vaultservice `plannedScopes`): the required part (`requested`) of each plugin in `ids`
 * that `eligible` keeps (registered, not switched off, not revoked, no grant yet). Never an optional item (optional permissions S8): one the user allows later reaches
 * Re-authorise through the grant. A plugin whose manifest is gone adds nothing.
 */
function firstRunGrants(ids, o) {
    return ids.filter(id => o.eligible(id)).flatMap(id => { const m = o.manifestOf(id); return m ? [requested(m, o.builtIn(id))] : []; });
}
// The default quota (DEFAULT_STORAGE_MB, what a manifest without `storage` gets) needs no consent; only a quota above it does.
const minus = (req, cur) => req.filter(x => !cur.includes(x));
// Optional permissions (plan 2026-11-09, section 3.1): the optional items of a manifest as a grant, and the items of a set a grant holds, gets or loses.
/** A grant with only the optional items of `m` (`optionalOf`: none of its required ones). `requested` stays the required part. */
const optionalRequested = (m) => withItems((0, exports.emptyGranted)(), (0, optional_1.optionalOf)(m));
exports.optionalRequested = optionalRequested;
/** The items of `s` that `g` holds. */
function itemsIn(g, s) {
    const c = (0, optional_1.cleanOptional)(s);
    return (0, optional_1.cleanOptional)({
        esi: (c.esi ?? []).filter(x => g.esi.includes(x)), network: (c.network ?? []).filter(x => g.network.includes(x)),
        clipboard: (c.clipboard ?? []).filter(x => g.clipboard.includes(x)), notifications: c.notifications === true && g.flags.notifications,
    });
}
/** `g` plus the items of `s` (a copy; nothing else changes). */
function withItems(g, s) {
    const c = (0, optional_1.cleanOptional)(s), o = copyGranted(g);
    o.esi.push(...minus(c.esi ?? [], o.esi));
    o.network.push(...minus(c.network ?? [], o.network));
    o.clipboard.push(...minus(c.clipboard ?? [], o.clipboard));
    if (c.notifications)
        o.flags.notifications = true;
    return o;
}
/** `g` without the items of `s` (a copy; nothing else changes). */
function withoutItems(g, s) {
    const c = (0, optional_1.cleanOptional)(s), o = copyGranted(g);
    o.esi = minus(o.esi, c.esi ?? []);
    o.network = minus(o.network, c.network ?? []);
    o.clipboard = minus(o.clipboard, c.clipboard ?? []);
    if (c.notifications)
        o.flags.notifications = false;
    return o;
}
// Only what req asks for beyond current. An empty result means req is covered.
function delta(current, req) {
    const cur = current ?? (0, exports.emptyGranted)();
    const d = (0, exports.emptyGranted)();
    if (RANK[req.characters] > RANK[cur.characters])
        d.characters = req.characters;
    d.esi = minus(req.esi, cur.esi);
    d.logs = minus(req.logs, cur.logs);
    d.clipboard = minus(req.clipboard, cur.clipboard);
    d.network = minus(req.network, cur.network);
    d.gameEvents = minus(req.gameEvents, cur.gameEvents);
    for (const k of FLAG_KEYS)
        d.flags[k] = req.flags[k] && !cur.flags[k];
    d.storageMB = req.storageMB > Math.max(cur.storageMB, manifest_1.DEFAULT_STORAGE_MB) ? req.storageMB : 0;
    d.databaseMB = req.databaseMB > cur.databaseMB ? req.databaseMB : 0; // the first request and every raise ask; a lower one does not
    for (const [iface, s] of Object.entries(req.services)) {
        const c = Object.hasOwn(cur.services, iface) ? cur.services[iface] : undefined;
        // New interface, another range (ranges are ^N: a different one is a major change) or another non-null provider.
        // A provider that disappeared (null) asks for nothing.
        if (!c || c.range !== s.range || (s.provider !== null && c.provider !== s.provider))
            d.services[iface] = { ...s };
    }
    return d;
}
function isEmpty(d) {
    return d.characters === 'none' && d.esi.length === 0 && d.logs.length === 0 && d.clipboard.length === 0 &&
        d.network.length === 0 && d.gameEvents.length === 0 && FLAG_KEYS.every(k => !d.flags[k]) && d.storageMB === 0 && d.databaseMB === 0 && Object.keys(d.services).length === 0;
}
const isStrs = (v) => Array.isArray(v) && v.every(x => typeof x === 'string');
const CHAT_PICKS_MAX = 32;
const CHAT_NAME_MAX = 100;
/** The list as stored, or null when it breaks the bound: at most 32, each 1 to 100 characters, no duplicates. */
function cleanPicks(v) {
    if (!isStrs(v) || v.length > CHAT_PICKS_MAX || new Set(v).size !== v.length)
        return null;
    return v.every(s => s !== '' && [...s].length <= CHAT_NAME_MAX) ? [...v] : null;
}
const isObj = (v) => typeof v === 'object' && v !== null && !Array.isArray(v);
const codeOf = (e) => e?.code ?? 'error';
// The refusal of a grant change that must reach the disk and could not (a read-only store or a failed write): nothing was changed.
const unsaved = new WeakSet();
/** True for the `unavailable` refusal of a change the permissions file could not keep (the registry tells the user). */
const isNotSaved = (e) => typeof e === 'object' && e !== null && unsaved.has(e);
exports.isNotSaved = isNotSaved;
function notSaved() {
    const e = (0, errors_1.coded)('unavailable', 'the permissions file could not be saved');
    unsaved.add(e);
    return e;
}
// Rebuilds a Granted from picked, type-checked fields only (unknown keys at every level are dropped); null if any field is invalid.
function cleanGranted(g) {
    if (!isObj(g))
        return null;
    if (g.characters !== 'none' && g.characters !== 'selected' && g.characters !== 'all')
        return null;
    if (!Array.isArray(g.selected) || !g.selected.every(n => Number.isSafeInteger(n)))
        return null;
    if (!isStrs(g.esi) || !isStrs(g.logs) || !isStrs(g.clipboard) || !isStrs(g.network))
        return null;
    // A record without the key was written before API 1.2.0: it granted none and is kept. Present, it must be a list of strings.
    if (Object.hasOwn(g, 'gameEvents') && !isStrs(g.gameEvents))
        return null;
    if (!isObj(g.flags))
        return null;
    const flags = (0, exports.emptyGranted)().flags;
    for (const k of FLAG_KEYS) {
        const v = LATER_FLAGS.has(k) && !Object.hasOwn(g.flags, k) ? false : g.flags[k];
        if (typeof v !== 'boolean')
            return null;
        flags[k] = v;
    }
    if (typeof g.storageMB !== 'number' || !Number.isFinite(g.storageMB) || g.storageMB < 0)
        return null;
    // databaseMB came with 1.12.0: a record without the key granted none; present, it must be a number of at least 0.
    if (Object.hasOwn(g, 'databaseMB') && (typeof g.databaseMB !== 'number' || !Number.isFinite(g.databaseMB) || g.databaseMB < 0))
        return null;
    if (!isObj(g.services))
        return null;
    const services = {};
    for (const [iface, s] of Object.entries(g.services)) {
        if (!manifest_1.INTERFACE_ID.test(iface) || iface.length > 64)
            continue; // also skips __proto__
        if (!isObj(s) || typeof s.range !== 'string' || (s.provider !== null && typeof s.provider !== 'string'))
            return null;
        services[iface] = { range: s.range, provider: s.provider };
    }
    return {
        characters: g.characters, selected: [...g.selected], esi: [...g.esi], logs: [...g.logs],
        clipboard: [...g.clipboard], network: [...g.network], gameEvents: isStrs(g.gameEvents) ? [...new Set(g.gameEvents.filter(f => exports.GAME_EVENT_FAMILIES.includes(f)))] : [], flags, storageMB: g.storageMB, databaseMB: typeof g.databaseMB === 'number' ? g.databaseMB : 0, services,
    };
}
function cleanRecord(id, r) {
    if (!isObj(r) || r.pluginId !== id || typeof r.version !== 'string' || typeof r.decidedAt !== 'string')
        return null;
    if (r.deniedVersion !== undefined && typeof r.deniedVersion !== 'string')
        return null;
    if ((r.provides !== undefined && typeof r.provides !== 'boolean') || (r.narrowed !== undefined && typeof r.narrowed !== 'boolean') || (r.background !== undefined && typeof r.background !== 'boolean'))
        return null;
    const granted = cleanGranted(r.granted);
    if (!granted)
        return null;
    if (r.revoked !== undefined && !Array.isArray(r.revoked))
        return null;
    const revoked = ordered((Array.isArray(r.revoked) ? r.revoked : []).filter(exports.isRevokeKind)); // an unknown kind (a newer file) is dropped
    const chatChannels = cleanPicks(r.chatChannels); // a list out of bounds is dropped, the record stays
    return withDeclined({
        pluginId: id, version: r.version, granted, ...(r.deniedVersion !== undefined ? { deniedVersion: r.deniedVersion } : {}), decidedAt: r.decidedAt,
        ...(typeof r.provides === 'boolean' ? { provides: r.provides } : {}), ...(typeof r.background === 'boolean' ? { background: r.background } : {}), ...(r.narrowed === true ? { narrowed: true } : {}),
        ...(revoked.length > 0 ? { revoked } : {}), ...(chatChannels !== null && chatChannels.length > 0 ? { chatChannels } : {}), ...(r.sawNames === true ? { sawNames: true } : {}),
    }, r.declined);
}
/**
 * Optional permissions (plan 2026-11-09, section 3.3): `rec` with `declined` set from `given`, cleaned (a malformed field or item is dropped and the record stays:
 * it declined nothing then, so the next decision asks again, never wider) and only when not empty. Invariant: `granted` never holds a declined item; an item
 * found in both lists leaves `granted` (fail closed, S10).
 */
function withDeclined(rec, given) {
    const { declined: _old, ...rest } = rec;
    const declined = (0, optional_1.cleanOptional)(given);
    return (0, optional_1.isEmptySet)(declined) ? rest : { ...rest, granted: withoutItems(rest.granted, declined), declined };
}
// Deep equality of two records, whatever the key order of their objects.
const canon = (v) => Array.isArray(v) ? v.map(canon)
    : isObj(v) ? Object.fromEntries(Object.keys(v).sort().map(k => [k, canon(v[k])])) : v;
const sameRecord = (a, b) => a !== undefined && JSON.stringify(canon(a)) === JSON.stringify(canon(b));
// A missing, corrupt or half-written file is an empty store: nothing granted, never "allow all".
class GrantStore {
    file;
    io;
    recs = new Map();
    // Set when the file was busy (Windows) for the whole retry: it is left alone and never overwritten this session.
    readOnly = false;
    fns = [];
    /**
     * Fires with the plugin id, the kind and the record as it was before (undefined for a new one) after a record changed in memory or an existing
     * record was revoked, saved or not (a decision stands in memory for the run); never for an equal record or an absent revoke, and never for a
     * `setSaved` that was refused.
     */
    onChange(fn) { this.fns.push(fn); }
    changed(id, kind, prev) { for (const f of this.fns)
        try {
            f(id, kind, prev);
        }
        catch { /* a listener must not stop the store */ } }
    // Changes made while read-only (or not yet written), replayed on top of the file once it can be read.
    pendingSets = new Map();
    pendingRevokes = new Set();
    write;
    constructor(file, io) {
        this.file = file;
        this.io = io;
        this.write = io?.write ?? atomicfile_1.writeFileAtomic; // the seam lets a test count the writes
    }
    load() {
        this.recs = new Map();
        this.readOnly = false;
        this.pendingSets.clear();
        this.pendingRevokes.clear();
        const res = (0, atomicfile_1.readJsonDetailed)(this.file, v => isObj(v) && v.version === 1 && isObj(v.plugins), this.io);
        if (res.status === 'busy') {
            this.readOnly = true;
            console.warn('grants: file busy, decisions stay in memory this session');
            return;
        }
        const raw = res.status === 'ok' ? res.value : undefined;
        if (!isObj(raw) || !isObj(raw.plugins))
            return;
        for (const [id, r] of Object.entries(raw.plugins)) {
            const rec = cleanRecord(id, r);
            if (rec)
                this.recs.set(id, rec);
        }
    }
    get(id) { return this.recs.get(id); }
    all() { return [...this.recs.values()]; }
    // `sawNames` (A5): the plugin could see names, and no way out has opened since. It is stored only where the grant no longer says so: after an update that
    // dropped the kind. A grant that still reads names writes nothing new, so a record from an older version starts with no write. A record with a way out does
    // not carry it: needsReset fired for that change, and the wipe ran before this write.
    // Every write holds the `declined` invariant too (withDeclined), so memory never keeps what the next load would drop.
    marked(given) {
        const rec = withDeclined(given, given.declined);
        const { sawNames: _given, ...rest } = rec;
        const provides = rec.provides ?? false;
        const prev = this.recs.get(rec.pluginId);
        const sawBefore = prev !== undefined && (prev.sawNames === true || (0, reset_1.couldSeeNames)(prev.granted, prev.provides ?? false, prev.revoked));
        return sawBefore && !(0, reset_1.couldSeeNames)(rec.granted, provides, rec.revoked) && !(0, windowsview_1.canSendOut)(rec.granted, provides) ? { ...rest, sawNames: true } : rest;
    }
    // A failed save (disk full, locked file) is logged and not fatal: the decision stands in memory for this run.
    // A record equal to the stored one writes nothing (every activation records its grant; fsync only for a real change), unless an
    // earlier change is still waiting for the disk.
    set(given) {
        const rec = this.marked(given);
        const prev = this.recs.get(rec.pluginId);
        const equal = sameRecord(prev, rec);
        const same = !this.readOnly && this.pendingSets.size === 0 && this.pendingRevokes.size === 0 && equal;
        this.recs.set(rec.pluginId, rec);
        if (same)
            return;
        this.pendingRevokes.delete(rec.pluginId);
        this.pendingSets.set(rec.pluginId, rec);
        this.save();
        if (!equal)
            this.changed(rec.pluginId, 'set', prev);
    }
    /**
     * `set` for a change that must not stand in memory only (I1: a revoke kept in memory would come back at the next start with no question). The
     * record is written at once; when it cannot be (the store is read-only and its file still busy, or the write failed), the call throws
     * `unavailable` and the store is exactly as it was: the records, the read-only flag and what waits for the disk. No listener hears of a refusal.
     */
    setSaved(given) {
        const rec = this.marked(given);
        const id = rec.pluginId;
        const before = { recs: this.recs, readOnly: this.readOnly, sets: new Map(this.pendingSets), revokes: new Set(this.pendingRevokes) };
        const prev = this.recs.get(id);
        this.recs = new Map(this.recs); // the rollback puts the earlier map back as it was
        this.recs.set(id, rec);
        this.pendingRevokes.delete(id);
        this.pendingSets.set(id, rec);
        if (!this.save()) {
            this.recs = before.recs;
            this.readOnly = before.readOnly;
            this.pendingSets = before.sets;
            this.pendingRevokes = before.revokes;
            throw notSaved();
        }
        if (!sameRecord(prev, rec))
            this.changed(id, 'set', prev);
    }
    /**
     * True when a change can reach the disk now: a read-only store reads its file again and, if it can, the store is written (with what waits for
     * the disk). Asked before an irreversible step that a change must follow (the wipe of a Characters revoke).
     */
    writable() { return this.save(); }
    // The user asked to be asked again about a denied version: the record stays (what was granted before), the denial goes.
    clearDenied(id) {
        const rec = this.recs.get(id);
        if (!rec || rec.deniedVersion === undefined)
            return;
        const { deniedVersion: _d, ...rest } = rec;
        this.set(rest);
    }
    // saved: false when the revocation is only in memory (read-only store or failed write); the B4 UI warns then.
    revoke(id) {
        const prev = this.recs.get(id);
        const had = this.recs.delete(id);
        this.pendingSets.delete(id);
        if (!had && !this.readOnly)
            return { saved: true };
        this.pendingRevokes.add(id);
        const saved = this.save();
        if (had)
            this.changed(id, 'revoke', prev);
        return { saved };
    }
    // Writes the store. On a read-only store the file is read again: if it is readable now, this session's sets and revokes
    // are applied on top of its records, the store leaves read-only mode and the result is written. true when persisted.
    save() {
        if (this.readOnly) {
            const res = (0, atomicfile_1.readJsonDetailed)(this.file, v => isObj(v) && v.version === 1 && isObj(v.plugins), this.io);
            if (res.status === 'busy')
                return false;
            const merged = new Map();
            const raw = res.status === 'ok' ? res.value : undefined;
            if (isObj(raw) && isObj(raw.plugins)) {
                for (const [id, r] of Object.entries(raw.plugins)) {
                    const rec = cleanRecord(id, r);
                    if (rec)
                        merged.set(id, rec);
                }
            }
            for (const id of this.pendingRevokes)
                merged.delete(id);
            for (const [id, rec] of this.pendingSets)
                merged.set(id, rec);
            this.recs = merged;
            this.readOnly = false;
        }
        try {
            this.write(this.file, JSON.stringify({ version: 1, plugins: Object.fromEntries(this.recs) }));
            this.pendingSets.clear();
            this.pendingRevokes.clear();
            return true;
        }
        catch (e) {
            console.warn(`grants: saving failed (${codeOf(e)})`);
            return false;
        }
    }
}
exports.GrantStore = GrantStore;
// A host with no consent UI wired (the default of PluginHost; the product uses UiPrompter, prompts.ts): nothing new is ever granted.
// Nobody sees the prompt, so it is not an answer: ask() fails, which ensureGrant treats as a failed prompt (the plugin stays off, no
// deniedVersion is saved, and a real prompter is asked later).
class DenyPrompter {
    async ask() { throw Object.assign(new Error('no consent UI yet'), { code: 'unavailable' }); }
}
exports.DenyPrompter = DenyPrompter;
// Test builds only: answers come from a script, and every call is counted.
class ScriptedPrompter {
    answers;
    calls = 0;
    constructor(answers) {
        this.answers = answers;
        if (!buildinfo_1.TEST_BUILD)
            throw new Error('ScriptedPrompter exists only in test builds');
    }
    async ask() {
        this.calls++;
        return this.answers[Math.min(this.calls - 1, this.answers.length - 1)] ?? { decision: 'deny' };
    }
}
exports.ScriptedPrompter = ScriptedPrompter;
function withProviders(req, providers) {
    const services = {};
    for (const [iface, s] of Object.entries(req.services)) {
        services[iface] = { range: s.range, provider: Object.hasOwn(providers, iface) ? providers[iface].pluginId : null };
    }
    return { ...req, services };
}
// What the plugin gets once req is consented: exactly req (never more), with the selected characters kept from the
// earlier grant when the level did not change, or taken from the user's choice when the level was raised.
function grantFor(current, req, chosen) {
    let selected = [];
    if (req.characters === 'selected') {
        // The user's picker choice wins; without one the earlier selection stays.
        selected = chosen !== undefined
            ? chosen.filter(n => Number.isSafeInteger(n))
            : current && current.characters === 'selected' ? current.selected : [];
    }
    // A provider that is gone right now keeps its earlier grant, so it is not asked again when it comes back.
    const services = {};
    for (const [iface, sv] of Object.entries(req.services)) {
        const c = current && Object.hasOwn(current.services, iface) ? current.services[iface] : undefined;
        services[iface] = sv.provider === null && c && c.range === sv.range ? { ...c } : { ...sv };
    }
    return { ...req, services, selected: [...new Set(selected)] };
}
/**
 * A4 (E2): the owners whose rows must go when `next` replaces `old`: the ids the plugin may keep seeing (`keep`), 'none' when it sees no character any more, undefined when
 * the plugin loses nothing. A plugin that saw `all` characters and now sees a selection lost every character outside it, not only the ones the user just unticked, so the
 * delete is "every owner not in keep".
 */
function narrowedKeep(old, next) {
    if (!old || old.characters === 'none' || next.characters === 'all')
        return undefined;
    if (next.characters === 'none')
        return 'none';
    const keep = [...new Set(next.selected)];
    if (old.characters === 'selected' && old.selected.every(n => keep.includes(n)))
        return undefined;
    return keep.length > 0 ? keep : 'none';
}
// S2 (M2): the items of `offered` (the new optional items an ask showed) that an Allow switched off. No `declined`: none. One written exactly as the host keeps a
// set (exactOptional): those of its items that were offered, so a required, foreign or already granted item it names is ignored. Anything else (not an object,
// a kind that is not a list, a non-canonical or duplicate item, an unknown kind): every offered item, so nothing optional is granted without a readable Allow.
function switchedOff(declined, offered) {
    if (declined === undefined)
        return {};
    const s = (0, optional_1.exactOptional)(declined);
    return s === null ? offered : (0, optional_1.intersectSet)(s, offered);
}
// What a grant decision of `m` starts from (ensureGrant and reviewNeeded read it the same way): the record it builds on, the request cut by
// what the user took back and kept narrowed, its delta over the record, whether the A5 reset fires, and whether the plugin would newly keep
// running with no view (`bgNew`, Task 8 review I2: `background` is no field of a grant, so the delta cannot show it).
// Optional permissions (plan 2026-11-09, section 3.2): the request adds every optional item the record has not declined (`declined`, read cut to the manifest's
// optional items), so a declined item is never asked for by itself; `optDelta` is the optional part of the delta. `reset` is the A5 rule over the whole request
// (what the ask shows and reviewNeeded reads); a decision reads the rule again on the grant it stores (section 3.5), which the switches can make smaller.
function basisOf(store, m, providers, fresh, bundled = false, builtIn = false) {
    const stored = store.get(m.id);
    // A fresh install over a stale record: asked as an install, the stale record kept only for the reset decision below.
    const rec = fresh ? undefined : stored;
    const provides = (m.contributes.services?.length ?? 0) > 0;
    const revoked = rec?.revoked ?? [];
    // What the user took back is not asked for again by itself (R17): the request is cut by it before the delta.
    const full = stripKinds(withProviders(requested(m, builtIn), providers), revoked);
    const bgKept = m.background === true && !revoked.includes('background');
    // What the record ran in the background (a record written before the field: the same version ran what this manifest asks).
    const prevBackground = rec ? rec.background ?? (rec.version === m.version ? bgKept : false) : false;
    // Characters the user narrowed from `all` stay narrowed for the same manifest: it is not asked again at every start.
    const kept = rec?.narrowed === true && rec.granted.characters === 'selected' && full.characters === 'all' ? { ...full, characters: 'selected' } : full;
    const optional = (0, optional_1.optionalOf)(m);
    const declined = (0, optional_1.intersectSet)(rec?.declined ?? {}, optional);
    const req = withItems(kept, (0, optional_1.minusSet)(optional, declined));
    const d = delta(rec?.granted, req);
    // The A5 rule reads the stored record, a stale one included: what an earlier copy could see decides whether its data is wiped.
    const prev = stored ? { g: stored.granted, provides: stored.provides ?? false, revoked: stored.revoked, sawNames: stored.sawNames } : undefined;
    const reset = (0, reset_1.needsReset)(prev, { g: req, provides });
    // A bundled plugin ships with the app, so running in the background is pre-granted for it (owner call 2026-10-31, docs/platform-notes.md): no question, whatever an older record stored
    // (a recorded Deny of the same version included). The Privacy toggle still works: a revoked `background` makes bgKept false and the host parks the plugin again.
    return { stored, rec, provides, revoked, bgKept, prevBackground,
        bgNew: bgKept && !prevBackground && !bundled, req, narrowed: kept !== full, d, reset, prev, optional, declined, optDelta: itemsIn(d, optional) };
}
// null: the plugin must stay disabled (denied escalation). A version that was denied is not asked again; a new version is.
async function ensureGrantNow(store, prompter, m, providers, hooks, o) {
    const confirm = o?.recordDeny === false; // an install or a reviewed update: always asked, a Deny records nothing
    const gone = () => { try {
        return o?.current !== undefined && o.current() !== true;
    }
    catch {
        return true;
    } };
    if (gone())
        return null;
    const { stored, rec, provides, revoked, bgKept, prevBackground, bgNew, req, narrowed, d, reset, prev, optional, declined, optDelta } = basisOf(store, m, providers, confirm && o?.fresh === true, o?.source === 'bundled', o?.builtIn === true);
    // A record written before B4a has no `provides`. The rule: it counts as "did not provide", whatever the current manifest says (a directory edited in
    // place must not hide a provider that was added after the grant). The cost is one wipe, with the host notice, for a legacy record of a plugin that
    // sees names and now provides; the record is rewritten with `provides` at once, so it happens once. Records of B4a and later are exact.
    const prevProvides = rec ? rec.provides ?? false : false;
    const now = () => new Date().toISOString();
    const flags = (narrow) => ({ provides, background: bgKept, ...(narrow ? { narrowed: true } : {}), ...(revoked.length > 0 ? { revoked: [...revoked] } : {}) });
    // The picks stay as long as the grant holds `chatlogs`. A fresh install has no record to take them from.
    const picks = (g) => rec?.chatChannels !== undefined && g.logs.includes('chatlogs') ? { chatChannels: [...rec.chatChannels] } : {};
    // Optional permissions (section 3.3): what the record keeps declined, the earlier items and `more`, cut to the manifest's optional items, minus what `g` holds.
    const declinedFor = (g, more) => {
        const s = (0, optional_1.minusSet)((0, optional_1.intersectSet)((0, optional_1.unionSet)(declined, more), optional), itemsIn(g, optional));
        return (0, optional_1.isEmptySet)(s) ? {} : { declined: s };
    };
    // The A5 reset follows the grant that is stored (section 3.5), not the request: a switched-off origin does not fire it. Without optional items the grant equals
    // the request up to the character narrowing, which canSendOut does not read, so this is the reset the ask showed.
    const fires = (g) => (0, reset_1.needsReset)(prev, { g, provides });
    // The wipe comes after the decision and before the new grant is stored: a failed wipe leaves the old record, so the next start tries again.
    const wipe = async (prompted, reset) => {
        if (gone())
            return false;
        if (!reset || !hooks?.wipe)
            return !gone();
        try {
            await hooks.wipe(prompted);
        }
        catch {
            console.error('PLUGIN_RESET', 'failed');
            return false;
        }
        return !gone();
    };
    // A4 (E2, M4, M5): a decided grant that takes characters away deletes their rows first, in the plugin's database; the old record stays when that fails (N1). The A5 reset deletes
    // the whole file, so it covers this. Compared with the stored record (a fresh install over a stale record included).
    const narrowRows = async (g, reset) => {
        if (gone())
            return false;
        const keep = narrowedKeep(stored?.granted, g);
        if (keep === undefined || !hooks?.narrow || (reset && hooks.wipe))
            return !gone();
        try {
            await hooks.narrow(keep);
        }
        catch {
            console.error('PLUGIN_NARROW', 'failed');
            return false;
        }
        return !gone();
    };
    // After an A5 reset the record is written for good (O8): a state kept in memory only would run the file delete again at the next start.
    const save = (r, reset) => {
        if (!reset || !hooks?.wipe) {
            store.set(r);
            return true;
        }
        try {
            store.setSaved(r);
            return true;
        }
        catch {
            console.error('PLUGIN_RESET', 'not saved');
            return false;
        }
    };
    // A decided grant: the wipe when the reset fires on it, the row delete, then the record. null when a step failed or the call no longer applies.
    const settle = async (granted, prompted, r) => {
        const reset = fires(granted);
        if (!(await wipe(prompted, reset)) || !(await narrowRows(granted, reset)) || gone())
            return null; // checked again right before the write
        return save(r, reset) ? granted : null;
    };
    if (isEmpty(d) && !bgNew && !confirm) { // nothing new: no question (running in the background with no view is asked like a permission)
        const granted = grantFor(rec?.granted, req, undefined);
        return settle(granted, false, { pluginId: m.id, version: m.version, granted, decidedAt: rec && rec.version === m.version && !rec.deniedVersion ? rec.decidedAt : now(), ...flags(narrowed), ...picks(granted), ...declinedFor(granted, {}) });
    }
    // No previous grant: an install, also a denied install asked again (empty grant) and a re-asked same-version denial.
    const previous = rec && !(isEmpty(rec.granted) && (rec.deniedVersion !== undefined || rec.version === m.version)) ? { version: rec.version, granted: rec.granted, background: prevBackground } : undefined;
    // Section 3.4 (board op-2): only optional items are new (nothing required, no new background), so a refusal is "Not now" and the plugin runs. A reviewed (staged) update
    // is one too, with no "Keep <version>": the new version runs either way, and an installed version that is revoked is not turned off by refusing optional items.
    // An install is not (it is asked as Allow and Deny: a Deny installs nothing). Nor is a staged update reviewed for more than its optional items (H1): one that
    // changes who the plugin is (`identity`, I3), or whose required part fires the A5 reset (M1), keeps "Keep <version>" with the switches, so a refusal never
    // moves the plugin to the new author's version or wipes its data.
    const optionalOnly = isEmpty(withoutItems(d, optDelta)) && !bgNew && !(0, optional_1.isEmptySet)(optDelta)
        && (!confirm || (previous !== undefined && o?.identity === undefined && !fires(withoutItems(req, optDelta))));
    // Owner answer 2026-11-06 (multi-client host groups, question 2 option e; docs/platform-notes.md "A Deny of a new kind keeps a bundled plugin running"): in the update
    // prompt of a bundled plugin, the revocable kinds the old grant did not hold at all (`DENY_KEEPS`), when they are everything required that is new, are what a Deny
    // leaves revoked: the plugin keeps running with the rest (a consumed service too, since L7: the services grant stays unset; a services grant whose entries all have no
    // provider holds none, so its provider appearing is new too). Anything else new (a widened held kind, among them a services grant that holds an entry with a provider
    // and gets another interface, range or provider, Game events or Chat logs, a flag, a quota), an install,
    // a confirming ask, and a Deny that would fire the A5 reset (a Deny never wipes) or delete owned rows (a narrowed Characters grant: a Deny never narrows) keep today's
    // Deny. A record whose denied version is this version never reaches the prompt (it short-circuits below); a newer version is asked, and with a denied version still stored the rule is off, so it gets today's Deny; once Reconsider or Edit permissions clears that denial, the
    // ask is an ordinary update and this rule applies to it like to any other.
    const denyRevokes = (() => {
        if (o?.source !== 'bundled' || confirm || optionalOnly || bgNew || previous === undefined || rec === undefined || rec.deniedVersion !== undefined)
            return [];
        const required = withoutItems(d, optDelta);
        const kinds = DENY_KEEPS.filter(k => asksKind(required, k) && !holdsKind(rec.granted, k));
        if (kinds.length === 0)
            return [];
        const rest = withoutItems(stripKinds(req, kinds, optional), optDelta);
        if (!isEmpty(withoutItems(delta(rec.granted, rest), optDelta)) || fires(rest))
            return [];
        return narrowedKeep(stored?.granted, grantFor(rec.granted, rest, undefined)) === undefined ? kinds : [];
    })();
    const deny = async () => {
        if ((confirm && !optionalOnly) || gone())
            return null; // R26: no record for a denied install
        if (optionalOnly) { // no deniedVersion: the plugin keeps what it had, and the new optional items join `declined`
            const granted = grantFor(rec?.granted, withoutItems(req, optDelta), undefined);
            return settle(granted, true, { pluginId: m.id, version: m.version, granted, decidedAt: now(), ...flags(narrowed), ...picks(granted), ...declinedFor(granted, optDelta) });
        }
        if (denyRevokes.length > 0) { // no deniedVersion: the new kinds join `revoked` (Privacy offers them with Allow), the new optional items join `declined`
            const granted = grantFor(rec?.granted, withoutItems(stripKinds(req, denyRevokes, optional), optDelta), undefined);
            return settle(granted, true, {
                pluginId: m.id, version: m.version, granted, decidedAt: now(), provides, background: bgKept, ...(narrowed ? { narrowed: true } : {}),
                revoked: ordered([...revoked, ...denyRevokes]), ...picks(granted), ...declinedFor(granted, optDelta),
            });
        }
        store.set({
            pluginId: m.id, version: rec?.version ?? m.version, granted: rec?.granted ?? (0, exports.emptyGranted)(), deniedVersion: m.version, decidedAt: now(),
            provides: prevProvides, background: prevBackground, ...(rec?.narrowed ? { narrowed: true } : {}), // what the kept grant had, not what the denied manifest has
            ...(revoked.length > 0 ? { revoked: [...revoked] } : {}), ...picks(rec?.granted ?? (0, exports.emptyGranted)()), ...(rec?.declined !== undefined ? { declined: rec.declined } : {}), // `declined` as it was
        });
        return null;
    };
    // A refusal of this version short-circuits, unless the required part has nothing new any more: the user refused an older, larger required ask and now only optional items are
    // new (a plugin that moved items from required to optional keeps its version). That gets the optional-only prompt, which keeps what the plugin has.
    const onlyOptionalNew = isEmpty(withoutItems(d, optDelta)) && !bgNew && !(0, optional_1.isEmptySet)(optDelta);
    if (rec?.deniedVersion === m.version && !confirm && !onlyOptionalNew)
        return null;
    let answer;
    const offered = itemsIn(req, optional);
    // The reset that only new optional origins fire (the required part alone does not): the prompt shows it while one of them stays switched on.
    const resetWhen = reset && !fires(withoutItems(req, optDelta)) ? optDelta.network ?? [] : [];
    try {
        answer = await prompter.ask({
            plugin: { id: m.id, name: m.name, ...(m.author !== undefined ? { author: m.author } : {}), version: m.version }, delta: d, providers,
            requested: req, ...(previous ? { previous } : {}), background: bgKept, reset,
            ...(o?.source !== undefined ? { source: o.source } : {}), ...(o?.keep !== undefined && !optionalOnly ? { keep: o.keep } : {}), // "Keep <version>" is not the only way out of an optional-only ask
            ...(o?.identity !== undefined ? { identity: o.identity } : {}), ...(confirm ? { staged: m } : {}), ...(o?.sourceIndex !== undefined ? { sourceIndex: o.sourceIndex } : {}),
            ...((0, optional_1.isEmptySet)(offered) ? {} : { optional: offered }), ...(optionalOnly ? { optionalOnly: true } : {}), ...(resetWhen.length > 0 ? { resetWhen } : {}),
            ...(denyRevokes.length > 0 ? { denyRevokes: [...denyRevokes] } : {}),
        });
    }
    catch (e) {
        // The prompt itself failed: that is not the user's answer. No deniedVersion, so the next start asks again.
        console.warn(`grants: prompter failed (${codeOf(e)})`);
        return null;
    }
    if (answer.decision !== 'allow')
        return deny();
    const off = switchedOff(answer.declined, optDelta);
    const asked = withoutItems(req, off);
    // "Allow for selected characters only" on a request for all characters: the plugin gets the chosen ones.
    const narrow = answer.selected !== undefined && req.characters === 'all';
    const granted = grantFor(rec?.granted, narrow ? { ...asked, characters: 'selected' } : asked, answer.selected);
    return settle(granted, true, { pluginId: m.id, version: m.version, granted, decidedAt: now(), ...flags(narrowed || narrow), ...picks(granted), ...declinedFor(granted, off) });
}
/**
 * R29: whether an update to `m` needs the user's review before its files are used: its request (cut by what the user took back, kept narrowed)
 * asks for more than the plugin's current grant, allowing it would fire the A5 reset, or it would newly keep running in the background with no
 * view (I2). Read exactly as the next ensureGrant reads it.
 */
function reviewNeeded(store, m, providers, builtIn = false) {
    const b = basisOf(store, m, providers, false, false, builtIn);
    return !isEmpty(b.d) || b.reset || b.bgNew;
}
// Calls are queued per (store, plugin id): each runs with its own manifest and providers against the record the earlier
// call saved. Identical requests still prompt once (the later run sees an empty delta or deniedVersion).
const queues = new WeakMap();
function queued(store, id, work) {
    let byId = queues.get(store);
    if (!byId)
        queues.set(store, byId = new Map());
    const map = byId;
    const prev = map.get(id) ?? Promise.resolve();
    const run = prev.then(work, work);
    map.set(id, run);
    const clear = () => { if (map.get(id) === run)
        map.delete(id); };
    run.then(clear, clear);
    return run;
}
function ensureGrant(store, prompter, m, providers, hooks, o) {
    return queued(store, m.id, () => ensureGrantNow(store, prompter, m, providers, hooks, o));
}
/** R29: whether a grant change of the plugin is queued or running (a prompt may be open): a plain update is not applied under it. */
function grantPending(store, id) {
    return queues.get(store)?.has(id) === true;
}
// R17: the user takes one part of a grant back. The record keeps the rest, lists the kind in `revoked`, and a later start asks nothing about
// it. Only Characters wipes (the A5 filter; `hooks.wipe` runs once, before the record changes, and a throw leaves the record as it was; the page was
// stopped for the wipe, so the registry starts the plugin again, N1).
// The change must reach the disk (final review I1): one kept in memory only would come back at the next start with no question. A store that cannot
// be written (read-only since a busy read at start, or a failing write) refuses it `unavailable` (`isNotSaved`) before the teardown and the wipe;
// a write that fails after the wipe refuses it too, and the record stays as it was.
async function revokeNow(store, m, kind, hooks, opts) {
    if (!declaredKinds(m, opts?.builtIn === true).includes(kind))
        throw (0, errors_1.coded)('bad_params', 'kind');
    const rec = store.get(m.id);
    if (!rec)
        throw (0, errors_1.coded)('not_found', 'no grant');
    if (rec.revoked?.includes(kind))
        return; // already revoked: nothing to change, nothing to wipe again
    if (kind === 'characters' && (hooks?.wipe || hooks?.ownerDelete)) {
        if (!store.writable())
            throw notSaved();
        await hooks.beforeWipe?.();
        // A4 (E3, E4): the owned rows go (box off), or the whole database file (box on), before the A5 filter of storage.json and the partition; a throw leaves the record as it was.
        if (hooks.ownerDelete)
            await hooks.ownerDelete(opts?.deleteOwn === true ? 'file' : 'rows');
        await hooks.wipe?.(true);
    }
    const revoked = ordered([...(rec.revoked ?? []), kind]);
    const { chatChannels: _picks, ...noPicks } = rec; // revoking `chatlogs` ends the picks: Allow starts with none
    // R-K: the optional items of the kind and `declined` stay as they are.
    store.setSaved({ ...(kind === 'chatlogs' ? noPicks : rec), granted: stripKind(rec.granted, kind, (0, optional_1.optionalOf)(m)), revoked, ...(kind === 'background' ? { background: false } : {}) });
}
function revokeGrant(store, m, kind, hooks, opts) {
    return queued(store, m.id, () => revokeNow(store, m, kind, hooks, opts));
}
/**
 * R20 step 3 (final review m4): the plugin's record is deleted in the plugin's queue, so after every grant change of it that is queued or running
 * has ended. A Characters revoke still waiting on its wipe would otherwise write the record back for an uninstalled id, and a reinstall of the
 * same id would start with it and no question. `saved` as `GrantStore.revoke` answers it.
 */
function forgetGrant(store, id) {
    return queued(store, id, async () => store.revoke(id));
}
/** The channels the user picked for the plugin; none once the grant no longer holds `chatlogs`. */
function getChatChannels(store, id) {
    const rec = store.get(id);
    return rec?.granted.logs.includes('chatlogs') === true ? [...(rec.chatChannels ?? [])] : [];
}
/** The user's picks replace the old ones. They must reach the disk: a failed write refuses them `unavailable` and changes nothing. */
function setChatChannels(store, id, list) {
    return queued(store, id, async () => {
        const picks = cleanPicks(list);
        if (picks === null)
            throw (0, errors_1.coded)('bad_params', 'channels');
        const rec = store.get(id);
        if (rec?.granted.logs.includes('chatlogs') !== true)
            throw (0, errors_1.coded)('not_found', 'no grant');
        const { chatChannels: _old, ...rest } = rec;
        store.setSaved({ ...rest, ...(picks.length > 0 ? { chatChannels: picks } : {}) });
    });
}
/** `fn` runs after a change of the picks a plugin reads, whatever made it: the picker, a revoke, an update that drops `chatlogs`, an uninstall. */
function watchChatChannels(store, fn) {
    store.onChange((id, _kind, prev) => {
        const before = prev !== undefined && prev.granted.logs.includes('chatlogs') ? prev.chatChannels ?? [] : [];
        const now = getChatChannels(store, id);
        if (before.length !== now.length || before.some((c, i) => c !== now[i]))
            fn(id);
    });
}
// R18: asks again, through the prompter, for exactly the revoked kinds named. Allowed: they are granted. Denied (or no longer revoked): the record
// is not touched, so the part stays revoked and the plugin keeps running as before; a user-started re-ask never takes the turn-off path of a denied
// escalation (no deniedVersion). A reset (A5) that fails also leaves the record alone and answers 'kept'; the page was stopped for it, so the registry
// starts the plugin again (N1) and the wipe tells the user. A prompter that fails to ask throws `unavailable`.
async function allowNow(store, prompter, m, providers, kinds, hooks, builtIn = false) {
    const rec = store.get(m.id);
    if (!rec)
        throw (0, errors_1.coded)('not_found', 'no grant');
    const declared = declaredKinds(m, builtIn);
    const want = ordered(kinds.filter(k => (rec.revoked ?? []).includes(k) && declared.includes(k)));
    if (want.length === 0)
        return 'granted'; // nothing of it is revoked
    const left = (rec.revoked ?? []).filter(k => !want.includes(k));
    // The grant as it stands plus exactly the parts asked: nothing else (a denied escalation stays denied). R-K: only the required items of those kinds; the
    // optional ones and `declined` stay as they are, `declined` cut to the manifest's optional items (an entry for an item it now requires would drop it again).
    const optional = (0, optional_1.optionalOf)(m);
    const req = takeKinds(rec.granted, withProviders(requested(m, builtIn), providers), want, optional);
    const d = delta(rec.granted, req);
    const bg = want.includes('background');
    const provides = (m.contributes.services?.length ?? 0) > 0;
    const prevProvides = rec.provides ?? false;
    const reset = (0, reset_1.needsReset)({ g: rec.granted, provides: prevProvides, revoked: rec.revoked, sawNames: rec.sawNames }, { g: req, provides });
    let answer;
    try {
        answer = await prompter.ask({
            plugin: { id: m.id, name: m.name, ...(m.author !== undefined ? { author: m.author } : {}), version: m.version }, delta: d, providers, requested: req,
            previous: { version: rec.version, granted: rec.granted, background: rec.background === true }, background: bg || (m.background === true && !left.includes('background')), reset,
        });
    }
    catch (e) {
        console.warn(`grants: prompter failed (${codeOf(e)})`);
        throw (0, errors_1.coded)('unavailable', 'the permission question could not be asked');
    }
    if (answer.decision !== 'allow')
        return 'kept';
    const narrow = answer.selected !== undefined && req.characters === 'all' && want.includes('characters');
    const granted = grantFor(rec.granted, narrow ? { ...req, characters: 'selected' } : req, want.includes('characters') ? answer.selected : undefined);
    if (reset && hooks?.wipe) {
        try {
            await hooks.beforeWipe?.();
            await hooks.wipe(true);
        }
        catch {
            console.error('PLUGIN_RESET', 'failed');
            return 'kept';
        }
    }
    else if (want.includes('characters') && hooks?.narrow) {
        // A4 (E2): the pick can be smaller than what the plugin saw before; the hook stops the page itself (O6). A failed delete keeps the old record.
        const keep = narrowedKeep(rec.granted, granted);
        if (keep !== undefined) {
            try {
                await hooks.narrow(keep);
            }
            catch {
                console.error('PLUGIN_NARROW', 'failed');
                return 'kept';
            }
        }
    }
    const { revoked: _r, declined: wasDeclined, ...rest } = rec;
    const declined = (0, optional_1.intersectSet)(wasDeclined ?? {}, optional);
    const next = {
        ...rest, granted, decidedAt: new Date().toISOString(), ...(reset ? { provides } : {}), ...(bg ? { background: true } : {}), ...(narrow ? { narrowed: true } : {}),
        ...(left.length > 0 ? { revoked: left } : {}), ...((0, optional_1.isEmptySet)(declined) ? {} : { declined }),
    };
    if (reset && hooks?.wipe) {
        try {
            store.setSaved(next);
        }
        catch {
            console.error('PLUGIN_RESET', 'not saved');
            return 'kept';
        }
    } // O8: the reset is not repeated at the next start
    else
        store.set(next);
    return 'granted';
}
function allowGrant(store, prompter, m, providers, kinds, hooks, builtIn = false) {
    return queued(store, m.id, () => allowNow(store, prompter, m, providers, kinds, hooks, builtIn));
}
// Optional permissions (plan 2026-11-09, T1.5): the items a call names. Each must be one of the manifest's optional items, written as the host keeps it
// (canonical, no duplicate, no other kind, `notifications` only as true), and at least one must be named; anything else is bad_params, before any prompt or write.
function namedItems(m, items) {
    const set = (0, optional_1.exactOptional)(items);
    if (set === null || (0, optional_1.isEmptySet)(set) || !(0, optional_1.isEmptySet)((0, optional_1.minusSet)(set, (0, optional_1.optionalOf)(m))))
        throw (0, errors_1.coded)('bad_params', 'items');
    return set;
}
// The record an optional-item call acts on, read inside the plugin's queue: the record of `m`'s very version, of a plugin that runs. A record with a deniedVersion
// is a plugin a refused escalation turned off (or kept at an older grant while it stays off): not_permitted, so no item is added beside what the refused version
// would have changed (P4). Another version is not_found: the call was made for a manifest an update replaced while it waited, and its items may be required,
// gone or new in the record's version (P3, P3b). A running plugin's record never holds a deniedVersion: every grant decision that runs it writes none.
function liveRecord(store, m) {
    const rec = store.get(m.id);
    if (!rec)
        throw (0, errors_1.coded)('not_found', 'no grant');
    if (rec.deniedVersion !== undefined)
        throw (0, errors_1.coded)('not_permitted', 'the plugin is off');
    if (rec.version !== m.version)
        throw (0, errors_1.coded)('not_found', 'no grant for this version');
    return rec;
}
// Allow optional items later (a Privacy switch, or permissions.request after a gesture): one optional-only prompt for the items not granted yet; when every
// one is granted already, 'granted' with no question. Allow grants the items left switched on and takes them out of `declined` ('kept' when none is left on);
// "Not now" answers 'kept' and the items join `declined`; the plugin keeps running either way, and nothing else of the grant changes. A refusal (Not now, or
// Allow with every switch off) changes `declined` only: no wipe, whatever the record says (a legacy record without `provides` would fire A5 on the unchanged
// grant, P5). The A5 reset is read on the final grant: when it fires, the page is stopped and wiped before the record is saved for good, and a failed wipe or
// save answers 'kept' with the record as it was (the registry starts the plugin again, N1). A prompter that fails to ask throws `unavailable` and changes
// nothing. The call acts on a live record only (liveRecord), and a record that changed while the prompt was open (a write outside the queue) is not written
// over: 'kept', checked after the answer and again after the wipe.
async function allowOptionalNow(store, prompter, m, providers, items, hooks, by) {
    const asked = namedItems(m, items);
    const rec = liveRecord(store, m);
    const moved = () => store.get(m.id) !== rec;
    const optional = (0, optional_1.optionalOf)(m);
    const want = (0, optional_1.minusSet)(asked, itemsIn(rec.granted, optional));
    if ((0, optional_1.isEmptySet)(want))
        return 'granted';
    const req = withItems(rec.granted, want);
    const provides = (m.contributes.services?.length ?? 0) > 0;
    const prev = { g: rec.granted, provides: rec.provides ?? false, revoked: rec.revoked, sawNames: rec.sawNames };
    const fires = (g) => (0, reset_1.needsReset)(prev, { g, provides });
    const reset = fires(req);
    const resetWhen = reset && !fires(rec.granted) ? want.network ?? [] : [];
    let answer;
    try {
        answer = await prompter.ask({
            plugin: { id: m.id, name: m.name, ...(m.author !== undefined ? { author: m.author } : {}), version: m.version }, delta: delta(rec.granted, req), providers, requested: req,
            previous: { version: rec.version, granted: rec.granted, background: rec.background === true }, background: m.background === true && !(rec.revoked ?? []).includes('background'), reset,
            optional: itemsIn(req, optional), optionalOnly: true, by, ...(resetWhen.length > 0 ? { resetWhen } : {}),
        });
    }
    catch (e) {
        console.warn(`grants: prompter failed (${codeOf(e)})`);
        throw (0, errors_1.coded)('unavailable', 'the permission question could not be asked');
    }
    if (moved())
        return 'kept';
    const off = answer.decision !== 'allow' ? want : switchedOff(answer.declined, want);
    const on = (0, optional_1.minusSet)(want, off);
    const granted = withItems(rec.granted, on);
    const declined = (0, optional_1.minusSet)((0, optional_1.unionSet)((0, optional_1.intersectSet)(rec.declined ?? {}, optional), off), itemsIn(granted, optional));
    const { declined: _was, ...rest } = rec;
    const andDeclined = (r) => (0, optional_1.isEmptySet)(declined) ? r : { ...r, declined };
    if ((0, optional_1.isEmptySet)(on)) {
        store.set(andDeclined(rest));
        return 'kept';
    } // a refusal: the grant, `provides` and decidedAt stay as they were
    const resetNow = fires(granted);
    if (resetNow && hooks?.wipe) {
        try {
            await hooks.beforeWipe?.();
            await hooks.wipe(true);
        }
        catch {
            console.error('PLUGIN_RESET', 'failed');
            return 'kept';
        }
        if (moved())
            return 'kept';
    }
    const next = andDeclined({ ...rest, granted, decidedAt: new Date().toISOString(), ...(resetNow ? { provides } : {}) });
    if (resetNow && hooks?.wipe) {
        try {
            store.setSaved(next);
        }
        catch {
            console.error('PLUGIN_RESET', 'not saved');
            return 'kept';
        }
    } // O8: the reset is not repeated at the next start
    else
        store.set(next);
    return 'granted';
}
function allowOptional(store, prompter, m, providers, items, hooks, by = 'plugin') {
    return queued(store, m.id, () => allowOptionalNow(store, prompter, m, providers, items, hooks, by));
}
// Switch optional items off (Privacy): they leave the grant and join `declined`, with no question and no wipe (taking a way out away never fires A5). The change
// must reach the disk (as a revoke, I1): a store that cannot be written refuses it `unavailable` (`isNotSaved`) and nothing changes. A live record only
// (liveRecord): a stale call never strips an item the record's version requires (P3b).
async function declineOptionalNow(store, m, items) {
    const asked = namedItems(m, items);
    const rec = liveRecord(store, m);
    const declined = (0, optional_1.unionSet)((0, optional_1.intersectSet)(rec.declined ?? {}, (0, optional_1.optionalOf)(m)), asked);
    store.setSaved({ ...rec, granted: withoutItems(rec.granted, asked), declined, decidedAt: new Date().toISOString() });
}
function declineOptional(store, m, items) {
    return queued(store, m.id, () => declineOptionalNow(store, m, items));
}
