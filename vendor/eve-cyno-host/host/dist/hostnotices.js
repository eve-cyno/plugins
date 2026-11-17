"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.REAUTH_ROW_ID = exports.VaultNotice = exports.EsiPauseNotices = exports.UPDATE_AVAILABLE = exports.UPDATE_MANUAL = exports.UPDATE_READY = exports.VAULT_NOTICE = exports.resetNotice = exports.LOCKED_NOTICE = exports.GAVE_UP_NOTICE = exports.databaseDamagedNotice = exports.VAULT_NOTICE_AFTER_MS = exports.pluginUpdatedNotice = exports.revokedNotice = exports.revokeNotSavedNotice = exports.pendingDeletesLostNotice = exports.ownerDeleteOwedNotice = exports.wipeFailedNotice = exports.OUTAGE_GAP_MS = exports.PAUSE_MERGE_MS = void 0;
exports.esiPausedNotice = esiPausedNotice;
exports.hostStatus = hostStatus;
const presence_1 = require("./presence");
const home_1 = require("./hostui/home");
exports.PAUSE_MERGE_MS = 60_000;
/** A pause that starts within this long after the earlier ones ended belongs to the same outage: its notice is updated, not repeated. */
exports.OUTAGE_GAP_MS = 10 * 60_000;
/** A revoke or an Allow reset whose wipe failed (N1): the plugin was stopped for it and runs again under the grant it had. */
const wipeFailedNotice = (name) => ({
    title: `${name} could not be reset`,
    body: 'Its stored data could not be cleared, so its permissions were not changed. Try again.',
});
exports.wipeFailedNotice = wipeFailedNotice;
/** A4: a delete of the plugin's saved character data did not finish (a file in use, a newer database); it is tried again at the next start. */
const ownerDeleteOwedNotice = (name) => ({
    title: `${name}: some data is not deleted yet`,
    body: `The delete did not finish. EVE-Cyno tries again the next time it starts, and ${name} may stay off until then.`,
});
exports.ownerDeleteOwedNotice = ownerDeleteOwedNotice;
/** The record of owed plugin-data deletes could not be read and was set aside (N2). */
const pendingDeletesLostNotice = () => ({
    title: 'Some pending deletes could not be read',
    body: 'The file that lists deletes still to do was damaged, so it was set aside. EVE-Cyno checks every plugin database again and removes the rows of characters that are gone. A request to delete a whole database file cannot be rebuilt: repeat it if you need it.',
});
exports.pendingDeletesLostNotice = pendingDeletesLostNotice;
/** A revoke the permissions file could not keep (I1): it was refused, and the plugin runs under the grant it had. */
const revokeNotSavedNotice = (name) => ({
    title: `${name}'s permission could not be revoked`,
    body: 'The permissions file could not be saved, so its permissions were not changed. Try again.',
});
exports.revokeNotSavedNotice = revokeNotSavedNotice;
/** R28: a plugin the marketplace revoked was disabled at once; nothing of its data was removed. Posted once per id and version. */
const revokedNotice = (name) => ({
    title: `${name} was revoked by the marketplace and disabled`,
    body: 'Its data stays on this computer. Remove it, or keep it disabled until a fixed version is published.',
});
exports.revokedNotice = revokedNotice;
/** R29: a plain plugin (or theme package) update was applied by itself: it asks for nothing new. One notice per update. */
const pluginUpdatedNotice = (name, version) => ({
    title: `${name} updated to ${version}`,
    body: 'No new permissions.',
});
exports.pluginUpdatedNotice = pluginUpdatedNotice;
exports.VAULT_NOTICE_AFTER_MS = 60_000;
const MAX_NAMES = 3;
const MAX_NAME = 24;
/** A plugin's database was damaged and set aside (store service, section 8): one notice per plugin per app session. The name is shortened like every notice's. */
const databaseDamagedNotice = (name) => ({
    title: `${short(name)}'s database was damaged`,
    body: `EVE-Cyno set the damaged file aside and started an empty one. ${short(name)} starts again from the beginning.`,
});
exports.databaseDamagedNotice = databaseDamagedNotice;
const pad = (n) => String(n).padStart(2, '0');
const clock = (ms) => { const d = new Date(ms); return `${pad(d.getHours())}:${pad(d.getMinutes())}`; };
const short = (s) => { const c = Array.from(s); return c.length <= MAX_NAME ? s : c.slice(0, MAX_NAME - 1).join('') + '…'; };
/** "A", "A and B", "A, B and C", "A, B, C and 2 more". */
function nameList(names) {
    const shown = names.slice(0, MAX_NAMES).map(short);
    const more = names.length - shown.length;
    if (more > 0)
        return `${shown.join(', ')} and ${more} more`;
    return shown.length <= 1 ? (shown[0] ?? '') : `${shown.slice(0, -1).join(', ')} and ${shown[shown.length - 1]}`;
}
/** One notice for the pauses that are still running at `now` (null when none is). `until` is epoch milliseconds. */
function esiPausedNotice(paused, names, now) {
    const live = paused.filter(p => p.until > now);
    if (live.length === 0)
        return null;
    const until = Math.max(...live.map(p => p.until));
    const who = nameList([...new Set(live.map(p => (p.pluginId === presence_1.HOST_ESI_ID ? 'EVE-Cyno' : names(p.pluginId))))]); // the host's own id reads EVE-Cyno, never "A plugin"
    return {
        title: 'ESI requests paused',
        body: `${who} paused until ${clock(until)} after many failed ESI requests. An ESI outage counts against every plugin, so several can pause at once.`,
    };
}
exports.GAVE_UP_NOTICE = {
    title: "EVE-Cyno's background service stopped",
    body: 'Characters, ESI, hotkeys and game logs are off until you restart EVE-Cyno.',
};
exports.LOCKED_NOTICE = {
    title: "EVE-Cyno's background service is already running",
    body: 'Another EVE-Cyno background service (cynod) still holds your data. Characters, ESI, hotkeys and game logs are off until it ends. Close any other EVE-Cyno window or command, or restart your computer, then start EVE-Cyno again.',
};
/** A5 without a prompt (an update that only adds a provided service): the plugin's stored data was cleared. */
const resetNotice = (name) => ({
    title: `${name} was reset`,
    body: 'It could see character names and can now send data out, so its stored data was cleared.',
});
exports.resetNotice = resetNotice;
exports.VAULT_NOTICE = {
    title: 'Your keychain is locked',
    body: 'Unlock it to use your characters. Thumbnails, hotkeys and logs keep working.',
};
/** The app updater (B5a): a verified update is staged and installs at the next quit. Posted once per version. */
const UPDATE_READY = (version) => ({
    title: `EVE-Cyno ${version} is ready`,
    body: 'It installs when you quit EVE-Cyno.',
});
exports.UPDATE_READY = UPDATE_READY;
/**
 * A verified newer release this copy cannot install itself (portable, dev, read-only AppImage, no file for this platform): the updater's
 * `manual` state. Posted once per version (updates.json `notified.manual`, shared with UPDATE_AVAILABLE: one of the two per version).
 */
