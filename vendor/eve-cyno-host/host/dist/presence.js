"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.PresenceService = exports.CallGate = exports.MAX_BACKOFF_MS = exports.CALL_HOLD_MS = exports.STALE_FACTOR = exports.MIN_GAP_MS = exports.SLOW_EVERY_MS = exports.PLACE_EVERY_MS = exports.ONLINE_EVERY_MS = exports.PRESENCE_SCOPES = exports.ONLINE_SCOPE = exports.HOST_ESI_ID = void 0;
exports.hostEsiGet = hostEsiGet;
exports.nameEsiGet = nameEsiGet;
const presencefmt_1 = require("./presencefmt");
const presencesnap_1 = require("./presencesnap");
exports.HOST_ESI_ID = 'eve-cyno.host.presence';
exports.ONLINE_SCOPE = 'esi-location.read_online.v1';
exports.PRESENCE_SCOPES = [
    exports.ONLINE_SCOPE,
    'esi-location.read_location.v1', 'esi-location.read_ship_type.v1',
    'esi-wallet.read_character_wallet.v1', 'esi-skills.read_skillqueue.v1',
];
exports.ONLINE_EVERY_MS = 60_000;
exports.PLACE_EVERY_MS = 60_000;
exports.SLOW_EVERY_MS = 300_000;
exports.MIN_GAP_MS = 1_000;
exports.STALE_FACTOR = 3;
/** The longest one call may hold the gate: above cynod.ts ESI_GET_HOST_LIMIT_MS (30 s), so cynod's own `timeout` answers first. */
exports.CALL_HOLD_MS = 35_000;
/** A failing read is asked again after its interval, then twice as long each time, never more than this apart (M15). */
exports.MAX_BACKOFF_MS = 15 * 60_000;
const NAME_RETRY_MS = 10 * 60_000;
const PAUSE_FALLBACK_MS = 60_000;
/** cynod codes the page shows through a state of their own (not shared, re-authorise, unavailable): no "Could not read" for them. */
const OWN_STATE = new Set(['scope_missing', 'invalid_grant', 'invalid_token', 'sidecar_down', 'keychain_unavailable']);
const ROUTES = {
    online: { path: id => `/characters/${id}/online`, scope: exports.PRESENCE_SCOPES[0], every: exports.ONLINE_EVERY_MS },
    location: { path: id => `/characters/${id}/location`, scope: exports.PRESENCE_SCOPES[1], every: exports.PLACE_EVERY_MS },
    ship: { path: id => `/characters/${id}/ship`, scope: exports.PRESENCE_SCOPES[2], every: exports.PLACE_EVERY_MS },
    wallet: { path: id => `/characters/${id}/wallet`, scope: exports.PRESENCE_SCOPES[3], every: exports.SLOW_EVERY_MS },
    queue: { path: id => `/characters/${id}/skillqueue`, scope: exports.PRESENCE_SCOPES[4], every: exports.SLOW_EVERY_MS },
};
const PLACE = ['location', 'ship'];
const SLOW = ['wallet', 'queue'];
/**
 * Spaces calls at least `gap` ms apart, in order. Shared with the name cache so every host call keeps the same pace. A call that has not
 * ended after CALL_HOLD_MS fails with code `timeout` and frees the gate: one call that never answers must not hold every later one.
 */
