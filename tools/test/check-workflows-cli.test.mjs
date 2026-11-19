// CWF-cli-*: tools/check-workflows.mjs, this checkout's C-WF rules (tools/lib/wfrules.mjs) run over another checkout's workflows
// (docs/RUNBOOK.md "Before every index and mirror approval" step 1; stage-fixes A1, MP-2). The rules then guard what a run will
// execute, not only this repository's own files in a local `npm test`. The other checkout is a copy of this one; its own tools are
// replaced by modules that record that they ran, so a pass or a failure can only come from the trusted copy. No network.
import { after, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
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
const cli = (args, cwd) => new Promise((resolve) => {
  execFile(process.execPath, [TOOL, ...args], { cwd, encoding: 'utf8', timeout: 120_000, maxBuffer: 16 * 1024 * 1024 },
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
