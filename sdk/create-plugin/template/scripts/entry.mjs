// Fills entry/<id>.json, the plugin's index entry, for the version in plugin.json, from the archive scripts/archive.mjs wrote:
//   node scripts/entry.mjs --url <https URL of the release archive> [--released YYYY-MM-DD]   (npm run entry -- --url ...)
// It writes the version's url, sha256, size and released (default: today, UTC), and copies its engines and permissions and the entry's
// name and author from plugin.json: the index refuses an entry whose listing differs from the archive's plugin.json. A version the
// entry does not list yet is added at the top (newest first) with an empty `changes` for you to fill in.
// It refuses, and writes nothing, when: the URL is one the index refuses (not https, not in canonical form, a port, user info, a query
// or a fragment, over 2048 characters); dist/<id>-<version>.zip is missing, is not this project's archive, was packed from another
// plugin.json, or is over 32 MiB; the entry file is not an entry of this id; or plugin.json's version is not the entry's newest (a
// merged version never changes: raise the version for a new archive). Exit 2 on a usage error.
import { createHash } from 'node:crypto';
import { readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { MAX_ARCHIVE_BYTES, quote, readStored } from './zip.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const fail = msg => { console.error(`entry: ${msg}`); process.exit(1); };
const USAGE = 'usage: node scripts/entry.mjs --url <https URL of the release archive> [--released YYYY-MM-DD]';
const ID_RE = /^[a-z][a-z0-9-]*(\.[a-z][a-z0-9-]*){2,}$/;
const VERSION_RE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const isObj = v => typeof v === 'object' && v !== null && !Array.isArray(v);

let args;
try {
  args = parseArgs({ args: process.argv.slice(2), strict: true, allowPositionals: false, options: { url: { type: 'string' }, released: { type: 'string' } } }).values;
  if (args.url === undefined) throw new Error('--url is needed');
} catch (e) {
  console.error(`entry: ${e.message}\n${USAGE}`);
  process.exit(2);
}

/** Why the index refuses `u` as an archive URL (its entry check and its download check), or null. */
function urlProblem(u) {
  if (u.length > 2048) return 'is longer than 2048 characters';
  let x;
  try { x = new URL(u); } catch { return 'is not a URL'; }
  if (x.protocol !== 'https:') return 'is not https:';
  if (x.href !== u) return `is not in canonical form (the index takes ${quote(x.href)})`;
  if (x.username || x.password) return 'has a user name or password';
  if (x.port !== '') return 'names a port (the index downloads from port 443 only)';
  if (x.search || x.hash || u.includes('?') || u.includes('#')) return 'has a query or a fragment';
  if (!x.hostname) return 'has no host';
  return null;
}
const urlWhy = urlProblem(args.url);
if (urlWhy) fail(`the URL ${urlWhy}`);

/** True for a YYYY-MM-DD that is a real day. */
const isDay = s => {
  const t = /^\d{4}-\d{2}-\d{2}$/.test(s) ? Date.parse(`${s}T00:00:00Z`) : NaN;
  return Number.isFinite(t) && new Date(t).toISOString().slice(0, 10) === s;
};
const released = args.released ?? new Date().toISOString().slice(0, 10);
if (!isDay(released)) fail(`--released ${quote(released)} is not a day (YYYY-MM-DD)`);

let manifestBytes, manifest;
try { manifestBytes = readFileSync(join(root, 'plugin.json')); manifest = JSON.parse(manifestBytes.toString('utf8')); } catch { fail('plugin.json is missing or not JSON'); }
const { id, version, name, author } = manifest ?? {};
if (typeof id !== 'string' || id.length > 100 || !ID_RE.test(id)) fail('plugin.json has no plain id');
if (typeof version !== 'string' || !VERSION_RE.test(version)) fail('plugin.json has no plain x.y.z version');
if (typeof name !== 'string' || typeof author !== 'string') fail('plugin.json needs a name and an author (the listing shows both)');
const engines = manifest.engines?.['eve-cyno-api'];
if (typeof engines !== 'string') fail('plugin.json names no engines["eve-cyno-api"] range');
const permissions = manifest.permissions ?? {};
if (!isObj(permissions)) fail('plugin.json permissions is not an object');

const file = `${id}-${version}.zip`;
let archive;
try { archive = readFileSync(join(root, 'dist', file)); } catch { fail(`dist/${file} is missing: run npm run pack first`); }
if (archive.length < 1 || archive.length > MAX_ARCHIVE_BYTES) fail(`dist/${file} is ${archive.length} bytes; the index takes 1 to ${MAX_ARCHIVE_BYTES}`);
const packed = readStored(archive);
if (packed === null) fail(`dist/${file} is not an archive scripts/archive.mjs wrote: run npm run pack again`);
if (!packed.get('plugin.json')?.equals(manifestBytes)) fail(`dist/${file} was packed from another plugin.json: run npm run pack again`);
const sha256 = createHash('sha256').update(archive).digest('hex');

const entryRel = `entry/${id}.json`, entryFile = join(root, 'entry', `${id}.json`);
let entry;
try { entry = JSON.parse(readFileSync(entryFile, 'utf8')); } catch { fail(`${entryRel} is missing or not JSON`); }
if (!isObj(entry) || entry.id !== id || !Array.isArray(entry.versions) || !entry.versions.every(isObj)) fail(`${entryRel} is not an entry of ${id} with a versions list`);

// x.y.z only (plugin.json's version is one); another version is never compared, the index's own check (C8) orders those.
const newer = (a, b) => {
  if (!VERSION_RE.test(b)) return true;
  const x = a.split('.').map(Number), y = b.split('.').map(Number);
  return x[0] !== y[0] ? x[0] > y[0] : x[1] !== y[1] ? x[1] > y[1] : x[2] > y[2];
};
const at = entry.versions.findIndex(v => v.version === version);
if (at > 0) fail(`${version} is not the newest version of ${entryRel}: a merged version never changes; raise the version in plugin.json and package.json`);
const copy = value => JSON.parse(JSON.stringify(value));
let v;
if (at === 0) v = entry.versions[0];
else {
  const top = entry.versions[0]?.version;
  if (typeof top === 'string' && !newer(version, top)) fail(`${version} is below ${top}, the newest version of ${entryRel} (versions are newest first)`);
  v = { version, released, changes: '' };
  entry.versions.unshift(v);
}
Object.assign(v, { released, engines, permissions: copy(permissions), url: args.url, sha256, size: archive.length });
const notes = [];
if (at !== 0) notes.push(`added version ${version} at the top: write what changed in its "changes"`);
for (const [k, value] of [['name', name], ['author', author]]) {
  if (entry[k] !== value) { notes.push(`${k} set to ${quote(value)} as in plugin.json`); entry[k] = value; }
}
if (!args.url.endsWith(`/${file}`)) notes.push(`the URL does not end in /${file}: it must serve exactly this archive`);

const tmp = `${entryFile}.tmp-${process.pid}`;
try { writeFileSync(tmp, `${JSON.stringify(entry, null, 2)}\n`, { flag: 'wx' }); renameSync(tmp, entryFile); } catch (e) { rmSync(tmp, { force: true }); fail(`could not write ${entryRel} (${e?.code ?? 'error'})`); }
console.log(`entry: ${entryRel}, version ${version}: ${archive.length} bytes, sha256 ${sha256}, released ${released}`);
for (const n of notes) console.log(`entry: note: ${n}`);
