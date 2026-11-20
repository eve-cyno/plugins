/** Error codes a rejected call carries. */
export type ErrorCode = 'not_permitted' | 'bad_params' | 'not_found' | 'unavailable' | 'timeout' | 'rate_limited' | 'too_large' | 'service_conflict' | 'internal';
/** Shape a rejected call carries. */
export interface HostError {
    code: ErrorCode;
    message: string;
    /**
     * 1.27.0 (`^1.27`). Epoch milliseconds. Set only on the `unavailable` rejection of `data.getPack` and `data.packVersion` for `market.hubs` while the host holds no copy and
     * the last download failed: the earliest time the host downloads again (see `DataPackInfo.retryAt`). Every other rejection has `code` and `message` only.
     */
    retryAt?: number;
}
/** A capability a plugin can test for in `host.capabilities().features`. */
export type Feature = 'characters' | 'esi' | 'logs' | 'storage' | 'commands' | 'settings' | 'status' | 'tile' | 'services' | 'notifications' | 'clipboard' | 'windows' | 'overlays' | 'thumbnails' | 'hotkeys' | 'theme' | 'ai' | 'account' | 'files' | 'gamelog' | 'data' | 'dataapi' | 'chat' | 'db' | 'fit' | 'permissions' | 'window';
/** A property of `eveCyno`: every feature, plus `host` which is always there. */
export type Namespace = 'host' | Feature;
export interface Capabilities {
    /** Host API version. */
    api: string;
    /** True when the namespace exists for this plugin: granted by the user and implemented by this host. */
    features: Record<Feature, boolean>;
    /** Interfaces this plugin may call, interface id -> installed version. */
    services: Record<string, string>;
}
export interface CharacterInfo {
    id: number;
    name: string;
}
export interface EsiGetParams {
    characterId: number;
    /** The route path: no trailing slash and no query (`/characters/1/assets`). A trailing slash, `?`, `#`, `//`, `..` or a path without a leading `/` is `bad_params`. */
    path: string;
    /**
     * API 1.10.0 (`^1.10`). Query parameters, at most 4 keys, each value a number or boolean (`page` and `from_id` are whole numbers, `include_completed` is a boolean). The path itself never holds a `?`. The broker keeps a list of the
     * keys each route accepts: `page` (assets, wallet journal, order history, contracts and, for a corporation, assets, orders, order history and industry jobs),
     * `from_id` (wallet transactions) and `include_completed` (industry jobs). A key the route does not list, a value out of range or a query on another route is `bad_params`.
     * API 1.27.0 (`^1.27`): the list also holds these keys, guaranteed from 1.27.0 only (an older host may answer `bad_params` for them): `page` on the blueprints of a character and of a corporation and on
     * `/markets/structures/{structure_id}`, and, on the public route `/markets/{region_id}/orders`, `type_id` (a whole number from 1 to 2147483647) and `page`. `type_id` is required there: a call to that route with no
     * query, or without `type_id`, is `bad_params`, and the broker adds `order_type=all` itself. A 403 on `/markets/structures/{structure_id}` (the character cannot see that market) is a normal answer: it stays out of
     * the 30-error pause and counts in the same window as the 403s on `/universe/structures/{structure_id}`, 20 in 60 seconds, then `rate_limited`.
     */
    query?: Record<string, number | boolean>;
}
export interface EsiResult {
    status: number;
    body: unknown;
    /** API 1.10.0. ESI's `X-Pages` (how many pages the route has), or `null` when the answer carries none. */
    pages: number | null;
    /** API 1.10.0. ESI's `Last-Modified` in epoch milliseconds, or `null`. */
    lastModified: number | null;
    /** API 1.10.0. ESI's `ETag`, or `null`. */
    etag: string | null;
    /** API 1.10.0. When the answer expires (ask again after this), epoch milliseconds, or `null` when ESI named no expiry. A cached answer gives the stored expiry. */
    expiresAt: number | null;
    /** API 1.10.0. True when the broker answered from its cache. */
    fromCache: boolean;
}
/** The read-only lookups of `esi.lookup` (API 1.10.0). ESI takes the ids of these in a POST body; the host sends nothing else. */
export type EsiLookupKind = 'character_asset_names' | 'character_asset_locations' | 'corporation_asset_names' | 'corporation_asset_locations' | 'universe_names';
export interface EsiLookupParams {
    kind: EsiLookupKind;
    /** The character whose token signs the call (any allowed character for `universe_names`, which needs no scope). */
    characterId: number;
    /** Required for the two `corporation_*` kinds, refused for the others. */
    corporationId?: number;
    /** 1 to 1000 positive integers. */
    ids: number[];
}
export interface EsiLookupResult {
    status: number;
    body: unknown;
}
export interface GamelogLine {
    characterId: number;
    line: string;
}
/**
 * Texts a plugin shows in the host UI (status text, tooltip, tile text and context) are plain one-line text: no newline, no
 * control, bidi or zero-width characters, at least one visible character. A text that breaks the rule is `bad_params`.
 */
export interface StatusItemParams {
    /** One of the ids in `contributes.statusItems`; any other id is `not_found`. */
    id: string;
    /** 1 to 80 characters. */
    text: string;
    /** 1 to 200 characters. */
    tooltip?: string;
    /** One of the plugin's own command ids (clicking the item runs it); any other id is `not_found`. */
    command?: string;
}
/** How the host marks a tile: `normal` is plain, `attention` and `alert` draw the eye (1.0.0-beta.4; replaces `info | warn | alert`). */
export type TileSeverity = 'normal' | 'attention' | 'alert';
/**
 * The summary on the plugin's tile (1.0.0-beta.4). Longer text is cut to the limit and ends with "…"; more than 3 lines,
 * a control character or an unknown severity is `bad_params`. Every call replaces the whole summary.
 */
export interface TileSummaryParams {
    /** 1 to 40 characters. */
    title?: string;
    /** At most 3 lines of 1 to 60 characters. */
    lines?: string[];
    /** Default `normal`. */
    severity?: TileSeverity;
    /** 1 to 8 characters. */
    badge?: string;
}
/** Namespaces the host reserves but does not implement in API 1.0 yet; `features.<name>` stays false. */
export type Reserved = Record<string, never>;
export interface HostNamespace {
    capabilities(): Promise<Capabilities>;
    /**
     * Opens a link in the user's browser (1.6.0, `^1.6`). A zKillboard kill page only, `https://zkillboard.com/kill/<id>/`, from the main page,
     * one user gesture per call: this is no way out for a plugin without `network`.
     */
    openLink(params: {
        url: string;
    }): Promise<true>;
}
/** A named set of characters the user made in the host. Member ids only: no character names. */
export interface CharacterGroup {
    id: string;
    name: string;
    /** Only the characters this plugin may see (its grant, and the vault). */
    characterIds: number[];
}
export interface CharactersNamespace {
    /**
     * The characters this plugin may see (its grant, and the vault), in the user's order (the order set in Settings > Characters); a character the order
     * does not list follows the listed ones, in the vault's order. The host reads the order on every call; there is no change event for it.
     */
    list(): Promise<CharacterInfo[]>;
    /**
     * The user's character groups, each narrowed to the characters this plugin may see; a group with none of them is left out. Each group's `characterIds` come in
     * the user's order; members the order does not list follow the listed ones and keep the group's stored order.
     */
    groups(): Promise<CharacterGroup[]>;
    /**
     * A character's portrait as a `data:image/png;base64,` or `data:image/jpeg;base64,` URL (1.7.0, `^1.7`), or `null` while the host cannot get it (offline, not an image,
     * too large). Only a character `list()` returns; any other id is `not_found`, the same answer as for an unknown character. The host fetches and caches the image; the plugin
     * needs no `network`. Needs `permissions.characters` other than `none`.
     */
    portrait(params: {
        characterId: number;
    }): Promise<string | null>;
    /**
     * Shows the host's main window (1.17.0, `^1.17`): the Characters page focused on `characterId`, or with `reauth: true` the re-authorisation
     * dialog of that character (to add the ESI scopes the plugin was granted later). Without params the Characters page alone. Main page only,
     * one user gesture per call (else `not_permitted`). `characterId` must be a character `list()` returns; any other id is `not_found`, the same
     * answer as for an unknown character. `reauth: true` without `characterId` is `bad_params`; the dialog names the plugin that asked. Resolves `true`
     * once the host has taken the request (the window and the page follow); the answer says nothing about the vault or what the user does next.
     */
    open(params?: {
        characterId?: number;
        reauth?: boolean;
    }): Promise<true>;
}
/** Needs `permissions.characters` other than `none` and at least one granted scope in `permissions.esi`. */
export interface EsiNamespace {
    get(params: EsiGetParams): Promise<EsiResult>;
    /**
     * API 1.10.0 (`^1.10`). A read-only lookup by id list: asset names and locations of a character or corporation, and `/universe/names`. You name a `kind`; the host
     * and cynod own the route, the method (POST) and the scope. The kinds need `esi-assets.read_assets.v1` (character) or `esi-assets.read_corporation_assets.v1`
     * (corporation) in `permissions.esi` and on the token; `universe_names` needs no scope. Same errors, rate share and pause as `get`; a character this plugin may not see is
     * `not_found`. Nothing is cached. The answer is `{ status, body }`.
     */
    lookup(params: EsiLookupParams): Promise<EsiLookupResult>;
    /**
     * API 1.6.0. Sets one autopilot waypoint in the character's client. Needs the scope `esi-ui.write_waypoint.v1` in `permissions.esi` and on the character's
     * token, the main page, and one user gesture per call: without one, `not_permitted`. A character without the scope is also `not_permitted`, and its message
     * says to re-authorise. A character this plugin may not see is `not_found`. The credit is kept when the params are wrong.
     */
    setWaypoint(params: EsiWaypointParams): Promise<true>;
    /**
     * API 1.8.0 (`^1.8`). Sets autopilot waypoints for several characters under ONE user gesture: the destinations go to each character in the order given, appended
     * (`addToBeginning` is never set); `clearOtherWaypoints` applies to the first destination of each character only. Same needs as `setWaypoint`: the scope in
     * `permissions.esi`, the main page, a gesture. Limits: 1 to 20 unique `characterIds`, 1 to 50 `destinationIds`, at most 200 waypoints in all (`bad_params`).
     * A call that is wrong as a whole fails with `bad_params`, `not_found` (a character this plugin may not see) or `not_permitted` (no scope in the manifest, no gesture, not the main page), and the gesture is kept. The host waits out ESI's per-plugin rate share (cynod refills one token a second per plugin and character), so a route of 40 waypoints takes about half a minute per character. Once the sending
     * starts, every character has its own entry, in the order of `characterIds`: a failure of one (no scope on its token, ESI busy) never stops the others.
     * `sent` is how many waypoints of a failed character reached the game.
     */
    setWaypoints(params: EsiWaypointsParams): Promise<EsiWaypointsResult>;
    /**
     * API 1.24.0 (`^1.24`). Saves a fitting to the character's fittings in the game; with `replaces`, the host then deletes that fitting of the character.
     * Needs esi-fittings.write_fittings.v1 in permissions.optional.esi, granted, and on the character's token. `replaces` and
     * deleteFitting also need esi-fittings.read_fittings.v1 in permissions.esi and on the token: the host reads the fitting to show it. The main page and
     * one user gesture per call, which opens the host's confirmation; the host writes only after the user confirms there. Each write is sent once.
     * `unknown`: the request was sent and no answer came; read the character's fittings before you try again. No other ESI write route exists.
     * A call that fails before the confirmation writes nothing: `not_permitted` (no gesture, not the main page, the scope not in the manifest or not granted),
     * `not_found` (a character this plugin may not see, or no fitting `replaces` names), `bad_params` (`fitting` is not a FitEsiBody as `fit.toEsi` gives it),
     * `rate_limited` (a write of this plugin is open, or ESI asked to slow down), `timeout`, `unavailable`. One write per plugin at a time.
     * Some of these are also thrown after the user confirmed, and then too nothing was written: `rate_limited` (ESI answered 420 or 429), `not_found`
     * (the character left the vault), `timeout` (the host's deadline ran out before the request was sent) and `unavailable`.
     * The host writes the name and description as its confirmation shows them (bidi, control and invisible characters removed, at most two combining marks in a row); a name with nothing visible left is `bad_params`.
     */
    saveFitting(params: EsiFittingSaveParams): Promise<EsiFittingSaveResult>;
    /**
     * API 1.24.0 (`^1.24`). Deletes one of the character's fittings in the game. The needs, the confirmation and the errors of `saveFitting` apply; the host reads
     * the fitting first to show it (`not_found` when the character has no fitting with that id). A fitting that is gone by the time the confirmed delete
     * reaches the game (ESI answers 404) is `deleted`.
     */
    deleteFitting(params: {
        characterId: number;
        fittingId: number;
    }): Promise<EsiFittingDeleteResult>;
}
/** Several waypoints for several characters (API 1.8.0). */
export interface EsiWaypointsParams {
    characterIds: number[];
    /** Solar system, station or structure ids, in the order to visit. */
    destinationIds: number[];
    /** Applies to the first destination of each character only. Default false. */
    clearOtherWaypoints?: boolean;
}
/** One entry per character of the call, in its order. */
export type EsiWaypointsResult = Array<{
    characterId: number;
    ok: true;
} | {
    characterId: number;
    ok: false;
    /** `not_permitted`: the character has not granted the scope (re-authorise it). `rate_limited`: ESI is busy, send again. `unavailable`: the character left the vault or the service is down. */
    code: 'not_permitted' | 'rate_limited' | 'unavailable' | 'failed';
    message: string;
    sent: number;
}>;
/** One waypoint. `clearOtherWaypoints` and `addToBeginning` default to false. */
export interface EsiWaypointParams {
    characterId: number;
    /** A solar system, station or structure id. */
    destinationId: number;
    clearOtherWaypoints?: boolean;
    addToBeginning?: boolean;
}
/** API 1.24.0. `fitting` as `fit.toEsi` gives it; `replaces`: the id of the character's fitting the host deletes once the new one is saved. */
export interface EsiFittingSaveParams {
    characterId: number;
    fitting: FitEsiBody;
    replaces?: number;
}
/**
 * API 1.24.0. `saved`: the game holds the new fitting (`fittingId`); with `replaces`, `old` says what became of the old one (`not_deleted`: it is still
 * there). `cancelled`: the user cancelled, or before the write the page stopped or reloaded or the plugin's permissions changed; nothing was written.
 * `needs_reauth`: the character's token lacks a scope the call needs, or its sign-in ended; nothing was written. Send the user to Settings > Characters to
 * turn on saving fittings for that character (`characters.open({ characterId })`): `characters.open` with `reauth` adds read scopes only, never
 * esi-fittings.write_fittings.v1.
 * `refused`: ESI refused the write, `message` is its text. `unknown`: the request was sent and no answer came; read the character's fittings before you
 * try again.
 */
