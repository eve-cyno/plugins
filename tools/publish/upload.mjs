#!/usr/bin/env node
// tools/publish/upload.mjs: the upload step of the upload jobs of publish.yml and resign.yml (plan 4.2 job upload, 4.3, 6.4), run in
// the environment mirror after the reviewer account's approval. It writes the signed index into the R2 bucket behind
// plugins.eve-cyno.dev and never signs.
//   node tools/publish/upload.mjs --target production|test --repair true|false --in <folder> [--summary <file>]   (publish.yml)
//   node tools/publish/upload.mjs --resign --in <folder> [--summary <file>]                                        (resign.yml)
// For tests only: --prefix <URL> (a local server), --key <pub>... (target production: instead of the pinned index keys),
// --archive-cache <dir> (archives by SHA-256, read before an author's URL).
//
// <folder> holds the run's artifacts: index.json, index.json.minisig, catalog/<sha256>.json, archives.json and, for target test, the
// run's throwaway public key test.pub. Steps, in this order:
//  1. The R2 values and GH_TOKEN are taken out of the environment (tools/lib/r2.mjs); --repair true (recovery R2) is for target
//     production only.
//  2. The inputs: the head's SHA-256 is HEAD_SHA256 (the one the build job showed), the head is at most 7 days old, at most 5 minutes
//     ahead and lives 60 days; the signature verifies it (the pinned index keys; target test: test.pub only); the catalog and the
//     archive list are exactly the ones it names.
//  3. The runner image: aws-cli version 2 whose s3api put-object takes --if-match and --if-none-match. Then the mirror's values.
//  4. The live pair (head and signature, at most 16,384 bytes each, with their ETags), read before any write and kept. Production and
//     resign: it must verify with the pinned keys and the new head must not be older (LIVE UNVERIFIED otherwise; recovery R2). A
//     missing head is a first publish only when GitHub shows no run with an approved index and successful sign and upload
//     (tools/approved-base.mjs, fail closed; never for resign). Target test: the earlier test pair is not checked. --repair true
//     (recovery R2, plan 4.2): a live pair that verifies is refused (NOT BROKEN); else the base is computed again from the candidate
//     runs' artifacts (tools/lib/repairbase.mjs, GH_TOKEN with actions: read; a missing artifact or no verified candidate stops the
//     run), the new head must be newer than the floor and its catalog not older than the base's, and every revocation of the union
//     that the new catalog drops is a WARN note (the build job's compare required its lift line). R1 never restores in a repair.
//  5. Each archive from the mirror when it is there (its SHA-256 checked: other bytes under its name stop the run), else the cache,
//     else its author's URL (C4, C5). The vendored index-verify.mjs checks the whole folder with --archives and, for production and
//     resign but not a repair, with --live (rollback and lifts against what is served: three reads).
//  6. publish only: the archives, then the catalog, create-only (If-None-Match: *; a 412 is "already mirrored", the mirror's copy
//     read back when it was not read in step 5); Cache-Control immutable.
//  7. The signature with If-Match on the live signature's ETag (If-None-Match: * when there is none), then the head with If-Match on
//     the live head's ETag (If-None-Match: * on a first publish); Cache-Control no-cache. Recovery R1 (plan 4.2): a write that fails
//     after its one retry, or answers 412, is followed by a re-read of that object before anything else; a head that did not land
//     puts the old signature back with If-Match on the new one's ETag (production and resign only, never on a first publish or a
//     repair: their old pair never verified).
//  8. Every exit after step 7 began re-reads both objects and verifies the pair: PUBLISHED (exit 0), else UNCHANGED, FIRST-PUBLISH
//     ORPHAN, TEST NOT PUBLISHED, REPLAYED or HALF-PUBLISHED (exit 1; docs/RUNBOOK.md, "When a run is red").
// Exit 0 published, 1 refused or not published, 2 usage.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { createRequire } from 'node:module';
import { createReport } from '../lib/summary.mjs';
import { PREFIXES, ROOT, headBoundsProblem, indexKeys, obtainArchive, prefixProblem, refusalLines, revKey, runVendored, sha256 } from '../lib/indexbuild.mjs';
import { IMMUTABLE, NO_CACHE, r2Client, takeCredentials } from '../lib/r2.mjs';

