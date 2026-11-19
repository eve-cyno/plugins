// The index build of tools/build-index.mjs and check C16 (plan 2.2 "Build mapping", 3.2, 4.2): entries and revoked.json become the
// source format of the vendored index-build.mjs, which writes the catalog and the archives; its head is then written again by
// `index-build.mjs --head-from` (the same parser, plus the app's listing admission on the whole catalog). The lifetime is the vendored
// tools' default, DEFAULT_INDEX_LIFETIME_DAYS (60 days, D36): no caller can pass another one. Every archive is checked against the
// entry's SHA-256 and size before the vendored tool sees it (it names archives by the hash it computes itself).
// Also the live reads of the index (`readLive`), paced for the zone's rate limit (plan 6.2: at most 50 requests per 10 s).
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { checkEntry, checkIds, readEntries, toIndexSource } from './entries.mjs';
import { downloadArchive } from './archives.mjs';
import { customKeys, fetchCapped, prefixProblem } from '../../vendor/eve-cyno-host/scripts/release-lib.mjs';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const VENDOR = path.join(ROOT, 'vendor', 'eve-cyno-host');
const require = createRequire(import.meta.url);
const I = require(path.join(VENDOR, 'host', 'dist', 'market', 'indexformat.js'));
const S = require(path.join(VENDOR, 'host', 'dist', 'minisign.js'));
const T = require(path.join(VENDOR, 'host', 'dist', 'trustkeys.js'));

