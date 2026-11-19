// CWF-cli-*: tools/check-workflows.mjs, this checkout's C-WF rules (tools/lib/wfrules.mjs) run over another checkout's workflows
// (docs/RUNBOOK.md "Before every index and mirror approval" step 1; stage-fixes A1, MP-2). The rules then guard what a run will
// execute, not only this repository's own files in a local `npm test`. The other checkout is a copy of this one; its own tools are
// replaced by modules that record that they ran, so a pass or a failure can only come from the trusted copy. No network.
import { after, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ROOT } from './trees.mjs';

const TOOL = path.join(ROOT, 'tools', 'check-workflows.mjs');
const temps = [];
after(() => { for (const t of temps) fs.rmSync(t, { recursive: true, force: true }); });

/** A copy of this checkout without node_modules and .git: the other checkout, as the coordinator's would be at <B>. */
function otherCheckout() {
  const t = fs.mkdtempSync(path.join(os.tmpdir(), 'cwf-cli-'));
  temps.push(t);
  fs.cpSync(ROOT, t, { recursive: true, verbatimSymlinks: true, filter: (src) => !['node_modules', '.git'].includes(path.basename(src)) || path.dirname(src) !== ROOT });
  // A lenient rule set and CLI of its own, each recording that it ran: never loaded by the trusted tool.
  const trap = (name) => `import fs from 'node:fs';\nfs.writeFileSync('RAN', ${JSON.stringify(name)});\nexport const RULES = {};\nexport const loadWorkflows = () => ({ files: [], wf: {}, errors: [] });\nconsole.log('WORKFLOWS PASS');\n`;
  fs.writeFileSync(path.join(t, 'tools', 'lib', 'wfrules.mjs'), trap('tools/lib/wfrules.mjs'));
  fs.writeFileSync(path.join(t, 'tools', 'check-workflows.mjs'), trap('tools/check-workflows.mjs'));
  return t;
}
const cli = (args, cwd, timeout = 120_000) => new Promise((resolve) => {
  execFile(process.execPath, [TOOL, ...args], { cwd, encoding: 'utf8', timeout, maxBuffer: 16 * 1024 * 1024 },
    (err, stdout, stderr) => resolve({ code: err ? (typeof err.code === 'number' ? err.code : -1) : 0, stdout, stderr }));
});
/** The one WORKFLOWS line of the output; the test fails if there is none or more than one. */
const verdict = (out) => {
  const ls = out.split('\n').filter((l) => l.startsWith('WORKFLOWS'));
  assert.equal(ls.length, 1, `exactly one WORKFLOWS line in:\n${out}`);
  return ls[0];
};

