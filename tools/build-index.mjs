#!/usr/bin/env node
// tools/build-index.mjs: the index steps of publish.yml and resign.yml (plan 2.2, 4.2, 4.3), around the vendored desktop index tools
// (vendor/eve-cyno-host/scripts/index-build.mjs and index-verify.mjs). It never signs, never uploads and reads no credential.
//
//   build  (--target production|test | --prefix <URL>) --out <new folder> [--tree <dir>] [--archives-json <new file>] [--archive-cache <dir>]
//          [--mirror-url <prefix>|none]
//     The tree's entries and revoked.json (default: this repository) into archives/, catalog/<sha256>.json and the UNSIGNED head
//     index.json, every URL under the target's prefix: each archive fetched (the cache first, then the mirror's archives/<sha256>.zip
//     when it is the pinned size and SHA-256, default the prefix built for, then the author's URL: C4) and checked
//     against the entry (C5); the catalog written by index-build.mjs, the head by index-build.mjs --head-from. The lifetime is the
//     vendored default, 60 days (D36); there is no option for it. A head more than 7 days old or 5 minutes ahead is refused.
//   base   --target production|test --repair true|false --out <new folder> [--summary <file>] [--prefix <URL>] [--key <pub>...]
//     The base of a publish: the live index, verified with the pinned index keys (catalog.json, index.json, index.json.minisig and
//     BASE.json). target test: no live compare (plan 4.2), an empty base. A live head that answers 404 is a first publish only when
//     GitHub shows no run with an approved index and a successful sign (tools/approved-base.mjs; fail closed); otherwise,
//     and for any live index the keys or the app's parsers refuse, LIVE UNVERIFIED. "The live index verifies" has one definition,
//     liveVerifies in tools/lib/indexbuild.mjs (the head, its signature and the catalog the head names), which upload.mjs uses too.
//     A read that fails for another reason than HTTP 404 or more bytes than its cap (a 429 or 503, a network error, a time-out, a
//     redirect) is no verdict on the live index: "dispatch again later" in every step, with or without repair.
//     --repair true (recovery R2, target production only): refused with NOT BROKEN when the live index verifies. Otherwise the base is
//     the newest verified candidate run's head, signature and catalog from GitHub's artifacts (tools/lib/repairbase.mjs; the live
//     index never is), with the union of the verified candidates' revocations and the floor in BASE.json (kind repair). A missing
//     artifact of a candidate, or no verified candidate, refuses the run (docs/RUNBOOK.md, section 'When plugins is unusable').
//   --compare-live --base <folder from base> --index <folder from build> --lift <file> --repair true|false [--summary <file>]
//     The new index against the base: not older (head and catalog), every live revocation kept unless the lift file names it exactly
//     (`<id> <versions>`, one per line, as index-verify.mjs prints them), and every lift line removes a live revocation. Prints the
//     listings added, changed and removed and the revocations added and lifted. With --repair true (a repair base only, and a repair
//     base only with it) the head must be newer than the floor, and the revocations kept or lifted are those of the union.
//   resign-check --outputs <file> [--summary <file>] [--tree <dir>] [--prefix <URL>] [--key <pub>...]
//     Writes needed=true when the verified live head is 30 days old or more, or fewer than 30 days remain before it expires; a live
//     index that does not verify fails (resign never repairs: recovery R2). A live catalog that is not the one main (--tree, default
//     this repository) builds is refused, MAIN DIVERGES (plan section 8, test MV-diverged): a publish still to do, or an older
//     verified head replayed into the mirror, which a re-sign would make fresh again (its missing revocations lost to the apps).
//   resign --out <new folder> [--archives-json <new file>] [--summary <file>] [--tree <dir>] [--prefix <URL>] [--key <pub>...]
//     The verified live head, signature, catalog and archives (paced: at most 50 requests per 10 s) into a temp folder, then
//     index-build.mjs --resign: the same catalog, a new head generated now, 60 days. MAIN DIVERGES refuses it as in resign-check.
// --prefix and --key replace the target's prefix and the pinned keys (a local test server, a private source). Exit 0 done, 1 refused,
// 2 usage.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { createRequire } from 'node:module';
import { createReport } from './lib/summary.mjs';
import { printableLine } from './lib/github.mjs';
import {
  LIFETIME_MS, PREFIXES, ROOT, buildIndex, fetchArchive, headBoundsProblem, indexKeys, liveVerifies, notBroken, pacer, prefixProblem,
  readJson, readLive, refusalLines, revKey, runVendored, sha256, treeDiff,
} from './lib/indexbuild.mjs';

