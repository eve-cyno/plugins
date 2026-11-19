// PB-*: tools/publish/upload.mjs, the upload step of publish.yml and resign.yml (plan task 2.4, sections 4.2 job upload, 4.3, 6.4):
// create-only archives and catalog, then a compare-and-swap of the signature, then of the head, and recovery R1 with its final
// re-read. The bucket is the stub aws of awsstub.mjs (a JSON file; no network, no credential: the R2 values are fake), served over
// 127.0.0.1 for the vendored index-verify.mjs --live; GitHub is the stub gh of ghstub.mjs. The index key is a throwaway key made in
// this run (--key), the test target's key the run's throwaway public key in the input folder, as the sign-test job leaves it.
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { throwawaySigner } from '../lib/throwaway.mjs';
import { LIFETIME_MS, refusalLines } from '../lib/indexbuild.mjs';
import { ROOT, cacheArchive, cleanup, manifest, pluginEntry, pluginZip, run, sha, tempDir, themeEntry, themeZip, version, writeTree } from './trees.mjs';
import { makeStubBin, md5Etag, object, pointStub, readAwsLog, readBucket, s3Calls, serveBucket, writeBucket } from './awsstub.mjs';
import { stubEnv } from './ghstub.mjs';
import { zip } from './zipwrite.mjs';

const require = createRequire(import.meta.url);
const I = require(path.join(ROOT, 'vendor', 'eve-cyno-host', 'host', 'dist', 'market', 'indexformat.js'));
const TOOL = 'tools/publish/upload.mjs';
const IMMUTABLE = 'public, max-age=31536000, immutable';
const FAKE_ID = 'FAKEKEYIDFORTESTSONLY0';
const FAKE_SECRET = 'fake-secret-for-tests-only-0123456789abcdef';
const FAKE_GH = 'fake-gh-token-for-tests-only';
const ACCOUNT = 'f'.repeat(32);
const HEAD = 'v1/index.json', SIG = 'v1/index.json.minisig';
const THEAD = 'test/v1/index.json', TSIG = 'test/v1/index.json.minisig';
const DAY = 86_400_000;
const stamp = (ms) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
const b64 = (b) => Buffer.from(b).toString('base64');
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const temps = [];
const BIN = makeStubBin(temps);
// approved-base.mjs learns the reviewer account from GitHub: the environment index's one required reviewer (the environments route
// below) or, in the version before that, the file committed at the run's commit (git show), which this git answers; every other git
// call (the vendored verifier's git ls-files) goes to the real git.
const REVIEWER = 4242;
const REAL_GIT = fs.realpathSync(path.join(BIN, 'git'));
fs.rmSync(path.join(BIN, 'git'));
fs.writeFileSync(path.join(BIN, 'git'), `#!${process.execPath}
const a = process.argv.slice(2);
if (a.includes('show')) { process.stdout.write(JSON.stringify({ reviewerId: ${REVIEWER} })); process.exit(0); }
const r = require('node:child_process').spawnSync(${JSON.stringify(REAL_GIT)}, a, { stdio: 'inherit' });
process.exit(r.status ?? 1);
`, { mode: 0o755 });
const signer = throwawaySigner(); // stands in for the index key (passed with --key)
const testSigner = throwawaySigner(); // the throwaway key of this run's sign-test job
const otherSigner = throwawaySigner(); // an earlier test run's throwaway key, or a key the app does not trust
let T, P, PT, PUB, CACHE, server, current = null;
const ix = {}; // index folders by name: { dir, list, head, sig }

const A100 = pluginZip(manifest({ version: '1.0.0' }));
const A110 = pluginZip(manifest({ version: '1.1.0' }));
const DUSK = themeZip();
const TREE_A = { entries: [pluginEntry([version('1.0.0', A100)])] };
const TREE_B = { entries: [pluginEntry([version('1.1.0', A110), version('1.0.0', A100)]), themeEntry([version('2.0.0', DUSK, {}, 'theme')])] };

function signFolder(dir, s) {
  const head = fs.readFileSync(path.join(dir, 'index.json'));
  fs.writeFileSync(path.join(dir, 'index.json.minisig'), s.sign(head, I.indexComment(JSON.parse(head).generated)));
}
async function buildIndex(name, tree, prefix, s) {
  const dir = path.join(T, name), list = path.join(T, `${name}.archives.json`);
  const r = await run('tools/build-index.mjs', ['build', '--prefix', prefix, '--tree', writeTree(path.join(T, `tree-${name}`), tree), '--out', dir,
    '--archive-cache', CACHE, '--archives-json', list]);
  assert.equal(r.code, 0, r.stdout + r.stderr);
  signFolder(dir, s);
  ix[name] = { dir, list, head: fs.readFileSync(path.join(dir, 'index.json')), sig: fs.readFileSync(path.join(dir, 'index.json.minisig')) };
}
/** The bucket objects of an index folder under `keyPrefix`, with the headers the upload step gives them. */
function objectsOf(name, keyPrefix = 'v1/') {
  const out = {};
  const walk = (rel) => {
    for (const e of fs.readdirSync(path.join(ix[name].dir, rel), { withFileTypes: true })) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) { walk(r); continue; }
      if (e.name === 'CUSTOM-KEY-ONLY.txt') continue;
      const pair = r === 'index.json' || r === 'index.json.minisig';
      out[keyPrefix + r] = object(fs.readFileSync(path.join(ix[name].dir, r)), r.endsWith('.zip') ? 'application/zip' : r.endsWith('.minisig') ? 'text/plain' : 'application/json',
        pair ? 'no-cache' : IMMUTABLE);
    }
  };
  walk('');
  return out;
}
/** The input folder the upload job downloads: head, signature, catalog/, archives.json (and test.pub for target test). */
function inputOf(name, dest, { testPub = false, head } = {}) {
  fs.mkdirSync(path.join(dest, 'catalog'), { recursive: true });
  const h = head ?? ix[name].head;
  fs.writeFileSync(path.join(dest, 'index.json'), h);
  fs.writeFileSync(path.join(dest, 'index.json.minisig'), ix[name].sig);
  for (const f of fs.readdirSync(path.join(ix[name].dir, 'catalog'))) fs.copyFileSync(path.join(ix[name].dir, 'catalog', f), path.join(dest, 'catalog', f));
  fs.copyFileSync(ix[name].list, path.join(dest, 'archives.json'));
  if (testPub) fs.writeFileSync(path.join(dest, 'test.pub'), testSigner.pubText);
  return h;
}

const GH = 'repos/eve-cyno/plugins';
const ghRun = (id, sha40, created) => ({ id, path: '.github/workflows/publish.yml', head_branch: 'main', head_sha: sha40, event: 'workflow_dispatch', head_repository: { full_name: 'eve-cyno/plugins' }, run_attempt: 1, created_at: created, html_url: `https://github.com/eve-cyno/plugins/actions/runs/${id}` });
/**
 * gh answers for run 300 (the run under review): no other run (a first publish), an approved and uploaded run 200, an approved run
 * 200 whose sign succeeded and upload failed ('signed'), or a failing list.
 */
function ghRoutes(kind) {
  const under = ghRun(300, 'b'.repeat(40), '2026-12-10T10:00:00Z');
  const done = ghRun(200, 'a'.repeat(40), '2026-12-01T10:00:00Z');
  const page = (l) => [{ total_count: l.length, workflow_runs: l }];
  const r = {
    [`GET ${GH}/actions/runs/300`]: { stdout: under },
    [`GET ${GH}/environments/index`]: { stdout: { name: 'index', can_admins_bypass: false, protection_rules: [
      { type: 'required_reviewers', prevent_self_review: true, reviewers: [{ type: 'User', reviewer: { id: REVIEWER, login: 'reviewer-account', type: 'User' } }] }] } },
    [`GET ${GH}/actions/workflows/publish.yml/runs?per_page=100`]: kind === 'error' ? { stderr: 'HTTP 502: Bad Gateway', exit: 1 } : { stdout: page(kind === 'approved' || kind === 'signed' ? [under, done] : [under]) },
    [`GET ${GH}/actions/workflows/resign.yml/runs?per_page=100`]: { stdout: page([]) },
  };
  if (kind === 'approved') {
    r[`GET ${GH}/actions/runs/200/approvals`] = { stdout: [{ state: 'approved', user: { id: REVIEWER }, environments: [{ name: 'index' }] }] };
    r[`GET ${GH}/actions/runs/200/jobs?filter=all&per_page=100`] = { stdout: [{ total_count: 2, jobs: [{ id: 1, name: 'sign', conclusion: 'success', run_attempt: 1 }, { id: 2, name: 'upload', conclusion: 'success', run_attempt: 1 }] }] };
    r[`GET ${GH}/compare/${'a'.repeat(40)}...${'b'.repeat(40)}`] = { stdout: { status: 'ahead' } };
  }
  if (kind === 'signed') {
    r[`GET ${GH}/actions/runs/200/approvals`] = { stdout: [{ state: 'approved', user: { id: REVIEWER }, environments: [{ name: 'index' }] }] };
    r[`GET ${GH}/actions/runs/200/jobs?filter=all&per_page=100`] = { stdout: [{ total_count: 2, jobs: [{ id: 1, name: 'sign', conclusion: 'success', run_attempt: 1 }, { id: 2, name: 'upload', conclusion: 'failure', run_attempt: 1 }] }] };
  }
  return r;
}

/**
 * gh answers for recovery R2, run 300 under review: run 290 (the half-published run: index approved, sign succeeded, upload failed;
 * artifacts of index HR) and run 280 (<A>: signed and uploaded; artifacts of index `older`, A by default). `drop`: { runId: [artifact
 * names it lacks] }.
 */
function repairRoutes({ drop = {}, older = 'A' } = {}) {
  const now = Date.now();
  const runs = [ghRun(300, 'b'.repeat(40), stamp(now)), ghRun(290, 'd'.repeat(40), stamp(now - DAY)), ghRun(280, 'a'.repeat(40), stamp(now - 5 * DAY))];
  const r = {
    [`GET ${GH}/environments/index`]: ghRoutes('none')[`GET ${GH}/environments/index`],
    [`GET ${GH}/actions/workflows/publish.yml/runs?per_page=100`]: { stdout: [{ total_count: runs.length, workflow_runs: runs }] },
    [`GET ${GH}/actions/workflows/resign.yml/runs?per_page=100`]: { stdout: [{ total_count: 0, workflow_runs: [] }] },
  };
  for (const [id, name, upload] of [[290, 'HR', 'failure'], [280, older, 'success']]) {
    r[`GET ${GH}/actions/runs/${id}/approvals`] = { stdout: [{ state: 'approved', user: { id: REVIEWER }, environments: [{ name: 'index' }] }] };
    r[`GET ${GH}/actions/runs/${id}/jobs?filter=all&per_page=100`] = { stdout: [{ total_count: 2, jobs: [{ id: id * 10, name: 'sign', conclusion: 'success', run_attempt: 1 }, { id: id * 10 + 1, name: 'upload', conclusion: upload, run_attempt: 1 }] }] };
    const catFile = fs.readdirSync(path.join(ix[name].dir, 'catalog'))[0];
    const files = { head: ['index.json', ix[name].head], signature: ['index.json.minisig', ix[name].sig], catalog: [catFile, fs.readFileSync(path.join(ix[name].dir, 'catalog', catFile))] };
    const arts = Object.keys(files).filter(n => !(drop[id] ?? []).includes(n)).map((n, i) => ({ id: id * 10 + i + 1, name: n, size_in_bytes: 100, expired: false }));
    r[`GET ${GH}/actions/runs/${id}/artifacts?per_page=100`] = { stdout: [{ total_count: arts.length, artifacts: arts }] };
    for (const x of arts) r[`GET ${GH}/actions/artifacts/${x.id}/zip`] = { b64: zip([{ name: files[x.name][0], data: files[x.name][1] }]).toString('base64') };
  }
  return r;
}