// Step 1: nothing below, and no child, sees the mirror's values or the GitHub token in the environment.
const taken = takeCredentials(process.env);
const ghToken = process.env.GH_TOKEN;
delete process.env.GH_TOKEN;

const require = createRequire(import.meta.url);
const I = require(path.join(ROOT, 'vendor', 'eve-cyno-host', 'host', 'dist', 'market', 'indexformat.js'));
const R2 = 'recovery R2 (docs/RUNBOOK.md): the coordinator confirms it with index-verify.mjs --live --archives, then publish.yml with repair';
const USAGE = [
  'usage: node tools/publish/upload.mjs --target production|test --repair true|false --in <folder> [--summary <file>]',
  '       node tools/publish/upload.mjs --resign --in <folder> [--summary <file>]',
  '       tests only: [--prefix <URL>] [--key <pub>...] [--archive-cache <dir>]',
].join('\n');
const usage = (why) => { if (why) console.error(why); console.error(USAGE); process.exit(2); };

let a;
try {
  a = parseArgs({
    args: process.argv.slice(2), strict: true, allowPositionals: false,
    options: { target: { type: 'string' }, repair: { type: 'string' }, resign: { type: 'boolean' }, in: { type: 'string' }, summary: { type: 'string' },
      prefix: { type: 'string' }, key: { type: 'string', multiple: true }, 'archive-cache': { type: 'string' } },
  }).values;
} catch (e) { usage(e.message); }
const resign = a.resign === true;
if (resign && (a.target !== undefined || a.repair !== undefined)) usage('--resign takes no --target and no --repair');
if (!resign && (a.target !== 'production' && a.target !== 'test')) usage('--target: production or test');
if (!resign && a.repair !== 'true' && a.repair !== 'false') usage('--repair: true or false');
if (typeof a.in !== 'string' || a.in === '') usage('--in <folder> is required');
const target = resign ? 'production' : a.target;
if (target === 'test' && a.key) usage('--key: target test verifies with the run\'s throwaway key, test.pub in the input folder');
if (a.prefix !== undefined && prefixProblem(a.prefix)) usage(`--prefix: ${prefixProblem(a.prefix)}`);
const P = a.prefix ?? PREFIXES[target];
const KEY_PREFIX = new URL(P).pathname.slice(1); // v1/ or test/v1/: the object keys are the URL paths
const K = (name) => KEY_PREFIX + name;
const HEAD_KEY = K('index.json'), SIG_KEY = K('index.json.minisig');
const IN = path.resolve(a.in);

const R = createReport();
const title = `tools/publish/upload.mjs ${resign ? 'resign' : `${target}${a.repair === 'true' ? ' repair' : ''}`}`;
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'evecyno-upload-'));
fs.chmodSync(work, 0o700);
function end(code, verdict) {
  R.finish(verdict, { title, file: a.summary });
  fs.rmSync(work, { recursive: true, force: true });
  process.exit(code);
}
/** Ends the run refused. `wrote` says whether content-addressed files were written (the pair never was). */
function refuse(why, wrote = false) {
  console.error(`REFUSED: ${why}`);
  R.fail('upload', why);
  end(1, `REFUSED: the head and its signature were not written${wrote ? ' (content-addressed files may have been)' : ''}`);
}

const repair = a.repair === 'true';
if (repair && target === 'test') refuse('repair is for target production only');

