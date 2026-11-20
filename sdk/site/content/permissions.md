A plugin runs with what the user granted, never with what its `plugin.json` asks for. The manifest's `permissions` list what the
plugin asks for. The app shows them in the permission prompt, and the plugin gets only what the user allows. A namespace of the
plugin API exists only when its permission is granted, so a plugin finds out what it has by looking for the namespace.

## How consent works

- **At install** the prompt lists every item the plugin asks for. A required item the user refuses keeps the plugin off. An
  optional item (below) has its own switch, and the plugin runs without it.
- **At an update** the app compares what the new version asks for with what the user granted. A version that asks for more, or that
  turns `background` on, is not applied by itself: the user reviews it and can keep the old version.
- **Later**, the user can take parts of a grant back. Every change restarts the plugin's page, so keep nothing in the page that a
  restart cannot rebuild.

Settings > Privacy can take back these parts one at a time: `characters`, `esi`, `network`, `ai`, `gamelogs`, `chatlogs`, `gameEvents`, `background`, `services`.

`gamelogs` and `chatlogs` are the two values of `logs`. The clipboard has a switch of its own there, and so does each optional item.
The other permissions stay as granted while the plugin is installed.

## What each permission unlocks

| Key | Unlocks | Notes |
|---|---|---|
| `characters` | `characters` | `selected` or `all`. `esi` and the game logs need it. |
| `esi` | `esi` | Registered ESI scopes, at most 64. Needs `characters` set to `selected` or `all`. |
| `logs` | `logs`, `chat` | `gamelogs` gives `logs` and needs `characters`. `chatlogs` gives `chat`, to a built-in plugin or to a plugin that cannot send data out (below). |
| `clipboard` | `clipboard` | `["read"]`. |
| `network` | the page's network, `dataapi` | The https origins the page may reach, at most 32. Never a shared host (below). The origin `https://data.eve-cyno.dev` also gives `dataapi`. |
| `overlays` | `overlays`, `windows` | |
| `hotkeys` | `hotkeys`, `windows` | |
| `windowThumbnails` | `thumbnails`, `windows` | |
| `windows` | `windows` | The list of EVE windows. Moving them (`windows.setBounds`) is for built-in plugins only on a 1.29.0 app. |
| `notifications` | `notifications` | |
| `account` | `account` | Reserved: the namespace has no method yet. |
| `ai` | `ai` | Claude Code answers built-in plugins only. |
| `files` | `files` | |
| `fit` | `fit` | The fitting engine on this computer. No data leaves it. |
| `gameEvents` | `gamelog` | `combat`, `ewar`, `mining`, `notice`. Needs no `characters`. |
| `data` | `data` | Built-in plugins only (below). |
| `storage` | `storage` | `storage` is always there. `quotaMB` from 1 to 20 sets its size; the default is 5 MB, and more than 5 asks the user. |
| `database` | `db` | Built-in plugins only (below). |
| `services` | `services` | The interfaces the plugin calls, each with a major range such as `^1`. A plugin that only provides services (`contributes.services`) gets `services` without it. |
| `optional` | `permissions` | Optional items: `esi`, `network`, `clipboard` and `notifications`. Needs `^1.17` or later. |

`background` is not a permission key but a top-level field of `plugin.json`: the plugin keeps running with no view open. A plugin
that is not built in asks the user for it as for a permission, and the user can take it back.

## Optional items

`permissions.optional` lists items the plugin can work without, in the shapes of the required part: `esi` scopes, `network` origins,
`clipboard: ["read"]` and `notifications: true`. The prompt shows each with a switch, on by default. The plugin reads what it got with
`eveCyno.permissions.get()` and asks again with `eveCyno.permissions.request(items)`, from a user's click in its main page. The
[plugin.json reference](@@manifest) has the whole rule.

## Plugins that can send data out

A plugin can send data out when it has a `network` origin, calls a service, provides one (`contributes.services`), or has `ai` or
`account`. Optional items count, switched on or off. Such a plugin:

- gets no `chat`, even when it asks for `chatlogs`. The app drops `chatlogs` from its request, so the prompt does not ask for it;
- sees no character name on an EVE window (`WindowInfo.character`) and no class on another program's window (`windowClass`).

A plugin with none of these keeps the chat logs and the names on this computer, which is why it may have them.

## Shared hosts

A `network` origin on a host that anyone can post to would let a plugin send data to a place its author does not control. The app
refuses these hosts, and every name under them, in `network` and `optional.network` (`shared_host`).

The shared hosts are `discord.com`, `discordapp.com`, `hooks.slack.com`, `api.telegram.org`, `webhook.site`, `pastebin.com`, `gist.github.com`, `api.github.com`.

## What only built-in plugins get

A built-in plugin is one that comes with the app. A plugin that comes from the Marketplace, from a file or from a folder is never
built in, whatever its id.

