A plugin is published as one `.zip` archive. The app reads it with its own zip reader, unpacks it into a fresh folder and checks the
folder as it checks a folder plugin, all before the install prompt shows. The index checks C6 and C7 run the same code on every
version you submit, so an archive that passes `npm run check` passes the app's install checks too.

## Make the archive

In a project made from the template, `npm run pack` builds the plugin and writes `dist/<id>-<version>.zip`. It stores the files
uncompressed, in name order and with a fixed time, so the same files give the same bytes on every run and every machine. It refuses
a folder with a link, an empty folder or a name that is not plain, and stops at the limits below.

If you make the archive with another tool, follow the rules on this page.

## Layout

`plugin.json` sits at the root of the archive: zip the content of the plugin folder, not the folder.

```zip accept
plugin.json
main.html
main.js
static/icon.svg
```

An archive that holds the folder has no `plugin.json` at its root. The installer refuses it with the code `archive`:

```zip refuse:archive
my-plugin/plugin.json
my-plugin/main.html
my-plugin/main.js
```

## Limits

| Limit | Value |
|---|---|
| Entries | at most 2000 entries, files and folders together |
| Unpacked size | at most 64 MiB, all entries together |
| Archive file | at most 32 MiB |
| Compression of one entry | at most 100 times: an entry may not unpack to more than 100 times its stored size |
| Path length | at most 200 characters |
| Folder depth | at most 16 names in one path, the file name included |
| One name in a path | at most 255 bytes in UTF-8, which a name with non-ASCII letters can reach before the path limit |

Entries are stored or deflated, nothing else. The reader refuses encryption, zip64, links, entries that are neither a file nor a
folder, and an archive with bytes that no entry accounts for. A stored entry written for streaming, with its sizes after the data,
is refused too (`method`): some tools write that shape when the archive goes to a pipe.

The template stores files without compression, so the compression limit never applies to its archives. A deflated entry of very
repetitive data, such as a large file of zeros, can pass 100 times and is refused (`ratio`).

## Names

Every entry name must work on both Windows and Linux. The reader refuses the whole archive (`bad_name`) for one name that breaks a
rule:

- `/` separates folders. No `\`, no name that starts with `/` or with a drive such as `C:`.
- No control characters and none of `<`, `>`, `:`, `"`, `|`, `?`, `*`.
- No empty name between two `/`, no `.` or `..`, and no name that ends in a dot or a space.
- No Windows device name (`CON`, `PRN`, `AUX`, `NUL`, `COM0` to `COM9`, `LPT0` to `LPT9` and the rest), with or without an
  extension: `nul.txt` is refused too.
- A name that is not plain ASCII needs the zip's UTF-8 flag.

Two names that differ only in case are one file on Windows, so they are refused (`duplicate`).

```zip refuse:bad_name
plugin.json
main.html
../main.js
```

```zip refuse:bad_name
plugin.json
main.html
static\icon.svg
```

```zip refuse:duplicate
plugin.json
main.html
main.js
Main.js
```

## The listing must match plugin.json

Your entry in the index describes each version: the listing the app shows before an install. The installer compares the listing with
the archive's `plugin.json` and refuses the install (`listing_mismatch`) on the first field that differs.

The listing repeats these fields, and each must equal the archive's: `id`, `version`, `name`, `author`, `engines`, `permissions`.

`engines` is compared as a range, so two spellings of the same range are equal. `permissions` is compared as a set: order and
repeats do not count, and `false`, an empty list or `characters: "none"` count as absent. `npm run entry` copies the name, the
author, `engines` and `permissions` from `plugin.json` into the entry, so they match when you run it after the last change.

Here the listing says version 0.1.0 and the archive's `plugin.json` says 0.1.1:

```zip refuse:listing_mismatch
plugin.json (version: "0.1.1")
main.html
```

The rules of the plugin API that follow say which updates the user must review before the app applies them.
