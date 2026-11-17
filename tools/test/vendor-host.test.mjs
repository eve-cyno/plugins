// Tests of tools/vendor-host.mjs. --verify runs on a copy of this repository's own vendored tree, tampered one way per case, so each
// failing case proves that its check sees exactly that change. The closure walker runs on a small tree made in the test.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { after, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { closureOf, scriptClosureOf, releaseLibRoots } from '../vendor-host.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const TOOL = path.join(ROOT, 'tools', 'vendor-host.mjs');
const VENDOR = 'vendor/eve-cyno-host';

const temps = [];
after(() => { for (const t of temps) fs.rmSync(t, { recursive: true, force: true }); });
const tempDir = () => { const t = fs.mkdtempSync(path.join(os.tmpdir(), 'vd-test-')); temps.push(t); return t; };

/** A copy of the parts of this repository that --verify reads: package.json, package-lock.json and the vendored tree. */
function copyRoot() {
  const t = tempDir();
  for (const f of ['package.json', 'package-lock.json']) fs.copyFileSync(path.join(ROOT, f), path.join(t, f));
  fs.cpSync(path.join(ROOT, VENDOR), path.join(t, VENDOR), { recursive: true });
  return t;
}
const verify = (root) => spawnSync(process.execPath, [TOOL, '--verify', '--root', root], { encoding: 'utf8' });
const sha256 = (b) => crypto.createHash('sha256').update(b).digest('hex');
const manifestOf = (root) => JSON.parse(fs.readFileSync(path.join(root, VENDOR, 'MANIFEST.json'), 'utf8'));
/** Rewrites one vendored file and its MANIFEST entry, the way a hand edit that also "fixes" the hash would. */
function rewriteConsistently(root, rel, edit) {
  const file = path.join(root, VENDOR, rel);
  const next = edit(fs.readFileSync(file, 'utf8'));
  assert.notEqual(next, fs.readFileSync(file, 'utf8'), `the tamper of ${rel} changed nothing`);
  fs.writeFileSync(file, next);
  const m = manifestOf(root);
  m.files[rel].sha256 = sha256(Buffer.from(next));
  m.files[rel].size = Buffer.byteLength(next);
  fs.writeFileSync(path.join(root, VENDOR, 'MANIFEST.json'), JSON.stringify(m, null, 2) + '\n');
}
const assertFails = (r, re) => {
  assert.equal(r.status, 1, `exit ${r.status}\nstdout:\n${r.stdout}\nstderr:\n${r.stderr}`);
  assert.match(r.stderr, re);
  assert.doesNotMatch(r.stdout, /^PASS/m);
};