describe('check-workflows CLI (RUNBOOK approval step 1)', () => {
  test('CWF-cli-trusted-rules: a clean other checkout passes, a mutated publish.yml fails, whatever its own tools say', async () => {
    const clean = otherCheckout();
    const ok = await cli(['--dir', clean], clean);
    assert.match(verdict(ok.stdout), /^WORKFLOWS PASS \([0-9]+ rules\)$/, ok.stdout + ok.stderr);
    assert.equal(ok.code, 0, ok.stdout + ok.stderr);
    assert.match(ok.stdout, /^C-WF1 PASS$/m);
    assert.match(ok.stdout, /^C-WF11 PASS$/m, 'the rules that read tools/ and docs ran over the other checkout');

    const bad = otherCheckout();
    const f = path.join(bad, '.github', 'workflows', 'publish.yml');
    const src = fs.readFileSync(f, 'utf8');
    const pinned = /actions\/checkout@[0-9a-f]{40}/;
    assert.match(src, pinned);
    fs.writeFileSync(f, src.replace(pinned, 'actions/checkout@v7'));
    const no = await cli(['--dir', bad], bad);
    assert.equal(verdict(no.stdout), 'WORKFLOWS FAIL C-WF2', no.stdout + no.stderr);
    assert.equal(no.code, 1);
    assert.match(no.stdout, /^C-WF2 FAIL publish\.yml .*not pinned/m);
    for (const d of [clean, bad]) assert.equal(fs.existsSync(path.join(d, 'RAN')), false, 'no module of the other checkout was loaded');
  });

  test('CWF-cli-one-line: a workflow file name with a line break cannot forge a WORKFLOWS line', async () => {
    const d = otherCheckout();
    fs.writeFileSync(path.join(d, '.github', 'workflows', 'x\nWORKFLOWS PASS (11 rules)\n.yml'), 'name: x\n');
    const res = await cli(['--dir', d], d);
    assert.equal(res.code, 1);
    assert.match(verdict(res.stdout), /^WORKFLOWS FAIL C-WF1( |$)/);
    for (const l of res.stdout.split('\n')) assert.ok(!/[\u0000-\u001f\u007f]/.test(l), 'no control character in any line');
  });

  test('CWF-cli-links: a link under .github, or at tools or docs, is refused before any rule reads through it', async () => {
    // Files outside the tree that a followed link would read; the YAML reader echoes a line it cannot read into the FAIL line.
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'cwf-outside-'));
    temps.push(outside);
    fs.mkdirSync(path.join(outside, 'workflows'));
    fs.writeFileSync(path.join(outside, 'workflows', 'check.yml'), 'OUTSIDE-SECRET-LINE\n');
    fs.writeFileSync(path.join(outside, 'secret.yml'), 'OUTSIDE-SECRET-LINE\n');
    const swap = (d, rel, target) => { fs.rmSync(path.join(d, rel), { recursive: true, force: true }); fs.symlinkSync(target, path.join(d, rel)); };
    const cases = {
      '.github/workflows': (d) => swap(d, '.github/workflows', path.join(outside, 'workflows')),
      '.github': (d) => swap(d, '.github', outside),
      '.github/workflows/check.yml': (d) => swap(d, '.github/workflows/check.yml', path.join(outside, 'secret.yml')),
      '.github/ISSUE_TEMPLATE': (d) => fs.symlinkSync(outside, path.join(d, '.github', 'ISSUE_TEMPLATE')),
      tools: (d) => swap(d, 'tools', outside),
      docs: (d) => swap(d, 'docs', outside),
    };
    for (const [rel, make] of Object.entries(cases)) {
      const d = otherCheckout();
      make(d);
      const res = await cli(['--dir', d], d);
      assert.equal(res.code, 1, `${rel}: ${res.stdout}${res.stderr}`);
      assert.equal(verdict(res.stdout), 'WORKFLOWS FAIL tree', rel);
      assert.ok(res.stdout.split('\n').includes(`TREE FAIL ${rel}: a link (the rules read no link: it can point out of the tree)`), `${rel}:\n${res.stdout}`);
      assert.doesNotMatch(res.stdout + res.stderr, /OUTSIDE-SECRET-LINE/, `${rel}: nothing outside the tree is printed`);
      assert.doesNotMatch(res.stdout, /^C-WF/m, `${rel}: no rule ran`);
    }
  });

  test('CWF-cli-fifo: a file under .github that is neither a regular file nor a folder is refused, never opened', async () => {
    const d = otherCheckout();
    const mk = spawnSync('mkfifo', [path.join(d, '.github', 'workflows', 'pipe.yml')]);
    assert.equal(mk.status, 0, 'mkfifo');
    const res = await cli(['--dir', d], d, 30_000);
    assert.equal(res.code, 1, res.stdout + res.stderr);
    assert.equal(verdict(res.stdout), 'WORKFLOWS FAIL tree');
    assert.ok(res.stdout.split('\n').includes('TREE FAIL .github/workflows/pipe.yml: neither a regular file nor a folder'), res.stdout);
  });

  test('CWF-cli-usage: no --dir is a usage error; a folder without workflows fails every rule', async () => {
    assert.equal((await cli([], ROOT)).code, 2);
    assert.equal((await cli(['--dir', ROOT, '--extra'], ROOT)).code, 2);
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'cwf-empty-'));
    temps.push(empty);
    const res = await cli(['--dir', empty], ROOT);
    assert.equal(res.code, 1);
    assert.match(verdict(res.stdout), /^WORKFLOWS FAIL C-WF1( |$)/);
  });
});