const DAY = 86_400_000;
/** The prefix of each publish target (plan 4.2); the app reads only `production`. */
export const PREFIXES = Object.freeze({ production: I.MARKET_URL_PREFIX, test: 'https://plugins.eve-cyno.dev/test/v1/' });
/** D36: every head this repository writes lives 60 days (the vendored tools' default). */
export const LIFETIME_MS = I.DEFAULT_INDEX_LIFETIME_DAYS * DAY;
/** Plan 4.2: the sign and upload jobs refuse a head older than 7 days or more than 5 minutes ahead; the tools refuse it first. */
export const HEAD_MAX_AGE_MS = 7 * DAY;
export const HEAD_MAX_AHEAD_MS = 300_000;
export const sha256 = (b) => crypto.createHash('sha256').update(b).digest('hex');
export { prefixProblem };
const SHA_RE = /^[0-9a-f]{64}$/;
const isObj = (v) => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Why the head `bytes` is not one to sign now (the app's parser, the 60-day lifetime, the age bounds), or null. */
export function headBoundsProblem(bytes, prefix, now = Date.now()) {
  let h;
  try { h = I.parseIndexHead(bytes, prefix); } catch (e) { return `the app refuses the head (${e?.message ?? 'bad_index'})`; }
  const g = Date.parse(h.generated), x = Date.parse(h.expires);
  if (g > now + HEAD_MAX_AHEAD_MS) return `the head was generated ${h.generated}, more than 5 minutes ahead of this machine's clock`;
  if (now - g > HEAD_MAX_AGE_MS) return `the head was generated ${h.generated}, more than 7 days ago: build a new head`;
  if (x - g !== LIFETIME_MS) return `the head expires ${h.expires}, not ${I.DEFAULT_INDEX_LIFETIME_DAYS} days after it was generated (${h.generated}; D36)`;
  return null;
}

/** Runs a vendored script (vendor/eve-cyno-host/scripts) with this Node. Resolves {code, stdout, stderr}; never rejects. */
export function runVendored(script, args, { timeoutMs = 1_800_000 } = {}) {
  return new Promise(resolve => {
    execFile(process.execPath, [path.join(VENDOR, 'scripts', script), ...args], { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: timeoutMs, killSignal: 'SIGKILL' },
      (err, stdout, stderr) => resolve({ code: err ? (typeof err.code === 'number' ? err.code : 1) : 0, stdout: stdout ?? '', stderr: stderr ?? '' }));
  });
}
/** The lines of a vendored tool's output that say why it refused (REFUSED, FAIL, usage), at most `max`. */
export const refusalLines = (r, max = 20) => `${r.stderr}\n${r.stdout}`.split('\n').map(l => l.trim())
  .filter(l => /^(REFUSED|FAIL|INDEX VERIFY FAILED|usage|--)/.test(l)).slice(0, max);

/** Every mirror read of this process shares one pace (plan 6.2: at most 50 requests per 10 s). */
let mirrorPace = null;

/**
 * The mirror's copy of `v`: `<mirror>archives/<sha256>.zip`, at most the pinned size, used only when it is the pinned size and SHA-256.
 * Resolves {ok: true, bytes} or {ok: false, why}.
 */
async function fromMirror(v, mirror, pace) {
  if (!Number.isSafeInteger(v.size) || v.size < 1 || v.size > I.MAX_ARCHIVE_BYTES) return { ok: false, why: 'the entry pins no size the app reads' };
  const r = await getLive(`${mirror}archives/${v.sha256}.zip`, v.size, pace, 600_000);
  if (!r.ok) return { ok: false, why: r.why };
  if (sha256(r.bytes) !== v.sha256) return { ok: false, why: 'the mirror copy is not the pinned size and SHA-256' }; // at most v.size bytes arrived
  return { ok: true, bytes: r.bytes };
}

/**
 * The archive of an entry version {url, sha256, size}: the cached copy `<cache>/<sha256>.zip` when there is one; else, with `mirror` (a
 * prefix such as the production one), the mirror's `archives/<sha256>.zip` when it is the pinned size and SHA-256, so a version already
 * live never depends on its author's URL; else downloaded from its author's URL (C4). What arrives is kept in the cache under its own
 * hash. Resolves {ok: true, bytes, file} or {ok: false, check: 'C4', error, why}. The caller checks the size and SHA-256 (C5): a cached
 * copy is never trusted to match its name.
 */
export async function obtainArchive(v, { cache, download = downloadArchive, mirror = null, pace = null }) {
  if (typeof v?.sha256 !== 'string' || !SHA_RE.test(v.sha256)) return { ok: false, check: 'C4', error: 'bad_entry', why: 'the entry names no SHA-256' };
  const f = path.join(cache, `${v.sha256}.zip`);
  let st = null;
  try { st = fs.lstatSync(f); } catch { /* not cached */ }
  if (st) {
    if (!st.isFile() || st.size > I.MAX_ARCHIVE_BYTES) return { ok: false, check: 'C4', error: 'cache', why: `the cached copy is not a regular file of at most ${I.MAX_ARCHIVE_BYTES} bytes` };
    return { ok: true, bytes: fs.readFileSync(f), file: f };
  }
  const keep = (bytes, hash) => {
    const g = path.join(cache, `${hash}.zip`);
    try { fs.writeFileSync(g, bytes, { flag: 'wx' }); } catch (e) {
      if (e?.code !== 'EEXIST') return { ok: false, check: 'C4', error: 'disk', why: `the archive could not be kept (${e?.code ?? 'error'})` };
    }
    return { ok: true, bytes, file: g };
  };
  let missed = '';
  if (mirror) {
    const m = await fromMirror(v, mirror, pace ?? (mirrorPace ??= pacer()));
    if (m.ok) return keep(m.bytes, v.sha256);
    missed = `; the mirror: ${m.why}`;
  }
  const d = await download(v.url);
  if (!d.ok) return { ok: false, check: 'C4', error: d.error, why: `${d.why}${missed}` };
  return keep(d.bytes, d.sha256);
}

/** The JSON file `name` of `dir`: {value}, {missing: true} or {why}. */
export function readJson(dir, name) {
  const f = path.join(dir, name);
  let st;
  try { st = fs.lstatSync(f); } catch { return { missing: true }; }
  if (!st.isFile() || st.size > I.MAX_CATALOG_BYTES) return { why: `${name} is not a regular file of at most ${I.MAX_CATALOG_BYTES} bytes` };
  try { return { value: JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(fs.readFileSync(f))) }; } catch { return { why: `${name} is not JSON (UTF-8)` }; }
}

