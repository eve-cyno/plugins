// BT-*: tools/base-tree.mjs, the base tree of check.yml. A temp git repository whose commit holds a .gitattributes that `git archive`
// obeys (export-ignore drops the entries, export-subst rewrites a file): the tool must write the commit's tree byte for byte all the
// same, with the executable bit and links, and refuse what it cannot write exactly. No network.
import { after, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { run } from './trees.mjs';

const temps = [];
after(() => { for (const t of temps) fs.rmSync(t, { recursive: true, force: true }); });
const tempDir = (name) => { const t = fs.mkdtempSync(path.join(os.tmpdir(), `bt-${name}-`)); temps.push(t); return t; };
const ENV = {
  ...process.env, GIT_AUTHOR_NAME: 'test', GIT_AUTHOR_EMAIL: 'test@example.invalid', GIT_COMMITTER_NAME: 'test',
  GIT_COMMITTER_EMAIL: 'test@example.invalid', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null',
};
const git = (dir, ...a) => {
  const r = spawnSync('git', ['-C', dir, ...a], { encoding: 'utf8', env: ENV });
  if (r.status !== 0) throw new Error(`git ${a.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
};

const FILES = {
  'entries/.gitkeep': '',
  'entries/.gitattributes': '*.json export-ignore\n',
  'entries/dev.example.intel.json': '{"schema":1,"id":"dev.example.intel"}\n',
  '.gitattributes': 'subst.txt export-subst\nvendor/** -text\n',
  'subst.txt': 'commit $Format:%H$\n',
  'revoked.json': '[]\n',
  'vendor/crlf.txt': 'a\r\nb\r\n',
};
/** A repository with FILES, an executable tool and a link, committed; returns { dir, rev }. */
function repo() {
  const dir = tempDir('repo');
  git(dir, 'init', '-q');
  for (const [p, text] of Object.entries(FILES)) {
    fs.mkdirSync(path.dirname(path.join(dir, p)), { recursive: true });
    fs.writeFileSync(path.join(dir, p), text);
  }
  fs.mkdirSync(path.join(dir, 'tools'));
  fs.writeFileSync(path.join(dir, 'tools', 'run.sh'), '#!/bin/sh\n', { mode: 0o755 });
  fs.symlinkSync('../revoked.json', path.join(dir, 'tools', 'rev-link'));
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'base');
  return { dir, rev: git(dir, 'rev-parse', 'HEAD') };
}
const baseTree = (args) => run('tools/base-tree.mjs', args);

describe('base tree (check.yml)', () => {
  test('BT-exact: every path of the commit, byte for byte, whatever .gitattributes says', async () => {
    const { dir, rev } = repo();
    // The premise: git archive obeys the tree's own .gitattributes, so its base would hold no entry and a rewritten file.
    const viaArchive = tempDir('archive');
    const ar = spawnSync('sh', ['-c', 'git -C "$1" -c core.attributesFile=/dev/null archive "$2" | tar -x -C "$3"', 'sh', dir, rev, viaArchive], { env: ENV });
    assert.equal(ar.status, 0);
    assert.equal(fs.existsSync(path.join(viaArchive, 'entries', 'dev.example.intel.json')), false, 'git archive drops the entry');
    assert.notEqual(fs.readFileSync(path.join(viaArchive, 'subst.txt'), 'utf8'), FILES['subst.txt'], 'git archive rewrites the file');

    const out = path.join(tempDir('out'), 'base');
    const r = await baseTree(['--repo', dir, '--rev', rev, '--out', out]);
    assert.equal(r.code, 0, r.stdout + r.stderr);
    assert.match(r.stdout, new RegExp(`^BASE TREE ${rev}: 9 paths`, 'm'));
    for (const [p, text] of Object.entries(FILES)) assert.equal(fs.readFileSync(path.join(out, p), 'utf8'), text, p);
    assert.equal(fs.statSync(path.join(out, 'tools', 'run.sh')).mode & 0o111, 0o111, 'the executable bit');
    assert.equal(fs.statSync(path.join(out, 'revoked.json')).mode & 0o111, 0, 'no executable bit');
    assert.equal(fs.lstatSync(path.join(out, 'tools', 'rev-link')).isSymbolicLink(), true);
    assert.equal(fs.readlinkSync(path.join(out, 'tools', 'rev-link')), '../revoked.json');
    assert.equal(fs.existsSync(path.join(out, '.git')), false);
  });

  test('BT-empty-folder: an existing empty folder is used; one with anything in it is refused', async () => {
    const { dir, rev } = repo();
    const empty = tempDir('empty');
    assert.equal((await baseTree(['--repo', dir, '--rev', rev, '--out', empty])).code, 0);
    const full = tempDir('full');
    fs.writeFileSync(path.join(full, 'x'), 'x');
    const r = await baseTree(['--repo', dir, '--rev', rev, '--out', full]);
    assert.equal(r.code, 1, r.stdout + r.stderr);
    assert.match(r.stderr, /^REFUSED: .*not empty/m);
  });

  test('BT-submodule: a submodule (gitlink) is refused, never written as an empty folder', async () => {
    const { dir, rev } = repo();
    git(dir, 'update-index', '--add', '--cacheinfo', `160000,${rev},entries/sub`);
    git(dir, 'commit', '-q', '-m', 'gitlink');
    const r = await baseTree(['--repo', dir, '--rev', git(dir, 'rev-parse', 'HEAD'), '--out', path.join(tempDir('out'), 'base')]);
    assert.equal(r.code, 1, r.stdout + r.stderr);
    assert.match(r.stderr, /^REFUSED: .*entries\/sub.*mode 160000/m);
  });

  test('BT-bad-path: a tree path ".git" or ".." (git mktree writes them) is refused, nothing is written', async () => {
    const { dir } = repo();
    const blob = git(dir, 'rev-parse', 'HEAD:revoked.json');
    for (const name of ['.git', '..', '.GIT']) {
      const t = spawnSync('git', ['-C', dir, 'mktree'], { input: `100644 blob ${blob}\t${name}\n`, encoding: 'utf8', env: ENV });
      assert.equal(t.status, 0, t.stderr);
      const rev = git(dir, 'commit-tree', t.stdout.trim(), '-m', 'bad');
      const out = tempDir('bad');
      const r = await baseTree(['--repo', dir, '--rev', rev, '--out', out]);
      assert.equal(r.code, 1, `${name}: ${r.stdout}${r.stderr}`);
      assert.match(r.stderr, /^REFUSED: .*path component/m, name);
      assert.deepEqual(fs.readdirSync(out), [], name);
    }
  });

  test('BT-usage: a full commit id is required, and it must name a commit of the repository', async () => {
    const { dir } = repo();
    const out = path.join(tempDir('out'), 'base');
    assert.equal((await baseTree(['--repo', dir, '--rev', 'HEAD', '--out', out])).code, 2);
    const r = await baseTree(['--repo', dir, '--rev', 'f'.repeat(40), '--out', out]);
    assert.equal(r.code, 1, r.stdout + r.stderr);
    assert.match(r.stderr, /^REFUSED: .*no commit/m);
    assert.equal(fs.existsSync(out), false);
  });
});
