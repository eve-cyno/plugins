// MS-*: the source check of the sign jobs' step "Check that minisign is Ubuntu's" (publish.yml and resign.yml). Its matcher,
// `good()`, lives only in the step's shell text, so the test takes that line from the parsed workflows (the run text GitHub hands to
// bash) and runs it in bash with LC_ALL=C, as the step does: the real bytes and bash's own regex reading, no copy of the pattern.
// Only bash runs here: no apt, no network, no workflow.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { loadWorkflows } from '../lib/wfrules.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const STEP = "Check that minisign is Ubuntu's";
const real = loadWorkflows(ROOT);

/** The one `good() { ... }` line of the source check in workflow `f`'s sign job, after its `export LC_ALL=C`. */
function goodLine(f) {
  assert.deepEqual(real.errors, [], 'the workflows load');
  const steps = real.wf[f]?.doc?.jobs?.sign?.steps ?? [];
  const runs = steps.filter((s) => s && s.name === STEP).map((s) => s.run);
  assert.equal(runs.length, 1, `${f} job sign has one step ${JSON.stringify(STEP)}`);
  const lines = runs[0].split('\n');
  const at = lines.flatMap((l, k) => (l.startsWith('good() {') ? [k] : []));
  assert.equal(at.length, 1, `${f}: the step defines good() on exactly one line`);
  const lc = lines.indexOf('export LC_ALL=C');
  assert.ok(lc >= 0 && lc < at[0], `${f}: the step sets LC_ALL=C before good()`);
  return lines[at[0]];
}

/** Each url with what bash's good() answers for it: 'pass' or 'fail'. */
function verdicts(line, urls) {
  const script = `${line}\nfor u in "$@"; do if good "$u"; then echo pass; else echo fail; fi; done\n`;
  const r = spawnSync('bash', ['-c', script, 'bash', ...urls], { encoding: 'utf8', env: { PATH: process.env.PATH, LC_ALL: 'C' } });
  assert.equal(r.status, 0, `bash ran good(): ${r.stderr}`);
  const out = r.stdout.trimEnd().split('\n');
  assert.equal(out.length, urls.length, `one answer per url: ${r.stdout}`);
  return Object.fromEntries(urls.map((u, k) => [u, out[k]]));
}

const PASS = [
  // GitHub-hosted runners in Amazon EC2 list Canonical's regional EC2 mirror (run 44801450424 named this one).
  'http://us-east-2.ec2.archive.ubuntu.com/ubuntu/',
  'https://us-east-2.ec2.archive.ubuntu.com/ubuntu',
  'http://azure.archive.ubuntu.com/ubuntu/',
  'http://archive.ubuntu.com/ubuntu/',
  'https://archive.ubuntu.com/ubuntu',
  'https://security.ubuntu.com/ubuntu/',
];
const FAIL = [
  'http://a.b.ec2.archive.ubuntu.com/ubuntu/',
  'http://evil.com/archive.ubuntu.com/ubuntu/',
  'http://archive.ubuntu.com.evil.com/ubuntu/',
  'http://us-east-2.ec2.archive.ubuntu.com.evil/ubuntu/',
  'http://x.ec2.archive.ubuntu.com/debian/',
  'http://.ec2.archive.ubuntu.com/ubuntu/',
  'http://US-EAST-2.ec2.archive.ubuntu.com/ubuntu/',
  'http://us-east-2.ec2.archive.ubuntu.com:8080/ubuntu/',
  'http://us-east-2.ec2.archive.ubuntu.com/ubuntu/x',
  'http://us-east-2_ec2.archive.ubuntu.com/ubuntu/',
  'http://us_east_2.ec2.archive.ubuntu.com/ubuntu/',
  'http://us-east-2.ec2xarchive.ubuntu.com/ubuntu/',
  'http://us-east-2.ec2.security.ubuntu.com/ubuntu/',
  'mirror+http://us-east-2.ec2.archive.ubuntu.com/ubuntu/',
  'ftp://us-east-2.ec2.archive.ubuntu.com/ubuntu/',
  'http://us-east-2.ec2.archive.ubuntu.com/ubuntu/\nhttp://evil.com/',
  '',
];

describe("MS the sign jobs' minisign source check", () => {
  test('MS-same: both sign jobs define the same good() line', () => {
    assert.equal(goodLine('publish.yml'), goodLine('resign.yml'));
  });
  for (const f of ['publish.yml', 'resign.yml']) {
    test(`MS-pass ${f}: the Ubuntu archive, its security host and Canonical's mirrors pass`, () => {
      assert.deepEqual(verdicts(goodLine(f), PASS), Object.fromEntries(PASS.map((u) => [u, 'pass'])));
    });
    test(`MS-fail ${f}: another host, another path or a deeper name fails`, () => {
      assert.deepEqual(verdicts(goodLine(f), FAIL), Object.fromEntries(FAIL.map((u) => [u, 'fail'])));
    });
  }
});