// ---- 2: the inputs -----------------------------------------------------------------------------------------------------------------------
/** A regular file of the input folder at the path `rel`, at most `max` bytes: its bytes, or the run is refused. */
function input(rel, max) {
  const f = path.join(IN, ...rel.split('/'));
  let st;
  try { st = fs.lstatSync(f); } catch { refuse(`${rel} is not in the input folder`); }
  if (!st.isFile()) refuse(`${rel} in the input folder is not a regular file`);
  if (st.size > max) refuse(`${rel} in the input folder is over ${max} bytes`);
  return fs.readFileSync(f);
}
const headBytes = input('index.json', I.MAX_HEAD_BYTES);
const want = process.env.HEAD_SHA256 ?? '';
if (!/^[0-9a-f]{64}$/.test(want)) refuse('HEAD_SHA256 (the SHA-256 the build job showed) is not set');
if (sha256(headBytes) !== want) refuse(`the head's SHA-256 is ${sha256(headBytes)}, not ${want}, the one the build job showed`);
const bound = headBoundsProblem(headBytes, P);
if (bound) refuse(`${bound}; a late mirror approval never uploads an old head: dispatch a new run`);
const head = I.parseIndexHead(headBytes, P);
const sigBytes = input('index.json.minisig', I.MAX_INDEX_SIG_BYTES);
const keyFiles = target === 'test' ? [path.join(IN, 'test.pub')] : (a.key ?? []).map(k => path.resolve(k));
if (target === 'test' && !fs.existsSync(keyFiles[0])) refuse('target test: the run\'s throwaway public key test.pub is not in the input folder');
const keyed = indexKeys(keyFiles);
if (keyed.why) refuse(keyed.why);
const keys = keyed.keys;
const keyText = target === 'test' ? 'the run\'s throwaway key (test.pub)' : a.key ? 'the --key keys' : 'the pinned index keys';
const verifies = (h, s) => I.verifyIndexHead(h, s.toString('utf8'), keys, P).ok;
if (!verifies(headBytes, sigBytes)) refuse(`the signature does not verify the head with ${keyText}`);
const catalogName = head.catalog.url.slice(P.length);
let catFiles = [];
try { catFiles = fs.readdirSync(path.join(IN, 'catalog')); } catch { /* below */ }
if (catFiles.length !== 1 || `catalog/${catFiles[0]}` !== catalogName) refuse(`the catalog folder must hold exactly ${catalogName}, the catalog the head names`);
const catBytes = input(catalogName, head.catalog.size);
if (!I.catalogMatches(catBytes, head)) refuse(`${catalogName}: its size or SHA-256 is not the one the head names`);
let cat;
try { cat = I.parseCatalog(catBytes, head, { prefix: P }); } catch (e) { refuse(`${catalogName}: the app refuses it (${e?.message ?? 'bad_index'})`); }
const named = new Map();
for (const l of cat.plugins) for (const v of l.versions) named.set(v.archive.url.slice(P.length), { sha256: v.archive.sha256, size: v.archive.size });
let list;
try { list = JSON.parse(input('archives.json', I.MAX_CATALOG_BYTES).toString('utf8')); } catch { refuse('archives.json is not JSON'); }
const SHA_RE = /^[0-9a-f]{64}$/;
if (!Array.isArray(list) || list.length !== named.size) refuse(`archives.json must list the ${named.size} archives the catalog names`);
for (const x of list) {
  const n = x && typeof x.name === 'string' ? named.get(x.name) : undefined;
  if (!n || x.sha256 !== n.sha256 || x.size !== n.size || !SHA_RE.test(x.sha256) || x.name !== `archives/${x.sha256}.zip` || typeof x.url !== 'string') {
    refuse(`archives.json: ${JSON.stringify(x?.name ?? x)} is not an archive the catalog names, with its SHA-256 and size`);
  }
}
list.sort((x, y) => (x.name < y.name ? -1 : 1));
if (new Set(list.map(x => x.name)).size !== list.length) refuse('archives.json names an archive twice');
R.pass('input', `head sha256 ${want}, generated ${head.generated}, expires ${head.expires}; the signature verifies with ${keyText}; ${catalogName}; ${list.length} archives`);

