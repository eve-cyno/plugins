# {{name}}

{{description}}

A plugin for the EVE-Cyno desktop app, made with `@eve-cyno/create-plugin`. Plugin id: `{{id}}`.

The plugin asks for no permission, so the app shows no consent question for it and a review of it stays small. Add a permission to
`plugin.json` only when the plugin needs it, and describe it here.

## Licence

This project has no licence yet. Pick one before you publish it and add a `LICENSE` file and a `license` field to `package.json`. The
files in `types/eve-cyno-plugin-api/` are the API's own declarations, under the MIT licence in that folder.

## What is here

| Path | What |
|---|---|
| `plugin.json` | The manifest: id, name, version, the API range (`^1.29`), the main page, what the plugin contributes. |
| `src/main.ts` | The typed entry. It reads the `eveCyno` global the host injects and uses the theme, commands and tile namespaces. |
| `static/` | `main.html` and `style.css`: copied as they are into the plugin folder. |
| `types/eve-cyno-plugin-api/` | The plugin API's declarations (1.29.0). The API package is not on npm yet, so the project carries them. |
| `test/` | `node --test` tests of the manifest. Add yours here. |
| `entry/{{id}}.json` | The index entry stub: what the plugin's Marketplace listing says. |
| `scripts/` | The build, the archive, the entry and the check scripts the commands below run. |

## Commands

Run `npm install` once (it installs TypeScript only). Then:

- `npm run build` compiles `src/` with `tsc` and writes the plugin folder `dist/{{id}}/`: `plugin.json`, `static/*` and the compiled `main.js`.
- `npm test` runs the tests.
- `npm run pack` writes `dist/{{id}}-<version>.zip`, a stored zip that is the same bytes on every run, the file you attach to a release. It runs `npm run build` first, so the archive is always the current source.
- `npm run entry -- --url <https release URL of the zip>` fills `entry/{{id}}.json` with the archive's sha256 and size and copies `engines` and `permissions` from `plugin.json`.
- `npm run check -- --plugins <path to a clone of eve-cyno/plugins>` runs that repository's own checks on your entry and archive. It needs `npm ci` run once in that clone, and network access only when the entry declares `provenance`.

## Try it in the app

Open Settings > Plugins > Developer, turn the developer folder on and pick `dist/{{id}}/`. The app reloads the plugin each time the
folder changes, so `npm run build` is the whole loop.

## Submit it

The public index is not live yet, so there is nothing to submit to today. When it is, you open a pull request to `eve-cyno/plugins`
that adds `entries/{{id}}.json` (your filled-in entry) and nothing else; its checks and a review decide. Add your GitHub login to
`maintainers` in the entry first, and `provenance` if you build the archive in a public workflow.

## The API

The declarations are in `types/eve-cyno-plugin-api/index.d.ts`. Raise `engines.eve-cyno-api` in `plugin.json` only when you use a
feature that needs a newer minor; the app refuses a plugin whose range it does not satisfy.
