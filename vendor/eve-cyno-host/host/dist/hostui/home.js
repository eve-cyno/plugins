"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.HomeModel = exports.DISCORD_URL = void 0;
exports.registerHome = registerHome;
// The home model: what the grid of plugin tiles, the rail and the full plugin view show about each plugin, and the page's calls
// on them (`home.*`, `plugin.*`). Reads only plugins that are registered. Every handler builds its arguments from picked,
// type-checked fields; the Discord address is fixed here and never comes from the page.
const errors_1 = require("../errors");
const appearance_1 = require("../appearance");
const permtext_1 = require("../permtext");
exports.DISCORD_URL = 'https://discord.gg/XZzkH38dt9';
const CHANGE_DEBOUNCE_MS = 50;
class HomeModel {
    d;
    views = new Map(); // the newest view event of each plugin: `crashed` outlives the registry's `stopped`
    fns = [];
    timer;
    sig; // the item list the listeners last heard about
    constructor(d) {
        this.d = d;
        d.registry.onState((id, state) => { if (state === 'disabled')
            this.views.delete(id); this.changed(); });
        d.host.onView(e => {
            if (e.state === 'ready' || e.state === 'stopped')
                this.views.delete(e.pluginId);
            else
                this.views.set(e.pluginId, e.state);
            this.changed();
        });
        d.tiles.onChange(() => this.changed());
        d.prefs.onChange(() => this.changed());
        d.contributions.onContext(() => this.changed());
    }
    /** A start the host attempted for a window failed: the plugin shows the crash panel (with Restart) until it runs again. */
    fail(id) { this.views.set(id, 'crashed'); this.changed(); }
    /** `fn` runs after a change, at most once per 50 ms. */
    onChange(fn) { this.fns.push(fn); }
    /** Announces a change (the owner of `popped` or `consentPending` calls this when their answer moves). */
    changed() {
        if (this.timer !== undefined)
            return;
        this.timer = setTimeout(() => {
            this.timer = undefined;
            const sig = JSON.stringify(this.items());
            if (sig === this.sig)
                return; // nothing a page shows has changed
            this.sig = sig;
            for (const fn of [...this.fns]) {
                try {
                    fn();
                }
                catch { /* a listener must not stop the others */ }
            }
        }, CHANGE_DEBOUNCE_MS);
        this.timer.unref();
    }
    /** Home order: the saved order (registered plugins only), then the other plugins by name. */
    items() {
        const all = this.d.registry.list().map(e => e.id);
        const known = new Set(all);
        const saved = this.d.prefs.order().filter(id => known.has(id));
        const rest = all.filter(id => !saved.includes(id)).map(id => ({ id, name: this.d.registry.manifestOf(id)?.name ?? id }))
            .sort((a, b) => a.name.localeCompare(b.name) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)).map(x => x.id);
        const out = [];
        for (const id of [...saved, ...rest]) {
            const it = this.item(id);
            if (it)
                out.push(it);
        }
        return out;
    }
    /** The state the pages show for the plugin. */
    stateOf(id) {
        const rs = this.d.registry.state(id);
        if (rs === 'disabled' && this.d.registry.disabledBy(id) === 'revoked')
            return 'revoked'; // R28: before anything else (it offers no Review, no Enable)
        if (rs !== 'running' && this.d.consentPending(id))
            return 'needsConsent'; // a prompt waits, or a denied version can be asked again
        if (rs === 'disabled')
            return 'disabled';
        const v = this.views.get(id);
        if (v === 'crashed')
            return 'crashed';
        if (v === 'restarting')
            return 'starting';
        return rs === 'running' ? 'running' : rs === 'starting' ? 'starting' : rs === 'suspended' ? 'suspended' : 'stopped';
    }
    item(id) {
        const m = this.d.registry.manifestOf(id);
        if (!m)
            return undefined;
        let tile;
        let context;
        const state = this.stateOf(id);
        try {
            const t = this.d.contributions.tile(id);
            if (t) {
                const { context: _c, ...summary } = t;
                tile = summary;
            }
            // M:9 board 3: a revoked plugin's last summary stays (dimmed by the page), without its badge and with no severity of its own.
            if (tile && state === 'revoked') {
                const { badge: _b, ...rest } = tile;
                tile = { ...rest, severity: 'normal' };
            }
            context = this.d.contributions.tileContext(id);
        }
        catch { /* not registered with the contributions (yet): no summary */ }
        return {
            id, name: m.name, version: m.version, colorClass: (0, appearance_1.paletteClass)(m), icon: (0, appearance_1.iconFor)(m), state,
            ...(tile ? { tile } : {}), ...(context !== undefined ? { context } : {}),
            ...(m.contributes.tile?.action ? { quickAction: m.contributes.tile.action.label } : {}),
            popped: this.d.popped(id), permCount: this.permissions(id).filter(l => l.kind !== 'storage').length, muted: this.d.prefs.isMuted(id),
            canNotify: this.d.host.grants.get(id)?.granted.flags.notifications === true, ...this.updateOf(id),
        };
    }
    // R29: the update on offer (a revoked plugin keeps its fix on offer); a throw shows none.
    updateOf(id) {
        try {
            const u = this.d.updateOf?.(id);
            return u ? { update: { version: u.version, review: u.review === true } } : {};
        }
        catch {
            return {};
        }
    }
    /** The permission lines of the plugin's current grant (none without a grant). */
    permissions(id) {
        const m = this.d.registry.manifestOf(id);
        const g = this.d.host.grants.get(id)?.granted;
        if (!m || !g)
            return [];
        return (0, permtext_1.permLines)(g, {
            background: m.background === true, providers: this.d.host.services.providersFor(m), provides: (m.contributes.services?.length ?? 0) > 0,
            providerNames: pid => this.d.registry.manifestOf(pid)?.name ?? pid, characterCount: x => x.selected.length,
        });
    }
}
exports.HomeModel = HomeModel;
const isObj = (v) => typeof v === 'object' && v !== null && !Array.isArray(v);
/** Registers the `home.*` and `plugin.*` calls and pushes `home.changed` to every host page. */
function registerHome(server, model, d) {
    const log = d.log ?? (() => { });
    // The plugin id of a call: a string naming a registered plugin.
    const pick = (p) => {
        const id = isObj(p) ? p.id : undefined;
        if (typeof id !== 'string' || id.length === 0 || id.length > 256)
            throw (0, errors_1.coded)('bad_params', 'id');
        if (d.registry.state(id) === undefined)
            throw (0, errors_1.coded)('not_found', 'plugin');
        return id;
    };
    // Slow actions (a consent prompt, a page start) are not awaited: the reply is immediate and the state event updates the page.
    const later = (what, p) => { p.catch(e => log(`${what} failed: ${String(e?.code ?? 'error')}`)); };
    server.register('home.list', () => model.items());
    server.register('home.reorder', p => {
        const ids = isObj(p) ? p.ids : undefined;
        if (!Array.isArray(ids) || ids.length > 512)
            throw (0, errors_1.coded)('bad_params', 'ids');
        const known = new Set(d.registry.list().map(e => e.id));
        const picked = [];
        for (const id of ids) {
            if (typeof id !== 'string' || !known.has(id))
                throw (0, errors_1.coded)('bad_params', 'ids');
            if (!picked.includes(id))
                picked.push(id);
        }
        // Plugins missing from the page's list keep their relative order after the listed ones.
        const rest = model.items().map(i => i.id).filter(id => !picked.includes(id));
        d.prefs.setOrder([...picked, ...rest]);
    });
    server.register('plugin.open', p => {
        const id = pick(p);
        const s = d.registry.state(id);
        if (s === 'disabled')
            throw (0, errors_1.coded)('unavailable', 'plugin is disabled');
        // A crashed plugin (the registry says `stopped` after the crash limit) waits for the user's Restart.
        if ((s === 'stopped' || s === 'suspended') && model.stateOf(id) !== 'crashed')
            later('plugin.open', d.host.restart(id)); // the view needs a page; a crashed one waits for Restart
        if (d.popouts.isOpen(id))
            later('plugin.open', d.popouts.open(id)); // the view lives in its own window: that window comes to the front
    });
    server.register('plugin.wake', p => {
        const id = pick(p);
        const s = d.registry.state(id);
        if ((s === 'stopped' || s === 'suspended') && model.stateOf(id) !== 'crashed')
            later('plugin.wake', d.wake(id));
    });
    server.register('plugin.popout', p => {
        const id = pick(p);
        const s = d.registry.state(id);
        if (s === 'disabled')
            throw (0, errors_1.coded)('unavailable', 'plugin is disabled');
        if ((s === 'stopped' || s === 'suspended') && model.stateOf(id) !== 'crashed')
            later('plugin.popout', d.host.restart(id));
        later('plugin.popout', d.popouts.open(id));
    });
    server.register('plugin.quick', p => {
        const id = pick(p);
        const action = d.registry.manifestOf(id)?.contributes.tile?.action;
        if (!action)
            throw (0, errors_1.coded)('not_found', 'quick action');
        later('plugin.quick', d.contributions.invoke(id, action.command));
    });
    server.register('plugin.restart', p => {
        const id = pick(p);
        if (d.registry.state(id) === 'disabled')
            throw (0, errors_1.coded)('unavailable', 'plugin is disabled');
        later('plugin.restart', d.host.restart(id));
    });
    server.register('plugin.enable', (p, _from, _wc, meta) => {
        const id = pick(p);
        const on = isObj(p) ? p.on : undefined;
        if (typeof on !== 'boolean')
            throw (0, errors_1.coded)('bad_params', 'on');
        if (on && !meta.gesture)
            throw (0, errors_1.coded)('not_permitted', 'enabling a plugin needs a user gesture'); // it may open the consent prompt; off needs none (GP-I3)
        later('plugin.enable', d.registry.setEnabled(id, on)); // waits for a consent prompt when enabling
    });
    server.register('plugin.reload', p => { later('plugin.reload', d.registry.reload(pick(p))); });
    server.register('plugin.review', (p, _from, _wc, meta) => {
        const id = pick(p);
        if (!meta.gesture)
            throw (0, errors_1.coded)('not_permitted', 'reviewing permissions needs a user gesture'); // it clears a stored denial and asks again (GP-I3)
        if (d.prompts?.has(id))
            d.prompts.front(id);
        else
            later('plugin.review', d.registry.reconsider(id));
    });
    server.register('plugin.permissions', p => model.permissions(pick(p)));
    server.register('plugin.report', p => { pick(p); later('plugin.report', d.openExternal(exports.DISCORD_URL)); });
    model.onChange(() => server.emit('home.changed', model.items())); // every host page follows (the main page and the pop-outs)
}
