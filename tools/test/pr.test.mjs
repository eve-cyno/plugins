// PR-*: the fixture pull-request suite (plan task 1.10). Each test builds a base tree and a head tree, caches the archives the head
// pins (so the download check C4 never connects: every archive URL is https://127.0.0.1/..., an address C4 refuses before it
// connects), runs tools/check.mjs as check.yml does (`refuse`, then `review`) and reads its verdict line and exit code.
// A refusal test names the check that refuses; a review test names the class. The first test shows that the same trees without a
// fault pass both modes, so no refusal below comes from the fixture itself. No network, no key, no secret.
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { PERMS, ROOT, cacheArchive, cleanup, linesOf, manifest, pluginEntry, pluginZip, run, sha, tempDir, themeEntry, themeZip, version, writeTree } from './trees.mjs';
import { ISSUER, PREDICATE } from '../lib/provenance.mjs';
import { toListing } from '../lib/entries.mjs';
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
/** A live base as build-index.mjs base writes it: catalog.json with the listings of `entries` (no author URL, no maintainers). */
function catalogBase(entries, revoked = []) {
  const dir = path.join(T, `t${n++}`);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'catalog.json'), `${JSON.stringify({ plugins: entries.map(toListing), revoked })}\n`);
  return dir;
}
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

  test('PR-untouched-entry: an entry the pull request does not change needs none of its maintainers', async () => {
    const B = pluginZip(manifest({ id: 'dev.other.tool', name: 'Other Tool' }));
    cacheArchive(cache, B);
    const other = pluginEntry([version('1.0.0', B)], { id: 'dev.other.tool', name: 'Other Tool', maintainers: ['bob'] });
    const A110 = pluginZip(manifest({ version: '1.1.0' }));
    cacheArchive(cache, A110);
    const base = baseTree({ entries: [pluginEntry([version('1.0.0', A100)]), other] });
    const both = tree({ entries: [pluginEntry([version('1.1.0', A110), version('1.0.0', A100)]), other] });
    const r = await check('review', base, both, ['--author', 'example-login']);
    assert.equal(r.code, 0, r.stdout + r.stderr);
    assert.equal(last(r.stdout), 'NO REVIEW NEEDED');
    const m = await check('review', base, both, ['--author', 'bob']);
    assert.equal(m.code, 3, m.stdout + m.stderr);
    assert.match(m.stdout, /^FLAG identity C10 C14 dev\.example\.intel: /m, 'the changed entry still needs one of its maintainers');
    assert.doesNotMatch(m.stdout, /^FLAG identity C10 C14 dev\.other\.tool/m);
  });

  test('PR-unlist: a merged version marked unlisted passes, stays pinned, and leaves the index without its archive', async () => {
    const OLD = pluginZip(manifest({ version: '0.9.0' })); // never cached: neither C4 nor C16 may need it once it is unlisted
    const base = tree({ entries: [pluginEntry([version('1.0.0', A100), version('0.9.0', OLD)])] });
    const h = tree({ entries: [pluginEntry([version('1.0.0', A100), version('0.9.0', OLD, { unlisted: true })])] });
    const r = await check('refuse', base, h);
    assert.equal(r.code, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /^PASS C16 .*\(1 archives\)/m);
  });

  test('PR-version-removed: removing a merged version is refused at C8 (unlist it instead)', async () => {
    const A110 = pluginZip(manifest({ version: '1.1.0' }));
    cacheArchive(cache, A110);
    const base = tree({ entries: [pluginEntry([version('1.1.0', A110), version('1.0.0', A100)])] });
    await refused(tree({ entries: [pluginEntry([version('1.0.0', A100)])] }), /^FAIL C8 dev\.example\.intel 1\.1\.0: a merged version is never removed/m, base);
  });

  test('PR-swap-across-prs: an unlisted version re-added with other bytes is refused at C8 (repro 2)', async () => {
    const A200 = pluginZip(manifest({ version: '2.0.0' }));
    const A200b = pluginZip(manifest({ version: '2.0.0' }), [{ name: 'evil.js', data: 'x' }]);
    cacheArchive(cache, A200b);
    const base = tree({ entries: [pluginEntry([version('2.0.0', A200, { unlisted: true }), version('1.0.0', A100)])] });
    const h = tree({ entries: [pluginEntry([version('2.0.0', A200b), version('1.0.0', A100)])] });
    await refused(h, /^FAIL C8 dev\.example\.intel 2\.0\.0: sha256 of a merged version never changes/m, base);
  });

  test('PR-entry-removed: removing a merged entry is refused at C8', async () => {
    await refused(tree({ entries: [] }), /^FAIL C8 dev\.example\.intel: a merged entry is never removed/m);
  });

  test('PR-background-over-unlisted: C10 reads the listed version before, not an unlisted one', async () => {
    const bg = (v, background) => pluginZip(manifest({ version: v, background }));
    const [B100, B110, B120] = [bg('1.0.0', true), bg('1.1.0', false), bg('1.2.0', true)];
    for (const b of [B100, B110, B120]) cacheArchive(cache, b);
    const base = tree({ entries: [pluginEntry([version('1.1.0', B110, { unlisted: true }), version('1.0.0', B100)])] });
    const h = tree({ entries: [pluginEntry([version('1.2.0', B120), version('1.1.0', B110, { unlisted: true }), version('1.0.0', B100)])] });
    const r = await check('review', base, h, ['--author', 'example-login']);
    assert.equal(r.code, 0, r.stdout + r.stderr);
    assert.equal(last(r.stdout), 'NO REVIEW NEEDED', 'background was on in 1.0.0, the listed version before 1.2.0');
  });

  // Regression: with no listed version below an added one, C10 skipped the comparison.
  const MORE = { characters: 'selected', network: ['https://api.example.com', 'https://collect.example.net'] };
  test('ESC-unlist-all-same-pr: a new version with more permissions and background, every older version unlisted in the same pull request, needs review escalation', async () => {
    const Z200 = pluginZip(manifest({ version: '2.0.0', permissions: MORE, background: true }));
    cacheArchive(cache, Z200);
    const base = baseTree();
    const plain = tree({ entries: [pluginEntry([version('2.0.0', Z200, { permissions: MORE }), version('1.0.0', A100)])] });
    const unlisted = tree({ entries: [pluginEntry([version('2.0.0', Z200, { permissions: MORE }), version('1.0.0', A100, { unlisted: true })])] });
    for (const [label, h] of [['a plain add', plain], ['an add that unlists 1.0.0', unlisted]]) {
      const r = await check('refuse', base, h);
      assert.equal(r.code, 0, `${label}: a valid change, refuse passes and review decides\n${r.stdout}${r.stderr}`);
      const v = await check('review', base, h, ['--author', 'example-login']);
      assert.equal(v.code, 3, `${label}\n${v.stdout}${v.stderr}`);
      assert.match(v.stdout, /^FLAG escalation C10 dev\.example\.intel: /m, label);
      assert.doesNotMatch(v.stdout, /could not be read/, `${label}: compared, not a failed read`);
      assert.equal(last(v.stdout), 'NEEDS REVIEW escalation', label);
    }
    // Compared with the unlisted 1.0.0, whose plugin.json is read: background alone is an escalation, nothing new is none.
    const BG = pluginZip(manifest({ version: '2.0.0', background: true }));
    const SAME = pluginZip(manifest({ version: '2.0.0' }));
    for (const z of [BG, SAME]) cacheArchive(cache, z);
    const bg = await check('review', base, tree({ entries: [pluginEntry([version('2.0.0', BG), version('1.0.0', A100, { unlisted: true })])] }), ['--author', 'example-login']);
    assert.equal(last(bg.stdout), 'NEEDS REVIEW escalation', bg.stdout);
    assert.doesNotMatch(bg.stdout, /could not be read/);
    const same = await check('review', base, tree({ entries: [pluginEntry([version('2.0.0', SAME), version('1.0.0', A100, { unlisted: true })])] }), ['--author', 'example-login']);
    assert.equal(same.code, 0, same.stdout + same.stderr);
    assert.equal(last(same.stdout), 'NO REVIEW NEEDED');
  });

  test('ESC-unlist-then-add: one pull request unlists every version, the next adds one with more permissions and background: review escalation', async () => {
    const Z200 = pluginZip(manifest({ version: '2.0.0', permissions: MORE, background: true }));
    cacheArchive(cache, Z200);
    const s1 = tree({ entries: [pluginEntry([version('1.0.0', A100, { unlisted: true })])] });
    const first = await check('review', baseTree(), s1, ['--author', 'example-login']);
    assert.equal(last(first.stdout), 'NO REVIEW NEEDED', 'unlisting alone needs no review');
    const s2 = tree({ entries: [pluginEntry([version('2.0.0', Z200, { permissions: MORE }), version('1.0.0', A100, { unlisted: true })])] });
    const r = await check('refuse', s1, s2);
    assert.equal(r.code, 0, r.stdout + r.stderr);
    const v = await check('review', s1, s2, ['--author', 'example-login']);
    assert.equal(v.code, 3, v.stdout + v.stderr);
    assert.match(v.stdout, /^FLAG escalation C10 dev\.example\.intel: /m);
    assert.doesNotMatch(v.stdout, /could not be read/, 'the unlisted 1.0.0 is read and compared');
    assert.equal(last(v.stdout), 'NEEDS REVIEW escalation');
  });

  // Trust check of the fix above (2026-11-19): C10 read the permissions of the version before from the entry, which no check holds to the
  // archive once the version is unlisted. A first pull request unlists 1.0.0 and widens its entry permissions; a second adds 2.0.0 with
  // those permissions and puts 1.0.0's back, so its archive reads again. Both needed no review.
  test('ESC-widen-unlisted-then-add: the version before an added one is compared by its archive\'s plugin.json, never by its entry copy', async () => {
    const Z200 = pluginZip(manifest({ version: '2.0.0', permissions: MORE }));
    const A110 = pluginZip(manifest({ version: '1.1.0' }));
    for (const z of [Z200, A110]) cacheArchive(cache, z);
    const add = (older) => tree({ entries: [pluginEntry([version('2.0.0', Z200, { permissions: MORE }), ...older])] });
    const widened = tree({ entries: [pluginEntry([version('1.0.0', A100, { unlisted: true, permissions: MORE })])] });
    const widened2 = tree({ entries: [pluginEntry([version('1.1.0', A110, { unlisted: true, permissions: MORE }), version('1.0.0', A100, { unlisted: true })])] });
    // C10 reads the version before by the base's copy of it (ESC-repin-then-add), and the widened base copy disagrees with its archive's
    // plugin.json, so each read fails closed: a review, whatever the second pull request writes back.
    const cases = [
      ['1.0.0 put back', widened, add([version('1.0.0', A100, { unlisted: true })]), '1.0.0'],
      ['an unlisted 1.1.0 above an unlisted 1.0.0, put back', widened2, add([version('1.1.0', A110, { unlisted: true }), version('1.0.0', A100, { unlisted: true })]), '1.1.0'],
      ['1.0.0 left widened', widened, add([version('1.0.0', A100, { unlisted: true, permissions: MORE })]), '1.0.0'],
    ];
    for (const [label, base, h, unread] of cases) {
      const v = await check('review', base, h, ['--author', 'example-login']);
      assert.equal(v.code, 3, `${label}\n${v.stdout}${v.stderr}`);
      assert.match(v.stdout, new RegExp(`^FLAG escalation C10 dev\\.example\\.intel ${unread.replaceAll('.', '\\.')}: its plugin\\.json could not be read`, 'm'), label);
      assert.equal(last(v.stdout), 'NEEDS REVIEW escalation', label);
    }
  });

  // Re-review of the fix above (2026-11-19): for the version before an added one, C10 read the head's pin of it. One pull request that
  // re-pins 1.0.0 (listed or unlisted) to a wider archive and adds 2.0.0 with the wider permissions needed no review; only the checks
  // job (C8) refused it. The review job reads the base's pin of a version the base holds, so it holds without the checks job.
  test('ESC-repin-then-add: the version before an added one is read by the base\'s pin, never by the head\'s', async () => {
    const B100 = pluginZip(manifest({ version: '1.0.0', permissions: MORE }));
    const Z200 = pluginZip(manifest({ version: '2.0.0', permissions: MORE }));
    for (const z of [B100, Z200]) cacheArchive(cache, z);
    for (const unl of [{}, { unlisted: true }]) {
      const label = `1.0.0 re-pinned ${JSON.stringify(unl)}`;
      const h = tree({ entries: [pluginEntry([version('2.0.0', Z200, { permissions: MORE }), version('1.0.0', B100, { permissions: MORE, ...unl })])] });
      const v = await check('review', baseTree(), h, ['--author', 'example-login']);
      assert.equal(v.code, 3, `${label}\n${v.stdout}${v.stderr}`);
      assert.match(v.stdout, /^FLAG escalation C10 dev\.example\.intel: /m, label);
      assert.doesNotMatch(v.stdout, /could not be read/, `${label}: the base's 1.0.0 is read and compared`);
      assert.equal(last(v.stdout), 'NEEDS REVIEW escalation', label);
    }
  });

  test('PR-merged-version-frozen: the first pull request of ESC-widen (unlist 1.0.0, widen its entry permissions) is refused at C8', async () => {
    await refused(tree({ entries: [pluginEntry([version('1.0.0', A100, { unlisted: true, permissions: MORE })])] }),
      /^FAIL C8 dev\.example\.intel 1\.0\.0: permissions of a merged version never changes/m);
    await refused(tree({ entries: [pluginEntry([version('1.0.0', A100, { engines: '^1.21.0' })])] }),
      /^FAIL C8 dev\.example\.intel 1\.0\.0: engines of a merged version never changes/m);
    const r = await check('refuse', baseTree(), tree({ entries: [pluginEntry([version('1.0.0', A100, { unlisted: true })])] }));
    assert.equal(r.code, 0, `unlisting alone is allowed\n${r.stdout}${r.stderr}`);
  });

  test('ESC-base-version-not-semver: a base version that is not semver leaves C10 nothing to compare: review escalation, not a crash', async () => {
    const A110 = pluginZip(manifest({ version: '1.1.0' }));
    const base = tree({ entries: [pluginEntry([version('1.0.0', A100), { ...version('1.0.0', A100), version: 'one' }])] });
    const v = await check('review', base, head(A110), ['--author', 'example-login']);
    assert.equal(v.code, 3, v.stdout + v.stderr);
    assert.match(v.stdout, /^FLAG escalation C10 dev\.example\.intel: the permissions could not be compared/m);
  });

  test('REV-new-version-of-revoked-id: an added version of an id that revoked.json names (base or head) needs review revoked', async () => {
    const Z101 = pluginZip(manifest({ version: '1.0.1' }));
    cacheArchive(cache, Z101);
    const rev = [{ id: 'dev.example.intel', versions: ['1.0.0'], reason: 'Sends data to a third party.', date: today }];
    const added = (revoked) => tree({ entries: [pluginEntry([version('1.0.1', Z101), version('1.0.0', A100)])], revoked });
    const base = baseTree({ revoked: rev });
    const r = await check('refuse', base, added(rev));
    assert.equal(r.code, 0, r.stdout + r.stderr);
    const v = await check('review', base, added(rev), ['--author', 'example-login']);
    assert.equal(v.code, 3, v.stdout + v.stderr);
    assert.match(v.stdout, /^FLAG revoked C15 dev\.example\.intel: /m);
    assert.equal(last(v.stdout), 'NEEDS REVIEW revoked');
    const same = await check('review', baseTree(), added(rev), ['--author', 'example-login']);
    assert.equal(last(same.stdout), 'NEEDS REVIEW revocation revoked', 'named on the head only: the pull request revokes 1.0.0 and adds 1.0.1');
    const lifted = await check('review', base, added([]), ['--author', 'example-login']);
    assert.equal(last(lifted.stdout), 'NEEDS REVIEW lift revoked', 'named on the base only: the pull request lifts it and adds 1.0.1');
    const all = [{ id: 'dev.example.intel', versions: '*', reason: 'Sends data to a third party.', date: today }];
    assert.equal(last((await check('review', baseTree({ revoked: all }), added(all), ['--author', 'example-login'])).stdout), 'NEEDS REVIEW revoked', 'every version revoked');
    const other = [{ id: 'dev.other.tool', versions: '*', reason: 'Sends data to a third party.', date: today }];
    const clean = await check('review', baseTree({ revoked: other }), added(other), ['--author', 'example-login']);
    assert.equal(clean.code, 0, clean.stdout + clean.stderr);
    assert.equal(last(clean.stdout), 'NO REVIEW NEEDED', 'a revocation of another id');
    const untouched = await check('review', base, baseTree({ revoked: rev }), ['--author', 'example-login']);
    assert.equal(last(untouched.stdout), 'NO REVIEW NEEDED', 'no added version');
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

  test('PR-multi-entry: more than one entry file changed (added, edited or removed) is flagged NEEDS REVIEW multi-entry', async () => {
    const A110 = pluginZip(manifest({ version: '1.1.0' }));
    const DUSK = themeZip();
    cacheArchive(cache, DUSK);
    const dusk = themeEntry([version('2.0.0', DUSK, {}, 'theme')]);
    const r = await check('review', baseTree(), head(A110), ['--author', 'example-login']);
    assert.equal(last(r.stdout), 'NO REVIEW NEEDED', 'one entry file');
    const two = tree({ entries: [pluginEntry([version('1.1.0', A110), version('1.0.0', A100)]), dusk] });
    const v = await check('review', baseTree(), two, ['--author', 'example-login']);
    assert.equal(v.code, 3, v.stdout + v.stderr);
    assert.match(v.stdout, /^FLAG multi-entry C13 2 entry files change: entries\/dev\.example\.dusk\.json, entries\/dev\.example\.intel\.json \(one entry file per pull request\)$/m);
    assert.equal(last(v.stdout), 'NEEDS REVIEW new multi-entry');
    const removed = await check('review', tree({ entries: [pluginEntry([version('1.0.0', A100)]), dusk] }), head(A110), ['--author', 'example-login']);
    assert.match(removed.stdout, /^FLAG multi-entry C13 2 entry files change: entries\/dev\.example\.dusk\.json, entries\/dev\.example\.intel\.json/m, 'a removed entry counts');
    const rev = [{ id: 'dev.example.intel', versions: ['1.0.0'], reason: 'Sends tokens to an unknown host.', date: today }];
    const withRev = await check('review', baseTree(), head(A110, { revoked: rev }), ['--author', 'example-login']);
    assert.doesNotMatch(withRev.stdout, /multi-entry/, 'revoked.json is not an entry file');
    const withDoc = await check('review', baseTree(), head(A110, { files: { 'docs/NOTE.md': 'x' } }), ['--author', 'example-login']);
    assert.equal(last(withDoc.stdout), 'NEEDS REVIEW maintenance', 'another path is maintenance, not an entry file');
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

describe('PR checks of check.mjs itself: C15 dates, C12, C14 on a removed entry', () => {
  const DAY = 86_400_000;
  const day = (offset) => new Date(Date.now() + offset * DAY).toISOString().slice(0, 10);
  const revocation = (date, reason = 'Sends tokens to an unknown host.') => [{ id: 'dev.example.intel', versions: ['1.0.0'], reason, date }];
  const revokedHead = (date, reason) => tree({ entries: [pluginEntry([version('1.0.0', A100)])], revoked: revocation(date, reason) });

  test('PR-c15-added-dated: an added revocation is dated today or yesterday (UTC); an older one is refused, an unchanged one is not', async () => {
    for (const d of [day(0), day(-1)]) {
      const r = await check('refuse', baseTree(), revokedHead(d));
      assert.equal(r.code, 0, r.stdout + r.stderr);
      assert.match(r.stdout, /^PASS C15 1 revocations: the host's rules, added ones dated today or yesterday \(UTC\)/m);
    }
    const old = day(-10);
    await refused(revokedHead(old), new RegExp(`^FAIL C15 dev\\.example\\.intel 1\\.0\\.0: an added revocation is dated today or yesterday \\(UTC\\), not ${old}$`, 'm'));
    const kept = await check('refuse', baseTree({ revoked: revocation(old) }), revokedHead(old));
    assert.equal(kept.code, 0, 'a revocation already on the base keeps its date');
    await refused(revokedHead(old, 'Another reason.'), /^FAIL C15 dev\.example\.intel 1\.0\.0: an added revocation/m, baseTree({ revoked: revocation(old) }));
  });

  test('PR-c15-future: a revocation dated in the future (UTC) is refused, in refuse and in publish; publish takes an older one', async () => {
    const soon = day(2);
    await refused(revokedHead(soon), new RegExp(`^FAIL C15 dev\\.example\\.intel 1\\.0\\.0: dated ${soon}, in the future \\(UTC\\)$`, 'm'));
    const p = await check('publish', baseTree(), revokedHead(soon), ['--target', 'test']);
    assert.equal(p.code, 1, p.stdout + p.stderr);
    assert.match(p.stdout, /^FAIL C15 dev\.example\.intel 1\.0\.0: dated .*, in the future \(UTC\)$/m);
    const older = await check('publish', baseTree(), revokedHead(day(-10)), ['--target', 'test']);
    assert.equal(older.code, 0, older.stdout + older.stderr);
    assert.match(older.stdout, /^PASS C15 1 revocations: the host's rules, none in the future \(UTC\)/m);
  });

  test('PR-c12-cli: check.mjs runs C12 on each added version with the cached archive, and a refusal of gh fails C12', async () => {
    const bin = path.join(T, 'gh-bin');
    fs.mkdirSync(bin);
    fs.writeFileSync(path.join(bin, 'gh'), `#!${process.execPath}
const fs = require('node:fs');
const e = process.env;
fs.appendFileSync(e.STUB_CALLS, JSON.stringify(process.argv.slice(2)) + '\\n');
process.stdout.write(fs.readFileSync(e.STUB_STDOUT));
process.exitCode = Number(e.STUB_EXIT || 0);
`, { mode: 0o755 });
    const A110 = pluginZip(manifest({ version: '1.1.0' }));
    const repo = 'example/intel', signer = `https://github.com/${repo}/.github/workflows/release.yml@refs/tags/v1.1.0`;
    const att = (digest) => [{ verificationResult: {
      signature: { certificate: { issuer: ISSUER, runnerEnvironment: 'github-hosted', sourceRepositoryURI: `https://github.com/${repo}`, subjectAlternativeName: signer, buildSignerURI: signer } },
      statement: { predicateType: PREDICATE, subject: [{ name: 'intel-1.1.0.zip', digest: { sha256: digest } }] },
    } }];
    const declared = { source: `https://github.com/${repo}`, provenance: { repo } };
    const base = tree({ entries: [pluginEntry([version('1.0.0', A100)], declared)] });
    const h = head(A110, { entry: declared });
    const go = async (stdout, exit = 0) => {
      const files = { out: path.join(T, `gh-out-${n++}`), calls: path.join(T, `gh-calls-${n++}`) };
      fs.writeFileSync(files.out, stdout);
      fs.writeFileSync(files.calls, '');
      const r = await run(SCRIPT, ['refuse', '--base', base, '--head', h, '--archive-cache', cache],
        { env: { PATH: `${bin}${path.delimiter}${process.env.PATH}`, STUB_STDOUT: files.out, STUB_CALLS: files.calls, STUB_EXIT: String(exit) } });
      return { ...r, calls: fs.readFileSync(files.calls, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l)) };
    };
    const ok = await go(JSON.stringify(att(sha(A110))));
    assert.equal(ok.code, 0, ok.stdout + ok.stderr);
    assert.match(ok.stdout, /^PASS C12 dev\.example\.intel 1\.1\.0: 1 attestation\(s\) bound to example\/intel$/m);
    assert.equal(ok.calls.length, 1, 'only the added version (1.0.0 is on the base)');
    assert.deepEqual(ok.calls[0].slice(-2), ['--', path.join(cache, `${sha(A110)}.zip`)]);
    const other = await go(JSON.stringify(att(sha(A100))));
    assert.match(other.stdout, /^FAIL C12 dev\.example\.intel 1\.1\.0: .*no subject has the archive SHA-256/m);
    const exit1 = await go('', 1);
    assert.equal(exit1.code, 1, exit1.stdout + exit1.stderr);
    assert.match(exit1.stdout, /^FAIL C12 dev\.example\.intel 1\.1\.0: .*gh attestation verify exited 1/m);
    const garbage = await go('not json');
    assert.match(garbage.stdout, /^FAIL C12 dev\.example\.intel 1\.1\.0: .*not one JSON value/m);
    const none = await check('refuse', baseTree(), head(A110));
    assert.doesNotMatch(none.stdout, /C12/, 'no provenance declared: no C12 line');
  });

  test('PR-identity-maintainers: a maintainer who adds a maintainer needs review identity', async () => {
    const r = await check('review', baseTree(), tree({ entries: [pluginEntry([version('1.0.0', A100)], { maintainers: ['example-login', 'new-login'] })] }), ['--author', 'example-login']);
    assert.equal(r.code, 3, r.stdout + r.stderr);
    assert.match(r.stdout, /^FLAG identity C10 C14 dev\.example\.intel: .*the maintainers changed/m);
    assert.equal(last(r.stdout), 'NEEDS REVIEW identity');
  });

  test('PR-c14-removed: removing an entry is flagged identity unless the author is one of its maintainers (any case)', async () => {
    const DUSK = themeZip();
    cacheArchive(cache, DUSK);
    const base = tree({ entries: [pluginEntry([version('1.0.0', A100)]), themeEntry([version('2.0.0', DUSK, {}, 'theme')], { maintainers: ['dusk-owner'] })] });
    const h = baseTree();
    const r = await check('review', base, h, ['--author', 'mallory']);
    assert.equal(r.code, 3, r.stdout + r.stderr);
    assert.match(r.stdout, /^FLAG identity C14 dev\.example\.dusk: the entry is removed by a login that is not one of its maintainers$/m);
    assert.doesNotMatch(r.stdout, /dev\.example\.intel: /, 'the entry left as it was is not flagged');
    const own = await check('review', base, h, ['--author', 'DUSK-OWNER']);
    assert.equal(own.code, 0, own.stdout + own.stderr);
    assert.equal(last(own.stdout), 'NO REVIEW NEEDED');
    const noAuthor = await check('review', base, h);
    assert.doesNotMatch(noAuthor.stdout, /C14 dev\.example\.dusk/);
  });

  // POLICY.md: the EVE-Cyno name or author is reserved for entries marked firstParty, which only the project merges.
  test('PR-first-party-author: a new first-party entry authored EVE-Cyno passes refuse and needs review new first-party', async () => {
    // The head adds one entry beside the base's; `firstParty: undefined` leaves the key out of the file (JSON.stringify).
    const project = (id, extra = {}) => {
      const author = extra.author ?? 'EVE-Cyno';
      const bytes = pluginZip(manifest({ id, name: 'Mining Ledger', author, version: '0.2.0' }));
      cacheArchive(cache, bytes);
      const e = pluginEntry([version('0.2.0', bytes)], { id, name: 'Mining Ledger', author, firstParty: true, source: null, ...extra });
      if (!('maintainers' in extra)) delete e.maintainers;
      return tree({ entries: [pluginEntry([version('1.0.0', A100)]), e] });
    };
    const ok = project('dev.evecyno.miningledger');
    const r = await check('refuse', baseTree(), ok);
    assert.equal(r.code, 0, r.stdout + r.stderr);
    assert.doesNotMatch(r.stdout, /^FAIL /m);
    assert.equal(last(r.stdout), 'CHECKS PASSED');
    const v = await check('review', baseTree(), ok, ['--author', 'example-login']);
    assert.equal(v.code, 3, v.stdout + v.stderr);
    assert.match(v.stdout, /^FLAG first-party C3 dev\.evecyno\.miningledger: the entry is first-party on the base or the head and the pull request changes it \(firstParty set or dropped included\)$/m);
    assert.equal(last(v.stdout), 'NEEDS REVIEW new first-party');

    // Without firstParty the id prefix is refused first (C2 leaves the entry out of C3); under another id the author is refused (C3).
    const unset = await check('refuse', baseTree(), project('dev.evecyno.miningledger', { firstParty: undefined }));
    assert.equal(unset.code, 1, unset.stdout + unset.stderr);
    assert.match(unset.stdout, /^FAIL C2 entries\/dev\.evecyno\.miningledger\.json: the id prefix dev\.evecyno\. is reserved for first-party entries$/m);
    const elsewhere = await check('refuse', baseTree(), project('dev.example.ledger', { firstParty: undefined }));
    assert.equal(elsewhere.code, 1, elsewhere.stdout + elsewhere.stderr);
    assert.match(elsewhere.stdout, /^FAIL C3 name or author of dev\.example\.ledger is reserved or not allowed$/m);
    const prefix = await check('refuse', baseTree(), project('dev.evecyno.tools', { firstParty: undefined, author: 'Example Author', maintainers: ['example-login'] }));
    assert.equal(prefix.code, 1, prefix.stdout + prefix.stderr);
    assert.match(prefix.stdout, /^FAIL C2 entries\/dev\.evecyno\.tools\.json: the id prefix dev\.evecyno\. is reserved for first-party entries$/m, 'a third party under the project\'s prefix');
    assert.doesNotMatch(prefix.stdout, /^FAIL C3 /m);
    const third = await check('refuse', baseTree(), project('dev.example.tools', { firstParty: undefined, author: 'EVE-Cyno Tools', maintainers: ['example-login'] }));
    assert.equal(third.code, 1, third.stdout + third.stderr);
    assert.match(third.stdout, /^FAIL C3 name or author of dev\.example\.tools is reserved or not allowed$/m, 'a third party');
    const listed = await check('refuse', baseTree(), project('dev.evecyno.miningledger', { maintainers: ['example-login'] }));
    assert.equal(listed.code, 1, listed.stdout + listed.stderr);
    assert.match(listed.stdout, /^FAIL C3 first-party entry dev\.evecyno\.miningledger lists maintainers$/m);
    const host = await check('refuse', baseTree(), project('eve-cyno.host.miningledger'));
    assert.equal(host.code, 1, host.stdout + host.stderr);
    assert.match(host.stdout, /^FAIL C2 .*the id prefix eve-cyno\.host\. is reserved for the host/m);
  });

  test('PR-first-party-change: any change to a first-party entry needs review first-party, whoever opens it; an untouched one needs none', async () => {
    const bytes = pluginZip(manifest({ id: 'dev.evecyno.miningledger', name: 'Mining Ledger', author: 'EVE-Cyno', version: '0.2.0' }));
    cacheArchive(cache, bytes);
    const ledger = (extra = {}) => {
      const e = pluginEntry([version('0.2.0', bytes)], { id: 'dev.evecyno.miningledger', name: 'Mining Ledger', author: 'EVE-Cyno', firstParty: true, source: null, ...extra });
      delete e.maintainers;
      return e;
    };
    const withLedger = (l) => tree({ entries: [pluginEntry([version('1.0.0', A100)]), l] });
    const base = withLedger(ledger());
    const edited = withLedger(ledger({ description: 'Edited by a third party.' }));
    const r = await check('refuse', base, edited);
    assert.equal(r.code, 0, r.stdout + r.stderr);
    const v = await check('review', base, edited, ['--author', 'example-login']);
    assert.equal(v.code, 3, v.stdout + v.stderr);
    assert.match(v.stdout, /^FLAG first-party C3 dev\.evecyno\.miningledger: /m);
    assert.equal(last(v.stdout), 'NEEDS REVIEW identity first-party');
    const same = await check('review', base, withLedger(ledger()), ['--author', 'example-login']);
    assert.equal(same.code, 0, same.stdout + same.stderr);
    assert.equal(last(same.stdout), 'NO REVIEW NEEDED');
  });

  test('PR-first-party-catalog: publish against a catalog base flags no untouched first-party entry; a firstParty flip still flags', async () => {
    const bytes = pluginZip(manifest({ id: 'dev.evecyno.miningledger', name: 'Mining Ledger', author: 'EVE-Cyno', version: '0.2.0' }));
    cacheArchive(cache, bytes);
    const ledger = pluginEntry([version('0.2.0', bytes)], { id: 'dev.evecyno.miningledger', name: 'Mining Ledger', author: 'EVE-Cyno', firstParty: true, source: null });
    delete ledger.maintainers;
    const intel = pluginEntry([version('1.0.0', A100)]);
    const r = await check('publish', catalogBase([intel, ledger]), tree({ entries: [intel, ledger] }), ['--target', 'test']);
    assert.equal(r.code, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /^NOTE base: the live catalog \(2 listings\)$/m, 'the base is read as a catalog');
    assert.doesNotMatch(r.stdout, /^FLAG first-party /m, 'a catalog holds less than an entry: an untouched first-party entry is no change');
    assert.equal(last(r.stdout), 'CHECKS PASSED');

    // A flip is a change a catalog does show: set (the base listing is not first-party) and dropped (the head entry is not).
    const own = { ...intel, firstParty: true };
    delete own.maintainers;
    const set = await check('publish', catalogBase([intel]), tree({ entries: [own] }), ['--target', 'test']);
    assert.equal(set.code, 0, set.stdout + set.stderr);
    assert.match(set.stdout, /^FLAG first-party C3 dev\.example\.intel: /m, 'firstParty set against a catalog base');
    const dropped = await check('publish', catalogBase([own]), tree({ entries: [intel] }), ['--target', 'test']);
    assert.equal(dropped.code, 0, dropped.stdout + dropped.stderr);
    assert.match(dropped.stdout, /^FLAG first-party C3 dev\.example\.intel: /m, 'firstParty dropped against a catalog base');
    const added = await check('publish', catalogBase([intel]), tree({ entries: [intel, ledger] }), ['--target', 'test']);
    assert.equal(added.code, 0, added.stdout + added.stderr);
    assert.match(added.stdout, /^FLAG first-party C3 dev\.evecyno\.miningledger: /m, 'a first-party entry the catalog does not hold');
  });

  test('PR-first-party-catalog-unlisted: publish flags first-party and new on a first-party entry the catalog leaves out that adds a listed version', async () => {
    const id = 'dev.evecyno.miningledger';
    const at = (v) => pluginZip(manifest({ id, name: 'Mining Ledger', author: 'EVE-Cyno', version: v }));
    const A010 = at('0.1.0'), A020 = at('0.2.0');
    cacheArchive(cache, A010);
    cacheArchive(cache, A020);
    const ledger = (versions) => {
      const e = pluginEntry(versions, { id, name: 'Mining Ledger', author: 'EVE-Cyno', firstParty: true, source: null });
      delete e.maintainers;
      return e;
    };
    const intel = pluginEntry([version('1.0.0', A100)]);
    // A catalog leaves out an entry with no listed, unrevoked version left (entries.mjs), so check.mjs stands the head's own merged
    // 0.1.0 in for the base entry (liveBase): both sides then hold the same firstParty, yet the catalog holds no listing of the id.
    const unlisted = await check('publish', catalogBase([intel]), tree({ entries: [intel, ledger([version('0.2.0', A020), version('0.1.0', A010, { unlisted: true })])] }), ['--target', 'test']);
    assert.equal(unlisted.code, 0, unlisted.stdout + unlisted.stderr);
    assert.match(unlisted.stdout, /^NOTE base: the live catalog \(1 listings\)$/m, 'the base is read as a catalog');
    assert.match(unlisted.stdout, /^FLAG first-party C3 dev\.evecyno\.miningledger: /m, 'its only version unlisted: new to the catalog');
    assert.match(unlisted.stdout, /^FLAG new C11 dev\.evecyno\.miningledger: /m, 'its only version unlisted: new to the catalog');
    assert.equal(last(unlisted.stdout), 'CHECKS PASSED');

    const rev = [{ id, versions: ['0.1.0'], reason: 'Sends data to a third party.', date: today }];
    const revoked = await check('publish', catalogBase([intel], rev), tree({ entries: [intel, ledger([version('0.2.0', A020), version('0.1.0', A010)])], revoked: rev }), ['--target', 'test']);
    assert.equal(revoked.code, 0, revoked.stdout + revoked.stderr);
    assert.match(revoked.stdout, /^FLAG first-party C3 dev\.evecyno\.miningledger: /m, 'its only version revoked: new to the catalog');
    assert.match(revoked.stdout, /^FLAG new C11 dev\.evecyno\.miningledger: /m, 'its only version revoked: new to the catalog');
    assert.equal(last(revoked.stdout), 'CHECKS PASSED');

    // The same entries as merged (no version added): the next catalog leaves them out too, so nothing is new and nothing changed.
    for (const [why, base, h] of [
      ['unlisted', catalogBase([intel]), tree({ entries: [intel, ledger([version('0.1.0', A010, { unlisted: true })])] })],
      ['revoked', catalogBase([intel], rev), tree({ entries: [intel, ledger([version('0.1.0', A010)])], revoked: rev })],
    ]) {
      const r = await check('publish', base, h, ['--target', 'test']);
      assert.equal(r.code, 0, r.stdout + r.stderr);
      assert.doesNotMatch(r.stdout, /^FLAG /m, `its only version ${why}, none added: no review class`);
      assert.equal(last(r.stdout), 'CHECKS PASSED');
    }
  });

  test('PR-first-party-catalog-review: review against a catalog base, and publish against a tree base, flag a first-party entry changed without a flip', async () => {
    const bytes = pluginZip(manifest({ id: 'dev.evecyno.miningledger', name: 'Mining Ledger', author: 'EVE-Cyno', version: '0.2.0' }));
    cacheArchive(cache, bytes);
    const ledger = pluginEntry([version('0.2.0', bytes)], { id: 'dev.evecyno.miningledger', name: 'Mining Ledger', author: 'EVE-Cyno', firstParty: true, source: null });
    delete ledger.maintainers;
    const intel = pluginEntry([version('1.0.0', A100)]);
    const edited = tree({ entries: [intel, { ...ledger, summary: 'Ledger of mined ore' }] });
    // A hand-run review: no review read this change before, so the filter that publish applies against a catalog does not apply.
    const v = await check('review', catalogBase([intel, ledger]), edited);
    assert.equal(v.code, 3, v.stdout + v.stderr);
    assert.match(v.stdout, /^NOTE C13: the base is a catalog, not a tree: no scope check$/m, 'review reads the catalog base');
    assert.match(v.stdout, /^FLAG first-party C3 dev\.evecyno\.miningledger: /m, 'a non-flip change to a first-party entry is read');
    assert.match(last(v.stdout), /^NEEDS REVIEW .*first-party/);

    // A tree base holds the whole entry, so publish against one shows the change as it is: the filter is for a catalog base only.
    const p = await check('publish', tree({ entries: [intel, ledger] }), edited, ['--target', 'test']);
    assert.equal(p.code, 0, p.stdout + p.stderr);
    assert.match(p.stdout, /^FLAG first-party C3 dev\.evecyno\.miningledger: /m, 'publish against a tree base');
    assert.equal(last(p.stdout), 'CHECKS PASSED');
  });

  test('PR-escalation-first-party-chatlogs: the first-party Intel entry whose new archive adds chatlogs is flagged escalation against a tree and a catalog base', async () => {
    // The vendored firstpartyallow.js exemption: the official first-party install of dev.evecyno.intel keeps chatlogs although it can send
    // data out, so the app asks for them again. C10 reads the permissions from the archives and firstParty from the entries.
    const firstParty = (id) => {
      const perms = (logs) => ({ characters: 'selected', network: ['https://api.example.com'], logs });
      const at = (v, logs) => {
        const bytes = pluginZip(manifest({ id, name: 'Intel', author: 'EVE-Cyno', version: v, permissions: perms(logs) }));
        cacheArchive(cache, bytes);
        return version(v, bytes, { permissions: perms(logs) });
      };
      const entry = (versions) => {
        const e = pluginEntry(versions, { id, name: 'Intel', author: 'EVE-Cyno', firstParty: true, source: null });
        delete e.maintainers;
        return e;
      };
      const v100 = at('1.0.0', ['gamelogs']), v110 = at('1.1.0', ['gamelogs', 'chatlogs']);
      return { base: entry([v100]), head: tree({ entries: [entry([v110, v100])] }) };
    };
    const intel = firstParty('dev.evecyno.intel');
    const t = await check('review', tree({ entries: [intel.base] }), intel.head);
    assert.equal(t.code, 3, t.stdout + t.stderr);
    assert.match(t.stdout, /^FLAG escalation C10 dev\.evecyno\.intel: /m, 'against a tree base');
    assert.match(last(t.stdout), /^NEEDS REVIEW .*escalation/);
    const c = await check('publish', catalogBase([intel.base]), intel.head, ['--target', 'test']);
    assert.equal(c.code, 0, c.stdout + c.stderr);
    assert.match(c.stdout, /^NOTE base: the live catalog \(1 listings\)$/m, 'the base is read as a catalog');
    assert.match(c.stdout, /^FLAG escalation C10 dev\.evecyno\.intel: /m, 'against a catalog base');
    assert.equal(last(c.stdout), 'CHECKS PASSED');

    // The same entry and archives under an id not on FIRST_PARTY_ALLOWLIST: HT-M1 drops chatlogs from both sides, nothing new is asked.
    const other = firstParty('dev.evecyno.map');
    const o = await check('review', tree({ entries: [other.base] }), other.head);
    assert.equal(o.code, 3, o.stdout + o.stderr);
    assert.doesNotMatch(o.stdout, /^FLAG escalation /m, 'another first-party id');
    assert.equal(last(o.stdout), 'NEEDS REVIEW first-party');
  });
});

// plan dp4 W1 (API 1.30.0): R1 flags every added version whose archive's plugin.json sets `wasm: true` (class `wasm`, owner answer
// OQ-3 (a)), the reason naming its ways out; R4 (C18) refuses the dogma module package outside a first-party entry.
describe('PR fixture suite: WebAssembly (R1, R4)', () => {
  const W = '^1.30.0';
  const SEALED = Object.freeze({ characters: 'selected' });
  /** A head adding 1.1.0 whose archive is `m` (engines ^1.30.0); the entry pins the manifest's permissions. */
  const wasmHead = (perms, over = {}, extra = []) => head(pluginZip(manifest({ version: '1.1.0', engines: { 'eve-cyno-api': W }, permissions: perms, wasm: true, ...over }), extra), { pin: { engines: W, permissions: perms } });
  const review = async (h, base = baseTree()) => {
    assert.equal((await check('refuse', base, h)).code, 0, 'a valid archive: refuse passes, review decides');
    const r = await check('review', base, h, ['--author', 'example-login']);
    assert.equal(r.code, 3, r.stdout + r.stderr);
    return r;
  };
  const FLAG = /^FLAG wasm C10 dev\.example\.intel 1\.1\.0: its plugin\.json sets wasm: true \(it may compile and run WebAssembly\); (.*)$/m;

  test('PR-wasm-sealed: a wasm version with no way out is flagged wasm, "no way out"', async () => {
    const r = await review(wasmHead(SEALED));
    assert.equal(r.stdout.match(FLAG)?.[1], 'no way out', r.stdout);
    assert.equal(last(r.stdout), 'NEEDS REVIEW wasm');
  });

  test('PR-wasm-ways: required network, optional network, a consumed service and ai are each named', async () => {
    const cases = [
      [PERMS, 'ways out: required network https://api.example.com'],
      [{ characters: 'selected', optional: { network: ['https://opt.example.com'] } }, 'ways out: optional network https://opt.example.com'],
      [{ characters: 'selected', services: { 'evecyno.map': '^1' } }, 'ways out: consumed service evecyno.map'],
      [{ characters: 'selected', ai: true }, 'ways out: ai'],
    ];
    for (const [perms, want] of cases) {
      const r = await review(wasmHead(perms));
      assert.equal(r.stdout.match(FLAG)?.[1], want, r.stdout);
      assert.match(last(r.stdout), /^NEEDS REVIEW (escalation )?wasm$/);
    }
  });

  test('PR-wasm-false: wasm false sets no flag', async () => {
    const r = await check('review', baseTree(), wasmHead(SEALED, { wasm: false }), ['--author', 'example-login']);
    assert.equal(r.code, 0, r.stdout + r.stderr);
    assert.equal(last(r.stdout), 'NO REVIEW NEEDED');
  });

  test('PR-wasm-duplicate-key: plugin.json is read as the host reads it, the last of a repeated key wins', async () => {
    const text = (first, lastValue) => `{"wasm": ${first}, ${JSON.stringify(manifest({ version: '1.1.0', engines: { 'eve-cyno-api': W }, permissions: SEALED })).slice(1, -1)}, "wasm": ${lastValue}}`;
    const dup = (first, lastValue) => zip([{ name: 'plugin.json', data: text(first, lastValue) }, { name: 'index.html', data: '<!doctype html><title>Intel</title>' }]);
    const on = await review(head(dup(false, true), { pin: { engines: W, permissions: SEALED } }));
    assert.equal(on.stdout.match(FLAG)?.[1], 'no way out', '"wasm": false, ..., "wasm": true cannot slip past R1');
    const off = await check('review', baseTree(), head(dup(true, false), { pin: { engines: W, permissions: SEALED } }), ['--author', 'example-login']);
    assert.equal(off.code, 0, 'the host reads false there too: no WebAssembly, no flag');
  });

  test('PR-wasm-publish-listed: publish against the live catalog flags no listed wasm version again, only an added one', async () => {
    const A110 = pluginZip(manifest({ version: '1.1.0', engines: { 'eve-cyno-api': W }, permissions: SEALED, wasm: true }));
    const A120 = pluginZip(manifest({ version: '1.2.0', engines: { 'eve-cyno-api': W }, permissions: SEALED, wasm: true }));
    cacheArchive(cache, A110);
    cacheArchive(cache, A120);
    const v110 = version('1.1.0', A110, { engines: W, permissions: SEALED });
    const listed = pluginEntry([v110, version('1.0.0', A100)]);
    const same = await check('publish', catalogBase([listed]), tree({ entries: [listed] }), ['--target', 'test']);
    assert.equal(same.code, 0, same.stdout + same.stderr);
    assert.doesNotMatch(same.stdout, /^FLAG wasm /m, 'a listed wasm version is not flagged again');
    const added = await check('publish', catalogBase([listed]), tree({ entries: [pluginEntry([version('1.2.0', A120, { engines: W, permissions: SEALED }), v110, version('1.0.0', A100)])] }), ['--target', 'test']);
    assert.equal(added.code, 0, added.stdout + added.stderr);
    assert.deepEqual(linesOf(added.stdout, 'FLAG wasm').map((l) => l.split(':')[0]), ['FLAG wasm C10 dev.example.intel 1.2.0']);
  });

  test('PR-wasm-engines: a wasm manifest whose engines admit a host below 1.30.0 is refused at C7', async () => {
    // A host below API 1.30.0 refuses the key itself (schema: unknown key), so the host requires a range that leaves every such host out.
    // Against the vendored host of 1.29.0 (before this re-vendor) every wasm manifest was refused at C7: `//wasm: unknown key`.
    const bad = head(pluginZip(manifest({ version: '1.1.0', engines: { 'eve-cyno-api': '^1.29.0' }, permissions: SEALED, wasm: true })), { pin: { engines: '^1.29.0', permissions: SEALED } });
    await refused(bad, /^FAIL C7 dev\.example\.intel 1\.1\.0: .*wasm needs engines\.eve-cyno-api/m);
  });

  const DOGMA = { name: 'vendor/dogma-wasm/MANIFEST.json', data: JSON.stringify({ package: '@eve-cyno/dogma-wasm', module: 'dogma.wasm' }) };
  test('PR-dogma-third-party: the dogma module package in an entry that is not first-party is refused at C18', async () => {
    await refused(wasmHead(SEALED, {}, [DOGMA]), /^FAIL C18 dev\.example\.intel 1\.1\.0: it holds the @eve-cyno\/dogma-wasm package \(vendor\/dogma-wasm\/MANIFEST\.json\), which only a first-party entry may ship$/m);
    // A repeated key (the last wins, as JSON.parse reads it) and another letter case of the file name are no way past it.
    const twice = { name: 'lib/manifest.JSON', data: '{"package": "@eve-cyno/dogma-wasm", "package": "x"}' };
    await refused(wasmHead(SEALED, {}, [twice]), /^FAIL C18 dev\.example\.intel 1\.1\.0: it holds the @eve-cyno\/dogma-wasm package \(lib\/manifest\.JSON\)/m);
    // The name spelled with a JSON escape: the text holds no literal match, JSON.parse reads the package name.
    const escaped = { name: 'MANIFEST.json', data: '{"package": "\\u0040eve-cyno/dogma-wasm"}' };
    assert.ok(!escaped.data.includes('@eve-cyno/dogma-wasm'));
    await refused(wasmHead(SEALED, {}, [escaped]), /^FAIL C18 dev\.example\.intel 1\.1\.0: it holds the @eve-cyno\/dogma-wasm package \(MANIFEST\.json\)/m);
    // Another package's MANIFEST.json is no refusal.
    const other = await check('refuse', baseTree(), wasmHead(SEALED, {}, [{ name: 'vendor/x/MANIFEST.json', data: '{"package":"@example/other"}' }]));
    assert.equal(other.code, 0, other.stdout + other.stderr);
    assert.doesNotMatch(other.stdout, /C18/);
  });

  test('PR-dogma-first-party: the dogma module package in a first-party entry passes C18', async () => {
    const id = 'dev.evecyno.fitoracle';
    const bytes = pluginZip(manifest({ id, name: 'Fit Oracle', author: 'EVE-Cyno', version: '0.1.0', engines: { 'eve-cyno-api': W }, permissions: SEALED, wasm: true }), [DOGMA]);
    cacheArchive(cache, bytes);
    const e = pluginEntry([version('0.1.0', bytes, { engines: W, permissions: SEALED })], { id, name: 'Fit Oracle', author: 'EVE-Cyno', firstParty: true, source: null });
    delete e.maintainers;
    const h = tree({ entries: [pluginEntry([version('1.0.0', A100)]), e] });
    const r = await check('refuse', baseTree(), h);
    assert.equal(r.code, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /^PASS C18 dev\.evecyno\.fitoracle 0\.1\.0: the @eve-cyno\/dogma-wasm package in a first-party entry$/m);
    assert.equal(last(r.stdout), 'CHECKS PASSED');
    const v = await check('review', baseTree(), h, ['--author', 'example-login']);
    assert.match(v.stdout, /^FLAG wasm C10 dev\.evecyno\.fitoracle 0\.1\.0: .*; no way out$/m);
    assert.equal(last(v.stdout), 'NEEDS REVIEW new first-party wasm');
  });
});