// ---- 3: the runner image and the mirror's values -----------------------------------------------------------------------------------------
if (taken.why) refuse(taken.why);
const r2 = r2Client(taken.creds, { workDir: work });
const cli = await r2.checkCli();
if (cli.why) refuse(`the runner image: ${cli.why}`);
R.pass('aws', `aws-cli ${cli.version}: s3api put-object takes --if-match and --if-none-match`);

// ---- 4: the live pair, read before any write -------------------------------------------------------------------------------------------------
const oldHead = await r2.get(HEAD_KEY, I.MAX_HEAD_BYTES);
const oldSig = await r2.get(SIG_KEY, I.MAX_INDEX_SIG_BYTES);
let firstPublish = false;
if (oldHead.status === 'error') refuse(`the live head cannot be read (${oldHead.why}): nothing was written; dispatch again later`);
if (oldSig.status === 'error') refuse(`the live signature cannot be read (${oldSig.why}): nothing was written; dispatch again later`);
if (target === 'test') {
  R.note(`target test: the live test pair is ${oldHead.status === 'missing' ? 'missing (a first test publish)' : 'not checked (an earlier run\'s throwaway key) and is replaced on its ETags'}`);
} else if (repair) {
  if (oldHead.status === 'ok' && oldSig.status === 'ok' && verifies(oldHead.bytes, oldSig.bytes)) {
    refuse(`NOT BROKEN: the live head and signature verify with ${keyText}; repair (recovery R2) is only for a live index that does not verify: dispatch publish.yml without repair`);
  }
  const runId = process.env.GITHUB_RUN_ID ?? '';
  if (!/^[1-9][0-9]{0,15}$/.test(runId)) refuse('REPAIR: no run id (GITHUB_RUN_ID) is set to find the candidate runs (fail closed)');
  R.note(`REPAIR: the live head ${oldHead.status === 'missing' ? 'is missing' : 'and signature do not verify'}; the base comes from the candidate runs' artifacts, computed again here`);
  const { repairBase } = await import('../lib/repairbase.mjs');
  const rb = await repairBase({ runId: Number(runId), env: { ...process.env, ...(ghToken ? { GH_TOKEN: ghToken } : {}) }, keys, prefix: P,
    liveHead: oldHead.status === 'ok' ? oldHead.bytes : null });
  for (const l of rb.lines) R.note(`repair: ${l}`);
  if (!rb.ok) refuse(rb.why);
  if (Date.parse(head.generated) <= Date.parse(rb.floor.generated)) {
    refuse(`the new head (${head.generated}) is not newer than the repair floor (${rb.floor.generated}, from ${rb.floor.source}): a rollback; dispatch a new repair run`);
  }
  if (Date.parse(cat.generated) < Date.parse(rb.base.catalog.generated)) {
    refuse(`the new catalog (${cat.generated}) is older than the base catalog (${rb.base.catalog.generated}, run ${rb.base.run}): a rollback`);
  }
  const have = new Set(cat.revoked.map(revKey));
  for (const r of rb.union) if (!have.has(revKey(r))) R.note(`WARN uploading it lifts the revocation ${revKey(r)} (the build job's compare let it through: the lift input named it)`);
  R.pass('live', `REPAIR: the base is run ${rb.base.run}'s verified head (generated ${rb.base.head.generated}); the new head is newer than the floor ${rb.floor.generated}; it replaces the live pair on its ETags`);
} else if (oldHead.status === 'missing') {
  if (resign) refuse(`the live head is missing: resign never makes a first publish or repairs (publish.yml, or ${R2})`);
  const runId = process.env.GITHUB_RUN_ID ?? '';
  if (!/^[1-9][0-9]{0,15}$/.test(runId)) refuse(`LIVE UNVERIFIED: the live head is missing and no run id (GITHUB_RUN_ID) is set to ask GitHub whether this is a first publish (fail closed); ${R2}`);
  const { approvedBase } = await import('../approved-base.mjs');
  const q = await approvedBase({ runId: Number(runId), repoDir: ROOT, env: { ...process.env, ...(ghToken ? { GH_TOKEN: ghToken } : {}) } });
  for (const l of q.lines) R.note(`approved-base: ${l}`);
  if (q.code !== 3) refuse(`LIVE UNVERIFIED: the live head is missing, but GitHub shows an approved run or could not be asked (approved-base exit ${q.code}): a deleted head; ${R2}`);
  firstPublish = true;
  R.note(`first publish: no live head, and no run has an approved index with successful sign and upload; ${oldSig.status === 'missing' ? 'no signature' : 'an orphan signature of an earlier first publish'} is live`);
} else {
  if (oldHead.status !== 'ok' || oldSig.status !== 'ok' || !verifies(oldHead.bytes, oldSig.bytes)) {
    refuse(`LIVE UNVERIFIED: the live head and signature do not verify with ${keyText}; ${R2}`);
  }
  const live = I.parseIndexHead(oldHead.bytes, P);
  const dg = Date.parse(head.generated) - Date.parse(live.generated);
  if (dg < 0 || (dg === 0 && head.catalog.sha256 !== live.catalog.sha256)) refuse(`the new head (${head.generated}) is older than the live head (${live.generated}), or the same time with another catalog: a rollback`);
  if (resign && JSON.stringify(head.catalog) !== JSON.stringify(live.catalog)) refuse('resign: the new head names another catalog than the live head');
  R.pass('live', `the live pair verifies (generated ${live.generated}); the new head replaces it on its ETags`);
}

