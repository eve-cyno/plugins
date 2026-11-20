# SDK

Tools for people who write plugins for the EVE-Cyno desktop app. MIT licence (see `LICENSE`).

This directory holds, or will hold:

- `vendor/plugin-api/`: a pinned copy of the plugin API types and README from the desktop repository.
- `tools/vendor-api.mjs`: copies and checks that vendored copy.
- the docs site generator and the scaffold package (added in later commits).

## Vendored plugin API

`vendor/plugin-api/` is a byte copy of `packages/plugin-api` (types for the API version the vendored host speaks, README,
LICENSE, package.json) taken from the desktop commit and API version named in `../vendor/eve-cyno-host/MANIFEST.json`.
`vendor/plugin-api/PIN.json` records the commit, the version and a sha256 per file.

    node sdk/tools/vendor-api.mjs --desktop <desktop checkout>   # re-export after the host is re-vendored
    node sdk/tools/vendor-api.mjs --verify                        # offline: files match PIN.json and MANIFEST.json
    node sdk/tools/vendor-api.mjs --check --desktop <checkout>    # a fresh export equals the vendored files

Never edit a file under `vendor/plugin-api/` by hand. `--verify` fails if you do.

## Tests

    node --test sdk/test
