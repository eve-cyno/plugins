// Shared parts of the release scripts (release-assemble.mjs, release-verify.mjs, index-build.mjs, index-verify.mjs, release-sign.sh).
// Nothing here signs, uploads or holds a secret key.
// - The manifest rules, the minisign verifier and the pinned keys come from the host's own build (host/dist), so the scripts check exactly
//   what the app checks. `npm --prefix host run build` (or build:test) makes it.
// - Signing happens in workflows (docs/release-checklist.md): a release in the signing workflow of eve-cyno/desktop (scripts/release-sign.sh
//   asks it), the plugin index in the publishing workflows of eve-cyno/plugins (release-sign.sh with purpose index stays the manual
//   fallback). The secret keys are Actions secrets plus an encrypted backup, never a file here. `refuseSecretKeys` stops a script when a minisign secret key
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
 * The host modules index-verify.mjs reads archives with (host/dist): the zip reader, theme packages, the listing admission (market/admit.js:
 * the app's own rule without the client's wiring in market/wire.js, DP3 M4), the installer's staged checks (the plugin manifest included).
 */
export function loadHostMarket() {
  const dist = path.join(ROOT, 'host', 'dist');
  try {
    return {
      zipread: require(path.join(dist, 'market', 'zipread.js')),
      themePackage: require(path.join(dist, 'themes', 'package.js')),
      admit: require(path.join(dist, 'market', 'admit.js')),
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
/**
 * The file index-build.mjs writes into a folder it builds, re-signs or writes a head for with --key, and index-verify.mjs into a folder
 * it verifies with --key (DP3 1.D). That folder's index was made for, or checked against, a key that is not the product's (a test
 * location or a private source), so release-sign.sh refuses to have its head signed (any entry of this name, in any case; with or
 * without --test-key).
 */
export const CUSTOM_KEY_MARKER = 'CUSTOM-KEY-ONLY.txt';
/** --key takes at most this many public keys: a primary and a standby, like the product's. */
export const MAX_CUSTOM_KEYS = 2;

/** True when `dir` holds an entry named `name` in any case (a folder that cannot be listed counts as holding it). */
export function holdsName(dir, name) {
  try { return fs.readdirSync(dir).some(n => n.toLowerCase() === name.toLowerCase()); } catch { return true; }
}
/**
 * Writes CUSTOM_KEY_MARKER into the folder `dir` (`how`: the command that marks it) unless an entry of that name is there in any case
 * already. Throws when it cannot be written.
 */
export function writeCustomKeyMarker(dir, how) {
  if (holdsName(dir, CUSTOM_KEY_MARKER)) return;
  fs.writeFileSync(path.join(dir, CUSTOM_KEY_MARKER), [
    `This folder was ${how}.`,
    'Its index was made for, or checked against, a key that is not the product index key (a test location or a private source).',
    'scripts/release-sign.sh therefore refuses to have its index.json signed, with or without --test-key. To sign the published index,',
    'build or re-sign it without --key (docs/release-checklist.md, "The plugin index").', ''].join('\n'), { flag: 'wx' });
}

/**
 * Why `p` is not a URL prefix the index tools take with --prefix, or null: a canonical folder URL (ending in /; no user, query or
 * fragment) over https, or over http on 127.0.0.1 only (a local test server). The app itself reads only MARKET_URL_PREFIX.
 */
export function prefixProblem(p) {
  let u;
  try { u = new URL(p); } catch { return 'not a URL'; }
  if (u.href !== p) return `not written canonically (${u.href})`;
  if (u.username || u.password || u.search || u.hash || p.includes('?') || p.includes('#')) return 'a prefix has no user, query or fragment';
  if (!u.pathname.endsWith('/')) return 'a folder URL ends with /';
  if (u.protocol === 'https:' || (u.protocol === 'http:' && u.hostname === '127.0.0.1')) return null;
  return 'https, or http on 127.0.0.1 only (a local test server)';
}

/**
 * The public keys of --key `files` (at most MAX_CUSTOM_KEYS minisign .pub files, no key twice, never a release key: an index never
 * verifies with one), as {keys} or {why} for a usage error. `S` and `T` are the host's minisign and trustkeys modules.
 */
export function customKeys(files, S, T) {
  if (files.length > MAX_CUSTOM_KEYS) return { why: `--key: at most ${MAX_CUSTOM_KEYS} public keys (a primary and a standby)` };
  const same = (a, b) => a.keyId === b.keyId && a.publicKey.equals(b.publicKey);
  const release = T.trustedKeys('release', false).slice();
  try { release.push(S.parsePublicKey(fs.readFileSync(TEST_RELEASE_PUB, 'utf8'))); } catch { /* no test key in this checkout */ }
  const keys = [];
  for (const f of files) {
    let text, k;
    try { text = fs.readFileSync(f, 'utf8'); } catch { return { why: `--key ${shown(f)}: cannot be read` }; }
    try { k = S.parsePublicKey(text); } catch { return { why: `--key ${shown(f)}: not a minisign public key` }; }
    if (release.some(r => same(r, k))) return { why: `--key ${shown(f)}: a release key (${k.keyId}); an index is verified with index keys only` };
    if (keys.some(x => same(x, k))) return { why: `--key ${shown(f)}: the key ${k.keyId} is given twice` };
    keys.push(k);
  }
  return { keys };
}

/**
 * index-verify.mjs check 4 and index-build.mjs --head-from: what a published index must not rely on in a catalog (`catBytes`, matched to
 * its head and parsed into `cat` without `admit`), as messages: listings the parser drops, types it ignores, categories it removes (the app
 * is lenient there), and listings the app's admission drops (market/admit.ts listingAdmit). `I` is market/indexformat, `M` loadHostMarket().
 */
export function catalogProblems(I, M, catBytes, cat, prefix) {
  const out = [];
  const raw = JSON.parse(catBytes.toString('utf8')).plugins; // parsed once already: it is JSON with a plugins list
  const idOf = (l, i) => (typeof l?.id === 'string' && /^[a-z0-9.-]{1,100}$/.test(l.id) ? l.id : `plugins[${i}]`);
  const isObj = (v) => typeof v === 'object' && v !== null && !Array.isArray(v);
  if (cat.dropped > 0) {
    const named = raw.map((l, i) => [l, i]).filter(([l]) => I.listingProblem(l, prefix) !== null).map(([l, i]) => `${idOf(l, i)} (${I.listingProblem(l, prefix)})`);
    out.push(`the app drops ${cat.dropped} listing${cat.dropped === 1 ? '' : 's'}: ${named.join(', ')}`);
  }
  for (const [i, l] of raw.entries()) {
    if (!isObj(l) || typeof l.type !== 'string') continue;
    if (l.type !== 'plugin' && l.type !== 'theme') out.push(`the app ignores the listing ${idOf(l, i)} (its type is not plugin or theme)`);
    else if (I.listingProblem(l, prefix) === null && l.categories.some(c => !I.CATEGORIES.includes(c))) out.push(`the app removes a category it does not know from the listing ${idOf(l, i)}`);
  }
  // The app's admission of a listing (the same function the app passes to parseCatalog as `admit`).
  for (const l of cat.plugins) {
    if (M.admit.listingAdmit(l)) continue;
    out.push(`the app drops the listing ${l.id} (${M.zipread.isDeviceNameId(l.id) ? 'its id starts with a Windows device name' : 'its name or author reads as the host\'s'})`);
  }
  return out;
}

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
 * SECRET_SCAN_DEPTH folders deep and follows no link to a folder. The release secret keys live only in the Actions secrets of
 * eve-cyno/desktop, the index secret key in those of eve-cyno/plugins (environment `index`), and both in the encrypted backup (DP3 M7). A
 * finding names where it is (a location and a relative path), never the file's content.
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
  console.error('The release secret keys live only in the Actions secrets of eve-cyno/desktop, the index secret key in those of eve-cyno/plugins (environment');
  console.error('"index"), and both in the encrypted backup (docs/release-checklist.md, "The signing keys").');
  console.error('Move the key off this machine (if it is a release or index key, treat it as exposed: follow "Key compromise and rotation" in the checklist).');
  process.exit(1);
}