// ---- 5: the archives and the whole folder ------------------------------------------------------------------------------------------------
const stage = path.join(work, 'index');
fs.mkdirSync(path.join(stage, 'catalog'), { recursive: true });
fs.mkdirSync(path.join(stage, 'archives'));
const staged = (name) => path.join(stage, ...name.split('/'));
fs.writeFileSync(staged('index.json'), headBytes);
fs.writeFileSync(staged('index.json.minisig'), sigBytes);
fs.writeFileSync(staged(catalogName), catBytes);
const cache = a['archive-cache'] ? path.resolve(a['archive-cache']) : path.join(work, 'cache');
fs.mkdirSync(cache, { recursive: true });
const readInMirror = new Set();
const swapped = (name) => `the mirror holds another file under ${name} (not the size and SHA-256 the catalog names): swapped in R2; the owner looks into it before anything is published`;
for (const x of list) {
  const m = await r2.get(K(x.name), x.size);
  if (m.status === 'error') refuse(`${x.name}: the mirror cannot be read (${m.why}): dispatch again later`);
  if (m.status === 'too-large' || (m.status === 'ok' && (m.bytes.length !== x.size || sha256(m.bytes) !== x.sha256))) refuse(swapped(x.name));
  if (m.status === 'ok') {
    fs.writeFileSync(staged(x.name), m.bytes);
    readInMirror.add(x.name);
    continue;
  }
  const got = await obtainArchive({ url: x.url, sha256: x.sha256 }, { cache });
  if (!got.ok) refuse(`${x.name}: not in the mirror, and ${got.why} (C4)`);
  if (got.bytes.length !== x.size || sha256(got.bytes) !== x.sha256) refuse(`${x.name}: the copy from ${x.url} is not the size and SHA-256 the catalog names (C5)`);
  fs.writeFileSync(staged(x.name), got.bytes);
}
R.note(`${readInMirror.size} of ${list.length} archives read from the mirror, the others from the cache or their author's URL`);
// Repair: no --live, which would compare with the live index that does not verify (the floor and the union were checked in step 4).
const againstLive = target === 'production' && !repair;
const verifyArgs = [stage, '--archives', '--prefix', P, ...keyFiles.flatMap(k => ['--key', k]), ...(againstLive ? ['--live'] : [])];
const v = await runVendored('index-verify.mjs', verifyArgs);
for (const l of v.stdout.split('\n')) if (l.startsWith('WARN ')) R.note(`index-verify: ${l}`);
if (v.code !== 0) refuse(`index-verify.mjs ${againstLive ? '--archives --live' : '--archives'} refused the index: ${refusalLines(v).join(' | ') || `exit ${v.code}: ${v.stderr.split('\n').find(Boolean) ?? 'no output'}`}`);
R.pass('index-verify', `the whole index verifies with ${keyText}${againstLive ? ', and against the live index (not a rollback)' : ''}`);