const require = createRequire(import.meta.url);
const I = require(path.join(ROOT, 'vendor', 'eve-cyno-host', 'host', 'dist', 'market', 'indexformat.js'));
const DAY = 86_400_000;
const RESIGN_AT_MS = 30 * DAY;
const R2 = 'recovery R2 (docs/RUNBOOK.md): the coordinator confirms it with index-verify.mjs --live --archives, then publish.yml with repair';

const USAGE = [
  'usage: node tools/build-index.mjs build (--target production|test | --prefix <URL>) --out <new folder> [--tree <dir>] [--archives-json <file>] [--archive-cache <dir>] [--mirror-url <prefix>|none]',
  '       node tools/build-index.mjs base --target production|test --repair true|false --out <new folder> [--summary <file>] [--prefix <URL>] [--key <pub>...]',
  '       node tools/build-index.mjs --compare-live --base <folder> --index <folder> --lift <file> --repair true|false [--summary <file>]',
  '       node tools/build-index.mjs resign-check --outputs <file> [--summary <file>] [--tree <dir>] [--prefix <URL>] [--key <pub>...]',
  '       node tools/build-index.mjs resign --out <new folder> [--archives-json <file>] [--summary <file>] [--tree <dir>] [--prefix <URL>] [--key <pub>...]',
].join('\n');
const ALLOWED = {
  build: ['target', 'prefix', 'out', 'tree', 'archives-json', 'archive-cache', 'mirror-url'],
  base: ['target', 'repair', 'out', 'summary', 'prefix', 'key'],
  '--compare-live': ['compare-live', 'base', 'index', 'lift', 'repair', 'summary'],
  'resign-check': ['outputs', 'summary', 'tree', 'prefix', 'key'],
  resign: ['out', 'archives-json', 'summary', 'tree', 'prefix', 'key'],
};
const REQUIRED = { build: ['out'], base: ['target', 'repair', 'out'], '--compare-live': ['base', 'index', 'lift', 'repair'], 'resign-check': ['outputs'], resign: ['out'] };

const usage = (why) => { if (why) console.error(printableLine(why)); console.error(USAGE); process.exit(2); };
let a, cmd;
try {
  const p = parseArgs({
    args: process.argv.slice(2), strict: true, allowPositionals: true,
    options: Object.fromEntries([...new Set(Object.values(ALLOWED).flat())].map(k => [k, k === 'compare-live' ? { type: 'boolean' } : k === 'key' ? { type: 'string', multiple: true } : { type: 'string' }])),
  });
  a = p.values;
  cmd = a['compare-live'] ? '--compare-live' : p.positionals[0];
  if (p.positionals.length !== (cmd === '--compare-live' ? 0 : 1)) usage();
} catch (e) { usage(e.message); }
if (!ALLOWED[cmd]) usage(`unknown step ${JSON.stringify(cmd ?? '')}`);
for (const k of Object.keys(a)) if (!ALLOWED[cmd].includes(k)) usage(`${cmd} takes no --${k}`);
for (const k of REQUIRED[cmd]) if (typeof a[k] !== 'string' || a[k] === '') usage(`${cmd} needs --${k}`);
if (a.target !== undefined && !Object.hasOwn(PREFIXES, a.target)) usage('--target: production or test');
if (a.repair !== undefined && a.repair !== 'true' && a.repair !== 'false') usage('--repair: true or false');
if (a.prefix !== undefined && prefixProblem(a.prefix)) usage(`--prefix: ${prefixProblem(a.prefix)}`);
if (cmd === 'build' && (a.target === undefined) === (a.prefix === undefined)) usage('build: --target or --prefix, one of them');
if (a['mirror-url'] !== undefined && a['mirror-url'] !== 'none' && prefixProblem(a['mirror-url'])) usage(`--mirror-url: ${prefixProblem(a['mirror-url'])}`);

