// E2E-*: the whole chain with the vendored desktop tools (plan task 1.7): entries -> catalog -> unsigned head (index-build.mjs with
// --prefix and --head-from, through tools/build-index.mjs build) -> a signature with a throwaway key made in this run -> index-verify.mjs
// --key --prefix --archives -> the folder served from 127.0.0.1 -> index-verify.mjs --live; then the live reads of build-index.mjs
// (base, --compare-live, resign-check, resign) against that server. The throwaway key's secret half never leaves this process's memory
// (tools/lib/throwaway.mjs); only its public key is written, into this run's temp folder. No network but 127.0.0.1.
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { createRequire } from 'node:module';
import { throwawaySigner } from '../lib/throwaway.mjs';
import { HEAD_MAX_AGE_MS, LIFETIME_MS, headBoundsProblem } from '../lib/indexbuild.mjs';
import { ROOT, cacheArchive, cleanup, manifest, pluginEntry, pluginZip, run, sha, tempDir, themeEntry, themeZip, version, writeTree } from './trees.mjs';

const require = createRequire(import.meta.url);
const I = require(path.join(ROOT, 'vendor', 'eve-cyno-host', 'host', 'dist', 'market', 'indexformat.js'));
const VERIFY = 'vendor/eve-cyno-host/scripts/index-verify.mjs';
const DAY = 86_400_000;
const today = new Date().toISOString().slice(0, 10);
const stamp = (ms) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');

let T, P, server, servedRoot = null;
const signer = throwawaySigner();
let PUB;