- **`permissions.data`** (data packs): refused (`bad_manifest`) for every id that is not on the list at the end of this page.
- **`permissions.database`**: accepted, but for any other plugin the field is ignored. There is no prompt line, no grant and no `db`
  namespace, and `host.capabilities().features.db` is false.
- **`chatlogs` with a way to send data out** (above): dropped from the request.
- **Moving windows**: `windows.setBounds` is `not_permitted` for any other plugin on a 1.29.0 app.
- **Claude Code as an AI provider**: it answers built-in plugins only. Another plugin never gets it among its providers.

## Examples

A plugin that reaches its own server and shows notifications:

```json accept
{
  "id": "dev.example.my-plugin",
  "name": "My Plugin",
  "author": "Example Author",
  "version": "0.1.0",
  "engines": { "eve-cyno-api": "^1.29" },
  "main": "main.html",
  "permissions": { "network": ["https://api.example.com"], "notifications": true }
}
```

A shared host:

```json refuse:shared_host why:shared_host_refused
{
  "id": "dev.example.my-plugin",
  "name": "My Plugin",
  "version": "0.1.0",
  "engines": { "eve-cyno-api": "^1.29" },
  "main": "main.html",
  "permissions": { "network": ["https://discord.com"] }
}
```

An origin that is not https:

```json refuse:bad_manifest why:only_https_origins_are_allowed
{
  "id": "dev.example.my-plugin",
  "name": "My Plugin",
  "version": "0.1.0",
  "engines": { "eve-cyno-api": "^1.29" },
  "main": "main.html",
  "permissions": { "network": ["http://api.example.com"] }
}
```

An origin with a path:

```json refuse:bad_manifest why:path,_query_and_fragment_are_not_allowed
{
  "id": "dev.example.my-plugin",
  "name": "My Plugin",
  "version": "0.1.0",
  "engines": { "eve-cyno-api": "^1.29" },
  "main": "main.html",
  "permissions": { "network": ["https://api.example.com/v1"] }
}
```

ESI scopes without characters:

```json refuse:bad_manifest why:needs_permissions.characters
{
  "id": "dev.example.my-plugin",
  "name": "My Plugin",
  "version": "0.1.0",
  "engines": { "eve-cyno-api": "^1.29" },
  "main": "main.html",
  "permissions": { "esi": ["esi-skills.read_skills.v1"] }
}
```

A data pack for a plugin that is not built in:

```json refuse:bad_manifest why:reserved_for_built-in_plugins
{
  "id": "dev.example.my-plugin",
  "name": "My Plugin",
  "version": "0.1.0",
  "engines": { "eve-cyno-api": "^1.29" },
  "main": "main.html",
  "permissions": { "data": ["sde.universe"] }
}
```

Optional items need `^1.17` or later:

```json refuse:bad_manifest why:1.17
{
  "id": "dev.example.my-plugin",
  "name": "My Plugin",
  "version": "0.1.0",
  "engines": { "eve-cyno-api": "^1.16" },
  "main": "main.html",
  "permissions": { "optional": { "network": ["https://api.example.com"] } }
}
```

With `^1.29` the same items are accepted:

```json accept
{
  "id": "dev.example.my-plugin",
  "name": "My Plugin",
  "author": "Example Author",
  "version": "0.1.0",
  "engines": { "eve-cyno-api": "^1.29" },
  "main": "main.html",
  "permissions": {
    "characters": "selected",
    "esi": ["esi-skills.read_skills.v1"],
    "optional": { "network": ["https://api.example.com"], "notifications": true }
  }
}
```

A database: the manifest is accepted, and a plugin that is not built in gets no database:

```json accept ignored:database
{
  "id": "dev.example.my-plugin",
  "name": "My Plugin",
  "author": "Example Author",
  "version": "0.1.0",
  "engines": { "eve-cyno-api": "^1.29" },
  "main": "main.html",
  "permissions": { "database": { "quotaMB": 50 } }
}
```

Chat logs and a network origin: accepted, and a plugin that is not built in is not asked for the chat logs:

```json accept ignored:chatlogs
{
  "id": "dev.example.my-plugin",
  "name": "My Plugin",
  "author": "Example Author",
  "version": "0.1.0",
  "engines": { "eve-cyno-api": "^1.29" },
  "main": "main.html",
  "permissions": { "logs": ["chatlogs"], "network": ["https://api.example.com"] }
}
```

Chat logs and no way to send data out: the user is asked for them:

```json accept kept:chatlogs
{
  "id": "dev.example.my-plugin",
  "name": "My Plugin",
  "author": "Example Author",
  "version": "0.1.0",
  "engines": { "eve-cyno-api": "^1.29" },
  "main": "main.html",
  "permissions": { "logs": ["chatlogs"] }
}
```