const R = createReport();
const stamp = (ms) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
const title = `tools/build-index.mjs ${cmd}`;
/** Ends the run: the verdict, the summary file, the exit code. */
function end(code, verdict) {
  R.finish(verdict, { title, file: a.summary });
  process.exit(code);
}
/**
 * Ends the run refused: REFUSED on stderr (and in the summary), exit 1; `cleanup` folders are removed first. `why` is printed whole as
 * one line of printable ASCII (printableLine), so no text it carries (a path, a server's answer, a vendored tool's output) starts a
 * line of its own, a workflow command (`::`) included, and its way out is never cut off.
 */
function refuse(why, ...cleanupDirs) {
  for (const d of cleanupDirs) fs.rmSync(d, { recursive: true, force: true });
  console.error(`REFUSED: ${printableLine(why)}`);
  R.fail('build-index', why);
  end(1, `REFUSED ${cmd}`);
}
/**
 * Resign only: refuses the run unless the verified live catalog is the one main's tree builds (treeDiff). A re-sign keeps the live
 * catalog as it is, so re-signing anything else would turn a replayed older head into a fresh one (plan section 8, MV-diverged).
 */
function refuseUnlessMain(catalog, ...cleanupDirs) {
  const diff = treeDiff(path.resolve(a.tree ?? ROOT), catalog);
  if (diff.length === 0) { R.pass('main', 'the live catalog is main\'s: the same revocations, listings, versions and archives'); return; }
  for (const d of diff.slice(0, 20)) R.note(`main differs from the live catalog: ${d}`);
  // The way out first, the differences last: the summary keeps 500 characters of a line.
  refuse('MAIN DIVERGES: the live catalog is not the one main builds. A re-sign would re-sign it with a new generated time, so an older '
    + 'verified head replayed into the mirror would come back fresh and apps would drop the revocations it lacks. If main was not '
    + 'published yet, run publish.yml; if it was, the live head is a replay: treat it as a security event (docs/RUNBOOK.md) before '
    + `anything else. Main and the live catalog differ (${diff.slice(0, 5).join('; ')}${diff.length > 5 ? `; ${diff.length - 5} more` : ''})`, ...cleanupDirs);
}
const keysOrUsage = () => {
  const k = indexKeys(a.key ?? []);
  if (k.why) usage(k.why);
  return k.keys;
};
const keyText = a.key ? 'the --key keys' : 'the pinned index keys';
const newFolder = (dir) => {
  if (fs.existsSync(dir)) refuse(`${dir} exists: write into a new folder`);
  fs.mkdirSync(path.dirname(path.resolve(dir)), { recursive: true });
  fs.mkdirSync(dir, { mode: 0o700 });
};

