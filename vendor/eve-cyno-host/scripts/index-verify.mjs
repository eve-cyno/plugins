#!/usr/bin/env node
// Verifies a plugin index (R20-R23), before and after the upload:
//   node scripts/index-verify.mjs <index folder> [--test-key] [--archives]   the folder index-build.mjs wrote, with index.json.minisig from release-sign.sh
//   node scripts/index-verify.mjs --live [--test-key] [--archives]           what https://plugins.eve-cyno.dev/v1/ serves now (reads only)
//   node scripts/index-verify.mjs <index folder> --live [--test-key] [--archives]   the folder, then the folder against what is served now (check 7)
// The checks, in the app's own order and with the app's own code (host/dist, market/indexformat.js):
//  1. index.json and index.json.minisig within their caps (16 KiB each);
//  2. the head's minisign signature with the INDEX keys only, never a release key: the product's keys pinned in trustkeys.ts, or with
//     --test-key the committed TEST index key and nothing else; then the head parser, and the trusted comment, which must be
//     `eve-cyno-index v1 <generated>` of the parsed head;
//  3. the head's `generated` is not in the future (more than 5 minutes ahead of this machine's clock, and with --live of the server's
//     Date header: a future head would hold every later one back as a rollback in the app), and the head has not expired;
//  4. the catalog it names: its size and SHA-256 against the head before it is parsed, the catalog parser, and no listing dropped, no
//     type ignored and no category removed (the app is lenient there; a published index never relies on it); no listing the app's
//     admission drops (market/wire.ts listingAdmit, the catalog parser's `admit`: an id that starts with a Windows device name, a name or
//     author that reads as the host's unless the listing is first-party);
//  5. each archive a listing names: its size and SHA-256 (the copy in archives/; with --live the published bytes, streamed and hashed,
//     never saved), each archive read once and dropped before the next (release-lib.mjs verifyArchives); with --archives also its
//     contents, read as the app reads them (the zip reader, R25): a plugin's archive goes through the installer's own staged checks
//     (market/stagecheck.ts) in a temp folder removed at once: plugin.json at the root, the unpacked plugin.json within the loader's 256 KiB
//     cap, parsed, its id, version, name, author, engines and permissions equal to the listing's (both normalised: listingDifference), and
//     the loader's checks of the folder (inspectPluginDir: `main` a regular file inside it, no link, no hard link); a theme's theme.json
//     (and LICENSE, nothing else), parsed, as listed;
//  6. --live only: index.json and index.json.minisig are served with `Cache-Control: no-cache`.
//  7. a folder with --live: the folder against the index served now (reads only: the live head and signature verified with the same keys, the
//     one catalog that head names). FAIL when the folder's head or catalog `generated` is older than the live one (a stale folder, re-signed
//     or not, is a rollback for every app that holds the live one: it refuses the head and keeps installs and updates off), or when it has the
//     live `generated` with another catalog. WARN (the exit code is unchanged) for each live revocation the folder does not have: uploading it
//     lifts that revocation. HTTP 404 on the live head is a first publish: nothing to compare with, a NOTE. Any other failure to read the live
//     index is a FAIL (the folder could not be compared).
// Every check prints PASS or FAIL naming its file. Exit 0 only when every check passed; 1 when one failed (or a secret key was found);
// 2 for usage. --live writes nothing but that temp folder. EVECYNO_TEST_INDEX_BASE (an http://127.0.0.1:<port>/v1/ URL) serves --live from a local test
// server and is accepted only together with --live and --test-key.
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ROOT, fetchCapped, hashFile, loadHost, loadHostMarket, noCache, refuseSecretKeys, verifyArchives } from './release-lib.mjs';

