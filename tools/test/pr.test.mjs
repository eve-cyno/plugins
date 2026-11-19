// PR-*: the fixture pull-request suite (plan task 1.10). Each test builds a base tree and a head tree, caches the archives the head
// pins (so the download check C4 never connects: every archive URL is https://127.0.0.1/..., an address C4 refuses before it
// connects), runs tools/check.mjs as check.yml does (`refuse`, then `review`) and reads its verdict line and exit code.
// A refusal test names the check that refuses; a review test names the class. The first test shows that the same trees without a
// fault pass both modes, so no refusal below comes from the fixture itself. No network, no key, no secret.
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, cacheArchive, cleanup, manifest, pluginEntry, pluginZip, run, sha, tempDir, themeEntry, themeZip, version, writeTree } from './trees.mjs';
import { ISSUER, PREDICATE } from '../lib/provenance.mjs';
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
});
