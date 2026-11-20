#!/usr/bin/env node
// Vendors packages/plugin-api (types for the pinned host API version, README, LICENSE, package.json) from the desktop commit that
// vendor/eve-cyno-host/MANIFEST.json names. Read-only on the desktop checkout (git show). See sdk/README.md.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
export const DEFAULT_MANIFEST = resolve(HERE, '../../vendor/eve-cyno-host/MANIFEST.json');
export const DEFAULT_VENDOR = resolve(HERE, '../vendor/plugin-api');

const COMMIT_RE = /^[0-9a-f]{40}$/;
const VERSION_RE = /^\d+\.\d+\.\d+$/;
const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

/** Files taken from packages/plugin-api, as [path in the desktop repo, name under vendor/plugin-api]. */
export function sourceFiles(version) {
  return [
    [`api/${version}.d.ts`, `${version}.d.ts`],
    ['README.md', 'README.md'],
    ['LICENSE', 'LICENSE'],
    ['package.json', 'package.json'],
  ];
}

export function readHostPin(manifestPath = DEFAULT_MANIFEST) {
  const m = JSON.parse(readFileSync(manifestPath, 'utf8'));
  const commit = m?.desktop?.commit;
  const version = m?.hostApi;
  if (typeof commit !== 'string' || !COMMIT_RE.test(commit)) throw new Error('MANIFEST.json: desktop.commit is not a 40-hex sha');
  if (typeof version !== 'string' || !VERSION_RE.test(version)) throw new Error('MANIFEST.json: hostApi is not a semver');
  return { commit, version };
}

function gitShow(desktop, commit, path) {
  return execFileSync('git', ['-C', desktop, 'show', `${commit}:packages/plugin-api/${path}`], { maxBuffer: 64 * 1024 * 1024 });
}

/** Reads the pinned files from the desktop repository. Returns Map<name, Buffer>. */
export function exportFiles({ desktop, commit, version }) {
  const out = new Map();
  for (const [src, name] of sourceFiles(version)) out.set(name, gitShow(desktop, commit, src));
  return out;
}

export function vendor({ desktop, manifestPath = DEFAULT_MANIFEST, vendorDir = DEFAULT_VENDOR }) {
  const { commit, version } = readHostPin(manifestPath);
  const files = exportFiles({ desktop, commit, version });
  const pkgVersion = JSON.parse(files.get('package.json').toString('utf8')).version;
  if (pkgVersion !== version) throw new Error(`desktop ${commit.slice(0, 8)}: plugin-api package.json is ${pkgVersion}, host API is ${version}`);
  mkdirSync(vendorDir, { recursive: true });
  const hashes = {};
  for (const [name, buf] of [...files].sort(([a], [b]) => (a < b ? -1 : 1))) {
    writeFileSync(join(vendorDir, name), buf);
    hashes[name] = sha256(buf);
  }
  const pin = { schema: 1, generator: 'sdk/tools/vendor-api.mjs', desktopCommit: commit, version, files: hashes };
  writeFileSync(join(vendorDir, 'PIN.json'), JSON.stringify(pin, null, 2) + '\n');
  return pin;
}

/** Offline check. Returns a list of problems (empty when green). */
export function verify({ manifestPath = DEFAULT_MANIFEST, vendorDir = DEFAULT_VENDOR } = {}) {
  const problems = [];
  let host;
  try { host = readHostPin(manifestPath); } catch (e) { return [e.message]; }
  let pin;
  try { pin = JSON.parse(readFileSync(join(vendorDir, 'PIN.json'), 'utf8')); } catch (e) { return [`PIN.json unreadable: ${e.message}`]; }
  if (pin.desktopCommit !== host.commit) problems.push(`PIN.json desktopCommit ${pin.desktopCommit} != MANIFEST.json desktop.commit ${host.commit}`);
  if (pin.version !== host.version) problems.push(`PIN.json version ${pin.version} != MANIFEST.json hostApi ${host.version}`);
  const expected = sourceFiles(host.version).map(([, n]) => n).sort();
  const pinned = Object.keys(pin.files ?? {}).sort();
  if (JSON.stringify(expected) !== JSON.stringify(pinned)) problems.push(`PIN.json lists [${pinned}], expected [${expected}]`);
  for (const [name, want] of Object.entries(pin.files ?? {})) {
    let buf;
    try { buf = readFileSync(join(vendorDir, name)); } catch { problems.push(`${name}: missing`); continue; }
    if (sha256(buf) !== want) problems.push(`${name}: sha256 differs from PIN.json`);
  }
  try {
    const v = JSON.parse(readFileSync(join(vendorDir, 'package.json'), 'utf8')).version;
    if (v !== host.version) problems.push(`package.json version ${v} != hostApi ${host.version}`);
  } catch (e) { problems.push(`package.json unreadable: ${e.message}`); }
  return problems;
}

/** Compares a fresh export with the vendored files. Returns a list of problems. */
export function check({ desktop, manifestPath = DEFAULT_MANIFEST, vendorDir = DEFAULT_VENDOR }) {
  const { commit, version } = readHostPin(manifestPath);
  const problems = [];
  for (const [name, buf] of exportFiles({ desktop, commit, version })) {
    let have;
    try { have = readFileSync(join(vendorDir, name)); } catch { problems.push(`${name}: missing`); continue; }
    if (!have.equals(buf)) problems.push(`${name}: differs from desktop ${commit.slice(0, 8)}`);
  }
  return problems;
}

function main(argv) {
  const args = { desktop: null, mode: 'vendor' };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--desktop') args.desktop = argv[++i];
    else if (a === '--verify') args.mode = 'verify';
    else if (a === '--check') args.mode = 'check';
    else { console.error(`unknown argument: ${a}`); return 2; }
  }
  if (args.mode !== 'verify' && !args.desktop) { console.error('--desktop <checkout> is required'); return 2; }
  if (args.mode === 'vendor') {
    const pin = vendor({ desktop: args.desktop });
    console.log(`vendored plugin-api ${pin.version} from desktop ${pin.desktopCommit.slice(0, 8)}`);
    return 0;
  }
  const problems = args.mode === 'verify' ? verify() : check({ desktop: args.desktop });
  for (const p of problems) console.error(`FAIL ${p}`);
  if (problems.length === 0) console.log(`${args.mode}: ok`);
  return problems.length === 0 ? 0 : 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = main(process.argv.slice(2));
