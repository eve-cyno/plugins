This page walks through the plugin that `create-plugin` writes, with the answers `dev.example.my-plugin`, `My Plugin` and `Example Author`. The code blocks further down are read from the template when the docs are built, so they are what the scaffold really writes. Your own id, name, author and description take the place of the example ones. If you have not made a plugin yet, start with [Getting started](@@start).

## How the files fit together

You write TypeScript in `src/`, a page in `static/` and a manifest. `npm run build` compiles `src/` with `tsc` into `build/`, then copies the manifest, everything in `static/` and everything in `build/` into one folder, `dist/<your-id>/`. That folder is the plugin: it is what you load in Settings > Plugins > Developer, and what `npm run pack` zips. The build stops with a message when `plugin.json` has no valid id, when `main` is not a file of the folder, or when a file name comes from both `static/` and `build/`.

## plugin.json

The [manifest](#file-plugin-json) names the plugin and says what it needs.

- `id`, `name`, `author` and `version` identify the plugin. The id is checked against the app's id rule when the app loads the folder.
- `engines` is `{ "eve-cyno-api": "^1.29" }`. The app refuses a plugin whose range it does not satisfy, with `incompatible_api`. The template asks for the API version its bundled types describe; lower it only if you use nothing that came after, and raise it when you use a newer feature. [What each version added](@@api/versions) lists the minors.
- `main` is the page the app opens, relative to the plugin folder: `main.html`, which comes from `static/`.
- `activationEvents` is `["onStartup"]`: the plugin loads when the app starts.
- `permissions` is empty. The plugin asks for nothing, so the app shows no consent question for it. When you need a feature that is behind a permission, add the key here. [Permissions and grants](@@permissions) lists them.
- `contributes` is where a plugin adds things to the app. The template declares one command, `say-hello`, and a tile action that runs it. [plugin.json](@@manifest) lists the other keys (settings, services and more).

## src/main.ts

The [entry](#file-src-main-ts) is the plugin's script, loaded by the page.

- It takes the `eveCyno` global the app injects into every plugin page. The line `import type { EveCyno, ThemeInfo } from '@eve-cyno/plugin-api'` brings in types only, so nothing from the API package is bundled and the page needs no runtime dependency. `tsconfig.json` maps `@eve-cyno/plugin-api` to the declarations in `types/eve-cyno-plugin-api/`, because the API package is not on npm.
- `eveCyno.theme.get()` returns the app's colours and corner radius, and `theme.onChanged` runs again when the user changes the theme. The plugin page gets no CSS from the app, so `applyTheme` copies the colours into CSS variables that `static/style.css` uses.
- `eveCyno.commands.onCommand` runs when the user starts a command the manifest declares, from the tile button or the command palette. The handler checks `command.id` against `say-hello`.
- `eveCyno.tile.setSummary({ title, lines })` sets the text on the plugin's tile in the app.

Every call to the API counts against the plugin's call budget of 100 calls, refilled at 100 a second. The tutorial plugin makes a handful.

## static/main.html and static/style.css

The [page](#file-static-main-html) holds a heading, the description, a button and a status line. It loads `main.js`, the compiled `src/main.ts`, as a module. Both [static files](#file-static-style-css) are copied as they are.

## package.json and tsconfig.json

The [package file](#file-package-json) is private, has no `license` field and one dev dependency, TypeScript. Its scripts are the ones in [Getting started](@@start): `build`, `test`, `pack`, `entry` and `check`. Pick a licence for your plugin before you share it. The [TypeScript config](#file-tsconfig-json) compiles `src/` into `build/` for the browser, in strict mode, with no ambient types.

## test/manifest.test.mjs

The [test](#file-test-manifest-test-mjs) runs with `npm test` (`node --test`). It checks the things the README of the generated project promises: the id is not the app's, the manifest version equals the package version and the entry stub's, the API range, no permission, `main` and its files exist, and the tile action names a declared command. Keep it in step when you change the manifest, and add tests of your own next to it.

## entry/&lt;id&gt;.json

The [entry stub](#file-entry-dev-example-my-plugin-json) is what the plugin's listing in the Marketplace index would say. It is a stub: its `url`, `sha256`, `size` and `released` are placeholders until you run `npm run pack` and then `npm run entry -- --url <the https URL of your release archive>`, which fills them from the archive and copies `engines` and `permissions` from `plugin.json`. Add your GitHub login to `maintainers` before you submit. [Submitting a plugin](@@submitting) explains the pull request.

## Files below

Each file is shown as the template writes it.
