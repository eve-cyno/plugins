// Shared parts of the release scripts (release-assemble.mjs, release-verify.mjs, index-build.mjs, index-verify.mjs, release-sign.sh).
// Nothing here signs, uploads or holds a secret key.
// - The manifest rules, the minisign verifier and the pinned keys come from the host's own build (host/dist), so the scripts check exactly
//   what the app checks. `npm --prefix host run build` (or build:test) makes it.
// - Signing happens in the signing workflow of eve-cyno/desktop (scripts/release-sign.sh asks it; docs/release-checklist.md): the secret
//   keys are Actions secrets plus an encrypted backup, never a file here. `refuseSecretKeys` stops a script when a minisign secret key
//   sits where it must never be: in this repository, git-ignored files included (the committed test keys excepted), in a release folder,
//   in minisign's default key folder or in ~/eve-cyno-keys (the folder of the dropped offline key session) on this machine.
// - Messages name files relative to the repository or the release folder, never by an absolute path.
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);

/** The host modules the scripts share with the app. Exits 2 with a hint when the host was not built. */
export function loadHost() {
  const dist = path.join(ROOT, 'host', 'dist');
  try {
    return {
      manifest: require(path.join(dist, 'updater', 'manifest.js')),
      minisign: require(path.join(dist, 'minisign.js')),
      trustkeys: require(path.join(dist, 'trustkeys.js')),
      indexformat: require(path.join(dist, 'market', 'indexformat.js')),
    };
  } catch {
    console.error('the host is not built: run `npm --prefix host run build` first');
    process.exit(2);
  }
}

/**
 * The host modules index-verify.mjs reads archives with (host/dist): the zip reader, theme packages, the listing admission, the
 * installer's staged checks (the plugin manifest included).
 */
export function loadHostMarket() {
  const dist = path.join(ROOT, 'host', 'dist');
  try {
    return {
      zipread: require(path.join(dist, 'market', 'zipread.js')),
      themePackage: require(path.join(dist, 'themes', 'package.js')),
      wire: require(path.join(dist, 'market', 'wire.js')),
      stagecheck: require(path.join(dist, 'market', 'stagecheck.js')),
    };
  } catch {
    console.error('the host is not built: run `npm --prefix host run build` first');
    process.exit(2);
  }
}

/**
 * GETs a published file (release-verify.mjs and index-verify.mjs with --live) and streams it to `onChunk`: never more than `max` bytes,
 * no redirect, ended after `timeoutMs`. Resolves {ok: true, size, cacheControl} or {ok: false, why}; never throws.
 */
export async function fetchCapped(url, max, onChunk, timeoutMs, userAgent) {
  const ac = new AbortController();
  let res;
  try {
    res = await fetch(url, { redirect: 'error', headers: { 'User-Agent': userAgent }, signal: AbortSignal.any([ac.signal, AbortSignal.timeout(timeoutMs)]) });
  } catch { return { ok: false, why: 'not reachable (network error, time-out or a redirect)' }; }
  if (res.status !== 200) { ac.abort(); return { ok: false, why: `HTTP ${res.status}` }; }
  let n = 0, over = false;
  try {
    for await (const c of res.body) {
      n += c.length;
      if (n > max) { over = true; break; }
      onChunk(Buffer.from(c));
    }
  } catch { if (!over) return { ok: false, why: 'the transfer broke off' }; }
  finally { if (over) ac.abort(); }
  if (over) return { ok: false, why: `more than ${max} bytes` };
  return { ok: true, size: n, cacheControl: res.headers.get('cache-control') ?? '', date: res.headers.get('date') ?? '' };
}
/**
 * `p` relative to `root` with forward slashes, for a command printed to run from the repository root; null when it has none (on Windows
 * a path on another drive or a UNC share: path.relative gives it back absolute, which must never be printed).
 */