/** Serves `servedRoot` under /v1/ (only regular files inside it), the head and its signature as no-cache, the rest immutable. */
function startServer() {
  return new Promise(resolve => {
    server = http.createServer((req, res) => {
      const u = new URL(req.url, 'http://127.0.0.1');
      const rel = u.pathname.startsWith('/v1/') ? decodeURIComponent(u.pathname.slice(4)) : null;
      const file = rel && servedRoot ? path.resolve(servedRoot, rel) : null;
      let st = null;
      try { if (file && file.startsWith(servedRoot + path.sep)) st = fs.lstatSync(file); } catch { /* 404 */ }
      if (!st?.isFile()) { res.writeHead(404, { 'Content-Type': 'text/plain' }); res.end('not found'); return; }
      const head = rel === 'index.json' || rel === 'index.json.minisig';
      res.writeHead(200, { 'Cache-Control': head ? 'no-cache' : 'public, max-age=31536000, immutable', 'Content-Length': st.size });
      res.end(fs.readFileSync(file));
    });
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
}

const A110 = pluginZip(manifest({ version: '1.1.0' }));
const A100 = pluginZip(manifest({ version: '1.0.0' }));
const DUSK = themeZip();
const REVOKED = [{ id: 'dev.example.intel', versions: ['1.0.0'], reason: 'Sends tokens to an unknown host.', date: today }];
const ENTRIES = [pluginEntry([version('1.1.0', A110), version('1.0.0', A100)]), themeEntry([version('2.0.0', DUSK, {}, 'theme')])];

/** Signs the head of `dir` with `s` (default the run's throwaway key). */
function signFolder(dir, s = signer) {
  const head = fs.readFileSync(path.join(dir, 'index.json'));
  const { generated } = JSON.parse(head);
  fs.writeFileSync(path.join(dir, 'index.json.minisig'), s.sign(head, I.indexComment(generated)));
}
const build = (out, tree, extra = []) => run('tools/build-index.mjs', ['build', '--prefix', P, '--tree', tree, '--out', out, '--archive-cache', path.join(T, 'cache'), ...extra]);
const verify = (args) => run(VERIFY, [...args, '--key', PUB, '--prefix', P]);
const keyArgs = () => ['--prefix', P, '--key', PUB];

before(async () => {
  T = tempDir('e2e');
  P = `http://127.0.0.1:${await startServer()}/v1/`;
  fs.mkdirSync(path.join(T, 'keys'));
  PUB = path.join(T, 'keys', 'throwaway.pub');
  fs.writeFileSync(PUB, signer.pubText);
  for (const a of [A110, A100, DUSK]) cacheArchive(path.join(T, 'cache'), a);
  writeTree(path.join(T, 'tree'), { entries: ENTRIES, revoked: REVOKED });
});
after(() => { server?.close(); cleanup(); });

describe('E2E chain', () => {
  test('E2E-chain: build, sign with a throwaway key, verify the folder, serve it, verify it live', async () => {
    const out = path.join(T, 'index');
    const listFile = path.join(T, 'archives.json');
    const b = await build(out, path.join(T, 'tree'), ['--archives-json', listFile]);
    assert.equal(b.code, 0, b.stdout + b.stderr);
    assert.match(b.stdout, /^BUILT /m);
    assert.ok(!fs.existsSync(path.join(out, 'index.json.minisig')), 'the build never signs');
    const headBytes = fs.readFileSync(path.join(out, 'index.json'));
    const head = I.parseIndexHead(headBytes, P);
    assert.equal(Date.parse(head.expires) - Date.parse(head.generated), 60 * DAY, 'D36: 60 days, written by the tool');
    assert.equal(headBoundsProblem(headBytes, P), null);
    const cat = I.parseCatalog(fs.readFileSync(path.join(out, ...head.catalog.url.slice(P.length).split('/'))), head, { prefix: P });
    assert.deepEqual(cat.plugins.map(l => [l.id, l.versions.map(v => v.version)]), [['dev.example.dusk', ['2.0.0']], ['dev.example.intel', ['1.1.0']]],
      'sorted by id; the revoked version is left out');
    assert.deepEqual(cat.revoked, REVOKED);
    assert.deepEqual(cat.plugins[1].versions[0].archive, { url: `${P}archives/${sha(A110)}.zip`, sha256: sha(A110), size: A110.length });
    const list = JSON.parse(fs.readFileSync(listFile, 'utf8'));
    assert.deepEqual(list.map(a => a.name).sort(), [`archives/${sha(A110)}.zip`, `archives/${sha(DUSK)}.zip`].sort());
    assert.ok(list.every(a => a.url.startsWith('https://127.0.0.1/releases/')), 'archives.json names the author URL');

    signFolder(out);
    const v = await verify([out, '--archives']);
    assert.equal(v.code, 0, v.stdout + v.stderr);
    assert.match(v.stdout, /^INDEX VERIFY OK /m);
    assert.match(v.stdout, /contents: dev\.example\.intel 1\.1\.0 as listed/);

    servedRoot = out;
    const live = await verify(['--live', '--archives']);
    assert.equal(live.code, 0, live.stdout + live.stderr);
    assert.match(live.stdout, /^PASS index\.json is served with Cache-Control: no-cache/m);
    assert.match(live.stdout, /^INDEX VERIFY OK /m);
  });

  test('E2E-live-refuses: a head signed with another key, and a changed catalog, fail index-verify --live', async () => {
    const out = path.join(T, 'index');
    const other = path.join(T, 'other');
    fs.cpSync(out, other, { recursive: true });
    signFolder(other, throwawaySigner());
    servedRoot = other;
    const wrongKey = await verify(['--live']);
    assert.equal(wrongKey.code, 1);
    assert.match(wrongKey.stdout, /^FAIL signature of index\.json: signed with a key that is not an index key here/m);
    signFolder(other);
    const catName = JSON.parse(fs.readFileSync(path.join(other, 'index.json'))).catalog.url.slice(P.length);
    fs.appendFileSync(path.join(other, ...catName.split('/')), ' ');
    const changed = await verify(['--live']);
    assert.equal(changed.code, 1);
    assert.match(changed.stdout, /^FAIL catalog\/[0-9a-f]{64}\.json: (more than \d+ bytes|its size or SHA-256 does not match the signed head)/m);
    servedRoot = out;
  });

  test('E2E-lifetime-not-input: build takes no lifetime, and refuses an output folder that exists', async () => {
    const l = await build(path.join(T, 'never'), path.join(T, 'tree'), ['--lifetime-days', '30']);
    assert.equal(l.code, 2, l.stdout + l.stderr);
    assert.ok(!fs.existsSync(path.join(T, 'never')));
    const e = await build(path.join(T, 'index'), path.join(T, 'tree'));
    assert.equal(e.code, 1);
    assert.match(e.stderr, /^REFUSED: .*exists/m);
  });

  test('E2E-cache-checked: a cached copy that is not the pinned archive is refused (C5)', async () => {
    const cache = path.join(T, 'badcache');
    cacheArchive(cache, A100, sha(A110)); // the bytes of 1.0.0 under the name of 1.1.0
    cacheArchive(cache, DUSK);
    const r = await run('tools/build-index.mjs', ['build', '--prefix', P, '--tree', path.join(T, 'tree'), '--out', path.join(T, 'bad'), '--archive-cache', cache]);
    assert.equal(r.code, 1, r.stdout + r.stderr);
    assert.match(r.stderr, /C5 .*SHA-256/);
    assert.ok(!fs.existsSync(path.join(T, 'bad')), 'nothing of a refused build is kept');
  });

  test('E2E-head-bounds: 60 days exactly, at most 7 days old, at most 5 minutes ahead', () => {
    const head = (g, life = LIFETIME_MS) => Buffer.from(JSON.stringify({
      schema: 1, generated: stamp(g), expires: stamp(g + life), catalog: { url: `${P}catalog/${'a'.repeat(64)}.json`, sha256: 'a'.repeat(64), size: 100 },
    }));
    const now = Date.now();
    assert.equal(headBoundsProblem(head(now - HEAD_MAX_AGE_MS + 60_000), P, now), null);
    assert.match(headBoundsProblem(head(now - HEAD_MAX_AGE_MS - 60_000), P, now), /more than 7 days ago/);
    assert.equal(headBoundsProblem(head(now + 240_000), P, now), null);
    assert.match(headBoundsProblem(head(now + 360_000), P, now), /ahead/);
    assert.match(headBoundsProblem(head(now, LIFETIME_MS - DAY), P, now), /not 60 days/);
    assert.match(headBoundsProblem(head(now), I.MARKET_URL_PREFIX, now), /refuses the head/, 'a head for another prefix');
  });
});

describe('E2E live reads of build-index.mjs', () => {
  const tree2 = () => path.join(T, 'tree2');
  before(() => writeTree(tree2(), { entries: ENTRIES, revoked: [] })); // the next index lifts the revocation of 1.0.0

  test('E2E-base: the verified live index becomes the base; test target and repair', async () => {
    servedRoot = path.join(T, 'index');
    const b = await run('tools/build-index.mjs', ['base', '--target', 'production', '--repair', 'false', '--out', path.join(T, 'base'), ...keyArgs()]);
    assert.equal(b.code, 0, b.stdout + b.stderr);
    const meta = JSON.parse(fs.readFileSync(path.join(T, 'base', 'BASE.json'), 'utf8'));
    assert.equal(meta.kind, 'live');
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(T, 'base', 'catalog.json'), 'utf8')).revoked, REVOKED);
    const t = await run('tools/build-index.mjs', ['base', '--target', 'test', '--repair', 'false', '--out', path.join(T, 'base-test')]);
    assert.equal(t.code, 0, t.stdout + t.stderr);
    assert.equal(JSON.parse(fs.readFileSync(path.join(T, 'base-test', 'BASE.json'), 'utf8')).kind, 'test');
    const r = await run('tools/build-index.mjs', ['base', '--target', 'production', '--repair', 'true', '--out', path.join(T, 'base-r'), ...keyArgs()]);
    assert.equal(r.code, 1);
    assert.match(r.stderr + r.stdout, /recovery R2/);
  });

  test('E2E-base-missing: a live head that answers 404 is a first publish only when GitHub shows no approved run (fail closed)', async () => {
    servedRoot = path.join(T, 'keys'); // serves no index.json
    const r = await run('tools/build-index.mjs', ['base', '--target', 'production', '--repair', 'false', '--out', path.join(T, 'base-404'), ...keyArgs()],
      { env: { GITHUB_RUN_ID: '', PATH: path.join(T, 'keys') } });
    assert.equal(r.code, 1, r.stdout + r.stderr);
    assert.match(r.stdout + r.stderr, /404/);
    assert.ok(!fs.existsSync(path.join(T, 'base-404', 'BASE.json')));
  });

  test('E2E-base-unverified: a live head the keys refuse is LIVE UNVERIFIED', async () => {
    servedRoot = path.join(T, 'other');
    signFolder(servedRoot, throwawaySigner());
    const r = await run('tools/build-index.mjs', ['base', '--target', 'production', '--repair', 'false', '--out', path.join(T, 'base-bad'), ...keyArgs()]);
    assert.equal(r.code, 1);
    assert.match(r.stdout + r.stderr, /LIVE UNVERIFIED/);
    servedRoot = path.join(T, 'index');
  });

  test('E2E-compare-live: a lift needs the lift input; an index that is not newer is a rollback', async () => {
    const next = path.join(T, 'index2');
    const b = await build(next, tree2());
    assert.equal(b.code, 0, b.stdout + b.stderr);
    const lift = path.join(T, 'lift.txt');
    const cmp = (index, text) => { fs.writeFileSync(lift, text); return run('tools/build-index.mjs', ['--compare-live', '--base', path.join(T, 'base'), '--index', index, '--lift', lift, '--repair', 'false']); };
    const no = await cmp(next, '\n');
    assert.equal(no.code, 1, no.stdout);
    assert.match(no.stdout, /^FAIL lift .*dev\.example\.intel 1\.0\.0/m);
    const yes = await cmp(next, 'dev.example.intel 1.0.0\n');
    assert.equal(yes.code, 0, yes.stdout + yes.stderr);
    assert.match(yes.stdout, /^NOTE revocation lifted: dev\.example\.intel 1\.0\.0/m);
    const extra = await cmp(next, 'dev.example.intel 1.0.0\ndev.example.dusk *\n');
    assert.equal(extra.code, 1);
    assert.match(extra.stdout, /^FAIL lift .*dev\.example\.dusk \*/m);
    const same = await cmp(path.join(T, 'index'), '\n');
    assert.equal(same.code, 1);
    assert.match(same.stdout, /^FAIL rollback /m);
  });

  test('E2E-resign: resign-check says when, resign writes a new 60-day head for the same catalog that verifies', async () => {
    servedRoot = path.join(T, 'index');
    const outputs = path.join(T, 'outputs.txt');
    const fresh = await run('tools/build-index.mjs', ['resign-check', '--outputs', outputs, '--tree', path.join(T, 'tree'), ...keyArgs()]);
    assert.equal(fresh.code, 0, fresh.stdout + fresh.stderr);
    assert.equal(fs.readFileSync(outputs, 'utf8'), 'needed=false\n');

    const old = path.join(T, 'old');
    fs.cpSync(path.join(T, 'index'), old, { recursive: true });
    // A head of 31 days ago needs a catalog of that time too (the app refuses a catalog newer than its head).
    const h0 = JSON.parse(fs.readFileSync(path.join(old, 'index.json'), 'utf8'));
    const g = Date.now() - 31 * DAY;
    const catFile = path.join(old, ...h0.catalog.url.slice(P.length).split('/'));
    const catBytes = Buffer.from(`${JSON.stringify({ ...JSON.parse(fs.readFileSync(catFile, 'utf8')), generated: stamp(g - 60_000) }, null, 2)}\n`);
    fs.rmSync(catFile);
    fs.writeFileSync(path.join(old, 'catalog', `${sha(catBytes)}.json`), catBytes);
    const h = { ...h0, catalog: { url: `${P}catalog/${sha(catBytes)}.json`, sha256: sha(catBytes), size: catBytes.length } };
    fs.writeFileSync(path.join(old, 'index.json'), `${JSON.stringify({ ...h, generated: stamp(g), expires: stamp(g + LIFETIME_MS) }, null, 2)}\n`);
    signFolder(old);
    servedRoot = old;
    fs.writeFileSync(outputs, '');
    const due = await run('tools/build-index.mjs', ['resign-check', '--outputs', outputs, '--tree', path.join(T, 'tree'), ...keyArgs()]);
    assert.equal(due.code, 0, due.stdout + due.stderr);
    assert.equal(fs.readFileSync(outputs, 'utf8'), 'needed=true\n');

    const out = path.join(T, 'resigned');
    const r = await run('tools/build-index.mjs', ['resign', '--out', out, '--archives-json', path.join(T, 'resign-archives.json'), ...keyArgs()]);
    assert.equal(r.code, 0, r.stdout + r.stderr);
    const nh = I.parseIndexHead(fs.readFileSync(path.join(out, 'index.json')), P);
    assert.deepEqual(nh.catalog, h.catalog, 'the same catalog');
    assert.ok(Date.parse(nh.generated) > g);
    assert.equal(Date.parse(nh.expires) - Date.parse(nh.generated), LIFETIME_MS);
    signFolder(out);
    const v = await verify([out, '--archives']);
    assert.equal(v.code, 0, v.stdout + v.stderr);

    servedRoot = path.join(T, 'other'); // signed with a key that is not ours
    const bad = await run('tools/build-index.mjs', ['resign', '--out', path.join(T, 'resigned-bad'), ...keyArgs()]);
    assert.equal(bad.code, 1);
    assert.match(bad.stdout + bad.stderr, /recovery R2/);
    servedRoot = path.join(T, 'index');
  });
});

