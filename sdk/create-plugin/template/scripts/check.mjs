// Runs the plugin index's own checks on this plugin's entry and archive, offline, with a local clone of eve-cyno/plugins:
//   node scripts/check.mjs --plugins <clone>   (npm run check -- --plugins <clone>)
// It makes a temp base tree with no entry (as for a new plugin), a head tree holding entry/<id>.json as entries/<id>.json, and an
// archive cache holding dist/<id>-<version>.zip under its SHA-256, then runs the clone's `tools/check.mjs refuse` (entry shape, id,
// names, version rules, the archive read by the app's own reader and installer checks, the whole index built and verified) and
// `review` (the review classes a maintainer reads), both with `--mirror-url none`. Nothing is downloaded: the archive is read from the
// cache. One exception: an entry that declares `provenance` has it checked with `gh attestation verify`, which needs the network.
// The clone needs `npm ci` once. Exit 0 when `refuse` passes (the review classes are printed; a new plugin is always `new`), 1 when it
// refuses, a run fails or the entry does not pin this archive, 2 on a usage error. The temp folder is removed at the end.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const fail = msg => { console.error(`check: ${msg}`); process.exit(1); };
const USAGE = 'usage: node scripts/check.mjs --plugins <clone of eve-cyno/plugins>';
const ID_RE = /^[a-z][a-z0-9-]*(\.[a-z][a-z0-9-]*){2,}$/;
const SHA_RE = /^[0-9a-f]{64}$/;

let args;
try {
  args = parseArgs({ args: process.argv.slice(2), strict: true, allowPositionals: false, options: { plugins: { type: 'string' } } }).values;
  if (args.plugins === undefined) throw new Error('--plugins is needed');
} catch (e) {
  console.error(`check: ${e.message}\n${USAGE}`);
  process.exit(2);
}

const clone = resolve(args.plugins);
const tool = join(clone, 'tools', 'check.mjs');
const isFile = p => { try { return statSync(p).isFile(); } catch { return false; } };
if (!isFile(tool) || !isFile(join(clone, 'vendor', 'eve-cyno-host', 'host', 'dist', 'manifest.js'))) fail('--plugins is not a clone of eve-cyno/plugins (no tools/check.mjs and vendored host)');
if (!['ajv', 'semver'].every(m => isFile(join(clone, 'node_modules', m, 'package.json')))) fail('the clone has no node_modules: run npm ci in it once');

let manifest;
try { manifest = JSON.parse(readFileSync(join(root, 'plugin.json'), 'utf8')); } catch { fail('plugin.json is missing or not JSON'); }
const { id, version } = manifest ?? {};
if (typeof id !== 'string' || id.length > 100 || !ID_RE.test(id) || typeof version !== 'string') fail('plugin.json has no plain id and version');

const entryRel = `entry/${id}.json`;
let entryBytes, entry;
try { entryBytes = readFileSync(join(root, 'entry', `${id}.json`)); entry = JSON.parse(entryBytes.toString('utf8')); } catch { fail(`${entryRel} is missing or not JSON`); }
const pinned = Array.isArray(entry?.versions) ? entry.versions.find(v => v?.version === version) : undefined;
if (!pinned) fail(`${entryRel} lists no version ${version}: run npm run entry -- --url <release URL>`);
if (typeof pinned.sha256 !== 'string' || !SHA_RE.test(pinned.sha256) || /^0+$/.test(pinned.sha256)) fail(`${entryRel} pins no archive for ${version} yet: run npm run entry -- --url <release URL>`);

const file = `${id}-${version}.zip`;
let archive;
try { archive = readFileSync(join(root, 'dist', file)); } catch { fail(`dist/${file} is missing: run npm run pack first`); }
const sha256 = createHash('sha256').update(archive).digest('hex');
if (sha256 !== pinned.sha256 || archive.length !== pinned.size) fail(`${entryRel} pins another archive than dist/${file}: run npm run entry again`);

const work = mkdtempSync(join(tmpdir(), 'plugin-check-'));
let code = 1;
try {
  const base = join(work, 'base'), head = join(work, 'head'), cache = join(work, 'cache');
  mkdirSync(join(base, 'entries'), { recursive: true });
  mkdirSync(join(head, 'entries'), { recursive: true });
  mkdirSync(cache);
  writeFileSync(join(base, 'revoked.json'), '[]\n');
  writeFileSync(join(head, 'revoked.json'), '[]\n');
  writeFileSync(join(head, 'entries', `${id}.json`), entryBytes);
  writeFileSync(join(cache, `${sha256}.zip`), archive);

  const run = mode => {
    console.log(`check: tools/check.mjs ${mode}`);
    const r = spawnSync(process.execPath, [tool, mode, '--base', base, '--head', head, '--archive-cache', cache, '--mirror-url', 'none'],
      { cwd: clone, stdio: ['ignore', 'pipe', 'inherit'], encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: 1_800_000 });
    const out = r.stdout ?? '';
    process.stdout.write(out);
    const last = out.trim().split('\n').pop() ?? '';
    return { status: r.error ? null : r.status, last };
  };
  const refuse = run('refuse');
  const review = run('review');
  if (refuse.status !== 0) console.log(`check: the index refuses this entry or archive (${refuse.last || `exit ${refuse.status}`})`);
  else if (review.status !== 0 && review.status !== 3) console.log(`check: the review run failed (${review.last || `exit ${review.status}`})`);
  else {
    code = 0;
    console.log(`check: the index checks pass; ${review.status === 3 ? `a maintainer reviews it: ${review.last.replace(/^NEEDS REVIEW /, '')}` : 'no review class is set'}`);
  }
} finally {
  rmSync(work, { recursive: true, force: true });
}
process.exit(code);