const usage = (why) => {
  if (why) console.error(why);
  console.error('usage: node scripts/index-verify.mjs <index folder> [--test-key] [--archives]\n       node scripts/index-verify.mjs <index folder> --live [--test-key] [--archives]   (also compares with the published index)\n       node scripts/index-verify.mjs --live [--test-key] [--archives]');
  process.exit(2);
};
const args = process.argv.slice(2);
let testKey = false, live = false, archives = false, dirArg = null;
for (const a of args) {
  if (a === '--test-key') { if (testKey) usage(); testKey = true; }
  else if (a === '--archives') { if (archives) usage(); archives = true; }
  else if (a === '--live') { if (live) usage(); live = true; }
  else if (a.startsWith('--') || dirArg !== null) usage();
  else dirArg = a;
}
if (!live && dirArg === null) usage();
// `<folder> --live` verifies the folder and compares it with the published index; `--live` alone verifies the published files.
const compare = live && dirArg !== null;
const liveSrc = live && !compare;
const testBase = process.env.EVECYNO_TEST_INDEX_BASE;
if (testBase !== undefined && !(live && testKey)) usage('EVECYNO_TEST_INDEX_BASE works only with --live and --test-key');
if (testBase !== undefined) {
  let u = null;
  try { u = new URL(testBase); } catch { /* checked below */ }
  if (!u || u.protocol !== 'http:' || u.hostname !== '127.0.0.1' || !u.port || u.pathname !== '/v1/' || u.search || u.hash || u.username || u.password || u.href !== testBase) {
    usage('EVECYNO_TEST_INDEX_BASE must be http://127.0.0.1:<port>/v1/');
  }
}

const { indexformat: I, minisign: S, trustkeys: T } = loadHost();
const M = loadHostMarket();
const dir = dirArg !== null ? path.resolve(dirArg) : null;
refuseSecretKeys(dir !== null ? [dir] : []);

let failed = 0, generated = null;
const pass = (what) => console.log(`PASS ${what}`);
const bad = (what, why) => { failed++; console.log(`FAIL ${what}: ${why}`); };
const finish = () => {
  console.log(failed ? `INDEX VERIFY FAILED ${failed}${generated ? ` (${generated})` : ''}` : `INDEX VERIFY OK ${generated}`);
  process.exit(failed ? 1 : 0);
};

let keys;
if (testKey) {
  keys = [S.parsePublicKey(fs.readFileSync(path.join(ROOT, 'host', 'test', 'keys', 'test-index.pub'), 'utf8'))];
  console.log(`NOTE --test-key: verifying with the committed TEST index key ${keys[0].keyId} only; no product build trusts it`);
} else {
  keys = T.trustedKeys('index', false);
  if (keys.length === 0) { bad('index keys', 'no index key is pinned in this build (PRODUCT_KEYS.index in host/src/trustkeys.ts is empty)'); finish(); }
}

// ---- reading: the local folder, or the published files ----------------------------------------------------------------------------------
const P = I.MARKET_URL_PREFIX;
const toServer = (url) => (testBase !== undefined ? testBase + url.slice(P.length) : url);
const get = (url, max, onChunk, timeoutMs) => fetchCapped(toServer(url), max, onChunk, timeoutMs, 'EVE-Cyno-index-verify');
/** A file of the index by its path under the prefix (`index.json`, `catalog/<sha>.json`): its bytes, at most `max`, or null (FAIL printed). */
const served = {}; // --live: the Date header each file was served with
async function readFile(name, max, { needNoCache = false } = {}) {
  if (liveSrc) {
    const chunks = [];
    const r = await get(P + name, max, c => chunks.push(c), I.INDEX_TIMEOUT_MS);
    if (!r.ok) { bad(name, r.why); return null; }
    served[name] = r.date;
    if (needNoCache) {
      if (noCache(r.cacheControl)) pass(`${name} is served with Cache-Control: no-cache`);
      else bad(name, `served with Cache-Control "${r.cacheControl}", not no-cache (upload it again with --cache-control=no-cache)`);
    }
    return Buffer.concat(chunks);
  }
  const f = path.join(dir, ...name.split('/'));
  let st;
  try { st = fs.lstatSync(f); } catch { bad(name, 'missing'); return null; }
  if (!st.isFile()) { bad(name, 'not a regular file'); return null; }
  if (st.size > max) { bad(name, `too large (over ${max} bytes)`); return null; }
  return fs.readFileSync(f);
}
/** An archive's size and SHA-256; with --archives also its bytes (at most the listed size: the catalog caps it at 32 MiB). */
async function archiveDigest(name, size) {
  if (liveSrc) {
    const h = crypto.createHash('sha256'), chunks = [];
    const r = await get(P + name, size, c => { h.update(c); if (archives) chunks.push(c); }, 10 * 60_000);
    return r.ok ? { size: r.size, sha256: h.digest('hex'), ...(archives ? { bytes: Buffer.concat(chunks) } : {}) } : { why: r.why };
  }
  const f = path.join(dir, ...name.split('/'));
  let st;
  try { st = fs.lstatSync(f); } catch { return { why: 'missing from the index folder' }; }
  if (!st.isFile()) return { why: 'not a regular file' };
  if (!archives) return hashFile(f);
  if (st.size > size) return { size: st.size, sha256: '' }; // reported as a size mismatch below; never read past the listed size
  const bytes = fs.readFileSync(f);
  return { size: bytes.length, sha256: crypto.createHash('sha256').update(bytes).digest('hex'), bytes };
}