// ---- build ------------------------------------------------------------------------------------------------------------------------------
async function stepBuild() {
  const prefix = a.prefix ?? PREFIXES[a.target];
  const mirror = a['mirror-url'] === 'none' ? null : (a['mirror-url'] ?? prefix);
  R.note(`archives: the cache, then ${mirror ? `the mirror ${mirror}archives/<sha256>.zip (the pinned size and SHA-256 only), then the author's URL` : "the author's URL (no mirror)"}`);
  const r = await buildIndex({
    tree: path.resolve(a.tree ?? ROOT), prefix, out: path.resolve(a.out), mirror,
    cache: a['archive-cache'] ? path.resolve(a['archive-cache']) : undefined, archivesJson: a['archives-json'] ? path.resolve(a['archives-json']) : undefined,
  });
  if (!r.ok) refuse(r.why);
  R.note(`head index.json: ${r.headBytes.length} bytes, sha256 ${sha256(r.headBytes)}; unsigned`);
  R.note(`${r.catalogName}: ${r.catalogBytes.length} bytes; ${r.archives.length} archives`);
  end(0, `BUILT ${prefix} generated ${r.head.generated}, expires ${r.head.expires} (60 days)`);
}

// ---- base -------------------------------------------------------------------------------------------------------------------------------
function writeEmptyBase(out, kind, prefix) {
  fs.mkdirSync(path.join(out, 'entries'));
  fs.writeFileSync(path.join(out, 'revoked.json'), '[]\n');
  fs.writeFileSync(path.join(out, 'BASE.json'), `${JSON.stringify({ schema: 1, kind, prefix }, null, 2)}\n`);
}
/** Recovery R2's base (plan 4.2): never the live index; the newest verified candidate run's artifacts, the union and the floor. */
async function stepRepairBase(out, prefix) {
  const keys = keysOrUsage();
  const live = await readLive({ prefix, keys });
  if (liveVerifies(live)) refuse(notBroken(live, keyText));
  if (live.status === 'unreadable') refuse(`the live index cannot be read (${live.why}): nothing to repair against; dispatch again later`);
  const runId = process.env.GITHUB_RUN_ID ?? '';
  if (!/^[1-9][0-9]{0,15}$/.test(runId)) refuse('REPAIR: no run id (GITHUB_RUN_ID) is set to find the candidate runs (fail closed)');
  R.note(`REPAIR: the live index ${live.status === 'missing' ? 'answers HTTP 404 (a deleted head)' : `does not verify (${live.why})`}; the base comes from the candidate runs' artifacts`);
  const { repairBase } = await import('./lib/repairbase.mjs');
  const rb = await repairBase({ runId: Number(runId), env: process.env, keys, prefix, liveHead: live.headBytes ?? null });
  for (const l of rb.lines) R.note(`repair: ${l}`);
  if (!rb.ok) refuse(rb.why);
  const b = rb.base;
  newFolder(out);
  fs.writeFileSync(path.join(out, 'index.json'), b.headBytes);
  fs.writeFileSync(path.join(out, 'index.json.minisig'), b.sigBytes);
  fs.writeFileSync(path.join(out, 'catalog.json'), b.catalogBytes);
  fs.writeFileSync(path.join(out, 'BASE.json'), `${JSON.stringify({
    schema: 1, kind: 'repair', prefix, generated: b.head.generated, catalogGenerated: b.catalog.generated, headSha256: sha256(b.headBytes), catalogName: b.catalogName,
    baseRun: b.run, floor: rb.floor.generated, floorSource: rb.floor.source, union: rb.union, candidates: rb.candidates,
  }, null, 2)}\n`);
  R.pass('base', `REPAIR: run ${b.run}'s verified head (generated ${b.head.generated}); ${b.catalogName}: ${b.catalog.plugins.length} listings; ${rb.union.length} revocations in the union of ${rb.candidates.filter(c => c.verified).length} verified candidates`);
  end(0, `BASE REPAIR run ${b.run} generated ${b.head.generated}; floor ${rb.floor.generated} from ${rb.floor.source}`);
}

async function stepBase() {
  const out = path.resolve(a.out);
  const prefix = a.prefix ?? PREFIXES[a.target];
  if (a.repair === 'true') {
    if (a.target === 'test') refuse('repair is for target production only');
    return stepRepairBase(out, prefix);
  }
  if (a.target === 'test') {
    newFolder(out);
    writeEmptyBase(out, 'test', prefix);
    R.note('target test: no live base compare (plan 4.2: an earlier test pair was signed with another run\'s throwaway key)');
    end(0, 'BASE test (empty)');
  }
  const keys = keysOrUsage();
  const live = await readLive({ prefix, keys });
  if (live.status === 'missing') {
    const runId = process.env.GITHUB_RUN_ID ?? '';
    if (!/^[1-9][0-9]{0,15}$/.test(runId)) refuse(`the live head answers HTTP 404 and no run id (GITHUB_RUN_ID) is set to ask GitHub whether this is a first publish (fail closed)`);
    const { approvedBase } = await import('./approved-base.mjs');
    const q = await approvedBase({ runId: Number(runId), repoDir: ROOT, env: process.env });
    for (const l of q.lines) R.note(`approved-base: ${l}`);
    if (q.code !== 3) refuse(`LIVE UNVERIFIED: the live head answers HTTP 404, but GitHub shows an approved run or could not be asked (approved-base exit ${q.code}): a deleted head; ${R2}`);
    newFolder(out);
    writeEmptyBase(out, 'first-publish', prefix);
    R.note('first publish: the live head answers HTTP 404 and no run has an approved index with a successful sign');
    end(0, 'BASE first publish (empty)');
  }
  if (live.status === 'unreadable') refuse(`the live index cannot be read (${live.why}): nothing to compare with; dispatch again later`);
  if (!liveVerifies(live)) refuse(`LIVE UNVERIFIED: ${live.why}; ${R2}`);
  newFolder(out);
  fs.writeFileSync(path.join(out, 'index.json'), live.headBytes);
  fs.writeFileSync(path.join(out, 'index.json.minisig'), live.sigBytes);
  fs.writeFileSync(path.join(out, 'catalog.json'), live.catalogBytes);
  fs.writeFileSync(path.join(out, 'BASE.json'), `${JSON.stringify({
    schema: 1, kind: 'live', prefix, generated: live.head.generated, catalogGenerated: live.catalog.generated, headSha256: sha256(live.headBytes), catalogName: live.catalogName,
  }, null, 2)}\n`);
  R.pass('base', `the live head verifies (generated ${live.head.generated}); ${live.catalogName}: ${live.catalog.plugins.length} listings, ${live.catalog.revoked.length} revocations`);
  end(0, `BASE live ${live.head.generated}`);
}

// ---- --compare-live ---------------------------------------------------------------------------------------------------------------------
const listingKey = (l) => JSON.stringify([l.name, l.author, l.firstParty, l.summary, l.description, l.categories, l.source, l.type, l.versions.map(v => [v.version, v.archive.sha256])]);
async function stepCompare() {
  const baseDir = path.resolve(a.base), dir = path.resolve(a.index);
  const meta = readJson(baseDir, 'BASE.json').value;
  if (!meta || meta.schema !== 1 || !['live', 'test', 'first-publish', 'repair'].includes(meta.kind) || prefixProblem(meta.prefix ?? '')) refuse('the base folder holds no BASE.json written by build-index.mjs base');
  const repair = meta.kind === 'repair';
  if (a.repair === 'true' && !repair) refuse(`--repair true needs the base that build-index.mjs base --repair true wrote, not a ${meta.kind} base`);
  if (a.repair !== 'true' && repair) refuse('a repair base is compared only with --repair true');
  let union = [];
  if (repair) {
    if (!Array.isArray(meta.union) || !meta.union.every(r => r && typeof r.id === 'string' && (r.versions === '*' || Array.isArray(r.versions)))
      || typeof meta.floor !== 'string' || !Number.isFinite(Date.parse(meta.floor))) refuse('the repair base names no union of revocations or no floor');
    union = meta.union;
  }
  const P = meta.prefix;
  let head, cat;
  try {
    head = I.parseIndexHead(fs.readFileSync(path.join(dir, 'index.json')), P);
    const cb = fs.readFileSync(path.join(dir, ...head.catalog.url.slice(P.length).split('/')));
    if (!I.catalogMatches(cb, head)) refuse('the new catalog does not match its head');
    cat = I.parseCatalog(cb, head, { prefix: P });
  } catch (e) { refuse(`the new index cannot be read (${e?.message ?? 'error'})`); }
  let liftText = '';
  try { liftText = fs.readFileSync(path.resolve(a.lift), 'utf8'); } catch { refuse('the lift file cannot be read'); }
  const lifts = [...new Set(liftText.split(/\r?\n/).map(l => l.trim()).filter(Boolean))];
  let base = { plugins: [], revoked: [] };
  if (meta.kind === 'live' || repair) {
    try {
      const bh = I.parseIndexHead(fs.readFileSync(path.join(baseDir, 'index.json')), P);
      base = I.parseCatalog(fs.readFileSync(path.join(baseDir, 'catalog.json')), bh, { prefix: P });
      if (repair) {
        R.note(`REPAIR: the base is run ${meta.baseRun}'s verified head (generated ${bh.generated}); the floor ${meta.floor} comes from ${meta.floorSource}; lifts count against the union of ${union.length} revocations`);
        if (Date.parse(head.generated) <= Date.parse(meta.floor)) R.fail('rollback', `the new head (${head.generated}) is not newer than the repair floor (${meta.floor}, from ${meta.floorSource}): build again`);
      } else if (Date.parse(head.generated) <= Date.parse(bh.generated)) R.fail('rollback', `the new head (${head.generated}) is not newer than the live head (${bh.generated}): build again`);
      if (Date.parse(cat.generated) < Date.parse(base.generated)) R.fail('rollback', `the new catalog (${cat.generated}) is older than the ${repair ? 'base' : 'live'} catalog (${base.generated})`);
    } catch (e) { refuse(`the base cannot be read (${e?.message ?? 'error'})`); }
  } else R.note(`base ${meta.kind}: nothing published to compare with; every listing and revocation is new`);
  const baseRevoked = repair ? union : base.revoked;
  const have = new Set(cat.revoked.map(revKey));
  const was = new Set(baseRevoked.map(revKey));
  const lifted = [...was].filter(k => !have.has(k));
  for (const k of lifted) {
    if (lifts.includes(k)) R.note(`revocation lifted: ${k} (named in lift)`);
    else R.fail('lift', `the ${repair ? 'union of the verified candidates' : 'live index'} revokes ${k}; this one does not: a lift needs that exact line in the lift input`);
  }
  for (const l of lifts) if (!lifted.includes(l)) R.fail('lift', `the lift input names ${l}, which is not a ${repair ? 'revocation of the union' : 'live revocation'} this index removes`);
  for (const k of cat.revoked.map(revKey).filter(k => !was.has(k))) R.note(`revocation added: ${k}`);
  const old = new Map(base.plugins.map(l => [l.id, l]));
  const now = new Map(cat.plugins.map(l => [l.id, l]));
  for (const [id, l] of now) {
    if (!old.has(id)) R.note(`listing added: ${id} ${l.versions.map(v => v.version).join(', ')}`);
    else if (listingKey(old.get(id)) !== listingKey(l)) R.note(`listing changed: ${id} ${l.versions.map(v => v.version).join(', ')}`);
  }
  for (const id of old.keys()) if (!now.has(id)) R.note(`listing removed: ${id}`);
  const against = meta.kind === 'live' ? `the live index ${meta.generated}` : repair ? `the repair base ${meta.generated} (REPAIR, floor ${meta.floor})` : `a ${meta.kind} base`;
  end(R.failed ? 1 : 0, R.failed ? `COMPARE FAILED ${R.failed}` : `COMPARE OK against ${against}`);
}

// ---- resign-check -----------------------------------------------------------------------------------------------------------------------
async function stepResignCheck() {
  const prefix = a.prefix ?? PREFIXES.production;
  const live = await readLive({ prefix, keys: keysOrUsage() });
  if (live.status === 'missing') refuse(`the live head answers HTTP 404: resign never makes a first publish or repairs (publish.yml, or ${R2})`);
  if (live.status === 'unreadable') refuse(`the live index cannot be read (${live.why}): nothing to check; dispatch again later`);
  if (!liveVerifies(live)) refuse(`the live index does not verify (${live.why}): resign never repairs; ${R2}`);
  const now = Date.now(), g = Date.parse(live.head.generated), x = Date.parse(live.head.expires);
  const needed = now - g >= RESIGN_AT_MS || x - now < RESIGN_AT_MS;
  R.pass('live', `the live head verifies: generated ${live.head.generated} (${Math.floor((now - g) / DAY)} days ago), expires ${live.head.expires} (in ${Math.floor((x - now) / DAY)} days)`);
  refuseUnlessMain(live.catalog);
  fs.appendFileSync(path.resolve(a.outputs), `needed=${needed}\n`);
  end(0, needed ? 'RESIGN NEEDED' : 'RESIGN NOT NEEDED');
}

// ---- resign -----------------------------------------------------------------------------------------------------------------------------
async function stepResign() {
  const prefix = a.prefix ?? PREFIXES.production;
  const out = path.resolve(a.out);
  if (fs.existsSync(out)) refuse(`${out} exists: write into a new folder`);
  if (a['archives-json'] && fs.existsSync(a['archives-json'])) refuse('the archive list file exists already');
  const pace = pacer();
  const live = await readLive({ prefix, keys: keysOrUsage(), pace });
  if (live.status === 'missing') refuse(`the live head answers HTTP 404: nothing to re-sign (publish.yml, or ${R2})`);
  if (live.status === 'unreadable') refuse(`the live index cannot be read (${live.why}): nothing to re-sign; dispatch again later`);
  if (!liveVerifies(live)) refuse(`the live index does not verify (${live.why}): resign never repairs; ${R2}`);
  refuseUnlessMain(live.catalog);
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'evecyno-resign-'));
  try {
    const signed = path.join(work, 'signed');
    fs.mkdirSync(path.join(signed, 'catalog'), { recursive: true });
    fs.mkdirSync(path.join(signed, 'archives'));
    fs.writeFileSync(path.join(signed, 'index.json'), live.headBytes);
    fs.writeFileSync(path.join(signed, 'index.json.minisig'), live.sigBytes);
    fs.writeFileSync(path.join(signed, ...live.catalogName.split('/')), live.catalogBytes);
    const archives = new Map();
    for (const l of live.catalog.plugins) for (const v of l.versions) {
      const name = v.archive.url.slice(prefix.length);
      if (archives.has(name)) continue;
      const why = await fetchArchive(prefix, name, v.archive.size, v.archive.sha256, path.join(signed, ...name.split('/')), pace);
      if (why) refuse(`a live archive: ${why}`, work);
      archives.set(name, { name, sha256: v.archive.sha256, size: v.archive.size, url: v.archive.url });
    }
    const r = await runVendored('index-build.mjs', ['--resign', signed, out, '--prefix', prefix, ...(a.key ?? []).flatMap(k => ['--key', path.resolve(k)])]);
    if (r.code !== 0) refuse(`index-build.mjs --resign refused: ${refusalLines(r).join(' | ') || `exit ${r.code}`}`, work);
    const headBytes = fs.readFileSync(path.join(out, 'index.json'));
    const bound = headBoundsProblem(headBytes, prefix);
    if (bound) refuse(bound, work, out);
    const head = I.parseIndexHead(headBytes, prefix);
    if (JSON.stringify(head.catalog) !== JSON.stringify(live.head.catalog)) refuse('the new head names another catalog than the live head', work, out);
    if (a['archives-json']) fs.writeFileSync(path.resolve(a['archives-json']), `${JSON.stringify([...archives.values()], null, 2)}\n`, { flag: 'wx' });
    R.note(`head index.json: ${headBytes.length} bytes, sha256 ${sha256(headBytes)}; unsigned; the same catalog ${live.catalogName}`);
    end(0, `RESIGNED generated ${head.generated}, expires ${head.expires} (${LIFETIME_MS / DAY} days; the live head was generated ${live.head.generated})`);
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
}

await ({ build: stepBuild, base: stepBase, '--compare-live': stepCompare, 'resign-check': stepResignCheck, resign: stepResign })[cmd]();
// a step that returns without end() is a bug: fail closed
console.error(`REFUSED: ${cmd} ended without a verdict`);
process.exit(1);