export function relToRoot(p, root = ROOT, P = path) {
  const r = P.relative(root, p);
  return P.isAbsolute(r) ? null : (r.split(P.sep).join('/') || '.');
}
/** One word of a printed shell command: as it is when plain, else in single quotes (a quote inside written as '\''). */
export const shq = (s) => (/^[A-Za-z0-9_@%+=:,./-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`);
/** True when a Cache-Control header value carries `no-cache`. */
export const noCache = (cc) => cc.split(',').map(s => s.trim().toLowerCase()).includes('no-cache');

/** The published name of each platform's file (the AppImage keeps one name: an in-place update keeps the path). */
export const PLATFORMS = /** @type {const} */ (['linux-x64', 'win32-x64']);
export const artifactName = (platform, version) => (platform === 'linux-x64' ? 'EVE-Cyno.AppImage' : `EVE-Cyno-${version}-setup.exe`);
export const MANIFEST = 'latest.json';
export const SIGNATURE = 'latest.json.minisig';
/** The committed TEST release key: `--test-key` verifies with this one only. */
export const TEST_RELEASE_PUB = path.join(ROOT, 'host', 'test', 'keys', 'test-release.pub');
/**
 * The file index-build.mjs --resign --test-key writes into its new folder (before anything else). That folder's catalog and archives
 * were checked only against a head signed with the committed TEST index key, whose secret is public in this repository, so
 * release-sign.sh refuses to have a head in a folder holding it (any entry of this name, in any case) signed with the product index keys.
 */
export const TEST_KEY_MARKER = 'TEST-KEY-ONLY.txt';

/** SHA-256 (lower hex) and size of a file, streamed. */
export function hashFile(file) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha256');
    let size = 0;
    fs.createReadStream(file).on('error', reject).on('data', c => { size += c.length; h.update(c); }).on('end', () => resolve({ sha256: h.digest('hex'), size }));
  });
}

/**
 * index-verify.mjs step 5 (6d review I1): the archives the kept `listings` name, grouped by URL. Each URL is digested once
 * (`digest(name, cap)` resolves {size, sha256, bytes?} or {why}; `cap` the largest size a pair lists) and the result is checked against
 * every (listing, version) pair naming it; with `contents` (--archives) the bytes are checked for each pair whose size and SHA-256
 * matched (`contents(bytes, l, v)`: a problem or null). The bytes are dropped before the next archive is read, so at most one archive is
 * held at a time. Resolves archive URL -> true when every pair naming it passed (flags only, never bytes).
 */
export async function verifyArchives(listings, prefix, { digest, contents, pass, bad }) {
  const groups = new Map(); // archive URL -> the pairs naming it, in catalog order
  for (const l of listings) for (const v of l.versions) {
    const g = groups.get(v.archive.url);
    if (g) g.push({ l, v }); else groups.set(v.archive.url, [{ l, v }]);
  }
  const passed = new Map();
  for (const [url, pairs] of groups) passed.set(url, await verifyArchive(url.slice(prefix.length), pairs, digest, contents, pass, bad));
  return passed;
}
/** One archive of verifyArchives: its own frame, so nothing of its bytes outlives it. */
async function verifyArchive(name, pairs, digest, contents, pass, bad) {
  const d = await digest(name, Math.max(...pairs.map(p => p.v.archive.size)));
  if (d.why) { bad(name, d.why); return false; }
  let all = true;
  for (const { l, v } of pairs) {
    const at = `${l.id} ${v.version}`;
    if (d.size !== v.archive.size) { bad(name, `${at}: ${d.size} bytes; the signed catalog says ${v.archive.size}`); all = false; continue; }
    if (d.sha256 !== v.archive.sha256) { bad(name, `${at}: its SHA-256 does not match the signed catalog`); all = false; continue; }
    pass(`${name} (${at}, ${v.archive.size} bytes)`);
    if (!contents) continue; // only bytes the catalog's size and hash matched are read further
    const problem = contents(d.bytes, l, v);
    if (problem === null) pass(`${name} contents: ${at} as listed`);
    else { bad(name, `${at}: ${problem}`); all = false; }
  }
  return all;
}

/** A path for messages: relative to the repository when inside it, else relative to `base` (a release folder), else its name. */
export function shown(p, base) {
  const inside = (root) => { const r = path.relative(root, p); return r && !r.startsWith('..') && !path.isAbsolute(r) ? r.split(path.sep).join('/') : null; };
  return inside(ROOT) ?? (base ? inside(base) : null) ?? path.basename(p);
}

// ---- secret keys -------------------------------------------------------------------------------------------------------------------
// A minisign secret key file: a comment line, then base64 of 158 bytes: "Ed", the KDF algorithm ("Sc" for scrypt, two zero bytes for an
// unencrypted key), the checksum algorithm, the KDF salt and limits, then the (encrypted) key id, key and checksum. minisign reads the
// second line as the key whatever the first one says (measured with 0.12: no "untrusted comment:" needed, a UTF-8 byte-order mark in
// front is fine, and so is anything after the key line).
const SECRET_BYTES = 158;
/** Files up to this size are read; a larger one is never taken for a key (a documented limit: minisign ignores what follows the key). */
export const SECRET_SCAN_MAX_BYTES = 4096;
/** How deep listDir looks below a folder outside the repository (a documented limit). */
export const SECRET_SCAN_DEPTH = 3;
/** The committed test secrets (unencrypted, test only): allowed at exactly these paths, as regular files, and only while unencrypted. */
const TEST_SECRETS = new Set(['host/test/keys/test-release.key', 'host/test/keys/test-index.key']);

/**
 * 'encrypted' | 'plain' when `file` is a minisign secret key, else null. A link counts as the file it names (followed with realpath;
 * a dangling link or a link to a folder is none). Reads only regular files of 100 to SECRET_SCAN_MAX_BYTES bytes.
 */
export function secretKeyKind(file) {
  try {
    let st = fs.lstatSync(file), real = file;
    if (st.isSymbolicLink()) { real = fs.realpathSync(file); st = fs.statSync(real); }
    if (!st.isFile() || st.size > SECRET_SCAN_MAX_BYTES || st.size < 100) return null;
    // trim() also drops a UTF-8 byte-order mark (U+FEFF); and the first line is never required to be a comment, so a mark there hides nothing
    const raw = fs.readFileSync(real, 'utf8').split(/\r?\n/).map(l => l.trim());
    // the line minisign reads (the second), and the second non-empty one (a key pasted below blank lines)
    for (const line of new Set([raw[1] ?? '', raw.filter(Boolean)[1] ?? ''])) {
      if (!/^[A-Za-z0-9+/]+={0,2}$/.test(line)) continue;
      const b = Buffer.from(line, 'base64');
      if (b.length === SECRET_BYTES && b.toString('latin1', 0, 2) === 'Ed') return b[2] === 0 && b[3] === 0 ? 'plain' : 'encrypted';
    }
    return null;
  } catch { return null; }
}
const isLink = (file) => { try { return fs.lstatSync(file).isSymbolicLink(); } catch { return false; } };

/** True when `p` is `root` or inside it. On Windows a path on another drive (or a UNC share) is outside: path.relative gives it back absolute. */
export function insideDir(root, p, P = path) {
  const r = P.relative(root, p);
  return r === '' || (r !== '..' && !r.startsWith(`..${P.sep}`) && !P.isAbsolute(r));
}

// Every file below `dir` (SECRET_SCAN_DEPTH folders deep at most), links to files included; a link to a folder is not followed.
const listDir = (dir) => {
  const out = [];
  const walk = (d, depth) => {
    let ents = [];
    try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      const p = path.join(d, e.name);
      if (e.isDirectory() && depth < SECRET_SCAN_DEPTH) walk(p, depth + 1);
      else if (e.isFile() || e.isSymbolicLink()) out.push(p);
    }
  };
  walk(dir, 0);
  return out;
};

/**
 * Exits 1 when a minisign secret key is found where none may be, on the machine the release tooling runs on:
 * - the repository: tracked and untracked files, and the git-ignored ones too (tmp/, release/, build output); only the two committed
 *   test secrets are allowed, at their exact paths, as regular files and while unencrypted;
 * - every folder in `dirs` outside the repository (a release folder elsewhere, on Windows also on another drive);
 * - minisign's default key folder (~/.minisign, or $MINISIGN_CONFIG_DIR) and ~/eve-cyno-keys (the dropped offline session's folder).
 * A link counts as the file it names. Limits: files over SECRET_SCAN_MAX_BYTES are not read, and outside the repository the scan goes
 * SECRET_SCAN_DEPTH folders deep and follows no link to a folder. Release and index secret keys live only in the Actions secrets of
 * eve-cyno/desktop and the encrypted backup. A finding names where it is (a location and a relative path), never the file's content.
 */
export function refuseSecretKeys(dirs = []) {
  const found = [];
  const add = (where, rel) => found.push(`${where}: ${rel.split(path.sep).join('/')}`);
  const git = (args) => {
    try { return execFileSync('git', ['ls-files', '-z', ...args], { cwd: ROOT, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 }).split('\0').filter(Boolean); }
    catch { console.error('cannot list the repository files (git ls-files failed)'); process.exit(2); }
  };
  for (const rel of git(['--cached', '--others', '--exclude-standard'])) {
    const kind = secretKeyKind(path.join(ROOT, rel));
    if (kind && !(kind === 'plain' && TEST_SECRETS.has(rel) && !isLink(path.join(ROOT, rel)))) add('this repository', rel);
  }
  for (const rel of git(['--others', '--ignored', '--exclude-standard'])) if (secretKeyKind(path.join(ROOT, rel))) add('this repository (git-ignored)', rel);
  for (const d of dirs) {
    if (insideDir(ROOT, path.resolve(d))) continue; // inside the repository: scanned above
    for (const f of listDir(d)) if (secretKeyKind(f)) add('the release folder', path.relative(path.dirname(d), f));
  }
  const home = os.homedir();
  const keyDirs = [[path.join(home, '.minisign'), '~/.minisign'], [path.join(home, 'eve-cyno-keys'), '~/eve-cyno-keys']];
  if (process.env.MINISIGN_CONFIG_DIR) keyDirs.push([process.env.MINISIGN_CONFIG_DIR, '$MINISIGN_CONFIG_DIR']);
  for (const [d, label] of keyDirs) for (const f of listDir(d)) if (secretKeyKind(f)) add(label, path.relative(d, f));
  if (found.length === 0) return;
  console.error('REFUSED: a minisign secret key is on this machine, where the release tooling runs:');
  for (const f of [...new Set(found)]) console.error(`  ${f}`);
  console.error('Release and index secret keys live only in the Actions secrets of eve-cyno/desktop and the encrypted backup (docs/release-checklist.md).');
  console.error('Move the key off this machine (if it is a release or index key, treat it as exposed: follow "Key compromise and rotation" in the checklist).');
  process.exit(1);
}