/**
 * One case: a bucket holding `live`, an input folder made from index `input`, faults, and the environment of the upload step. `edge`:
 * what the server serves instead of the bucket (awsstub.mjs).
 */
function scenario({ live, input = 'B', faults = [], version: ver, skeletonDrop, gh = 'none', routes, env = {}, testPub = false, head, edge = {} } = {}) {
  const dir = tempDir('upload');
  const bucket = path.join(dir, 'bucket.json');
  writeBucket(bucket, { objects: structuredClone(live ?? objectsOf('A')), faults, edge, ...(ver ? { version: ver } : {}), ...(skeletonDrop ? { skeletonDrop } : {}) });
  current = bucket;
  const inDir = path.join(dir, 'in');
  const h = inputOf(input, inDir, { testPub, head });
  const awsLog = path.join(dir, 'aws.jsonl');
  fs.writeFileSync(awsLog, '');
  pointStub(BIN, { bucket, log: awsLog });
  const g = stubEnv(BIN, routes ?? ghRoutes(gh), temps);
  return {
    dir, bucket, inDir, awsLog, ghLog: g.log, summary: path.join(dir, 'summary.md'),
    env: { ...g.env, R2_ACCESS_KEY_ID: FAKE_ID, R2_SECRET_ACCESS_KEY: FAKE_SECRET, R2_ACCOUNT_ID: ACCOUNT,
      R2_BUCKET: 'eve-cyno-plugins', HEAD_SHA256: sha(h), GITHUB_RUN_ID: '300', GH_TOKEN: FAKE_GH, ...env },
  };
}
async function upload(sc, mode = 'production', extra = []) {
  const args = mode === 'resign' ? ['--resign', '--in', sc.inDir, '--summary', sc.summary, '--prefix', P, '--key', PUB]
    : mode === 'test' ? ['--target', 'test', '--repair', 'false', '--in', sc.inDir, '--summary', sc.summary, '--prefix', PT]
      : ['--target', 'production', '--repair', mode === 'repair' ? 'true' : 'false', '--in', sc.inDir, '--summary', sc.summary, '--prefix', P, '--key', PUB];
  const r = await run(TOOL, [...args, '--archive-cache', CACHE, ...extra], { env: sc.env });
  const log = readAwsLog(sc.awsLog);
  const out = r.stdout + r.stderr;
  return { ...r, out, log, calls: s3Calls(log), puts: s3Calls(log).filter(c => c.op === 'put-object'), bucket: readBucket(sc.bucket),
    summary: fs.existsSync(sc.summary) ? fs.readFileSync(sc.summary, 'utf8') : '', last: r.stdout.trim().split('\n').at(-1) };
}
const bytesOf = (bucket, key) => (bucket[key] ? Buffer.from(bucket[key].b64, 'base64') : null);
/** The bucket key of the catalog index `name`'s head names. */
const catKeyOf = (name) => `v1/${JSON.parse(ix[name].head).catalog.url.slice(P.length)}`;
/** build-index.mjs base without repair against the case's bucket, as the build job runs it. */
const normalBase = (sc, out) => run('tools/build-index.mjs', ['base', '--target', 'production', '--repair', 'false', '--out', out, '--summary', sc.summary, '--prefix', P, '--key', PUB], { env: sc.env });
/** build-index.mjs resign-check against the case's bucket, main's tree `tree`. */
const resignCheck = (sc, tree) => {
  const outputs = path.join(sc.dir, `outputs-${Math.random().toString(16).slice(2)}.txt`);
  fs.writeFileSync(outputs, '');
  return run('tools/build-index.mjs', ['resign-check', '--outputs', outputs, '--tree', tree, '--prefix', P, '--key', PUB], { env: sc.env });
};
/** The one REFUSED line of a run's stderr. */
const refusedLine = (r) => {
  const l = r.stderr.split('\n').filter(x => x.startsWith('REFUSED: '));
  assert.equal(l.length, 1, JSON.stringify(r.stderr));
  return l[0];
};
const garbage = b64('untrusted comment: not a signature\nRVQAAAAA\n');

before(async () => {
  T = tempDir('upload-fixtures');
  CACHE = path.join(T, 'cache');
  for (const a of [A100, A110, DUSK]) cacheArchive(CACHE, a);
  server = await serveBucket(() => current);
  P = `http://127.0.0.1:${server.port}/v1/`;
  PT = `http://127.0.0.1:${server.port}/test/v1/`;
  PUB = path.join(T, 'index.pub');
  fs.writeFileSync(PUB, signer.pubText);
  // A0 is older than A, the live index of most cases; B is the new index the run publishes.
  await buildIndex('A0', TREE_A, P, signer);
  await sleep(1100);
  await buildIndex('A', TREE_A, P, signer);
  await buildIndex('AT', TREE_A, PT, otherSigner);
  await sleep(1100);
  await buildIndex('B', TREE_B, P, signer);
  await buildIndex('BT', TREE_B, PT, testSigner);
  // A re-sign of the live A: the same catalog, a new head (build-index.mjs resign reads the bucket through the server).
  current = path.join(T, 'bucket-A.json');
  writeBucket(current, { objects: objectsOf('A') });
  const r = await run('tools/build-index.mjs', ['resign', '--out', path.join(T, 'R'), '--archives-json', path.join(T, 'R.archives.json'), '--tree', path.join(T, 'tree-A'), '--prefix', P, '--key', PUB]);
  assert.equal(r.code, 0, r.stdout + r.stderr);
  signFolder(path.join(T, 'R'), signer);
  ix.R = { dir: path.join(T, 'R'), list: path.join(T, 'R.archives.json'), head: fs.readFileSync(path.join(T, 'R', 'index.json')), sig: fs.readFileSync(path.join(T, 'R', 'index.json.minisig')) };
});
after(() => { server?.close(); for (const t of temps) fs.rmSync(t, { recursive: true, force: true }); cleanup(); });