export type EsiFittingSaveResult = {
    status: 'saved';
    fittingId: number;
    old?: 'deleted' | 'not_deleted' | 'unknown';
} | {
    status: 'cancelled';
} | {
    status: 'needs_reauth';
} | {
    status: 'refused';
    message: string;
} | {
    status: 'unknown';
};
/** API 1.24.0. As EsiFittingSaveResult; `deleted`: the game no longer holds the fitting (also when it was already gone: ESI answered 404). */
export type EsiFittingDeleteResult = {
    status: 'deleted';
} | {
    status: 'cancelled';
} | {
    status: 'needs_reauth';
} | {
    status: 'refused';
    message: string;
} | {
    status: 'unknown';
};
/** A kind of EVE client log. The manifest's `permissions.logs` lists the kinds a plugin asks for. */
export type LogKind = 'gamelogs' | 'chatlogs';
/**
 * Needs `permissions.characters` other than `none` and a `permissions.logs` kind that the user granted and this host streams.
 * This namespace streams `gamelogs` only; it is absent for a plugin granted `chatlogs` alone. Chat goes through `eveCyno.chat` (API 1.5).
 */
export interface LogsNamespace {
    /**
     * Starts the gamelog stream; lines arrive through `onLine`. A kind that is not in the plugin's grant (or that the host does not
     * stream here, such as `chatlogs`) fails with `not_permitted`, like a method that does not exist.
     */
    subscribe(params: {
        kind: LogKind;
    }): Promise<true>;
    onLine(handler: (line: GamelogLine) => void): void;
}
/** A text change on the system clipboard. */
export interface ClipboardChange {
    text: string;
}
/**
 * Present when the plugin was granted `permissions.clipboard: ["read"]`. Text only.
 *
 * Call `subscribe()` once per page, then handle `onChanged`. The user decides per plugin whether the clipboard is watched (default: off):
 * `subscribe()` answers `{ enabled: false }` while it is off, and events start when the user switches it on; nothing needs to be
 * subscribed again. The host reads the clipboard every 500 ms, only while at least one subscribed plugin is switched on.
 *
 * An event is a change from now on: the text on the clipboard when watching starts is not sent. A text longer than 16 KiB (UTF-8) is not
 * sent. Nothing is sent while an EVE sign-in is in progress (the clipboard may carry the user's password), and the text on the clipboard when
 * the sign-in ends counts as already seen. A copy that carries the password-manager hint is withheld: detection is checked on Linux for a hint written by Electron (real password managers are an owner check) and not verified on Windows yet, and managers that set no hint (browser extensions) are not covered. macOS delivers no clipboard events at all (fail closed). Subscriptions are per page: one ends with the page.
 */
export interface ClipboardNamespace {
    subscribe(): Promise<{
        enabled: boolean;
    }>;
    onChanged(handler: (change: ClipboardChange) => void): void;
}
/**
 * Small, config-like data kept by the host for this plugin (bulk data belongs in the `db` namespace from API 1.12.0, or in IndexedDB
 * inside the plugin's own page, which lives in its own isolated partition).
 *
 * - Keys match `[A-Za-z0-9._:-]{1,128}` and must not start with `__` (reserved for the host); anything else is `bad_params`.
 * - Values are strict JSON: null, booleans, finite numbers (`-0` is stored as `0`), strings, arrays and plain objects. Anything
 *   else (a function, `BigInt`, `undefined`, `NaN`, a `Date`, a cycle) is `bad_params`.
 * - A value is at most 1 MiB as JSON (`too_large`). The whole store is limited by `permissions.storage.quotaMB` (default 5,
 *   at most 20), which also counts the host's own data for this plugin such as its settings; a write past it is `too_large`
 *   and changes nothing.
 * - `get` of a missing key resolves `null`.
 * - Every node of a value lies at most 64 levels below its root (a scalar inside 64 nested arrays passes, inside 65 it is `bad_params`); an own `__proto__` key is `bad_params`; every value within 1 MiB passes the node rule.
 * - Writes are acknowledged once they are in memory and reach the disk within 250 ms (at once when the plugin is unloaded or
 *   the app quits); a crash can lose the last 250 ms.
 * - `unavailable` when the file is locked by another program, and for `set` and `delete` after the host failed to write
 *   the file (disk full, no permission): reads keep working and writes resume once a retry (every 5 s) succeeds.
 */
export interface StorageNamespace {
    get(params: {
        key: string;
    }): Promise<unknown>;
    set(params: {
        key: string;
        value: unknown;
    }): Promise<true>;
    delete(params: {
        key: string;
    }): Promise<boolean>;
    keys(): Promise<string[]>;
}
export interface CommandsNamespace {
    /** Runs one of this plugin's own commands (`contributes.commands`): the plugin gets its own `onCommand` event. Another id is `not_found`. */
    execute(params: {
        id: string;
    }): Promise<true>;
    /** The user (or the command palette, or a status item) invoked one of this plugin's commands. */
    onCommand(handler: (command: {
        id: string;
    }) => void): void;
}
export interface SettingsNamespace {
    /**
     * All settings: the `default` of each property of `contributes.settings`, overlaid with what the user set. Only the user
     * changes settings (in the host UI); a value is checked against the contributed schema before it is stored.
     */
    get(): Promise<Record<string, unknown>>;
    /** A setting was changed by the user; read the new value with `get()`. */
    onChanged(handler: (change: {
        key: string;
    }) => void): void;
    /**
     * The user pressed Play beside a setting marked `x-preview`: `key` is that setting, `values` the form as it stands, saved or not.
     * Only that setting is checked: any other value is as the user typed it, so a number can be `NaN` and an empty field `undefined`. Nothing is stored and
     * `get()` still answers the saved values. Delivered to the main page of a running plugin only; Play starts nothing.
     */
    onPreview(handler: (preview: {
        key: string;
        values: Record<string, unknown>;
    }) => void): void;
}
export interface StatusNamespace {
    set(params: StatusItemParams): Promise<true>;
}
export interface TileNamespace {
    /**
     * The host shows at most one update per plugin every 2 seconds: later calls inside the window are coalesced and the
     * newest one is shown when the window ends. The last summary is kept across restarts.
     */
    setSummary(params: TileSummaryParams): Promise<void>;
    /** Title-bar context text, 1 to 30 characters. */
    setContext(params: {
        text: string;
    }): Promise<true>;
}
/**
 * Inter-plugin services. The host brokers every call: the consumer needs the user's consent for that provider
 * (`permissions.services`), params and results are checked against the provider's contributed schemas, and only JSON crosses.
 * A call fails with `not_permitted` (no consent, no installed provider for the interface, another provider than the consented one,
 * a version outside the consented range),
 * `not_found` (unknown method), `bad_params`, `too_large` (over 256 KiB), `rate_limited` (8 calls in flight per consumer,
 * 20 per second per consumer and provider), `timeout` (30 s), `unavailable` (the provider crashed or is gone) or `internal`
 * (the provider failed or returned a result that breaks its schema).
 */
export interface ServicesNamespace {
    /** Calls `method` of `interface` (an id such as `intel.hostiles`). `params` defaults to `{}`. */
    call(params: ServiceCallParams): Promise<unknown>;
    /**
     * Provider side: answers calls to a method of an interface this plugin contributes (`contributes.services[]`). Handlers are
     * keyed by interface and method, so two interfaces may both have a method `get`. A call that arrives before its handler is
     * registered waits up to 2 s for it, then fails with `not_found`. `consumer` is the id
     * of the calling plugin, attested by the host. `ctx` is attested by the host too: `characterIds` are the characters the consumer may see
     * (its grant cut by the vault; empty when it has none) and `builtIn` says whether the consumer is a bundled plugin. A thrown (or rejected) `{ code, message }` reaches the caller only when `code`
     * is `bad_params`, `not_found`, `unavailable` or `internal` (any other code becomes `internal`); the message is cut at 200
     * characters. The return value must be JSON that matches the method's `result` schema.
     */
    handle(iface: string, method: string, handler: (params: unknown, consumer: string, ctx: ServiceCallContext) => unknown | Promise<unknown>): void;
}
/** What the host attests about the consumer of a service call (H14). */
export interface ServiceCallContext {
    characterIds: number[];
    builtIn: boolean;
    /**
     * 1.23.0. A gesture grant from the consumer's act (ServiceCallParams.gesture). Spend it as AiChatRequest.gesture. It pays for at most the provider's turns per ask
     * (AiLimits.turnsPerAsk: a whole number from 1 to 30, set in Settings > AI; 12 by default) on a provider that needs a user act (Claude Code), one at a time, within 15 minutes,
     * by this plugin only. It ends when the consumer revokes it or gives a newer one, when
     * the call that brought it fails or times out, when the consumer's window closes, when either plugin's page stops or reloads, or when the AI settings for
     * Claude Code or this plugin change. Keep it in memory: never store, log or send it on.
     */
    gesture?: string;
}
export interface ServiceCallParams {
    interface: string;
    method: string;
    params?: unknown;
    /**
     * 1.23.0. 'grant': this call is the user's act. Make it in the task of a press in your main page (a mouse press or a key press the host saw itself; an event
     * your page makes never counts). A grant is minted only for AI Chat's interface `evecyno.aichat`, methods `askStart` and `askReply`, between two built-in
     * plugins: when the press is at most 1 s old and the call reaches the provider, the provider receives a gesture grant with this call
     * (ServiceCallContext.gesture). Any other interface or method gets none and spends no press. Any grant you gave this provider before ends. Without a press
     * the call goes ahead without one. 'revoke': ends the grant you gave this provider, if any; no press needed. Your page never sees a grant.
     */
    gesture?: 'grant' | 'revoke';
}
/** A rectangle in DIP (device-independent pixels), in virtual-screen coordinates. */
export interface Rect {
    x: number;
    y: number;
    width: number;
    height: number;
}
/**
 * `client`: an EVE client with a character. `login`: an EVE client at the character-selection screen. `other`: a window of an
 * application the user added in the host settings (its title is never given to plugins).
 */
export type WindowKind = 'client' | 'login' | 'other';
export interface WindowInfo {
    /** The window's id: stable while the window lives. Pass it to `focus`, `minimize` and `setBounds`. */
    id: number;
    kind: WindowKind;
    /**
     * An opaque, per-plugin identifier of the character (`client` windows only, `null` otherwise). The same character gives the same
     * key for this plugin across windows and restarts; another plugin gets another key. Use it to remember per-character state.
     */
    key: string | null;
    /**
     * The character's name. Present only for a plugin that cannot send data out: no `permissions.network` host, no consumed service
     * (`permissions.services`), no provided service (`contributes.services`) because the services broker relays data to other
     * plugins, and neither `permissions.ai` nor `permissions.account`. Any other plugin gets `key` only.
     */
    character?: string;
    /** Present only when the user's vault holds the character and the plugin may see it (`permissions.characters`). */
    characterId?: number;
    active: boolean;
    minimized: boolean;
    bounds: Rect;
    /**
     * API 1.29.0 (`^1.29`). `other` windows only: the entry of the user's extra window classes (host Settings > Hotkeys and thumbnails)
     * that this window matched, spelled as the user wrote it (Linux: a WM_CLASS class or instance; Windows: a program file name, with or
     * without `.exe`). Never the window title. Present only for a plugin that cannot send data out (the rule of `character`); absent
     * otherwise, and on `client` and `login` windows.
     */
    windowClass?: string;
}
export interface DisplayInfo {
    id: number;
    bounds: Rect;
    workArea: Rect;
    scaleFactor: number;
    primary: boolean;
}
/**
 * API 1.29.0 (`^1.29`). Whether this host moves EVE windows on this desktop (`windows.moveSupport`). `wayland`: a Linux Wayland session (one with
 * `WAYLAND_DISPLAY` set) where this host does not move EVE's XWayland windows; `platform`: this host does not move windows on this system.
 */
export type WindowMoveSupport = {
    supported: true;
} | {
    supported: false;
    why: 'wayland' | 'platform';
};
/** API 1.29.0. A `client` or `login` window id from `list()` and its new outer rectangle (DIP, the shape of `WindowInfo.bounds`). */
export interface WindowBoundsItem {
    id: number;
    bounds: Rect;
}
/**
 * API 1.29.0. One item's outcome, read back from the system after the move. `ok: true`: the window is at `bounds`, which is the target, or
 * within a few pixels of it, or where the desktop put it instead (inside the work area, say); a window that was already at its target is
 * `ok` too. `ok: false`: `minimized` or `maximized` (also full screen): not moved, because the host never changes a window's state;
 * `refused`: still where it was and not at the target; `gone`: the id is not listed (any more); `off_display`: the rectangle overlaps no display.
 */
