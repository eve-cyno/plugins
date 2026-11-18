# Contributing

## Add or update a plugin

1. Publish a release archive (`.zip`) at an `https:` URL you control. Note its SHA-256 and size in bytes.
2. Add or edit `entries/<id>.json`, where `<id>` is the plugin id. Add a new version at the top of `versions`; never change the
   `url`, `sha256` or `size` of a version that is already merged.
3. Never remove a merged version, and never remove a merged entry. To take a version out of the Marketplace, add `"unlisted": true`
   to it: it leaves the catalog but stays in the entry with its `url`, `sha256` and `size`, so its version number can never come
   back with other bytes. An unlisted version stays unlisted; publish a new version instead. A version is listed when it is added.
   An entry lists at most 50 versions and holds at most 200 in all.
4. Declare `engines` and `permissions` exactly as in the archive's `plugin.json`.
5. Open a pull request and fill in the template.
6. The automatic checks run on the pull request. A maintainer reviews it; there is no fixed review time.

## Rules

- One entry file per pull request.
- No accounts, install counts or ratings.
- Plugins that automate gameplay, touch the game client or break Fenris Creations' terms are not listed.
- By submitting an entry you allow EVE-Cyno to copy each listed archive, unchanged, to its mirror and serve it to users of the app.

## Run the checks locally

```sh
npm ci
npm test
```

## Contact

Discord <https://discord.gg/XZzkH38dt9>, or in game `eve:Bythlak`.