describe('upload: order, headers and create-only files', () => {
  test('PB-order-headers: archives and catalog create-only, then the signature, then the head, each compare-and-swap on the live ETag', async () => {
    const sc = scenario();
    const r = await upload(sc);
    assert.equal(r.code, 0, r.out);
    assert.match(r.last, /^PUBLISHED /);
    const keys = r.puts.map(p => p.key);
    const catKey = `v1/${JSON.parse(ix.B.head).catalog.url.slice(P.length)}`;
    const archives = [A100, A110, DUSK].map(a => `v1/archives/${sha(a)}.zip`).sort();
    assert.deepEqual(keys, [...archives, catKey, SIG, HEAD], 'archives (by name), the catalog, the signature, the head');
    for (const p of r.puts.slice(0, 4)) {
      assert.equal(p.ifNoneMatch, '*', `${p.key} is create-only`);
      assert.equal(p.ifMatch, undefined);
      assert.equal(p.cacheControl, IMMUTABLE, `${p.key} is content-addressed`);
    }
    assert.deepEqual(r.puts.slice(0, 3).map(p => p.contentType), ['application/zip', 'application/zip', 'application/zip']);
    assert.equal(r.puts[3].contentType, 'application/json');
    const A = objectsOf('A');
    assert.deepEqual([r.puts[4].ifMatch, r.puts[4].ifNoneMatch, r.puts[4].cacheControl, r.puts[4].contentType], [A[SIG].etag, undefined, 'no-cache', 'text/plain']);
    assert.deepEqual([r.puts[5].ifMatch, r.puts[5].ifNoneMatch, r.puts[5].cacheControl, r.puts[5].contentType], [A[HEAD].etag, undefined, 'no-cache', 'application/json']);
    assert.match(r.out, new RegExp(`archives/${sha(A100)}\\.zip: already mirrored`), 'a 412 on If-None-Match: * is read as mirrored');
    assert.deepEqual(bytesOf(r.bucket, HEAD), ix.B.head);
    assert.deepEqual(bytesOf(r.bucket, SIG), ix.B.sig);
    assert.match(r.summary, /\*\*PUBLISHED /);
    const gets = r.calls.filter(c => c.op === 'get-object');
    assert.ok(gets.every(g => /^bytes=0-\d+$/.test(g.range)), 'every read is capped by a byte range');
    assert.deepEqual(gets.slice(0, 2).map(g => [g.key, g.range]), [[HEAD, 'bytes=0-16384'], [SIG, 'bytes=0-16384']], 'the live pair is read before any write');
    assert.deepEqual(gets.slice(-2).map(g => g.key), [HEAD, SIG], 'the final re-read of both objects');
    assert.equal(sc.ghLog().length, 0, 'a live head: GitHub is not asked');
  });

  test('PB-secrets: the R2 values reach the aws child only as AWS_* variables, never an argument or a line of output', async () => {
    const sc = scenario();
    const r = await upload(sc);
    assert.equal(r.code, 0, r.out);
    for (const s of [FAKE_ID, FAKE_SECRET, FAKE_GH]) {
      assert.ok(!r.out.includes(s), 'not in the output');
      assert.ok(!r.summary.includes(s), 'not in the summary');
      assert.ok(r.log.every(c => !c.argv.some(x => x.includes(s))), 'not an argument');
    }
    for (const c of r.log) {
      assert.deepEqual([c.env.keyId, c.env.secret, c.env.region, c.env.attempts], [FAKE_ID, FAKE_SECRET, 'auto', '1']);
      assert.deepEqual(c.env.other, [], 'no R2_ or GitHub token variable in the aws child');
    }
    assert.ok(r.log.some(c => c.argv.includes(`https://${ACCOUNT}.r2.cloudflarestorage.com`)), 'the R2 S3 endpoint of the account');
    assert.ok(r.calls.every(c => c.op === 'get-object' || c.op === 'put-object'));
  });

  test('PB-catalog-412-other-bytes: a 412 on a file the mirror holds with other bytes stops before the pair', async () => {
    const live = objectsOf('A');
    const catKey = `v1/${JSON.parse(ix.B.head).catalog.url.slice(P.length)}`;
    live[catKey] = object(Buffer.from('{"not":"the catalog"}'), 'application/json', IMMUTABLE);
    const r = await upload(scenario({ live }));
    assert.equal(r.code, 1, r.out);
    assert.match(r.out, /another file under catalog\//);
    assert.ok(!r.puts.some(p => p.key === SIG || p.key === HEAD), 'the pair is never written');
  });

  test('PB-mirror-swapped: an archive the mirror holds with other bytes refuses the run before any write', async () => {
    const live = objectsOf('A');
    live[`v1/archives/${sha(A100)}.zip`] = object(A110, 'application/zip', IMMUTABLE);
    const r = await upload(scenario({ live }));
    assert.equal(r.code, 1, r.out);
    assert.match(r.out, /swapped in R2/);
    assert.equal(r.puts.length, 0);
  });
});

describe('upload: refusals before any write', () => {
  test('PB-usage: the publish and resign forms, and --key only for target production', async () => {
    const sc = scenario();
    for (const args of [['--in', sc.inDir], ['--resign', '--target', 'production', '--in', sc.inDir], ['--target', 'test', '--repair', 'false', '--in', sc.inDir, '--key', PUB],
      ['--target', 'staging', '--repair', 'false', '--in', sc.inDir], ['--target', 'production', '--repair', 'maybe', '--in', sc.inDir]]) {
      const r = await run(TOOL, args, { env: sc.env });
      assert.equal(r.code, 2, `${args.join(' ')}: ${r.stdout}${r.stderr}`);
    }
    assert.deepEqual(readAwsLog(sc.awsLog), []);
  });

  test('PB-head-7-days: a head generated more than 7 days ago, or not the one the build job showed, is never uploaded', async () => {
    const h = JSON.parse(ix.B.head);
    const g = Date.now() - 8 * DAY;
    const old = Buffer.from(`${JSON.stringify({ ...h, generated: stamp(g), expires: stamp(g + LIFETIME_MS) }, null, 2)}\n`);
    const r = await upload(scenario({ head: old }));
    assert.equal(r.code, 1, r.out);
    assert.match(r.out, /more than 7 days ago/);
    assert.deepEqual(r.log, [], 'no aws call');
    const m = await upload(scenario({ env: { HEAD_SHA256: 'e'.repeat(64) } }));
    assert.equal(m.code, 1, m.out);
    assert.match(m.out, /not e{64}, the one the build job showed/);
    assert.deepEqual(m.log, []);
  });

  test('PB-runner-image: an AWS CLI that is not version 2, or whose put-object takes no --if-match, stops the run before any S3 call', async () => {
    const v1 = await upload(scenario({ version: 'aws-cli/1.33.0 Python/3.12.3 Linux/6.8.0 botocore/1.34.0' }));
    assert.equal(v1.code, 1, v1.out);
    assert.match(v1.out, /not version 2/);
    assert.deepEqual(v1.calls, []);
    const old = await upload(scenario({ skeletonDrop: ['IfMatch'] }));
    assert.equal(old.code, 1, old.out);
    assert.match(old.out, /--if-match/);
    assert.match(old.out, /pinned AWS CLI release/);
    assert.deepEqual(old.calls, []);
  });

  test('PB-credentials: a missing mirror variable is named (never its value) before any S3 call', async () => {
    const r = await upload(scenario({ env: { R2_SECRET_ACCESS_KEY: '' } }));
    assert.equal(r.code, 1, r.out);
    assert.match(r.out, /R2_SECRET_ACCESS_KEY/);
    assert.deepEqual(r.calls, []);
    const acct = await upload(scenario({ env: { R2_ACCOUNT_ID: 'not-an-account' } }));
    assert.equal(acct.code, 1, acct.out);
    assert.deepEqual(acct.calls, []);
  });

  test('PB-live-unverified-refused: a live pair the pinned keys refuse is LIVE UNVERIFIED; nothing is written', async () => {
    const live = objectsOf('A');
    live[SIG] = object(Buffer.from(otherSigner.sign(ix.A.head, I.indexComment(JSON.parse(ix.A.head).generated))), 'text/plain', 'no-cache');
    const r = await upload(scenario({ live }));
    assert.equal(r.code, 1, r.out);
    assert.match(r.out, /LIVE UNVERIFIED/);
    assert.equal(r.puts.length, 0);
  });

  test('PB-read-network-retried: a read that meets a network error is retried once; a second one refuses the run before any write', async () => {
    const net = (nth) => ({ op: 'get-object', key: HEAD, nth, result: 'network' });
    const once = await upload(scenario({ faults: [net(1)] }));
    assert.equal(once.code, 0, once.out);
    assert.match(once.last, /^PUBLISHED /);
    const twice = await upload(scenario({ faults: [net(1), net(2)] }));
    assert.equal(twice.code, 1, twice.out);
    assert.match(twice.out, /the live head cannot be read/);
    assert.equal(twice.puts.length, 0);
  });

  test('PB-rollback-refused: a new head older than the live one is never uploaded', async () => {
    const r = await upload(scenario({ input: 'A0' }));
    assert.equal(r.code, 1, r.out);
    assert.match(r.out, /older than the live head/);
    assert.equal(r.puts.length, 0);
  });

  test('PB-head-deleted-not-first-publish: a missing head after an approved, uploaded run is LIVE UNVERIFIED, not a first publish', async () => {
    const live = objectsOf('A');
    delete live[HEAD];
    const sc = scenario({ live, gh: 'approved' });
    const r = await upload(sc);
    assert.equal(r.code, 1, r.out);
    assert.match(r.out, /LIVE UNVERIFIED/);
    assert.match(r.out, /deleted head/);
    assert.equal(r.puts.length, 0);
    assert.ok(sc.ghLog().length > 0, 'GitHub was asked');
  });

  test('PB-head-missing-after-sign-not-first-publish: a missing head after an approved run whose sign succeeded is LIVE UNVERIFIED', async () => {
    // That run's upload failed, but its signed head may have gone live: a missing head now is a deleted one (recovery R2).
    for (const live of [{}, { [SIG]: object(ix.A0.sig, 'text/plain', 'no-cache') }]) {
      const r = await upload(scenario({ live, gh: 'signed' }));
      assert.equal(r.code, 1, r.out);
      assert.match(r.out, /LIVE UNVERIFIED: the live head is missing, but GitHub shows an approved run/);
      assert.match(r.out, /NOT A FIRST PUBLISH: run 200 /);
      assert.equal(r.puts.length, 0);
    }
  });

  test('PB-head-404-query-error-fails: a missing head and a GitHub query that fails is a refusal, never a first publish', async () => {
    const live = objectsOf('A');
    delete live[HEAD];
    const r = await upload(scenario({ live, gh: 'error' }));
    assert.equal(r.code, 1, r.out);
    assert.match(r.out, /LIVE UNVERIFIED/);
    assert.equal(r.puts.length, 0);
    const noRun = await upload(scenario({ live, gh: 'none', env: { GITHUB_RUN_ID: '' } }));
    assert.equal(noRun.code, 1, noRun.out);
    assert.equal(noRun.puts.length, 0);
  });

  test('REFUSED-one-line: a refusal whose text holds line breaks is one REFUSED line in build-index.mjs and upload.mjs; no line starts a workflow command', async () => {
    // A local path is text the tools print in a refusal: the output folder of build-index.mjs, a --key file of upload.mjs.
    // The runner reads its older command form, ##[...], anywhere in a line, so that never reaches the log either.
    const evil = 'x\n::error title=injected::injected\r\n::warning::second ##[error]legacy';
    const dir = tempDir('oneline');
    const out = path.join(dir, `out${evil}`);
    fs.mkdirSync(out);
    const b = await run('tools/build-index.mjs', ['base', '--target', 'test', '--repair', 'false', '--out', out]);
    assert.equal(b.code, 1, JSON.stringify(b.stdout + b.stderr));
    const sc = scenario();
    const u = await run(TOOL, ['--target', 'production', '--repair', 'false', '--in', sc.inDir, '--prefix', P, '--key', path.join(dir, `key${evil}.pub`)], { env: sc.env });
    assert.equal(u.code, 1, JSON.stringify(u.stdout + u.stderr));
    assert.deepEqual(readAwsLog(sc.awsLog), [], 'refused before any aws call');
    for (const [name, r, tail] of [['build-index.mjs', b, 'exists: write into a new folder'], ['upload.mjs', u, 'cannot be read']]) {
      const lines = `${r.stdout}\n${r.stderr}`.split(/\r\n|\r|\n/);
      assert.ok(lines.every(l => !l.trimStart().startsWith('::')), `${name}: no line starts a workflow command: ${JSON.stringify(lines)}`);
      assert.ok(lines.every(l => !l.includes('##[')), `${name}: no line holds the older command form: ${JSON.stringify(lines)}`);
      const refused = r.stderr.split('\n').filter(l => l.startsWith('REFUSED: '));
      assert.equal(refused.length, 1, `${name}: ${JSON.stringify(r.stderr)}`);
      assert.match(refused[0], new RegExp(`injected .*second # #\\[error\\]legacy.*${esc(tail)}`), `${name}: the whole refusal on its one line`);
    }
  });
});

describe('upload: recovery R1 on the signature', () => {
  test('PB-sig-lost-response-landed: a lost answer whose signature landed goes on to the head with the ETag of the re-read', async () => {
    const r = await upload(scenario({ faults: [{ op: 'put-object', key: SIG, nth: 1, result: 'network-landed' }] }));
    assert.equal(r.code, 0, r.out);
    assert.match(r.last, /^PUBLISHED /);
    const sigPuts = r.puts.filter(p => p.key === SIG);
    assert.equal(sigPuts.length, 2, 'one retry after the network error, which answers 412');
    assert.equal(r.puts.at(-1).key, HEAD);
    assert.match(r.out, /new signature is live/);
    assert.deepEqual(bytesOf(r.bucket, HEAD), ix.B.head);
  });

  test('PB-sig-412-nothing-written: a 412 with the old signature still live stops with no further write (unchanged, red)', async () => {
    const r = await upload(scenario({ faults: [{ op: 'put-object', key: SIG, nth: 1, result: '412' }] }));
    assert.equal(r.code, 1, r.out);
    assert.match(r.last, /^UNCHANGED/);
    assert.match(r.out, /^FAIL cas .*412/m);
    assert.ok(!r.puts.some(p => p.key === HEAD), 'the head is never written');
    assert.equal(r.puts.filter(p => p.key === SIG).length, 1, 'a 412 is not retried');
    assert.deepEqual(bytesOf(r.bucket, SIG), ix.A.sig);
  });

  test('PB-sig-changed-half-published: a signature someone else changed stops with no write; the final re-read says HALF-PUBLISHED', async () => {
    const r = await upload(scenario({ faults: [{ op: 'put-object', key: SIG, nth: 1, before: { [SIG]: garbage } }] }));
    assert.equal(r.code, 1, r.out);
    assert.match(r.last, /^HALF-PUBLISHED/);
    assert.ok(!r.puts.some(p => p.key === HEAD));
    assert.equal(r.puts.filter(p => p.key === SIG).length, 1);
  });

  test('PB-cas-412: a 412 on the signature or on the head ends the run red with no further write', async () => {
    const A0 = { [HEAD]: b64(ix.A0.head), [SIG]: b64(ix.A0.sig) };
    const s = await upload(scenario({ faults: [{ op: 'put-object', key: SIG, nth: 1, before: A0 }] }));
    assert.equal(s.code, 1, s.out);
    assert.match(s.out, /^FAIL cas index\.json\.minisig: 412/m);
    assert.match(s.last, /^REPLAYED/, 'an older verified pair written during the run');
    assert.ok(!s.puts.some(p => p.key === HEAD));
    const h = await upload(scenario({ faults: [{ op: 'put-object', key: HEAD, nth: 1, before: { [HEAD]: b64(ix.A0.head) } }] }));
    assert.equal(h.code, 1, h.out);
    assert.match(h.out, /^FAIL cas index\.json: 412/m);
    assert.equal(h.puts.filter(p => p.key === SIG).length, 1, 'nothing is restored over a head someone else wrote');
  });
});

describe('upload: recovery R1 on the head', () => {
  test('PB-head-lost-response-landed: a lost answer whose head landed is published; nothing is restored', async () => {
    const r = await upload(scenario({ faults: [{ op: 'put-object', key: HEAD, nth: 1, result: 'network-landed' }] }));
    assert.equal(r.code, 0, r.out);
    assert.match(r.last, /^PUBLISHED /);
    assert.equal(r.puts.filter(p => p.key === HEAD).length, 2, 'one retry, which answers 412');
    assert.equal(r.puts.filter(p => p.key === SIG).length, 1, 'no restore');
    assert.match(r.out, /the new head is live \(the answer was lost\)/);
    assert.doesNotMatch(r.out, /^FAIL /m, 'the 412 of the retry over its own landed head is not a compare-and-swap failure');
  });

  test('PB-head-fail-restores-sig: a head PUT that failed twice and did not land puts the old signature back on the new ETag', async () => {
    const r = await upload(scenario({ faults: [{ op: 'put-object', key: HEAD, nth: 1, result: 'network-lost' }, { op: 'put-object', key: HEAD, nth: 2, result: 'network-lost' }] }));
    assert.equal(r.code, 1, r.out);
    assert.match(r.last, /^UNCHANGED/);
    const sigPuts = r.puts.filter(p => p.key === SIG);
    assert.equal(sigPuts.length, 2);
    assert.equal(sigPuts[1].ifMatch, md5Etag(ix.B.sig), 'If-Match on the new signature\'s ETag');
    assert.equal(sigPuts[1].bodySha, sha(ix.A.sig), 'the old signature\'s bytes');
    assert.equal(sigPuts[1].cacheControl, 'no-cache');
    assert.deepEqual(bytesOf(r.bucket, SIG), ix.A.sig);
    assert.deepEqual(bytesOf(r.bucket, HEAD), ix.A.head);
    const lostHead = (nth) => ({ op: 'put-object', key: HEAD, nth, result: 'network-lost' });
    const n = await upload(scenario({ faults: [{ op: 'put-object', key: SIG, nth: 1, result: 'no-etag' }, lostHead(1), lostHead(2)] }));
    assert.equal(n.code, 1, n.out);
    assert.match(n.last, /^UNCHANGED/, 'a signature written with no ETag in the answer: the restore takes the ETag of a re-read');
    const nSig = n.puts.filter(p => p.key === SIG);
    assert.equal(nSig.length, 2);
    assert.equal(nSig[1].ifMatch, md5Etag(ix.B.sig));
    assert.deepEqual(bytesOf(n.bucket, SIG), ix.A.sig);
  });

  test('PB-restore-fails-half-published: a restore that fails leaves HALF-PUBLISHED', async () => {
    const lost = (key, nth) => ({ op: 'put-object', key, nth, result: 'network-lost' });
    const r = await upload(scenario({ faults: [lost(HEAD, 1), lost(HEAD, 2), lost(SIG, 2), lost(SIG, 3)] }));
    assert.equal(r.code, 1, r.out);
    assert.match(r.last, /^HALF-PUBLISHED/);
    assert.equal(r.puts.filter(p => p.key === SIG).length, 3, 'the signature, then the restore and its one retry');
  });

  test('PB-head-changed-half-published: a head someone else changed is never written over and nothing is restored', async () => {
    const r = await upload(scenario({ faults: [{ op: 'put-object', key: HEAD, nth: 1, before: { [HEAD]: b64(ix.A0.head) } }] }));
    assert.equal(r.code, 1, r.out);
    assert.match(r.last, /^HALF-PUBLISHED/);
    assert.equal(r.puts.filter(p => p.key === HEAD).length, 1);
    assert.equal(r.puts.filter(p => p.key === SIG).length, 1);
  });

  test('PB-final-reread-pair-broken: writes that succeeded but a pair that no longer verifies, or a re-read that fails, is HALF-PUBLISHED', async () => {
    const r = await upload(scenario({ faults: [{ op: 'put-object', key: HEAD, nth: 1, after: { [SIG]: garbage } }] }));
    assert.equal(r.code, 1, r.out);
    assert.match(r.last, /^HALF-PUBLISHED/);
    assert.match(r.out, /^FAIL r1 the live pair does not verify/m);
    const e = await upload(scenario({ faults: [{ op: 'get-object', key: HEAD, nth: 2, result: 'error' }, { op: 'get-object', key: HEAD, nth: 3, result: 'error' }] }));
    assert.equal(e.code, 1, e.out);
    assert.match(e.last, /^HALF-PUBLISHED/);
    assert.match(e.out, /^FAIL r1 the final re-read failed/m);
  });

  test('PB-final-reread-replayed: a pair that verifies but is neither the new nor the old one is REPLAYED', async () => {
    const r = await upload(scenario({ faults: [{ op: 'put-object', key: HEAD, nth: 1, after: { [HEAD]: b64(ix.A0.head), [SIG]: b64(ix.A0.sig) } }] }));
    assert.equal(r.code, 1, r.out);
    assert.match(r.last, /^REPLAYED/);
  });
});

describe('upload: a first publish', () => {
  test('PB-first-publish-orphan-overwritten: an orphan signature with no signed run on GitHub never blocks a first publish', async () => {
    const live = { [SIG]: object(ix.A0.sig, 'text/plain', 'no-cache') };
    const sc = scenario({ live, gh: 'none' });
    const r = await upload(sc);
    assert.equal(r.code, 0, r.out);
    assert.match(r.last, /^PUBLISHED /);
    const sig = r.puts.find(p => p.key === SIG), head = r.puts.find(p => p.key === HEAD);
    assert.deepEqual([sig.ifMatch, sig.ifNoneMatch], [md5Etag(ix.A0.sig), undefined], 'If-Match on the orphan');
    assert.deepEqual([head.ifMatch, head.ifNoneMatch], [undefined, '*'], 'no live head: create-only');
    assert.ok(sc.ghLog().length > 0, 'GitHub was asked whether there ever was a head');
  });

  test('PB-first-publish-orphan-not-half: a new signature with the head still missing is FIRST-PUBLISH ORPHAN; nothing is restored', async () => {
    const r = await upload(scenario({ live: {}, gh: 'none', faults: [{ op: 'put-object', key: HEAD, nth: 1, result: 'network-lost' }, { op: 'put-object', key: HEAD, nth: 2, result: 'network-lost' }] }));
    assert.equal(r.code, 1, r.out);
    assert.match(r.last, /^FIRST-PUBLISH ORPHAN/);
    assert.match(r.last, /this run signed, so the next run is no first publish: a repair run \(recovery R2\) overwrites it/);
    assert.doesNotMatch(r.out, /HALF-PUBLISHED/);
    assert.equal(r.puts.filter(p => p.key === SIG).length, 1, 'nothing restored');
    const n = await upload(scenario({ live: {}, gh: 'none', faults: [{ op: 'put-object', key: SIG, nth: 1, result: 'network-lost' }, { op: 'put-object', key: SIG, nth: 2, result: 'network-lost' }] }));
    assert.equal(n.code, 1, n.out);
    assert.match(n.last, /^UNCHANGED/, 'both objects still missing');
    assert.match(n.last, /this run signed, so the next run is no first publish: dispatch a repair run \(recovery R2\)/);
    assert.ok(!n.puts.some(p => p.key === HEAD));
    const lost = (nth) => ({ op: 'put-object', key: HEAD, nth, result: 'network-lost' });
    const e = await upload(scenario({ live: {}, gh: 'none', faults: [lost(1), lost(2), { op: 'get-object', key: SIG, nth: 2, result: 'error' }] }));
    assert.equal(e.code, 1, e.out);
    assert.match(e.last, /^HALF-PUBLISHED/, 'a final re-read that fails is never read as an orphan');
  });
});

describe('upload: target test and resign', () => {
  test('PB-test-target-throwaway-key-verify: test/v1/ only, the run\'s throwaway key, the older test pair neither checked nor restored', async () => {
    const live = objectsOf('AT', 'test/v1/');
    const r = await upload(scenario({ live, input: 'BT', testPub: true }), 'test');
    assert.equal(r.code, 0, r.out);
    assert.match(r.last, /^PUBLISHED /);
    assert.ok(r.calls.every(c => c.key.startsWith('test/v1/')), 'nothing outside test/v1/');
    assert.deepEqual(r.puts.slice(-2).map(p => [p.key, p.ifMatch]), [[TSIG, live[TSIG].etag], [THEAD, live[THEAD].etag]]);
    assert.deepEqual(bytesOf(r.bucket, THEAD), ix.BT.head);
    const f = await upload(scenario({ live, input: 'BT', testPub: true, faults: [{ op: 'put-object', key: THEAD, nth: 1, result: 'network-lost' }, { op: 'put-object', key: THEAD, nth: 2, result: 'network-lost' }] }), 'test');
    assert.equal(f.code, 1, f.out);
    assert.match(f.last, /^TEST NOT PUBLISHED/);
    assert.equal(f.puts.filter(p => p.key === TSIG).length, 1, 'no restore on target test');
    const nokey = await upload(scenario({ live, input: 'BT' }), 'test');
    assert.equal(nokey.code, 1, nokey.out);
    assert.match(nokey.out, /test\.pub/);
    assert.equal(nokey.puts.length, 0);
  });

  test('PB-resign-pair-only: resign writes only the signature and the head, each on the live ETag', async () => {
    const r = await upload(scenario({ input: 'R' }), 'resign', ['--tree', path.join(T, 'tree-A')]);
    assert.equal(r.code, 0, r.out);
    assert.match(r.last, /^PUBLISHED /);
    const A = objectsOf('A');
    assert.deepEqual(r.puts.map(p => [p.key, p.ifMatch]), [[SIG, A[SIG].etag], [HEAD, A[HEAD].etag]]);
    const live = objectsOf('A');
    delete live[HEAD];
    const gone = await upload(scenario({ input: 'R', live }), 'resign', ['--tree', path.join(T, 'tree-A')]);
    assert.equal(gone.code, 1, gone.out);
    assert.match(gone.out, /resign never/);
    assert.equal(gone.puts.length, 0);
  });

  test('MV-diverged-upload: resign refuses to re-sign a live catalog that is not main\'s (an older verified head replayed into the mirror)', async () => {
    const revoked = [{ id: 'dev.example.intel', versions: '*', reason: 'Revoked after the live head was made.', date: '2026-01-01' }];
    const tree = writeTree(path.join(T, 'tree-mv-revoked'), { ...TREE_A, revoked });
    const r = await upload(scenario({ input: 'R' }), 'resign', ['--tree', tree]);
    assert.equal(r.code, 1, r.out);
    assert.match(r.out, /REFUSED: MAIN DIVERGES: .*revocation on main only: dev\.example\.intel \*/);
    assert.equal(r.puts.length, 0, 'nothing is written');
    const more = writeTree(path.join(T, 'tree-mv-more'), TREE_B);
    const m = await upload(scenario({ input: 'R' }), 'resign', ['--tree', more]);
    assert.equal(m.code, 1, m.out);
    assert.match(m.out, /MAIN DIVERGES: .*listing on main only: dev\.example\.dusk/);
    assert.equal(m.puts.length, 0);
  });

  test('PB-resign-another-catalog: a resign whose new head names another catalog than the live head is refused, even when main has that catalog', async () => {
    const r = await upload(scenario({ input: 'B' }), 'resign', ['--tree', path.join(T, 'tree-B')]);
    assert.equal(r.code, 1, r.out);
    assert.match(r.out, /REFUSED: resign: the new head names another catalog than the live head/);
    assert.equal(r.puts.length, 0, 'nothing is written');
  });

  test('PB-tree-resign-only: --tree is a test option of the resign form only', async () => {
    const sc = scenario();
    const r = await run(TOOL, ['--target', 'production', '--repair', 'false', '--in', sc.inDir, '--tree', path.join(T, 'tree-B')], { env: sc.env });
    assert.equal(r.code, 2, r.stdout + r.stderr);
    assert.deepEqual(readAwsLog(sc.awsLog), []);
  });
});

// ---- recovery R2: build-index.mjs base and --compare-live with --repair true, and the upload step's own base and floor ----------------
describe('recovery R2 (repair: true)', () => {
  const X = { id: 'dev.example.gone', versions: '*', reason: 'Revoked by the half-published run.', date: '2026-01-01' };
  const Y = { id: 'dev.example.old', versions: '*', reason: 'Revoked by an older run.', date: '2026-01-01' };
  before(async () => {
    // AY: an older uploaded run's index revoking Y. HR: the half-published run's index (signed, its upload failed), newer than A and
    // AY, revoking X only. NR keeps X, NL lifts it. NO: NR's head over a catalog generated as A's (older than HR's catalog).
    await sleep(1100);
    await buildIndex('AY', { ...TREE_A, revoked: [Y] }, P, signer);
    await sleep(1100);
    await buildIndex('HR', { ...TREE_A, revoked: [X] }, P, signer);
    await sleep(1100);
    await buildIndex('NR', { ...TREE_B, revoked: [X] }, P, signer);
    await buildIndex('NL', TREE_B, P, signer);
    const dir = path.join(T, 'NO');
    fs.cpSync(ix.NR.dir, dir, { recursive: true });
    const catFile = fs.readdirSync(path.join(dir, 'catalog'))[0];
    const cat = Buffer.from(JSON.stringify({ ...JSON.parse(fs.readFileSync(path.join(dir, 'catalog', catFile), 'utf8')), generated: JSON.parse(ix.A.head).generated }));
    fs.rmSync(path.join(dir, 'catalog', catFile));
    fs.writeFileSync(path.join(dir, 'catalog', `${sha(cat)}.json`), cat);
    const h = JSON.parse(ix.NR.head);
    fs.writeFileSync(path.join(dir, 'index.json'), `${JSON.stringify({ ...h, catalog: { url: `${P}catalog/${sha(cat)}.json`, sha256: sha(cat), size: cat.length } }, null, 2)}\n`);
    signFolder(dir, signer);
    ix.NO = { dir, list: ix.NR.list, head: fs.readFileSync(path.join(dir, 'index.json')), sig: fs.readFileSync(path.join(dir, 'index.json.minisig')) };
  });
  /** The live state a half-finished upload leaves: HR's head and catalog, A's signature (the pair does not verify). */
  const broken = () => ({ ...objectsOf('A'), ...objectsOf('HR'), [SIG]: objectsOf('A')[SIG] });
  /** An unsigned head generated at `g` (ms) that names a catalog without any revocation, served with that catalog. */
  const attacker = (g) => {
    const cat = Buffer.from(JSON.stringify({ schema: 1, generated: stamp(g), plugins: [], revoked: [] }));
    const h = Buffer.from(JSON.stringify({ schema: 1, generated: stamp(g), expires: stamp(g + LIFETIME_MS), catalog: { url: `${P}catalog/${sha(cat)}.json`, sha256: sha(cat), size: cat.length } }));
    return { ...broken(), [HEAD]: object(h, 'application/json', 'no-cache'), [`v1/catalog/${sha(cat)}.json`]: object(cat, 'application/json', IMMUTABLE) };
  };
  const base = (sc, out) => run('tools/build-index.mjs', ['base', '--target', 'production', '--repair', 'true', '--out', out, '--summary', sc.summary, '--prefix', P, '--key', PUB], { env: sc.env });
  const compare = (sc, baseDir, index, liftText, repair = 'true') => {
    const lift = path.join(sc.dir, `lift-${Math.random().toString(16).slice(2)}.txt`);
    fs.writeFileSync(lift, liftText);
    return run('tools/build-index.mjs', ['--compare-live', '--base', baseDir, '--index', ix[index].dir, '--lift', lift, '--repair', repair], { env: sc.env });
  };

  test('PB-repair-not-broken: repair against a live index that verifies is refused by the build step and the upload step', async () => {
    const sc = scenario({ input: 'NR', routes: repairRoutes() });
    const b = await base(sc, path.join(sc.dir, 'base'));
    assert.equal(b.code, 1, b.stdout + b.stderr);
    assert.match(b.stderr, /^REFUSED: NOT BROKEN: /m);
    assert.ok(!fs.existsSync(path.join(sc.dir, 'base')));
    const u = await upload(sc, 'repair');
    assert.equal(u.code, 1, u.out);
    assert.match(u.out, /NOT BROKEN/);
    assert.equal(u.puts.length, 0);
    assert.equal(sc.ghLog().length, 0, 'GitHub is not asked for a live index that verifies');
  });

  test('PB-repair-build-and-upload: the base is the verified half-published run, lifts count against the union, the upload publishes', async () => {
    const sc = scenario({ live: broken(), input: 'NR', routes: repairRoutes() });
    const out = path.join(sc.dir, 'base');
    const b = await base(sc, out);
    assert.equal(b.code, 0, b.stdout + b.stderr);
    assert.match(b.stdout, /^BASE REPAIR /m);
    const meta = JSON.parse(fs.readFileSync(path.join(out, 'BASE.json'), 'utf8'));
    assert.equal(meta.kind, 'repair');
    assert.equal(meta.baseRun, 290);
    assert.equal(meta.floor, JSON.parse(ix.HR.head).generated);
    assert.deepEqual(meta.union.map(r => r.id), [X.id]);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(out, 'catalog.json'), 'utf8')).revoked, [X], 'the half-published run\'s own catalog artifact');
    assert.deepEqual(fs.readFileSync(path.join(out, 'index.json')), ix.HR.head);
    assert.match(fs.readFileSync(sc.summary, 'utf8'), /REPAIR/);
    assert.match(b.stdout, /run 290 .*verifies/);
    assert.match(b.stdout, /floor .* from run 290's verified head/);
    const keep = await compare(sc, out, 'NR', '\n');
    assert.equal(keep.code, 0, keep.stdout + keep.stderr);
    assert.match(keep.stdout, /^COMPARE OK against the repair base /m);
    const dropped = await compare(sc, out, 'NL', '\n');
    assert.equal(dropped.code, 1, dropped.stdout);
    assert.match(dropped.stdout, /^FAIL lift .*dev\.example\.gone \*/m);
    const lifted = await compare(sc, out, 'NL', 'dev.example.gone *\n');
    assert.equal(lifted.code, 0, lifted.stdout + lifted.stderr);
    assert.match(lifted.stdout, /^NOTE revocation lifted: dev\.example\.gone \*/m);
    const u = await upload(sc, 'repair');
    assert.equal(u.code, 0, u.out);
    assert.match(u.last, /^PUBLISHED .*REPAIR/);
    const live = broken();
    assert.deepEqual(u.puts.slice(-2).map(p => [p.key, p.ifMatch]), [[SIG, live[SIG].etag], [HEAD, live[HEAD].etag]]);
    assert.deepEqual(bytesOf(u.bucket, HEAD), ix.NR.head);
    assert.match(u.out, /repair: base: run 290 /);
  });

  test('PB-repair-union-revocations: an older verified candidate\'s revocation the base dropped still needs a lift', async () => {
    const sc = scenario({ live: broken(), input: 'NR', routes: repairRoutes({ older: 'AY' }) });
    const out = path.join(sc.dir, 'base');
    const b = await base(sc, out);
    assert.equal(b.code, 0, b.stdout + b.stderr);
    const meta = JSON.parse(fs.readFileSync(path.join(out, 'BASE.json'), 'utf8'));
    assert.equal(meta.baseRun, 290);
    assert.deepEqual(meta.union.map(r => r.id), [X.id, Y.id]);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(out, 'catalog.json'), 'utf8')).revoked, [X], 'the base catalog revokes X only');
    const dropped = await compare(sc, out, 'NR', '\n');
    assert.equal(dropped.code, 1, dropped.stdout);
    assert.match(dropped.stdout, /^FAIL lift .*union.*dev\.example\.old \*/m);
    const lifted = await compare(sc, out, 'NR', 'dev.example.old *\n');
    assert.equal(lifted.code, 0, lifted.stdout + lifted.stderr);
    assert.match(lifted.stdout, /^NOTE revocation lifted: dev\.example\.old \*/m);
    const u = await upload(sc, 'repair');
    assert.equal(u.code, 0, u.out);
    assert.match(u.out, /uploading it lifts the revocation dev\.example\.old \*/);
    assert.doesNotMatch(u.out, /uploading it lifts the revocation dev\.example\.gone/);
  });

  test('PB-repair-catalog-not-older: a new head over a catalog older than the base catalog is a rollback', async () => {
    const sc = scenario({ live: broken(), input: 'NO', routes: repairRoutes() });
    const out = path.join(sc.dir, 'base');
    assert.equal((await base(sc, out)).code, 0);
    const c = await compare(sc, out, 'NO', '\n');
    assert.equal(c.code, 1, c.stdout);
    assert.match(c.stdout, /^FAIL rollback .*older than the base catalog/m);
    const u = await upload(sc, 'repair');
    assert.equal(u.code, 1, u.out);
    assert.match(u.out, /older than the base catalog/);
    assert.equal(u.puts.length, 0);
  });

  test('PB-repair-unsigned-head-never-base: an attacker-written live head and its catalog are never the base', async () => {
    const sc = scenario({ live: attacker(Date.now() - 60 * DAY / 60), input: 'NL', routes: repairRoutes() });
    const out = path.join(sc.dir, 'base');
    const b = await base(sc, out);
    assert.equal(b.code, 0, b.stdout + b.stderr);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(out, 'catalog.json'), 'utf8')).revoked, [X], 'not the live catalog without revocations');
    const dropped = await compare(sc, out, 'NL', '\n');
    assert.equal(dropped.code, 1, dropped.stdout);
    assert.match(dropped.stdout, /^FAIL lift .*dev\.example\.gone \*/m, 'the revocation the live catalog dropped still needs a lift');
    const u = await upload(sc, 'repair');
    assert.equal(u.code, 0, u.out);
    assert.match(u.out, /uploading it lifts the revocation dev\.example\.gone \*/);
  });

  test('PB-repair-floor-raised-only: an unsigned live generated newer than the new head blocks it; one over 5 minutes ahead is ignored', async () => {
    const near = scenario({ live: attacker(Date.now() + 120_000), input: 'NR', routes: repairRoutes() });
    const out = path.join(near.dir, 'base');
    const b = await base(near, out);
    assert.equal(b.code, 0, b.stdout + b.stderr);
    assert.match(b.stdout, /floor .* from the unsigned live head/);
    const c = await compare(near, out, 'NR', '\n');
    assert.equal(c.code, 1, c.stdout);
    assert.match(c.stdout, /^FAIL rollback .*repair floor/m);
    const u = await upload(near, 'repair');
    assert.equal(u.code, 1, u.out);
    assert.match(u.out, /not newer than the repair floor/);
    assert.equal(u.puts.length, 0);
    const far = scenario({ live: attacker(Date.now() + DAY), input: 'NR', routes: repairRoutes() });
    const out2 = path.join(far.dir, 'base');
    const b2 = await base(far, out2);
    assert.equal(b2.code, 0, b2.stdout + b2.stderr);
    assert.match(b2.stdout, /more than 5 minutes ahead of now: ignored/);
    const c2 = await compare(far, out2, 'NR', '\n');
    assert.equal(c2.code, 0, c2.stdout + c2.stderr);
    const u2 = await upload(far, 'repair');
    assert.equal(u2.code, 0, u2.out);
    // The base's own head again (generated exactly at the floor) is a rollback too.
    const same = scenario({ live: broken(), input: 'HR', routes: repairRoutes() });
    const out3 = path.join(same.dir, 'base');
    assert.equal((await base(same, out3)).code, 0);
    const c3 = await compare(same, out3, 'HR', '\n');
    assert.equal(c3.code, 1, c3.stdout);
    assert.match(c3.stdout, /^FAIL rollback .*repair floor/m);
    const u3 = await upload(same, 'repair');
    assert.equal(u3.code, 1, u3.out);
    assert.match(u3.out, /not newer than the repair floor/);
    assert.equal(u3.puts.length, 0);
  });

  test('PB-repair-artifact-missing-stops: a candidate without its head or signature artifact stops the build and the upload step', async () => {
    const sc = scenario({ live: broken(), input: 'NR', routes: repairRoutes({ drop: { 290: ['head'] } }) });
    const b = await base(sc, path.join(sc.dir, 'base'));
    assert.equal(b.code, 1, b.stdout + b.stderr);
    assert.match(b.stderr, /^REFUSED: ARTIFACT MISSING: run 290 .*head/m);
    assert.ok(!fs.existsSync(path.join(sc.dir, 'base')));
    const sig = scenario({ live: broken(), input: 'NR', routes: repairRoutes({ drop: { 280: ['signature'] } }) });
    const u = await upload(sig, 'repair');
    assert.equal(u.code, 1, u.out);
    assert.match(u.out, /ARTIFACT MISSING: run 280 .*signature/);
    assert.equal(u.puts.length, 0);
    const noRun = scenario({ live: broken(), input: 'NR', routes: repairRoutes(), env: { GITHUB_RUN_ID: '' } });
    const n = await upload(noRun, 'repair');
    assert.equal(n.code, 1, n.out);
    assert.match(n.out, /REPAIR: no run id \(GITHUB_RUN_ID\)/);
    assert.equal(n.puts.length, 0);
    const nb = await base(noRun, path.join(noRun.dir, 'base'));
    assert.equal(nb.code, 1);
    assert.match(nb.stderr, /^REFUSED: REPAIR: no run id \(GITHUB_RUN_ID\)/m);
    assert.equal(noRun.ghLog().length, 0, 'GitHub is not asked without the run id');
  });

  test('PB-repair-base-kind: --repair true takes only a repair base, and --repair false never a repair base', async () => {
    const sc = scenario({ live: broken(), input: 'NR', routes: repairRoutes() });
    const out = path.join(sc.dir, 'base');
    assert.equal((await base(sc, out)).code, 0);
    const f = await compare(sc, out, 'NR', '\n', 'false');
    assert.equal(f.code, 1, f.stdout);
    assert.match(f.stderr, /repair base/);
    const ok = scenario({ input: 'NR' });
    const live = path.join(ok.dir, 'live');
    const lb = await run('tools/build-index.mjs', ['base', '--target', 'production', '--repair', 'false', '--out', live, '--prefix', P, '--key', PUB], { env: ok.env });
    assert.equal(lb.code, 0, lb.stdout + lb.stderr);
    const t = await compare(ok, live, 'NR', '\n', 'true');
    assert.equal(t.code, 1, t.stdout);
    assert.match(t.stderr, /--repair true needs/);
  });

  test('PB-repair-production-only: the upload step refuses --repair true for target test before it reads anything', async () => {
    const sc = scenario({ testPub: true, routes: repairRoutes() });
    const r = await run(TOOL, ['--target', 'test', '--repair', 'true', '--in', sc.inDir, '--prefix', PT], { env: sc.env });
    assert.equal(r.code, 1, r.stdout + r.stderr);
    assert.match(r.stderr, /^REFUSED: repair is for target production only/m);
    assert.deepEqual(readAwsLog(sc.awsLog), []);
    assert.equal(sc.ghLog().length, 0);
  });

  test('PB-repair-empty-live-head: a 0-byte live object (a ranged GET answers InvalidRange) reads as empty bytes and never blocks a repair', async () => {
    const empty = object(Buffer.alloc(0), 'application/json', 'no-cache');
    for (const live of [{ ...broken(), [HEAD]: empty }, { ...broken(), [HEAD]: empty, [SIG]: { ...empty, contentType: 'text/plain' } }]) {
      const u = await upload(scenario({ live, input: 'NR', routes: repairRoutes() }), 'repair');
      assert.equal(u.code, 0, u.out);
      assert.match(u.last, /^PUBLISHED .*REPAIR/);
      assert.equal(u.puts.find(p => p.key === HEAD).ifMatch, md5Etag(Buffer.alloc(0)), 'If-Match on the empty head\'s ETag');
      assert.equal(u.puts.find(p => p.key === SIG).ifMatch, live[SIG].etag);
      assert.ok(u.calls.some(c => c.op === 'head-object' && c.key === HEAD), 'the empty object\'s ETag comes from head-object');
      assert.match(u.out, /REPAIR: the live head and signature do not verify/);
    }
    const p = await upload(scenario({ live: { ...broken(), [HEAD]: empty }, input: 'NR', routes: repairRoutes() }));
    assert.equal(p.code, 1, p.out);
    assert.match(p.out, /LIVE UNVERIFIED: the live head and signature do not verify/, 'without repair: recovery R2, never "dispatch again later"');
    assert.doesNotMatch(p.out, /cannot be read/);
    const grown = { op: 'head-object', key: HEAD, nth: 1, before: { [HEAD]: b64('x') } };
    const raced = await upload(scenario({ live: { ...broken(), [HEAD]: empty }, input: 'NR', routes: repairRoutes(), faults: [grown] }), 'repair');
    assert.equal(raced.code, 1, raced.out);
    assert.match(raced.out, /the live head cannot be read \(.*not a 0-byte object/, 'an object that is not empty at head-object is never read as empty');
    assert.equal(raced.puts.length, 0);
    const gone = await upload(scenario({ live: { ...broken(), [HEAD]: empty }, input: 'NR', routes: repairRoutes(), faults: [{ ...grown, before: { [HEAD]: null } }] }), 'repair');
    assert.equal(gone.code, 1, gone.out);
    assert.match(gone.out, /the live head cannot be read \(get-object answered InvalidRange and head-object missing: /);
    assert.equal(gone.puts.length, 0);
    const noEtag = await upload(scenario({ live: { ...broken(), [HEAD]: empty }, input: 'NR', routes: repairRoutes(), faults: [{ op: 'head-object', key: HEAD, nth: 1, result: 'no-etag' }] }), 'repair');
    assert.equal(noEtag.code, 1, noEtag.out);
    assert.match(noEtag.out, /the live head cannot be read \(get-object answered InvalidRange and head-object named no ETag\)/);
    assert.equal(noEtag.puts.length, 0);
    const net = await upload(scenario({ live: { ...broken(), [HEAD]: empty }, input: 'NR', routes: repairRoutes(), faults: [{ op: 'head-object', key: HEAD, nth: 1, result: 'network' }] }), 'repair');
    assert.equal(net.code, 0, `one network error of head-object is retried once\n${net.out}`);
    assert.equal(net.calls.filter(c => c.op === 'head-object' && c.key === HEAD).length >= 2, true);
  });

  test('PB-repair-r1-no-restore: a head PUT that did not land restores nothing over a pair that never verified', async () => {
    const lost = (nth) => ({ op: 'put-object', key: HEAD, nth, result: 'network-lost' });
    const r = await upload(scenario({ live: broken(), input: 'NR', routes: repairRoutes(), faults: [lost(1), lost(2)] }), 'repair');
    assert.equal(r.code, 1, r.out);
    assert.equal(r.puts.filter(p => p.key === SIG).length, 1, 'the old signature is not put back');
    assert.match(r.last, /^HALF-PUBLISHED/, 'the new signature over the old head does not verify');
    const s = await upload(scenario({ live: broken(), input: 'NR', routes: repairRoutes(), faults: [{ op: 'put-object', key: SIG, nth: 1, result: '412' }] }), 'repair');
    assert.equal(s.code, 1, s.out);
    assert.match(s.last, /^UNCHANGED: the live index still does not verify/);
  });

  // One definition of "the live index verifies" (liveVerifies in tools/lib/indexbuild.mjs: the head, its signature and
  // the catalog the head names) in build-index.mjs base, with and without repair, and in upload.mjs, so no state is refused by one step
  // and taken by the other.
  describe('one definition of "the live index verifies"', () => {
    /** A's live index with its catalog object gone: the head and its signature still verify. */
    const catalogGone = () => { const live = objectsOf('A'); delete live[catKeyOf('A')]; return live; };

    test('LIVE-catalog-missing-normal-refuses: a live pair that verifies over a missing catalog is LIVE UNVERIFIED in build and upload alike', async () => {
      const sc = scenario({ live: catalogGone(), input: 'NR' });
      const want = new RegExp(`^REFUSED: LIVE UNVERIFIED: ${esc(catKeyOf('A').slice(3))}: HTTP 404; recovery R2 `, 'm');
      const b = await normalBase(sc, path.join(sc.dir, 'base'));
      assert.equal(b.code, 1, b.stdout + b.stderr);
      assert.match(b.stderr, want);
      assert.ok(!fs.existsSync(path.join(sc.dir, 'base')));
      const u = await upload(sc);
      assert.equal(u.code, 1, u.out);
      assert.match(u.out, want, 'the upload step refuses on the same definition, with the same way out');
      assert.equal(u.puts.length, 0, 'nothing is written');
      assert.deepEqual(u.calls.map(c => [c.op, c.key]), [['get-object', HEAD], ['get-object', SIG]], 'refused at the live read, before any archive is read');
      assert.equal(sc.ghLog().length, 0, 'a live head: GitHub is not asked');
    });

    test('LIVE-catalog-missing-repair-publishes: the same state is repaired: build passes, upload writes the new catalog and the pair', async () => {
      const sc = scenario({ live: catalogGone(), input: 'NR', routes: repairRoutes() });
      const out = path.join(sc.dir, 'base');
      const b = await base(sc, out);
      assert.equal(b.code, 0, b.stdout + b.stderr);
      assert.match(b.stdout, /^NOTE REPAIR: the live index does not verify \(catalog\/[0-9a-f]{64}\.json: HTTP 404\)/m);
      assert.match(b.stdout, /^BASE REPAIR run 290 /m);
      const c = await compare(sc, out, 'NR', '\n');
      assert.equal(c.code, 0, c.stdout + c.stderr);
      const u = await upload(sc, 'repair');
      assert.equal(u.code, 0, u.out);
      assert.match(u.last, /^PUBLISHED .*REPAIR/);
      assert.match(u.out, /^NOTE REPAIR: the live head and signature verify, but the live index does not \(catalog\/[0-9a-f]{64}\.json: HTTP 404\)/m);
      const catKey = catKeyOf('NR');
      const cat = u.puts.find(p => p.key === catKey);
      assert.deepEqual([cat?.ifNoneMatch, cat?.cacheControl], ['*', IMMUTABLE], 'the new catalog, create-only');
      const A = objectsOf('A');
      assert.deepEqual(u.puts.slice(-2).map(p => [p.key, p.ifMatch]), [[SIG, A[SIG].etag], [HEAD, A[HEAD].etag]], 'then the pair, on the live ETags');
      assert.deepEqual(bytesOf(u.bucket, catKey), fs.readFileSync(path.join(ix.NR.dir, ...catKey.slice(3).split('/'))));
      assert.deepEqual(bytesOf(u.bucket, HEAD), ix.NR.head);
      assert.deepEqual(bytesOf(u.bucket, SIG), ix.NR.sig);
      const next = await normalBase(sc, path.join(sc.dir, 'next'));
      assert.equal(next.code, 0, next.stdout + next.stderr);
      assert.match(next.stdout, /^BASE live /m, 'the live index verifies again: the next run is a normal one');
    });

    test('LIVE-head-over-cap: a live head over its cap (an R2 writer\'s) is LIVE UNVERIFIED on a normal run and opens the repair in build and upload', async () => {
      const big = object(Buffer.alloc(I.MAX_HEAD_BYTES + 1, 0x20), 'application/json', 'no-cache');
      const sc = scenario({ live: { ...objectsOf('A'), [HEAD]: big }, input: 'NR', routes: repairRoutes() });
      const nb = await normalBase(sc, path.join(sc.dir, 'normal'));
      assert.equal(nb.code, 1, nb.stdout + nb.stderr);
      assert.match(nb.stderr, new RegExp(`^REFUSED: LIVE UNVERIFIED: index\\.json: more than ${I.MAX_HEAD_BYTES} bytes; recovery R2 `, 'm'));
      const nu = await upload(sc);
      assert.equal(nu.code, 1, nu.out);
      assert.match(nu.out, /^REFUSED: LIVE UNVERIFIED: the live head and signature do not verify .*; recovery R2 /m);
      assert.equal(nu.puts.length, 0);
      assert.doesNotMatch(nb.stderr + nu.out, /dispatch again later/, 'a head over its cap is a verdict, never "dispatch again later"');
      const out = path.join(sc.dir, 'base');
      const b = await base(sc, out);
      assert.equal(b.code, 0, b.stdout + b.stderr);
      assert.match(b.stdout, new RegExp(`^NOTE REPAIR: the live index does not verify \\(index\\.json: more than ${I.MAX_HEAD_BYTES} bytes\\)`, 'm'));
      assert.match(b.stdout, /^BASE REPAIR run 290 /m);
      const c = await compare(sc, out, 'NR', '\n');
      assert.equal(c.code, 0, c.stdout + c.stderr);
      const u = await upload(sc, 'repair');
      assert.equal(u.code, 0, u.out);
      assert.match(u.last, /^PUBLISHED .*REPAIR/);
      assert.deepEqual(u.puts.slice(-2).map(p => [p.key, p.ifMatch]), [[SIG, objectsOf('A')[SIG].etag], [HEAD, big.etag]], 'the pair, on the live ETags (the head\'s from its size check)');
      assert.deepEqual(bytesOf(u.bucket, HEAD), ix.NR.head);
    });

    test('LIVE-catalog-over-cap: a live catalog over the size its head names is LIVE UNVERIFIED in build and upload and opens the repair', async () => {
      const key = catKeyOf('A');
      const A = objectsOf('A');
      const over = object(Buffer.concat([bytesOf(A, key), Buffer.from(' ')]), 'application/json', IMMUTABLE);
      const sc = scenario({ live: { ...A, [key]: over }, input: 'NR', routes: repairRoutes() });
      const want = new RegExp(`^REFUSED: LIVE UNVERIFIED: ${esc(key.slice(3))}: more than ${bytesOf(A, key).length} bytes; recovery R2 `, 'm');
      const nb = await normalBase(sc, path.join(sc.dir, 'normal'));
      assert.equal(nb.code, 1, nb.stdout + nb.stderr);
      assert.match(nb.stderr, want);
      const nu = await upload(sc);
      assert.equal(nu.code, 1, nu.out);
      assert.match(nu.out, want, 'the upload step refuses on the same definition, with the same way out');
      assert.equal(nu.puts.length, 0);
      const b = await base(sc, path.join(sc.dir, 'base'));
      assert.equal(b.code, 0, b.stdout + b.stderr);
      assert.match(b.stdout, /^BASE REPAIR run 290 /m);
    });

    test('LIVE-archive-swapped: other bytes under a live archive leave the index verifying: upload refuses swapped, repair is NOT BROKEN; once the owner deletes the object a normal run restores it', async () => {
      const key = `v1/archives/${sha(A100)}.zip`;
      const live = objectsOf('A');
      live[key] = object(Buffer.from('not the archive'), 'application/zip', IMMUTABLE);
      const sc = scenario({ live, input: 'B' });
      const b = await normalBase(sc, path.join(sc.dir, 'base'));
      assert.equal(b.code, 0, b.stdout + b.stderr);
      assert.match(b.stdout, /^BASE live /m, 'the head, its signature and the catalog verify; archives are not part of the definition');
      const u = await upload(sc);
      assert.equal(u.code, 1, u.out);
      assert.match(u.out, new RegExp(`^REFUSED: the mirror holds another file under ${esc(key.slice(3))} .*swapped in R2`, 'm'));
      assert.equal(u.puts.length, 0, 'nothing is written');
      const rs = scenario({ live, input: 'NR', routes: repairRoutes() });
      const notBroken = new RegExp(`^REFUSED: NOT BROKEN: the live index verifies with the --key keys \\(the head generated ${esc(JSON.parse(ix.A.head).generated)}, `
        + `${esc(catKeyOf('A').slice(3))}\\); repair \\(recovery R2\\) is only for a live index that does not verify: dispatch publish\\.yml without repair$`, 'm');
      const rb = await base(rs, path.join(rs.dir, 'base'));
      assert.equal(rb.code, 1, rb.stdout + rb.stderr);
      assert.match(rb.stderr, notBroken);
      const ru = await upload(rs, 'repair');
      assert.equal(ru.code, 1, ru.out);
      assert.match(ru.out, notBroken, 'the upload step refuses on the same definition, in the same words');
      assert.equal(ru.puts.length, 0);
      assert.equal(rs.ghLog().length, 0, 'GitHub is not asked for a live index that verifies');
      // The owner looks into it and deletes the object (docs/RUNBOOK.md); a normal run then uploads the archive again, create-only.
      delete live[key];
      const n = await upload(scenario({ live, input: 'B' }));
      assert.equal(n.code, 0, n.out);
      assert.match(n.last, /^PUBLISHED /);
      const p = n.puts.find(x => x.key === key);
      assert.deepEqual([p?.ifNoneMatch, p?.cacheControl], ['*', IMMUTABLE]);
      assert.deepEqual(bytesOf(n.bucket, key), A100);
    });
  });

  // The index served over the prefix (the edge, which caches) and the objects in R2 are read apart. A read that fails says nothing
  // about the index, an edge that serves another pair is no verdict on the bucket, and a catalog the edge still serves from its cache
  // may be gone from R2.
  describe('the index served and the pair in R2', () => {
    test('LIVE-read-fails-dispatch-again: a signature or catalog the edge answers with HTTP 503 or 429 is "dispatch again later" in build and upload, normal, repair and resign; nothing is written', async () => {
      for (const [key, status] of [[catKeyOf('A'), 503], [SIG, 429]]) {
        const edge = { [key]: { status } };
        const want = new RegExp(`^REFUSED: the live index cannot be read \\(${esc(key.slice(3))}: HTTP ${status}\\): .*dispatch again later$`, 'm');
        const rs = scenario({ input: 'NR', routes: repairRoutes(), edge });
        const rb = await base(rs, path.join(rs.dir, 'base'));
        assert.equal(rb.code, 1, rb.stdout + rb.stderr);
        assert.match(rb.stderr, want, 'repair: never opened by a read that failed over a healthy bucket');
        assert.ok(!fs.existsSync(path.join(rs.dir, 'base')));
        const ru = await upload(rs, 'repair');
        assert.equal(ru.code, 1, ru.out);
        assert.match(ru.out, want, 'the upload step refuses the repair in the same way');
        assert.equal(ru.puts.length, 0, 'nothing is written');
        assert.equal(rs.ghLog().length, 0, 'GitHub is not asked');
        const sc = scenario({ input: 'B', edge });
        const nb = await normalBase(sc, path.join(sc.dir, 'base'));
        assert.equal(nb.code, 1, nb.stdout + nb.stderr);
        assert.match(nb.stderr, want, 'a normal run: never LIVE UNVERIFIED for a read that failed');
        const nu = await upload(sc);
        assert.equal(nu.code, 1, nu.out);
        assert.match(nu.out, want);
        assert.equal(nu.puts.length, 0);
        const rc = await resignCheck(sc, path.join(T, 'tree-A'));
        assert.equal(rc.code, 1, rc.stdout + rc.stderr);
        assert.match(rc.stderr, want, 'resign-check: never "does not verify" for a read that failed');
        const u = await upload(scenario({ input: 'R', edge }), 'resign', ['--tree', path.join(T, 'tree-A')]);
        assert.equal(u.code, 1, u.out);
        assert.match(u.out, want);
        assert.equal(u.puts.length, 0);
      }
    });

    test('LIVE-edge-not-bucket: an index served that is not the pair in R2 (an edge behind the bucket, or one serving other bytes) is "dispatch again later" for a publish and a re-sign; nothing is written', async () => {
      const A0 = objectsOf('A0');
      const live = { ...objectsOf('A'), [catKeyOf('A0')]: A0[catKeyOf('A0')] }; // A0's pair, served alone, verifies over its catalog
      const want = /^REFUSED: the index served over the prefix is not the head and signature in R2 .*dispatch again later(; if it persists past ~10 min: a security event \(docs\/RUNBOOK\.md, REPLAYED\))?$/m;
      for (const edge of [{ [HEAD]: A0[HEAD], [SIG]: A0[SIG] }, { [SIG]: A0[SIG] }, { [HEAD]: null }, { [SIG]: null }]) {
        const what = JSON.stringify(Object.keys(edge));
        const u = await upload(scenario({ live, input: 'B', edge }));
        assert.equal(u.code, 1, `${what}: ${u.out}`);
        assert.match(u.out, want, what);
        assert.doesNotMatch(u.out, /LIVE UNVERIFIED/, `${what}: the bucket's pair verifies; the edge is no verdict on it`);
        assert.equal(u.puts.length, 0, what);
        const r = await upload(scenario({ live, input: 'R', edge }), 'resign', ['--tree', path.join(T, 'tree-A')]);
        assert.equal(r.code, 1, `${what}: ${r.out}`);
        assert.match(r.out, want, what);
        assert.equal(r.puts.length, 0, what);
      }
    });

    test('LIVE-edge-older-pair: an older pair that verifies, served in place of the pair in R2, names both generated times and the security event; over a broken R2 pair it never sends the owner round LIVE UNVERIFIED -> repair -> NOT BROKEN', async () => {
      const A0 = objectsOf('A0');
      const edge = { [HEAD]: A0[HEAD], [SIG]: A0[SIG] };
      const g = (name) => esc(JSON.parse(ix[name].head).generated);
      const security = '; if it persists past ~10 min: a security event \\(docs/RUNBOOK\\.md, REPLAYED\\)$';
      const served = `\\(served: a pair that verifies, the head generated ${g('A0')}; R2: `;
      // The pair in R2 verifies: a publish waits for the edge, and is told when waiting is no longer the answer.
      const ok = await upload(scenario({ live: { ...objectsOf('A'), [catKeyOf('A0')]: A0[catKeyOf('A0')] }, input: 'B', edge }));
      assert.equal(ok.code, 1, ok.out);
      assert.match(ok.out, new RegExp(`^REFUSED: the index served over the prefix is not the head and signature in R2 ${served}the head generated ${g('A')}\\): .*dispatch again later${security}`, 'm'));
      assert.equal(ok.puts.length, 0);
      // The pair in R2 does not verify (HR's head, A's signature): the same refusal, not LIVE UNVERIFIED and recovery R2, which the build
      // job (it reads the index served only) would refuse as NOT BROKEN.
      const live = { ...broken(), [catKeyOf('A0')]: A0[catKeyOf('A0')] };
      const want = new RegExp(`^REFUSED: the index served over the prefix is not the head and signature in R2 ${served}the head generated ${g('HR')}, `
        + `a pair that does not verify\\): .*dispatch again later${security}`, 'm');
      const n = await upload(scenario({ live, input: 'B', edge }));
      assert.equal(n.code, 1, n.out);
      assert.match(n.out, want);
      assert.doesNotMatch(n.out, /LIVE UNVERIFIED/);
      assert.equal(n.puts.length, 0);
      const rs = scenario({ live, input: 'NR', routes: repairRoutes(), edge });
      const rb = await base(rs, path.join(rs.dir, 'base'));
      assert.equal(rb.code, 1, rb.stdout + rb.stderr);
      assert.match(rb.stderr, /^REFUSED: NOT BROKEN: /m, 'the build job reads the index served only');
      const ru = await upload(rs, 'repair');
      assert.equal(ru.code, 1, ru.out);
      assert.match(ru.out, want, 'the upload step compares the index served with R2 before NOT BROKEN');
      assert.doesNotMatch(ru.out, /NOT BROKEN/);
      assert.equal(ru.puts.length, 0);
      assert.equal(rs.ghLog().length, 0, 'GitHub is not asked');
    });

    test('PB-resign-catalog-edge-only: a live catalog gone from R2 but still served from the edge cache is never re-signed; other bytes under its name are swapped', async () => {
      const key = catKeyOf('A');
      const A = objectsOf('A');
      const resignA = (sc) => upload(sc, 'resign', ['--tree', path.join(T, 'tree-A')]);
      const gone = { ...A };
      delete gone[key];
      const g = await resignA(scenario({ input: 'R', live: gone, edge: { [key]: A[key] } }));
      assert.equal(g.code, 1, g.out);
      assert.match(g.out, new RegExp(`^REFUSED: resign: the live catalog ${esc(key.slice(3))} is not in R2, only in the edge cache`, 'm'));
      assert.equal(g.puts.length, 0, 'a re-sign writes the pair only, and not over a catalog the mirror does not hold');
      const other = { ...A, [key]: object(Buffer.from('{"not":"the catalog"}'), 'application/json', IMMUTABLE) };
      const s = await resignA(scenario({ input: 'R', live: other, edge: { [key]: A[key] } }));
      assert.equal(s.code, 1, s.out);
      assert.match(s.out, new RegExp(`^REFUSED: the mirror holds another file under ${esc(key.slice(3))} .*swapped in R2`, 'm'));
      assert.equal(s.puts.length, 0);
      const e = await resignA(scenario({ input: 'R', faults: [{ op: 'get-object', key, nth: 1, result: 'error' }] }));
      assert.equal(e.code, 1, e.out);
      assert.match(e.out, new RegExp(`^REFUSED: ${esc(key.slice(3))}: the mirror cannot be read \\(.*\\): nothing was written; dispatch again later$`, 'm'));
      assert.equal(e.puts.length, 0);
      const ok = await resignA(scenario({ input: 'R' }));
      assert.equal(ok.code, 0, ok.out);
      assert.ok(ok.calls.some(c => c.op === 'get-object' && c.key === key), 'the live catalog is read from R2 itself');
      assert.deepEqual(ok.puts.map(p => p.key), [SIG, HEAD]);
    });
  });
});