describe('vendor-host --verify', () => {
  test('VD-clean: the committed vendored tree verifies, in place and as a copy', () => {
    const inPlace = spawnSync(process.execPath, [TOOL, '--verify'], { encoding: 'utf8' });
    assert.equal(inPlace.status, 0, inPlace.stderr);
    assert.match(inPlace.stdout, /^PASS vendor\/eve-cyno-host: \d+ files match MANIFEST\.json \(desktop [0-9a-f]{12}, host API \d+\.\d+\.\d+\)$/m);
    const copy = verify(copyRoot());
    assert.equal(copy.status, 0, copy.stderr);
    assert.equal(copy.stderr, '');
  });

  test('VD-hash: one changed byte in a vendored file fails', () => {
    const t = copyRoot();
    const f = path.join(t, VENDOR, 'host/dist/minisign.js');
    const b = fs.readFileSync(f);
    b[b.length - 2] ^= 0x01;
    fs.writeFileSync(f, b);
    assertFails(verify(t), /^FAIL hash host\/dist\/minisign\.js: sha256 [0-9a-f]{64}, MANIFEST\.json [0-9a-f]{64}$/m);
  });

  test('VD-hash: a changed MANIFEST.json hash fails too', () => {
    const t = copyRoot();
    const m = manifestOf(t);
    m.files['host/dist/trustkeys.js'].sha256 = '0'.repeat(64);
    fs.writeFileSync(path.join(t, VENDOR, 'MANIFEST.json'), JSON.stringify(m, null, 2) + '\n');
    assertFails(verify(t), /^FAIL hash host\/dist\/trustkeys\.js/m);
  });

  test('VD-extra-file: a file MANIFEST.json does not name fails, at any depth', () => {
    const t = copyRoot();
    fs.writeFileSync(path.join(t, VENDOR, 'host/dist/market/extra.js'), 'module.exports = {};\n');
    fs.writeFileSync(path.join(t, VENDOR, 'EXTRA.md'), 'x\n');
    const r = verify(t);
    assertFails(r, /^FAIL extra host\/dist\/market\/extra\.js$/m);
    assert.match(r.stderr, /^FAIL extra EXTRA\.md$/m);
  });

  test('VD-extra-file: a symlink or other non-regular entry fails', () => {
    const t = copyRoot();
    const f = path.join(t, VENDOR, 'host/dist/minisign.js');
    const keep = path.join(tempDir(), 'minisign.js');
    fs.renameSync(f, keep);
    fs.symlinkSync(keep, f);
    assertFails(verify(t), /^FAIL not-regular host\/dist\/minisign\.js$/m);
  });

  test('VD-missing-file: a file MANIFEST.json names but the tree lacks fails', () => {
    const t = copyRoot();
    fs.rmSync(path.join(t, VENDOR, 'host/dist/market/zipread.js'));
    assertFails(verify(t), /^FAIL missing host\/dist\/market\/zipread\.js$/m);
  });

  test('VD-missing-file: a missing or malformed MANIFEST.json fails', () => {
    const t = copyRoot();
    const m = manifestOf(t);
    m.files['../outside.js'] = { sha256: '0'.repeat(64), size: 1, origin: 'tree' };
    fs.writeFileSync(path.join(t, VENDOR, 'MANIFEST.json'), JSON.stringify(m, null, 2) + '\n');
    assertFails(verify(t), /^FAIL manifest vendor\/eve-cyno-host\/MANIFEST\.json has a bad entry "\.\.\/outside\.js"$/m);
    fs.writeFileSync(path.join(t, VENDOR, 'MANIFEST.json'), JSON.stringify({ ...manifestOf(copyRoot()), schema: 2 }, null, 2) + '\n');
    assertFails(verify(t), /^FAIL manifest vendor\/eve-cyno-host\/MANIFEST\.json is not a schema 1 manifest$/m);
    fs.rmSync(path.join(t, VENDOR, 'MANIFEST.json'));
    assertFails(verify(t), /^FAIL manifest vendor\/eve-cyno-host\/MANIFEST\.json cannot be read \(ENOENT\)$/m);
  });

  test('VD-dep-version: package.json must pin ajv and semver exactly as the host does', () => {
    for (const [name, value] of [['ajv', '8.20.1'], ['ajv', '^8.20.0'], ['semver', '7.8.4']]) {
      const t = copyRoot();
      const p = JSON.parse(fs.readFileSync(path.join(t, 'package.json'), 'utf8'));
      p.dependencies[name] = value;
      fs.writeFileSync(path.join(t, 'package.json'), JSON.stringify(p, null, 2) + '\n');
      assertFails(verify(t), new RegExp(`^FAIL dependency ${name}: package\\.json `, 'm'));
    }
  });

  test('VD-dep-version: package-lock.json must hold the host\'s version and integrity', () => {
    for (const field of ['version', 'integrity']) {
      const t = copyRoot();
      const l = JSON.parse(fs.readFileSync(path.join(t, 'package-lock.json'), 'utf8'));
      l.packages['node_modules/semver'][field] = field === 'version' ? '7.8.6' : 'sha512-AAAA';
      fs.writeFileSync(path.join(t, 'package-lock.json'), JSON.stringify(l, null, 2) + '\n');
      assertFails(verify(t), new RegExp(`^FAIL dependency semver: package-lock\\.json ${field} `, 'm'));
    }
  });

  test('VD-keys-equal: an index key changed in a .pub file (MANIFEST.json updated with it) fails', () => {
    const t = copyRoot();
    const other = 'RWQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
    rewriteConsistently(t, 'host/src/keys/index-standby.pub', s => s.replace(/^RW[A-Za-z0-9+/=]+$/m, other));
    assertFails(verify(t), /^FAIL keys host\/dist\/trustkeys\.js PRODUCT_KEYS\.index /m);
  });

  test('VD-keys-equal: swapped primary and standby in trustkeys.js (MANIFEST.json updated with it) fails', () => {
    const t = copyRoot();
    rewriteConsistently(t, 'host/dist/trustkeys.js', s => {
      const m = s.match(/index: \[\s*'([^']+)',[^\n]*\n\s*'([^']+)'/);
      assert.ok(m, 'the index keys in trustkeys.js');
      return s.replace(m[1], '@@').replace(m[2], m[1]).replace('@@', m[2]);
    });
    assertFails(verify(t), /^FAIL keys host\/dist\/trustkeys\.js PRODUCT_KEYS\.index /m);
  });

  test('VD-keys-equal: a test build of buildinfo.js (MANIFEST.json updated with it) fails, one field at a time', () => {
    const key = '["RWQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"]';
    for (const [from, to] of [['exports.TEST_BUILD = false;', 'exports.TEST_BUILD = true;'],
      ['exports.TEST_INDEX_KEYS = [];', `exports.TEST_INDEX_KEYS = ${key};`],
      ['exports.TEST_RELEASE_KEYS = [];', `exports.TEST_RELEASE_KEYS = ${key};`]]) {
      const t = copyRoot();
      rewriteConsistently(t, 'host/dist/buildinfo.js', s => s.replace(from, to));
      assertFails(verify(t), /^FAIL keys host\/dist\/buildinfo\.js is not a product build/m);
    }
  });
});

describe('vendor-host closure walk', () => {
  /** A tiny built tree: host/dist with CommonJS requires, a JSON file and the release-lib shape. */
  function tree(files) {
    const t = tempDir();
    for (const [rel, body] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(path.join(t, rel)), { recursive: true });
      fs.writeFileSync(path.join(t, rel), body);
    }
    return t;
  }

  test('VD-closure: relative requires, JSON, index.js, built-ins and the allowed packages', () => {
    const t = tree({
      'host/dist/a.js': '"use strict";\nconst b = require("./b");\nconst s = require("./schemas/s.json");\nconst c = require("./c");\nconst fs = require("node:fs");\nconst z = require("zlib");\nconst A = __importDefault(require("ajv/dist/2020"));\n// a comment that says require() does nothing\n',
      'host/dist/b.js': 'const a = require("./a");\nconst semver = require("semver");\n',
      'host/dist/c/index.js': 'module.exports = {};\n',
      'host/dist/schemas/s.json': '{}\n',
      'host/dist/unused.js': 'module.exports = {};\n',
    });
    const c = closureOf(t, ['host/dist/a.js']);
    assert.deepEqual(c.files, ['host/dist/a.js', 'host/dist/b.js', 'host/dist/c/index.js', 'host/dist/schemas/s.json']);
    assert.deepEqual(c.packages, ['ajv', 'semver']);
    assert.deepEqual(c.builtins, ['node:fs', 'zlib']);
  });

  test('VD-closure: a package outside ajv and semver, a non-literal require, an unresolved file and an escape are refused', () => {
    const cases = [
      [{ 'host/dist/a.js': 'require("electron");\n' }, /electron/],
      [{ 'host/dist/a.js': 'const n = "x"; require(n);\n' }, /non-literal require/],
      [{ 'host/dist/a.js': 'require("./gone");\n' }, /cannot resolve \.\/gone/],
      [{ 'host/dist/a.js': 'require("../../../outside");\n' }, /outside the exported tree/],
    ];
    for (const [files, re] of cases) assert.throws(() => closureOf(tree(files), ['host/dist/a.js']), re);
  });

  test('VD-closure: the scripts walk follows static imports and the release-lib roots are read from its loaders', () => {
    const t = tree({
      'scripts/index-verify.mjs': "import fs from 'node:fs';\nimport {\n  ROOT,\n  loadHost,\n} from './release-lib.mjs';\n// import x from 'not-an-import'\n",
      'scripts/release-lib.mjs': "import path from 'node:path';\nexport function loadHost() {\n  const dist = path.join(ROOT, 'host', 'dist');\n  return { m: require(path.join(dist, 'updater', 'manifest.js')), k: require(path.join(dist, 'trustkeys.js')) };\n}\n",
    });
    const s = scriptClosureOf(t, ['scripts/index-verify.mjs']);
    assert.deepEqual(s.files, ['scripts/index-verify.mjs', 'scripts/release-lib.mjs']);
    assert.deepEqual(releaseLibRoots(t), ['host/dist/trustkeys.js', 'host/dist/updater/manifest.js']);
    assert.throws(() => scriptClosureOf(tree({ 'scripts/x.mjs': "import y from 'left-pad';\n" }), ['scripts/x.mjs']), /left-pad/);
    assert.throws(() => releaseLibRoots(tree({ 'scripts/release-lib.mjs': 'export {};\n' })), /no host\/dist loader/);
    assert.throws(() => releaseLibRoots(tree({ 'scripts/release-lib.mjs': "const dist = path.join(ROOT, 'host', 'dist');\nrequire(dist);\n" })), /no host\/dist loader/);
  });
});
