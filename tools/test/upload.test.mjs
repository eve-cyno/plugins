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
import { LIFETIME_MS } from '../lib/indexbuild.mjs';
import { ROOT, cacheArchive, cleanup, manifest, pluginEntry, pluginZip, run, sha, tempDir, themeEntry, themeZip, version, writeTree } from './trees.mjs';
import { makeStubBin, md5Etag, object, pointStub, readAwsLog, readBucket, s3Calls, serveBucket, writeBucket } from './awsstub.mjs';
import { stubEnv } from './ghstub.mjs';

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
const ghRun = (id, sha40, created) => ({ id, path: '.github/workflows/publish.yml', head_branch: 'main', head_sha: sha40, created_at: created, html_url: `https://github.com/eve-cyno/plugins/actions/runs/${id}` });
/** gh answers for run 300 (the run under review): no other run (a first publish), an approved and uploaded run 200, or a failing list. */
function ghRoutes(kind) {
  const under = ghRun(300, 'b'.repeat(40), '2026-12-10T10:00:00Z');
  const done = ghRun(200, 'a'.repeat(40), '2026-12-01T10:00:00Z');
  const page = (l) => [{ total_count: l.length, workflow_runs: l }];
  const r = {
    [`GET ${GH}/actions/runs/300`]: { stdout: under },
    [`GET ${GH}/environments/index`]: { stdout: { name: 'index', can_admins_bypass: false, protection_rules: [
      { type: 'required_reviewers', prevent_self_review: true, reviewers: [{ type: 'User', reviewer: { id: REVIEWER, login: 'reviewer-account', type: 'User' } }] }] } },
    [`GET ${GH}/actions/workflows/publish.yml/runs?per_page=100`]: kind === 'error' ? { stderr: 'HTTP 502: Bad Gateway', exit: 1 } : { stdout: page(kind === 'approved' ? [under, done] : [under]) },
    [`GET ${GH}/actions/workflows/resign.yml/runs?per_page=100`]: { stdout: page([]) },
  };
  if (kind === 'approved') {
    r[`GET ${GH}/actions/runs/200/approvals`] = { stdout: [{ state: 'approved', user: { id: REVIEWER }, environments: [{ name: 'index' }] }] };
    r[`GET ${GH}/actions/runs/200/jobs?per_page=100`] = { stdout: [{ total_count: 2, jobs: [{ id: 1, name: 'sign', conclusion: 'success' }, { id: 2, name: 'upload', conclusion: 'success' }] }] };
    r[`GET ${GH}/compare/${'a'.repeat(40)}...${'b'.repeat(40)}`] = { stdout: { status: 'ahead' } };
  }
  return r;
}

/** One case: a bucket holding `live`, an input folder made from index `input`, faults, and the environment of the upload step. */
function scenario({ live, input = 'B', faults = [], version: ver, skeletonDrop, gh = 'none', env = {}, testPub = false, head } = {}) {
  const dir = tempDir('upload');
  const bucket = path.join(dir, 'bucket.json');
  writeBucket(bucket, { objects: structuredClone(live ?? objectsOf('A')), faults, ...(ver ? { version: ver } : {}), ...(skeletonDrop ? { skeletonDrop } : {}) });
  current = bucket;
  const inDir = path.join(dir, 'in');
  const h = inputOf(input, inDir, { testPub, head });
  const awsLog = path.join(dir, 'aws.jsonl');
  fs.writeFileSync(awsLog, '');
  pointStub(BIN, { bucket, log: awsLog });
  const g = stubEnv(BIN, ghRoutes(gh), temps);
  return {
    dir, bucket, inDir, awsLog, ghLog: g.log, summary: path.join(dir, 'summary.md'),
    env: { ...g.env, R2_ACCESS_KEY_ID: FAKE_ID, R2_SECRET_ACCESS_KEY: FAKE_SECRET, R2_ACCOUNT_ID: ACCOUNT,
      R2_BUCKET: 'eve-cyno-plugins', HEAD_SHA256: sha(h), GITHUB_RUN_ID: '300', GH_TOKEN: FAKE_GH, ...env },
  };
}
async function upload(sc, mode = 'production', extra = []) {
  const args = mode === 'resign' ? ['--resign', '--in', sc.inDir, '--summary', sc.summary, '--prefix', P, '--key', PUB]
    : mode === 'test' ? ['--target', 'test', '--repair', 'false', '--in', sc.inDir, '--summary', sc.summary, '--prefix', PT]
      : ['--target', 'production', '--repair', 'false', '--in', sc.inDir, '--summary', sc.summary, '--prefix', P, '--key', PUB];
  const r = await run(TOOL, [...args, '--archive-cache', CACHE, ...extra], { env: sc.env });
  const log = readAwsLog(sc.awsLog);
  const out = r.stdout + r.stderr;
  return { ...r, out, log, calls: s3Calls(log), puts: s3Calls(log).filter(c => c.op === 'put-object'), bucket: readBucket(sc.bucket),
    summary: fs.existsSync(sc.summary) ? fs.readFileSync(sc.summary, 'utf8') : '', last: r.stdout.trim().split('\n').at(-1) };
}
const bytesOf = (bucket, key) => (bucket[key] ? Buffer.from(bucket[key].b64, 'base64') : null);
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
  const r = await run('tools/build-index.mjs', ['resign', '--out', path.join(T, 'R'), '--archives-json', path.join(T, 'R.archives.json'), '--prefix', P, '--key', PUB]);
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
  test('PB-repair-refused: --repair true (recovery R2) is not built into the upload step; nothing is read or written', async () => {
    const sc = scenario();
    const r = await run(TOOL, ['--target', 'production', '--repair', 'true', '--in', sc.inDir, '--prefix', P, '--key', PUB], { env: sc.env });
    assert.equal(r.code, 1, r.stdout + r.stderr);
    assert.match(r.stdout + r.stderr, /recovery R2/);
    assert.deepEqual(readAwsLog(sc.awsLog), []);
  });

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
  test('PB-first-publish-orphan-overwritten: an orphan signature of an earlier failed first publish never blocks the next run', async () => {
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
    assert.doesNotMatch(r.out, /HALF-PUBLISHED/);
    assert.equal(r.puts.filter(p => p.key === SIG).length, 1, 'nothing restored');
    const n = await upload(scenario({ live: {}, gh: 'none', faults: [{ op: 'put-object', key: SIG, nth: 1, result: 'network-lost' }, { op: 'put-object', key: SIG, nth: 2, result: 'network-lost' }] }));
    assert.equal(n.code, 1, n.out);
    assert.match(n.last, /^UNCHANGED/, 'both objects still missing');
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
    const r = await upload(scenario({ input: 'R' }), 'resign');
    assert.equal(r.code, 0, r.out);
    assert.match(r.last, /^PUBLISHED /);
    const A = objectsOf('A');
    assert.deepEqual(r.puts.map(p => [p.key, p.ifMatch]), [[SIG, A[SIG].etag], [HEAD, A[HEAD].etag]]);
    const live = objectsOf('A');
    delete live[HEAD];
    const gone = await upload(scenario({ input: 'R', live }), 'resign');
    assert.equal(gone.code, 1, gone.out);
    assert.match(gone.out, /resign never/);
    assert.equal(gone.puts.length, 0);
  });
});
