# EVE-Cyno plugin index: review policy

This repository is the public list of plugins and theme packages the EVE-Cyno desktop app can install from its Marketplace. The app
installs a plugin only when the user allows the permissions it asks for, and it runs every plugin in its own sandbox.

## Submitting

Open a pull request that adds or changes one file in `entries/`. The archive must be a release you publish (an `https:` link), named
in the entry by its SHA-256 and size. The automatic checks run on every pull request: the entry and the plugin's `plugin.json` against
the app's own rules, the archive's hash and size, the archive through the app's own archive reader, the permissions compared with the
previous version, and, when you declare it, the build provenance from your GitHub Actions.

## Human review

A maintainer reviews every new plugin and every version that asks for more permissions, runs in the background for the first time, or
changes its author, name or type, its provenance repository or its maintainers. A version that asks for nothing new is merged after
the checks pass and a maintainer has read the change.
A maintainer also reviews every version whose plugin.json sets `wasm: true`. Each WebAssembly file must be built from public source
named in the entry's `source`, with the build command in that source, and the plugin may compile only WebAssembly files inside its
archive, never bytes it downloads or receives.
There is no fixed review time.

## What we do not list

Plugins that automate gameplay, send one input to several game clients, read the screen or the game window, touch the game client, its
process or its memory, or go around the plugin API; anything against Fenris Creations' terms (client modification, botting,
real-money trading); plugins whose name or author reads as EVE-Cyno. Only the project's own entries may set `firstParty`, and only they may use that name or
author; a pull request from anyone else that sets `firstParty` or uses them is refused. An id that starts with `dev.evecyno.` is
refused unless its entry sets `firstParty`; only the project changes a `firstParty` entry, and a maintainer reads every change to one.

## Mirroring

By submitting an entry you allow EVE-Cyno to copy each listed archive, unchanged, to `plugins.eve-cyno.dev` and to serve it from there
to users of the app, for as long as the version is listed or installed. The app downloads archives only from that copy, never from
your server. The checks read a version already published from that copy too (against its SHA-256 and size); your link is needed while
a version is added.

## Revocation

We revoke a plugin version that breaks this policy or harms its users. The app turns it off at its next check (at most four hours
later, or at its next start) and keeps its data. Each revocation gives a one-line reason and a date.

## No accounts, no install counts, no ratings

Installing needs no account. This index keeps no install counts and no ratings.

## Private sources

A user can add another index (for example an alliance's), with the desktop app version that includes private sources. Plugins from
private sources are not reviewed by EVE-Cyno; the app names their source on every permission prompt.

## Feedback, support and reports

Discord <https://discord.gg/XZzkH38dt9>, or in game `eve:Bythlak`.

## Disclaimer

EVE Online and all related materials are the property of Fenris Creations. EVE-Cyno is not affiliated with Fenris Creations.