/**
 * --archives: what in the archive `bytes` differs from the listing `l` at version `v`, as the app's installer would see it (R25, R26), or
 * null when it holds the plugin or theme package as listed.
 */
function contentsProblem(bytes, l, v) {
  const z = M.zipread.readZip(bytes);
  if (!z.ok) return `the app refuses the archive (${z.reason})`;
  const file = (n) => z.entries.find(e => e.name === n && !e.dir)?.data ?? null;
  if (l.type === 'theme') {
    const json = file('theme.json');
    if (json === null || z.entries.some(e => e.dir || (e.name !== 'theme.json' && e.name !== 'LICENSE'))) return 'a theme archive holds theme.json and LICENSE only';
    let pkg;
    try { pkg = M.themePackage.parsePackage(json); } catch (e) { return `the app refuses its theme.json (${e?.message ?? 'bad'})`; }
    const d = I.themeListingDifference(pkg, l, v);
    return d === null ? null : `its theme.json ${d} differs from the listing`;
  }
  // The installer's own staged checks (market/stagecheck.ts), on the archive unpacked into a temp folder that goes at once.
  let tmp;
  try { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'evecyno-index-verify-')); } catch (e) { return `no temp folder to unpack it in (${e?.code ?? 'error'})`; }
  try {
    const c = M.stagecheck.checkStagedPlugin(z.entries, tmp, l, v);
    return c.ok ? null : c.why;
  } finally {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) { console.log(`NOTE a temp folder of index-verify could not be removed (${e?.code ?? 'error'})`); }
  }
}