// ---- 6: the content-addressed files, create-only -------------------------------------------------------------------------------------------
if (!resign) {
  for (const { name, size, sha } of [...list.map(x => ({ name: x.name, size: x.size, sha: x.sha256 })), { name: catalogName, size: head.catalog.size, sha: head.catalog.sha256 }]) {
    const p = await r2.put(K(name), staged(name), { cacheControl: IMMUTABLE, ifNoneMatch: '*' });
    if (p.status === 'ok') { R.note(`${name}: uploaded (create-only)`); continue; }
    if (p.status !== 'precondition') refuse(`${name} could not be uploaded (${p.why}); dispatch a new run`, true);
    if (!readInMirror.has(name)) {
      const back = await r2.get(K(name), size);
      if (back.status !== 'ok' || back.bytes.length !== size || sha256(back.bytes) !== sha) refuse(back.status === 'error' ? `${name}: answered 412 and cannot be read back (${back.why})` : swapped(name), true);
    }
    R.note(`${name}: already mirrored (412 on If-None-Match: *)`);
  }
}

// ---- 7: the pair, compare-and-swap; recovery R1 -------------------------------------------------------------------------------------------
const exists = (o) => o.status === 'ok' || o.status === 'too-large';
const cas = (old) => (exists(old) ? { ifMatch: old.etag } : { ifNoneMatch: '*' });
const holds = (o, bytes) => o.status === 'ok' && o.bytes.equals(bytes);
const unchanged = (o, old) => (exists(old) ? exists(o) && o.etag === old.etag : o.status === 'missing');
const casFailed = (name, p) => {
  if (p.status === 'precondition') R.fail('cas', `${name}: 412 Precondition Failed on the compare-and-swap: someone changed the live index during this run (docs/RUNBOOK.md, "When a run is red")`);
  else R.note(`${name}: the write failed after its retry (${p.why}); it is read again before anything else`);
};

let newSigEtag = null;
const s = await r2.put(SIG_KEY, staged('index.json.minisig'), { cacheControl: NO_CACHE, ...cas(oldSig) });
if (s.status === 'ok') {
  newSigEtag = s.etag;
  R.note(`index.json.minisig: written (${exists(oldSig) ? 'If-Match on the live ETag' : 'If-None-Match: *'})`);
} else {
  const back = await r2.get(SIG_KEY, I.MAX_INDEX_SIG_BYTES);
  if (holds(back, sigBytes)) {
    newSigEtag = back.etag;
    R.note('index.json.minisig: the new signature is live (the answer was lost); the head follows');
  } else {
    casFailed('index.json.minisig', s);
    await finish(unchanged(back, oldSig) ? 'the signature was not written; nothing more is written' : 'the live signature is neither the old nor the new one; nothing more is written');
  }
}
const h = await r2.put(HEAD_KEY, staged('index.json'), { cacheControl: NO_CACHE, ...cas(oldHead) });
if (h.status === 'ok') await finish(`index.json: written (${exists(oldHead) ? 'If-Match on the live ETag' : 'If-None-Match: *'})`);
const hb = await r2.get(HEAD_KEY, I.MAX_HEAD_BYTES);
if (holds(hb, headBytes)) await finish('index.json: the new head is live (the answer was lost); nothing is restored');
casFailed('index.json', h);
if (!unchanged(hb, oldHead)) await finish('the live head is neither the old nor the new one; nothing more is written');
if (target === 'test') await finish('the head was not written; target test restores nothing');
if (firstPublish) await finish('the head was not written; a first publish has no old signature to put back');
if (repair) await finish('the head was not written; the old pair never verified, so nothing is put back');
if (newSigEtag === null) {
  const sb = await r2.get(SIG_KEY, I.MAX_INDEX_SIG_BYTES);
  if (!holds(sb, sigBytes)) await finish('the head was not written, and the live signature is not the new one: nothing is put back');
  newSigEtag = sb.etag;
}
const oldSigFile = path.join(work, 'old.minisig');
fs.writeFileSync(oldSigFile, oldSig.bytes);
const rs = await r2.put(SIG_KEY, oldSigFile, { cacheControl: NO_CACHE, ifMatch: newSigEtag });
await finish(rs.status === 'ok' ? 'the head was not written; the old signature was put back' : `the head was not written; putting the old signature back failed (${rs.status}: ${rs.why})`);

