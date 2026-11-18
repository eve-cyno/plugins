// Test-only fixtures for the end-to-end chain (e2e.test.mjs) and the fixture PR suite to come (task 1.10): plugin and theme archives built
// in the run (zipwrite.mjs), entries that pin them, repository trees (entries/, revoked.json, flags.json, any other file), an archive
// cache by SHA-256, and the tools run as child processes. Every archive URL is https://127.0.0.1/..., an address the download check
// (C4) refuses before it connects, so a test that forgets to cache an archive fails at C4 and never reaches the network.
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { zip } from './zipwrite.mjs';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
export const PERMS = Object.freeze({ characters: 'selected', network: ['https://api.example.com'] });

const temps = [];
/** A new temp folder, removed by cleanup(). */
export function tempDir(name = 'pr') {
  const t = fs.mkdtempSync(path.join(os.tmpdir(), `evecyno-${name}-test-`));
  temps.push(t);
  return t;
}
export function cleanup() { for (const t of temps.splice(0)) fs.rmSync(t, { recursive: true, force: true }); }

/** A plugin.json the app accepts (the manifest of archives.test.mjs), with `over` on top. */
export const manifest = (over = {}) => ({
  id: 'dev.example.intel', name: 'Intel Board', author: 'Example Author', version: '1.0.0', engines: { 'eve-cyno-api': '^1.20.0' },
  esiCompatibilityDate: '2026-08-18', main: 'index.html', permissions: PERMS, ...over,
});
export const pluginZip = (m = manifest(), extra = []) => zip([
  { name: 'plugin.json', data: JSON.stringify(m) }, { name: 'index.html', data: '<!doctype html><title>Intel</title>' }, ...extra,
]);
export const themeZip = (over = {}) => zip([{ name: 'theme.json', data: JSON.stringify({
  schema: 1, id: 'dev.example.dusk', name: 'Dusk Themes', author: 'Example Author', version: '2.0.0',
  themes: [{ id: 'day', name: 'Day', scheme: 'light', roles: {} }], ...over,
}) }]);

/** An entry version pinning `bytes`; a plugin version carries engines and permissions. */
export const version = (v, bytes, over = {}, type = 'plugin') => ({
  version: v, released: '2026-12-01', changes: `Version ${v}.`, url: `https://127.0.0.1/releases/${sha(bytes).slice(0, 16)}.zip`,
  sha256: sha(bytes), size: bytes.length, ...(type === 'plugin' ? { engines: '^1.20.0', permissions: PERMS } : {}), ...over,
});
export const pluginEntry = (versions, over = {}) => ({
  schema: 1, id: 'dev.example.intel', type: 'plugin', name: 'Intel Board', author: 'Example Author', summary: 'Intel reports on a map',
  description: 'Reads chat logs.\nShows reports.', categories: ['intel'], source: 'https://example.com/intel', maintainers: ['example-login'],
  versions, ...over,
});
export const themeEntry = (versions, over = {}) => ({
  schema: 1, id: 'dev.example.dusk', type: 'theme', name: 'Dusk Themes', author: 'Example Author', summary: 'Two quiet themes',
  description: '', categories: ['themes'], source: null, maintainers: ['example-login'], versions, ...over,
});

/** Writes a repository tree: entries/<id>.json, revoked.json, flags.json and `files` ({relative path: text}). */
export function writeTree(dir, { entries = [], revoked = [], flags = {}, files = {} } = {}) {
  fs.mkdirSync(path.join(dir, 'entries'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'entries', '.gitkeep'), '');
  for (const e of entries) fs.writeFileSync(path.join(dir, 'entries', `${e.id}.json`), `${JSON.stringify(e, null, 2)}\n`);
  if (revoked !== null) fs.writeFileSync(path.join(dir, 'revoked.json'), `${JSON.stringify(revoked, null, 2)}\n`);
  if (flags !== null) fs.writeFileSync(path.join(dir, 'flags.json'), `${JSON.stringify(flags)}\n`);
  for (const [rel, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), text);
  }
  return dir;
}

/** Puts `bytes` into the archive cache as `<name ?? sha256>.zip`. */
export function cacheArchive(cache, bytes, name = sha(bytes)) {
  fs.mkdirSync(cache, { recursive: true });
  fs.writeFileSync(path.join(cache, `${name}.zip`), bytes);
}

/** Runs `node <script> ...args` from the repository root. Resolves {code, stdout, stderr}. */
export function run(script, args, { env = {}, timeoutMs = 300_000 } = {}) {
  return new Promise(resolve => {
    execFile(process.execPath, [path.join(ROOT, script), ...args], {
      cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: timeoutMs, killSignal: 'SIGKILL',
      env: { ...process.env, GITHUB_ACTIONS: '', ...env },
    }, (err, stdout, stderr) => resolve({ code: err ? (typeof err.code === 'number' ? err.code : -1) : 0, stdout, stderr }));
  });
}
/** The output lines that start with `word`. */
export const linesOf = (out, word) => out.split('\n').filter(l => l.startsWith(word));