export type WindowBoundsResult = {
    id: number;
    ok: true;
    bounds: Rect;
} | {
    id: number;
    ok: false;
    reason: 'minimized' | 'maximized' | 'refused' | 'gone' | 'off_display';
};
/**
 * The EVE windows on the desktop. Present when the plugin was granted any of `windows` (the list alone), `windowThumbnails`, `hotkeys` or `overlays`.
 *
 * Window changes are sent as events to a plugin that called `subscribe()`; the host polls only while at least one plugin is
 * subscribed. Subscriptions are per page: one ends with the page that made it (reload, crash or stop; an overlay page's with its overlay).
 *
 * `focus`, `focusLastOther` and `minimize` of the active window each need a user gesture in the plugin's own page: a mouse
 * press or a non-repeating key press, at most 1 second before the call (one gesture, one call; a plugin keeps at most 4).
 * Without one they fail with `not_permitted` ("no user gesture"). Minimizing a window that is not active needs none.
 * An id that is not a listed window is `not_found`. `setBounds` has its own gesture rule (main page or hotkey only): see there.
 */
export interface WindowsNamespace {
    list(): Promise<WindowInfo[]>;
    displays(): Promise<DisplayInfo[]>;
    /**
     * Starts `onChanged`, `onActiveChanged` and `onDisplaysChanged` events for this page. Events report changes from now on: call `list()`
     * after `subscribe()` for the current state.
     */
    subscribe(): Promise<true>;
    focus(params: {
        id: number;
    }): Promise<true>;
    /** At most 64 ids (`too_large`). */
    minimize(params: {
        ids: number[];
    }): Promise<true>;
    /** Focuses the last window that was active and is not an EVE window listed here (`not_found` when there is none). */
    focusLastOther(): Promise<true>;
    /** API 1.29.0 (`^1.29`). The user's extra window classes, in their order ([] when none). The rule of `windowClass`: `not_permitted` for a plugin that can send data out. */
    extraClasses(): Promise<string[]>;
    /**
     * API 1.29.0 (`^1.29`). Read-only; needs no gesture. On a KWin Wayland session `WindowInfo.bounds` is the client rectangle (the compositor's
     * decoration is not part of the outer rectangle cynod sees); `setBounds` takes the same convention.
     */
    moveSupport(): Promise<WindowMoveSupport>;
    /**
     * API 1.29.0 (`^1.29`). Moves and resizes EVE windows (`client` and `login`). Main page only. Only on a user act: a mouse press or a
     * non-repeating key press in the plugin's MAIN page, or a press of one of the plugin's hotkeys, at most 1 second before the call. A press
     * on a thumbnail slot or in an overlay page does not count. One act pays for one call, whatever the number of items. The host never moves
     * a window on its own, never activates, raises or minimizes one here, and leaves a minimized, maximized or full-screen window as it is.
     * One result per item, in order: what happens to one window never fails the call. The whole call fails only for its shape and rights,
     * before any move and with the act kept: `bad_params` (an item that is not `{ id, bounds }` with finite numbers and a size of at least
     * 1x1, an id given twice, or a rectangle beyond what the system takes: 32767 pixels), `too_large` (more than 64 items), `not_permitted`
     * (no user gesture, an overlay page, a listed `other` window in the items, or a plugin that may not move windows: on a 1.29.0 host only
     * the built-in plugins may), `unavailable` (`moveSupport()` says no).
     * A window that changes kind between the host's check and the call can still spend the act: the system then answers `not_permitted` after the credit is used.
     * On a KWin Wayland session `WindowInfo.bounds` is the client rectangle (the compositor's decoration is not part of the outer rectangle cynod
     * sees); `setBounds` takes the same convention.
     */
    setBounds(params: {
        items: WindowBoundsItem[];
    }): Promise<WindowBoundsResult[]>;
    onChanged(handler: (windows: WindowInfo[]) => void): void;
    /** `id` is the active listed window, or `null` when another application is active. */
    onActiveChanged(handler: (event: {
        id: number | null;
    }) => void): void;
    onDisplaysChanged(handler: (displays: DisplayInfo[]) => void): void;
}
export interface OverlayCreateParams {
    /** One of the ids in `contributes.overlays`: it names the plugin page (`entry`) the overlay shows. */
    type: string;
    /**
     * A name the host remembers the overlay's position under (1 to 64 of `A-Za-z0-9._:-`; at most 256 keys per plugin). Creating an
     * overlay with a key that was used before puts it where it was last placed, as long as that spot is still on a display.
     */
    key?: string;
    /**
     * Where to open it when no remembered position applies (size 32x18 to 4096x4096). If it is not on a display, the default is used instead:
     * 384x216, cascaded from the top-left of the primary display.
     */
    bounds?: Rect;
    /** Mouse input passes through the overlay to the window below. Default false. */
    clickThrough?: boolean;
    /** The id of another open overlay of this plugin to stack this one over. It then moves by the same amount whenever that overlay is moved. */
    above?: number;
}
export interface OverlayInfo {
    id: number;
    type: string;
    key: string | null;
    bounds: Rect;
    /** What the plugin asked for. The host hides an overlay for a while without changing this: while it lies over an active EVE-Cyno window or a permission prompt, and while a host dialog is up. */
    visible: boolean;
}
/**
 * Overlay windows: small transparent windows of the plugin's own, always on top and never focused (a click on one does not take
 * focus from the game). Each shows one of the plugin's pages (`contributes.overlays`), which has this same `eveCyno` object.
 * Present when the plugin was granted `overlays`.
 *
 * Overlays belong to the plugin's main page: a reload, crash or stop of that page closes all of them, with no event. A plugin has at
 * most 64 overlays (`too_large`). `bounds` are DIP in virtual-screen coordinates, 32x18 to 4096x4096; `setBounds` needs them on a display.
 * A move the host makes itself (a display went away, or the user reset its saved spot in Settings) is not remembered under the key; only your own `setBounds` is.
 *
 * `onClosed` and `onMoved` are delivered to the main page only, not to overlay pages (as are `commands.onCommand` and `settings.onChanged`).
 */
export interface OverlaysNamespace {
    create(params: OverlayCreateParams): Promise<OverlayInfo>;
    /** Moves or resizes up to 64 overlays in one call. All of them are checked first: nothing moves when one is refused. */
    setBounds(params: {
        items: {
            id: number;
            bounds: Rect;
        }[];
    }): Promise<true>;
    update(params: {
        id: number;
        visible?: boolean;
        clickThrough?: boolean;
    }): Promise<true>;
    /** Moves the overlay (and the overlays stacked over it) to the front of the other overlays. */
    raise(params: {
        id: number;
    }): Promise<true>;
    /** Closes the overlay and the overlays stacked over it. */
    close(params: {
        id: number;
    }): Promise<true>;
    list(): Promise<OverlayInfo[]>;
    /** In an overlay page: that overlay. In the main page: `null`. */
    self(): Promise<OverlayInfo | null>;
    /**
     * An overlay closed: by `close`, by the system (`closed`) or because its page crashed (`crashed`). Not sent when the main page itself reloads,
     * crashes or stops. The main page and the overlay pages share one renderer process, so a renderer crash is the main page's: no event then.
     */
    onClosed(handler: (event: {
        id: number;
        reason: 'closed' | 'crashed';
    }) => void): void;
    /** The host moved the overlay: its display went away, or the user reset its saved spot in Settings. */
    onMoved(handler: (event: {
        id: number;
        bounds: Rect;
    }) => void): void;
}
export interface ThumbnailAttachParams {
    /** An overlay of this plugin (any of its pages may attach to it). */
    overlayId: number;
    /** A window id from `windows.list()`. */
    windowId: number;
    /** DIP, relative to the overlay's content: at least 16x9 and inside the overlay. */
    rect: Rect;
    /** 0.2 to 1. Default 1. */
    opacity?: number;
    /** 1 to 30 (frames per second on Linux). Default 15. */
    fps?: number;
}
export interface ThumbnailPointer {
    slotId: number;
    type: 'down' | 'up' | 'move' | 'enter' | 'leave' | 'wheel';
    /** The button that changed (0 left, 1 middle, 2 right); -1 for a move. */
    button: number;
    /** The buttons held (bit 0 left, bit 1 right, bit 2 middle). */
    buttons: number;
    /** DIP, relative to the slot. */
    x: number;
    y: number;
    /** DIP on the screen: stays meaningful while the overlay moves under the pointer. */
    screenX: number;
    screenY: number;
    ctrl: boolean;
    shift: boolean;
    alt: boolean;
    meta: boolean;
    /** Only for `wheel`. */
    deltaY?: number;
}
export type ThumbnailState = 'live' | 'unavailable' | 'closed';
/** A slot's state (`thumbnails.onState`). */
export type ThumbnailStateEvent = {
    slotId: number;
    state: ThumbnailState;
    /**
     * 1.0.0-beta.7, only with `live`: the slot is larger than its window now (the window shrank, or the host moved the overlay to a display
     * with a larger scale), so the host draws the whole window at this size (DIP), at most 1:1 and centred in the slot. Shrink the slot or
     * the overlay to it, or leave it: a `live` without `clamped` follows when the window is large enough again.
     */
    clamped?: {
        width: number;
        height: number;
    };
};
/**
 * Live thumbnails of EVE windows inside your overlays. Present when the plugin was granted `windowThumbnails`.
 *
 * A slot is a rectangle of one of your overlays that the host paints with the live window. The host draws it on top of your overlay
 * page and in a view of its own: your page never receives the pixels (no stream, no canvas), only the pointer events over the slot.
 * Draw around the slot; to draw over it, open a second overlay with `above`.
 *
 * A thumbnail is always the whole window, never cropped or magnified (`bad_params` otherwise): the overlay that holds a slot lies fully on
 * one display, the slot lies fully inside its overlay (an `overlays.setBounds` that would clip it is refused), and the slot is at most as
 * large as its window's client area in physical pixels (1:1 at most; smaller is a zoom out). A slot that is larger than its window later
 * (the window shrank) is drawn at most 1:1 and reported with `clamped` (see `ThumbnailStateEvent`).
 *
 * At most 32 slots per plugin (`too_large`). A slot ends with its overlay and with the page that attached it (a reload, crash or stop
 * ends it, with no event). A pointer press (`down`) over a slot counts as a user gesture for `windows.focus` and `windows.minimize`.
 * `move` events are limited to 60 per second per slot; the last move before an `up` is always delivered. Events go to the page that attached.
 */
export interface ThumbnailsNamespace {
    /** `not_found` for an overlay that is not yours or a window that is not listed. */
    attach(params: ThumbnailAttachParams): Promise<{
        slotId: number;
    }>;
    /**
     * Changes the slot. Passing `windowId` points the slot at that (listed) window again, which also restarts a slot that reported `closed`
     * or `unavailable`.
     */
    update(params: {
        slotId: number;
        rect?: Rect;
        opacity?: number;
        fps?: number;
        windowId?: number;
    }): Promise<true>;
    detach(params: {
        slotId: number;
    }): Promise<true>;
    onPointer(handler: (event: ThumbnailPointer) => void): void;
    /**
     * `live`: pixels are flowing (with `clamped` when the window is drawn smaller than the slot). `unavailable`: the host could not capture
     * the window, or the capture stopped; `update({ slotId, windowId })` starts it again. `closed`: the window left the list; the slot stays
     * until you detach it or `update` it with a listed `windowId`. Sent once per change (a new or ended `clamped` is a change).
     */
    onState(handler: (event: ThumbnailStateEvent) => void): void;
}
export interface HotkeyBinding {
    /** Your name for the binding (`^[a-z][A-Za-z0-9.-]{0,63}$`), unique in one `register` call. It comes back in `onPressed`. */
    id: string;
    /**
     * Modifiers `Control` (or `Ctrl`), `Alt` and `Shift`, then one key, joined by `+` and not case-sensitive: `Control+Alt+Shift+F9`.
     * Keys: F1 to F24, A to Z, 0 to 9 and Num0 to Num9. A letter or a top-row digit needs a modifier; an F key does not, and since
     * 1.0.0-beta.7 neither does a numpad key (`Num5` alone is a chord). Modifiers alone, `Super` and a second key are `invalid`.
     * Num0 to Num9 are the keypad digits with NumLock on: such a chord fires with NumLock on; with NumLock off the key goes to the focused
     * window (the game included) as its other meaning (an arrow, Home, End, PgUp, PgDn, Insert). On Windows a numpad chord with `Shift`
     * does not fire (with NumLock on, Windows turns Shift and a keypad digit into that other key). Note: on Linux, F13 to F24 often have no X keysym (evdev maps them to `XF86Tools` and similar keys), so such a
     * chord cannot be grabbed; use F1 to F12, a letter or a digit with modifiers where you can.
     */
    chord: string;
    /**
     * Optional (1.0.0-beta.6): the words Settings shows for the binding instead of its `id`: 1 to 40 characters (code points), not blank,
     * with no control, format (bidi, zero-width, soft hyphen, tag), lone surrogate or line and paragraph separator character (Unicode Cc, Cf,
     * Cs, Zl, Zp), else `bad_params`. The host shows it to the user only; it never comes back in a result.
     */
    label?: string;
    /**
     * API 1.29.0 (`^1.29`). When the binding fires: `press` (the default) when the chord goes down, `release` once when its key goes up
     * again (at most one `onPressed` per press; a key held longer than 10 s fires nothing; the release is the user gesture then). Where the host's path does not
     * report the release (the desktop's shortcut portal), the binding fires on press and the result's `trigger` says so.
     */
    trigger?: 'press' | 'release';
}
export interface HotkeyResult {
    id: string;
    /** The chord in its canonical spelling (`Control+Alt+Shift+Key`); for `invalid`, the text you sent. */
    chord: string;
    ok: boolean;
    /**
     * `taken`: another plugin holds the chord, or an earlier binding of the same call has it. `invalid`: not a chord. `os_refused`: the system refused it (another program holds it, the key
     * does not exist on this keyboard, or the portal failed). `unsupported`: hotkeys do not exist on this operating system.
     */
    reason?: 'taken' | 'invalid' | 'os_refused' | 'unsupported';
    /** The host's choice for the chord: `x11` (a key grab) or `portal` (the desktop's shortcut portal) on Linux, `win32` on Windows. */
    path?: 'x11' | 'portal' | 'win32';
    /**
     * Portal only: the user (or the desktop) has given the shortcut a trigger. `false` means the binding exists but nothing fires until the user
     * assigns a key in the system's shortcut settings.
     */
    assigned?: boolean;
    /** API 1.29.0. Only when the binding carried `trigger` and is `ok`: when it fires on this host. */
    trigger?: 'press' | 'release';
}
/**
 * Global hotkeys: a chord that works while the game has the focus. Present when the plugin was granted `hotkeys`.
 *
 * One press is one `onPressed`, however long the key is held (the host filters auto-repeat). A press is a user gesture for the page that
 * registered it, like a click: `windows.focus` in the handler works (once per press). API 1.29.0: a binding with `trigger: 'release'` fires
 * when its key goes up, once per press (`HotkeyBinding.trigger`). A chord that no plugin holds is the host's to
 * place: on Linux the host grabs the key itself and uses the desktop's portal only when the grab fails (or the user chose the portal);
 * on Windows it uses RegisterHotKey. The host never reads other keystrokes and never sends input.
 *
 * Hotkeys belong to the plugin's main page: `register` is refused from an overlay page, and a reload, crash or stop of the main page
 * releases every chord, with no event. At most 64 bindings (`too_large`); a malformed binding or a repeated id is `bad_params`.
 */
