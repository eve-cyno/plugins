# SDK

Tools for people who write plugins for the EVE-Cyno desktop app: the plugin docs site, the scaffold that creates a plugin project,
and a pinned copy of the plugin API. MIT licence (see `LICENSE`).

Everything here needs Node 22.2 or newer. The site build needs nothing else. For the tests, run `npm ci` once at the repository root
(the vendored host code the tests run needs its dependencies) and once in `sdk/`, which installs TypeScript 7.0.2, the version a
generated project builds with. That puts it in the npm cache, which the scaffold test installs it from, offline.

## What is here

- `vendor/plugin-api/`: a pinned copy of the plugin API types and README from the desktop repository.
- `tools/vendor-api.mjs`: copies and checks that vendored copy.
- `create-plugin/`: the scaffold package `@eve-cyno/create-plugin` and its template (see `create-plugin/README.md`).
- `site/`: the docs site generator (`site/build.mjs`, `site/lib/`), the hand-written page text (`site/content/<slug>.md`), the
  pinned design snapshot and its assets (`site/design/`, pinned in `site/design/PINS.md`), the self-hosted fonts (`site/assets/fonts/`, OFL
  1.1, pinned with their licences in `FONTS.md` there) and the site's tests.
- `test/`: the tests of the vendoring tool and of this package.

## Docs site

From `sdk/`:

    node site/build.mjs [--out <dir>] [--base /plugins/] [--index-live]

`npm run build:site` is the same with no options: it writes the static site to `site/dist/`, the pages under `site/dist/plugins/`.
The generator has no dependency. It reads the vendored API declarations and README, the vendored host's manifest schema, the
repository's `POLICY.md`, `CONTRIBUTING.md`, entry schema and check tools, and the scaffold's template, so a page that repeats a
rule, a limit or a generated file is built from the code that has it. `--index-live` (or `INDEX_LIVE=true`) draws the "Marketplace
is open" banner on every page; it is off by default, because the public index is not published and no page may say it is.

## Scaffold

    node sdk/create-plugin/bin/create-plugin.mjs [dir] [--id <id>] [--name <name>] [--author <author>] [--description <text>] [--yes]

It writes a working plugin project: the manifest, a typed entry, a build, a test, the pack, entry and check scripts, and the index
entry stub. The package is private and not on npm yet, so `npm create @eve-cyno/plugin` does not work today. `create-plugin/README.md`
lists what it refuses and what it writes.

## Vendored plugin API

`vendor/plugin-api/` is a byte copy of `packages/plugin-api` (types for the API version the vendored host speaks, README,
LICENSE, package.json) taken from the desktop commit and API version named in `../vendor/eve-cyno-host/MANIFEST.json`.
`vendor/plugin-api/PIN.json` records the commit, the version and a sha256 per file.

    node sdk/tools/vendor-api.mjs --desktop <desktop checkout>   # re-export after the host is re-vendored
    node sdk/tools/vendor-api.mjs --verify                        # offline: files match PIN.json and MANIFEST.json
    node sdk/tools/vendor-api.mjs --check --desktop <checkout>    # a fresh export equals the vendored files

Never edit a file under `vendor/plugin-api/` by hand. `--verify` fails if you do.

## Tests

From `sdk/`:

    npm test

It runs `node --test` on `site/test/`, `create-plugin/test/` and `test/`: the site build and every page's sources, the scaffold
(including an end-to-end run of a generated project: install, build, test, pack, entry and the index checks) and the vendoring
tool. The end-to-end scaffold test is skipped, with a message, only on a machine whose npm cache has no TypeScript 7.0.2 and where
`npm ci` was not run in `sdk/`.
