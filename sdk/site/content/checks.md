The plugin index runs its checks on every entry pull request, with the app's own code for everything the app also checks. You can
run the same checks on your machine before you open the pull request.

<!-- not-live -->
> [!NOTE] Submissions are not open yet
> The index takes no entries yet. The checks already run on your machine, so a plugin you check now is ready when it opens.

<!-- /not-live -->
## Two runs

- **refuse** fails the pull request on any FAIL line. It ends with `CHECKS PASSED` or `CHECKS FAILED <n>`.
- **review** sets the review classes below. A class does not refuse anything: it holds the pull request for a maintainer to read.
  It ends with `NEEDS REVIEW <classes>` or `NO REVIEW NEEDED`.

Every line of the output is a PASS, FAIL, FLAG or NOTE line that names its check id.

## What each check does

| Check | Run | What it checks |
|---|---|---|
| C1 | refuse | The entry file has the shape of the entry schema and of the app's own listing rules: known categories, versions newest first, every URL canonical https with no user name, query or fragment. `entries/` holds only `<id>.json` files. |
| C2 | refuse | The file is named `<id>.json`. The id follows the plugin id rule, does not start with `eve-cyno.host.`, does not start with a Windows device name, and no other entry has it. |
| C3 | refuse, review | Names: a reserved name or author, and a new or renamed entry whose name reads like another entry's name, are refused. Sets the `first-party` class. |
| C4 | refuse | The download from your URL: https on the default port, no user name or query, at most 5 redirects (each https), public addresses only, at most 32 MiB, no content coding, ended after 60 s without progress or 600 s in all. |
| C5 | refuse | The download's size and SHA-256 equal the ones the entry pins. |
| C6 | refuse | The app's zip reader accepts the archive: see [Archive rules](@@packaging). |
| C7 | refuse | The app's install checks on the unpacked archive: `plugin.json` at the root, the manifest parser, the listing equal to `plugin.json`, the loader's folder checks. |
| C8 | refuse | Version rules: valid versions, newest first; a merged version never changes and is never removed (it can be marked `"unlisted": true`); an added version is listed and higher than every merged one. |
| C9 | refuse | Every archive URL of the catalog built from the entries is its mirror name, `archives/<sha256>.zip`. |
| C10 | review | Sets `escalation` and `identity`. |
| C11 | review | Sets `new`. |
| C12 | refuse | Provenance, when the entry declares it: `gh attestation verify` binds the archive to the repository the entry names. |
| C13 | review | Sets `maintenance` and `multi-entry`. |
| C14 | review | Sets `identity` when the author of the pull request is not a maintainer of an entry it changes or removes. |
| C15 | refuse, review | `revoked.json` follows the app's rules, and a revocation added in the pull request is dated today or yesterday (UTC). Sets `revocation`, `lift` and `revoked`. |
| C16 | refuse | The whole index builds, is signed with a key made for the run and thrown away, and verifies with the app's own index verifier. |
| C17 | review | Sets `engines`. |

## What sets a review class

| Class | Set by | When |
|---|---|---|
| `new` | C11 | The entry is new: the index has no plugin with this id yet. |
| `escalation` | C10 | An added version asks for more than the version before it, turns `background` on, or has no lower version to compare with. Only the required permissions are compared; the app asks for an optional item when the plugin requests it. |
| `identity` | C10, C14 | The name, author or type changed, the provenance repository changed or was dropped, the maintainers changed, or the author of the pull request is not one of them. |
| `first-party` | C3 | The entry's `firstParty` flag changed. |
| `engines` | C17 | An added version's `engines` range does not reach the major API version of the current app. |
| `maintenance` | C13 | The pull request changes a file other than `entries/<id>.json` and `revoked.json`. |
| `multi-entry` | C13 | The pull request changes more than one entry file. |
| `revocation` | C15 | A revocation is added or changed. |
| `lift` | C15 | A revocation is removed. |
| `revoked` | C15 | A version is added to an id that `revoked.json` names. |

## Run them on your machine

In a project made from the template:

1. Clone the index repository (`eve-cyno/plugins`) once and run `npm ci` in the clone.
2. `npm run pack` writes the archive.
3. `npm run entry -- --url <release URL>` pins the archive's SHA-256 and size in `entry/<id>.json`. The URL is where the archive will
   be published; nothing is downloaded.
4. `npm run check -- --plugins <clone>` runs the clone's checks, refuse and then review, on your entry and archive.

The command builds a temporary index repository that holds your entry as a new plugin and reads the archive from your `dist/`
folder, with no mirror. It ends with `the index checks pass` and the review classes a maintainer will read: a new plugin is always
`new`, so the line says `a maintainer reviews it: new`. It exits 0 when refuse passes, 1 when the index refuses the entry or the
archive or a run fails, and 2 on a usage error.

Some checks run in full only on the pull request:

- **C4** downloads from your URL there. On your machine the archive comes from `dist/`, so only its size and SHA-256 are checked (C5).
- **C12** needs the network on your machine too: `gh attestation verify` reads the attestations from GitHub.
- **C14** needs the login of the pull request's author, so it is not run on your machine.
- **C8** and **C10** compare an update with the versions already merged. On your machine the entry is always new, so only the rules
  within the entry run.
