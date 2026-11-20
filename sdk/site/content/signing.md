The app trusts the plugin index because it is signed, not because of where it comes from. This page says what the app checks, in
order, and what that means for a plugin you submit.

<!-- not-live -->
> [!NOTE] The official index is not published yet
> This page describes how the app reads the index once it is. Until then the app has no plugin to offer from it.

<!-- /not-live -->
## The signed head

The index starts with a small file, the head `index.json`, and its minisign signature.

- The head is at most 16 KiB, and so is the signature.
- The signature's trusted comment is `eve-cyno-index v1 <generated>`, where `<generated>` is the head's own `generated` time. A
  signature made for another head does not verify this one.
- The app verifies the signature with the index keys it ships with, and reads no field of the head before that. A key that signs app
  releases never verifies an index.
- A head is valid until its `expires` time, at most 90 days after `generated`.
- **No rollback.** A head older than one the app has seen, or one with the same `generated` time and another catalog, is refused.

A head past its `expires` time is stale. The app still shows its plugins and still applies its revocations, but it installs nothing
from it. After a check that fails (a bad signature, a rollback, a broken or too large file) the app installs and updates nothing until
a head verifies again, after a restart too.

## The catalog, pinned by SHA-256

The head names the catalog by its size and SHA-256, at `catalog/<sha256>.json`. The catalog is at most 4 MiB and is not signed on
its own: the app checks its size and SHA-256 against the verified head before it reads one byte of it. A catalog that is not the one
the head names is refused.

The catalog holds every listing (each listed version with its archive's SHA-256 and size) and every revocation. A malformed
revocation refuses the whole index. One malformed listing is dropped and counted, so one bad entry cannot hide the other plugins or a
revocation.

For your plugin this means: what the app installs is the archive your entry pinned, byte for byte. Nobody can change it after the
head is signed without a new signature.

## The archive mirror

Every archive URL in the catalog is its mirror name, `archives/<sha256>.zip`, under the index's own address (check C9). The app
downloads archives only from there, never from your server. It checks the size (at most 32 MiB) and the SHA-256 against the catalog,
then reads the archive as [Archive rules](@@packaging) says.

Your release URL is read while a version is added: check C4 downloads it, and C5 compares it with the entry. A version number, once
merged, never comes back with other bytes (check C8), so publish a fix as a new version.

## When the app checks

The app checks the index when it starts and then every 4 hours after each check ends. After a check whose signature or catalog did
not verify, it tries once more 10 minutes later. With **Check for updates** switched off in the app, it sends no index request at all.

## Revocation and lift

A revocation names a plugin id, the versions (a list, or `*` for every version), a reason of at most 200 characters and a date
(`YYYY-MM-DD`). Revocations are kept in `revoked.json` in the index repository. One added in a pull request is dated that day or the
day before (UTC), and a maintainer reads it before it is merged (the `revocation` class).

- The app applies a revocation by plugin id to every copy of that plugin: from the Marketplace, from a file, from a folder, built in
  or from a private source.
- A revoked version is turned off and cannot be switched on. It stays installed with its data: the app deletes nothing of it. The
  user gets one notice for each id and version.
- A revocation that names `*` covers every version, a new one too. A revocation that names versions covers only those: publish a
  fixed version, and a maintainer reads it before it is listed (the `revoked` class).
- **Lift.** A revocation is lifted when a pull request removes it from `revoked.json` (the `lift` class) and the next signed index no
  longer names it. The app lifts it at its next check of a head that verifies and has not expired. A stale index, a failed check or
  a rollback never lifts one.

## Private sources

A user can add another plugin index, for example an alliance's, in Settings > Plugins. It is read with the same checks as the
official one: the signed head, the catalog pinned by SHA-256, the same archive rules.

- The user pastes one or two minisign public keys when adding the source. The app never fetches a key from the source.
- The index URL is https, ends in `/index.json`, and is not `eve-cyno.dev` or a name under it.
- EVE-Cyno does not review plugins from a private source. Every install and update prompt names the source and says it is not
  reviewed.
- A plugin from a private source is never first-party, and it updates only from the source it was installed from. An id that is
  installed from another index is `id_taken`.
- The official index's revocations reach every plugin, a private source's included. A private source's revocations reach only the
  plugins installed from it.