export interface HotkeysNamespace {
    /**
     * Replaces your whole set of bindings. The answer has one result per binding, in order; a chord that is refused does not fail the
     * call. A chord you registered before and register again stays registered without a gap. Passing `[]` releases everything.
     * On the portal path the call can wait for the system's shortcut dialog, for minutes.
     */
    register(params: {
        bindings: HotkeyBinding[];
    }): Promise<HotkeyResult[]>;
    /** The results of your last `register`, as they are now. */
    list(): Promise<HotkeyResult[]>;
    /** Releases every chord of this plugin. */
    clear(): Promise<true>;
    onPressed(handler: (event: {
        id: string;
    }) => void): void;
}
/**
 * Present when the plugin was granted `permissions.notifications: true`. The host draws the notification (a toast and an entry in its
 * notification panel) and owns its buttons: Open, Mute <your plugin> and Dismiss. A plugin cannot add buttons or run code from one.
 *
 * `title` is at most 60 characters and `body` at most 200; a longer text is cut and ends with "…" (counted in code points). Both are plain
 * one-line text (no newline, control, bidi or zero-width characters); anything else, or an unknown severity, is `bad_params`.
 * At most 3 notifications at once, then one every 10 seconds; more is `rate_limited`. A plugin the user muted gets no toast and its
 * notifications are listed as read; `show` still resolves, with `muted: true` so the plugin can stay silent too. The host keeps the newest 50 notifications in memory. `onOpened` runs when the
 * user opens one of your notifications (the Open button, or the entry in the panel); the plugin is started first when it is not running.
 */
export interface NotificationsNamespace {
    show(params: {
        title: string;
        body?: string;
        severity?: TileSeverity;
    }): Promise<{
        id: string;
        muted?: boolean;
    }>;
    onOpened(handler: (event: {
        id: string;
    }) => void): void;
}
/**
 * Optional permission items (1.17.0): the manifest's `permissions.optional`, or a part of it. `esi`: ESI scopes; `network`: https origins in their
 * canonical form (lower case, no default port, no path); `clipboard`: clipboard read; `notifications`: showing notifications. A kind with no item is
 * left out.
 */
export interface OptionalSet {
    esi?: string[];
    network?: string[];
    clipboard?: ['read'];
    /**
     * `true` only. `get()` never gives `false` (an item not there is left out), `request` refuses `false` (`bad_params`), and in the manifest
     * `false` lists no item.
     */
    notifications?: boolean;
}
/**
 * Present when the manifest lists optional items in `permissions.optional` (1.17.0, `^1.17`; such a manifest must ask for `^1.17` or a range whose
 * lowest version is at least 1.17.0). The user can switch each optional item off in the permission prompt or in Settings > Privacy, and the plugin keeps
 * running without it. A declined item fails as an ungranted one does (an absent namespace, `not_permitted`, an origin outside the page's CSP): read
 * `get()` to know what you have. A grant change restarts the page, so there is no change event.
 */
export interface PermissionsNamespace {
    /** The optional items granted now, and every other optional item of the manifest as `declined`. */
    get(): Promise<{
        granted: OptionalSet;
        declined: OptionalSet;
    }>;
    /**
     * Asks the user for optional items of the manifest. Main page only, one user gesture per call (else `not_permitted`). Every item must be one of the
     * manifest's optional items, written as `get()` gives it (else `bad_params`, as is an empty set). While a permission question of the plugin is open, a
     * second call is `rate_limited`. Resolves `'granted'` with no question when every item is granted already; else the host asks, and `'declined'` when
     * the user said Not now or switched every item off. An Allow restarts the page, so the promise does not settle then: read `get()` after the restart.
     * A call refused before the host decides (`bad_params`, `not_permitted`, `rate_limited`) keeps the gesture. A call that reaches the decision spends it
     * whatever the answer: `'granted'` with no question, Allow, Not now, or an error when the question could not be asked.
     */
    request(items: OptionalSet): Promise<'granted' | 'declined'>;
}
/**
 * Present when the plugin was granted `permissions.files` (1.1.0). The host shows its own OS dialog; the plugin never learns a path or a
 * file name. Main page only (`not_permitted` from an overlay page). Each call needs a mouse press or a non-repeating key press in the
 * plugin's main page at most 1 second before it (a thumbnail click or a hotkey press does not count): one gesture, one dialog, else
 * `not_permitted` ("no user gesture"). One dialog per plugin at a time (`rate_limited`). Overlays are hidden while the dialog is up.
 * `extensions`: 1 to 4 of the data extensions json, txt, csv, md, xml, yaml, yml, log; default ["txt"] (anything else is `bad_params`).
 * `suggestedName`: 1 to 64 characters (counted in code points) of display text (no control, bidi or zero-width character), none of
 * / \ : * ? " < > |, not starting with a dot, not ending with a dot or a space, not a Windows device name (CON, PRN, AUX, NUL, COM0-9,
 * LPT0-9, alone or with an extension). Its own extension (after the last dot, any case) must be one of the data extensions above; a name
 * without a dot gets the first of `extensions` (`layout` -> `layout.json`). Anything else is `bad_params`.
 * `text`: at most 1 MiB as UTF-8 (`too_large`), valid Unicode (a lone surrogate is `bad_params`). The 2 MiB limit on the params of one
 * call is checked first, in the page, so a text far over 1 MiB can fail there (also `too_large`, "params larger than 2 MiB"); a text of at
 * most 1 MiB always passes it. The file holds the text as UTF-8 with no BOM and the line endings as given.
 * `saveText` resolves false when the user cancels; the file is replaced atomically. `openText` resolves null when the user cancels; a
 * picked file over 1 MiB is `too_large`, one that is not UTF-8 text (or not a regular file) is `unavailable`. One leading BOM is dropped;
 * line endings come as they are in the file (CRLF stays CRLF). Reading or writing the picked file may take at most 30 seconds (a hung
 * network drive): then `unavailable` (a write that finishes later may still replace the file). The dialog itself has no time limit.
 */
export interface FilesNamespace {
    /** Text only: writes `text` (at most 1 MiB as UTF-8) to the file the user picks in the save dialog. */
    saveText(params: {
        suggestedName: string;
        text: string;
        extensions?: string[];
    }): Promise<boolean>;
    /** Text only: the content of the file the user picks in the open dialog (UTF-8, at most 1 MiB), never its path or name. */
    openText(params?: {
        extensions?: string[];
    }): Promise<string | null>;
    /**
     * Stream save (1.13.0): for a file larger than `saveText` takes. The same gesture, main-page and one-dialog rules as `saveText`, and
     * the same `suggestedName` and `extensions` rules. Shows the host's save dialog once and resolves true when the stream is open, false when
     * the user cancels. Then send the bytes with `writeChunk` and finish with `endSave`. A plugin has one open stream at a time (a second
     * `beginSave` is `rate_limited`, before it shows anything). Nothing is at the final path until `endSave` succeeds: the host writes to a
     * temp name beside it and renames it on success; an existing file there stays as it was until then.
     */
    beginSave(params: {
        suggestedName: string;
        extensions?: string[];
    }): Promise<boolean>;
    /**
     * Appends a chunk to the open stream: `data` is a Uint8Array of at most 1 MiB (`too_large`; the stream stays open), at most 512 MiB in all
     * (the chunk that would pass it is `too_large` and the stream is closed and removed). Resolves when the bytes are on disk, so `await` each
     * call: only one call on a stream may be unfinished (a second is `rate_limited` and changes nothing), which keeps memory flat. The 2 MiB
     * limit on the params of a call counts the whole buffer behind a typed array, not only the viewed part: send `bytes.slice(a, b)`, not
     * `bytes.subarray(a, b)` of a larger buffer. With no stream open: `unavailable`. A write error, or a write that takes more than 30 seconds:
     * `unavailable`, the stream is closed and the temp file removed.
     */
    writeChunk(params: {
        data: Uint8Array;
    }): Promise<void>;
    /** Finishes the stream: the file appears at the picked path (an existing file is replaced atomically). A failure is `unavailable` and leaves nothing behind. */
    endSave(): Promise<void>;
    /** Drops the stream and removes the temp file; the picked path is not touched. Resolves with no stream open, too. The host does the same when the plugin stops, reloads or crashes. */
    abortSave(): Promise<void>;
}
/**
 * The host theme as a plugin view sees it (1.0.0-beta.5). The twelve colours are opaque `#rrggbb`. There is no host accent: plugins never draw with ice. `own` is your plugin's palette colour under the theme.
 */
export interface ThemeInfo {
    /** `cyno`, or `pkg:<package id>/<theme id>`. */
    id: string;
    name: string;
    scheme: 'dark' | 'light';
    density: 'normal' | 'compact';
    colors: {
        /** The window behind everything. */
        window: string;
        /** The page background. */
        background: string;
        /** Cards and panels on the background. */
        surface: string;
        /** Raised surfaces (inputs, chips). */
        raised: string;
        line: string;
        text: string;
        textMuted: string;
        textDim: string;
        ok: string;
        warn: string;
        bad: string;
        /** Your plugin's own palette colour (the one on its tile) under this theme. */
        own: string;
    };
    /** The base corner radius in px. */
    radius: number;
    /** The resolved CSS font stacks (names only: the host does not give out font files, so bundle the fonts you need). */
    fonts: {
        display: string;
        body: string;
        mono: string;
    };
    /**
     * API 1.28.0 (`^1.28`): the resolved motion level, always one of the three: the stored choice
     * when there is one, else what the system asks for (`prefers-reduced-motion`: `reduced`, otherwise `full`). `reduced` keeps meaning (a state change, a
     * short fade) and drops movement; `off` shows end states at once. `onChanged` runs when it changes.
     */
    motion: 'full' | 'reduced' | 'off';
}
/**
 * Read-only. `get` answers the current theme; `onChanged` runs when the user switches theme, accent or fonts, or the motion level changes. The scheme also
 * drives `prefers-color-scheme` in your page. No CSS is injected into plugin pages.
 */
export interface ThemeNamespace {
    get(): Promise<ThemeInfo>;
    onChanged(handler: (theme: ThemeInfo) => void): void;
}
/**
 * API 1.22.0 (`^1.22`): the plugin's own window. Every plugin has it and it needs no permission: it tells a plugin only about its own window.
 */
export interface WindowNamespace {
    /**
     * The user closed the plugin's own window (opened with "Open in its own window"): its close button or the window manager's close, or its window is
     * dropped after a crash (the window's own page failed for good after it was shown). The page keeps running, hidden, and the main window keeps showing
     * what it showed. Fires once per window, and again each time the window is opened and closed again.
     * Not on a minimise, a hide, focus loss or any other visibility change, not on "Back to main window", not when the main window closes (to the tray or not),
     * not when the host closes the window (the plugin is switched off or uninstalled) and not when the app quits. Only the plugin whose window closed hears it,
     * on its main page (not on overlay pages); a page that is not running when the window closes does not hear it later.
     */
    onClosed(handler: () => void): void;
}
/** Event families a plugin can ask for (1.2.0). `combat`: damage, misses, repairs; `ewar`: warp disruption, jams, neuts, nos; `mining`: yields, residue, stops; `notice`: `Jump`, `Dock`, `Undock` markers only. */
export type GameEventFamily = 'combat' | 'ewar' | 'mining' | 'notice';
/** What one game event is. `Notice` is the `notice` family; the `Mining*` kinds are `mining`; `Ewar`, `Neut*` and `Nos*` are `ewar`; the rest is `combat`. */
export type GameEventKind = 'DamageIn' | 'DamageOut' | 'MissIn' | 'MissOut' | 'RepIn' | 'RepOut' | 'NeutIn' | 'NeutOut' | 'NosIn' | 'NosOut' | 'Ewar' | 'MiningYield' | 'MiningResidue' | 'MiningStop' | 'Notice';
/**
 * One typed event parsed from a character's game log (1.2.0). Raw log text, unknown lines, system and station names are never delivered.
 * English client logs only: other languages parse to nothing (see `GamelogCharacter.parsedShare`).
 */
