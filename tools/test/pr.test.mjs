// PR-*: the fixture pull-request suite (plan task 1.10). Each test builds a base tree and a head tree, caches the archives the head
// pins (so the download check C4 never connects: every archive URL is https://127.0.0.1/..., an address C4 refuses before it
// connects), runs tools/check.mjs as check.yml does (`refuse`, then `review`) and reads its verdict line and exit code.
// A refusal test names the check that refuses; a review test names the class. The first test shows that the same trees without a
// fault pass both modes, so no refusal below comes from the fixture itself. No network, no key, no secret.
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { ROOT, cacheArchive, cleanup, manifest, pluginEntry, pluginZip, run, sha, tempDir, version, writeTree } from './trees.mjs';
import { zerosAtExactRatio, zerosAtMostRatio, zip } from './zipwrite.mjs';

const MIB = 1024 * 1024;
const today = new Date().toISOString().slice(0, 10);
const last = (out) => out.trim().split('\n').at(-1);
// TOOLS_ROOT lets the mutation proofs run the same suite against a mutated copy of the tools (never set in a normal run).
const SCRIPT = process.env.PR_TEST_TOOLS_ROOT ? path.relative(ROOT, path.join(process.env.PR_TEST_TOOLS_ROOT, 'tools', 'check.mjs')) : 'tools/check.mjs';

let T, cache, n = 0;
const A100 = pluginZip(manifest({ version: '1.0.0' }));
before(() => { T = tempDir('pr'); cache = path.join(T, 'cache'); cacheArchive(cache, A100); });
after(cleanup);

const tree = (spec) => writeTree(path.join(T, `t${n++}`), spec);
const baseTree = (extra = {}) => tree({ entries: [pluginEntry([version('1.0.0', A100)])], ...extra });
/** A head that adds 1.1.0 (the archive `bytes`, cached) to the base entry; `pin` overrides what the entry pins. */
function head(bytes, { pin = {}, entry = {}, ...rest } = {}) {
  cacheArchive(cache, bytes);
  return tree({ entries: [pluginEntry([version('1.1.0', bytes, pin), version('1.0.0', A100)], entry)], ...rest });
}
const check = (mode, base, h, extra = []) => run(SCRIPT, [mode, '--base', base, '--head', h, '--archive-cache', cache, ...extra]);
const refused = async (h, re, base = baseTree()) => {
  const r = await check('refuse', base, h);
  assert.equal(r.code, 1, r.stdout + r.stderr);
  assert.match(r.stdout, re);
  assert.match(last(r.stdout), /^CHECKS FAILED [1-9]/);
  assert.doesNotMatch(r.stdout, /^PASS C16/m, 'the whole-index check does not run after a refusal');
};
/** An archive with plugin.json, index.html and the `extra` entries. */
const withFiles = (extra, m = manifest({ version: '1.1.0' })) => pluginZip(m, extra);