/**
 * Builds the index of the tree `tree` (entries/, revoked.json, flags.json) into the new folder `out`, every URL under `prefix`:
 * archives/, catalog/<sha256>.json and the unsigned head index.json. `cache`: a folder of archives by SHA-256 (read, and filled with
 * downloads); without it a temp folder. `mirror`: the prefix whose archives/ is read before an author's URL (obtainArchive), or null.
 * `archivesJson`: a new file listing each archive {name, sha256, size, url} (the author's URL).
 * Resolves {ok: true, headBytes, head, catalogName, catalogBytes, archives} or {ok: false, why}; on a refusal nothing of `out` is kept.
 */
export async function buildIndex({ tree, prefix, out, cache, archivesJson, download, mirror = null }) {
  const refuse = (why) => ({ ok: false, why });
  if (prefixProblem(prefix)) return refuse(`prefix ${prefix}: ${prefixProblem(prefix)}`);
  if (fs.existsSync(out)) return refuse('the output folder exists: build into a new folder');
  if (archivesJson && fs.existsSync(archivesJson)) return refuse('the archive list file exists already');
  const read = readEntries(path.join(tree, 'entries'));
  const problems = [...read.problems, ...read.entries.flatMap(({ file, entry }) => checkEntry(entry).map(p => ({ ...p, file }))), ...checkIds(read.entries)];
  if (problems.length > 0) return refuse(`the entries do not pass the checks: ${problems.slice(0, 5).map(p => `${p.check} ${p.file ?? ''} ${p.message}`).join('; ')}`);
  const rev = readJson(tree, 'revoked.json');
  if (!Array.isArray(rev.value)) return refuse(`revoked.json: ${rev.why ?? (rev.missing ? 'missing' : 'not a JSON list')}`);
  const flags = readJson(tree, 'flags.json');
  if (!flags.missing && !(isObj(flags.value) && Object.keys(flags.value).length === 0)) return refuse('flags.json: must be {} (flags are reserved)');
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'evecyno-build-'));
  let made = false;
  try {
    const store = cache ?? path.join(work, 'cache');
    fs.mkdirSync(store, { recursive: true });
    const entries = read.entries.map(x => x.entry);
    const kept = [];
    const source = toIndexSource(entries, rev.value, (id, version) => {
      const v = entries.find(e => e.id === id).versions.find(x => x.version === version);
      kept.push({ id, v });
      return path.join(store, `${v.sha256}.zip`);
    });
    const archives = new Map();
    for (const { id, v } of kept) {
      const got = await obtainArchive(v, { cache: store, download, mirror });
      if (!got.ok) return refuse(`${id} ${v.version}: C4 ${got.why}`);
      if (got.bytes.length !== v.size || sha256(got.bytes) !== v.sha256) return refuse(`${id} ${v.version}: C5 the archive's size or SHA-256 is not the one the entry pins`);
      if (!archives.has(v.sha256)) archives.set(v.sha256, { name: `archives/${v.sha256}.zip`, sha256: v.sha256, size: v.size, url: v.url });
    }
    const src = path.join(work, 'source.json');
    fs.writeFileSync(src, JSON.stringify(source, null, 2));
    made = true;
    const b = await runVendored('index-build.mjs', [src, out, '--prefix', prefix]);
    if (b.code !== 0) return refuse(`index-build.mjs refused the catalog: ${refusalLines(b).join(' | ') || `exit ${b.code}`}`);
    fs.rmSync(path.join(out, 'index.json'));
    const h = await runVendored('index-build.mjs', ['--head-from', out, '--prefix', prefix]);
    if (h.code !== 0) return refuse(`index-build.mjs --head-from refused the head: ${refusalLines(h).join(' | ') || `exit ${h.code}`}`);
    const headBytes = fs.readFileSync(path.join(out, 'index.json'));
    const bound = headBoundsProblem(headBytes, prefix);
    if (bound) return refuse(bound);
    const head = I.parseIndexHead(headBytes, prefix);
    const catalogName = head.catalog.url.slice(prefix.length);
    const list = [...archives.values()].sort((x, y) => (x.name < y.name ? -1 : 1));
    if (archivesJson) fs.writeFileSync(archivesJson, `${JSON.stringify(list, null, 2)}\n`, { flag: 'wx' });
    made = false; // kept
    return { ok: true, headBytes, head, catalogName, catalogBytes: fs.readFileSync(path.join(out, ...catalogName.split('/'))), archives: list };
  } finally {
    if (made) fs.rmSync(out, { recursive: true, force: true });
    fs.rmSync(work, { recursive: true, force: true });
  }
}