export interface GameEvent {
    /** Stable per plugin and character (an HMAC of the Listener name), never the name. Same key as `WindowInfo` uses for that character. */
    key: string;
    /** Only for a vault character your grant allows (the windows rule); otherwise absent. */
    characterId?: number;
    /** Log time, ms since epoch (UTC), 1 s resolution. */
    t: number;
    /** When the host received the line, ms since epoch (for a replayed event, when the replay started). */
    rx: number;
    kind: GameEventKind;
    /** HP, GJ or units, by kind. */
    amount?: number;
    resource?: 'armor' | 'shield' | 'hull' | 'structure' | 'capacitor';
    /**
     * The other party, as written in the log. Present only for a plugin with no data-out (no `network`, services, `ai` or `account`).
     * Every other plugin gets `entityIsPlayer` and `entityRef` instead and never sees the name.
     */
    entity?: string;
    /** True when the other party is a player. Absent or false means not a player (or redacted to false). */
    entityIsPlayer?: boolean;
    /** Small number, one per distinct entity since this page subscribed (a per-page counter; it resets on reload). Only for plugins that do not get `entity`. */
    entityRef?: number;
    weapon?: string;
    quality?: string;
    ore?: string;
    crit?: boolean;
    stop?: 'HoldFull' | 'AsteroidDepleted' | 'TargetLost';
    ewar?: 'scramble' | 'disruption' | 'jam';
    direction?: 'in' | 'out';
    notice?: 'Jump' | 'Dock' | 'Undock';
    /** True on every event of a replay (history), absent on live events. */
    replay?: true;
}
/**
 * Events reach `onEvents` per page in batches: one every 250 ms, at most 4 per second, at most 500 events each. When more arrive
 * the newest 500 are kept and `dropped` counts the rest. A replay is not dropped: it is paced to the same 4 batches per second.
 */
export interface GameEventBatch {
    events: GameEvent[];
    /** Events lost in this window (the 500-event cap, or live events held during a replay beyond 20 000). */
    dropped: number;
    /** Set on the last batch of a replay: replay is over (at most the last 32 MiB of each session file is replayed), live events follow. Also sent on timeout or when replay is unsupported, so it does not mean the history is complete. */
    replayEnd?: true;
}
/** A character the host sees a game log for (1.2.0). */
export interface GamelogCharacter {
    /** The same key as `GameEvent.key`. */
    key: string;
    /** Same rule as `GameEvent.characterId`. */
    characterId?: number;
    /** ms since epoch of the last line read; 0 while the log has a header and no timestamped line yet. */
    lastLineAt: number;
    /** 0..1: the share of the last 200 event lines the parser recognised (1 with none). Low means a language the parser does not know. */
    parsedShare: number;
    /** How many event lines `parsedShare` is based on (at most 200). */
    eventLines: number;
}
/**
 * `eveCyno.gamelog` exists only for a plugin granted `permissions.gameEvents` (a list of families); without it the property is absent.
 * It needs no `characters` permission and does not count as data-out. It reads English client logs only.
 *
 * `subscribe` picks the families (only those granted) and holds the plugin awake. With `replay: 'session'` the host first sends the
 * current session's history to this page alone, as its own paced, lossless batches: each event has `replay: true` and the last batch
 * has `replayEnd: true`. Live events follow. `replay: 'none'` (the default) starts from live. `characters()` lists the characters
 * with a log, with `parsedShare`. Every plugin holding `gameEvents` gets this list, including plugins that can send data out.
 *
 * Errors: `subscribe` needs 1 to 4 distinct families, otherwise `bad_params`; a family not granted by `gameEvents` fails with
 * `not_permitted`.
 */
export interface GamelogNamespace {
    subscribe(params: {
        families: GameEventFamily[];
        replay?: 'none' | 'session';
    }): Promise<{
        families: GameEventFamily[];
    }>;
    characters(): Promise<GamelogCharacter[]>;
    onEvents(handler: (batch: GameEventBatch) => void): void;
}
/**
 * A data pack the host serves. 1.3.0: the SDE universe; 1.11.0: `sde.types` (types, groups, categories, NPC stations, container-group mark), for the built-in assets plugin only;
 * 1.27.0: `market.hubs` (the hub price table of the EVE-Cyno data API; the host downloads it, it does not ship with the app), for the built-in assets plugin only.
 */
export type DataPackId = 'sde.universe' | 'sde.types' | 'market.hubs';
export interface DataPackInfo {
    id: DataPackId;
    version: string;
    sha256: string;
    size: number;
    /**
     * 1.27.0 (`^1.27`), `market.hubs` only. Epoch milliseconds. Present while the last download failed (until one succeeds): the earliest time the host downloads again,
     * the server's `Retry-After` when it sent one, else the table's own period (`nextBuildAt` - `builtAt` of the held copy), else 15 minutes (the period of the hub build).
     * It may lie in the past: then the next `getPack` downloads. On the answer of `getPack` only, it is also present after a download at or after the held table's
     * `nextBuildAt` that left the held table past its `nextBuildAt` (a 304, the same table, or a newer table already past its own) when the answer's `Date` (the server's
     * clock) is at or after that `nextBuildAt` and at most one table period after it: the time of the answer plus the overrun so far by the answer's `Date` (`Date` - `nextBuildAt`,
     * at least 1 second, at most 900 seconds, and less than one table period), the earliest time the host downloads again. A later such answer of
     * the same table names a new time only while its wait is at least the time since the table's first such time, measured at the request's start, and before its
     * first such download plus one period. For the first answer of a table whose `Date` is before that `nextBuildAt` by at most one table period (a client clock ahead of the server's), it is the time of
     * the answer plus the time left by the `Date` (`nextBuildAt` - `Date`, with the same bounds); later such answers of that table name none.
     * `packVersion` leaves that one out (no download failed). Absent otherwise: the next download is due when the host's floor opens: at the held table's `nextBuildAt`,
     * or one table period after the last download when that is earlier or the copy is already past its `nextBuildAt`.
     */
    retryAt?: number;
}
export interface DataPack extends DataPackInfo {
    bytes: Uint8Array;
}
/**
 * 1.27.0. The answer of `data.refreshPack`. `ok: true`: the host fetched a table and `version` is the held copy's version. A refusal sends no request:
 * `fresh` (no download is due: the held table's own `nextBuildAt` is still ahead, or a download at or after it brought no newer table less than one table period
 * (`nextBuildAt` - `builtAt`) ago; `nextAt`, epoch milliseconds, is the time the next download is due: that `nextBuildAt` when the last download came before it,
 * else the earlier time after that download's overrun (the `retryAt` of `getPack`'s answer, see `DataPackInfo.retryAt`), else the last download plus
 * one table period, and never later than the last download plus one table period), `retry_later` (a failure back-off is running;
 * `retryAt`, epoch milliseconds, is the earliest time the host downloads again; the host keeps no timer, so the download happens at the first `getPack` or `refreshPack` from then on.
 * It is the server's `Retry-After` when it sent one, else the table's own period (`nextBuildAt` - `builtAt` of the held copy), else, with no copy held, 15 minutes (the period of the
 * hub build). `unavailable`: the fetch was made and failed; `retryAt` is the same time, as `retry_later` will answer it.
 */
export type RefreshPackResult = {
    ok: true;
    version: string;
} | {
    ok: false;
    reason: 'fresh';
    nextAt: number;
} | {
    ok: false;
    reason: 'retry_later';
    retryAt: number;
} | {
    ok: false;
    reason: 'unavailable';
    retryAt: number;
};
/**
 * Read-only host data (1.3.0). Present only for a built-in plugin the host allows (the map); other plugins reach geometry through the
 * `evecyno.map` service. The packs `sde.universe` and `sde.types` ship with the app; `packVersion` and `onPackChanged` exist for a later update check: for them the
 * version never changes and the event never fires. A pack that fails its size or SHA-256 check is `unavailable`.
 *
 * 1.27.0: the pack `market.hubs` is downloaded by the host and its version changes: it is the table's `builtAt`. `getPack({ id: 'market.hubs' })` returns the held copy, or
 * downloads one first when the host's floor has opened: at the table's `nextBuildAt`, or one table period (`nextBuildAt` - `builtAt`, at least 5 minutes) after the last
 * download when that is earlier or the copy is already past its `nextBuildAt`; before the first copy it waits for that download up to 30 seconds, then rejects `unavailable`.
 * After a download at or after `nextBuildAt` that brought no table ahead of its own, the floor opens earlier, after the overrun so far by the answer's `Date`
 * (`Date` - `nextBuildAt`, 1 to 900 seconds), and `getPack`'s answer carries that time as `retryAt`; a later such answer of the same table may name a new time while
 * the overrun keeps up with the time waited (see `DataPackInfo.retryAt`). `onPackChanged` stays unfired for it: ask `getPack` again when that floor opens and read
 * the new `version`. The plugin never sees the URL.
 *
 * The retry time (1.27.0): after a failed download the held copy's `DataPackInfo` (from `getPack` and `packVersion`) carries `retryAt`, and while no copy is held the
 * `unavailable` rejection of both methods carries it (`HostError.retryAt`). `packVersion` never downloads: it is the read for a line such as "The last update failed;
 * trying again at <time>." or for the time to call `getPack` again after a failure, and it costs no request; the earlier time past `nextBuildAt` is on
 * `getPack`'s answer only, so a failure line never shows it. `getPack` may download. `refreshPack` is the Refresh button only, never to read
 * the time: it downloads at once whenever neither of its refusals applies.
 */
export interface DataNamespace {
    getPack(params: {
        id: DataPackId;
    }): Promise<DataPack>;
    packVersion(params: {
        id: DataPackId;
    }): Promise<DataPackInfo>;
    /**
     * 1.27.0 (`^1.27`). Asks the host for a newer table now (the Refresh button), for `market.hubs` only; any other id is `bad_params`. It never bypasses the table's own period:
     * while no download is due (the held copy's `nextBuildAt` is ahead, or a download at or after it brought no newer table less than one table period ago, or before
     * the earlier time after a download's overrun, see `DataPackInfo.retryAt`) the answer is `{ ok: false, reason: 'fresh', nextAt }`, with `nextAt` the time the next download is due, and while a
     * failure back-off runs it is
     * `{ ok: false, reason: 'retry_later', retryAt }`; neither sends a request. Otherwise the host downloads at once (joining a download already running) and answers
     * `{ ok: true, version }` or `{ ok: false, reason: 'unavailable', retryAt }`. A refusal is an answer, not an error.
     */
    refreshPack(params: {
        id: 'market.hubs';
    }): Promise<RefreshPackResult>;
    onPackChanged(handler: (event: {
        id: DataPackId;
        version: string;
    }) => void): void;
}
export type FitSlotGroup = 'high' | 'mid' | 'low' | 'rig' | 'subsystem' | 'service';
export type FitModuleState = 'online' | 'offline' | 'overheat';
export interface EngineFit {
    hullTypeId: number;
    modules: Array<{
        group: FitSlotGroup;
        index: number | null;
        typeId: number;
        chargeTypeId?: number;
        state: FitModuleState;
        mutated?: boolean;
    }>;
    drones: Array<{
        typeId: number;
        quantity: number;
        active: number;
    }>;
    cargo: Array<{
        typeId: number;
        quantity: number;
    }>;
    implants: number[];
}
export type SkillLevel = 0 | 1 | 2 | 3 | 4 | 5;
/**
 * The pilot behind a calculation. `allV`: every skill at V. `allZero`: every skill at 0. `levels` (1.16.0): the listed skills at their level; a skill
 * missing from `levels` counts 0, never V (unless `base` is `'allV'`, 1.18.0); at most 1,000 pairs, no id twice. `implants` (1.16.0, any kind): the pilot's active clone, at most 10 type ids;
 * an implant line of the fit itself never applies. A skill or implant id the engine does not know (newer than its SDE) is ignored and counted in
 * `skillsIgnored`; an unknown implant is also an `unmodelled` entry. 1.14.0 and 1.15.0 hosts accept only `{ kind: 'allV' }`.
 * `base` (1.18.0, kind `levels` only): `'allZero'` (the default, also when absent) counts a skill missing from `levels` as 0; `'allV'` counts it as V,
 * and the listed pairs override. Any other value, or `base` on kind `allV` or `allZero`, is `bad_params` at `skills.base`.
 */