const UPDATE_MANUAL = (version) => ({
    title: `EVE-Cyno ${version} is out`,
    body: `Download it from Discord: ${home_1.DISCORD_URL}`,
});
exports.UPDATE_MANUAL = UPDATE_MANUAL;
/** A verified newer release that waits because "Update automatically" is off (`available`): Settings > Updates has Download now. */
const UPDATE_AVAILABLE = (version) => ({
    title: `EVE-Cyno ${version} is out`,
    body: 'Download it in Settings > Updates.',
});
exports.UPDATE_AVAILABLE = UPDATE_AVAILABLE;
/**
 * Follows `esi.paused` events. A pause lasts 60 s: pauses that overlap belong to one outage and share one notice, which is updated in
 * place; a pause that starts after the earlier ones ended is a new notice. `post` returns the id of the notice it made; `update` rewrites it.
 */
class EsiPauseNotices {
    d;
    active = new Map(); // plugin id -> end of its pause
    noticeId;
    lastEnd = -Infinity; // the latest end of any pause seen
    constructor(d) {
        this.d = d;
    }
    /** The number of plugins that are paused now (the `ESI paused · N` row). */
    count() { this.prune(); return this.active.size; }
    /** The earliest end among the running pauses (epoch ms), or undefined when none runs: when the row has to be looked at again. */
    nextEnd() { this.prune(); return this.active.size === 0 ? undefined : Math.min(...this.active.values()); }
    paused(p) {
        const now = this.d.now();
        this.prune();
        const sameOutage = this.noticeId !== undefined && (this.active.size > 0 || now - this.lastEnd < exports.OUTAGE_GAP_MS);
        this.active.set(p.pluginId, p.until);
        this.lastEnd = Math.max(this.lastEnd, p.until);
        const n = esiPausedNotice([...this.active].map(([pluginId, until]) => ({ pluginId, until })), this.d.names, now);
        if (!n)
            return; // already over
        if (sameOutage && this.d.update(this.noticeId, n))
            return;
        this.noticeId = this.d.post(n);
    }
    prune() {
        const now = this.d.now();
        for (const [id, until] of [...this.active])
            if (until <= now)
                this.active.delete(id);
    }
}
exports.EsiPauseNotices = EsiPauseNotices;
/**
 * The vault notice is posted once per session, when `keychain_unavailable` has lasted 60 s without a break. `later` runs `fn` after `ms`
 * and returns a cancel function.
 */
