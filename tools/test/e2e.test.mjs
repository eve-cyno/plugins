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
import { HEAD_MAX_AGE_MS, LIFETIME_MS, headBoundsProblem, obtainArchive } from '../lib/indexbuild.mjs';
import { ROOT, cacheArchive, cleanup, manifest, pluginEntry, pluginZip, run, sha, tempDir, themeEntry, themeZip, version, writeTree } from './trees.mjs';

const require = createRequire(import.meta.url);
const I = require(path.join(ROOT, 'vendor', 'eve-cyno-host', 'host', 'dist', 'market', 'indexformat.js'));
const VERIFY = 'vendor/eve-cyno-host/scripts/index-verify.mjs';
const DAY = 86_400_000;
const today = new Date().toISOString().slice(0, 10);
const stamp = (ms) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');

let T, P, server, servedRoot = null, n = 0;
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
    assert.match(r.stderr, /^REFUSED: NOT BROKEN: .*recovery R2/m, 'repair (recovery R2) against a live index that verifies');
    assert.ok(!fs.existsSync(path.join(T, 'base-r')));
    const rt = await run('tools/build-index.mjs', ['base', '--target', 'test', '--repair', 'true', '--out', path.join(T, 'base-rt')]);
    assert.equal(rt.code, 1);
    assert.match(rt.stderr, /repair is for target production only/);
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
    const r = await run('tools/build-index.mjs', ['resign', '--out', out, '--archives-json', path.join(T, 'resign-archives.json'), '--tree', path.join(T, 'tree'), ...keyArgs()]);
    assert.equal(r.code, 0, r.stdout + r.stderr);
    const nh = I.parseIndexHead(fs.readFileSync(path.join(out, 'index.json')), P);
    assert.deepEqual(nh.catalog, h.catalog, 'the same catalog');
    assert.ok(Date.parse(nh.generated) > g);
    assert.equal(Date.parse(nh.expires) - Date.parse(nh.generated), LIFETIME_MS);
    signFolder(out);
    const v = await verify([out, '--archives']);
    assert.equal(v.code, 0, v.stdout + v.stderr);

    servedRoot = path.join(T, 'other'); // signed with a key that is not ours
    const bad = await run('tools/build-index.mjs', ['resign', '--out', path.join(T, 'resigned-bad'), '--tree', path.join(T, 'tree'), ...keyArgs()]);
    assert.equal(bad.code, 1);
    assert.match(bad.stdout + bad.stderr, /recovery R2/);
    servedRoot = path.join(T, 'index');
  });

  test('MV-diverged: resign-check and resign refuse a live catalog that is not main\'s (a replayed older head is never made fresh)', async () => {
    servedRoot = path.join(T, 'index'); // built from tree: intel 1.1.0 (1.0.0 revoked) and dusk 2.0.0
    const dusk = { id: 'dev.example.dusk', versions: '*', reason: 'Revoked after the live head was made.', date: today };
    const trees = {
      // main revokes dusk; the live catalog (an older verified head) lacks that revocation and still lists dusk
      revoked: writeTree(path.join(T, 'mv-revoked'), { entries: ENTRIES, revoked: [...REVOKED, dusk] }),
      // main lifted the revocation of intel 1.0.0, so main lists 1.0.0 and the live catalog does not
      lifted: writeTree(path.join(T, 'mv-lifted'), { entries: ENTRIES, revoked: [] }),
      // main has no dusk entry
      fewer: writeTree(path.join(T, 'mv-fewer'), { entries: [ENTRIES[0]], revoked: REVOKED }),
    };
    const want = {
      revoked: [/revocation on main only: dev\.example\.dusk \*/, /listing live only: dev\.example\.dusk/],
      lifted: [/revocation live only: dev\.example\.intel 1\.0\.0/, /listing dev\.example\.intel: the versions differ \(main: 1\.0\.0, 1\.1\.0; live: 1\.1\.0\)/],
      fewer: [/listing live only: dev\.example\.dusk/],
    };
    for (const [name, tree] of Object.entries(trees)) {
      const outputs = path.join(T, `mv-outputs-${name}.txt`);
      fs.writeFileSync(outputs, '');
      const c = await run('tools/build-index.mjs', ['resign-check', '--outputs', outputs, '--tree', tree, ...keyArgs()]);
      assert.equal(c.code, 1, `${name}: ${c.stdout}${c.stderr}`);
      assert.match(c.stderr, /^REFUSED: MAIN DIVERGES: /m, name);
      for (const re of want[name]) assert.match(c.stdout + c.stderr, re, name);
      assert.equal(fs.readFileSync(outputs, 'utf8'), '', `${name}: no needed= output, so the head job never runs`);
      const out = path.join(T, `mv-resigned-${name}`);
      const r = await run('tools/build-index.mjs', ['resign', '--out', out, '--tree', tree, ...keyArgs()]);
      assert.equal(r.code, 1, `${name}: ${r.stdout}${r.stderr}`);
      assert.match(r.stderr, /^REFUSED: MAIN DIVERGES: /m, name);
      assert.ok(!fs.existsSync(out), `${name}: nothing is written`);
    }
    const bad = writeTree(path.join(T, 'mv-bad'), { entries: ENTRIES, revoked: null });
    const b = await run('tools/build-index.mjs', ['resign-check', '--outputs', path.join(T, 'mv-outputs-bad.txt'), '--tree', bad, ...keyArgs()]);
    assert.equal(b.code, 1, b.stdout + b.stderr);
    assert.match(b.stderr, /^REFUSED: MAIN DIVERGES: .*\(main's revoked\.json: missing\)/m, 'a tree that cannot be read is a difference (fail closed)');
    const junk = writeTree(path.join(T, 'mv-junk'), { entries: ENTRIES, revoked: REVOKED, files: { 'entries/dev.example.junk.json': 'not JSON' } });
    const j = await run('tools/build-index.mjs', ['resign-check', '--outputs', path.join(T, 'mv-outputs-junk.txt'), '--tree', junk, ...keyArgs()]);
    assert.equal(j.code, 1, j.stdout + j.stderr);
    assert.match(j.stderr, /^REFUSED: MAIN DIVERGES: .*main's entries cannot be read \(dev\.example\.junk\.json not JSON/m, 'an entry file that cannot be read is never skipped');
    const same = path.join(T, 'mv-outputs-same.txt');
    fs.writeFileSync(same, '');
    const ok = await run('tools/build-index.mjs', ['resign-check', '--outputs', same, '--tree', path.join(T, 'tree'), ...keyArgs()]);
    assert.equal(ok.code, 0, ok.stdout + ok.stderr);
    assert.match(ok.stdout, /^PASS main the live catalog is main's/m);
    assert.equal(fs.readFileSync(same, 'utf8'), 'needed=false\n');
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

  test('E2E-check-review: new entries (two entry files) and an added revocation need review (exit 3)', async () => {
    const r = await check('review', path.join(T, 'empty'), path.join(T, 'tree'), ['--author', 'example-login']);
    assert.equal(r.code, 3, r.stdout + r.stderr);
    assert.match(r.stdout, /^FLAG new C11 dev\.example\.intel/m);
    assert.match(r.stdout, /^PASS C13 /m);
    assert.equal(last(r.stdout), 'NEEDS REVIEW new multi-entry revocation revoked', 'revoked: the tree revokes intel 1.0.0 and adds its versions');
  });

  test('E2E-check-publish: against the live base the lift is information, not a refusal', async () => {
    const r = await check('publish', path.join(T, 'base'), path.join(T, 'tree2'), ['--target', 'production']);
    assert.equal(r.code, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /^NOTE base: the live catalog/m);
    assert.match(r.stdout, /^PASS C4-C7 dev\.example\.intel 1\.0\.0/m, 'a version that is not live is checked');
    assert.doesNotMatch(r.stdout, /^PASS C4-C7 dev\.example\.intel 1\.1\.0/m, 'a live version is not');
    assert.match(r.stdout, /^FLAG lift C15 removed: dev\.example\.intel 1\.0\.0/m);
    assert.doesNotMatch(r.stdout, /^FLAG identity/m, 'a catalog names no maintainers or provenance: they are not compared');
    assert.equal(last(r.stdout), 'CHECKS PASSED');
    // The tree the live catalog was built from: intel 1.0.0 is revoked, so the catalog leaves it out, but it was merged, not added.
    const steady = await check('publish', path.join(T, 'base'), path.join(T, 'tree'), ['--target', 'production']);
    assert.equal(steady.code, 0, steady.stdout + steady.stderr);
    assert.doesNotMatch(steady.stdout, /^FLAG /m, 'nothing changed since the live catalog: no review class');
    assert.doesNotMatch(steady.stdout, /^NOTE review classes/m);
    assert.equal(last(steady.stdout), 'CHECKS PASSED');
  });

  test('E2E-check-publish-repair: a repair base is named as such, and its lifts count against the union of revocations', async () => {
    const dir = path.join(T, 'base-repair-check');
    fs.cpSync(path.join(T, 'base'), dir, { recursive: true });
    const meta = JSON.parse(fs.readFileSync(path.join(dir, 'BASE.json'), 'utf8'));
    const older = { id: 'dev.example.older', versions: '*', reason: 'Revoked by an older candidate run.', date: '2026-01-01' };
    const union = [...JSON.parse(fs.readFileSync(path.join(dir, 'catalog.json'), 'utf8')).revoked, older];
    fs.writeFileSync(path.join(dir, 'BASE.json'), JSON.stringify({ ...meta, kind: 'repair', baseRun: 290, floor: meta.generated, floorSource: "run 290's verified head", union }));
    const r = await check('publish', dir, path.join(T, 'tree2'), ['--target', 'production']);
    assert.equal(r.code, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /^NOTE base: the repair base \(run 290's verified catalog/m);
    assert.doesNotMatch(r.stdout, /the live catalog/);
    assert.match(r.stdout, /^FLAG lift C15 removed: dev\.example\.older \*/m);
    assert.match(r.stdout, /^FLAG lift C15 removed: dev\.example\.intel 1\.0\.0/m);
  });

  test('E2E-check-publish-unlisted: against the live catalog an unlisted live version stays pinned; a removed one is refused', async () => {
    // 1.1.0 is live and now unlisted; 1.0.0 is revoked (so not in the live catalog) and unlisted too: neither is added, checked or listed.
    const unlisted = writeTree(path.join(T, 'tree-unlisted'), { entries: [pluginEntry([version('1.1.0', A110, { unlisted: true }), version('1.0.0', A100, { unlisted: true })]), ENTRIES[1]], revoked: REVOKED });
    const r = await check('publish', path.join(T, 'base'), unlisted, ['--target', 'production']);
    assert.equal(r.code, 0, r.stdout + r.stderr);
    assert.doesNotMatch(r.stdout, /^PASS C4-C7 dev\.example\.intel/m, 'an unlisted version is not checked again');
    assert.match(r.stdout, /^PASS C16 .*\(1 archives\)/m, 'only the theme is listed');
    const removed = writeTree(path.join(T, 'tree-removed'), { entries: [pluginEntry([version('1.0.0', A100)]), ENTRIES[1]], revoked: REVOKED });
    const x = await check('publish', path.join(T, 'base'), removed, ['--target', 'production']);
    assert.equal(x.code, 1, x.stdout + x.stderr);
    assert.match(x.stdout, /^FAIL C8 dev\.example\.intel 1\.1\.0: a merged version is never removed/m);
    // C8 holds a live version to all the catalog holds of it: its permissions, engines, release date and changes too.
    const wider = { characters: 'selected', network: ['https://api.example.com', 'https://collect.example.net'] };
    for (const [k, value] of [['permissions', wider], ['engines', '^1.21.0'], ['released', '2026-12-02'], ['changes', 'Slower.']]) {
      const changed = writeTree(path.join(T, `tree-changed-${k}`), { entries: [pluginEntry([version('1.1.0', A110, { [k]: value, unlisted: true }), version('1.0.0', A100)]), ENTRIES[1]], revoked: REVOKED });
      const c = await check('publish', path.join(T, 'base'), changed, ['--target', 'production']);
      assert.equal(c.code, 1, `${k}\n${c.stdout}${c.stderr}`);
      assert.match(c.stdout, new RegExp(`^FAIL C8 dev\\.example\\.intel 1\\.1\\.0: ${k} of a merged version never changes`, 'm'), k);
    }
    const gone = writeTree(path.join(T, 'tree-gone'), { entries: [ENTRIES[1]], revoked: REVOKED });
    const g = await check('publish', path.join(T, 'base'), gone, ['--target', 'production']);
    assert.equal(g.code, 1, g.stdout + g.stderr);
    assert.match(g.stdout, /^FAIL C8 dev\.example\.intel: a merged entry is never removed/m);
  });

  test('E2E-check-mirror: a live version comes from the mirror, hash-checked, never from its author (whose URL may be gone)', async () => {
    servedRoot = path.join(T, 'index'); // archives/ holds intel 1.1.0 and the theme; intel 1.0.0 is revoked, so not mirrored
    const fresh = () => { const c = path.join(T, `mirror-cache-${n++}`); fs.mkdirSync(c); return c; };
    const run2 = (mode, cache, extra) => run('tools/check.mjs', [mode, '--base', path.join(T, 'tree'), '--head', path.join(T, 'tree'), '--archive-cache', cache, ...extra]);
    const cache = fresh();
    const r = await run2('refuse', cache, ['--mirror-url', P]);
    assert.equal(r.code, 0, r.stdout + r.stderr);
    assert.match(r.stdout, new RegExp(`^NOTE archives: the cache, then the mirror ${P.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')}archives/<sha256>\\.zip`, 'm'));
    assert.match(r.stdout, /^PASS C16 .*\(2 archives\)/m);
    assert.deepEqual(fs.readdirSync(cache).sort(), [`${sha(A110)}.zip`, `${sha(DUSK)}.zip`].sort(), 'kept in the cache');
    const none = await run2('refuse', fresh(), ['--mirror-url', 'none']);
    assert.equal(none.code, 1, 'without the mirror the author URLs (127.0.0.1, refused by C4) are all there is');
    assert.match(none.stdout, /^FAIL C16 .*C4 /m);
    assert.match(none.stdout, /^NOTE archives: the cache, then the author's URL \(no mirror\)/m);

    // Other bytes under the name on the mirror do not count: the author's URL is tried, and refused here.
    const swapped = path.join(T, 'swapped');
    fs.cpSync(path.join(T, 'index'), swapped, { recursive: true });
    const other = Buffer.from(A110);
    other[other.length - 1] ^= 1; // the pinned size, other bytes
    fs.writeFileSync(path.join(swapped, 'archives', `${sha(A110)}.zip`), other);
    servedRoot = swapped;
    const x = await run2('refuse', fresh(), ['--mirror-url', P]);
    assert.equal(x.code, 1, x.stdout + x.stderr);
    assert.match(x.stdout, /^FAIL C16 .*dev\.example\.intel 1\.1\.0: C4 .*the mirror copy is not the pinned size and SHA-256/m);
    fs.writeFileSync(path.join(swapped, 'archives', `${sha(A110)}.zip`), Buffer.concat([A110, Buffer.from([0])]));
    const big = await run2('refuse', fresh(), ['--mirror-url', P]);
    assert.match(big.stdout, new RegExp(`^FAIL C16 .*dev\\.example\\.intel 1\\.1\\.0: C4 .*the mirror: more than ${A110.length} bytes`, 'm'), 'read up to the pinned size only');
    servedRoot = path.join(T, 'index');

    // An added version comes from its author's URL (C4) even when the mirror holds its bytes.
    const added = await run('tools/check.mjs', ['refuse', '--base', emptyTree(), '--head', path.join(T, 'tree'), '--archive-cache', fresh(), '--mirror-url', P]);
    assert.equal(added.code, 1, added.stdout + added.stderr);
    assert.match(added.stdout, /^FAIL C4 dev\.example\.intel 1\.1\.0: /m);
    assert.doesNotMatch(added.stdout, /^FAIL .*the mirror/m);
  });

  test('E2E-mirror-pins: the mirror is read only for a pinned size the app reads, up to it, at the given pace', async () => {
    servedRoot = path.join(T, 'index');
    const dir = path.join(T, 'mirror-unit');
    fs.mkdirSync(dir);
    const down = async () => ({ ok: false, error: 'http_status', why: 'the author URL is gone' });
    let paced = 0;
    const pace = async () => { paced++; };
    const ok = await obtainArchive({ url: 'https://127.0.0.1/x.zip', sha256: sha(A110), size: A110.length }, { cache: dir, mirror: P, download: down, pace });
    assert.equal(ok.ok, true);
    assert.equal(paced, 1);
    assert.deepEqual(fs.readFileSync(path.join(dir, `${sha(A110)}.zip`)), A110, 'kept in the cache');
    for (const size of [undefined, 0, 1.5, '12']) {
      const r = await obtainArchive({ url: 'https://127.0.0.1/x.zip', sha256: sha(DUSK), size }, { cache: dir, mirror: P, download: down, pace });
      assert.deepEqual([r.ok, r.why], [false, 'the author URL is gone; the mirror: the entry pins no size the app reads'], String(size));
    }
    assert.equal(paced, 1, 'no request without a pinned size');
  });

  test('E2E-check-mirror-default: the default mirror is the production prefix; a bad --mirror-url is a usage error', async () => {
    const r = await check('refuse', path.join(T, 'tree'), path.join(T, 'tree'));
    assert.equal(r.code, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /^NOTE archives: the cache, then the mirror https:\/\/plugins\.eve-cyno\.dev\/v1\/archives\/<sha256>\.zip/m);
    const t = await check('publish', path.join(T, 'tree'), path.join(T, 'tree'), ['--target', 'test']);
    assert.match(t.stdout, /^NOTE archives: the cache, then the mirror https:\/\/plugins\.eve-cyno\.dev\/test\/v1\/archives\//m, 'the test target reads its own mirror');
    for (const bad of ['http://example.com/v1/', 'https://plugins.eve-cyno.dev/v1', 'ftp://x/']) {
      assert.equal((await check('refuse', path.join(T, 'tree'), path.join(T, 'tree'), ['--mirror-url', bad])).code, 2, bad);
    }
  });

  test('E2E-review-mirror: C10 reads the version before an added one from the mirror', async () => {
    servedRoot = path.join(T, 'index');
    const A120 = pluginZip(manifest({ version: '1.2.0' }));
    const cacheOf = (name) => { const c = path.join(T, name); cacheArchive(c, A120); return c; }; // the added version is cached; 1.1.0 (live) is not
    const head = writeTree(path.join(T, 'tree-120'), { entries: [pluginEntry([version('1.2.0', A120), version('1.1.0', A110), version('1.0.0', A100)]), ENTRIES[1]], revoked: REVOKED });
    const args = (m, cache) => ['review', '--base', path.join(T, 'tree'), '--head', head, '--archive-cache', cache, '--author', 'example-login', '--mirror-url', m];
    const cache = cacheOf('review-mirror-cache');
    const r = await run('tools/check.mjs', args(P, cache));
    assert.equal(r.code, 3, r.stdout + r.stderr);
    assert.doesNotMatch(r.stdout, /^FLAG escalation/m, '1.1.0 read and compared');
    assert.equal(last(r.stdout), 'NEEDS REVIEW revoked', 'the tree revokes intel 1.0.0: a new version of it is read by a maintainer');
    assert.ok(fs.existsSync(path.join(cache, `${sha(A110)}.zip`)), 'read from the mirror');
    const none = await run('tools/check.mjs', args('none', cacheOf('review-nomirror-cache')));
    assert.match(none.stdout, /^FLAG escalation C10 dev\.example\.intel 1\.1\.0: its plugin\.json could not be read/m);

    // The added version is read from its author's URL even when the mirror holds it; a base version the head drops, from the mirror.
    const withNew = path.join(T, 'index-with-120');
    fs.cpSync(path.join(T, 'index'), withNew, { recursive: true });
    fs.writeFileSync(path.join(withNew, 'archives', `${sha(A120)}.zip`), A120);
    servedRoot = withNew;
    const empty = path.join(T, 'review-empty-cache');
    const fresh = await run('tools/check.mjs', args(P, empty));
    assert.match(fresh.stdout, /^FLAG escalation C10 dev\.example\.intel 1\.2\.0: its plugin\.json could not be read/m);
    assert.doesNotMatch(fresh.stdout, /1\.1\.0: its plugin\.json could not be read/);
    const dropped = writeTree(path.join(T, 'tree-120-dropped'), { entries: [pluginEntry([version('1.2.0', A120), version('1.0.0', A100)]), ENTRIES[1]], revoked: REVOKED });
    const d = await run('tools/check.mjs', ['review', '--base', path.join(T, 'tree'), '--head', dropped, '--archive-cache', cacheOf('review-dropped-cache'), '--author', 'example-login', '--mirror-url', P]);
    assert.doesNotMatch(d.stdout, /could not be read/, d.stdout);
    servedRoot = path.join(T, 'index');
  });

  test('E2E-build-mirror: build-index.mjs build reads live archives from the mirror (default: its --prefix)', async () => {
    servedRoot = path.join(T, 'index');
    const cache = path.join(T, 'build-mirror-cache');
    fs.mkdirSync(cache);
    const list = path.join(T, 'build-mirror-archives.json');
    const b = await run('tools/build-index.mjs', ['build', '--prefix', P, '--tree', path.join(T, 'tree'), '--out', path.join(T, 'index-mirror'), '--archive-cache', cache, '--archives-json', list]);
    assert.equal(b.code, 0, b.stdout + b.stderr);
    assert.ok(b.stdout.includes(`NOTE archives: the cache, then the mirror ${P}archives/<sha256>.zip`), b.stdout);
    assert.deepEqual(fs.readdirSync(cache).sort(), [`${sha(A110)}.zip`, `${sha(DUSK)}.zip`].sort(), 'kept in the cache');
    assert.ok(JSON.parse(fs.readFileSync(list, 'utf8')).every(a => a.url.startsWith('https://127.0.0.1/releases/')), 'archives.json still names the author URL');
    const none = await run('tools/build-index.mjs', ['build', '--prefix', P, '--tree', path.join(T, 'tree'), '--out', path.join(T, 'index-nomirror'), '--archive-cache', path.join(T, 'build-nomirror-cache'), '--mirror-url', 'none']);
    assert.equal(none.code, 1, none.stdout + none.stderr);
    assert.match(none.stderr, /^REFUSED: .*C4 /m);
    assert.match(none.stdout, /^NOTE archives: the cache, then the author's URL \(no mirror\)/m);
    assert.doesNotMatch(none.stderr, /the mirror/);
    const bad = await run('tools/build-index.mjs', ['build', '--prefix', P, '--tree', path.join(T, 'tree'), '--out', path.join(T, 'index-badmirror'), '--mirror-url', 'http://example.com/v1/']);
    assert.equal(bad.code, 2, bad.stdout + bad.stderr);
    assert.equal((await run('tools/build-index.mjs', ['base', '--target', 'test', '--repair', 'false', '--out', path.join(T, 'base-mirror'), '--mirror-url', P])).code, 2, 'build only');
  });

  test('E2E-check-refuses: a wrong pinned hash fails C5, and C16 does not run', async () => {
    const bad = writeTree(path.join(T, 'tree-bad'), { entries: [pluginEntry([version('1.1.0', A110, { sha256: sha(A100) })])] });
    const r = await check('refuse', path.join(T, 'empty'), bad);
    assert.equal(r.code, 1, r.stdout + r.stderr);
    assert.match(r.stdout, /^FAIL C5 dev\.example\.intel 1\.1\.0: /m);
    assert.match(r.stdout, /^NOTE C16 and C9 are not run/m);
    assert.equal(last(r.stdout), 'CHECKS FAILED 1');
  });

  test('E2E-check-publish-unlisted-live: a version unlisted by an earlier publish, and an entry with none listed, pass against the live catalog', async () => {
    // The live catalog was built from this tree: intel lists 1.2.0 only (1.1.0 unlisted, 1.0.0 revoked), dusk lists nothing.
    const A120 = pluginZip(manifest({ version: '1.2.0' }));
    cacheArchive(path.join(T, 'cache'), A120);
    const tree = writeTree(path.join(T, 'tree-unlisted-live'), {
      entries: [pluginEntry([version('1.2.0', A120), version('1.1.0', A110, { unlisted: true }), version('1.0.0', A100)]), themeEntry([version('2.0.0', DUSK, { unlisted: true }, 'theme')])], revoked: REVOKED,
    });
    const out = path.join(T, 'index-unlisted-live');
    const bu = await build(out, tree);
    assert.equal(bu.code, 0, bu.stdout + bu.stderr);
    signFolder(out);
    servedRoot = out;
    const base = path.join(T, 'base-unlisted-live');
    const b = await run('tools/build-index.mjs', ['base', '--target', 'production', '--repair', 'false', '--out', base, ...keyArgs()]);
    servedRoot = path.join(T, 'index');
    assert.equal(b.code, 0, b.stdout + b.stderr);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(base, 'catalog.json'), 'utf8')).plugins.map(l => [l.id, l.versions.map(v => v.version)]), [['dev.example.intel', ['1.2.0']]]);
    const r = await check('publish', base, tree, ['--target', 'production']);
    assert.equal(r.code, 0, r.stdout + r.stderr);
    assert.equal(last(r.stdout), 'CHECKS PASSED');
    assert.doesNotMatch(r.stdout, /could not be read/, 'an unlisted version is never an added one for C10');
    assert.doesNotMatch(r.stdout, /^FLAG /m, 'a revoked, an unlisted version and an entry with none listed were merged, not added: no review class');
    // A live catalog cannot tell a version listed again from an added one; the pull request's checks against the base tree refuse it.
  });

  test('E2E-review-unlist-and-add: the archive read for C10 is the listed version before the added one, as the head lists them', async () => {
    // The pull request adds 1.2.0 and unlists 1.1.0: C10 compares 1.2.0 with 1.0.0, so 1.0.0's archive is read and 1.1.0's is not.
    const A120 = pluginZip(manifest({ version: '1.2.0' }));
    const cache = path.join(T, 'unlist-add-cache');
    for (const z of [A120, A100]) cacheArchive(cache, z);
    const base = writeTree(path.join(T, 'tree-unlist-add-base'), { entries: [pluginEntry([version('1.1.0', A110), version('1.0.0', A100)])], revoked: [] });
    const head = writeTree(path.join(T, 'tree-unlist-add-head'), { entries: [pluginEntry([version('1.2.0', A120), version('1.1.0', A110, { unlisted: true }), version('1.0.0', A100)])], revoked: [] });
    const r = await run('tools/check.mjs', ['review', '--base', base, '--head', head, '--archive-cache', cache, '--author', 'example-login']);
    assert.equal(r.code, 0, r.stdout + r.stderr);
    assert.equal(last(r.stdout), 'NO REVIEW NEEDED');
  });
});