export type SkillInput = {
    kind: 'allV';
    implants?: number[];
} | {
    kind: 'allZero';
    implants?: number[];
} | {
    kind: 'levels';
    levels: Array<[typeId: number, level: SkillLevel]>;
    base?: 'allV' | 'allZero';
    implants?: number[];
};
export type FitStatBlock = 'resources' | 'dps' | 'tank' | 'capacitor' | 'navigation' | 'targeting' | 'drones' | 'range';
export interface FitUse {
    used: number;
    capacity: number;
}
export interface FitEngineMeta {
    version: string;
    sdeVersion: string;
    hashVersion: number;
}
export interface FitViolation {
    code: 'cpu' | 'pg' | 'calibration' | 'turrets' | 'launchers' | 'slots' | 'subsystemMissing' | 'subsystemDuplicate' | 'groupLimit' | 'alpha' | 'unknownItem' | 'notFittable' | 'charge' | 'droneBandwidth' | 'droneBay' | 'hullRestriction' | 'rigSize' | 'skill';
    severity: 'hard' | 'soft';
    subject?: {
        typeId: number;
        group?: FitSlotGroup;
        index?: number | null;
    };
    use?: FitUse;
    skill?: {
        typeId: number;
        needs: number;
        has: number;
    };
    consumers?: Array<{
        typeId: number;
        amount: number;
    }>;
    /** 1.16.0: with `validate` `options.train` under kind `levels`: the skills that lift this resource violation. */
    train?: Array<{
        skillTypeId: number;
        level: SkillLevel;
        gain: number;
    }>;
}
export interface FitResources {
    cpu: FitUse;
    pg: FitUse;
    calibration: FitUse;
    turrets: FitUse;
    launchers: FitUse;
    droneBandwidth: FitUse;
    droneBay: FitUse;
    slots: Record<FitSlotGroup, FitUse>;
}
/**
 * Every number in a fit result is a finite number, except `capacitor.secondsToEmpty`, which is `null` when the capacitor is stable (it never
 * empties, so the time is undefined). A figure the engine cannot compute for a fit is sent as `0`, and `flags.estimated` carries one entry
 * `{ block, reason: 'not computable for this fit' }` for its block. No other field is ever `null`, so `.toFixed()` is safe on all of them.
 */
export interface FitStats {
    dps: {
        total: number;
        weapons: number;
        drones: number;
        applied: number;
        perWeapon: Array<{
            weapon: string;
            theoretical: number;
            applied: number;
        }>;
    };
    /** The weapons' volley alone (turrets and launchers), like the game's fitting window; 0 for a drone boat. Before 1.19.0 it included the drones' volley; that is `drones.volley` now. */
    volley: number;
    /** Per layer: hit points and resists. `resists` are fractions from 0 to 1 (0.5 is a 50 % resist); the game shows them as percent. */
    tank: {
        ehp: number;
        shield: FitLayer;
        armor: FitLayer;
        hull: FitLayer;
        activeRepPerSec: number;
        /** 1.16.0, per second: local peak repair, the capacitor-limited sustained estimate, and what the fit repairs on others (`capacitor` in GJ, the rest in hit points). */
        repair: {
            shield: number;
            armor: number;
            hull: number;
            sustained: {
                shield: number;
                armor: number;
                hull: number;
            };
            remote: {
                shield: number;
                armor: number;
                hull: number;
                capacitor: number;
            };
        };
    };
    capacitor: {
        capacity: number;
        rechargeSec: number;
        stable: boolean;
        stablePct: number;
        /** Seconds until the capacitor is empty; `null` when it is stable (never empties). The only nullable stat. */
        secondsToEmpty: number | null;
        /** 1.21.0: the game's capacitor delta, GJ per second (negative when the capacitor drains), and as a percentage of the peak recharge. Not the verdict: `stable` is. Not meaningful when `flags.unmodelled` names the capacitor (charge-fed ancillary reps). */
        deltaGJps: number;
        deltaPct: number;
    };
    navigation: {
        speed: number;
        alignTime: number;
        signatureRadius: number;
    };
    targeting: {
        lockRange: number;
        scanResolution: number;
        maxLockedTargets: number;
        sensorStrength: number;
    };
    drones: {
        dps: number; /** 1.19.0: the launched drones' volley (hit points of damage per salvo); `volley` above is the weapons' alone. */
        volley: number; /** The launched drones' bandwidth only; drones that sit in the bay do not count. */
        bandwidthUsed: number;
        bandwidthAvail: number;
        bayUsed: number;
        bayAvail: number;
        inBay: number;
        active: number;
        maxActive: number;
        activeTypeIds: number[];
    };
    range: Array<{
        weapon: string;
        optimal: number;
        falloff: number;
    }>;
}
export interface FitLayer {
    hp: number;
    resists: {
        em: number;
        therm: number;
        kin: number;
        exp: number;
    };
}
export interface FitEvaluation {
    /** `skillsIgnored` (1.16.0): how many skill pairs and implant ids named an id the engine does not know (a count only, never ids). */
    engine: FitEngineMeta;
    skills: SkillInput['kind'];
    skillsIgnored: number;
    resources: FitResources;
    perModule: Array<{
        typeId: number;
        group: FitSlotGroup;
        index: number | null;
        cpu: number;
        pg: number;
    }>;
    stats: FitStats;
    violations: FitViolation[];
    flags: {
        estimated: Array<{
            block: FitStatBlock;
            reason: string;
        }>;
        unmodelled: Array<{
            what: string;
            affects: FitStatBlock[];
        }>;
    };
}
/**
 * One fit of a pasted text. `line` (1.15.0): the 1-based line of its header. `hash`, `hashVersion` and `designKey` (1.15.0) are what `hash`
 * answers for `fit`; they are left out when the hull did not resolve (`fit.hullTypeId` is 0 and the header is in `unresolved`).
 */
export interface FitParsed {
    name: string;
    fit: EngineFit;
    comments: string[];
    unresolved: Array<{
        line: number;
        text: string;
    }>;
    warnings: string[];
    line: number;
    hash?: string;
    hashVersion?: number;
    designKey?: string;
}
export interface FitItemRow {
    typeId: number;
    name: string;
    group: string;
    slot: FitSlotGroup | null;
    metaTier: number;
    cpu: number;
    pg: number;
    calibration?: number;
    /** 1.20.0, implants only: the slot, 1 to 10 (attribute 331). Left out for every other item and for an implant outside 1 to 10 (Genolution 'Auroral' AU-79 has 79). */
    implantSlot?: number;
}
export interface FitItemInfo {
    typeId: number;
    name: string;
    group: string;
    category: string;
    slot: FitSlotGroup | null;
    hardpoint: 'turret' | 'launcher' | null;
    rigSize: number | null;
    chargeTypeIds: number[];
    canOverheat: boolean;
    metaTier: number;
    alphaLegal: boolean;
    /** 1.20.0: an implant's slot, 1 to 10; `null` for every other type and for an implant outside 1 to 10 (AU-79). */
    implantSlot: number | null;
}
/** One implant of a `FitImplantSet`. `modelled` is true when the engine applies the implant's modifiers (a set bonus can still change no stat the rail shows). */
export interface FitImplantSetMember {
    typeId: number;
    name: string;
    slot: number;
    modelled: boolean;
}
/**
 * 1.20.0: one implant set at one grade, derived from the SDE (no set table exists): the implants that share a set-key attribute and a grade word.
 * `id` is `"<set-key attribute id>:<grade>"` with the grade in lower case, `"none"` when there is no grade (`"838:mid"`, `"1799:none"`); it is stable for one SDE build.
 * `family` is `"Crystal"`; `name` is `"Mid-grade Crystal"` (the family when `grade` is `null`); `slots` are the slots the members occupy, ascending;
 * `members` are ordered by slot, then type id.
 */
export interface FitImplantSet {
    id: string;
    family: string;
    grade: 'high' | 'mid' | 'low' | null;
    name: string;
    slots: number[];
    members: FitImplantSetMember[];
}
/** 1.21.0: one bonus of an implant as the game lists it (SDE display name and unit; `name` is '' for a set key the SDE does not name); `value` is resolved beside the other implants of the call (set bonuses applied). */
export interface FitImplantBonus {
    attributeId: number;
    name: string;
    unitId: number | null;
    unit: string;
    base: number;
    value: number;
    setKey: boolean;
}
export interface FitImplantBonusItem {
    typeId: number;
    name: string;
    slot: number | null;
    modelled: boolean;
    bonuses: FitImplantBonus[];
}
/** What a total acts on: the ship, the pilot, a module group (`name` is the SDE group name) or the modules that need a skill (`name` is the SDE skill name). Structured, no wording: the caller words it. */
export interface FitImplantTarget {
    kind: 'ship' | 'pilot' | 'group' | 'skill';
    name?: string;
}
/**
 * One attribute added up over carriers that act on the same targets: 'sum' (points, +), 'percent' (compounded, as the engine applies it), 'product' (multipliers).
 * One attribute can have several totals (a ship hardwiring and a drone hardwiring read the same attribute), told apart by `targets` (de-duplicated, stable order; empty when no target can be named).
 */
export interface FitImplantTotal {
    attributeId: number;
    name: string;
    unitId: number | null;
    unit: string;
    combine: 'sum' | 'percent' | 'product';
    value: number;
    typeIds: number[];
    targets: readonly FitImplantTarget[];
}
/** The set multiplier on the bonuses of one set key: the product of the chosen members' key values. */
export interface FitImplantSetFactor {
    setKey: number;
    family: string;
    typeIds: number[];
    factor: number;
}
export interface FitEsiFitting {
    fitting_id?: number;
    name: string;
    description: string;
    ship_type_id: number;
    items: Array<{
        type_id: number;
        flag: string;
        quantity: number;
    }>;
}
export interface FitEsiBody {
    name: string;
    description: string;
    ship_type_id: number;
    items: Array<{
        type_id: number;
        flag: string;
        quantity: number;
    }>;
}
export type FitSearchCategory = 'ship' | 'module' | 'charge' | 'drone' | 'implant' | 'subsystem';
/** Damage splits for `options.damagePattern` (1.16.0); `uniform` is the default. A later minor may add presets. */
export type FitDamagePatternId = 'uniform' | 'em' | 'thermal' | 'kinetic' | 'explosive';
export interface FitEvaluateOptions {
    defaultAmmo?: boolean;
    damagePattern?: FitDamagePatternId;
}
/** The skills a type needs: `direct` its own list, `all` the closure with the prerequisites (direct first, each skill once at the highest level any path needs). */
export interface FitSkillReq {
    typeId: number;
    direct: Array<[skillTypeId: number, level: SkillLevel]>;
    all: Array<[skillTypeId: number, level: SkillLevel]>;
}
/** `missing`: every unmet requirement of the type's own `direct` list at the pilot's levels (a missing prerequisite of a skill the pilot has trained is not a violation: the game checks only the item's own skills; owner ruling 2026-11-14). The training list is `requiredSkills().all`. */
export interface FitCanUse {
    typeId: number;
    ok: boolean;
    missing: Array<{
        typeId: number;
        needs: SkillLevel;
        has: SkillLevel;
    }>;
}
/** What a solve may do. `gates`: keep the stat at least `atLeast` percent (0 to 100) of the baseline; a stat once. `from: 'fallback'`: the engine's rule for the kind; the result echoes the policy used. `allowT2toT1`: ignored by Fix and Downgrade; only Convert's classic pass honours it. */
export interface FitSolvePolicy {
    gates: Array<{
        stat: 'dps' | 'ehp';
        atLeast: number;
    }>;
    baseline: 'flown' | 'designed';
    allowT2toT1: boolean;
    allowRigChanges: boolean;
    from: 'request' | 'fallback';
}
/** `prices`: `[typeId, isk]` pairs of the open fit's items only, at most 512, a type id once. */
export interface FitSolveOptions extends FitEvaluateOptions {
    prices?: Array<[typeId: number, isk: number]>;
}
export interface FitSolveNumbers {
    dps: number;
    ehp: number;
    capStable: boolean;
    valid: boolean;
}
/**
 * One changed line against the request's fit. `index`: the request module's index (null when it had none), or the drone stack's position in `fit.drones`.
 * `to: null` empties the line. `chargeFrom` and `chargeTo` are present only when the charge changes (null: no charge). `quantity`: a drone line's new quantity.
 * `downgrade`: `to` has a lower meta level (attribute 633, absent = 0) than `from`, or the change empties a line the pilot cannot use.
 */
export interface FitSolveChange {
    group: FitSlotGroup | 'drone';
    index: number | null;
    from: number | null;
    to: number | null;
    chargeFrom?: number | null;
    chargeTo?: number | null;
    quantity?: number;
    downgrade: boolean;
}
/**
 * A note on the chosen fit that does not change the status. `officer`: one per line that holds an Officer module (`index`: the request module's index, null when it had none, or the drone stack's position).
 * `capacitor`: the fit's capacitor is clearly worse than the flown fit's; `train`: at most 3 skill lines that would improve it.
 */