class CallGate {
    now;
    timers;
    gap;
    hold;
    last = -Infinity;
    chain = Promise.resolve();
    constructor(now, timers, gap = exports.MIN_GAP_MS, hold = exports.CALL_HOLD_MS) {
        this.now = now;
        this.timers = timers;
        this.gap = gap;
        this.hold = hold;
    }
    run(fn) {
        const p = this.chain.then(async () => {
            const wait = this.last + this.gap - this.now();
            if (wait > 0)
                await new Promise(r => this.timers.set(r, wait));
            const prev = this.last;
            this.last = this.now();
            try {
                const out = await this.bounded(fn());
                if (out === undefined)
                    this.last = prev; // no call went out: the slot is free again
                return out;
            }
            catch (e) {
                if (e?.code === 'paused')
                    this.last = prev;
                throw e;
            }
        });
        this.chain = p.then(() => undefined, () => undefined);
        return p;
    }
    bounded(p) {
        return new Promise((resolve, reject) => {
            const t = this.timers.set(() => reject({ code: 'timeout' }), this.hold);
            p.then(v => { this.timers.clear(t); resolve(v); }, e => { this.timers.clear(t); reject(e); });
        });
    }
}
exports.CallGate = CallGate;
/** The host's ESI call over cynod's `esi.get` (R2): the reserved id, the app version and the five presence scopes; public paths carry no character. */
function hostEsiGet(call, version) {
    return async (characterId, p) => {
        const r = await call('esi.get', {
            ...(characterId === null ? {} : { characterId }), path: p, granted: [...exports.PRESENCE_SCOPES], pluginId: exports.HOST_ESI_ID, pluginVersion: version, compatDate: '',
        });
        return { status: typeof r?.status === 'number' ? r.status : 0, body: r?.body }; // cache and error-limit metadata stay in cynod
    };
}
/** The name cache's ESI call: paced by the shared gate, and refused (code `paused`) while the service is stopped or paused. */
function nameEsiGet(gate, esiGet, allows) {
    return (c, p) => gate.run(async () => {
        if (!allows())
            throw { code: 'paused' };
        return esiGet(c, p);
    });
}
const sigOf = (c) => `${[...c.scopes].sort().join(' ')}|${c.needsReauth ? 1 : 0}|${c.refreshedAt}`;
const isId = (x) => typeof x === 'number' && Number.isSafeInteger(x) && x > 0;
const rec = (x) => (typeof x === 'object' && x !== null && !Array.isArray(x) ? x : undefined);
const str = (x) => (typeof x === 'string' && x.length <= 64 ? x : undefined);
const codeOf = (e) => (typeof e?.code === 'string' ? e.code : 'error');
function parseField(key, body) {
    const r = rec(body);
    switch (key) {
        case 'online': return r && typeof r.online === 'boolean' ? { online: r.online, lastLogin: str(r.last_login), lastLogout: str(r.last_logout) } : undefined;
        case 'location': return r && isId(r.solar_system_id)
            ? { systemId: r.solar_system_id, stationId: isId(r.station_id) ? r.station_id : undefined, structureId: isId(r.structure_id) ? r.structure_id : undefined } : undefined;
        case 'ship': return r && isId(r.ship_type_id) ? { typeId: r.ship_type_id } : undefined;
        case 'wallet': return typeof body === 'number' && Number.isFinite(body) ? body : undefined;
        case 'queue': {
            if (!Array.isArray(body) || body.length > 200)
                return undefined;
            const q = [];
            for (const [i, x] of body.entries()) {
                const o = rec(x);
                if (!o || !isId(o.skill_id) || typeof o.finished_level !== 'number')
                    return undefined;
                q.push({ e: { skillId: o.skill_id, level: o.finished_level, start: str(o.start_date), finish: str(o.finish_date) }, pos: typeof o.queue_position === 'number' ? o.queue_position : i });
            }
            return q.sort((a, b) => a.pos - b.pos).map(x => x.e); // ESI's array order is not promised
        }
    }
}
class PresenceService {
    d;
    chars = new Map();
    gate;
    running = false;
    busy = false;
    gen = 0;
    timer;
    pausedUntil = 0;
    down = false;
    pauseOpen = false; // a pause ended or is running: the names are asked again when calls are allowed
    lastState = 'ok';
    /** The characters whose names were asked for since the last full rewarm (a list that adds one asks for that one). */
    warmed = new Set();
    /** A name lookup failed: the names are asked for again after NAME_RETRY_MS (an offline character is read once, so nothing else would). */
    nameRetry;
    /** A call got no answer in time and no call has been answered since: a character with nothing to show yet shows that, not the loading form. */
    stalledAt;
    /** `<field>:<reason>` already logged; a field's entries go once no character's read of it fails any more. */
    logged = new Set();
    constructor(d) {
        this.d = d;
        this.gate = d.gate ?? new CallGate(d.now, d.timers);
        for (const [id, data] of d.snapshot.load()) {
            const st = this.fresh();
            for (const k of presencesnap_1.FIELD_KEYS) {
                const f = data[k];
                if (f)
                    st.data[k] = { ...f, snap: true };
            }
            this.chars.set(id, st);
        }
        d.onList(() => this.vaultChanged());
    }
    // ---- control ------------------------------------------------------------------------------------------------------------
    start() {
        if (this.running)
            return;
        this.running = true;
        this.gen++;
        this.memo = undefined;
        this.stalledAt = undefined; // a new run asks again
        const now = this.d.now();
        for (const c of this.d.characters()) {
            const st = this.stateOf(c.id);
            st.sig = sigOf(c);
            this.initDue(st, c, now);
        }
        this.arm();
        this.rewarm(); // lookups refused while stopped; cached names cost no call
    }
    stop() {
        if (!this.running)
            return;
        this.running = false;
        this.gen++;
        if (this.timer !== undefined) {
            this.d.timers.clear(this.timer);
            this.timer = undefined;
        }
        if (this.nameRetry !== undefined) {
            this.d.timers.clear(this.nameRetry);
            this.nameRetry = undefined;
        }
        this.d.snapshot.flush();
        this.d.names.flush();
        this.d.onChange?.(); // the top bar's ESI row drops its failing state: nothing is read now
    }
    /** True while a call may go out: started and not inside a pause. The name lookups ask this too. */
    allowsCalls() { return this.running && this.d.now() >= this.pausedUntil; }
    /** One refresh now (the overview opened): one character, or all. */
    refresh(characterId) {
        const now = this.d.now();
        for (const c of this.d.characters()) {
            if (characterId !== undefined && c.id !== characterId)
                continue;
            const st = this.stateOf(c.id);
            st.due.online = now;
            for (const k of SLOW)
                st.due[k] = now;
            for (const k of PLACE)
                if (st.online === true || !st.fetched.has(k))
                    st.due[k] = now;
        }
        if (this.running)
            this.arm();
    }
    /** An `esi.paused` for the host id: no calls until `until` (epoch ms); the values stay. */
    paused(until) {
        if (!Number.isFinite(until))
            return;
        this.pausedUntil = Math.max(this.pausedUntil, until);
        this.pauseOpen = true;
        this.changed();
        if (this.running)
            this.arm();
    }
    /** When the pause ends (epoch ms), or null while no pause is on. */
    pauseEnd() { return this.d.now() < this.pausedUntil ? this.pausedUntil : null; }
    state() {
        if (this.down)
            return 'unavailable';
        return this.d.now() < this.pausedUntil ? 'paused' : 'ok';
    }
    /**
     * The reads that fail now, for the top bar: how many (a field of a character), for how many characters, and the plain reasons (distinct,
     * "not found (404)"). No id, no name. A read leaves it with its next answer; nothing runs while the service is stopped, so nothing fails.
     */
    failing() {
        const out = { reads: 0, characters: 0, reasons: [] };
        if (!this.running)
            return out;
        const byId = this.byId();
        for (const [id, st] of this.chars) {
            const c = byId.get(id);
            if (!c)
                continue;
            let any = false;
            for (const k of presencesnap_1.FIELD_KEYS) {
                const f = st.failed[k];
                if (!f || !this.eligible(c, st, k))
                    continue; // a field no longer read (scope gone, needs re-authorising, scope missing) is not failing
                out.reads++;
                any = true;
                const why = (0, presencefmt_1.readFailure)(f);
                if (!out.reasons.includes(why))
                    out.reasons.push(why);
            }
            if (any)
                out.characters++;
        }
        return out;
    }
    /**
     * The last values with their times, the fields the character does not share, whether it needs re-authorising, and the latest failed read no
     * answer has replaced (its own, or `timeout` while ESI answers no call at all).
     */
    raw(characterId) {
        const st = this.chars.get(characterId);
        const c = this.byId().get(characterId);
        const out = { notShared: [], reauth: false };
        if (c) {
            out.reauth = c.needsReauth || (st?.reauth ?? false);
            out.notShared = presencesnap_1.FIELD_KEYS.filter(k => !c.scopes.includes(ROUTES[k].scope) || (st?.missing.has(k) ?? false));
        }
        if (st)
            for (const k of presencesnap_1.FIELD_KEYS) {
                const f = st.data[k];
                if (f && (!c || c.scopes.includes(ROUTES[k].scope)))
                    out[k] = structuredClone(f); // a field whose scope is gone is not shown
            }
        let last;
        if (st)
            for (const k of presencesnap_1.FIELD_KEYS) {
                const f = st.failed[k];
                if (f && !out.notShared.includes(k) && (!last || f.at >= last.at))
                    last = f;
            }
        if (!last && this.stalledAt !== undefined)
            last = { code: 'timeout', at: this.stalledAt };
        if (last)
            out.failure = { code: last.code, ...(last.status !== undefined ? { status: last.status } : {}), at: last.at };
        return out;
    }
    /** A value is stale when it came from the snapshot and no poll replaced it yet, or is older than 3x its interval. */
    stale(characterId, key) {
        const st = this.chars.get(characterId);
        const f = st?.data[key];
        if (!f)
            return false;
        if (f.snap === true)
            return true;
        if (PLACE.includes(key) && st.online === false)
            return false; // an offline character is read once: its age shows as "last seen"
        return this.d.now() - f.at > exports.STALE_FACTOR * ROUTES[key].every;
    }
    // ---- vault list ---------------------------------------------------------------------------------------------------------
    vaultChanged() {
        this.memo = undefined;
        const list = this.d.characters();
        const ids = new Set(list.map(c => c.id));
        for (const id of [...this.chars.keys()])
            if (!ids.has(id))
                this.chars.delete(id);
        this.d.snapshot.keep(ids);
        for (const id of [...this.warmed])
            if (!ids.has(id))
                this.warmed.delete(id);
        const now = this.d.now();
        for (const c of list) {
            const st = this.stateOf(c.id);
            const sig = sigOf(c);
            if (st.sig !== undefined && st.sig !== sig) { // the scopes or the sign-in changed: a failing read is asked again now, without its back-off
                st.missing.clear();
                st.reauth = false;
                for (const k of presencesnap_1.FIELD_KEYS) {
                    const f = st.failed[k];
                    if (f) {
                        f.n = 0;
                        if (st.due[k] !== Infinity)
                            st.due[k] = now;
                    }
                }
            }
            st.sig = sig;
            let dropped = false;
            for (const k of presencesnap_1.FIELD_KEYS)
                if (st.data[k] && !c.scopes.includes(ROUTES[k].scope)) {
                    delete st.data[k];
                    dropped = true;
                } // revoked: not shared any more
            if (dropped)
                this.d.snapshot.put(c.id, st.data);
            if (this.running)
                this.initDue(st, c, now, true);
        }
        this.changed();
        if (this.running) {
            this.arm();
            const fresh = new Set(list.filter(c => !this.warmed.has(c.id)).map(c => c.id));
            if (fresh.size > 0)
                this.rewarm(fresh); // the first list, or a character added: their names
        }
    }
    // ---- scheduling ---------------------------------------------------------------------------------------------------------
    fresh() {
        return { data: {}, due: { online: Infinity, location: Infinity, ship: Infinity, wallet: Infinity, queue: Infinity }, fetched: new Set(), missing: new Set(), reauth: false, online: undefined, sig: undefined, failed: {} };
    }
    stateOf(id) {
        let st = this.chars.get(id);
        if (!st) {
            st = this.fresh();
            this.chars.set(id, st);
        }
        return st;
    }
    eligible(c, st, key) {
        return !c.needsReauth && !st.reauth && c.scopes.includes(ROUTES[key].scope) && !st.missing.has(key);
    }
    /** Due times at start (and for a character the list just changed). `keep` leaves times that are already set. */
    initDue(st, c, now, keep = false) {
        if (!keep || st.due.online === Infinity)
            st.due.online = now;
        for (const k of SLOW) {
            if (keep && st.due[k] !== Infinity)
                continue;
            const at = st.data[k]?.at;
            st.due[k] = at !== undefined && !st.data[k]?.snap ? at + ROUTES[k].every : now;
        }
        // Place fields wait for the online answer; without the online scope the answer never comes, so they are read once.
        if (!keep)
            for (const k of PLACE) {
                const at = st.data[k]?.at;
                st.due[k] = st.online === true ? (at !== undefined && !st.data[k]?.snap ? at + ROUTES[k].every : now) : Infinity;
            }
        if (!this.eligible(c, st, 'online'))
            for (const k of PLACE)
                if (!st.fetched.has(k) && st.due[k] === Infinity)
                    st.due[k] = now;
    }
    memo;
    /** The vault's list by id, built once per turn (the vault rebuilds every row on each `characters()`). */
    byId() {
        if (!this.memo) {
            this.memo = new Map(this.d.characters().map(c => [c.id, c]));
            queueMicrotask(() => { this.memo = undefined; });
        }
        return this.memo;
    }
    nextDue(now, onlyDue) {
        let best;
        for (const c of this.byId().values()) {
            const st = this.chars.get(c.id);
            if (!st)
                continue;
            for (const k of presencesnap_1.FIELD_KEYS) {
                const due = st.due[k];
                if (due === Infinity || (onlyDue && due > now) || !this.eligible(c, st, k))
                    continue;
                if (!best || due < best.due)
                    best = { c, key: k, due };
            }
        }
        return best;
    }
    arm() {
        if (this.timer !== undefined) {
            this.d.timers.clear(this.timer);
            this.timer = undefined;
        }
        if (!this.running)
            return;
        const now = this.d.now();
        const next = this.nextDue(now, false);
        const paused = this.pausedUntil > now;
        if (!next && !paused)
            return;
        const at = Math.max(next?.due ?? 0, this.pausedUntil);
        this.timer = this.d.timers.set(() => void this.wake(), Math.max(0, at - now));
    }
    async wake() {
        this.timer = undefined;
        if (!this.running)
            return;
        if (this.state() !== this.lastState)
            this.changed(); // the end of a pause
        if (this.busy)
            return; // the running call re-arms when it ends
        const now = this.d.now();
        if (now < this.pausedUntil) {
            this.arm();
            return;
        }
        if (this.pauseOpen) {
            this.pauseOpen = false;
            this.rewarm();
        } // lookups refused during the pause
        const task = this.nextDue(now, true);
        if (!task) {
            this.arm();
            return;
        }
        this.busy = true;
        try {
            await this.call(task.c, task.key);
        }
        finally {
            this.busy = false;
            if (this.running)
                this.arm();
        }
    }
    async call(c, key) {
        const gen = this.gen;
        const st = this.chars.get(c.id);
        if (!st)
            return;
        const route = ROUTES[key];
        const asked = this.d.now();
        st.due[key] = asked + route.every; // the normal cadence; a failure moves it later (back-off), never into a loop
        let res;
        let err;
        try {
            res = await this.gate.run(async () => {
                // The gate may have held this call for seconds: look again right before it goes out.
                if (gen !== this.gen || !this.running)
                    return undefined;
                const cur = this.byId().get(c.id);
                if (!cur || this.chars.get(c.id) !== st || !this.eligible(cur, st, key))
                    return undefined;
                if (this.d.now() < this.pausedUntil) {
                    st.due[key] = this.pausedUntil;
                    return undefined;
                }
                return this.d.esiGet(c.id, route.path(c.id));
            });
        }
        catch (e) {
            err = e;
        }
        if (gen !== this.gen || !this.running)
            return; // stopped meanwhile: nothing is recorded
        if (this.chars.get(c.id) !== st)
            return; // removed (or replaced) while the call was in flight: the answer is dropped
        const cur = this.byId().get(c.id) ?? c;
        const now = this.d.now();
        if (err !== undefined) {
            const code = codeOf(err);
            this.fail(cur, st, key, code, now);
            if (code === 'timeout')
                this.stalledAt ??= now; // ESI answers nothing: every character still waiting says so
            if (!OWN_STATE.has(code))
                this.readFailed(st, key, { code, at: now }, asked);
            this.changed();
            return;
        }
        if (!res)
            return;
        this.down = false;
        this.stalledAt = undefined;
        const v = res.status === 200 ? parseField(key, res.body) : undefined;
        if (v === undefined) { // any other failure keeps the last value (it turns stale after 3x the interval); with none, the view shows why
            this.readFailed(st, key, res.status === 200 || res.status === 0 ? { code: 'unreadable', at: now } : { code: 'status', status: res.status, at: now }, asked);
            this.changed();
            return;
        }
        if (st.failed[key]) {
            delete st.failed[key];
            if (![...this.chars.values()].some(s => s.failed[key]))
                for (const t of [...this.logged])
                    if (t.startsWith(`${key}:`))
                        this.logged.delete(t); // a later failure is news again
        }
        st.data[key] = { v, at: now };
        this.after(st, key, v, now);
        this.d.snapshot.put(c.id, st.data);
        this.warm(key, v, now);
        this.changed();
    }
    /** cynod's own codes (the plugin API renames them, the host sees them raw). */
    fail(c, st, key, code, now) {
        if (code === 'scope_missing') {
            st.missing.add(key);
            st.sig = sigOf(c);
            st.due[key] = Infinity;
            if (key === 'online')
                this.initDue(st, c, now, true);
        }
        else if (code === 'invalid_grant' || code === 'invalid_token') {
            st.reauth = true;
            st.sig = sigOf(c);
            for (const k of presencesnap_1.FIELD_KEYS)
                st.due[k] = Infinity;
        }
        else if (code === 'rate_limited') {
            this.pausedUntil = Math.max(this.pausedUntil, now + PAUSE_FALLBACK_MS);
            this.pauseOpen = true;
        } // its end asks for the names refused meanwhile
        else if (code === 'sidecar_down' || code === 'keychain_unavailable')
            this.down = true;
    }
    /**
     * A read failed (R8: the last value stays). The failure is kept until an answer replaces it, the read is asked again later and later
     * (its interval, doubled each time, at most MAX_BACKOFF_MS), and one log line says so the first time (the field and the reason only).
     */
    readFailed(st, key, f, asked) {
        const n = (st.failed[key]?.n ?? 0) + 1;
        st.failed[key] = { ...f, n };
        if (st.due[key] !== Infinity)
            st.due[key] = asked + Math.min(ROUTES[key].every * 2 ** (n - 1), exports.MAX_BACKOFF_MS);
        // the place fields wait for the online answer; when it fails they are read once, as without the online scope
        if (key === 'online')
            for (const k of PLACE)
                if (!st.fetched.has(k) && st.due[k] === Infinity)
                    st.due[k] = asked;
        const why = f.code === 'status' ? String(f.status) : f.code;
        if (!this.logged.has(`${key}:${why}`)) {
            this.logged.add(`${key}:${why}`);
            this.d.log?.(`presence: ${key} read failed (${why})`);
        }
    }
    /** Reschedules the place fields after an answer. */
    after(st, key, v, now) {
        if (key === 'online') {
            const on = v.online;
            st.online = on;
            for (const k of PLACE) {
                if (on) {
                    if (st.due[k] === Infinity)
                        st.due[k] = now;
                }
                else if (!st.fetched.has(k)) {
                    if (st.due[k] === Infinity)
                        st.due[k] = now;
                }
                else
                    st.due[k] = Infinity;
            }
        }
        else if (PLACE.includes(key)) {
            st.fetched.add(key);
            st.due[key] = st.online === true ? now + ROUTES[key].every : Infinity;
        }
    }
    /** Asks again for the names of every held value (a lookup may have been refused by a stop or a pause, or failed). */
    rewarm(only) {
        const now = this.d.now();
        if (!only)
            this.warmed.clear();
        // Only characters in the vault's list: a snapshot character the vault no longer holds gets no lookups, and before the first list there is nobody.
        for (const c of this.byId().values()) {
            if (only && !only.has(c.id))
                continue;
            this.warmed.add(c.id);
            const st = this.chars.get(c.id);
            if (st)
                for (const k of ['location', 'ship', 'queue']) {
                    const f = st.data[k];
                    if (f)
                        this.warm(k, f.v, now);
                }
        }
    }
    /** The name lookups failed: ask again later, once. */
    scheduleNameRetry() {
        if (!this.running || this.nameRetry !== undefined)
            return;
        this.nameRetry = this.d.timers.set(() => { this.nameRetry = undefined; if (this.running)
            this.rewarm(); }, NAME_RETRY_MS);
    }
    /** Asks the name cache for the names this value needs; the views redraw when they arrive. */
    warm(key, v, now) {
        const done = () => this.changed();
        const ask = (p) => { void p.then(r => { if (r === null)
            this.scheduleNameRetry(); done(); }, () => { }); };
        if (key === 'location') {
            const l = v;
            ask(this.d.names.system(l.systemId));
            if (l.stationId !== undefined)
                ask(this.d.names.station(l.stationId));
        }
        else if (key === 'ship')
            ask(this.d.names.type(v.typeId));
        else if (key === 'queue') {
            const cur = v.find(e => e.finish !== undefined && Date.parse(e.finish) > now);
            if (cur)
                ask(this.d.names.type(cur.skillId));
        }
    }
    changed() {
        this.lastState = this.state();
        try {
            this.d.onChange();
        }
        catch { /* a view's failure must not stop the polling */ }
    }
}
exports.PresenceService = PresenceService;