// ---- the live index ---------------------------------------------------------------------------------------------------------------------
/** The keys a live head verifies with: the pinned product index keys, or the `--key` files (at most 2, never a release key). */
export function indexKeys(keyFiles = []) {
  if (keyFiles.length > 0) return customKeys(keyFiles.map(f => path.resolve(f)), S, T);
  const keys = T.trustedKeys('index', false);
  return keys.length > 0 ? { keys } : { why: 'no index key is pinned in the vendored trustkeys.js' };
}

/** At most `max` requests per `windowMs` (plan 6.2: the zone blocks an address above 100 per 10 s; CI stays at half of it). */
export function pacer(max = 50, windowMs = 10_000) {
  const times = [];
  return async () => {
    for (;;) {
      const now = Date.now();
      while (times.length > 0 && now - times[0] >= windowMs) times.shift();
      if (times.length < max) { times.push(now); return; }
      await new Promise(r => setTimeout(r, windowMs - (now - times[0]) + 5));
    }
  };
}

const UA = 'EVE-Cyno-plugins-build';
async function getLive(url, max, pace, timeoutMs = I.INDEX_TIMEOUT_MS) {
  await pace();
  const chunks = [];
  const r = await fetchCapped(url, max, c => chunks.push(c), timeoutMs, UA);
  return r.ok ? { ok: true, bytes: Buffer.concat(chunks) } : r;
}

/**
 * The index served under `prefix` now, read as the app reads it: {status: 'missing'} (the head answers 404), {status: 'unreadable',
 * why} (the head cannot be read), {status: 'unverified', headBytes, why} (anything the keys or the app's parsers refuse, the catalog
 * included; headBytes: the head as served, unverified, for recovery R2's floor only), or {status: 'ok', headBytes, sigBytes, head,
 * catalogName, catalogBytes, catalog}.
 */
export async function readLive({ prefix, keys, pace = pacer() }) {
  const h = await getLive(`${prefix}index.json`, I.MAX_HEAD_BYTES, pace);
  if (!h.ok) return h.why === 'HTTP 404' ? { status: 'missing' } : { status: 'unreadable', why: `index.json: ${h.why}` };
  const s = await getLive(`${prefix}index.json.minisig`, I.MAX_INDEX_SIG_BYTES, pace);
  if (!s.ok) return { status: 'unverified', headBytes: h.bytes, why: `index.json.minisig: ${s.why}` };
  const v = I.verifyIndexHead(h.bytes, s.bytes.toString('utf8'), keys, prefix);
  if (!v.ok) return { status: 'unverified', headBytes: h.bytes, why: `the live head does not verify with the index keys (${v.reason})` };
  const catalogName = v.head.catalog.url.slice(prefix.length);
  const c = await getLive(v.head.catalog.url, v.head.catalog.size, pace);
  if (!c.ok) return { status: 'unverified', headBytes: h.bytes, why: `${catalogName}: ${c.why}` };
  if (!I.catalogMatches(c.bytes, v.head)) return { status: 'unverified', headBytes: h.bytes, why: `${catalogName}: its size or SHA-256 is not the one the live head names` };
  let catalog;
  try { catalog = I.parseCatalog(c.bytes, v.head, { prefix }); } catch (e) { return { status: 'unverified', headBytes: h.bytes, why: `${catalogName}: the app refuses it (${e?.message ?? 'bad_index'})` }; }
  return { status: 'ok', headBytes: h.bytes, sigBytes: s.bytes, head: v.head, catalogName, catalogBytes: c.bytes, catalog };
}