export type FitSolveWarning = {
    code: 'officer';
    group: FitSlotGroup | 'drone';
    index: number | null;
    typeId: number;
    message: string;
} | {
    code: 'capacitor';
    message: string;
    train: Array<{
        skillTypeId: number;
        level: SkillLevel;
    }>;
};
export interface FitSolveResult {
    status: 'ok' | 'ok_with_downgrades' | 'no_candidate' | 'uncertain';
    fit?: EngineFit;
    changes: FitSolveChange[];
    baseline: {
        designed: FitSolveNumbers;
        flown: FitSolveNumbers;
        used: 'flown' | 'designed';
    };
    result?: FitSolveNumbers;
    /** What stopped a `no_candidate` solve. `capacitor`: the fit is not capacitor stable while the original is. `subsystems`: a convert onto another Tech 3 hull (the solver never picks subsystems). */
    binding?: {
        code: FitViolation['code'] | 'gate' | 'capacitor' | 'subsystems';
        use?: FitUse;
        unit?: 'tf' | 'MW' | 'points' | 'Mbit/s' | 'm3';
        stat?: 'dps' | 'ehp';
        reached?: number;
        atLeast?: number;
        skill?: {
            typeId: number;
            needs: SkillLevel;
            has: SkillLevel;
        };
    };
    closest?: Array<{
        fit: EngineFit;
        changes: FitSolveChange[];
        result: FitSolveNumbers;
    }>;
    train?: Array<{
        skillTypeId: number;
        level: SkillLevel;
        lifts: 'binding' | 'gate';
    }>;
    /** Always present, empty when there is nothing to warn of. A job result keeps it. */
    warnings: FitSolveWarning[];
    uncertain?: Array<{
        what: string;
    }>;
    capped: boolean;
    evaluations: number;
    skillsIgnored: number;
    policy: FitSolvePolicy;
    engine: FitEngineMeta;
}
/** Every fit converted onto every hull (the pairs: fits outer, hulls inner). `ref`: your name for the fit, 1 to 128 bytes, once per spec, no C0 control character but tab, LF and CR (`bad_params`). At most 5,000 pairs. */
export interface FitJobSpec {
    kind: 'convert';
    fits: Array<{
        ref: string;
        fit: EngineFit;
    }>;
    hulls: number[];
    skills: SkillInput;
    policy: FitSolvePolicy;
    options?: FitSolveOptions;
}
/** `lost` and `expired` are answered by the host: `lost`, the engine that ran the job is gone (it restarted or the app did); `expired`, the retention ended. */
export type FitJobState = 'queued' | 'running' | 'done' | 'cancelled' | 'failed' | 'expired' | 'lost';
/** `unread`: results not acknowledged yet. `endedAt` and `expiresAt` are Unix ms and set once the job ended; an `expired` job (answered by the host after the engine stopped) may lack `endedAt`. `failure`: with state `failed`, the pair and the error that ended the job, as a code and a fixed text (`pair 3 (fits[1]): too_large: the fit is too large for the engine`). */
export interface FitJobStatus {
    jobId: string;
    state: FitJobState;
    total: number;
    done: number;
    counts: {
        ok: number;
        ok_with_downgrades: number;
        no_candidate: number;
        uncertain: number;
    };
    unread: number;
    estimateMs: number;
    failure?: string;
    endedAt?: number;
    expiresAt?: number;
    engine: FitEngineMeta;
}
export interface FitJobResult {
    ref: string;
    hullTypeId: number;
    solve: Omit<FitSolveResult, 'engine' | 'closest'>;
}
export interface FitNamespace {
    /** Any fit method can fail `too_large` with "params: the request is larger than the fitting engine takes" (a request over 4 MiB minus 64 KiB of UTF-8 bytes, e.g. a very large jobStart). */
    /** 1.16.0 adds the solver figures: `evalMs` (running mean of one evaluation), `workers`, `evaluationsPerSolve` and `maxJobMs` (the longest job estimate). All four are absent when the engine does not report solver figures. */
    info(): Promise<FitEngineMeta & {
        state: 'ready' | 'starting';
        engine: FitEngineMeta;
        evalMs?: number;
        workers?: number;
        evaluationsPerSolve?: {
            refit: number;
            downgrade: number;
            convert: number;
        };
        maxJobMs?: number;
    }>;
    /** `text`: at most 1 MiB as UTF-8 (`too_large`); a C0 control character other than tab, LF and CR is `bad_params`. */
    parse(p: {
        text: string;
    }): Promise<{
        fits: FitParsed[];
        engine: FitEngineMeta;
    }>;
    render(p: {
        fit: EngineFit;
        name: string;
        format: 'eft';
    }): Promise<{
        text: string;
        engine: FitEngineMeta;
    }>;
    /** `designKey` (1.15.0): the hash of what an ESI fitting keeps of the fit, that is `toEsi`, then `fromEsi` (`fitting_id` 0), then `hash`. */
    hash(p: {
        fit: EngineFit;
    }): Promise<{
        hash: string;
        hashVersion: number;
        designKey: string;
        engine: FitEngineMeta;
    }>;
    searchItems(p: {
        query?: string;
        category?: FitSearchCategory;
        slot?: FitSlotGroup;
        metaGroups?: number[];
        fitsHull?: number;
        /** 1.20.0: only implants of this slot, an integer from 1 to 10 (anything else is `bad_params`). */
        implantSlot?: number;
        /** 1.20.0: only subsystems of this kind (SDE attribute 1366: core 125, defensive 126, offensive 127, propulsion 128). Without `slot` it implies `slot: 'subsystem'`; anything else is `bad_params`. Combines with `fitsHull`. */
        subsystemSlot?: 'core' | 'defensive' | 'offensive' | 'propulsion';
        limit: number;
        cursor?: string;
    }): Promise<{
        items: FitItemRow[];
        cursor?: string;
        engine: FitEngineMeta;
    }>;
    itemInfo(p: {
        typeIds: number[];
    }): Promise<{
        items: FitItemInfo[];
        unknown: number[];
        engine: FitEngineMeta;
    }>;
    evaluate(p: {
        fit: EngineFit;
        skills: SkillInput;
        options?: FitEvaluateOptions;
    }): Promise<FitEvaluation>;
    /** `options.train` (1.16.0, kind `levels`): adds `train` lines to the violations a higher skill level lifts. */
    validate(p: {
        fit: EngineFit;
        skills: SkillInput;
        options?: {
            train?: boolean;
        };
    }): Promise<{
        resources: FitResources;
        violations: FitViolation[];
        skillsIgnored: number;
        engine: FitEngineMeta;
    }>;
    /** `hash`, `hashVersion` and `designKey` (1.15.0) are what `hash` answers for the returned `fit`. */
    fromEsi(p: {
        fitting: FitEsiFitting;
    }): Promise<{
        fit: EngineFit;
        name: string;
        description: string;
        unmapped: Array<{
            typeId: number;
            flag: string;
        }>;
        hash: string;
        hashVersion: number;
        designKey: string;
        engine: FitEngineMeta;
    }>;
    toEsi(p: {
        fit: EngineFit;
        name: string;
        description: string;
    }): Promise<{
        body: FitEsiBody;
        dropped: Array<{
            typeId: number;
            reason: 'noSlotFlag' | 'implant' | 'tooMany';
        }>;
        truncated: {
            name: boolean;
            description: boolean;
        };
        engine: FitEngineMeta;
    }>;
    /** 1.16.0. `typeIds` at most 512. */
    requiredSkills(p: {
        typeIds: number[];
    }): Promise<{
        items: FitSkillReq[];
        unknown: number[];
        engine: FitEngineMeta;
    }>;
    canUse(p: {
        skills: SkillInput;
        typeIds: number[];
    }): Promise<{
        items: FitCanUse[];
        unknown: number[];
        skillsIgnored: number;
        engine: FitEngineMeta;
    }>;
    /** 1.16.0. Moves the fit (`refit`, `downgrade`) or converts it to `target.hullTypeId` (`convert`, required there, refused for the other kinds). Under 30 s. */
    solve(p: {
        kind: 'refit' | 'downgrade' | 'convert';
        fit: EngineFit;
        skills: SkillInput;
        policy: FitSolvePolicy;
        target?: {
            hullTypeId: number;
        };
        options?: FitSolveOptions;
    }): Promise<FitSolveResult>;
    /**
     * 1.16.0 jobs. One job per plugin at a time (`rate_limited` for a second; the engine also holds at most 4 waiting jobs); more than 5,000 pairs or an
     * estimate over `maxJobMs` is `too_large`; a job id that is not yours or unknown is `not_found`. The engine keeps unread results 30 minutes after the job ends.
     */
    jobStart(p: {
        spec: FitJobSpec;
    }): Promise<{
        jobId: string;
        pairs: number;
        estimateMs: number;
        engine: FitEngineMeta;
    }>;
    jobStatus(p: {
        jobId: string;
    }): Promise<FitJobStatus>;
    /**
     * `limit` 0 to 50; `cursor` is an opaque string and always comes back (the last page and an empty page too). A page's results leave the engine only when
     * the next call names its cursor, so send `limit: 0` with the last cursor to acknowledge the last page. No cursor: the first unacknowledged result.
     * An unknown or stale cursor is `bad_params`.
     */
    jobPage(p: {
        jobId: string;
        cursor?: string;
        limit: number;
    }): Promise<{
        results: FitJobResult[];
        cursor: string;
        engine: FitEngineMeta;
    }>;
    jobCancel(p: {
        jobId: string;
    }): Promise<FitJobStatus>;
    /**
     * 1.20.0. The implant sets of this SDE build (56 set-grade entries, 334 implants, about 31 KB), sorted by family, then grade high, mid, low (the ungraded set last).
     * The engine derives them once at start; the answer is the same on every call. No parameters.
     */
    implantSets(): Promise<{
        sets: FitImplantSet[];
        engine: FitEngineMeta;
    }>;
    /**
     * 1.21.0. What up to ten implants give, as the game lists it, resolved together (set bonuses applied; about 4 KB at most).
     * `implants` is 1 to 10 type ids, each a positive int32; an empty list or an eleventh id is `bad_params`. `items` is one row per implant the engine knows, in request order;
     * `unknown` lists ids the SDE does not know or that are no implant, once each; `ignored` lists a second implant of an already used slot and a repeated id of an implant the engine cannot model. `totals` add each attribute up over its carriers; `sets` are the multipliers of the set keys.
     */
    implantBonuses(p: {
        implants: number[];
    }): Promise<{
        items: FitImplantBonusItem[];
        totals: FitImplantTotal[];
        sets: FitImplantSetFactor[];
        unknown: number[];
        ignored: number[];
        engine: FitEngineMeta;
    }>;
}
/**
 * Why a chat failed (1.4.0). `no_provider`: no provider the user allows for this plugin (or its key is missing or the keychain is locked).
 * `cap_reached`: the plugin's monthly token cap is used up. `provider_unreachable`: network, timeout or a server error. `provider_rejected`:
 * the provider refused the request (a wrong key, its rate limit, a request too long for the model). `model_unsupported`: the model is not
 * one of the provider's, or the provider does not know it.
 */
export type AiErrorCode = 'no_provider' | 'cap_reached' | 'provider_unreachable' | 'provider_rejected' | 'model_unsupported';
/** How a chat stream ended (1.4.0). `aborted`: by `abort`, or because the page that started it went away. `error`: an `error` event came just before. */
export type AiEndReason = 'stop' | 'tool_use' | 'max_tokens' | 'aborted' | 'error';
/** A model of a provider. `tools`: the model can call tools. `maxContext`: its context window in tokens, `null` when the provider does not say. */
export interface AiModelInfo {
    id: string;
    tools: boolean;
    maxContext: number | null;
}
/** A provider the user allows for this plugin (1.4.0): its id, the display name the user gave it, and its models. Never a key or a base URL. */
export interface AiProviderInfo {
    id: string;
    name: string;
    isDefault: boolean;
    models: AiModelInfo[];
    defaultModel: string | null;
}
/** A tool call the model made. `arguments` is `null` when the model's arguments were not valid JSON; answer it with an error `tool` message. */
export interface AiToolCall {
    callId: string;
    name: string;
    arguments: Record<string, unknown> | null;
}
/**
 * One turn of a conversation (1.4.0). A `tool` message answers the `AiToolCall` with the same `callId`. The system prompt is `AiChatRequest.system`.
 * An assistant message carries at most 64 `toolCalls`; a tool name is at most 128 characters and a `callId` at most 256. A field not listed here is refused.
 */
export type AiMessage = {
    role: 'user';
    content: string;
} | {
    role: 'assistant';
    content: string;
    toolCalls?: AiToolCall[];
} | {
    role: 'tool';
    callId: string;
    name: string;
    content: string;
};
/** A tool the model may call. `inputSchema` is the JSON Schema of its arguments. A model with `tools: false` is sent no tools. */
export interface AiTool {
    name: string;
    description: string;
    inputSchema: Record<string, unknown>;
}
/**
 * id: [A-Za-z0-9_-]{1,64}, unique among your open requests. messages 1..200, all text ≤ 512 KiB, tools ≤ 64, maxTokens 1..8192 (a whole number; default 4096).
 * `provider` and `model` are at most 256 characters. A field this type does not list is refused (`bad_params`) in the request, in every message, tool and tool call.
 */
export interface AiChatRequest {
    id: string;
    /** An id from `providers()`; absent: the provider with `isDefault`. A provider the user does not allow for this plugin is `no_provider`. */
    provider?: string;
    /** One of the provider's `models`; absent: its `defaultModel`. Another model is `model_unsupported`. */
    model?: string;
    system?: string;
    messages: AiMessage[];
    tools?: AiTool[];
    maxTokens?: number;
    /**
     * 1.23.0. A gesture grant (ServiceCallContext.gesture) to spend on this turn instead of a press in your own page. Only a turn on a provider that needs a user
     * act uses it (Claude Code), and such a turn runs with no tools at all in that provider (no EVE data tools: the request is the whole input). A grant that is
     * not yours, spent, expired, ended or already in a running turn: provider_rejected, nothing starts. On another provider it is ignored and not charged.
     */
    gesture?: string;
}
/**
 * One event of a chat stream (1.4.0), with the `id` of its request. `text` deltas join in order to the answer.
 * `tool_call`: run the tool and send its result as a `tool` message in your next request. `usage`: the tokens the request used.
 * `error`: one plain sentence for the user, never the provider's own text; `end` (`error`) follows. Every stream ends with one `end`.
 * `tool` (1.26.0): the provider ran one of the EVE data tools itself (Claude Code, through the host's MCP server), once per call, in order with the text; `name` is the
 * tool's name (letters, digits, `_` and `-`, never empty). It has no arguments and no result, and nothing to answer: show it as a step. Only a plugin whose
 * `engines.eve-cyno-api` range starts at 1.26.0 or later receives it; an older plugin gets no event for such a call.
 */