// ---- 1-3: the head ----------------------------------------------------------------------------------------------------------------------
const headBytes = await readFile('index.json', I.MAX_HEAD_BYTES, { needNoCache: true });
const sigBytes = await readFile('index.json.minisig', I.MAX_INDEX_SIG_BYTES, { needNoCache: true });
if (!headBytes || !sigBytes) finish();
const sigText = sigBytes.toString('utf8');
const WHY = {
  unknown_key: 'signed with a key that is not an index key here (a release key, the test key or an unknown key)',
  bad_signature: 'the signature does not match index.json (was it changed after signing?)',
  bad_trusted_comment: 'the trusted comment was changed after signing',
  legacy_algorithm: 'a legacy signature: sign again without -l (minisign signs prehashed by default)',
  malformed: 'not a minisign signature',
};
const checked = I.verifyIndexHead(headBytes, sigText, keys, P);
if (!checked.ok) {
  // The same checks again, one by one, to say which one failed.
  const v = S.verifyMinisign(headBytes, sigText, keys);
  let parsed = null, why = '';
  try { parsed = I.parseIndexHead(headBytes, P); } catch (e) { why = e?.message ?? 'bad_index'; }
  if (checked.reason === 'too_large') {
    // Both files are read within their caps, so this is a signature that grew when decoded, or a catalog declared over 4 MiB.
    if (Buffer.byteLength(sigText, 'utf8') > I.MAX_INDEX_SIG_BYTES) bad('index.json.minisig', `too large (over ${I.MAX_INDEX_SIG_BYTES} bytes as text)`);
    else bad('index.json', `the app refuses it (${why || 'too large'})`);
  } else if (!v.ok) bad('signature of index.json', WHY[v.reason] ?? v.reason);
  else if (!parsed) bad('index.json', `the app refuses it (${why})`);
  else bad('signature of index.json', `the trusted comment "${v.trusted}" is not "${I.indexComment(parsed.generated)}"`);
  finish();
}
const head = checked.head;
generated = head.generated;
pass(`signature of index.json (index key ${checked.keyId})`);
pass('index.json parses (schema 1)');
pass(`trusted comment "${I.indexComment(head.generated)}"`);
// A head dated ahead would hold every later index back as a rollback in the app (R23): never ahead of this machine's clock, nor with
// --live of the server's (its Date header), by more than AHEAD_MS.
const AHEAD_MS = 300_000;
const g = Date.parse(head.generated);
if (g > Date.now() + AHEAD_MS) bad('index.json', `generated ${head.generated} is in the future by this machine's clock (more than 5 minutes ahead)`);
else pass(`index.json generated ${head.generated}, not ahead of this machine's clock`);
if (liveSrc) {
  const d = Date.parse(served['index.json'] ?? '');
  if (!Number.isFinite(d)) bad('index.json', 'served without a Date header to check its generated against');
  else if (g > d + AHEAD_MS) bad('index.json', `generated ${head.generated} is in the future by the server's clock (Date: ${new Date(d).toISOString()})`);
  else pass(`index.json generated ${head.generated}, not ahead of the server's clock`);
}
const left = Date.parse(head.expires) - Date.now();
if (left > 0) pass(`index.json expires ${head.expires} (in ${Math.floor(left / 86_400_000)} days)`);
else bad('index.json', `expired at ${head.expires}: build and sign a new head (docs/release-checklist.md, "The plugin index")`);

// ---- 4: the catalog ---------------------------------------------------------------------------------------------------------------------
const catName = head.catalog.url.slice(P.length); // catalog/<sha256>.json: the head's URL is P + that, checked by the parser
const catBytes = await readFile(catName, head.catalog.size);
if (!catBytes) finish();
if (!I.catalogMatches(catBytes, head)) { bad(catName, 'its size or SHA-256 does not match the signed head'); finish(); }
let cat;
try { cat = I.parseCatalog(catBytes, head, { prefix: P }); } catch (e) { bad(catName, `the app refuses it (${e?.message ?? 'bad_index'})`); finish(); }
// A published index relies on none of the parser's lenient rules: no listing dropped, no type ignored, no category removed.
const raw = JSON.parse(catBytes.toString('utf8')).plugins; // parsed once already: it is JSON with a plugins list
const idOf = (l, i) => (typeof l?.id === 'string' && /^[a-z0-9.-]{1,100}$/.test(l.id) ? l.id : `plugins[${i}]`);
const isObj = (v) => typeof v === 'object' && v !== null && !Array.isArray(v);
const before = failed;
if (cat.dropped > 0) {
  const named = raw.map((l, i) => [l, i]).filter(([l]) => I.listingProblem(l, P) !== null).map(([l, i]) => `${idOf(l, i)} (${I.listingProblem(l, P)})`);
  bad(catName, `the app drops ${cat.dropped} listing${cat.dropped === 1 ? '' : 's'}: ${named.join(', ')}`);
}
for (const [i, l] of raw.entries()) {
  if (!isObj(l) || typeof l.type !== 'string') continue;
  if (l.type !== 'plugin' && l.type !== 'theme') bad(catName, `the app ignores the listing ${idOf(l, i)} (its type is not plugin or theme)`);
  else if (I.listingProblem(l, P) === null && l.categories.some(c => !I.CATEGORIES.includes(c))) bad(catName, `the app removes a category it does not know from the listing ${idOf(l, i)}`);
}
// The app's admission of a listing (the same function the app passes to parseCatalog as `admit`).
for (const l of cat.plugins) {
  if (M.wire.listingAdmit(l)) continue;
  bad(catName, `the app drops the listing ${l.id} (${M.zipread.isDeviceNameId(l.id) ? 'its id starts with a Windows device name' : 'its name or author reads as the host\'s'})`);
}
if (failed === before) pass(`${catName} (${cat.plugins.length} listings, ${cat.revoked.length} revocations; none dropped, ignored or changed)`);