class VaultNotice {
    d;
    cancel;
    posted = false;
    constructor(d) {
        this.d = d;
    }
    state(s) {
        const locked = !s.available && s.reason === 'keychain_unavailable';
        if (!locked) {
            this.cancel?.();
            this.cancel = undefined;
            return;
        }
        if (this.posted || this.cancel)
            return;
        this.cancel = this.d.later(() => { this.cancel = undefined; if (this.posted)
            return; this.posted = true; this.d.post(); }, exports.VAULT_NOTICE_AFTER_MS);
    }
}
exports.VaultNotice = VaultNotice;
exports.REAUTH_ROW_ID = 'vault.reauth';
/** The `ESI` row: a pause wins; then failing reads (a warn row, counts and reasons in the tooltip); else ok. */
function esiRow(s) {
    if (s.esiPaused > 0)
        return { id: 'host:esi', text: `ESI paused · ${s.esiPaused}`, tone: 'warn' };
    const f = s.esiFailing;
    if (f && f.reads > 0) {
        const reads = `${f.reads} ESI ${f.reads === 1 ? 'read' : 'reads'} failing for ${f.characters} ${f.characters === 1 ? 'character' : 'characters'}`;
        return { id: 'host:esi', text: 'ESI: some reads failing', tone: 'warn', tooltip: `${reads}: ${f.reasons.join(', ')}. Retrying.` };
    }
    return { id: 'host:esi', text: 'ESI ok', tone: 'ok' };
}
/**
 * The host's own status rows (R20, R12): ESI, the vault, the re-authorisation queue, the sidecar and the clipboard indicator.
 * `watching` holds display names; `reauth` is the number of characters waiting to sign in again (0 or absent: no row).
 */
function hostStatus(s) {
    const rows = [];
    rows.push(esiRow(s));
    if (!s.vault.available) {
        if (s.vault.reason === 'keychain_unavailable')
            rows.push({ id: 'host:vault', text: 'Vault locked', tone: 'warn' });
        else if (s.vault.reason === 'sso_unavailable')
            rows.push({ id: 'host:vault', text: 'Sign-in down', tone: 'warn' });
    }
    if ((s.reauth ?? 0) > 0)
        rows.push({ id: exports.REAUTH_ROW_ID, text: `Re-authorise ${s.reauth}`, tone: 'attention', narrow: 'Re-auth', clickable: true });
    if (s.sidecarDown)
        rows.push({ id: 'host:sidecar', text: 'Service stopped', tone: 'bad' });
    // Q9: one watcher is "Clipboard", several "Clipboard · <n>" (the names are in the tooltip), and a sign-in round that holds the clipboard
    // is "Clipboard paused" in tone `warn`. The names go to the tooltip only, never to the text.
    if (s.watching.length > 0) {
        const tooltip = s.watching.join(', ');
        if (s.clipboardPaused === true)
            rows.push({ id: 'host:clipboard', text: 'Clipboard paused', tone: 'warn', tooltip });
        else
            rows.push({ id: 'host:clipboard', text: s.watching.length === 1 ? 'Clipboard' : `Clipboard · ${s.watching.length}`, tone: 'ok', tooltip });
    }
    return rows;
}
