// Builds the plugin: tsc compiles src/ into build/, then the plugin folder dist/<id>/ is made of plugin.json, static/** and the
// compiled build/**. That folder is what Settings > Plugins > Developer loads and what scripts/archive.mjs packs.
//   node scripts/build.mjs   (npm run build)
// Exits 1 with the reason when TypeScript is not installed, tsc fails, plugin.json has no plain id, `main` is not in the folder, or a
// file cannot go into the folder: a link, anything but files and folders, an empty folder, a name that is not plain (zip.mjs), or a
// name that two sources give (static/ and the compiled output, or plugin.json). Files are copied one by one, so a link is never
// followed. Output lines name paths inside the project only.
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MAX_ENTRIES, listFiles, quote } from './zip.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const fail = msg => { console.error(`build: ${msg}`); process.exit(1); };
const ID_RE = /^[a-z][a-z0-9-]*(\.[a-z][a-z0-9-]*){2,}$/; // the host's plugin id rule, at most 100 characters

/** The tsc launcher of the typescript package this project resolves (node_modules, or a folder above), or null. */
function tscPath() {
  try {
    const pkgFile = createRequire(join(root, 'package.json')).resolve('typescript/package.json');
    const bin = JSON.parse(readFileSync(pkgFile, 'utf8')).bin;
    const rel = typeof bin === 'string' ? bin : bin?.tsc;
    return typeof rel === 'string' ? join(dirname(pkgFile), rel) : null;
  } catch { return null; }
}

let manifest;
try { manifest = JSON.parse(readFileSync(join(root, 'plugin.json'), 'utf8')); } catch { fail('plugin.json is missing or not JSON'); }
const id = manifest?.id;
if (typeof id !== 'string' || id.length > 100 || !ID_RE.test(id)) fail('plugin.json has no plain id (lower-case dotted words, three or more)');

const tsc = tscPath();
if (tsc === null) fail('TypeScript is not installed: run npm install first');
rmSync(join(root, 'build'), { recursive: true, force: true });
const r = spawnSync(process.execPath, [tsc, '-p', root], { stdio: 'inherit' });
if (r.error || r.status !== 0) fail('tsc failed');

// The folder's files by name: plugin.json, then static/**, then the compiled build/**; a name two of them give is refused.
const files = new Map([['plugin.json', join(root, 'plugin.json')]]);
const origin = new Map([['plugin.json', 'plugin.json']]);
for (const [folder, label] of [['static', 'static/'], ['build', 'the compiled src/ (build/)']]) {
  const dir = join(root, folder);
  if (!existsSync(dir)) continue;
  let names;
  try { names = listFiles(dir); } catch (e) { fail(`${label}: ${e.message}`); }
  for (const name of names) {
    if (files.has(name)) fail(`${quote(name)} comes from both ${origin.get(name)} and ${label}: rename one`);
    files.set(name, join(dir, ...name.split('/')));
    origin.set(name, label);
  }
}
if (files.size > MAX_ENTRIES) fail(`${files.size} files, an archive holds at most ${MAX_ENTRIES}`);
if (typeof manifest.main !== 'string' || !files.has(manifest.main)) fail(`plugin.json main ${quote(manifest.main)} is not a file of the plugin folder`);

const out = join(root, 'dist', id);
rmSync(out, { recursive: true, force: true });
for (const [name, from] of files) {
  const to = join(out, ...name.split('/'));
  mkdirSync(dirname(to), { recursive: true });
  copyFileSync(from, to);
}
console.log(`build: dist/${id}/, ${files.size} files`);