// ---- 8: the final re-read ------------------------------------------------------------------------------------------------------------------
/** Every exit after the first write of the pair: re-reads both objects, verifies the pair and ends the run with its outcome. */
async function finish(step) {
  R.note(`R1: ${step}; the final re-read of the head and its signature follows`);
  const fh = await r2.get(HEAD_KEY, I.MAX_HEAD_BYTES);
  const fsig = await r2.get(SIG_KEY, I.MAX_INDEX_SIG_BYTES);
  const isNew = holds(fh, headBytes) && holds(fsig, sigBytes);
  const pairOk = fh.status === 'ok' && fsig.status === 'ok' && verifies(fh.bytes, fsig.bytes);
  const red = (verdict, why) => { R.fail('r1', why); end(1, verdict); };
  if (target === 'test') {
    if (isNew && pairOk) end(0, `PUBLISHED ${P} generated ${head.generated} (target test, the run's throwaway key)`);
    red('TEST NOT PUBLISHED: the new test pair is not live; dispatch a new test run', 'the final re-read does not show the new test pair');
  }
  if (fh.status === 'error' || fsig.status === 'error') red('HALF-PUBLISHED: the final re-read failed; recovery R2 or the owner\'s manual path', `the final re-read failed (${fh.why ?? fsig.why})`);
  if (repair) {
    if (isNew && pairOk) end(0, `PUBLISHED ${P} generated ${head.generated}: the new head and signature are live and verify (REPAIR, recovery R2)`);
    if (unchanged(fh, oldHead) && unchanged(fsig, oldSig)) red('UNCHANGED: the live index still does not verify; nothing was published; dispatch a new repair run', 'the broken pair is still live');
  }
  if (firstPublish && fh.status === 'missing') {
    if (fsig.status === 'missing') red('UNCHANGED: nothing was published (a first publish; both objects are still missing); dispatch a new run', 'nothing was published');
    red('FIRST-PUBLISH ORPHAN: a signature with no head; apps read the missing head as unavailable and the next run overwrites it', 'a first publish left its signature without a head');
  }
  if (!pairOk) red('HALF-PUBLISHED: the live head and signature do not verify as a pair; recovery R2 or the owner\'s manual path', `the live pair does not verify with ${keyText}`);
  if (isNew) end(0, `PUBLISHED ${P} generated ${head.generated}: the new head and signature are live and verify`);
  if (!firstPublish && !repair && holds(fh, oldHead.bytes) && holds(fsig, oldSig.bytes)) red('UNCHANGED: the old pair is live; nothing was published; dispatch a new run', 'the old pair is still live');
  red('REPLAYED: a pair that verifies but is neither the new nor the old one is live; a security event (docs/RUNBOOK.md)', 'someone else\'s verified head is live');
}
