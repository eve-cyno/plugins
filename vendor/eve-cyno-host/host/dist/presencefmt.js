"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.wallet = wallet;
exports.duration = duration;
exports.securityTag = securityTag;
exports.location = location;
exports.ship = ship;
exports.onlineFor = onlineFor;
exports.skill = skill;
exports.queueText = queueText;
exports.meter = meter;
exports.readFailure = readFailure;
exports.initials = initials;
const MIN = 60_000, DAY = 86_400_000;
const ROMAN = ['', 'I', 'II', 'III', 'IV', 'V'];
/** `1.84 B ISK`, `612 M ISK`, `9.7 M ISK`, `850 K ISK`, `512 ISK`. */
function wallet(n) {
    if (!Number.isFinite(n))
        return '—';
    const sign = n < 0 ? '-' : '';
    const a = Math.abs(n);
    const trim = (v, dec) => String(Number(v.toFixed(dec)));
    const units = [[1e9, 'B'], [1e6, 'M'], [1e3, 'K']];
    for (let i = 0; i < units.length; i++) {
        const [size, unit] = units[i];
        if (a < size)
            continue;
        const v = a / size;
        const text = unit === 'B' ? trim(v, 2) : v >= 10 ? String(Math.round(v)) : trim(v, 1);
        if (unit !== 'B' && Number(text) >= 1000 && i > 0)
            return `${sign}${trim(a / units[i - 1][0], units[i - 1][1] === 'B' ? 2 : 1)} ${units[i - 1][1]} ISK`; // 999.96 K rounds up to the next unit
        return `${sign}${text} ${unit} ISK`;
    }
    return `${sign}${Math.floor(a)} ISK`; // under 1 000 it never rounds up into the next unit
}
/** The two largest units of d, h, min; under a minute `<1 min`. */
function duration(ms) {
    const total = Math.floor(Math.max(0, Number.isFinite(ms) ? ms : 0) / MIN);
    const d = Math.floor(total / 1440), h = Math.floor((total % 1440) / 60), m = total % 60;
    if (d > 0)
        return h > 0 ? `${d} d ${h} h` : `${d} d`;
    if (h > 0)
        return m > 0 ? `${h} h ${m} min` : `${h} h`;
    return m > 0 ? `${m} min` : '<1 min';
}
const isAbyssal = (systemId) => systemId >= 12_000_000 && systemId <= 12_999_999;
const isWormhole = (systemId) => systemId >= 31_000_000 && systemId <= 31_999_999;
/** `high-sec`, `low-sec`, `null-sec` from the security status rounded to one decimal; `wormhole` for a wormhole system. */
function securityTag(sec, systemId) {
    if (isWormhole(systemId))
        return 'wormhole';
    if (sec === undefined || !Number.isFinite(sec))
        return '';
    if (sec <= 0)
        return 'null-sec';
    const shown = sec < 0.05 ? 0.1 : Math.floor(sec * 10 + 0.5 + 1e-9) / 10; // EVE shows 0.0 < sec < 0.05 as 0.1; otherwise round half up
    return shown >= 0.5 ? 'high-sec' : 'low-sec';
}
/** Where the character is; offline: the last known place plus `, last seen <duration> ago`. `now` is the caller's clock. */
function location(raw, names, now) {
    const loc = raw.location?.v;
    let place = '';
    if (loc) {
        const sys = names.system(loc.systemId);
        if (isAbyssal(loc.systemId))
            place = 'Abyssal space';
        else if (loc.structureId !== undefined)
            place = sys ? `${sys.name}, in a structure` : 'In a structure';
        else if (loc.stationId !== undefined)
            place = names.station(loc.stationId) ?? (sys ? `${sys.name}, docked` : 'Docked');
        else if (sys)
            place = sys.regionName ? `${sys.name}, ${sys.regionName}` : sys.name;
    }
    const on = raw.online?.v;
    if (on && !on.online && on.lastLogout) {
        const t = Date.parse(on.lastLogout);
        if (Number.isFinite(t)) {
            const seen = `last seen ${duration(now - t)} ago`;
            return place ? `${place}, ${seen}` : `Last seen ${duration(now - t)} ago`;
        }
    }
    return place;
}
/** The ship's type name; the hover card passes `withWhere` for `, in space` or `, docked`. */
function ship(raw, names, withWhere = false) {
    const s = raw.ship?.v;
    if (!s)
        return '';
    const name = names.type(s.typeId);
    if (!name)
        return '';
    if (!withWhere)
        return name;
    const loc = raw.location?.v;
    if (!loc)
        return name;
    return `${name}, ${loc.stationId !== undefined || loc.structureId !== undefined ? 'docked' : 'in space'}`;
}
/** `<duration> online` from `last_login`. */
function onlineFor(lastLogin, now) {
    const t = lastLogin === undefined ? NaN : Date.parse(lastLogin);
    return Number.isFinite(t) ? `${duration(now - t)} online` : '';
}
const finishOf = (e) => (e.finish === undefined ? NaN : Date.parse(e.finish));
const current = (queue, now) => queue.find(e => finishOf(e) > now);
/** The skill in training: `<name> <Roman level>` and the time left; null when nothing is in training. */
function skill(queue, names, now) {
    const e = current(queue, now);
    if (!e)
        return null;
    return { text: `${names.type(e.skillId) ?? 'Skill'} ${ROMAN[e.level] ?? String(e.level)}`, left: duration(finishOf(e) - now) };
}
/** `<n> d queue`, or `Queue empty in <duration>` (warn) under 48 h, or `No skill in training` (warn). */
function queueText(queue, now) {
    const ends = queue.map(finishOf).filter(t => t > now);
    if (ends.length === 0)
        return { text: 'No skill in training', warn: true };
    const last = Math.max(...ends);
    const left = last - now;
    if (left < 2 * DAY)
        return { text: `Queue empty in ${duration(left)}`, warn: true };
    return { text: `${Math.floor(left / DAY)} d queue`, warn: false };
}
/** The share (0 to 1) of the current skill's training time that has passed. */
function meter(queue, now) {
    const e = current(queue, now);
    if (!e || e.start === undefined)
        return 0;
    const start = Date.parse(e.start), end = finishOf(e);
    if (!Number.isFinite(start) || end <= start)
        return 0;
    return Math.min(1, Math.max(0, (now - start) / (end - start)));
}
/** A failed read in plain words, for "Could not read from ESI: <reason>. Retrying." (R8). No id, no name: the code and the HTTP status only. */
function readFailure(f) {
    if (f.code === 'status') {
        const s = f.status ?? 0;
        if (s === 401 || s === 403)
            return `access refused (${s})`;
        if (s === 404)
            return `not found (${s})`;
        if (s === 420 || s === 429)
            return `too many requests (${s})`;
        if (s >= 500 && s <= 599)
            return `ESI server error (${s})`;
        if (s > 0)
            return `unexpected answer (${s})`;
    }
    switch (f.code) {
        case 'status':
        case 'unreadable': return 'an answer EVE-Cyno cannot read';
        case 'timeout': return 'no answer in time';
        case 'rate_limited': return 'too many requests';
        case 'bad_params': return 'the request was not accepted';
        case 'not_permitted': return 'the request was not permitted';
        case 'unknown_character': return 'the character is not in the keychain';
        case 'sso_unavailable': return 'the EVE sign-in cannot be reached';
        default: return 'the connection failed'; // cynod's `internal`: the request did not reach ESI or its answer did not come back
    }
}
/** The first letter of the first two words, upper case. */
function initials(name) {
    const words = name.trim().split(/\s+/).filter(Boolean).slice(0, 2);
    const out = words.map(w => Array.from(w)[0].toUpperCase()).join('');
    return out || '?';
}
