The app can load one plugin from a folder on your computer, so you can run your plugin while you write it. The folder is a trust
boundary: the app checks a folder plugin as it checks a plugin installed from an archive, and gives it nothing an installed plugin
would not get.

## Load a folder

1. Build the plugin. In a project made from the template, `npm run build` writes the plugin folder `dist/<your-id>/`.
2. In the main window open **Settings > Plugins**. Below the plugin list, switch on **Load a plugin from a folder**. It is off until
   you switch it on.
3. Press **Choose folder…** and pick the folder that holds `plugin.json`.

The folder name is free: the app reads the plugin id from `plugin.json`, not from the folder name. One folder is loaded at a time.
Choosing another folder unloads the plugin of the first one, and switching the setting off unloads it too.

These steps need your own click or key press in the main window. A plugin cannot switch the setting on, choose a folder or press
Reload: the plugin API has no method for any of them.

The plugin shows in the plugin list with the tag **From folder**. Its row has no uninstall action: switch the setting off or choose
another folder to unload it.

## Reload

While the setting is on, the app watches the folder and everything in it. After a change it waits until nothing has changed for
300 ms, then reads the folder again and starts the plugin again, so a build that writes many files causes one reload.

- **Reload**, next to the folder, reads the folder again at once.
- A reload reads everything again: `plugin.json`, `main` and every rule on this page. If the folder no longer passes, the plugin is
  unloaded. Fix it, and the next change in the folder, or Reload, loads it again.
- The template's build deletes `dist/<your-id>/` and writes it again. When the folder is deleted and made again, the watch can stop
  (Windows reports a deleted folder as an error). If a build does not show in the app, press Reload.

## When the folder does not load

The developer section shows one problem line:

| Problem | The line says | What to check |
|---|---|---|
| `id_taken` | Another plugin already uses this id | A built-in or installed plugin has this id. Give your plugin its own `id`. A folder plugin never replaces another plugin. |
| `not_loadable` | plugin.json cannot be loaded | `plugin.json` breaks a rule of the [plugin.json reference](@@manifest), the name rule below, or a file rule below. |
| `not_a_folder` | This is not a folder | The chosen path is a file, or the folder is gone. |

## What a folder plugin may do

A folder plugin is a plugin like any other: the same plugin API, the same call limit, and only the permissions you grant it.

- **Its permissions are asked as at an install.** The first load asks you for what its `plugin.json` asks for. Grants are kept by
  plugin id. Another folder, another id, or the setting switched off and on again is asked again, so a folder never runs on a grant
  you gave an earlier folder with the same id.
- **It runs with what you granted.** A reload whose `plugin.json` asks for more than you granted asks you again before the plugin
  gets it. See [Permissions and grants](@@permissions).
- **It keeps its data between reloads.** Storage is kept by plugin id, as for an installed plugin.

## What a folder plugin may not do

- **It is never a built-in plugin**, whatever its id. Data packs, the plugin database, chat logs for a plugin that can send data out,
  moving windows and Claude Code as an AI provider stay closed to it. [Permissions and grants](@@permissions) lists them.
- **It is never shown as a Marketplace plugin.** The app does not call it reviewed or signed.
- **It may not take an id that is in use** (`id_taken`), or an id that starts with `eve-cyno.host.`, which the app keeps for itself.
- **Its name and author follow the names rule.** A name may not be, or read like, a name the app uses itself (EVE-Cyno, Settings,
  Characters, Marketplace, Home), and neither name nor author may contain EVE-Cyno in any spelling. Look-alike letters count as the
  letters they look like.
- **No links.** The folder itself may not be a symbolic link. `plugin.json` and the `main` file must be plain files inside the
  folder: not a symbolic link (not even one that points inside the folder) and not a file with a second hard link. A file the page
  loads is served only when it is a plain file inside the folder, not a symbolic link and without a second hard link. On Windows a
  link or junction anywhere on its path is refused too. The template's build copies files one by one and refuses links, so a
  folder it writes has none.
- **A revoked version stays off.** A version the Marketplace revoked cannot be switched on, from a folder or from anywhere else.

## Examples

The template's `plugin.json` loads:

```json accept
{
  "id": "dev.example.my-plugin",
  "name": "My Plugin",
  "author": "Example Author",
  "version": "0.1.0",
  "engines": { "eve-cyno-api": "^1.29" },
  "main": "main.html",
  "permissions": {}
}
```

A name the app uses itself is refused:

```json refuse:reserved_name
{
  "id": "dev.example.my-plugin",
  "name": "Marketplace",
  "author": "Example Author",
  "version": "0.1.0",
  "engines": { "eve-cyno-api": "^1.29" },
  "main": "main.html"
}
```

So is an author that contains EVE-Cyno:

```json refuse:reserved_author
{
  "id": "dev.example.my-plugin",
  "name": "My Plugin",
  "author": "EVE Cyno fans",
  "version": "0.1.0",
  "engines": { "eve-cyno-api": "^1.29" },
  "main": "main.html"
}
```

And an id with the app's own prefix:

```json refuse:bad_manifest why:the_prefix_eve-cyno.host._is_reserved
{
  "id": "eve-cyno.host.my-plugin",
  "name": "My Plugin",
  "author": "Example Author",
  "version": "0.1.0",
  "engines": { "eve-cyno-api": "^1.29" },
  "main": "main.html"
}
```
