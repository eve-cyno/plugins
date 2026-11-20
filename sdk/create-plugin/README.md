# @eve-cyno/create-plugin

Generates a working EVE-Cyno desktop plugin project: the manifest, a typed entry, a build, a test and the index entry stub. The
package is MIT.

```
npm create @eve-cyno/plugin@latest [dir] -- [--id <id>] [--name <name>] [--author <author>] [--yes]
```

Or from a checkout of this repository:

```
node sdk/create-plugin/bin/create-plugin.mjs [dir] [--id <id>] [--name <name>] [--author <author>] [--description <text>] [--yes]
```

It asks for what is missing (id, name, author, description) unless `--yes` is given; `--yes` needs `--id` and `--author`. The folder
defaults to the last segment of the id, the name to that segment in title case. `--version` prints the scaffold version and the plugin
API version it bundles (1.29.0).

## What it refuses

It writes nothing and exits 1 when:

- the target folder exists and is not empty;
- the id does not match the host's rule (lower-case dotted words, three or more, at most 100 characters), starts with
  `eve-cyno.host.`, starts with a Windows device name (`con`, `nul`, `com1` and the like) or contains the host's name (`eve-cyno`);
- the name or author is not valid display text (1 to 60 characters, no control or invisible characters) or reads as the host
  (`EVE-Cyno`, `Settings`, `Characters`, `Marketplace`, `Home`);
- the description is empty or longer than 120 characters (it is the index summary too).

`lib/rules.mjs` copies these rules; `test/generate.test.mjs` holds them to the vendored host. One gap: the host also folds
look-alike letters (Cyrillic and the like) with a large table that this package does not carry, so a name spelled that way passes
here and is refused by the host later.

The same answers give the same bytes: nothing in the output depends on the clock or the machine.

## What it writes

`plugin.json` (no permission, API range `^1.29`, one command and the tile action that runs it), `package.json` (private, TypeScript
7.0.2 as the only dev dependency, scripts `build`, `test`, `pack`, `entry`, `check`), `tsconfig.json`, `src/main.ts`, `static/main.html`,
`static/style.css`, `test/manifest.test.mjs`, `entry/<id>.json`, a README for the new project, `.gitignore`, and
`types/eve-cyno-plugin-api/` (the API's declarations and licence, copied from `sdk/vendor/plugin-api`).

The API package is not on npm, so the project carries its declarations and maps `@eve-cyno/plugin-api` to them in `tsconfig.json`. When
the package is published, replace the `paths` entry with a dev dependency and delete `types/`.

## Licences

The package is MIT (`LICENSE`). The files it writes into a new project are MIT-0 ("MIT No Attribution"): they need no notice. It
writes no `LICENSE` file at the project root (a licence file names its copyright holder, and the project is the author's); the generated
`package.json` has no `license` field, and the generated README states MIT-0 and asks the author to add a `LICENSE` file and a `license` field with the licence picked. The bundled
declarations keep their MIT licence. Nothing from `vendor/eve-cyno-host` (PolyForm Strict) is in the package; the tests read it from
the repository.

## Tests

From `sdk/` (the repository root needs `npm ci` first, for the vendored host's dependencies):

```
node --test "create-plugin/test/**/*.test.mjs"
```

## Versions

The scaffold has its own semver, `1.0.0` at the first publish. A new plugin API minor means re-vendoring `sdk/vendor/plugin-api`,
copying the declarations into `template/types/`, raising `eveCynoApi` here and `engines` in `template/plugin.json`, and a minor bump of
this package.
