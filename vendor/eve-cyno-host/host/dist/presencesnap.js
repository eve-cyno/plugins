"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.PresenceSnapshot = exports.SNAPSHOT_EVERY_MS = exports.FIELD_KEYS = void 0;
exports.sanitize = sanitize;
// The on-disk snapshot of the presence service (R22): the last raw values per character, with their times, in <userData>/presence.json.
// It holds the user's own wallet and location: never logged, never sent anywhere. Written at most once per 30 s, atomically. A corrupt file is
// deleted (a cache ESI rebuilds, and a copy would keep wallet and location data); a file that stays locked (Windows) means memory only
// for the session. Pure Node (no Electron).
const atomicfile_1 = require("./atomicfile");
const presencefile_1 = require("./presencefile");
exports.FIELD_KEYS = ['online', 'location', 'ship', 'wallet', 'queue'];
exports.SNAPSHOT_EVERY_MS = 30_000;
const MAX_QUEUE = 200;
const isNum = (x) => typeof x === 'number' && Number.isFinite(x);
const isId = (x) => typeof x === 'number' && Number.isSafeInteger(x) && x > 0;
const isStr = (x) => typeof x === 'string' && x.length <= 64;
const rec = (x) => (typeof x === 'object' && x !== null && !Array.isArray(x) ? x : undefined);
function stamped(x, v) {
    const o = rec(x);
    if (!o || !isNum(o.at))
        return undefined;
    const value = v(o.v);
    return value === undefined ? undefined : { v: value, at: o.at };
}
const optStr = (x) => (isStr(x) ? x : undefined);
/** Keeps only well-formed fields of a stored entry. */
function sanitize(raw) {
    const o = rec(raw) ?? {};
    const out = {};
    const online = stamped(o.online, x => { const r = rec(x); return r && typeof r.online === 'boolean' ? { online: r.online, lastLogin: optStr(r.lastLogin), lastLogout: optStr(r.lastLogout) } : undefined; });
    if (online)
        out.online = online;
    const location = stamped(o.location, x => { const r = rec(x); return r && isId(r.systemId) ? { systemId: r.systemId, stationId: isId(r.stationId) ? r.stationId : undefined, structureId: isId(r.structureId) ? r.structureId : undefined } : undefined; });
    if (location)
        out.location = location;
    const ship = stamped(o.ship, x => { const r = rec(x); return r && isId(r.typeId) ? { typeId: r.typeId } : undefined; });
    if (ship)
        out.ship = ship;
    const wallet = stamped(o.wallet, x => (isNum(x) ? x : undefined));
    if (wallet)
        out.wallet = wallet;
    const queue = stamped(o.queue, x => {
        if (!Array.isArray(x) || x.length > MAX_QUEUE)
            return undefined;
        const q = [];
        for (const e of x) {
            const r = rec(e);
            if (!r || !isId(r.skillId) || !isNum(r.level))
                return undefined;
            q.push({ skillId: r.skillId, level: r.level, start: optStr(r.start), finish: optStr(r.finish) });
        }
        return q;
    });
    if (queue)
        out.queue = queue;
    return out;
}
const dataOf = (raw) => {
    const out = {};
    for (const k of exports.FIELD_KEYS) {
        const f = raw[k];
        if (f)
            out[k] = { v: f.v, at: f.at };
    }
    return out;
};
const codeOf = (e) => e?.code ?? 'error';
class PresenceSnapshot {
    file;
    now;
    write;
    io;
    map = new Map();
    dirty = false;
    lastWrite = -Infinity;
    locked = false;
    warned = false;
    constructor(file, now, write = atomicfile_1.writeFileAtomic, io) {
        this.file = file;
        this.now = now;
        this.write = write;
        this.io = io;
    }
    /** Reads the file (once is enough: the service calls it at construction). A missing or corrupt (deleted) file is empty; a locked one is left alone. */
    load() {
        this.map = new Map();
        const r = (0, presencefile_1.readCache)(this.file, v => rec(v) !== undefined, this.io);
        if (r.status === 'busy') {
            this.locked = true;
            console.warn('presence: snapshot locked, memory only');
            return new Map();
        }
        if (r.status !== 'ok')
            return new Map(); // missing, or corrupt and deleted
        const chars = rec(rec(r.value)?.characters);
        if (!chars)
            return new Map();
        for (const [k, v] of Object.entries(chars)) {
            const id = Number(k);
            if (!isId(id))
                continue;
            const d = sanitize(v);
            if (Object.keys(d).length > 0)
                this.map.set(id, d);
        }
        return new Map(this.map);
    }
    put(characterId, raw) {
        this.map.set(characterId, dataOf(raw));
        this.dirty = true;
        this.maybeWrite();
    }
    /** Drops every character not in `ids`; the file follows on the next write. */
    keep(ids) {
        for (const id of [...this.map.keys()])
            if (!ids.has(id)) {
                this.map.delete(id);
                this.dirty = true;
            }
    }
    flush() { if (this.dirty)
        this.writeNow(); }
    maybeWrite() { if (this.now() - this.lastWrite >= exports.SNAPSHOT_EVERY_MS)
        this.writeNow(); }
    writeNow() {
        if (this.locked)
            return;
        this.lastWrite = this.now();
        const characters = {};
        for (const [id, d] of this.map)
            characters[String(id)] = d;
        try {
            this.write(this.file, JSON.stringify({ version: 1, characters }));
            this.dirty = false;
        }
        catch (e) {
            if (!this.warned) {
                this.warned = true;
                console.warn(`presence: snapshot not saved (${codeOf(e)}), memory only`);
            }
        }
    }
}
exports.PresenceSnapshot = PresenceSnapshot;