export type AiEvent = {
    id: string;
    type: 'text';
    delta: string;
} | ({
    id: string;
    type: 'tool_call';
} & AiToolCall) | {
    id: string;
    type: 'tool';
    name: string;
} | {
    id: string;
    type: 'usage';
    inputTokens: number;
    outputTokens: number;
} | {
    id: string;
    type: 'error';
    code: AiErrorCode;
    message: string;
} | {
    id: string;
    type: 'end';
    reason: AiEndReason;
};
/** 1.24.0. The user's limits for this plugin's AI use (Settings > AI). */
export interface AiLimits {
    /**
     * How many model replies one ask may take, on every provider: a whole number from 1 to 30 (12 by default; 1.26.0, it was 6, 12 or 16 before). A gesture grant pays
     * for this many Claude Code turns. A plugin whose `engines.eve-cyno-api` range starts below 1.26.0 is answered 6, 12 or 16: the largest of them that is not above
     * the user's number, and 6 when the number is below 6.
     */
    turnsPerAsk: number;
}
/**
 * Present when the plugin was granted `permissions.ai: true` (1.4.0). The host calls the provider the user set up in Settings > AI with the
 * user's key: a plugin never sees a key, a base URL or the account session, and the call does not use the plugin's `network` grant.
 *
 * At most 2 open streams per plugin. A monthly token cap per plugin (across all providers, local ones included) is checked before a
 * request opens; at the cap the stream ends with `cap_reached`. A reload, crash or stop of the page aborts its open streams, and events go
 * to the page that called `chat` only.
 */
export interface AiNamespace {
    /** The providers the user allows for this plugin, with their models. Never a key or a base URL. */
    providers(): Promise<AiProviderInfo[]>;
    /** Starts a stream and resolves `true` at once. Shape errors reject with `bad_params`, a reused `id` with `bad_params` as well, a third open stream with `rate_limited`; everything else arrives as `error` then `end`. */
    chat(request: AiChatRequest): Promise<true>;
    /** Closes the upstream request of stream `id`, which ends with `end` (`aborted`). `false` when no stream with that id is open. */
    abort(params: {
        id: string;
    }): Promise<boolean>;
    /** 1.24.0. The user's limits for this plugin's AI use. Read it at the start of an ask and keep the number for that ask: the user may change it between asks. Needs the `ai` permission, like the other calls. */
    limits(): Promise<AiLimits>;
    onEvent(handler: (event: AiEvent) => void): void;
}
/**
 * Why a data API call gave no result (1.4.0). `quota`: the keyless trial or the key's quota is used up: a normal state to show the user,
 * not a failure of the plugin. `key_required`: the tool needs a data key. `key_rejected`: the user's key is wrong or not allowed for the
 * tool. `not_found`: no such tool (or it is switched off). `bad_arguments`: the server refused the arguments. `unavailable`: network, a
 * server error, a timeout (30 s), a result over 1 MiB, or a data key the host cannot read.
 */
export type DataApiReason = 'quota' | 'key_required' | 'key_rejected' | 'not_found' | 'bad_arguments' | 'unavailable';
/** A tool of the EVE data API. `inputSchema` is the JSON Schema of its arguments (pass it on to the model as an `AiTool`). */
export interface DataApiTool {
    name: string;
    description: string;
    inputSchema: Record<string, unknown>;
}
/** A source of a result: show its name, link and license where you show the result. */
export interface DataApiAttribution {
    name: string;
    url: string;
    license: string;
}
/**
 * The answer of one tool call. `ok: true`: `text` is the answer in words (for the model), `data` the structured result, `attribution`
 * its sources. `ok: false`: `message` is one plain sentence for the user; `retryAfterSec` comes with `quota` when the server says.
 */
export type DataApiResult = {
    ok: true;
    tool: string;
    text: string;
    data: unknown;
    attribution: DataApiAttribution[];
} | {
    ok: false;
    reason: DataApiReason;
    message: string;
    retryAfterSec?: number;
};
/** 1.25.0. The published intel datasets of the EVE data API. */
export type DatasetName = 'intel-gates-now' | 'intel-systems-hour' | 'intel-gates-profile';
export type DatasetResult = {
    ok: true;
    name: DatasetName;
    data: unknown;
    fetchedAt: number;
    stale: boolean;
} | {
    ok: false;
    reason: 'not_published' | 'unavailable';
    message: string;
};
/**
 * The EVE data API (`https://data.eve-cyno.dev`), brokered by the host (1.4.0). Present when the plugin's granted `permissions.network`
 * holds `https://data.eve-cyno.dev`. The host makes the call and adds the user's free data key (Settings > AI) when one is set; the plugin
 * never sees it. Without a key the calls work within the keyless trial limits.
 */
export interface DataApiNamespace {
    /** The tools the data API offers. The host caches the list; a fetch counts as one of the 60 calls a minute, a cached list does not. Rejects with `unavailable` when the list cannot be fetched, or with `rate_limited` when a fetch would pass the 60 a minute. */
    tools(): Promise<DataApiTool[]>;
    /** tool: [a-z0-9_]{1,64}; arguments ≤ 64 KiB as JSON. 60 calls a minute and 4 at a time per plugin, then `rate_limited`; a bad `tool` or `arguments` is `bad_params`. Everything the server does is a `DataApiResult`. */
    call(params: {
        tool: string;
        arguments: Record<string, unknown>;
    }): Promise<DataApiResult>;
    /** `keyed`: the user has set a data key, and calls carry it. */
    status(): Promise<{
        keyed: boolean;
    }>;
    /** 1.25.0. One published dataset: the host downloads it (no data key, no plugin id, no arguments), keeps it in memory and on disk, and asks the server again only after the dataset's fixed refresh floor (60 s for `intel-gates-now`, 300 s for `intel-systems-hour`, 3600 s for `intel-gates-profile`). `fetchedAt`: epoch ms of the last download or 304; `stale`: the last refresh failed and this is the kept copy. 60 calls a minute per plugin, cached answers included, then `rate_limited`; an unknown `name` is `bad_params`. */
    dataset(params: {
        name: DatasetName;
    }): Promise<DatasetResult>;
}
/** One line of a chat channel the user picked: who wrote what, and never which of the user's characters heard it. */
export interface ChatLine {
    channel: string;
    /** Log time, epoch milliseconds, 1 s resolution. */
    at: number;
    speaker: string;
    /** Cut at 1024 characters. */
    text: string;
}
/** Per pick: `following` is true when a session of the channel started after the last daily downtime. With the game's "Log Chat to File" off it is false, so a tool that warns the user can say it is deaf. A client closed today still counts: `following` with an old `lastLineAt` is a quiet channel. */
export interface ChatChannelState {
    channel: string;
    following: boolean;
    /** Log time of the newest line seen since the app started; null when there was none. */
    lastLineAt: number | null;
}
export interface ChatBatch {
    lines: ChatLine[];
    /** Lines dropped since the previous batch, because more arrived than a batch holds. */
    dropped: number;
}
/**
 * The chat channels the user picked for this plugin, and nothing else: no other channel is read. Lines are live, one line however many
 * of the user's clients hear it, and nothing old is ever delivered. The picks belong to the user: a plugin reads them and can open the
 * picker, it cannot set them.
 *
 * Needs `permissions.logs` with `chatlogs`, and does not depend on `permissions.characters`. The namespace exists only for a plugin that
 * cannot send data out (no network, no service provided, no AI, no account) or that is built in; the host checks this for every batch and
 * delivers nothing when the check fails.
 */
export interface ChatNamespace {
    /** The user's picks for this plugin, which can be empty. */
    channels(): Promise<string[]>;
    /** Opens the host's picker, from the main page, on a user gesture, like `files`. Answers the picks after the dialog: the old ones when the user cancels. */
    pickChannels(): Promise<string[]>;
    /** One entry per pick. Cynod follows a pick once a page subscribed: before that every entry says `following: false`. */
    state(): Promise<ChatChannelState[]>;
    /** Starts delivery to this page through `onLines`. It holds the plugin awake, and it ends with the page. */
    subscribe(): Promise<true>;
    /** Batches come every 250 ms at most, 4 per second, 500 lines each; the newest lines are kept. */
    onLines(handler: (batch: ChatBatch) => void): void;
    /** The user changed the picks. Reaches the pages that subscribed. */
    onChannelsChanged(handler: (channels: string[]) => void): void;
}
/** API 1.12.0. A value in a column: NULL, an integer or real (integers within +-(2^53-1)), text, or a blob. */
export type DbValue = null | number | string | Uint8Array;
/** `?`, `?NNN` (array) or `:name`, `@name`, `$name` (object). */
export type DbParams = DbValue[] | Record<string, DbValue>;
export interface DbStatement {
    sql: string;
    params?: DbParams;
}
/** A table whose rows belong to a character: `column` holds the character id (an INTEGER, NULL marks a plugin-local row). */
export interface DbOwned {
    table: string;
    column: string;
}
/**
 * API 1.12.0 (`^1.12`): the plugin's own SQLite database, kept by the host in a separate process. Needs `permissions.database: { quotaMB }`
 * (1 to 2048) and the user's consent. **Built-in plugins only for now**: for any other plugin the manifest field is ignored, the namespace
 * does not exist and `host.capabilities().features.db` is false.
 *
 * - The host checks every statement before it runs (one statement per entry; no ATTACH, VACUUM, triggers, temp objects, extensions or
 *   pragmas; FTS5 is the only virtual table module). A refused statement is `bad_params`.
 * - Schema changes are only allowed in `migrate`; `query` is read only; `write` runs all its statements in one transaction.
 * - A call over its time cap (`query` 10 s, `write` 30 s, `migrate` 120 s) is `timeout`; the host stops the database process and the call
 *   changes nothing. A write past the quota is `too_large`.
 */
export interface DbNamespace {
    /** Runs `statements` in one transaction when the schema version is below `version`, then sets it. `owned` lists every owned table after this version. */
    migrate(p: {
        version: number;
        statements: (string | DbStatement)[];
        owned: DbOwned[];
    }): Promise<{
        ran: boolean;
        from: number;
        to: number;
    }>;
    /** Read only. At most `limit` rows (default 10 000, at most 100 000) and 1 MiB per call; `more` says rows remain. `keyset` names 1 to 4 unique, non-NULL, ascending output columns for stateless paging with `cursor`. */
    query(p: {
        sql: string;
        params?: DbParams;
        limit?: number;
        keyset?: string[];
        cursor?: string;
    }): Promise<{
        columns: string[];
        rows: DbValue[][];
        more: boolean;
        cursor: string | null;
    }>;
    /** All statements in one transaction: all or nothing. `lastInsertRowid` is null when nothing was inserted or the rowid is outside +-(2^53-1). An upsert (INSERT ... ON CONFLICT ... DO UPDATE) always reports null, whether it inserted or updated; use RETURNING rowid. */
    write(p: {
        statements: DbStatement[];
    }): Promise<{
        changes: number[];
        lastInsertRowid: number | null;
    }>;
    /** bytes: pages in use; quotaBytes: the granted quota; fileBytes: the database, its WAL and a kept damaged copy on disk; quarantinedAt: when a damaged file was set aside this session, else null. */
    usage(): Promise<{
        bytes: number;
        quotaBytes: number;
        fileBytes: number;
        quarantinedAt: number | null;
    }>;
    /**
     * 1.13.0: saves a copy of the database to a file the user picks in a host dialog. Main page only, one user gesture, no params; the plugin never sees the path.
     * Resolves `true` when the file was written, `false` when the user closed the dialog. The copy holds the owned rows (it is the user's own copy).
     */
    backup(): Promise<boolean>;
    /**
     * 1.13.0: replaces the database with a backup the user picks, after the host asked "Replace the database with this backup?". Main page only, one user gesture, no params.
     * The host checks the file before anything is replaced (a backup of this plugin, no triggers, within the quota; else `unavailable` or `too_large`, nothing changed) and drops the
     * rows of owners the plugin may not see. Resolves `true` when the backup is in place, `false` when the user closed a dialog. Calls in flight fail `unavailable`; run `migrate` again afterwards.
     */
    restore(): Promise<boolean>;
}
export interface EveCyno {
    host: HostNamespace;
    storage: StorageNamespace;
    commands: CommandsNamespace;
    settings: SettingsNamespace;
    status: StatusNamespace;
    tile: TileNamespace;
    theme: ThemeNamespace;
    /** 1.22.0. */
    window: WindowNamespace;
    characters?: CharactersNamespace;
    esi?: EsiNamespace;
    logs?: LogsNamespace;
    services?: ServicesNamespace;
    clipboard?: ClipboardNamespace;
    windows?: WindowsNamespace;
    overlays?: OverlaysNamespace;
    thumbnails?: ThumbnailsNamespace;
    hotkeys?: HotkeysNamespace;
    notifications?: NotificationsNamespace;
    files?: FilesNamespace;
    gamelog?: GamelogNamespace;
    data?: DataNamespace;
    ai?: AiNamespace;
    dataapi?: DataApiNamespace;
    chat?: ChatNamespace;
    db?: DbNamespace;
    fit?: FitNamespace;
    /** 1.17.0: present when the manifest has `permissions.optional`. */
    permissions?: PermissionsNamespace;
    account?: Reserved;
}
/** The host-provided `eveCyno` global of the current plugin page. */
export declare function getEveCyno(): EveCyno;
