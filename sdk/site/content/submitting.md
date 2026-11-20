<!-- not-live -->
> [!WARNING] Nothing can be submitted yet
> The public plugin index is not published. This page describes the pull request you will open when it is, so you can prepare the files today. The checks below already run on your own machine.
<!-- /not-live -->

## Prepare the entry in your project

A plugin made with the template has everything the entry needs. From the project folder:

1. `npm run pack` builds the plugin and writes `dist/<id>-<version>.zip`, the release archive. The same files give the same bytes on every run. Attach the file to a release you publish at an `https:` URL you control.
2. `npm run entry -- --url <the https URL of that archive>` fills `entry/<id>.json` with the archive's SHA-256 and size and copies `engines` and `permissions` from `plugin.json`, so they match the archive as the rules below require. It adds your version at the top of `versions` when the entry does not list it yet, with an empty `changes` for you to fill in.
3. Add your GitHub login to `maintainers` in the entry. Add `provenance` too if you build the archive in a public workflow, as the generated `README.md` says.

The file in your project is `entry/<id>.json`. In the index repository the same file is `entries/<id>.json` (the folder is plural there), and that one file is your whole pull request.

## Run the index checks on your own machine

The index repository runs checks on every pull request (see [Checks](@@checks)). You can run the same checks on your entry and archive before you open it. Clone `eve-cyno/plugins`, run `npm ci` once inside the clone, then run this in your project:

`npm run check -- --plugins <path to the clone>`

The script copies your entry and archive into a temporary tree and runs the clone's own `tools/check.mjs` in `refuse` mode (entry shape, id and names, version rules, the archive read by the app's own archive reader) and in `review` mode (which review classes a maintainer would read). Nothing is downloaded: the archive comes from your `dist/` folder. The one exception is an entry that declares `provenance`, which needs the network. It exits 0 when the index would not refuse the entry; a new plugin is always held for a maintainer's review, and the output names the class.

Do not run `npm ci` and `npm test` in the index clone to check your plugin: those commands run the index repository's own tests, not your plugin.

The text below is the repository's `CONTRIBUTING.md`, shown here as it is, apart from its section about running the repository's tests.

