// VL-*: tools/publish/verify-live.mjs, the verify job of publish.yml and resign.yml (plan 4.2 job verify, 6.2), and the paced live
// download of tools/lib/liveread.mjs. The live index is a bucket file served over 127.0.0.1 (awsstub.mjs serveBucket), signed with
// throwaway keys made in this run. No network but 127.0.0.1.
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { throwawaySigner } from '../lib/throwaway.mjs';
import { pacer } from '../lib/indexbuild.mjs';
import { downloadServed } from '../lib/liveread.mjs';
import { ROOT, cacheArchive, cleanup, manifest, pluginEntry, pluginZip, run, sha, tempDir, themeEntry, themeZip, version, writeTree } from './trees.mjs';
import { object, serveBucket, writeBucket } from './awsstub.mjs';

const require = createRequire(import.meta.url);
const I = require(path.join(ROOT, 'vendor', 'eve-cyno-host', 'host', 'dist', 'market', 'indexformat.js'));
const TOOL = 'tools/publish/verify-live.mjs';
const IMMUTABLE = 'public, max-age=31536000, immutable';
const signer = throwawaySigner(), testSigner = throwawaySigner();
const A100 = pluginZip(manifest({ version: '1.0.0' }));
const A110 = pluginZip(manifest({ version: '1.1.0' }));
const DUSK = themeZip();
const TREE = { entries: [pluginEntry([version('1.1.0', A110), version('1.0.0', A100)]), themeEntry([version('2.0.0', DUSK, {}, 'theme')])] };
let T, P, PT, PUB, server, current = null;
const objs = {};

async function published(name, prefix, keyPrefix, s) {
  const dir = path.join(T, name);
  const r = await run('tools/build-index.mjs', ['build', '--prefix', prefix, '--tree', writeTree(path.join(T, `tree-${name}`), TREE), '--out', dir, '--archive-cache', path.join(T, 'cache')]);
  assert.equal(r.code, 0, r.stdout + r.stderr);
  const head = fs.readFileSync(path.join(dir, 'index.json'));
  fs.writeFileSync(path.join(dir, 'index.json.minisig'), s.sign(head, I.indexComment(JSON.parse(head).generated)));
  const out = {};
  const walk = (rel) => {
    for (const e of fs.readdirSync(path.join(dir, rel), { withFileTypes: true })) {
      const f = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(f);
      else out[keyPrefix + f] = object(fs.readFileSync(path.join(dir, f)), 'application/octet-stream', f.startsWith('index.json') ? 'no-cache' : IMMUTABLE);
    }
  };
  walk('');
  objs[name] = out;
}
function serve(objects) {
  current = path.join(tempDir('vl'), 'bucket.json');
  writeBucket(current, { objects });
  return current;
}
const verify = (args) => run(TOOL, args);
const last = (r) => r.stdout.trim().split('\n').at(-1);

before(async () => {
  T = tempDir('verify-live');
  for (const a of [A100, A110, DUSK]) cacheArchive(path.join(T, 'cache'), a);
  server = await serveBucket(() => current);
  P = `http://127.0.0.1:${server.port}/v1/`;
  PT = `http://127.0.0.1:${server.port}/test/v1/`;
  PUB = path.join(T, 'index.pub');
  fs.writeFileSync(PUB, signer.pubText);
  fs.mkdirSync(path.join(T, 'in'));
  fs.writeFileSync(path.join(T, 'in', 'test.pub'), testSigner.pubText);
  await published('B', P, 'v1/', signer);
  await published('BT', PT, 'test/v1/', testSigner);
});
after(() => { server?.close(); cleanup(); });