describe('PR fixture suite', () => {
  test('PR-clean: a new version with the same permissions passes refuse and needs no review', async () => {
    const A110 = pluginZip(manifest({ version: '1.1.0' }));
    const base = baseTree(), h = head(A110);
    const r = await check('refuse', base, h);
    assert.equal(r.code, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /^PASS C4-C7 dev\.example\.intel 1\.1\.0/m);
    assert.match(r.stdout, /^PASS C16 /m);
    assert.equal(last(r.stdout), 'CHECKS PASSED');
    const v = await check('review', base, h, ['--author', 'example-login']);
    assert.equal(v.code, 0, v.stdout + v.stderr);
    assert.equal(last(v.stdout), 'NO REVIEW NEEDED');
  });

  test('PR-bad-manifest: an archive whose plugin.json the app refuses is refused at C7', async () => {
    const bad = withFiles([], manifest({ version: '1.1.0', main: '../escape.html' }));
    await refused(head(bad), /^FAIL C7 dev\.example\.intel 1\.1\.0: /m);
  });

  test('PR-manifest-differs: a plugin.json that disagrees with the entry is refused at C7', async () => {
    const bad = withFiles([], manifest({ version: '1.1.0', permissions: { characters: 'selected', network: ['https://evil.example.net'] } }));
    await refused(head(bad), /^FAIL C7 dev\.example\.intel 1\.1\.0: /m);
  });

  test('PR-wrong-hash: a pinned SHA-256 that is not the archive\'s (same size) is refused at C5', async () => {
    const A110 = pluginZip(manifest({ version: '1.1.0' }));
    const other = Buffer.from(A110);
    other[other.length - 1] ^= 0x01; // the pin is the hash of this copy; the cache holds A110 under that name
    cacheArchive(cache, A110, sha(other));
    await refused(head(A110, { pin: { sha256: sha(other) } }), /^FAIL C5 dev\.example\.intel 1\.1\.0: .*SHA-256 is not the one the entry pins/m);
  });

  test('PR-wrong-size: a pinned size that is not the archive\'s is refused at C5', async () => {
    const A110 = pluginZip(manifest({ version: '1.1.0' }));
    await refused(head(A110, { pin: { size: A110.length + 1 } }), /^FAIL C5 dev\.example\.intel 1\.1\.0: .*bytes; the entry pins/m);
  });

  test('PR-zip-bomb-ratio: an entry that inflates 101:1 is refused at C6', async () => {
    const x = zerosAtExactRatio(101, 1500);
    await refused(head(withFiles([{ name: 'big.bin', data: x.data, raw: x.raw }])), /^FAIL C6 dev\.example\.intel 1\.1\.0: .*ratio/mi);
  });

  test('PR-zip-bomb-total: more than 64 MiB unpacked is refused at C6', async () => {
    const a = zerosAtMostRatio(32 * MIB, 100), c = zerosAtMostRatio(32 * MIB + 1, 100);
    await refused(head(withFiles([{ name: 'a.bin', data: a.data, raw: a.raw }, { name: 'c.bin', data: c.data, raw: c.raw }])), /^FAIL C6 dev\.example\.intel 1\.1\.0: /m);
  });

  test('PR-zip-bomb-count: 2,001 entries are refused at C6', async () => {
    const many = Array.from({ length: 1999 }, (_, i) => ({ name: `f/${String(i).padStart(4, '0')}.txt`, data: 'x', method: 0 }));
    await refused(head(withFiles(many)), /^FAIL C6 dev\.example\.intel 1\.1\.0: /m); // plugin.json + index.html + 1999 = 2001
  });

  test('PR-zip-count-edge: 2,000 entries are not a bomb (the count test refuses at the limit, not before)', async () => {
    const many = Array.from({ length: 1998 }, (_, i) => ({ name: `f/${String(i).padStart(4, '0')}.txt`, data: 'x', method: 0 }));
    const r = await check('refuse', baseTree(), head(withFiles(many)));
    assert.equal(r.code, 0, r.stdout + r.stderr);
  });

  test('PR-escalation: a new version that asks for more network is flagged NEEDS REVIEW escalation', async () => {
    const net = { characters: 'selected', network: ['https://api.example.com', 'https://more.example.com'] };
    const A110 = pluginZip(manifest({ version: '1.1.0', permissions: net }));
    const base = baseTree(), h = head(A110, { pin: { permissions: net } });
    assert.equal((await check('refuse', base, h)).code, 0, 'a valid change: refuse passes, review decides');
    const r = await check('review', base, h, ['--author', 'example-login']);
    assert.equal(r.code, 3, r.stdout + r.stderr);
    assert.match(r.stdout, /^FLAG escalation C10 dev\.example\.intel/m);
    assert.equal(last(r.stdout), 'NEEDS REVIEW escalation');
  });

  test('PR-maintenance: a change outside entries/ and revoked.json is flagged NEEDS REVIEW maintenance', async () => {
    const base = baseTree({ files: { 'tools/check.mjs': '// old\n' } });
    const h = tree({ entries: [pluginEntry([version('1.0.0', A100)])], files: { 'tools/check.mjs': '// new: passes everything\n' } });
    const r = await check('review', base, h, ['--author', 'example-login']);
    assert.equal(r.code, 3, r.stdout + r.stderr);
    assert.match(r.stdout, /^FLAG maintenance C13 1 path\(s\) outside entries\/<id>\.json and revoked\.json: tools\/check\.mjs/m);
    assert.equal(last(r.stdout), 'NEEDS REVIEW maintenance');
  });

  test('PR-entries-dotfile: entries/.gitattributes is refused at C1 and flagged maintenance by C13', async () => {
    const base = baseTree();
    const h = tree({ entries: [pluginEntry([version('1.0.0', A100)])], files: { 'entries/.gitattributes': '*.json export-ignore\n' } });
    const r = await check('refuse', base, h);
    assert.equal(r.code, 1, r.stdout + r.stderr);
    assert.match(r.stdout, /^FAIL C1 entries\/\.gitattributes: /m);
    const v = await check('review', base, h, ['--author', 'example-login']);
    assert.match(v.stdout, /^FLAG maintenance C13 1 path\(s\) outside entries\/<id>\.json and revoked\.json: entries\/\.gitattributes/m);
    assert.doesNotMatch(v.stdout, /^PASS C13/m);
  });

  test('PR-entries-subfolder: a file in a folder below entries/ is refused at C1 and flagged maintenance by C13', async () => {
    const base = baseTree();
    const h = tree({ entries: [pluginEntry([version('1.0.0', A100)])], files: { 'entries/x/.gitattributes': '* export-ignore\n', 'entries/x/dev.example.y.json': '{}' } });
    const r = await check('refuse', base, h);
    assert.equal(r.code, 1, r.stdout + r.stderr);
    assert.match(r.stdout, /^FAIL C1 entries\/x: /m);
    const v = await check('review', base, h, ['--author', 'example-login']);
    assert.match(v.stdout, /^FLAG maintenance C13 2 path\(s\) outside entries\/<id>\.json and revoked\.json: entries\/x\/\.gitattributes, entries\/x\/dev\.example\.y\.json/m);
  });

  test('PR-entries-gitkeep: a change to entries/.gitkeep or a dot .json file is maintenance, not an entry change', async () => {
    const base = baseTree();
    const h = tree({ entries: [pluginEntry([version('1.0.0', A100)])], files: { 'entries/.gitkeep': 'x', 'entries/.hidden.json': '{}' } });
    const v = await check('review', base, h, ['--author', 'example-login']);
    assert.match(v.stdout, /^FLAG maintenance C13 2 path\(s\) outside entries\/<id>\.json and revoked\.json: entries\/\.gitkeep, entries\/\.hidden\.json/m);
  });

  test('PR-lift: removing a revocation is flagged NEEDS REVIEW lift', async () => {
    const rev = [{ id: 'dev.example.intel', versions: ['1.0.0'], reason: 'Sends tokens to an unknown host.', date: today }];
    const base = baseTree({ revoked: rev });
    const h = tree({ entries: [pluginEntry([version('1.0.0', A100)])], revoked: [] });
    const r = await check('review', base, h, ['--author', 'example-login']);
    assert.equal(r.code, 3, r.stdout + r.stderr);
    assert.match(r.stdout, /^FLAG lift C15 removed: dev\.example\.intel 1\.0\.0/m);
    assert.equal(last(r.stdout), 'NEEDS REVIEW lift');
  });

  test('PR-bad-entry: an entry the app\'s listing rules refuse is refused at C1', async () => {
    const h = tree({ entries: [pluginEntry([version('1.0.0', A100)], { source: 'http://example.com/not-https' })] });
    const r = await check('refuse', baseTree(), h);
    assert.equal(r.code, 1, r.stdout + r.stderr);
    assert.match(r.stdout, /^FAIL C1 entries\/dev\.example\.intel\.json: /m);
  });
});
