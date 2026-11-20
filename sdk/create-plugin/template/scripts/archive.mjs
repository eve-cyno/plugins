// Packs the plugin into its archive, <id>-<version>.zip: the file you attach to a release and pin in entry/<id>.json, with plugin.json
// at the archive root.
//   node scripts/archive.mjs [--src <folder>] [--out <folder>]   (npm run pack)
// Without --src it runs scripts/build.mjs first and packs dist/<id>/, so the archive is always the current source; --src packs that
// folder as it is. --out: where the archive goes (default dist/). The id and version come from the packed folder's own plugin.json.
// Stored entries in name order with a fixed time (zip.mjs), so the same files give the same bytes on every run and every machine. A
// folder that would not make a plain archive (no plugin.json, a link or anything but files and folders, an empty folder, a name that is
// not plain, more than 2000 files, more than 32 MiB) exits 1 and writes nothing. Exit 2 on a usage error.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { MAX_ARCHIVE_BYTES, listFiles, zipStored } from './zip.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const fail = msg => { console.error(`archive: ${msg}`); process.exit(1); };
const ID_RE = /^[a-z][a-z0-9-]*(\.[a-z][a-z0-9-]*){2,}$/; // the host's plugin id rule, at most 100 characters
const VERSION_RE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/; // a plain x.y.z: the archive name holds it

let args;
try {
  args = parseArgs({ args: process.argv.slice(2), strict: true, allowPositionals: false, options: { src: { type: 'string' }, out: { type: 'string' } } }).values;
} catch (e) {
  console.error(`archive: ${e.message}\nusage: node scripts/archive.mjs [--src <folder>] [--out <folder>]`);
  process.exit(2);
}

let src = args.src === undefined ? undefined : resolve(args.src);
if (src === undefined) {
  const b = spawnSync(process.execPath, [join(root, 'scripts', 'build.mjs')], { stdio: 'inherit' });
  if (b.error || b.status !== 0) fail('the build failed, nothing packed');
  src = join(root, 'dist', JSON.parse(readFileSync(join(root, 'plugin.json'), 'utf8')).id);
}
const out = args.out === undefined ? join(root, 'dist') : resolve(args.out);

let manifest;
try { manifest = JSON.parse(readFileSync(join(src, 'plugin.json'), 'utf8')); } catch { fail('the folder has no readable plugin.json at its top'); }
const { id, version } = manifest ?? {};
if (typeof id !== 'string' || id.length > 100 || !ID_RE.test(id)) fail('plugin.json has no plain id (lower-case dotted words, three or more)');
if (typeof version !== 'string' || !VERSION_RE.test(version)) fail('plugin.json has no plain x.y.z version');

let names;
try { names = listFiles(src); } catch (e) { fail(e.message); }
if (!names.includes('plugin.json')) fail('no plugin.json at the top of the folder');

let bytes;
try { bytes = zipStored(names.map(name => ({ name, data: readFileSync(join(src, ...name.split('/'))) }))); } catch (e) { fail(String(e?.message ?? 'zip failed').replace(/^zip: /, '')); }
if (bytes.length > MAX_ARCHIVE_BYTES) fail(`the archive would be ${bytes.length} bytes, more than the index takes (${MAX_ARCHIVE_BYTES})`);

const file = `${id}-${version}.zip`, target = join(out, file), tmp = `${target}.tmp-${process.pid}`;
try { mkdirSync(out, { recursive: true }); writeFileSync(tmp, bytes, { flag: 'wx' }); renameSync(tmp, target); } catch (e) { rmSync(tmp, { force: true }); fail(`could not write ${file} (${e?.code ?? 'error'})`); }
const sha256 = createHash('sha256').update(bytes).digest('hex');
console.log(`archive: ${file}, ${names.length} files, ${bytes.length} bytes, sha256 ${sha256}`);