describe('verify-live', () => {
  test('VL-ok: the published index reads back and verifies; the summary says so', async () => {
    serve(objs.B);
    const summary = path.join(T, 'summary.md');
    const r = await verify(['--target', 'production', '--in', path.join(T, 'nothing'), '--summary', summary, '--prefix', P, '--key', PUB]);
    assert.equal(r.code, 0, r.stdout + r.stderr);
    assert.match(last(r), /^LIVE VERIFIED /);
    assert.match(r.stdout, /^PASS cache index\.json is served with Cache-Control: no-cache/m);
    assert.match(r.stdout, /^PASS cache index\.json\.minisig is served/m);
    assert.match(r.stdout, /^PASS date /m);
    assert.match(r.stdout, /^NOTE index-verify: INDEX VERIFY OK /m);
    assert.doesNotMatch(r.stdout, /immutable Cache-Control/);
    assert.match(fs.readFileSync(summary, 'utf8'), /\*\*LIVE VERIFIED /);
  });

  test('VL-no-cache: a head served without no-cache fails; a mutable archive is a note', async () => {
    const o = structuredClone(objs.B);
    o['v1/index.json'].cacheControl = IMMUTABLE;
    const zip = Object.keys(o).find(k => k.endsWith('.zip'));
    o[zip].cacheControl = 'public, max-age=60';
    serve(o);
    const r = await verify(['--target', 'production', '--in', T, '--prefix', P, '--key', PUB]);
    assert.equal(r.code, 1, r.stdout + r.stderr);
    assert.match(r.stdout, /^FAIL cache index\.json is served with Cache-Control "public, max-age=31536000, immutable", not no-cache/m);
    assert.match(r.stdout, /^NOTE served without an immutable Cache-Control: archives\//m);
    assert.match(last(r), /^LIVE NOT VERIFIED/);
  });

  test('VL-archive-swapped: an archive with other bytes in the bucket fails verify', async () => {
    const o = structuredClone(objs.B);
    const k = `v1/archives/${sha(A100)}.zip`;
    o[k] = object(Buffer.concat([A100.subarray(0, A100.length - 1), Buffer.from([A100.at(-1) ^ 1])]), 'application/zip', IMMUTABLE);
    serve(o);
    const r = await verify(['--target', 'production', '--in', T, '--prefix', P, '--key', PUB]);
    assert.equal(r.code, 1, r.stdout + r.stderr);
    assert.match(r.stdout, /^FAIL index-verify .*archives\//m);
  });

  test('VL-wrong-key-or-missing-head: another key, or no head at all, fails', async () => {
    serve(objs.B);
    const other = path.join(T, 'other.pub');
    fs.writeFileSync(other, throwawaySigner().pubText);
    const k = await verify(['--target', 'production', '--in', T, '--prefix', P, '--key', other]);
    assert.equal(k.code, 1, k.stdout + k.stderr);
    assert.match(k.stdout, /^FAIL index-verify signature of index\.json/m);
    const o = structuredClone(objs.B);
    delete o['v1/index.json'];
    serve(o);
    const m = await verify(['--target', 'production', '--in', T, '--prefix', P, '--key', PUB]);
    assert.equal(m.code, 1);
    assert.match(m.stdout, /^FAIL read .*index\.json: HTTP 404/m);
  });

  test('VL-test-target: test/v1/ with the run\'s throwaway key from test.pub; without it, a refusal', async () => {
    serve(objs.BT);
    const r = await verify(['--target', 'test', '--in', path.join(T, 'in'), '--prefix', PT]);
    assert.equal(r.code, 0, r.stdout + r.stderr);
    assert.match(last(r), /^LIVE VERIFIED /);
    const none = await verify(['--target', 'test', '--in', path.join(T, 'nothing'), '--prefix', PT]);
    assert.equal(none.code, 1);
    assert.match(none.stdout, /test\.pub/);
    const usage = await verify(['--target', 'test', '--in', path.join(T, 'in'), '--prefix', PT, '--key', PUB]);
    assert.equal(usage.code, 2);
  });

  test('VL-paced: the live reads go through the pacer, never more than its limit in one window', async () => {
    serve(objs.B);
    const at = server.requests.length;
    const t0 = Date.now();
    const d = await downloadServed({ prefix: P, dir: path.join(tempDir('vl-paced'), 'live'), pace: pacer(2, 400) });
    assert.equal(d.ok, true, d.why);
    const reqs = server.requests.slice(at);
    assert.equal(reqs.length, 6, 'head, signature, catalog and three archives, each once');
    assert.ok(Date.now() - t0 >= 790, `six requests at two per 400 ms take at least 800 ms (${Date.now() - t0} ms)`);
    for (let i = 2; i < reqs.length; i++) assert.ok(reqs[i].at - reqs[i - 2].at >= 390, `request ${i} came ${reqs[i].at - reqs[i - 2].at} ms after request ${i - 2}`);
  });
});