describe('E2E check.mjs', () => {
  const check = (mode, base, head, extra = []) => run('tools/check.mjs', [mode, '--base', base, '--head', head, '--archive-cache', path.join(T, 'cache'), ...extra]);
  const emptyTree = () => writeTree(path.join(T, 'empty'), {});
  const last = (out) => out.trim().split('\n').at(-1);

  test('E2E-check-refuse: a new plugin and theme pass every refusal check, C16 included', async () => {
    const summary = path.join(T, 'summary.md');
    const r = await check('refuse', emptyTree(), path.join(T, 'tree'), ['--summary', summary]);
    assert.equal(r.code, 0, r.stdout + r.stderr);
    for (const re of [/^PASS C1 C2 2 entries/m, /^PASS C4-C7 dev\.example\.intel 1\.1\.0/m, /^PASS C4-C7 dev\.example\.dusk 2\.0\.0/m, /^PASS C15 1 revocations/m,
      /^PASS C16 the whole index builds, signs with a throwaway key and verifies/m, /^PASS C9 /m]) assert.match(r.stdout, re);
    assert.equal(last(r.stdout), 'CHECKS PASSED');
    assert.match(fs.readFileSync(summary, 'utf8'), /\*\*CHECKS PASSED\*\*/);
  });

  test('E2E-check-review: new entries and an added revocation need review (exit 3)', async () => {
    const r = await check('review', path.join(T, 'empty'), path.join(T, 'tree'), ['--author', 'example-login']);
    assert.equal(r.code, 3, r.stdout + r.stderr);
    assert.match(r.stdout, /^FLAG new C11 dev\.example\.intel/m);
    assert.match(r.stdout, /^PASS C13 /m);
    assert.equal(last(r.stdout), 'NEEDS REVIEW new revocation');
  });

  test('E2E-check-publish: against the live base the lift is information, not a refusal', async () => {
    const r = await check('publish', path.join(T, 'base'), path.join(T, 'tree2'), ['--target', 'production']);
    assert.equal(r.code, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /^NOTE base: the live catalog/m);
    assert.match(r.stdout, /^PASS C4-C7 dev\.example\.intel 1\.0\.0/m, 'a version that is not live is checked');
    assert.doesNotMatch(r.stdout, /^PASS C4-C7 dev\.example\.intel 1\.1\.0/m, 'a live version is not');
    assert.match(r.stdout, /^FLAG lift C15 removed: dev\.example\.intel 1\.0\.0/m);
    assert.equal(last(r.stdout), 'CHECKS PASSED');
  });

  test('E2E-check-refuses: a wrong pinned hash fails C5, and C16 does not run', async () => {
    const bad = writeTree(path.join(T, 'tree-bad'), { entries: [pluginEntry([version('1.1.0', A110, { sha256: sha(A100) })])] });
    const r = await check('refuse', path.join(T, 'empty'), bad);
    assert.equal(r.code, 1, r.stdout + r.stderr);
    assert.match(r.stdout, /^FAIL C5 dev\.example\.intel 1\.1\.0: /m);
    assert.match(r.stdout, /^NOTE C16 and C9 are not run/m);
    assert.equal(last(r.stdout), 'CHECKS FAILED 1');
  });
});
