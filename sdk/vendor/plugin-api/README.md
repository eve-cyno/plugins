# @eve-cyno/plugin-api

The plugin SDK for the EVE-Cyno desktop app: types and helpers for writing plugins.

This package is licensed under the MIT License (see `LICENSE`). The rest of the repository is
source-available under PolyForm Strict 1.0.0 (see the root `LICENSE`).

## Entry point

`import { getEveCyno } from '@eve-cyno/plugin-api'` resolves to built JavaScript and declarations (`exports["."]` ->
`dist/index.js`, `dist/index.d.ts`), so it needs no TypeScript loader. In this repository `npm --prefix host run build:plugin-api`
builds them.

**Call limit (every method but `services.result`).** All pages of one plugin share one budget: 100 calls, refilled at 100 a second (`services.result`, the answer to a service call, is exempt). A call past it is refused
before it runs with `rate_limited` and the method's name as the message (`db.write`); nothing happened, so the same call may go again
after a short wait, a write too. The namespaces' own limits below come on top. Pace your calls on your side (the Assets plugin keeps
a bucket under the host's and retries this refusal) and never treat it as an ESI error or a lost write.

## Frozen surface (1.30.0)

The 1.30.0 public declarations are frozen as `api/1.30.0.d.ts`, a byte snapshot of the built `dist/index.d.ts` (`host/src/selftest-freeze.ts`
compares them, line endings normalised to LF). The package is public on npm (`publishConfig.access`); the first publish is made by hand, and `prepack` rebuilds `dist` from `src` first. A later change to the surface bumps
`version` in `package.json` and `HOST_API.version` (`host/src/manifest.ts`) together and adds a new snapshot `api/<version>.d.ts`
(the check then points at it); the old snapshot stays. Never change a snapshot's declarations in place once a version is published; until the first publish, a doc-comment-only edit of the current (unreleased) snapshot is allowed, together with the same edit in `src`, because the freeze check compares the snapshot with the build (the check pins the hashes of the older snapshots).
1.22.0 adds the `window` namespace with the event `onClosed(handler)`: the user closed the plugin's own window (opened with "Open in its own window") with its close button or the window manager's, or its window is dropped after a crash; the page keeps running, hidden, and the handler gets no argument. Every plugin has the namespace and it needs no permission (`capabilities().features.window` is `true`); it fires once per window, again after each reopen, and not on a minimise, a hide, focus loss, "Back to main window", the main window's close, a close by the host or the app's quit (a plugin that uses it needs `^1.22`); 1.21.0 adds the method `implantBonuses({ implants })` to `fit` (1 to 10 implant type ids, each a positive int32, else `bad_params`; answers `items` with the bonus rows of each implant, `totals` per attribute and target set (each with `targets`: `ship`, `pilot`, `group` or `skill`, a name for the last two), `sets` with the set multipliers, `unknown`, `ignored` and `engine`; a plugin that uses it needs `^1.21`), and `capacitor.deltaGJps` and `capacitor.deltaPct` to the fit stats (the game's capacitor delta in GJ/s and as a percentage of the peak recharge; additive, no `^1.21` needed to read them, absent from an older engine); 1.20.0 adds implant slots and sets to the fit catalogue: `implantSlot` on the `searchItems` rows (`FitItemRow`, left out when the item is no implant or has no slot 1 to 10) and on `itemInfo` (`FitItemInfo`, `null` then), an `implantSlot` filter (1 to 10) in `searchItems`, a `subsystemSlot` filter (`core`, `defensive`, `offensive`, `propulsion`; implies slot `subsystem`) in `searchItems`, and the method `implantSets()` (the SDE's 56 set-grade entries with their members, sorted by family, then grade high, mid, low; a plugin that uses them needs `^1.20`); 1.19.0 adds `drones.volley` to the fit stats (the launched drones' volley) and changes what `volley` means: the weapons' alone, as the game's fitting window shows it (before 1.19.0 it also held the drones'); `drones.bandwidthUsed` counts the launched drones only, and `tank.shield|armor|hull.resists` are documented as fractions from 0 to 1 (additive, no `^1.19` needed to read them); 1.18.0 adds `base` (`'allV'` or `'allZero'`) to the `levels` skills of `fit`: with `'allV'` a skill missing from `levels` counts V (a plugin that sends it needs `^1.18`); 1.17.0 adds optional permissions: the manifest field `permissions.optional` (`esi`, `network`, `clipboard`, `notifications`; such a manifest needs `^1.17`), the `permissions` namespace (`get`, `request`; present only when the manifest lists optional items) and `characters.open` (the Characters page or the re-authorisation of one character; a plugin that uses it needs `^1.17`); 1.16.0 adds to the `fit` namespace: `levels` skills with `implants` (plus `implants` on `allV` and `allZero`), the methods `requiredSkills`, `canUse`, `solve`, `jobStart`, `jobStatus`, `jobPage` and `jobCancel`, `damagePattern` in the evaluate options, `train` in `validate`, `skillsIgnored`, `stats.tank.repair` and the solver figures of `info` (a plugin that uses them needs `^1.16`); 1.15.0 adds hash fields to the `fit` results: each fit of `parse` has `line` and, when its hull resolved, `hash`, `hashVersion` and `designKey`; `hash` and `fromEsi` answer `designKey` (and `fromEsi` also `hash` and `hashVersion` of the fit it returns); a plugin that reads them needs `^1.15`; 1.14.0 adds the `fit` namespace (the fitting engine on this computer; manifest field `permissions.fit: true`; a plugin that uses it needs `^1.14`); 1.13.0 adds the stream save to `files` (`beginSave`, `writeChunk`, `endSave`, `abortSave`) and `backup()` and `restore()` to `db` (a plugin that uses them needs `^1.13`); 1.12.0 adds the `db` namespace (the plugin's own SQLite database in a separate host process; manifest field `permissions.database: { quotaMB }`; built-in plugins only for now; a plugin that uses it needs `^1.12`); 1.11.0 adds the data pack id `sde.types` to `DataPackId` (read only by the built-in assets plugin; a plugin that asks for it needs `^1.11`); 1.10.0 adds `query` to `esi.get`, the cache fields `pages`, `lastModified`, `etag`, `expiresAt` and `fromCache` to its result, and the method `esi.lookup` (see ESI below; a plugin that reads the new result fields needs `^1.10`); 1.9.0 added the manifest field `suspendUnderPressure` (with `background`: when memory is low the host may suspend the plugin after it has been hidden, unheld and idle for the idle period; the next use starts it again, so keep nothing a restart cannot rebuild; no change to the declarations, `api/1.9.0.d.ts` equals `api/1.8.0.d.ts`); 1.8.0 added `esi.setWaypoints` (several characters and destinations under one gesture, one answer per character); 1.7.0 added `characters.portrait`, the manifest flag `windows` (the window list only, without window control) and `muted` in the `notifications.show` answer (true when the user muted the plugin: no toast came, so play no sound); 1.6.0 added `esi.setWaypoint`, `host.openLink` and `settings.onPreview`; 1.5.0 added the `chat` namespace; 1.4.0 added `ai` and `dataapi`; 1.3.0 added `data`; 1.2.0 added `gamelog`; 1.1.0 added `files`. The older snapshots `api/1.0.0.d.ts`, `api/1.1.0.d.ts`,
1.23.0 adds three optional fields and nothing else (a plugin that uses any of them needs `^1.23`): `ServiceCallParams.gesture` (`'grant'` or `'revoke'`), `ServiceCallContext.gesture` (a string) and `AiChatRequest.gesture` (a string). They carry a host gesture grant from a consumer's user act (a real press in its main page) through a provider to the provider's Claude Code turn; see Gesture grants below.
1.24.0 adds three methods and four types (a plugin that uses one needs `^1.24`). `eveCyno.ai.limits()` returns `AiLimits`, `{ turnsPerAsk: 6 | 12 | 16 }`, the user's "Turns per ask" for your plugin (Settings > AI; 12 unless the user changed it). It is how many model replies one ask may take, on every provider, and a gesture grant pays for that many Claude Code turns (the 12 of 1.23.0 is this number). Read it at the start of an ask and keep it for that ask. It needs the `ai` permission like the other `ai` calls; a plugin without `ai` has no `limits`. `eveCyno.esi.saveFitting(EsiFittingSaveParams)` and `eveCyno.esi.deleteFitting({ characterId, fittingId })` write a character's in-game fittings, each only after the user confirms it in the host's own dialog; they answer `EsiFittingSaveResult` and `EsiFittingDeleteResult` (see ESI below).
1.25.0 adds one method and two types (a plugin that uses it needs `^1.25`): `eveCyno.dataapi.dataset({ name })` returns a `DatasetResult` for one published intel dataset of the EVE data API (`DatasetName`: `intel-gates-now`, `intel-systems-hour` or `intel-gates-profile`); see EVE data API below. It needs the data API origin in the granted `network`, like the other `dataapi` calls, and no built-in status.
1.26.0 changes two `ai` types and nothing else (a plugin that relies on either needs `^1.26`). `AiLimits.turnsPerAsk` is a `number`: the user's whole number from 1 to 30 (Settings > AI, 12 by default), no longer `6 | 12 | 16`. `AiEvent` has one more kind, `{ id, type: 'tool', name }`: a provider that runs the EVE data tools itself (Claude Code) ran one, once per call, in order with the text; it has no arguments, no result and nothing to answer (show it as a step). The host answers by the plugin's engines range, so a plugin typed against 1.24.0 or 1.25.0 is never handed what its types do not hold: when the range starts below 1.26.0, `limits()` answers the largest of 6, 12 and 16 that is not above the user's number (6 when the number is below 6), and the stream carries no `tool` event (such a call shows nothing). `api/1.25.0.d.ts` keeps `6 | 12 | 16`: the type is not widened in place.
1.27.0 adds one method, one type and one pack id (a plugin that uses them needs `^1.27`): `DataPackId` gains `market.hubs`, the hub price table of the EVE-Cyno data API, for the built-in assets plugin only; the host downloads it (it does not ship with the app), its version changes (the table's `builtAt`) and `getPack` returns the held copy or downloads a newer one first; `eveCyno.data.refreshPack({ id: 'market.hubs' })` asks for a newer table now and answers a `RefreshPackResult`: `{ ok: true, version }`, or a refusal that sends no request, `{ ok: false, reason: 'fresh', nextAt }` (no download is due: the held table's `nextBuildAt` is ahead, or a download at or after it brought no newer table less than one table period ago) and `{ ok: false, reason: 'retry_later', retryAt }` (a failure back-off runs), or `{ ok: false, reason: 'unavailable', retryAt }` (the download failed); `nextAt` and `retryAt` are epoch milliseconds. It also adds the optional `retryAt` to `DataPackInfo` and `HostError`, the retry time after a failed `market.hubs` download (see Data packs below). The broker's query keys for the blueprint routes, the structure market and `/markets/{region_id}/orders` (see ESI below) are guaranteed from 1.27.0 only: an older host may answer `bad_params` for them.
1.28.0 adds one field and nothing else (a plugin that reads `motion` needs `^1.28`): `ThemeInfo.motion`, `'full' | 'reduced' | 'off'`, the resolved motion level. It is the user's stored choice when there is one, else what the system asks for (`prefers-reduced-motion`: `reduced`, otherwise `full`), so it is always one of the three. `theme.get()` answers it and `theme.onChanged` runs once when it changes. `reduced` keeps meaning (a state change, a short fade) and drops movement; `off` shows end states at once. The host sends the field to every plugin; an older plugin type has no such key and ignores it.
1.29.0 adds three `windows` methods, three types and three optional fields (a plugin that uses any of them needs `^1.29`). `eveCyno.windows.setBounds({ items })` moves and resizes EVE windows (`client` and `login`): each item is a `WindowBoundsItem`, a window id from `list()` and its new outer rectangle in DIP, and the answer has one `WindowBoundsResult` per item, in order, read back from the system after the move (`ok` with the bounds the window has, or `ok: false` with `minimized`, `maximized`, `refused`, `gone` or `off_display`). It is the main page's and needs a user act of its own: a press in the plugin's main page or a press of one of its hotkeys, at most 1 s old (a thumbnail press or a press in an overlay page does not count); one act pays for one call. The host never moves a window on its own and never activates, raises or minimizes one in this call; on a 1.29.0 host, and still on a 1.30.0 host, only the built-in plugins may call it (`not_permitted` for any other). `eveCyno.windows.moveSupport()` answers a `WindowMoveSupport`: `{ supported: true }`, or `{ supported: false, why }` with `wayland` (a Linux Wayland session where this host does not move EVE's XWayland windows) or `platform`; `setBounds` is `unavailable` then. On a KWin Wayland session `WindowInfo.bounds` is the client rectangle (the compositor's decoration is not part of the outer rectangle cynod sees); `setBounds` takes the same convention. `WindowInfo.windowClass` names the entry of the user's extra window classes that an `other` window matched, and `eveCyno.windows.extraClasses()` lists those entries; both go only to a plugin that cannot send data out (the rule of `character`), never the window title. `HotkeyBinding.trigger` (`'press'`, the default, or `'release'`) asks for a binding that fires once when its key goes up again, and `HotkeyResult.trigger` says when an `ok` binding that asked fires on this host: on the desktop's shortcut portal a release binding fires on press. All three methods need window control like `focus` (`windowThumbnails`, `hotkeys` or `overlays`); no permission is new.
1.30.0 adds one manifest field and nothing else; the declarations do not change, so `api/1.30.0.d.ts` equals `api/1.29.0.d.ts` (the 1.9.0 rule). `"wasm": true` lets the plugin's pages and Workers compile and run WebAssembly: the host adds `'wasm-unsafe-eval'` to `script-src` in the Content-Security-Policy it sends with every file of that plugin (pages, overlay pages, pop-outs, Worker scripts and the `.wasm` files themselves) and of no other plugin; every other directive stays as it is. JavaScript `eval` stays blocked, and so do `new Function` and string timers (the token covers WebAssembly compilation only), and `blob:` and `data:` Workers stay refused. A dedicated Worker obeys the policy of its own script's response, so load its script from the archive like the page. Without the field, or on a version that drops it, a compile is refused with a `CompileError` (test for it by name; its message names `'unsafe-eval'`). `wasm` is no permission: nothing is granted or stored, and the policy follows the manifest of the version that runs. The key is new in 1.30.0 and an older host refuses it (`bad_manifest`), so a manifest that writes it, `true` or `false`, needs an engines range whose lowest version is at least 1.30.0 (`^1.30`); a lower range is `bad_manifest`. A plugin may compile only WebAssembly files inside its archive, never bytes it downloads or receives: once the token is there the host cannot tell fetched bytes from shipped ones, so the official index has a maintainer review every version that sets `wasm: true`, and each WebAssembly file must be built from public source named in the entry's `source`, with the build command in that source.
`api/1.2.0.d.ts`, `api/1.3.0.d.ts`, `api/1.4.0.d.ts`, `api/1.5.0.d.ts`, `api/1.6.0.d.ts`, `api/1.7.0.d.ts` and `api/1.8.0.d.ts`, `api/1.9.0.d.ts`, `api/1.10.0.d.ts`, `api/1.11.0.d.ts` and `api/1.12.0.d.ts`, `api/1.13.0.d.ts`, `api/1.14.0.d.ts`, `api/1.15.0.d.ts`, `api/1.16.0.d.ts`, `api/1.17.0.d.ts`, `api/1.18.0.d.ts`, `api/1.19.0.d.ts`, `api/1.20.0.d.ts`, `api/1.21.0.d.ts`, `api/1.22.0.d.ts`, `api/1.23.0.d.ts`, `api/1.24.0.d.ts`, `api/1.25.0.d.ts`, `api/1.26.0.d.ts`, `api/1.27.0.d.ts`, `api/1.28.0.d.ts` and `api/1.29.0.d.ts` stay as they were (the check pins their hashes; the "at most 12 turns" of 1.23.0 is superseded in 1.24.0 by `AiLimits.turnsPerAsk`, and its `6 | 12 | 16` in 1.26.0 by a number, the snapshots are not edited), and a plugin that asks for `^1.0` loads on a 1.30.0 host.
A plugin's `engines.eve-cyno-api` range must include the host's API version (`semver.satisfies`). A range narrower than `^1.0` that
leaves 1.30.0 out, such as `~1.0.0`, `1.0.x` or `1.0.0`, is refused by a 1.30.0 host with `incompatible_api` (the plugin is not
registered). Ask for `^1.0` (or `^1.1` when you use `files`, `^1.2` when you use `gamelog`, `^1.3` when you use `data`, `^1.4` when you use `ai` or `dataapi`, `^1.5` when you use `chat`, `^1.6` when you use `esi.setWaypoint`, `^1.7` when you use `characters.portrait`, `^1.8` when you use `esi.setWaypoints`, `^1.9` when you set `suspendUnderPressure`, `^1.10` when you use `esi.get` `query` or its cache fields, or `esi.lookup`, `^1.12` when you use `db`, `^1.13` when you use the stream save, `^1.14` when you use `fit` (`^1.15` for the hash fields `line`, `hash`, `hashVersion` and `designKey`; `^1.16` for skill levels, the solver and the jobs), `^1.17` when you list `permissions.optional` or use `characters.open`, `^1.18` when you send `base` in `fit` skills, `^1.20` when you call `fit.implantSets`, send `implantSlot` or `subsystemSlot` to `searchItems` or read `implantSlot`, `^1.21` when you call `fit.implantBonuses`, `^1.22` when you use `window.onClosed`, `^1.23` when you send or read `gesture` in `services.call`, a `services.handle` context or `ai.chat`, `^1.24` when you call `ai.limits`, `esi.saveFitting` or `esi.deleteFitting`, `^1.25` when you call `dataapi.dataset`, `^1.26` when you read `turnsPerAsk` as any whole number from 1 to 30 or handle the `ai` event `tool`, `^1.27` when you call `data.refreshPack`, ask for the pack `market.hubs`, read `retryAt`, or send the `esi.get` query keys `page` on the blueprint routes or on `/markets/structures/{structure_id}`, or `type_id` and `page` on `/markets/{region_id}/orders`, `^1.28` when you read `ThemeInfo.motion`, `^1.29` when you call `windows.setBounds`, `windows.moveSupport` or `windows.extraClasses`, read `WindowInfo.windowClass`, or send or read a hotkey `trigger`, `^1.30` when you set `wasm`).

## Marketplace archives and updates (DP1-B5b)

A plugin published to the marketplace is a `.zip` with `plugin.json` at its root (zip the folder's content, not the folder; stored or
deflate entries only, no encryption or zip64, at most 2000 entries and 64 MiB unpacked, plain names). The listing's `id`, `version`,
`name`, `author`, `engines` and `permissions` must equal the archive's `plugin.json`, or the install is refused. A plugin's `name` may not
be, or read like, "EVE-Cyno", "Settings", "Characters", "Marketplace" or "Home", and neither name nor author may contain "evecyno" after
look-alike letters are folded (an author may only for bundled and first-party plugins). An update that adds a permission, adds
`background: true`, changes the author or name, or replaces a copy the user installed by hand is not applied by itself: the user reviews it
(and can keep the old version). The host revokes by plugin id; a revoked version cannot be enabled.

## Manifest limits (API v1)

The host refuses a `plugin.json` that breaks these, before it creates anything from it:

- `plugin.json` is at most 256 KiB.
- `plugin.json` is a regular file: not a symlink, FIFO or other special file. On Windows the host checks that the
  file it opened is the one it looked up, by file id, so the plugin folder must be on a volume with file ids (NTFS or
  ReFS). On a volume that reports file id 0 (FAT/exFAT, some SMB shares) every manifest is refused.
- Schemas a plugin contributes (`contributes.settings`, service `params` and `result`) use JSON Schema 2020-12 with
  a keyword allowlist, checked at every schema position:
  - allowed: `type`, `enum`, `const`, `properties`, `required`, `additionalProperties`, `items`, `prefixItems`,
    `minItems`, `maxItems`, `uniqueItems`, `contains`, `minContains`, `maxContains`, `minLength`, `maxLength`, `minimum`,
    `maximum`, `exclusiveMinimum`, `exclusiveMaximum`, `multipleOf`, `minProperties`, `maxProperties`, `propertyNames`,
    `dependentRequired`, `dependentSchemas`, `anyOf`, `oneOf`, `allOf`, `not`, `if`, `then`, `else`,
    `unevaluatedProperties`, `unevaluatedItems`, `$defs`, `$ref`, `$schema` (the 2020-12 URI only), `$comment`, `title`,
    `description`, `default`, `examples`, `deprecated`, `readOnly`, `writeOnly`, plus the four display annotations `x-unit`,
    `x-enumLabels`, `x-multiline` and `x-preview` (see the settings form below);
  - everything else is refused, notably `pattern`, `patternProperties`, `format`, `$id`, `$anchor`, `$dynamicRef`
    and `dependencies` (plugin regexes would run in the host process);
  - `$ref` is only `#/$defs/<name>` and only from outside `$defs` (a `$defs` entry may not contain any `$ref`, so definitions
    cannot loop or fan out), the entry must exist, and `$defs` names match `[A-Za-z0-9_-]{1,64}`;
    `default`, `examples`, `const` and `enum` are data and cannot be referenced;
  - each schema: at most 64 KiB, 16 levels of nesting, 128 nodes and 64 `$ref`. A node is every schema object and
    every `true`/`false` in a schema position, `$defs` included; each `dependentRequired` entry and each name in it
    count as one node too;
  - `enum` has at most 256 items and `const` is at most 4096 bytes as JSON;
  - all schemas of one plugin together: at most 128 KiB, 2000 nodes, 200 `$defs` entries, and an expanded weight of
    262144 bytes: each schema's JSON size plus, for every `$ref`, the JSON size of the definition it points at
    (annotations such as `description` count, so put long texts outside a referenced definition).
- `contributes.settings` is flat. Its root is `{ "type": "object", "properties": { ... } }`, optionally with `title`, `description`,
  `$defs`, `$schema` and `$comment`; any other keyword at the root (`required`, `dependentRequired`, `dependentSchemas`,
  `if`/`then`/`else`, `allOf`/`anyOf`/`oneOf`/`not`, `minProperties`/`maxProperties`, `propertyNames`,
  `unevaluatedProperties`, `additionalProperties`, ...) is refused. Only the declared properties can be set; each value is checked
  against its own property schema (which may use the full allowlist above), and a `default` must satisfy it.
- (1.0.0-beta.6) The host draws `contributes.settings` as a form (Settings > Plugins > the plugin). It can draw this subset and nothing else; a schema
  outside it shows a "can't be drawn" panel with a way to report it, and its values stay readable by the plugin:
  - at most 32 properties, each with `type` `string`, `number`, `integer` or `boolean`, and only `title`, `description`, `default`,
    `enum` (up to 16 strings), `minimum`, `maximum`, `minLength`, `maxLength` and the two annotations below (a nested
    `object`, an `array`, `$ref`, `oneOf` and the like are not drawn; a property named `__proto__`, `constructor` or `prototype` is not drawn);
  - the field label is `title` (else the key) and the help line is `description`; a `default` is shown as "Default: ...";
  - an `enum` of up to 4 values is drawn as radio buttons, a longer one as a list; a boolean as a switch; a number or integer as a
    number field with its range ("1 to 10", "at least 1", "at most 10");
  - `x-unit` (a string of at most 12 characters) is the unit written after a number, such as `jumps`;
  - `x-enumLabels` (an array of display texts, the same length as `enum`) are the texts shown for the enum values, in order;
  - `x-multiline: true` (on a plain `string` property only) draws a monospace box of 10 rows instead of one line; such a text may be up to 65536 characters (set `maxLength` to say so);
  - `x-preview: true` (on a property with an `enum` only) draws the enum as a list with a Play button beside it, whatever its length. Play sends the form as it stands to `settings.onPreview`, in the main page, and saves nothing (1.6.0, `^1.6`);
  - an emptied number, switch or choice is "Required.", and so is an emptied text whose `minLength` is 1 or more;
  - an emptied optional text (no `minLength` of 1 or more) is saved as unset: the stored value is removed and the plugin reads its `default`;
  - every value is checked against the schema in the host when it is saved; a wrong value is refused with a message and nothing is
    written, and a key that is not declared is refused. Text values are at most 4096 characters, an `x-multiline` text at most 65536.
- Texts shown by the host (names, command and status-item titles) are 1 to 60 characters of plain text: no control, bidi or
  zero-width characters; emoji sequences are fine, a run of more than two combining marks is not.
- `version` is a SemVer 2.0 version without a leading `v` (build metadata such as `1.0.0+x` is fine).
- `main` is a relative path of `[A-Za-z0-9._-]` segments separated by `/`, with no `.` or `..` segment, query or fragment.
- `network` entries are `https://` origins with a plain DNS host name (no wildcard, IP address or `localhost`).
  Your page reaches them through a proxy the host runs in a process of its own (a plugin with no `network` entry gets one that
  refuses everything). If that process ends, every running plugin is stopped and shown as crashed, since its network is gone; it
  starts again on its next use or when the user restarts it.
  An `<img>` whose `src` is on a granted origin loads too (the host's content security policy lists the granted origins in `img-src` as well as `connect-src`); every other origin is refused.
- `permissions.storage.quotaMB` is an integer from 1 to 20 (default 5; more than 5 asks for consent). Host storage is for
  small, config-like data: a value is at most 1 MiB, and bulk data belongs in IndexedDB in the plugin's own page. See
  `StorageNamespace` for the key rules, the JSON-only values, `null` for a missing key, the 250 ms write coalescing and
  `unavailable` for a locked file or a failing disk.

- `permissions.esi` and `permissions.logs` need `permissions.characters` to be `selected` or `all`: with `none` (the default) the
  manifest is refused. The exception is `chatlogs` alone (1.5.0), which does not depend on characters. `permissions.logs` kinds are `gamelogs`,
  streamed by `logs` and `gameEvents`, and `chatlogs`, delivered by `chat`.
- The params of one call are at most 2 MiB when serialised; a larger call fails with `too_large` before it leaves the page.

- `permissions.esi` may list only ESI scopes registered for the app (`registered` in the host's `esi-scopes.json`: the read scopes plus
  a few write scopes). Any other scope is refused at install with `bad_manifest` "unknown or unregistered ESI scope", because one bad
  scope would make every sign-in round fail for every plugin.
- A plugin `id` that starts with `eve-cyno.host.` is reserved for the host's own services (for example its character presence reads) and is refused with `bad_manifest`.

## Optional permissions (1.17.0)

A plugin can mark some permission items as optional. The user may switch each optional item off in the permission prompt or in Settings > Privacy, and the plugin keeps running without it. A refused required item still turns the plugin off, as before.

**Manifest.** `permissions.optional` lists the items in the shapes of the required part: `esi` (registered scopes), `network` (https origins), `clipboard: ["read"]` and `notifications: true`. No other kind is optional. The manifest must ask for `^1.17` (or a range whose lowest version is at least 1.17.0), else `bad_manifest`. An item may not be in both the required and the optional part (`bad_manifest`), optional `esi` needs `permissions.characters` to be `selected` or `all`, and a shared host is refused in `optional.network` as it is in `network` (`shared_host`). Example (the Fit manager's manifest):

```json
{
  "engines": { "eve-cyno-api": "^1.17" },
  "permissions": {
    "characters": "all",
    "esi": ["esi-fittings.read_fittings.v1"],
    "network": ["https://data.eve-cyno.dev"],
    "optional": { "esi": ["esi-skills.read_skills.v1", "esi-clones.read_implants.v1"], "network": ["https://images.evetech.net"] }
  }
}
```

**What the user sees.** Each optional item has a switch (on by default) and an `Optional` tag in the install or update prompt; Allow takes the items left on. Settings > Privacy shows each optional item as its own row with its own switch. Revoke Hosts removes the required hosts only; optional hosts keep their own switches. An item the user switched off is not asked for again by an update; only `request` asks again.

**`eveCyno.permissions`** exists only when the manifest has `permissions.optional` (`host.capabilities().features.permissions`).

- `get()` resolves `{ granted, declined }`, both `OptionalSet`s: the optional items granted now, and every other optional item of the manifest as declined.
- `request(items)` asks the user for optional items, written as `get()` gives them. Main page only, one user gesture per call (else `not_permitted`). An item the manifest does not list, an empty set or `notifications: false` is `bad_params`. While a question of the plugin is open, a second call is `rate_limited`. It resolves `'granted'` with no question when every item is granted already, and `'declined'` when the user says Not now or switches every item off. A call refused before the host decides (`bad_params`, `not_permitted`, `rate_limited`) keeps the gesture; a call that reaches the decision spends it. The host sets no cooldown, so ask only on a user action that needs the item.
- **A grant change restarts the page.** When the user allows items (in the prompt, through `request` or in Privacy) or switches a granted item off, the host restarts the plugin page, so there is no change event. After an Allow through `request` the promise does not settle: read `get()` after the restart. Keep nothing in the page that a restart cannot rebuild.
- A declined item fails as any ungranted one does: an absent namespace, `not_permitted`, or an origin outside the page's CSP. Read `get()` before you use an item.

**ESI scopes asked per character.** The host keeps a list of ESI scopes that it asks per character. Today it holds the six corporation-role scopes: roles (`esi-characters.read_corporation_roles.v1`), corporation assets (`esi-assets.read_corporation_assets.v1`), divisions (`esi-corporations.read_divisions.v1`), corporation orders (`esi-markets.read_corporation_orders.v1`), corporation jobs (`esi-industry.read_corporation_jobs.v1`) and corporation wallets (`esi-wallet.read_corporation_wallets.v1`). The list is the host's, not the manifest's: no manifest key marks a scope, and a plugin cannot opt in or out. Such a scope is always asked per character, whether the manifest lists it in `permissions.optional.esi` or in `permissions.esi`: once granted, it is asked of a character only after the user turns it on for that character in Settings > Characters, or completes a `characters.open` re-authorisation that the plugin asked for. Until then `esi.get` for that character answers `not_permitted` ("character <id> has not granted <scope>; re-authorise it"), with no ESI request. The Allow prompt says so: Allow starts no sign-in. It is never asked of every covered character, and the first sign-in does not ask it. A character whose sign-in bundle holds the scope (All read-only scopes or Everything) has it already. Every other ESI scope is asked as before: a required one of every covered character, an optional one of every covered character once allowed. `permissions.get()` answers the plugin-level half only; whether one character holds the scope shows in its `esi.get` answers.

**`eveCyno.characters.open(params?)`** (`^1.17`) shows the host's main window: the Characters page focused on `characterId`, or with `reauth: true` the re-authorisation dialog of that character (to add ESI scopes the plugin was granted later). The re-authorisation also adds the plugin's granted per-character scopes (above, optional or required) that the character lacks. Main page only, one user gesture per call (else `not_permitted`). `characterId` must be one that `characters.list()` returns (else `not_found`); `reauth: true` without `characterId` is `bad_params`. The dialog says which plugin asked ("Asked by <plugin name>."). It resolves `true` once the host has taken the request and says nothing about what the user does next.

## Appearance and tile (1.0.0-beta.4, breaking)

Manifest fields for the plugin's tile and view:

- `color`: `#rrggbb`. The host picks the nearest colour of its palette; without `color` it picks one from the plugin id.
- `icon` (1.0.0-beta.6): a lower-case word of 1 to 24 letters (`^[a-z]{1,24}$`; anything else is `bad_manifest`). The host draws one of `radar`, `flag`, `vortex`, `grid`, `truck`, `spark`, `cpu`, `rocket`, `wrench`, `chart`, `coin`, `map`, `crosshair`, `book`, `clock`, `box`, `satellite`, `asteroid`, `planet`, `factory`, `compass` and `plugin` (the generic icon). An unknown name, or none, shows the generic `plugin` icon. `layers`, the default before 1.0.0-beta.6, is no longer in the list and now draws the generic icon too.
- `description`: what the plugin does, 1 to 200 characters of plain text.
- `contributes.tile.action`: `{ "command": "<id>", "label": "<text>" }`, the quick action on the tile. `command` must be in
  `contributes.commands`; `label` is 1 to 20 characters. Otherwise `bad_manifest`.

`eveCyno.tile.setSummary({ title?, lines?, severity?, badge? })` replaces the tile summary (the old `{ text, severity: 'info' | 'warn' | 'alert' }` shape is gone):

- `title` at most 40 characters, `lines` at most 3 of at most 60 characters each, `badge` at most 8. A longer text is cut and ends with
  "…" (counted in code points). More than 3 lines, a control or invisible character, or a severity that is not
  `normal`, `attention` or `alert` (the default is `normal`; `info` and `warn` no longer exist) is `bad_params`.
- The host shows at most one update per plugin every 2 seconds. Later calls inside the window are coalesced and the newest one is
  shown when the window ends. The last summary is kept across restarts, with the time the host applied it.
- `eveCyno.tile.setContext({ text })` is now at most 30 characters. It shows in the plugin's header and is coalesced like the summary:
  at most one update every 2 seconds, the newest wins.
- The quick action runs `command` as if the user had picked it in the palette; the tile shows it as a button next to the age.
- A plugin has one view: its `main` page. `contributes.views`, `contributes.windows` and `contributes.themes` stay reserved (a plugin cannot contribute a theme; users add theme packages in the host); the host shows that view in
  the main window, in its own window (pop-out) or parked while hidden, never twice.

## Files (1.1.0)

`eveCyno.files` exists for a plugin granted `permissions.files: true`. It saves a text the plugin made to a file the user picks, or reads
a text file the user picks, through an OS dialog the host draws.

```js
const saved = await eveCyno.files.saveText({ suggestedName: 'layout.json', text: JSON.stringify(doc), extensions: ['json'] });
const text = await eveCyno.files.openText({ extensions: ['json', 'txt'] }); // null when the user cancels
```

- Text only, at most 1 MiB as UTF-8 each way: a longer `text` is `too_large`, and so is a picked file over 1 MiB. The host measures the
  UTF-8 bytes of the text itself (`new TextEncoder().encode(text).length`), not its length in characters. A picked file that is not UTF-8
  text, or not a regular file, is `unavailable`.
- The 2 MiB limit on the params of one call (see "Manifest limits") is checked first, in the page: a text far over 1 MiB may fail there
  with `too_large` "params larger than 2 MiB" instead. A text of at most 1 MiB always passes that check.
- `text` must be valid Unicode: a lone surrogate (half of a pair) is `bad_params`. The file gets the text as UTF-8 with no BOM and the line
  endings you wrote. `openText` drops one leading BOM and gives the line endings as they are in the file (a file saved on Windows may
  have CRLF).
- The plugin never learns a path or a file name: `saveText` resolves `true` (saved) or `false` (the user cancelled), `openText` the
  file's text or `null` (the user cancelled). A save replaces the file atomically.
- Main page only: a call from an overlay page is `not_permitted`.
- Each call needs a user gesture in the plugin's main page: a mouse press or a non-repeating key press at most 1 second (1000 ms) before
  it. One gesture opens one dialog. A thumbnail click or a hotkey press does not count. Without a gesture the call is `not_permitted`
  ("no user gesture").
- One dialog per plugin at a time; a second call while one is up is `rate_limited`. The host hides the plugin's overlays while the
  dialog is up.
- `extensions` (save and open): 1 to 4 of the data extensions `json`, `txt`, `csv`, `md`, `xml`, `yaml`, `yml`, `log` (lower case),
  default `["txt"]`. Nothing a system could run or render as active content (`cmd`, `bat`, `ps1`, `js`, `html`, `desktop`, ...).
- `suggestedName` (save only): 1 to 64 characters of display text, counted in code points (an emoji or another character outside the
  BMP is one), with no control, bidi or zero-width character, none of `/ \ : * ? " < > |`, not starting with a dot, not ending with a
  dot or a space, and not a Windows device name (`CON`, `PRN`, `AUX`, `NUL`, `COM0`-`COM9`, `LPT0`-`LPT9`, alone or with an
  extension, in any case). Its own extension, the part after the last dot, must be one of the data extensions (any case:
  `layout.JSON` is fine, `layout.json.cmd` is not). A name without a dot gets the first of `extensions`: `layout` with `['yaml']` is
  proposed as `layout.yaml`. It is only the name the dialog proposes: the user may change it, and the host never tells you the name that
  was used. Anything else is `bad_params`.
- Reading or writing the picked file may take at most 30 seconds (a hung network drive); then the call is `unavailable` (a write that
  finishes later may still replace the file). The dialog itself has no time limit.

### Stream save (1.13.0)

For a file larger than `saveText` takes (up to 512 MiB). It needs the same `permissions.files: true` and `^1.13` in `engines.eve-cyno-api`.

```js
if (await eveCyno.files.beginSave({ suggestedName: 'export.csv', extensions: ['csv'] })) { // one dialog; false when the user cancels
  try {
    for (const chunk of chunks) await eveCyno.files.writeChunk({ data: chunk }); // await each call; chunk: Uint8Array, at most 1 MiB
    await eveCyno.files.endSave();
  } catch (e) { await eveCyno.files.abortSave(); throw e; }
}
```

- `beginSave` follows every `saveText` rule: main page only, a user gesture in the main page (one gesture, one dialog), the same `suggestedName` and `extensions`.
  It resolves `true` when the stream is open and `false` when the user cancels.
- One open stream per plugin: a second `beginSave` is `rate_limited` and shows no dialog.
- `writeChunk({ data })`: a `Uint8Array` of at most 1 MiB (a longer one is `too_large`; the stream stays open), at most 512 MiB in all (the chunk that
  would pass it is `too_large` and the stream is closed). It resolves when the bytes are written, so `await` it: a call while the previous one is
  unfinished is `rate_limited` and changes nothing. That is the backpressure that keeps memory flat. The 2 MiB limit on the params of one call counts the
  whole buffer behind a typed array: pass `bytes.slice(a, b)` (a copy of 1 MiB), not a `subarray` of a larger buffer.
- Nothing is at the picked path until `endSave` succeeds. The host writes to a temp file next to it and renames it over the target on success. A
  cancel, `abortSave`, a write error, going over the total cap, a write that takes more than 30 seconds, the plugin stopping, reloading or crashing:
  the temp file is removed and the target is as it was. A failure is `unavailable` and closes the stream; with no stream open, `writeChunk` and
  `endSave` are `unavailable` and `abortSave` resolves.
- The plugin is not suspended for idleness while a stream is open.

## Game events (1.2.0)

`eveCyno.gamelog` exists for a plugin granted `permissions.gameEvents` (a list of the families it may read). Without the grant the
property is absent (`capabilities().features.gamelog` is `false`). It needs no `characters` permission, and it is input: it does not count as
data-out. The host reads the game's Gamelogs once and delivers typed events; raw log text never reaches a plugin.

```js
await eveCyno.gamelog.subscribe({ families: ['mining', 'notice'], replay: 'session' });
eveCyno.gamelog.onEvents(({ events, dropped, replayEnd }) => { /* events[i].kind, .amount, .ore, .replay ... */ });
const chars = await eveCyno.gamelog.characters(); // [{ key, lastLineAt, parsedShare, eventLines }]
```

- Families: `combat`, `ewar`, `mining`, `notice`. `notice` carries typed markers only (`Jump`, `Dock`, `Undock`) with the log time: no system
  or station names, no generic notify text. Unknown lines are never forwarded.
- English client logs only. Another language parses to nothing; `characters()` shows it as a low `parsedShare` (the share of the last 200
  event lines the parser recognised, 1 with none; `eventLines` says how many lines it rests on).
- `lastLineAt` is the time (ms since epoch) of the last timestamped line read. It is `0` while the log has a header and no timestamped line
  yet: treat `<= 0` as "no line yet", not as 1970 or a stale log.
- Batching, per page: a batch every 250 ms, at most 4 batches per second, at most 500 events per batch. When more arrive in a window the
  newest 500 are kept and `dropped` counts the rest.
- `key` is stable for your plugin and one character (an HMAC of the Listener name) and equals the key `WindowInfo` uses. `characterId` is
  there only for a vault character your grant allows.
- Other parties' names: a plugin with no data-out (no `network`, services, `ai` or `account`) gets `entity` as written. Every other plugin
  gets no `entity`; `entityIsPlayer` stays, and `entityRef` is a number from a per-page counter (one per distinct entity since the page
  subscribed; it resets on reload and cannot be linked across sessions).
- Replay: `replay: 'session'` first sends the current session's history to the one page that asked, as its own paced (4 batches per second),
  lossless batches (no 500-event drop). Each replayed event has `replay: true`; the last batch has `replayEnd: true` (replay is over; at most the last 32 MiB of each session file is replayed). Live events follow.
  `replay: 'none'` (the default) starts from live.
- Subscribing holds the plugin awake. Revoking the grant ends delivery.

## Data packs (1.3.0)

`eveCyno.data` is reserved for built-in plugins and the first-party exempt install. The host allowlists the plugin id and the packs it may read (`dev.evecyno.map` and `dev.evecyno.intel`: `sde.universe`; `dev.evecyno.assets`: `sde.universe`, `sde.types` and `market.hubs`);
`permissions.data` in any other plugin's manifest is refused with `bad_manifest`, and the property is absent
(`capabilities().features.data` is `false`). Other plugins reach the map's geometry through the `evecyno.map` service. The `data` permission itself shows no consent line (public, read-only data), but a plugin that consumes a service is asked for it like any other plugin, a bundled one too: only `background` is pre-granted for bundled plugins (`host/src/grants.ts`, `basisOf`).

```js
const info = await eveCyno.data.packVersion({ id: 'sde.universe' });  // { id, version, sha256, size }
const pack = await eveCyno.data.getPack({ id: 'sde.universe' });      // { id, version, sha256, size, bytes: Uint8Array }
eveCyno.data.onPackChanged(({ id, version }) => { /* never fires in 1.3.0 */ });
```

- The pack ids are `sde.universe`, `sde.types` (1.11.0) and `market.hubs` (1.27.0). The first two ship with the app and work offline from the first start; `market.hubs` is downloaded by the host.
- `bytes` is an intact `Uint8Array`; its length is `size` and its SHA-256 is `sha256`. A pack that fails its size or SHA-256 check is
  `unavailable`.
- `packVersion` and `onPackChanged` exist for a later update check: the version of the two shipped packs never changes and the event never fires.
- `market.hubs` (1.27.0, `^1.27`, built-in assets plugin only): the version is the table's `builtAt`. `getPack` returns the held copy, or downloads a newer one first when the host's floor has opened: at the table's `nextBuildAt`, or one table period (`nextBuildAt` - `builtAt`, at least 5 minutes; the host refuses a table with a shorter one) after the last download when that is earlier or the copy is already past its `nextBuildAt`; before the first copy it waits for that download up to 30 seconds, then rejects `unavailable`. After a download at or after `nextBuildAt` that brought no table ahead of its own (a 304, the same table, or a newer table already past its `nextBuildAt`), the floor opens earlier: after the overrun so far by the answer's `Date` header, the server's clock (`Date` - `nextBuildAt`, at least 1 second, at most 900 seconds, and less than one table period; a `Date` that is missing, not an HTTP date, or more than one table period before or after `nextBuildAt` gives no earlier time), and `getPack`'s answer carries that time as `retryAt`. A later such answer of the same table names a new time only while its wait is at least the time since the table's first such time, measured at the request's start, and before its first such download plus one table period, so the waits at least double. The first answer of a table whose `Date` is before `nextBuildAt` (a client clock ahead of the server's) opens the floor earlier too: after the time left by the `Date` (`nextBuildAt` - `Date`, with the same bounds), also carried as `retryAt`; later such answers of that table do not. The host reads no `Retry-After` on a 200 or a 304. `onPackChanged` stays unfired for it: call `getPack` again when that floor opens and read the new `version`. The plugin never sees the URL.
- `eveCyno.data.refreshPack({ id: 'market.hubs' })` (1.27.0, `^1.27`) is the Refresh button: it asks for a newer table now and never bypasses the table's own period. It answers `{ ok: false, reason: 'fresh', nextAt }` while no download is due: the held copy's `nextBuildAt` is ahead, or a download at or after it brought no newer table less than one table period (`nextBuildAt` - `builtAt`) ago (`nextAt`, epoch milliseconds, is the time the next download is due: that `nextBuildAt` when the last download came before it, else the earlier time after that download's overrun (the `retryAt` of `getPack`'s answer), else the last download plus one table period, and never later than the last download plus one table period), and `{ ok: false, reason: 'retry_later', retryAt }` while a failure back-off runs (`retryAt`: the earliest time the host downloads again, the server's `Retry-After` when it sent one, else the table's own period, else, with no copy held, 15 minutes, the period of the hub build); neither sends a request. Otherwise the host downloads at once (joining a download already running) and answers `{ ok: true, version }` or `{ ok: false, reason: 'unavailable', retryAt }`. A refusal is an answer, not a rejection; any other pack id is `bad_params`.
- The retry time of `market.hubs` (1.27.0, `^1.27`), for a line such as "The last update failed; trying again at <time>." and for the time to ask again: after a failed download, `retryAt` (epoch milliseconds, the same time as `retry_later`) is on the held copy's `DataPackInfo`, so on the answers of `getPack` and `packVersion`, until a download succeeds; while no copy is held it is on the `unavailable` rejection of both methods (`HostError.retryAt`). `getPack`'s answer (not `packVersion`'s) also carries the host's earlier time past `nextBuildAt` (from the due answer's `Date`, above), so a failure line read through `packVersion` never shows it; a plugin that schedules its next `getPack` at the larger of `nextBuildAt` and `retryAt` follows both. A rejection without it means no download has failed yet (the first may still run: `getPack` again joins it). `retryAt` may lie in the past: the host keeps no timer, so it downloads at the next `getPack`. `packVersion` never downloads and is the read for the time; `getPack` may download; `refreshPack` is only the Refresh button, never the read, since it downloads at once whenever neither of its refusals applies.

## AI (1.4.0)

`eveCyno.ai` exists for a plugin granted `permissions.ai: true` (`capabilities().features.ai`). The host calls the AI provider the user set
up in Settings > AI, with the user's key: the plugin never sees a key, a provider's base URL or the account session, and the call does not
go through the plugin's `network` grant.

```js
const providers = await eveCyno.ai.providers(); // [{ id, name, isDefault, models: [{ id, tools, maxContext }], defaultModel }]
const { turnsPerAsk } = await eveCyno.ai.limits(); // 1.24.0; 1.26.0: 1 to 30 model replies for one ask (Settings > AI, 12 by default)
eveCyno.ai.onEvent(e => { /* e.id; e.type is text, tool_call, tool (1.26.0), usage, error or end */ });
await eveCyno.ai.chat({ id: 'c1', system: 'Answer in English.', messages: [{ role: 'user', content: 'Hi' }], maxTokens: 1024 });
await eveCyno.ai.abort({ id: 'c1' }); // false when no stream with that id is open
```

- `chat` resolves `true` at once and the answer arrives through `onEvent`, each event with the request's `id`: `text` (`delta`; join them
  in order), `tool_call` (`callId`, `name`, `arguments`), `tool` (1.26.0, `name`: a tool the provider ran itself, see Claude Code below), `usage` (`inputTokens`, `outputTokens`), `error` (`code`, `message`) and, last,
  one `end` with its `reason`: `stop`, `tool_use`, `max_tokens`, `aborted` or `error`.
- `limits()` (1.24.0) answers `turnsPerAsk`, the user's whole number from 1 to 30 (1.26.0; Settings > AI, 12 by default). A plugin whose engines range starts
  below 1.26.0 (typed against `6 | 12 | 16`) is answered the largest of 6, 12 and 16 that is not above that number, and 6 when it is below 6; ask for `^1.26` to read the number itself.
- A tool call's `arguments` is `null` when the model's JSON was not valid. Answer each call with `{ role: 'tool', callId, name, content }`
  in your next request, after the `assistant` message that carries its `toolCalls`. The system prompt is `system`; there is no `system` role.
- Limits, `bad_params` otherwise: `id` is 1 to 64 of `A-Za-z0-9_-` and unique among your open requests (a reused one is `bad_params`); 1 to 200 messages, 512 KiB of
  text in all, 64 tools; `maxTokens` 1 to 8192 (default 4096).
- At most 2 open streams per plugin: a third `chat` is `rate_limited`. Every other failure, the checks before the request opens
  included, is an `error` event followed by `end` (`error`). The codes are `no_provider` (no provider allowed for this plugin, or its key
  is missing), `cap_reached`, `provider_unreachable`, `provider_rejected` and `model_unsupported`; `message` is one plain sentence from the
  host, never the provider's own text.
- `provider` is an id from `providers()` (default: the one with `isDefault`), `model` one of its `models` (default: its `defaultModel`).
  A model with `tools: false` is sent no tools.
  The Claude Code provider (`claude-cli`, the user's own install, off by default) has models with `tools: true` because Claude Code runs the EVE data tools itself through MCP: the host drops the `tools` a plugin sends to it and the plugin never receives a `tool_call` event from it. Each call of an EVE tool arrives as a `tool` event with the tool's name (1.26.0; a plugin whose range starts below 1.26.0 gets no event for it), and the sources come as one `Sources:` text line after the reply. A plugin sees it in `providers()` only when the user chose it by name for that plugin: policies `default` and `all` never include it (`no_provider`). A `chat` on it spends one gesture credit of your plugin (at most 4 held, each valid 1 s, one per call); credits come from real clicks and key presses in your page, your global hotkeys and presses on your thumbnails. Without one the call ends with `provider_rejected`, unless it carries a host gesture grant in `gesture` (from 1.23.0, see Gesture grants): such a turn runs Claude Code with no tools.
- The user sets a monthly token cap per plugin, counted across all providers (local ones too) and checked before a request opens; the
  user gets a notification at 80 %.
- A reload, crash or stop of the page aborts its open streams. Events go to the page that called `chat` only.
- `ai` counts as data-out: a plugin with it gets no character names (`WindowInfo.character`, `GameEvent.entity`).

## EVE data API (1.4.0)

`eveCyno.dataapi` exists for a plugin whose granted `permissions.network` holds `https://data.eve-cyno.dev`
(`capabilities().features.dataapi`). The host makes each call and adds the user's free data key (Settings > AI) to `tools` and `call` when one is set; the
plugin never sees the key. Without a key, calls work within the keyless trial limits. `dataset` (1.25.0) never sends the key.

```js
const tools = await eveCyno.dataapi.tools(); // [{ name, description, inputSchema }], at most 64 tools
const r = await eveCyno.dataapi.call({ tool: tools[0].name, arguments: {} });
if (r.ok) show(r.text, r.attribution); else showReason(r.reason, r.message, r.retryAfterSec);
const { keyed } = await eveCyno.dataapi.status(); // true when the user set a data key
```

`tools()` returns at most 64 tools: a longer list from the server is cut to its first 64 valid tools (the host logs that it did), which is also what `ai.chat` accepts.

- `tool` is 1 to 64 of `a-z0-9_`, `arguments` at most 64 KiB as JSON; anything else is `bad_params`.
- 60 calls a minute and 4 at a time per plugin; more is `rate_limited`, and nothing is sent.
- A call that passes those checks resolves a result, also when it gives no data: `ok: false` with a `reason` and a plain `message`.
  `quota` (the keyless trial or the key's quota is used up, with `retryAfterSec` when the server says) is a normal state to show, not an
  error. The other reasons are `key_required`, `key_rejected`, `not_found` (no such tool), `bad_arguments` and `unavailable` (network, a
  server error, a timeout of 30 s, a result over 1 MiB, or a data key the host cannot read).
- `ok: true` gives `text` (the answer in words, for a model), `data` (the structured result) and `attribution` (`name`, `url` and
  `license` of each source): show the attribution with the result.
- The host caches the list of `tools()`. A fetch counts as one of the 60 calls a minute (a cached list does not); `tools()` rejects with
  `unavailable` when the list cannot be fetched, or with `rate_limited` when a fetch would pass the 60 a minute.

### Datasets (1.25.0)

```js
const r = await eveCyno.dataapi.dataset({ name: 'intel-gates-now' });
if (r.ok) use(r.data, r.fetchedAt, r.stale); else say(r.message); // r.reason: 'not_published' | 'unavailable'
```

`dataset` gives one published dataset file as `data` (a parsed JSON object, `unknown` to the types). The host downloads it without a data key, a plugin id or arguments (the params hold `name` alone; any other key is refused with `bad_params`), keeps it in memory and on disk (one copy for every plugin, also after a restart), and asks the server again only after the dataset's fixed refresh floor, counted from the last try whatever its outcome: 60 s for `intel-gates-now`, 300 s for `intel-systems-hour`, 3600 s for `intel-gates-profile`. Plugins that ask at once share one request. `fetchedAt` is the epoch ms of the last download or 304; `stale: true` means the last refresh failed (the server could not be reached or answered an error other than 404) and this is the kept copy. 60 calls a minute per plugin (cached answers count), then `rate_limited`; an unknown `name` is `bad_params`. `not_published`: the server answered 404, it has no such file yet. `unavailable`: there is no kept copy and the server could not be reached or answered an error, or the server sent a file that is not this dataset (its `format` is not the name or its `version` is not an integer; the host never serves it, and the kept copy stays for the next refresh). Read `format` and `version` yourself and refuse a major version you do not know.

## Chat (1.5.0)

`eveCyno.chat` delivers the chat channels the user picked, and nothing else. `ChatNamespace` in `src/index.ts` is the reference.

- **Who gets it.** A plugin with `chatlogs` in `permissions.logs`. It does not need `permissions.characters`. A plugin that can send data out gets chat only when it is built in, only from channels the user picked; other players' names in a line reach it, and it keeps them in its page. The host checks this for every batch and delivers nothing when the check fails.
- **The picks are the user's.** `channels()` reads them. `pickChannels()` opens the host's picker from the main page, on a user gesture, and answers the picks after the dialog: the old ones when the user cancels. A plugin cannot set them. A user picks at most 32, and revoking `chatlogs` clears them.
- **Lines are live.** `subscribe()` starts delivery to the page, holds the plugin awake and ends with the page. Nothing old is delivered, and a new pick starts at the end of its files. One line arrives once however many of the user's clients hear it. A line never says which character heard it, and lines of the `EVE System` speaker do not arrive.
- **Text is hostile input.** Anyone in a channel can type anything. `text` is cut at 1024 characters.
- **Batches.** At most 4 per second, 500 lines each, the newest kept. `dropped` counts what the host cut. What cynod's own queue dropped is logged there, so `dropped` is a lower bound.
- **`state()`.** One entry per pick. `following` is true when a session of the channel started after the last daily downtime, so a client that left today still counts, and false when "Log Chat to File" is off or no client joined the channel since. Before `subscribe` every entry says false. `lastLineAt` is the newest line seen since the app started. A tool that warns the user must show `following: false`: a deaf page must not look healthy.
- **`onChannelsChanged`** arrives once cynod has the new picks, so a `state()` called in answer is current. It reaches pages that subscribed.

## Fitting engine (1.14.0; hash fields 1.15.0; skills, solver and jobs 1.16.0)

`eveCyno.fit` is the fitting engine that runs on this computer: it parses and renders EFT text, hashes a fit, searches and describes items, evaluates a fit (resources, DPS, tank, capacitor, navigation, targeting, drones, range) and converts to and from the ESI fitting shape. Test `host.capabilities().features.fit` first. It needs `permissions.fit: true` (one consent line; nothing leaves the computer) and `^1.14` in `engines.eve-cyno-api`.

Methods: `info`, `parse`, `render`, `hash`, `searchItems`, `itemInfo`, `evaluate`, `validate`, `fromEsi`, `toEsi`, and since 1.16.0 `requiredSkills`, `canUse`, `solve`, `jobStart`, `jobStatus`, `jobPage`, `jobCancel`. Every result carries `engine` (`version`, `sdeVersion`, `hashVersion`). Every number in an `evaluate` result is finite except `stats.capacitor.secondsToEmpty`, which is `null` for a stable capacitor; a figure the engine cannot compute is `0` with a `flags.estimated` entry whose reason is `not computable for this fit`. `skills` is `allV`, `allZero` or `levels` (1.16.0; 1.14.0 and 1.15.0 hosts accept only `allV`). The engine starts at the first call and stops when idle; a call while it restarts fails `unavailable` and the next call starts it again. A plugin may make 50 calls a second and have 4 in flight (`rate_limited`); both counts belong to one page of the plugin and start again when the page reloads (a job call of the old page still runs to its end). The fit manager paces itself on its side with the same bucket (50 calls a second, burst 50; idle work such as rehash, ESI swap-in and import leaves 10 tokens for interactive calls) and retries a `rate_limited` answer 5 times after 20, 50, 120, 250 and 500 ms.

**Hash fields (1.15.0).** Each fit of a `parse` result has `line` (the 1-based line of its header in the pasted text) and, when its hull resolved, `hash`, `hashVersion` and `designKey`, the same values `hash` answers for its `fit`; they are left out when the hull did not resolve. `designKey` is the hash of what an ESI fitting keeps of the fit: `toEsi`, then `fromEsi` (with `fitting_id` 0), then `hash`, so an import needs one `parse` call instead of four calls per fit. `hash` answers `designKey` too, and `fromEsi` answers `hash`, `hashVersion` and `designKey` of the fit it returns. A plugin built against 1.14.0 keeps working: the fields are only added.

**Skill levels, solver and jobs (1.16.0, `^1.16`).** All additive; a plugin built against 1.15.0 keeps working.

- **`SkillInput`.** `{ kind: 'allV' }`, `{ kind: 'allZero' }` or `{ kind: 'levels', levels: [[skillTypeId, level], ...] }`, each with optional `implants` (the pilot's active clone, at most 10 type ids; the implant lines of the fit itself never apply). In `levels` a skill you leave out counts 0, never V, except that a hull or subsystem skill the pilot lacks altogether counts level I for the numbers (the game's fitting simulation does the same; `requiredSkills`, `canUse` and the skill violations still report it as missing), and `allZero` has no such floor: every skill at 0; at most 1,000 pairs, a skill once, a level 0 to 5 (`bad_params` otherwise, for example `skills.levels[2]: skill id listed twice`). An id the engine does not know (a skill or implant newer than its data) is ignored and counted in `skillsIgnored` (a count, never ids); an unknown implant is also an `unmodelled` entry. Under `levels` and under any `implants` a resource violation is `hard`; the `soft` class (within 5 %) stays for `allV` and `allZero` without implants.
- **Changed results.** `info()` also answers `evalMs`, `workers`, `evaluationsPerSolve` and `maxJobMs` (all four are left out when the engine does not report them). `evaluate` takes `options.damagePattern` (`uniform`, `em`, `thermal`, `kinetic`, `explosive`; `uniform` is the default) and answers `skillsIgnored` and `stats.tank.repair` (per second: local peak `shield`, `armor`, `hull`; the capacitor-limited `sustained`; what the fit repairs on others in `remote`, with `capacitor` in GJ). `validate` takes `options.train: true` (kind `levels`) and adds `train` lines (`{ skillTypeId, level, gain }`) to the violations a higher level lifts; it answers `skillsIgnored`.
- **`requiredSkills({ typeIds })`** (at most 512, `bad_params` over) answers per type its `direct` skills and the closure `all` (direct first, each skill once at the highest level any path needs). **`canUse({ skills, typeIds })`** answers per type `ok` and `missing`: every unmet requirement of the type's own `direct` list at the pilot's levels (a missing prerequisite of a skill the pilot has trained is not a violation: the game checks only the item's own skills; use `all` of `requiredSkills` for what to train).
- **`solve({ kind, fit, skills, policy, target?, options? })`** (`kind` `refit`, `downgrade` or `convert`; `target: { hullTypeId }` for `convert` only) answers within 30 seconds: `status` (`ok`, `ok_with_downgrades`, `no_candidate`, `uncertain`), the new `fit` and its `changes`, the `baseline` numbers (`designed`: all V, no implants; `flown`: the pilot) and which one was `used`, the `result`, and for `no_candidate` the `binding` (a violation code, `gate`, `capacitor` or `subsystems`), up to 2 `closest` fits and up to 3 `train` skills. A change line has `chargeFrom` and `chargeTo` only when the charge changes. `policy` needs all five fields; `from: 'fallback'` lets the engine pick the rule for the kind and the result echoes the policy used. `options.prices` are `[typeId, isk]` pairs of the open fit's items (at most 512).
- **Jobs.** `jobStart({ spec })` converts every fit of `spec.fits` (each with a `ref` of 1 to 128 bytes, once) onto every hull of `spec.hulls` (`kind: 'convert'`, at most 5,000 pairs) and answers `jobId`, `pairs` and `estimateMs` at once. `jobStatus({ jobId })` answers the state (`queued`, `running`, `done`, `cancelled`, `failed`, `expired`, `lost`), `total`, `done`, `counts`, `unread`, `endedAt` and `expiresAt` (Unix ms, once the job ended; an `expired` job may lack `endedAt`). `jobPage({ jobId, cursor?, limit })` reads results (`limit` 0 to 50, one page under 4 MiB). `jobCancel({ jobId })` stops a job. A page's `cursor` is an opaque string and is always there; the results of a page leave the engine only when the next call names that cursor, so the last page is acknowledged by `jobPage({ jobId, cursor, limit: 0 })`. A call without a cursor starts at the first unacknowledged result; an unknown or stale cursor is `bad_params`. The engine keeps unread results 30 minutes after a job ends.
- **Job errors.** A job id that is not yours reads like an unknown one: `not_found`. A second job while one is queued or running is `rate_limited`, and so is a fifth job waiting engine-wide. `too_large`: more than 5,000 pairs (fits times hulls, whichever list is long), an estimate over 30 minutes (`info().maxJobMs`), or a fit too large to expand.
- **`lost` and `expired`.** The host answers these when the engine process that ran the job is gone (it was stopped when idle, it crashed, or the app restarted). `lost`: the job had not ended, so run the pairs you have not read again. `expired`: the job had ended and its `unread` results went with the process. A page of such a job is `not_found`. A job outlives a page reload, but a `jobStart` still running when its page reloads is dropped: its answer has no reader. After an app restart the host holds no record of the job at all and answers `not_found`.

Limits and errors. Params are at most 2 MiB (`too_large`); `parse` `text` is at most 1 MiB and `itemInfo` `typeIds` at most 512 (`too_large`); `searchItems` `query` and `cursor` are limited in bytes by the engine; a result line is at most 4 MiB (`too_large`). Each call has 30 seconds (`timeout`). Errors: `bad_params` (the message starts with the field path, for example `fit.modules[3].typeId: ...`, at most 200 characters), `too_large`, `timeout`, `rate_limited`, `unavailable` (engine stopped, restarting, or not available until the app restarts), `internal`, and `not_permitted` when the manifest has no `fit` grant. A call with bad params costs no rate token. `stats.drones`: `active`, `bandwidthUsed` and `dps` count launched drones; `inBay` and `bayUsed` count the whole bay. `validate` figures follow the same finite-number contract as `evaluate`. Service-slot modules are not fittable.

## Database (1.12.0)

`eveCyno.db` is the plugin's own SQLite database, kept by the host in a separate process (one per plugin, started at the first call and closed after two idle minutes). Test `host.capabilities().features.db` first. It needs `permissions.database: { quotaMB }` (an integer from 1 to 2048, asked in the consent prompt) and `^1.12` in `engines.eve-cyno-api`.

**Who gets it.** Built-in plugins only, for now. The database process is not sandboxed (the host cannot sandbox an Electron utility process), so only reviewed SQL reaches the engine. A plugin that is not built in still loads when its manifest declares `database`; it gets no consent line, no grant for it and `features.db === false`. Test builds treat the `dev.evecyno.*` fixtures as built in.

**Calls.** `migrate({ version, statements, owned })` runs the statements in one transaction when the stored schema version is below `version`, then stores it and answers `{ ran: true, from, to }` (`ran: false` when the stored version is already `version` or higher); this is the only place for schema changes (`CREATE`, `ALTER`, `DROP`, FTS5 tables). `query({ sql, params?, limit?, keyset?, cursor? })` is read only and answers `{ columns, rows, more, cursor }` with rows as arrays, at most `limit` rows (default 10 000, at most 100 000) and 1 MiB. `write({ statements })` runs every statement in one transaction, all or nothing, and answers `{ changes, lastInsertRowid }` (`lastInsertRowid` is `null` when nothing was inserted or the rowid is past 2^53-1); an upsert (`INSERT ... ON CONFLICT ... DO UPDATE`) always reports `null`, whether it inserted or updated; use `RETURNING rowid` to learn the row. `usage()` answers `{ bytes, quotaBytes, fileBytes, quarantinedAt }`. 1.13.0 adds `backup()` and `restore()`, each with no parameters, from the main page, on a user gesture and through a host dialog (the plugin never sees a path); they answer `true` when done and `false` when the user closed a dialog. `backup()` writes a consistent copy of the whole database, owned rows included: it is the user's own copy, so say in the UI that it should be kept private. `restore()` first asks the user to confirm, then checks the file (a backup of this plugin, no triggers or foreign virtual tables, within the quota; otherwise `unavailable` or `too_large` and nothing changes), replaces the database, and drops the rows of owners the plugin may not see (its granted characters that the vault still holds; while the vault list cannot be trusted and the plugin may see characters, `restore()` answers `unavailable` and nothing changes). Calls in flight when the file is replaced fail `unavailable`; run `migrate` again afterwards, because the restored file may carry an older schema version.

**Params.** `?`, `?NNN` (an array) or `:name`, `@name`, `$name` (an object); values are `null`, a finite number, a string or a `Uint8Array`. Booleans, BigInt, NaN and integers past 2^53-1 are `bad_params` (store 1 or 0). Named params may not start with `evecyno_`. The whole call is at most 2 MiB, counting a typed-array view by its whole buffer.

**Paging.** Without `keyset` a result cut by the cap says `more: true, cursor: null`: narrow the query. With `keyset: ['a','b']` (1 to 4 output columns that are unique, non-NULL and ascending in that order) the host returns an opaque `cursor`; pass it, with the same `sql`, `params` and `keyset`, for the next page. No read snapshot is held between calls, so pages are not one snapshot. A trailing SQL comment is refused in keyset mode.

**What the host refuses** (`bad_params`; the message starts with `guard:` for a policy refusal, `sql:` or `statement:` for SQL SQLite rejects, `cursor:` for a bad cursor and `owned:` for a bad `owned` declaration): `ATTACH`, `DETACH`, `VACUUM`, `ANALYZE`, transaction and savepoint statements, triggers, temp objects, pragmas (introspection and a few read forms are allowed), `load_extension`, virtual tables other than FTS5 (and FTS5 with `content`, `content_rowid`, `contentless_delete` or `contentless_unindexed`), names starting with `evecyno_`, more than one statement per entry, more than 64 columns in a table or result, a value or SQL text over 1 MiB. Long `OR` chains stop at an expression depth of 200: use `IN (...)` or `json_each`. A sort or `GROUP BY` without an index that needs more than the store's memory fails `too_large`: sort through an index.

**Owned rows.** `owned: [{ table, column }]` declares the tables whose rows belong to a character: the owner column is `INTEGER` in a `STRICT` table, not generated, the first column of a non-partial index, and it keeps its position (to drop a column left of it, rebuild the table: create, copy, drop, rename). `UPDATE` of an owner column, `rowid`, `_rowid_` or `oid` is denied (change an owner by delete and insert). A NULL owner marks a plugin-local row. Owner deletes (a later API minor) run no foreign-key actions.

**Limits.** `query` 10 s, `write` 30 s, `migrate` 120 s: past the cap the host stops the database process, the call is `timeout` and changes nothing. One call runs at a time per plugin, at most 32 wait (and 8 MiB of params), beyond that `rate_limited`. A write past the quota is `too_large` and changes nothing; the disk use is at most the quota plus one kept damaged copy plus the write-ahead log of the largest single write (the host truncates a log above 4 MiB after the write). A damaged file is set aside and an empty one started (`unavailable` for that call, then `quarantinedAt` is set and the plugin migrates again). Errors use the existing codes: `bad_params`, `too_large`, `timeout`, `unavailable`, `rate_limited`, `not_permitted`, `internal`.

**Testing a plugin that uses `db`.** The repository's private package `packages/store-core` has `createFakeDb({ quotaMB })`, which returns a `DbNamespace` over an in-memory SQLite with the host's guard, caps, keyset rules, error codes and message prefixes (it needs Node 24 with `node:sqlite` `setAuthorizer`). It has no time cap (`slow()` makes the next call `timeout`), no real write-ahead log and no process; `damage()` and `down(n)` fake a damaged file and an unavailable store. Vendor it by relative path, as the multi-client plugin does with `gamelog-state`.

## Theme (1.0.0-beta.5)

`eveCyno.theme` is always present (no permission) and read-only: a plugin never sets the theme.

- `await eveCyno.theme.get()` answers a `ThemeInfo`: `id` (`cyno` or `pkg:<package>/<theme>`), `name`, `scheme` (`dark` or `light`),
  `density`, twelve `colors` (`window`, `background`, `surface`, `raised`, `line`, `text`, `textMuted`, `textDim`, `ok`, `warn`, `bad`,
  `own`), the base `radius` in px and the `fonts` (`display`, `body`, `mono`) as CSS font stacks.
- `eveCyno.theme.onChanged(handler)` runs with the new `ThemeInfo` when the user switches theme, accent or fonts. It reaches the plugin's
  main page and its overlay pages.
- `colors.own` is your plugin's own palette colour (the one on its tile) as the theme draws it. There is no host accent colour: plugins
  never draw with the host's ice.
- The page's `prefers-color-scheme` follows `scheme`. The host injects no CSS into plugin pages: draw with the colours you read.
- `fonts` are names only. The host gives out no font files, so bundle the fonts you need and fall back to the stack.

## Gesture grants (1.23.0)

Three optional fields; a plugin that uses any of them needs `^1.23`.

- `services.call({ interface, method, params, gesture: 'grant' })`: this call is the user's act. Make it in the task of a press in your main page
  (a mouse or key press the host saw itself; an event your page makes never counts). A grant is minted only for AI Chat's interface `evecyno.aichat`,
  methods `askStart` and `askReply`, between two built-in plugins: when the press is at most 1 s old and the call reaches the provider, the provider's
  handler gets a grant in `ctx.gesture` (an opaque string). Any other interface or method gets none and spends no press. Any grant you gave that
  provider before ends. Without a press the call goes ahead without a grant. `gesture: 'revoke'` ends the grant you gave that provider; it needs no
  press. Your page never sees a grant.
- `ctx.gesture` (the third argument of a `services.handle` handler): spend it as `AiChatRequest.gesture`. It pays for at most the provider's turns per ask
  (`AiLimits.turnsPerAsk`: a whole number from 1 to 30, set in Settings > AI; 12 by default) on a provider that needs a user act (Claude Code), one at a time, within 15 minutes, by this plugin only. It ends when the consumer revokes it or gives a newer
  one, when the call that brought it fails or times out, when the consumer's window closes, when either plugin's page stops or reloads, or when the AI
  settings for Claude Code or this plugin change. Keep it in memory: never store, log or send it on.
- `eveCyno.ai.chat({ ..., gesture })`: spends a grant on this turn instead of a press in your own page. A Claude Code turn that spends one runs with no
  tools at all in that provider. A grant that is not yours, spent, expired, ended or already in a running turn: `provider_rejected`, nothing starts.
  On another provider it is ignored and not charged.

## Window (1.22.0)

`eveCyno.window` is always present (no permission) and tells a plugin only about its own window. A plugin that uses it needs `^1.22`.

```js
eveCyno.window.onClosed(() => { /* the user closed this plugin's own window: stop what only made sense while it was open */ });
```

- The handler runs, with no argument, when the user closes the plugin's own window (opened with "Open in its own window") with its
  close button or the window manager's close, or when its window is dropped after a crash (the window's own page failed for good after
  it was shown). The page keeps running, hidden, back in the main window.
- It fires once per window: a close that follows a crash, or a crash that follows a close, does not fire it twice.
- It fires again each time the plugin's window is reopened and closed. It reaches the plugin's main page only, not its overlay pages,
  and only the plugin whose window closed hears it. A page that is not running when the window closes does not hear it later.
- It does not fire on a minimise, a hide, focus loss or another visibility change, on "Back to main window", when the main window
  closes (to the tray or not), when the host closes the window (the plugin is switched off or uninstalled) or when the app quits.

## Notifications (1.0.0-beta.4)

`eveCyno.notifications` exists for a plugin granted `permissions.notifications: true`.

```js
const { id } = await eveCyno.notifications.show({ title: 'Hostile Loki x3 in 1DQ1-A', body: '2 jumps from you', severity: 'alert' });
eveCyno.notifications.onOpened(({ id }) => { /* the user opened that notification: show the matching view */ });
```

- The host draws the toast and keeps the entry in its notification panel. The buttons are the host's (Open, Mute <your plugin>, Dismiss);
  a plugin cannot define buttons or run code from a click.
- `title` at most 60 characters, `body` at most 200, `severity` `normal` (default), `attention` or `alert`. A longer text is cut and
  ends with "…" (counted in code points). A newline, a control or invisible character, or an unknown severity is `bad_params`.
- At most 3 notifications at once, then one every 10 seconds; the excess is `rate_limited`.
- The user can mute a plugin: its notifications are then listed as read and get no toast, and `show` still resolves.
- The host keeps the newest 50 notifications in memory (they are gone after a restart).
- `onOpened({ id })` runs when the user opens a notification of yours; a plugin that is not running is started first. Like every
  `on*` hook it returns nothing (there is no unsubscribe).

## ESI (1.0.0-beta.3)

`eveCyno.esi.get` goes through the host's broker, which keeps each plugin apart from the others:

- The cache is per plugin, the rate share is per plugin and character (burst 20, then 1 call per second; public routes share one
  `public` bucket per plugin), and at most 4 calls of one plugin are in flight; the rest wait in order. A fresh cache hit costs no
  share.
- A plugin whose calls end in 30 non-2xx answers within 60 seconds is paused for 60 seconds: `esi.get` rejects with `rate_limited`
  ("paused after too many ESI errors"). 420 and 429 answers count too, and so does an ESI outage (5xx), so it can pause every plugin
  at once; retry after the pause.
- `esi.get` rejects with `unavailable` when the character needs re-authorization (its sign-in expired or was revoked); the user
  re-authorizes it in the host, and calls work again after that.
- The result is `{ status, body }` and, from 1.10.0 (`^1.10`), `{ status, body, pages, lastModified, etag, expiresAt, fromCache }`: `pages` is ESI's `X-Pages` (an integer or `null`),
  `lastModified` and `expiresAt` are epoch milliseconds (or `null`; `expiresAt` is when to ask again, and a cached answer gives the stored expiry), `etag` is ESI's `ETag` (or `null`) and
  `fromCache` says the broker answered from its cache. The rate-limit and error-limit data stay in the host.
- `eveCyno.esi.get({ characterId, path, query })` (1.10.0, `^1.10`): `query` is an object of at most 4 keys with number or boolean values (a string is `bad_params`), for the routes that page or filter. The `path`
  still never holds a `?`. The broker accepts only the keys listed for the route: `page` (assets, wallet journal, order history and contracts of a character; assets, orders, order history and industry
  jobs of a corporation), `from_id` (wallet transactions), `include_completed` (industry jobs of a character or corporation). Any other key, a value out of range or a query on another route is `bad_params`. From 1.27.0 (`^1.27`; an older host may answer `bad_params` for them) the list also holds `page` on the blueprints of a character and of a corporation and on `/markets/structures/{structure_id}`, and, on the public
  route `/markets/{region_id}/orders`, `type_id` (a whole number from 1 to 2147483647) and `page`; `type_id` is required there, so a call to that route with no query, or without `type_id`, is `bad_params` (the broker adds `order_type=all`).
  The `path` has no trailing slash and no query string: `/characters/1/online/` and `/status/?x=1` are `bad_params` (the broker adds no slash and drops none, so ESI sees the path as written). Two pages are two cache entries. A 403 on `/universe/structures/{structure_id}` (no docking access) or on `/markets/structures/{structure_id}` (the character cannot see that market) does not count against the 30-error pause, but the two routes share one window: 20 such 403s in 60 seconds pause the plugin on their own.
- `eveCyno.esi.lookup({ kind, characterId, corporationId?, ids })` (1.10.0, `^1.10`) is a closed set of read-only lookups that ESI answers to a POST with the ids in the body: `kind` is one of
  `character_asset_names`, `character_asset_locations`, `corporation_asset_names`, `corporation_asset_locations` and `universe_names`. You name the kind; the host never takes a path, a method or a
  scope from the plugin, so this is no general POST. `ids` are 1 to 1000 positive integers; `corporationId` is required for the two `corporation_*` kinds and refused for the others. The asset kinds
  need `esi-assets.read_assets.v1` (character) or `esi-assets.read_corporation_assets.v1` (corporation, which also needs the in-game corporation role) in `permissions.esi` and on the token;
  `universe_names` needs no scope. The answer is `{ status, body }`; nothing is cached; errors, rate share and pause are those of `get`; a character this plugin may not see is `not_found`.
- `eveCyno.host.openLink({ url })` (1.6.0, `^1.6`) opens a link in the user's browser: a zKillboard kill page only, `https://zkillboard.com/kill/<id>/`, from the main page, one user gesture per call. Any other URL is `bad_params`. It is not a general opener, because a plugin without `network` could otherwise send what it knows to a URL of its own choosing.
- `eveCyno.esi.setWaypoints` (1.8.0, `^1.8`) is `setWaypoint` for several characters and destinations under ONE gesture: `{ characterIds (1 to 20, unique), destinationIds
  (1 to 50, in the order to visit), clearOtherWaypoints }`, at most 200 waypoints in all. `clearOtherWaypoints` applies to the first destination of each character, the rest are
  appended. A call that is wrong as a whole (`bad_params`; a character this plugin may not see, `not_found`; the manifest lacks the scope; no gesture) throws and keeps the credit.
  Otherwise the answer holds one entry per character in the order given: `{ ok: true }` or `{ ok: false, code, message, sent }`, where `sent` counts the waypoints of that
  character that reached the game. One character failing (no scope on its token, ESI busy) never stops the others. The characters are sent one after the other.
- `eveCyno.esi.setWaypoint` (1.6.0, `^1.6`) sets one autopilot waypoint in the character's client; with `setWaypoints` and the two fitting writes below it is
  one of the only ESI writes, and there is no general POST. It needs `esi-ui.write_waypoint.v1` in `permissions.esi` and on the character's token, the main page, and one user
  gesture per call. Without a gesture it rejects with `not_permitted`; a wrong parameter is `bad_params` and keeps the credit; a character
  this plugin may not see is `not_found`, the same as an unknown id. A token without the scope is `not_permitted`, and its message says to
  re-authorise; the host queues that character for re-authorization. The rate share and the pause are the ones of `esi.get`. Nothing is cached.
- `eveCyno.esi.saveFitting({ characterId, fitting, replaces? })` and `eveCyno.esi.deleteFitting({ characterId, fittingId })` (1.24.0, `^1.24`) save a fitting to the
  character's fittings in the game (with `replaces`, then delete that one) and delete one. Needs esi-fittings.write_fittings.v1 in permissions.optional.esi, granted, and
  on the character's token. `replaces` and deleteFitting also need esi-fittings.read_fittings.v1 in permissions.esi and on the token: the host reads the fitting to show
  it. The main page and one user gesture per call, which opens the host's confirmation; the host writes only after the user confirms there. Each write is sent once.
  `unknown`: the request was sent and no answer came; read the character's fittings before you try again. No other ESI write route exists. `fitting` is a `FitEsiBody` as
  `fit.toEsi` gives it. The confirmation shows the character's name from the host's vault, the ship and every line as the host names them, and your fitting's name and
  description; your plugin never draws it. The answer is `{ status: 'saved', fittingId, old? }` (`old`: `deleted`, `not_deleted` or `unknown` after a replace) or
  `{ status: 'deleted' }` (also when the fitting was already gone: ESI answered 404 to the confirmed delete), else `cancelled` (the user cancelled, or your page
  stopped or reloaded, or your permissions changed, before the write), `needs_reauth` (the token lacks a scope or its sign-in ended: send the user to Settings >
  Characters, `characters.open({ characterId })`, to turn on saving fittings for that character; `characters.open` with `reauth: true` adds read scopes only and
  never adds esi-fittings.write_fittings.v1), `refused` with ESI's `message`, or `unknown`. Nothing is written in any of these but `saved`, `deleted` and `unknown`.
  A call refused before the confirmation throws: `not_permitted` (no gesture, not the main page, the scope not in the manifest or not granted), `not_found` (a
  character this plugin may not see, a fitting id the character does not have), `bad_params`, `rate_limited` (one write per plugin at a time, or ESI asked to slow
  down), `timeout` or `unavailable`. Some are also thrown after the user confirmed, and then too nothing was written: `rate_limited` (ESI answered 420 or 429),
  `not_found` (the character left the vault), `timeout` (the host's deadline ran out before the request was sent) and `unavailable`.

## Character groups (1.0.0-beta.3)

`eveCyno.characters.groups()` returns the user's character groups as `{ id, name, characterIds }[]`. Groups are made by the user in
the host; a plugin only reads them. Ids only: a group never carries character names (use `characters.list()` for those). Each group
is narrowed to the characters this plugin may see (`characters: 'all'` is every character in the vault, `selected` only the selected
ones), and a group with none of them is left out. The method exists wherever `characters` does.
`characters.list()` and the `characterIds` of each group come in the user's order (the order the user set in Settings > Characters; a character
the order does not list follows the listed ones). The host reads it on every call, so a plugin that keeps the list asks again when it needs a fresh one;
there is no change event for it.

## Clipboard (1.0.0-beta.3)

`eveCyno.clipboard` exists for a plugin granted `permissions.clipboard: ["read"]`. It delivers text changes only.

```js
const { enabled } = await eveCyno.clipboard.subscribe();   // once per page; { enabled: false } until the user switches the plugin on
eveCyno.clipboard.onChanged(({ text }) => { /* a new text was copied */ });
```

- The user switches clipboard watching on per plugin (default off). While it is off `subscribe()` answers `{ enabled: false }` and no
  event is sent; when the user switches it on, events start for pages that subscribed, with no second call. The host reads the
  clipboard every 500 ms, and only while at least one subscribed plugin is switched on.
- An event reports a change from now on: the text that was already on the clipboard when watching started is not sent, and the same
  text again is not sent twice in a row.
- A text longer than 16 KiB (UTF-8) is dropped.
- Nothing is sent while an EVE sign-in is in progress, because the user may copy a password then. The text on the clipboard when the
  sign-in ends counts as already seen.
- A copy that carries the password-manager hint (`x-kde-passwordManagerHint` on Linux, `ExcludeClipboardContentFromMonitorProcessing`
  on Windows) is withheld, also later when the hint is gone. Detection is checked on Linux for a hint written by Electron;
  real password managers are an owner check, and Windows is not verified yet. Managers that set no hint (browser extensions) are not
  covered. macOS delivers no clipboard events at all (it fails closed: nothing is sent there).
- Subscriptions are per page and end with the page that made them. A plugin that is subscribed is not closed by the host's idle suspension.

## Windows (1.0.0-beta.2)

`eveCyno.windows` exists for a plugin granted `windows` (API 1.7.0: the list alone, no pictures; `windows.focus`, `windows.minimize` and `windows.focusLastOther` need one of the other three), `windowThumbnails`, `hotkeys` or `overlays`. It lists the
EVE windows (`list`), the displays (`displays`) and, after `subscribe()`, sends `onChanged`, `onActiveChanged` and
`onDisplaysChanged` events (call `list()` after `subscribe()` for the current state). Rules a plugin can rely on:

- `character` (the name from the window title) is given only to a plugin without a `network` host that also consumes no service, provides none (the services broker is a relay) and has neither `permissions.ai` nor `permissions.account`; every plugin gets `key`, an
  opaque identifier that is stable for that plugin and differs between plugins. `characterId` appears only for a character in the
  user's vault that the plugin may see.
- `focus`, `focusLastOther` and a `minimize` that includes the active window each need a user gesture in the plugin page (one
  mouse press or non-repeating key press within the last second; at most 4 are kept). Without one: `not_permitted`, "no user gesture".
- Subscriptions are per page: a page subscribes for itself, and a subscription ends when that page reloads, crashes or stops (an overlay
  page's when that page ends, with its overlay). A main page's reload does not carry over a subscription: subscribe again.
- `setBounds` (1.29.0) has a stricter rule than `focus`: the act must be a press in the main page or a press of one of your hotkeys (a thumbnail
  press or an overlay-page press does not count), the call comes from the main page, and only built-in plugins may make it on a 1.29.0 host (1.30.0 changes nothing here).
- To minimize the client that was active, wait for `onActiveChanged` after you `focus` another window. `windows.list()` right after a
  `focus` may still show the old window as active (on Linux the window manager answers `_NET_ACTIVE_WINDOW` asynchronously), and
  minimizing a window the host still counts as active needs a user gesture, which the call may not have.

## Overlays (1.0.0-beta.2)

`eveCyno.overlays` exists for a plugin granted `overlays`. An overlay is a small transparent window of the plugin's own: always on top,
never focused (a click on it does not take focus from the game) and without a taskbar entry. Its title is chosen by the host
(`EVE-Cyno overlay - <plugin name>`). It shows one of the plugin's pages, declared in the manifest:

```json
{ "contributes": { "overlays": [{ "id": "thumb", "entry": "overlay.html" }] }, "permissions": { "overlays": true } }
```

`id` is the overlay type (`eveCyno.overlays.create({ type: 'thumb' })`); `entry` is a relative `.html` path of the plugin (at most 16
overlay types). The overlay page gets the same `eveCyno` object; `eveCyno.overlays.self()` returns its own overlay (`null` in the main page).

- A plugin has at most 64 overlays (`too_large`). `bounds` are DIP in virtual-screen coordinates, 32x18 to 4096x4096. `setBounds`
  needs them on a display, takes up to 64 items and refuses all of them when one is invalid. `create` uses `bounds` only when no
  remembered position applies, and falls back to the default spot when they are off every display.
- Pass a `key` to `create` and the host remembers where the overlay was last placed (at most 256 keys per plugin), and opens it
  there next time if that spot is still on a display; otherwise at the `bounds` you ask for, otherwise at a cascaded default.
- `above: <id>` stacks an overlay over another one of yours. It moves with that overlay, and closes with it.
- When a display goes away, an overlay of which less than half is on a display is moved onto the primary display and `onMoved` fires. A
  saved position is likewise reused only when at least half of the overlay lies on a display. An overlay that holds a thumbnail slot
  must lie fully on one display and is moved, not shrunk (see Thumbnails). That move is
  not remembered: when the display comes back, the next `create` with the same key opens on the spot your plugin last chose.
- The host also hides an overlay (without changing `visible`, which stays your wish) while it lies over an EVE-Cyno window the user is working in (the focused one) or over a permission prompt, and shows it again when it no longer does. The host also moves an overlay when the user resets its saved spot in Settings: the overlay keeps its size, the overlays stacked over it move with it, and `onMoved` fires for each. That move is not remembered either.
- `overlays.onClosed` and `overlays.onMoved` (like `commands.onCommand`, `settings.onChanged` and `settings.onPreview`) are delivered to the plugin's
  main page only; an overlay page does not receive them.
- Overlays belong to the plugin's main page: a reload, crash or stop of that page closes every overlay, with no event. The main page
  and its overlay pages run in one renderer process (one per plugin), so a renderer crash is a crash of the main page (1.0.0-beta.7): every overlay
  closes with no event and the plugin restarts, which uses one of the plugin's three restarts; open them again when it starts. `onClosed` with reason `crashed` comes only for an
  overlay page whose renderer went away while the main page lives.
- A mouse press or non-repeating key press in an overlay page counts as a user gesture, like one in the main page (see Windows).

## Thumbnails (1.0.0-beta.2)

`eveCyno.thumbnails` exists for a plugin granted `windowThumbnails`. A thumbnail is a **slot**: a rectangle of one of your overlays that the
host paints with the live EVE window. The host draws it in a view of its own, on top of your overlay page, so your page never receives
the pixels (no stream, no canvas); it receives pointer events over the slot. Draw around the slot; to draw over it, open a second
overlay with `above`.

```js
const { slotId } = await eveCyno.thumbnails.attach({ overlayId, windowId, rect: { x: 2, y: 2, width: 380, height: 194 } });
eveCyno.thumbnails.onPointer(e => { if (e.type === 'down' && e.button === 0) eveCyno.windows.focus({ id: windowId }); });
```

- `attach({ overlayId, windowId, rect, opacity?, fps? })`: `rect` is DIP relative to the overlay's content, at least 16x9 and inside the
  overlay; `opacity` 0.2 to 1 (default 1); `fps` 1 to 30 (default 15). An overlay that is not yours and a window that is not listed
  are `not_found`; a 33rd slot is `too_large`.
- `update({ slotId, rect?, opacity?, fps?, windowId? })` and `detach({ slotId })`.
- A thumbnail is always the whole window, never a cropped or magnified view. The host enforces it, so these are `bad_params`:
  - an overlay that holds a slot lies fully inside one display (`attach` is refused otherwise, and so is an `overlays.setBounds` that would
    leave it partly off the display);
  - a slot is never larger than its window: its size in physical pixels (DIP times the display scale) is at most the size of the window's
    client area in each dimension (1.0.0-beta.7: the client area, what the thumbnail shows; the frame and the caption do not count), so
    the largest view is 1:1 and a smaller slot is a zoom out. The same check runs again when `update` changes the `rect` or the
    `windowId`, and on `overlays.setBounds` at the new spot's display scale (refused when a slot would be larger than its window there,
    also while the host draws that slot clamped: shrink the slot to `clamped` first; an overlay stacked `above` the moved one is checked
    at the spot it is carried to). A minimized window is exempt (the whole window is shown), and so is a listed window without a client
    area (0x0, such as a hidden one): once it has one, a larger slot is drawn clamped (next item);
  - (1.0.0-beta.7) a slot that becomes larger than its window afterwards, because the window shrinks or because the host moves the overlay
    to a display with a larger scale, is neither refused nor detached: the host draws the whole window at most 1:1, centred in the slot,
    and sends `onState` `live` with `clamped: { width, height }`, the size in DIP it draws the window at. Shrink the slot (or the overlay)
    to it, or leave it; a `live` without `clamped` follows when the window is large enough again. Pointer events still cover the whole
    slot;
  - `overlays.setBounds` (also in a batch, which is refused as a whole) that would leave a slot partly outside its overlay: "bounds would
    clip a thumbnail". Move or resize the slot with `update` first.
  - The host applies a slot's rectangle again whenever its overlay is placed, so a move to a display with another scale keeps the whole
    window in the slot.
  - When the displays change, the host moves an overlay that holds a slot, never resizes it. If the overlay is larger than every display,
    its slots are detached: you get `onState` `unavailable` for each, and the `slotId` is then gone (`not_found`).
- Masking a slot with an opaque `above` overlay cannot be checked by the host; the marketplace review looks for it.
- `onPointer`: `down`, `up`, `move`, `enter`, `leave` and `wheel`, with the button, the buttons held, the position in the slot and on the
  screen (`screenX`/`screenY` stay valid while your overlay moves under the pointer) and the modifiers. `move` is limited to 60 per second;
  the last move before an `up` always arrives. A `down` over a slot is a user gesture (see Windows), so `windows.focus` works in its handler.
- `onState`: `live` (pixels flow; with `clamped` as above), `unavailable` (the host could not capture the window, or the capture stopped:
  `thumbnails.update({ slotId, windowId })` with the same window starts it again, so retry a little later) or `closed` (the window left the list). A closed
  slot stays until you `detach` it or `update` it with a listed `windowId` (also after the same window id comes back).
- (1.0.0-beta.7) On Windows the host makes every live thumbnail again after the computer resumes from sleep and after a display change;
  the slot stays `live` and you hear nothing unless that fails (`unavailable`).
- A hidden overlay shows and captures nothing; the slot continues when the overlay is shown again.
- A slot belongs to the page that attached it. It ends, with no event, when that page reloads, crashes or stops, and when its overlay closes.
  A plugin has at most 32 slots.

## Hotkeys (1.0.0-beta.2)

`eveCyno.hotkeys` exists for a plugin granted `hotkeys`. A chord is global: the host grabs it from the system (an X11 key grab, the desktop's shortcut portal, or `RegisterHotKey` on Windows), so it works while the game has the focus. Under XWayland the X11 grab sees the key only while an X11 window has the focus, which is why the portal exists as the alternative. One press is one `onPressed`, however long
the key is held (the host filters auto-repeat), and the press is a user gesture for your page, so `windows.focus` works in the handler.

```js
const results = await eveCyno.hotkeys.register({ bindings: [
  { id: 'cycle', chord: 'Control+Alt+Shift+F9' },
  { id: 'char1', chord: 'Control+Alt+Shift+1' },
] });
eveCyno.hotkeys.onPressed(async ({ id }) => { /* focus a window */ });
```

- Chords are tokens joined by `+`, not case-sensitive: any of `Control` (or `Ctrl`), `Alt`, `Shift`, each at most once, then one key from F1 to
  F24, A to Z, 0 to 9 or Num0 to Num9. A letter or a top-row digit needs a modifier; an F key does not, and (1.0.0-beta.7) neither does a
  numpad key: `Num5` alone is a chord. `Super` and modifier-only chords are `invalid`.
- Num0 to Num9 are the keypad digits with NumLock on; the keypad's other keys (decimal point, operators, Enter) are not chord keys. A
  numpad chord fires with NumLock on; with NumLock off the key goes to the focused window (the game included) as its other meaning (an
  arrow, Home, End, PgUp, PgDn, Insert), on Windows and on Linux (X11) alike. On Windows `Shift` with a numpad key does not fire: with
  NumLock on, Windows turns Shift and a keypad digit into that other key. On the desktop's shortcut portal the host asks for `KP_<n>` and
  the desktop decides.
- On Linux, F13 to F24 often have no X keysym (evdev maps them to `XF86Tools` and similar keys): such a chord cannot be grabbed and comes
  back `os_refused` (or on the portal). Prefer F1 to F12, or letters and digits with modifiers.
- `register({ bindings })` replaces your whole set (at most 64, `too_large`; ids match `^[a-z][A-Za-z0-9.-]{0,63}$` and are unique, else
  `bad_params`). The answer has one result per binding: `ok`, or `reason` `taken` (another plugin holds the chord, or an earlier binding of the same call has it), `invalid`, `os_refused`
  (another program holds it, or nothing could grab it) or `unsupported`. `path` says how the host placed it: `x11` (a key grab) or `portal` on
  Linux, `win32` on Windows. On the portal path `register` can wait for the system's shortcut dialog, for minutes. A portal chord has `assigned: false` until the user gives it a key in the system's shortcut settings.
- `label` (1.0.0-beta.6, optional): the words the host's Settings page shows for the binding instead of its `id`; 1 to 40 characters (code
  points), not blank, with no control character (tab and newline included), no format character (bidi controls, zero-width characters
  such as the joiner inside emoji sequences, the soft hyphen, tag characters), no lone surrogate and no line or paragraph separator
  (Unicode categories Cc, Cf, Cs, Zl and Zp), else `bad_params`. Results do not carry it.
- `trigger` (1.29.0, optional): `'release'` fires once when the chord's key goes up again, `'press'` (the default) when it goes down. An `ok` result of a
  binding that sent it carries `trigger`, when it fires on this host: the desktop's shortcut portal fires a release binding on press. At most one `onPressed` per press; a key held longer than 10 s fires nothing.
- `list()` returns the last results; `clear()` releases everything. A chord you register again stays registered without a gap.
- Hotkeys belong to the main page (`register` is refused from an overlay page); a reload, crash or stop releases every chord, with no event.
- The host reads no other keystrokes and sends no input.

## Running in the background (1.0.0-beta.2)

The host closes the page of a plugin that has made no API call for 30 minutes and holds nothing (no overlay, slot, hotkey,
subscription or call in flight), and starts it again on its next use (a command, a service call). Your plugin's page is not kept
alive by its own network traffic, timers or computation. A plugin that has to keep running regardless declares it in
`plugin.json`:

```json
{ "background": true }
```

`background` is an optional boolean. Leave it out unless the plugin really works without ever calling the API.

From 1.9.0 (`^1.9`) a background plugin may also declare `"suspendUnderPressure": true` (refused without `background: true`). When the computer is short of memory the host then suspends the plugin once its view has been hidden for 30 minutes and it holds no overlay, thumbnail, hotkey, log, chat or clipboard subscription, file dialog, channel picker or service call in flight. Other plugins calling its services (between calls) and a windows subscription do not keep it alive, but a plugin that calls a suspended plugin's service starts it again, so a caller that probes it on a timer undoes the suspension; the next use starts it again, so keep nothing a restart cannot rebuild.

## Trying the OS capabilities

A test build of the host ships a fixture plugin that uses `windows`, `overlays`, `thumbnails` and `hotkeys` together:
`npm --prefix host run test:multiclient-demo` (`--test=multiclient-demo`) opens an overlay with a live slot and a chord for each client
in the window list (real EVE or the fake EVE; it fails with `no EVE clients` when the list stays empty) and stays open. It is an owner check mode, not a plugin you can install.
Flags: `EVECYNO_DEMO_HOTKEY_PATH=portal`, `EVECYNO_DEMO_OPACITY`, `EVECYNO_DEMO_BOUNDS=1`. It prints `DEMO_REFUSED <binding> <code>` for a refused chord and `DEMO_SLOT_ERR` for a refused slot.

Plugins never receive EVE game pixels and never inject input into the game client.

EVE Online and all related materials are the property of Fenris Creations. EVE-Cyno is not affiliated with Fenris Creations.

Questions and feedback: Discord https://discord.gg/XZzkH38dt9 or in-game `eve:Bythlak`.