// ---- 5: the archives the kept listings name ---------------------------------------------------------------------------------------------
// Each archive URL (archives/<name>: checked by the parser) read once and checked for every listing version naming it, then dropped.
await verifyArchives(cat.plugins, P, { digest: archiveDigest, ...(archives ? { contents: contentsProblem } : {}), pass, bad });

// ---- 7: a folder against the published index (--live with a folder) -------------------------------------------------------------------------
/** The live file `name` (at most `max` bytes), or {why}. */
async function readLive(name, max) {
  const chunks = [];
  const r = await get(P + name, max, c => chunks.push(c), I.INDEX_TIMEOUT_MS);
  return r.ok ? Buffer.concat(chunks) : { why: r.why };
}
const revKey = (r) => `${r.id} ${r.versions === '*' ? '*' : [...r.versions].sort().join(',')}`;
async function compareWithLive() {
  const lh = await readLive('index.json', I.MAX_HEAD_BYTES);
  if (!Buffer.isBuffer(lh)) {
    if (lh.why === 'HTTP 404') console.log('NOTE live index.json: HTTP 404, no index is published yet: nothing to compare the folder with');
    else bad('live index.json', `cannot be read (${lh.why}): the folder cannot be compared with the published index`);
    return;
  }
  const ls = await readLive('index.json.minisig', I.MAX_INDEX_SIG_BYTES);
  if (!Buffer.isBuffer(ls)) { bad('live index.json.minisig', `cannot be read (${ls.why}): the folder cannot be compared with the published index`); return; }
  const lv = I.verifyIndexHead(lh, ls.toString('utf8'), keys, P);
  if (!lv.ok) { bad('live index.json', `does not verify with these keys (${lv.reason}): the folder cannot be compared with the published index`); return; }
  const live = lv.head;
  const lcName = live.catalog.url.slice(P.length);
  const lc = await readLive(lcName, live.catalog.size);
  if (!Buffer.isBuffer(lc)) { bad(`live ${lcName}`, `cannot be read (${lc.why}): the folder cannot be compared with the published index`); return; }
  if (!I.catalogMatches(lc, live)) { bad(`live ${lcName}`, 'its size or SHA-256 does not match the published head'); return; }
  let lcat;
  try { lcat = I.parseCatalog(lc, live, { prefix: P }); } catch (e) { bad(`live ${lcName}`, `the app refuses it (${e?.message ?? 'bad_index'})`); return; }
  const rollback = 'uploading it is a rollback: an app that holds the published index refuses it and keeps installs and updates off. Build a new index from the published one (index-build.mjs --resign <published folder>) or from a current source';
  const dh = Date.parse(head.generated) - Date.parse(live.generated);
  const before = failed;
  if (dh < 0) bad('index.json', `generated ${head.generated} is older than the published index (${live.generated}): ${rollback}`);
  else if (dh === 0 && head.catalog.sha256 !== live.catalog.sha256) bad('index.json', `has the published generated (${live.generated}) with another catalog: ${rollback}`);
  if (Date.parse(cat.generated) < Date.parse(lcat.generated)) bad(catName, `its generated ${cat.generated} is older than the published catalog's (${lcat.generated}): ${rollback}`);
  if (failed === before) pass(`not older than the published index (${live.generated})`);
  const have = new Set(cat.revoked.map(revKey));
  const missing = lcat.revoked.filter(r => !have.has(revKey(r)));
  for (const r of missing) console.log(`WARN the published index revokes ${JSON.stringify(r.id)} (${r.versions === '*' ? 'all versions' : `versions ${JSON.stringify(r.versions)}`}); this folder does not: uploading it lifts that revocation`);
  if (missing.length === 0) pass(`every published revocation is in the folder (${lcat.revoked.length})`);
}
if (compare) await compareWithLive();
finish();
