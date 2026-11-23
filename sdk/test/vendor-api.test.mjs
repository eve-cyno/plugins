import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, readFileSync, writeFileSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { DEFAULT_MANIFEST, DEFAULT_VENDOR, verify } from '../tools/vendor-api.mjs';

const TOOL = new URL('../tools/vendor-api.mjs', import.meta.url).pathname;

function sandbox() {
  const dir = mkdtempSync(join(tmpdir(), 'vendor-api-'));
  const vendorDir = join(dir, 'plugin-api');
  const manifestPath = join(dir, 'MANIFEST.json');
  cpSync(DEFAULT_VENDOR, vendorDir, { recursive: true });
  cpSync(DEFAULT_MANIFEST, manifestPath);
  return { dir, vendorDir, manifestPath };
}
const editJson = (path, fn) => { const j = JSON.parse(readFileSync(path, 'utf8')); fn(j); writeFileSync(path, JSON.stringify(j, null, 2)); };

test('--verify is green on the committed vendor tree (CLI)', () => {
  const out = execFileSync(process.execPath, [TOOL, '--verify'], { encoding: 'utf8' });
  assert.match(out, /verify: ok/);
});

test('verify: pristine copy has no problems', () => {
  assert.deepEqual(verify(sandbox()), []);
});

test('verify: a changed byte in the d.ts fails', () => {
  const s = sandbox();
  const host = JSON.parse(readFileSync(s.manifestPath, 'utf8')).hostApi;
  appendFileSync(join(s.vendorDir, `${host}.d.ts`), ' ');
  assert.match(verify(s).join('\n'), /sha256 differs/);
});

test('verify: a changed byte in the README fails', () => {
  const s = sandbox();
  appendFileSync(join(s.vendorDir, 'README.md'), 'x');
  assert.match(verify(s).join('\n'), /README\.md: sha256 differs/);
});

test('verify: a wrong commit fails', () => {
  const s = sandbox();
  editJson(s.manifestPath, (m) => { m.desktop.commit = 'f'.repeat(40); });
  assert.match(verify(s).join('\n'), /desktopCommit/);
});

test('verify: a wrong version fails', () => {
  const s = sandbox();
  editJson(s.manifestPath, (m) => { m.hostApi = '0.0.0'; });
  assert.match(verify(s).join('\n'), /version/);
});

test('verify: a missing file fails', () => {
  const s = sandbox();
  execFileSync('rm', [join(s.vendorDir, 'LICENSE')]);
  assert.match(verify(s).join('\n'), /LICENSE: missing/);
});

test('verify: vendored package.json version drift fails even when PIN is rewritten to match', () => {
  const s = sandbox();
  editJson(join(s.vendorDir, 'package.json'), (p) => { p.version = '1.28.0'; });
  assert.match(verify(s).join('\n'), /package\.json version 1\.28\.0/);
});
