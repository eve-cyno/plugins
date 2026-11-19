// SCOPE-*: tools/merge-scope.mjs, the merge gate of docs/RUNBOOK.md "Publishing" steps 1.4a and 1.5a (stage-fixes A1, finding 1). A
// pull request whose changes are only regular files entries/<id>.json and revoked.json ran the base's own tools and workflow in
// check.yml, so its green jobs mean something; any other change (tools, workflows, the lock file, a link, a deletion, a mode change,
// entries/.gitattributes) could have changed what the jobs print, and the owner reads it before he says "merge". The tool reads only
// git plumbing of the candidate repository and runs none of its code. With --read <H> (step 1.5a) every owner path of the merge must
// be the object <H> names and one <H> changed, so the owner's "merge" for <H> covers it. Each case is a temp git repository; no
// network.
import { after, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ROOT } from './trees.mjs';

const TOOL = path.join(ROOT, 'tools', 'merge-scope.mjs');
const temps = [];
after(() => { for (const t of temps) fs.rmSync(t, { recursive: true, force: true }); });
const tempDir = (name) => { const t = fs.mkdtempSync(path.join(os.tmpdir(), `scope-${name}-`)); temps.push(t); return t; };
const ENV = {
  ...process.env, GIT_AUTHOR_NAME: 'test', GIT_AUTHOR_EMAIL: 'test@example.invalid', GIT_COMMITTER_NAME: 'test',
  GIT_COMMITTER_EMAIL: 'test@example.invalid', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null',
};
const git = (dir, ...a) => {
  const r = spawnSync('git', ['-C', dir, ...a], { encoding: 'utf8', env: ENV });
  if (r.status !== 0) throw new Error(`git ${a.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
};
const entry = (id, v = '1.0.0') => `${JSON.stringify({ schema: 1, id, versions: [{ version: v }] })}\n`;

/** The base tree of an index repository, enough for the gate: entries, revocations, a tool, a workflow, the manifest and lock file. */
const BASE = {
  'entries/.gitkeep': '',
  'entries/dev.example.intel.json': entry('dev.example.intel'),
  'revoked.json': '[]\n',
  'tools/check.mjs': "console.log('CHECKS PASSED');\n",
  '.github/workflows/check.yml': 'name: check\n',
  'package.json': '{"name":"index","type":"module"}\n',
  'package-lock.json': '{"lockfileVersion":3}\n',
};
const write = (dir, files) => {
  for (const [p, text] of Object.entries(files)) {
    const f = path.join(dir, p);
    if (text === null) { fs.rmSync(f); continue; }
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, text);
  }
};
const commit = (dir, msg) => { git(dir, 'add', '-A'); git(dir, 'commit', '-q', '--allow-empty', '-m', msg); return git(dir, 'rev-parse', 'HEAD'); };
/** A repository with BASE (plus `extra`) committed as the base; returns { dir, base }. */
function repo(extra = {}) {
  const dir = tempDir('repo');
  git(dir, 'init', '-q', '-b', 'main');
  write(dir, { ...BASE, ...extra });
  return { dir, base: commit(dir, 'base') };
}
/** The base repository, then one commit made by `change(dir)`: { dir, base, head }. */
function pr(change, extra = {}) {
  const r = repo(extra);
  change(r.dir);
  return { ...r, head: commit(r.dir, 'pull request') };
}
const scope = (args, { cwd = ROOT } = {}) => new Promise((resolve) => {
  execFile(process.execPath, [TOOL, ...args], { cwd, encoding: 'utf8', timeout: 60_000, env: ENV },
    (err, stdout, stderr) => resolve({ code: err ? (typeof err.code === 'number' ? err.code : -1) : 0, stdout, stderr }));
});
const gate = (r, more = []) => scope(['--repo-dir', r.dir, '--base', r.base, '--head', r.head, ...more]);
/** The one SCOPE line of the output; the test fails if there is none or more than one. */
const scopeLine = (out) => {
  const ls = out.split('\n').filter((l) => l.startsWith('SCOPE'));
  assert.equal(ls.length, 1, `exactly one SCOPE line in:\n${out}`);
  return ls[0];
};
const assertEntriesOnly = (res) => {
  assert.equal(scopeLine(res.stdout), 'SCOPE ENTRIES-ONLY', res.stdout + res.stderr);
  assert.equal(res.code, 0, res.stderr);
};
/** OWNER naming exactly `names` (in any order). */
const assertOwner = (res, names) => {
  const l = scopeLine(res.stdout);
  assert.match(l, /^SCOPE OWNER /, res.stdout + res.stderr);
  assert.deepEqual(l.slice('SCOPE OWNER '.length).split(' ').sort(), [...names].sort());
  assert.equal(res.code, 3, res.stderr);
};

describe('merge scope (RUNBOOK Publishing 1.4a, 1.5a)', () => {
  test('SCOPE-entries-only: an added and a changed entry file are entries only', async () => {
    const r = pr((d) => write(d, { 'entries/dev.example.new.json': entry('dev.example.new'), 'entries/dev.example.intel.json': entry('dev.example.intel', '1.1.0') }));
    const res = await gate(r);
    assertEntriesOnly(res);
    assert.match(res.stdout, new RegExp(`^base ${r.base}, head ${r.head}$`, 'm'), 'it names the two commits it compared');
  });

  test('SCOPE-revoked-only: a changed revoked.json is entries only', async () => {
    assertEntriesOnly(await gate(pr((d) => write(d, { 'revoked.json': '[{"id":"dev.example.intel","versions":"*"}]\n' }))));
  });

  test('SCOPE-tools-owner: a changed tool goes to the owner, beside an entry', async () => {
    const r = pr((d) => write(d, { 'tools/check.mjs': "console.log('CHECKS PASSED'); process.exit(0);\n", 'entries/dev.example.new.json': entry('dev.example.new') }));
    assertOwner(await gate(r), ['tools/check.mjs']);
  });

  test('SCOPE-workflow-owner: a changed workflow goes to the owner', async () => {
    assertOwner(await gate(pr((d) => write(d, { '.github/workflows/check.yml': 'name: check\non: push\n' }))), ['.github/workflows/check.yml']);
  });

  test('SCOPE-package-lock-owner: a changed lock file goes to the owner', async () => {
    assertOwner(await gate(pr((d) => write(d, { 'package-lock.json': '{"lockfileVersion":3,"packages":{}}\n' }))), ['package-lock.json']);
  });

  test('SCOPE-entry-symlink-owner: a link, a type change or a submodule under an entry name goes to the owner', async () => {
    // An added link named like an entry (mode 120000).
    assertOwner(await gate(pr((d) => fs.symlinkSync('../tools/check.mjs', path.join(d, 'entries', 'dev.example.link.json')))), ['entries/dev.example.link.json']);
    // An entry file turned into a link (type change T).
    assertOwner(await gate(pr((d) => { fs.rmSync(path.join(d, 'entries', 'dev.example.intel.json')); fs.symlinkSync('../revoked.json', path.join(d, 'entries', 'dev.example.intel.json')); })), ['entries/dev.example.intel.json']);
    // A gitlink (mode 160000) named like an entry.
    const r = repo();
    git(r.dir, 'update-index', '--add', '--cacheinfo', `160000,${r.base},entries/dev.example.sub.json`);
    git(r.dir, 'commit', '-q', '-m', 'gitlink');
    assertOwner(await gate({ ...r, head: git(r.dir, 'rev-parse', 'HEAD') }), ['entries/dev.example.sub.json']);
    // A link under an entry name turned into a regular file (type change T, ending as mode 100644) is a type change all the same.
    const l = repo();
    fs.symlinkSync('../revoked.json', path.join(l.dir, 'entries', 'dev.example.was-link.json'));
    const linked = commit(l.dir, 'a link');
    fs.rmSync(path.join(l.dir, 'entries', 'dev.example.was-link.json'));
    write(l.dir, { 'entries/dev.example.was-link.json': entry('dev.example.was-link') });
    const res = await gate({ dir: l.dir, base: linked, head: commit(l.dir, 'link to file') });
    assertOwner(res, ['entries/dev.example.was-link.json']);
    assert.match(res.stdout, /^owner T entries\/dev\.example\.was-link\.json: change type T /m);
  });

  test('SCOPE-entry-mode-owner: an entry file made executable goes to the owner', async () => {
    assertOwner(await gate(pr((d) => fs.chmodSync(path.join(d, 'entries', 'dev.example.intel.json'), 0o755))), ['entries/dev.example.intel.json']);
    assertOwner(await gate(pr((d) => { write(d, { 'entries/dev.example.x.json': entry('dev.example.x') }); fs.chmodSync(path.join(d, 'entries', 'dev.example.x.json'), 0o755); })), ['entries/dev.example.x.json']);
    // An executable entry made a regular file again is a mode change too.
    const r = repo();
    fs.chmodSync(path.join(r.dir, 'entries', 'dev.example.intel.json'), 0o755);
    const exec = commit(r.dir, 'executable');
    fs.chmodSync(path.join(r.dir, 'entries', 'dev.example.intel.json'), 0o644);
    const res = await gate({ dir: r.dir, base: exec, head: commit(r.dir, 'regular') });
    assertOwner(res, ['entries/dev.example.intel.json']);
    assert.match(res.stdout, /^owner M entries\/dev\.example\.intel\.json: mode 100755 to 100644$/m);
  });

  test('SCOPE-entry-delete-owner: a deleted entry or revoked.json goes to the owner', async () => {
    const res = await gate(pr((d) => write(d, { 'entries/dev.example.intel.json': null })));
    assertOwner(res, ['entries/dev.example.intel.json']);
    assert.match(res.stdout, /^owner D entries\/dev\.example\.intel\.json: deleted$/m);
    assertOwner(await gate(pr((d) => write(d, { 'revoked.json': null }))), ['revoked.json']);
  });

  test('SCOPE-gitattributes-owner: entries/.gitattributes, .gitkeep and names outside the id grammar go to the owner', async () => {
    assertOwner(await gate(pr((d) => write(d, { 'entries/.gitattributes': '*.json export-ignore\n' }))), ['entries/.gitattributes']);
    assertOwner(await gate(pr((d) => write(d, { 'entries/.gitkeep': 'x\n' }))), ['entries/.gitkeep']);
    assertOwner(await gate(pr((d) => write(d, {
      'entries/Dev.Example.Upper.json': entry('Dev.Example.Upper'),
      'entries/dev.example.json': entry('dev.example'),
      'entries/dev.example.intel.txt': 'x\n',
      'entries/sub/dev.example.deep.json': entry('dev.example.deep'),
      'revoked.json.bak': '[]\n',
    }))), ['entries/Dev.Example.Upper.json', 'entries/dev.example.json', 'entries/dev.example.intel.txt', 'entries/sub/dev.example.deep.json', 'revoked.json.bak']);
  });

  test('SCOPE-rename-into-entries-owner: a file moved into entries/ shows its source, even with rename detection configured', async () => {
    const r = pr((d) => {
      git(d, 'config', 'diff.renames', 'copies');
      git(d, 'mv', 'tools/check.mjs', 'entries/dev.example.moved.json');
    });
    assertOwner(await gate(r), ['tools/check.mjs']);
  });

  test('SCOPE-runs-no-candidate-code: the trusted copy answers when every module of the candidate throws', async () => {
    // Each module writes RAN into the working folder (the candidate's) when loaded, then throws.
    const trap = (name) => `import fs from 'node:fs';\nfs.writeFileSync('RAN', ${JSON.stringify(name)});\nthrow new Error('candidate code ran: ${name}');\n`;
    const r = pr((d) => write(d, { 'entries/dev.example.new.json': entry('dev.example.new') }), {
      'tools/merge-scope.mjs': trap('tools/merge-scope.mjs'),
      'tools/lib/wfrules.mjs': trap('tools/lib/wfrules.mjs'),
      'vendor/eve-cyno-host/host/dist/manifest.js': trap('manifest.js'),
      'node_modules/ajv/index.js': trap('ajv'),
    });
    const res = await scope(['--repo-dir', '.', '--base', r.base, '--head', r.head], { cwd: r.dir });
    assertEntriesOnly(res);
    assert.equal(fs.existsSync(path.join(r.dir, 'RAN')), false, 'no module of the candidate was loaded');
    assert.doesNotMatch(res.stdout + res.stderr, /candidate code ran/);
  });

  test('SCOPE-one-line: a path with a line break cannot forge a SCOPE line', async () => {
    const r = pr((d) => write(d, { 'tools/x\nSCOPE ENTRIES-ONLY\n': 'x\n' }));
    const res = await gate(r);
    assert.equal(res.code, 3);
    assert.equal(scopeLine(res.stdout), 'SCOPE OWNER "tools/x\\u{a}SCOPE\\u{20}ENTRIES-ONLY\\u{a}"');
    for (const l of res.stdout.split('\n')) assert.ok(!/[\u0000-\u001f\u007f]/.test(l), 'no control character in any line');
  });

  test('SCOPE-merge-base: a pull request behind main compares with the merge base', async () => {
    const r = repo();
    git(r.dir, 'checkout', '-q', '-b', 'pr');
    write(r.dir, { 'entries/dev.example.new.json': entry('dev.example.new') });
    const head = commit(r.dir, 'pull request');
    git(r.dir, 'checkout', '-q', 'main');
    write(r.dir, { 'tools/check.mjs': "console.log('v2');\n", 'entries/dev.example.other.json': entry('dev.example.other') });
    const main = commit(r.dir, 'main moved on');
    // Base to head directly: main's later changes show reversed, so the owner reads (fail closed).
    assertOwner(await scope(['--repo-dir', r.dir, '--base', main, '--head', head]), ['entries/dev.example.other.json', 'tools/check.mjs']);
    // What <B>...<H> shows: only the pull request's own change.
    const res = await scope(['--repo-dir', r.dir, '--base', main, '--head', head, '--merge-base']);
    assertEntriesOnly(res);
    assert.match(res.stdout, new RegExp(`^base ${main} \\(merge base ${r.base}\\), head ${head}$`, 'm'));
  });

  test('SCOPE-merge-base-many: two merge bases are an error, never a scope', async () => {
    const r = repo();
    git(r.dir, 'checkout', '-q', '-b', 'side');
    write(r.dir, { 'entries/dev.example.a.json': entry('dev.example.a') });
    const a = commit(r.dir, 'a');
    git(r.dir, 'checkout', '-q', 'main');
    write(r.dir, { 'entries/dev.example.b.json': entry('dev.example.b') });
    const b = commit(r.dir, 'b');
    git(r.dir, 'checkout', '-q', '-b', 'x', b);
    git(r.dir, 'merge', '-q', '--no-edit', a);
    const x = git(r.dir, 'rev-parse', 'HEAD');
    git(r.dir, 'checkout', '-q', '-b', 'y', a);
    git(r.dir, 'merge', '-q', '--no-edit', b);
    const y = git(r.dir, 'rev-parse', 'HEAD');
    const res = await scope(['--repo-dir', r.dir, '--base', x, '--head', y, '--merge-base']);
    assert.equal(res.code, 1, res.stdout + res.stderr);
    assert.match(res.stderr, /^ERROR .*2 merge bases/m);
    // One rule for every ERROR (RUNBOOK 1.4a): rebase or fix the pull request, then start again at step 1; never on to 1.5a.
    assert.match(res.stderr, /rebase the pull request on main, then start again at step 1 of "Publishing"/);
    assert.doesNotMatch(res.stderr, /1\.5a/);
    assert.doesNotMatch(res.stdout, /^SCOPE/m);
  });

  test('SCOPE-gitmodules-ignore: a .gitmodules in the working folder or diff.ignoreSubmodules cannot hide a gitlink', async () => {
    const r = repo();
    git(r.dir, 'update-index', '--add', '--cacheinfo', `160000,${r.base},entries/dev.example.sub.json`);
    git(r.dir, 'commit', '-q', '-m', 'gitlink');
    const head = git(r.dir, 'rev-parse', 'HEAD');
    // Not committed: only the working folder of the checkout holds it, and diff-tree would read its ignore = all.
    write(r.dir, { '.gitmodules': '[submodule "x"]\n\tpath = entries/dev.example.sub.json\n\turl = ./x\n\tignore = all\n' });
    assertOwner(await gate({ ...r, head }), ['entries/dev.example.sub.json']);
    fs.rmSync(path.join(r.dir, '.gitmodules'));
    git(r.dir, 'config', 'diff.ignoreSubmodules', 'all');
    assertOwner(await gate({ ...r, head }), ['entries/dev.example.sub.json']);
  });

  test('SCOPE-replace-objects: a refs/replace entry cannot swap the pull request commit for one without its change', async () => {
    const r = pr((d) => write(d, { 'tools/check.mjs': "console.log('CHECKS PASSED'); process.exit(0);\n" }));
    // A commit with the base's tree, put in place of <H> for every git command that honours replace refs.
    const fake = git(r.dir, 'commit-tree', '-p', r.base, '-m', 'no change', `${r.base}^{tree}`);
    git(r.dir, 'replace', r.head, fake);
    assertOwner(await gate(r), ['tools/check.mjs']);
    assertOwner(await gate(r, ['--merge-base']), ['tools/check.mjs']);
  });

  test('SCOPE-errors: an unknown rev is an error; a missing option or a rev that reads as an option is a usage error', async () => {
    const r = pr((d) => write(d, { 'revoked.json': '[1]\n' }));
    const unknown = await scope(['--repo-dir', r.dir, '--base', r.base, '--head', 'f'.repeat(40)]);
    assert.equal(unknown.code, 1);
    assert.doesNotMatch(unknown.stdout, /^SCOPE/m);
    const notRepo = await scope(['--repo-dir', tempDir('empty'), '--base', r.base, '--head', r.head]);
    assert.equal(notRepo.code, 1);
    assert.equal((await scope(['--base', r.base, '--head', r.head])).code, 2, '--repo-dir is required');
    assert.equal((await scope(['--repo-dir', r.dir, '--head', r.head])).code, 2, '--base is required');
    const out = path.join(tempDir('out'), 'written');
    const inj = await scope(['--repo-dir', r.dir, `--base=--output=${out}`, '--head', r.head]);
    assert.equal(inj.code, 2);
    assert.equal(fs.existsSync(out), false, 'the value never reaches git as an option');
  });
});

/**
 * Step 1.5a's --read <H>: main moved on from the merge base <mb> of the pull request; the coordinator merged <H> into it the way
 * `change(dir)` says (by default `git merge --no-ff <H>`). Returns { dir, mb, base: main, head: <H>, merge }.
 */
function merged({ prFiles, mainFiles = null, extra = {}, change = null }) {
  const r = repo(extra);
  git(r.dir, 'checkout', '-q', '-b', 'pr');
  write(r.dir, prFiles);
  const head = commit(r.dir, 'pull request');
  git(r.dir, 'checkout', '-q', 'main');
  if (mainFiles) write(r.dir, mainFiles);
  const base = mainFiles ? commit(r.dir, 'main moved on') : r.base;
  if (change) change(r.dir, head); else git(r.dir, 'merge', '-q', '--no-ff', '--no-edit', head);
  return { dir: r.dir, mb: r.base, base, head, merge: git(r.dir, 'rev-parse', 'HEAD') };
}
const readGate = (m, read = m.head) => scope(['--repo-dir', m.dir, '--base', m.base, '--head', m.merge, '--read', read]);
/** UNREAD naming exactly `names` (in any order), exit 4. */
const assertUnread = (res, names) => {
  const l = scopeLine(res.stdout);
  assert.match(l, /^SCOPE UNREAD /, res.stdout + res.stderr);
  assert.deepEqual(l.slice('SCOPE UNREAD '.length).split(' ').sort(), [...names].sort());
  assert.equal(res.code, 4, res.stderr);
};
const FIVE = (first, last) => `${first}\nline 2\nline 3\nline 4\n${last}\n`;

describe('merge scope --read (RUNBOOK Publishing 1.5a)', () => {
  test('SCOPE-read-same-object: each owner path of the merge is the object <H> names, and <H> changed it', async () => {
    const m = merged({
      prFiles: { 'tools/check.mjs': "console.log('v2');\n", 'entries/dev.example.new.json': entry('dev.example.new') },
      mainFiles: { 'entries/dev.example.other.json': entry('dev.example.other') },
    });
    const res = await readGate(m);
    assertOwner(res, ['tools/check.mjs']);
    assert.match(res.stdout, new RegExp(`^read ${m.head} \\(merge base ${m.mb}\\): 1 owner paths, each the object ${m.head} names and changed by it$`, 'm'));
    // An entries-only merge passes the same way; entries are not compared (the jobs checked the merged files, step 1.5).
    const e = merged({ prFiles: { 'entries/dev.example.new.json': entry('dev.example.new') } });
    assertEntriesOnly(await readGate(e));
  });

  test('SCOPE-read-different-blob: a tool that is not the object <H> names is unread (a force-push, or main changed it too)', async () => {
    // The review's case: the owner read <H2> (harmless), the coordinator merged <H> (the one fetched before the force-push).
    const r = repo();
    git(r.dir, 'checkout', '-q', '-b', 'pr');
    write(r.dir, { 'tools/x.mjs': "process.exit(0); // malicious\n" });
    const h = commit(r.dir, 'pull request');
    write(r.dir, { 'tools/x.mjs': "console.log('harmless');\n" });
    git(r.dir, 'commit', '-q', '-a', '--amend', '-m', 'pull request');
    const h2 = git(r.dir, 'rev-parse', 'HEAD');
    git(r.dir, 'checkout', '-q', 'main');
    git(r.dir, 'merge', '-q', '--no-ff', '--no-edit', h);
    const m = { dir: r.dir, base: r.base, head: h, merge: git(r.dir, 'rev-parse', 'HEAD') };
    assertOwner(await readGate(m), ['tools/x.mjs']);
    const res = await readGate(m, h2);
    assertUnread(res, ['tools/x.mjs']);
    assert.match(res.stdout, new RegExp(`^unread A tools/x\\.mjs: not the object ${h2} names$`, 'm'));

    // main changed the same tool (another hunk): git merges both, so the merged file is neither <H>'s nor main's. revoked.json,
    // merged the same way, is an entry path and is not compared.
    const n = merged({
      prFiles: { 'tools/check.mjs': FIVE('one', 'five from the pull request'), 'revoked.json': FIVE('[', '5]') },
      mainFiles: { 'tools/check.mjs': FIVE('one from main', 'five'), 'revoked.json': FIVE('[0,', '5]') },
      extra: { 'tools/check.mjs': FIVE('one', 'five'), 'revoked.json': FIVE('[', '5]') },
    });
    assert.equal(git(n.dir, 'show', `${n.merge}:tools/check.mjs`), FIVE('one from main', 'five from the pull request').trimEnd(), 'the premise: git merged both hunks');
    assertUnread(await readGate(n), ['tools/check.mjs']);
  });

  test('SCOPE-read-path-only-in-merge: a path the merge commit adds that <H> does not hold is unread', async () => {
    const m = merged({
      prFiles: { 'tools/check.mjs': "console.log('v2');\n" },
      change: (d, head) => {
        git(d, 'merge', '-q', '--no-ff', '--no-commit', head);
        write(d, { 'tools/z.mjs': "process.exit(0);\n" });
        commit(d, 'an evil merge');
      },
    });
    const res = await readGate(m);
    assertUnread(res, ['tools/z.mjs']);
    assert.match(res.stdout, /^unread A tools\/z\.mjs: not the object [0-9a-f]{40} names$/m);
  });

  test('SCOPE-read-unchanged-by-pr: a path <H> holds as the merge base did is unread (the compare view never showed it)', async () => {
    // main changed tools/check.mjs after the merge base; the merge sets it back to the merge base's file, which <H> also holds.
    const m = merged({
      prFiles: { 'tools/new.mjs': "console.log('new');\n" },
      mainFiles: { 'tools/check.mjs': "console.log('main v2');\n" },
      change: (d, head) => {
        git(d, 'merge', '-q', '--no-ff', '--no-commit', head);
        write(d, { 'tools/check.mjs': BASE['tools/check.mjs'] });
        commit(d, 'a merge that reverts main');
      },
    });
    const res = await readGate(m);
    assertUnread(res, ['tools/check.mjs']);
    assert.match(res.stdout, new RegExp(`^unread M tools/check\\.mjs: unchanged from the merge base ${m.mb} to ${m.head}, so not in the compare view$`, 'm'));
  });

  test('SCOPE-read-errors: --read names a commit; an unknown one is an error, one that reads as an option a usage error', async () => {
    const m = merged({ prFiles: { 'tools/check.mjs': "console.log('v2');\n" } });
    const unknown = await readGate(m, 'f'.repeat(40));
    assert.equal(unknown.code, 1, unknown.stdout + unknown.stderr);
    assert.match(unknown.stderr, /^ERROR /m);
    assert.doesNotMatch(unknown.stdout, /^SCOPE/m);
    assert.equal((await readGate(m, '--merge-base')).code, 2);
  });
});
