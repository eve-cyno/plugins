"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.couldSeeNames = void 0;
exports.needsReset = needsReset;
exports.filterStorage = filterStorage;
exports.wipePlugin = wipePlugin;
const windowsview_1 = require("./windowsview");
/**
 * The grant lets the plugin see names, and it has no way to send data out: window thumbnails, hotkeys or overlays (character names), game
 * events (other players' names, spec 4.4) or chat channels (the authors and what they wrote, C4). `revoked`: the parts the user took back. A revoked
 * `gameEvents` or `chatlogs` grant still counts, because the plugin saw names while it held it and what it stored may hold them; the revoke does not
 * clear that, a later way out does. A built-in plugin with a way out reads chat by the `chat` rule and is not sealed, so it is not covered here.
 */
const couldSeeNames = (g, provides, revoked = []) => (g.flags.windows || g.flags.windowThumbnails || g.flags.hotkeys || g.flags.overlays || g.gameEvents.length > 0 || revoked.includes('gameEvents') || g.logs.includes('chatlogs') || revoked.includes('chatlogs')) && !(0, windowsview_1.canSendOut)(g, provides);
exports.couldSeeNames = couldSeeNames;
/**
 * True when the previous state could see names and the next one can send data out. No previous state: nothing to clear. `sawNames` carries the first half
 * across updates: a version that drops the kind leaves what the plugin stored where it was, so a later way out must still clear it.
 */
function needsReset(prev, next) {
    return prev !== undefined && (prev.sawNames === true || (0, exports.couldSeeNames)(prev.g, prev.provides, prev.revoked)) && (0, windowsview_1.canSendOut)(next.g, next.provides);
}
/**
 * What survives the wipe: `__settings` (only the user writes it) and the `__overlays` pairs whose key the host issued to the plugin as a
 * character key. Every other key goes.
 */
function filterStorage(data, issued) {
    const out = {};
    if (Object.hasOwn(data, '__settings'))
        out.__settings = data.__settings;
    const ov = data.__overlays;
    if (Array.isArray(ov)) {
        const kept = ov.filter(p => Array.isArray(p) && p.length === 2 && typeof p[0] === 'string' && issued.has(p[0]));
        if (kept.length > 0)
            out.__overlays = kept;
    }
    return out;
}
/**
 * The A5 wipe (R13): storage keeps `__settings` and the overlay positions saved under host-issued keys, everything else goes, and the
 * partition is cleared, and the database file goes through the owner-delete layer (A4, E5; `database`). Logs the token only (never the plugin id). A throw means the plugin was not wiped: the caller does not start it.
 */
async function wipePlugin(d, pluginId, prompted, mode = 'reset') {
    try {
        if (mode === 'reset')
            await d.database?.(pluginId); // E5: the whole database file first; a failure is a failed wipe and the old grant stays
        const st = d.storage(pluginId);
        st.replaceAll(filterStorage(st.snapshot(), d.issued(pluginId)));
        await d.clearPartition(pluginId);
        d.clearHostTexts?.(pluginId);
        d.dropJobs?.(pluginId);
    }
    catch (e) {
        console.warn('PLUGIN_RESET_FAILED');
        try {
            d.failed?.(pluginId);
        }
        catch { /* the notice must not hide the error */ }
        throw e;
    }
    console.warn('PLUGIN_RESET');
    if (!prompted)
        d.notice(pluginId);
}