describe('long refusals and usage errors', () => {
  test('REFUSED-long-keeps-way-out: a MAIN DIVERGES refusal over 300 characters keeps its way out, before the differences, on its REFUSED line', async () => {
    // Seven differences from the live A: five revocations on main only, dusk listed on main only, intel's versions.
    const revoked = ['gone', 'old', 'bad', 'four', 'five'].map(n =>({ id: `dev.example.${n}`, versions: '*', reason: 'Revoked on main after the live head was made.', date: '2026-01-01' }));
    const tree = writeTree(path.join(T, 'tree-long'), { ...TREE_B, revoked });
    const sc = scenario({ input: 'R' });
    const b = await resignCheck(sc, tree);
    assert.equal(b.code, 1, b.stdout + b.stderr);
    const u = await upload(sc, 'resign', ['--tree', tree]);
    assert.equal(u.code, 1, u.out);
    assert.equal(u.puts.length, 0);
    for (const [name, r, wayOut] of [['build-index.mjs', b, 'treat it as a security event (docs/RUNBOOK.md) before anything else'], ['upload.mjs', u, 'a security event (docs/RUNBOOK.md)']]) {
      const line = refusedLine(r);
      assert.ok(line.length > 300, `${name}: a refusal longer than 300 characters (${line.length})`);
      assert.match(line, /^REFUSED: MAIN DIVERGES: /, name);
      const at = line.indexOf(wayOut);
      assert.ok(at > 0, `${name}: the way out is on the REFUSED line: ${line}`);
      assert.ok(at < line.indexOf('revocation on main only: dev.example.bad *'), `${name}: the way out comes before the differences: ${line}`);
      assert.match(line, /; 2 more\)$/, `${name}: the differences, five and a count of the rest, at the end`);
    }
  });

  test('REFUSED-vendored-capped: each line of a vendored tool\'s refusal is cut to 300 printable characters, so one line of its output never fills the REFUSED line', () => {
    const huge = `REFUSED: ${'x'.repeat(1024 * 1024)}`;
    const lines = refusalLines({ stderr: `${huge}\nnoise\n`, stdout: `FAIL ##[error]legacy ${'y'.repeat(1000)}\nINDEX VERIFY FAILED: short\n` });
    assert.equal(lines.length, 3, JSON.stringify(lines.map(l => l.slice(0, 40))));
    assert.ok(lines.every(l => l.length <= 300), `every line at most 300 characters: ${lines.map(l => l.length)}`);
    assert.match(lines[0], /^REFUSED: x+$/);
    assert.match(lines[1], /^FAIL # #\[error\]legacy y+$/);
    assert.equal(lines[2], 'INDEX VERIFY FAILED: short');
    assert.ok(refusalLines({ stderr: Array.from({ length: 30 }, () => huge).join('\n'), stdout: '' }).join(' | ').length <= 20 * 303, 'at most 20 lines of at most 300');
  });

  test('USAGE-one-line: a usage error whose text holds line breaks prints no line that starts a workflow command, in build-index.mjs and upload.mjs', async () => {
    const evil = '--x\n::error::injected';
    const b = await run('tools/build-index.mjs', ['base', evil]);
    const u = await run(TOOL, [evil]);
    for (const [name, r] of [['build-index.mjs', b], ['upload.mjs', u]]) {
      assert.equal(r.code, 2, `${name}: ${JSON.stringify(r.stdout + r.stderr)}`);
      const lines = `${r.stdout}\n${r.stderr}`.split(/\r\n|\r|\n/);
      assert.ok(lines.every(l => !l.trimStart().startsWith('::')), `${name}: no line starts a workflow command: ${JSON.stringify(lines)}`);
      assert.match(r.stderr, /^Unknown option '--x ::error::injected'/m, `${name}: the reason, on one line`);
    }
  });
});