/** One live archive `name` (archives/<name>.zip) of `size` bytes into `file`, checked against `sha`: null, or why it failed. */
export async function fetchArchive(prefix, name, size, sha, file, pace) {
  const r = await getLive(`${prefix}${name}`, size, pace, 600_000);
  if (!r.ok) return `${name}: ${r.why}`;
  if (r.bytes.length !== size || sha256(r.bytes) !== sha) return `${name}: its size or SHA-256 is not the one the live catalog names`;
  fs.writeFileSync(file, r.bytes, { flag: 'wx' });
  return null;
}

/** The text a lift line and index-verify.mjs give a revocation: `<id> *` or `<id> <versions, sorted, joined by commas>`. */
export const revKey = (r) => `${r.id} ${r.versions === '*' ? '*' : [...r.versions].sort().join(',')}`;

/**
 * Where the catalog `catalog` (as the app parsed it) differs from the index main's tree `tree` (entries/, revoked.json) builds (plan
 * 4.3 and section 8, "Mirror divergence"; test MV-diverged): the revocations, the listing ids, and each listing's versions with their
 * archives' SHA-256, mapped as the build maps them (toIndexSource: unlisted and revoked versions left out). Listing texts (name,
 * summary and the like) are not compared. Returns the differences as lines, [] when the catalog is main's. A tree whose entries or
 * revoked.json cannot be read is one difference (fail closed). A re-sign keeps the live catalog as it is, so a difference means either
 * a publish still to do or an older verified head replayed into the mirror: re-signing it would make that head fresh again, and apps
 * would drop the revocations it lacks.
 */
export function treeDiff(tree, catalog) {
  const read = readEntries(path.join(tree, 'entries'));
  if (read.problems.length > 0) return [`main's entries cannot be read (${read.problems.slice(0, 3).map(p => `${p.file ?? ''} ${p.message}`.trim()).join('; ')})`];
  const rev = readJson(tree, 'revoked.json');
  if (!Array.isArray(rev.value)) return [`main's revoked.json: ${rev.why ?? (rev.missing ? 'missing' : 'not a JSON list')}`];
  const entries = read.entries.map(x => x.entry);
  let mainRevs, mainListings;
  try {
    mainRevs = new Set(rev.value.map(revKey));
    const src = toIndexSource(entries, rev.value, (id, version) => entries.find(e => e.id === id).versions.find(v => v.version === version).sha256);
    mainListings = new Map(src.plugins.map(l => [l.id, l.versions.map(v => ({ version: v.version, sha256: v.archive }))]));
  } catch (e) { return [`main's entries or revoked.json cannot be mapped to a catalog (${e?.message ?? 'error'})`]; }
  const liveRevs = new Set(catalog.revoked.map(revKey));
  const liveListings = new Map(catalog.plugins.map(l => [l.id, l.versions.map(v => ({ version: v.version, sha256: v.archive.sha256 }))]));
  const out = [
    ...[...mainRevs].filter(k => !liveRevs.has(k)).sort().map(k => `revocation on main only: ${k}`),
    ...[...liveRevs].filter(k => !mainRevs.has(k)).sort().map(k => `revocation live only: ${k}`),
    ...[...mainListings.keys()].filter(id => !liveListings.has(id)).sort().map(id => `listing on main only: ${id}`),
    ...[...liveListings.keys()].filter(id => !mainListings.has(id)).sort().map(id => `listing live only: ${id}`),
  ];
  const names = (vs) => vs.map(v => v.version).sort().join(', ');
  const keys = (vs) => vs.map(v => `${v.version} ${v.sha256}`).sort().join('\n');
  for (const [id, m] of [...mainListings].sort(([x], [y]) => (x < y ? -1 : 1))) {
    const l = liveListings.get(id);
    if (!l || keys(m) === keys(l)) continue;
    out.push(names(m) !== names(l) ? `listing ${id}: the versions differ (main: ${names(m)}; live: ${names(l)})` : `listing ${id}: the archives of its versions differ`);
  }
  return out;
}
