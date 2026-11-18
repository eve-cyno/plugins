// Tests of tools/check-envs.mjs (C-ENV1, plan 4.1). GitHub is a stub gh on PATH (ghstub.mjs) that answers from canned bodies shaped
// like GitHub's REST answers; the reviewer file comes from a temp git repository. The probe rule is fail-closed: only HTTP 403 with
// the exact message "Resource not accessible by personal access token" and an x-ratelimit-remaining above 0 passes.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { after, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { PROBE_MESSAGE, checkEnvs } from '../check-envs.mjs';
import { makeGhStub, repoWithReviewer, stubEnv } from './ghstub.mjs';

const TOOL = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'check-envs.mjs');
const temps = [];
after(() => { for (const t of temps) fs.rmSync(t, { recursive: true, force: true }); });
const BIN = makeGhStub(temps);

const REVIEWER = 4242;
const TOKEN_USER = 1001;
const R = 'repos/eve-cyno/plugins';
const good = repoWithReviewer(JSON.stringify({ reviewerId: REVIEWER }), undefined, temps);

/** An environment as GET /repos/{owner}/{repo}/environments/{name} answers it; `o` overrides single parts. */
function envDoc(name, o = {}) {
  return {
    id: 7, node_id: 'EN_x', name, url: `https://api.github.com/${R}/environments/${name}`,
    html_url: `https://github.com/eve-cyno/plugins/deployments/activity_log?environments_filter=${name}`,
    created_at: '2026-11-20T10:00:00Z', updated_at: '2026-11-20T10:00:00Z',
    can_admins_bypass: 'bypass' in o ? o.bypass : false,
    protection_rules: o.rules ?? [
      { id: 11, node_id: 'GA_r', prevent_self_review: 'selfReview' in o ? o.selfReview : true, type: 'required_reviewers',
        reviewers: o.reviewers ?? [{ type: 'User', reviewer: { login: 'reviewer-account', id: REVIEWER, type: 'User' } }] },
      { id: 12, node_id: 'GA_b', type: 'branch_policy' },
    ],
    deployment_branch_policy: 'dbp' in o ? o.dbp : { protected_branches: false, custom_branch_policies: true },
  };
}
const policies = (list = [{ id: 1, node_id: 'DBP_x', name: 'main', type: 'branch' }]) => [{ total_count: list.length, branch_policies: list }];
const TEXT = { 200: 'OK', 403: 'Forbidden', 404: 'Not Found', 429: 'Too Many Requests', 502: 'Bad Gateway' };
/** `gh api -i` output: status line, headers, a blank line, the body. */
function http(status, message, remaining = '4999') {
  const head = [`HTTP/2.0 ${status} ${TEXT[status] ?? 'X'}`, 'Content-Type: application/json; charset=utf-8', 'X-Ratelimit-Limit: 5000'];
  if (remaining !== null) head.push(`X-Ratelimit-Remaining: ${remaining}`);
  const body = status === 200 ? '[]' : JSON.stringify({ message, documentation_url: 'https://docs.github.com/rest', status: String(status) });
  return { stdout: `${head.join('\r\n')}\r\n\r\n${body}`, exit: status === 200 ? 0 : 1, stderr: status === 200 ? '' : `gh: ${message} (HTTP ${status})\n` };
}
const ADMIN = `GET ${R}/keys`;
const ACTIONS = `DELETE ${R}/actions/artifacts/1`;

function routes(o = {}) {
  return {
    'GET user': { stdout: { login: 'agent', id: o.user ?? TOKEN_USER, type: 'User' } },
    [`GET ${R}/environments/index`]: o.index ?? { stdout: envDoc('index') },
    [`GET ${R}/environments/mirror`]: o.mirror ?? { stdout: envDoc('mirror') },
    [`GET ${R}/environments/index/deployment-branch-policies?per_page=100`]: o.indexPolicies ?? { stdout: policies() },
    [`GET ${R}/environments/mirror/deployment-branch-policies?per_page=100`]: o.mirrorPolicies ?? { stdout: policies() },
    [ADMIN]: o.admin ?? http(403, PROBE_MESSAGE),
    [ACTIONS]: o.actions ?? http(403, PROBE_MESSAGE),
  };
}

async function run(o = {}, { repo = good, t2 = false, rev } = {}) {
  const { env, log } = stubEnv(BIN, routes(o), temps);
  const r = await checkEnvs({ rev: rev ?? repo.rev, repoDir: repo.dir, env, t2 });
  return { ...r, text: r.lines.join('\n'), calls: log() };
}
const fails = async (o, re, opts) => {
  const r = await run(o, opts);
  assert.equal(r.ok, false, r.text);
  assert.match(r.text, re);
  assert.match(r.text, /C-ENV1 FAIL/);
  return r;
};

describe('C-ENV1 settings', () => {
  test('CE-pass: both environments right and both probes refused: PASS, and only ids and settings are read', async () => {
    const r = await run();
    assert.equal(r.ok, true, r.text);
    assert.match(r.text, /C-ENV1 PASS/);
    assert.doesNotMatch(r.text, /reviewer-account|agent/, 'no login is printed');
    const endpoints = r.calls.map((a) => `${(a.find((x) => x.startsWith('--method=')) ?? '').slice(9)} ${a[a.length - 1]}`);
    assert.deepEqual(endpoints.sort(), Object.keys(routes()).sort(), 'exactly these requests, nothing that names a secret');
    for (const a of r.calls) {
      assert.ok(a.includes('--hostname=github.com'), `the host is an argument: ${a}`);
      assert.ok(!a.some((x) => /secrets/.test(x)), 'no secret endpoint');
    }
    for (const key of [ADMIN, ACTIONS]) {
      const a = r.calls.find((c) => `${(c.find((x) => x.startsWith('--method=')) ?? '').slice(9)} ${c[c.length - 1]}` === key);
      assert.ok(a.includes('-i'), `${key} is read with its status line and headers`);
    }
  });
  test('CE-reviewer-at-rev: the reviewer id comes from the file at <B>, never from the working tree', async () => {
    const repo = repoWithReviewer(JSON.stringify({ reviewerId: REVIEWER }), JSON.stringify({ reviewerId: 777 }), temps);
    assert.equal((await run({}, { repo })).ok, true);
    const other = { stdout: envDoc('index', { reviewers: [{ type: 'User', reviewer: { login: 'x', id: 777, type: 'User' } }] }) };
    await fails({ index: other }, /environment index: the required reviewer is user 777, not the reviewer id 4242/, { repo });
  });
  test('CE-placeholder: the committed placeholder fails', async () => {
    const repo = repoWithReviewer(JSON.stringify({ reviewerId: 0, placeholder: 'PLACEHOLDER' }), undefined, temps);
    await fails({}, /placeholder/, { repo });
  });
  test('CE-reviewer-file-missing: no reviewer file at <B> fails', async () => {
    const r = await run({}, { rev: '0'.repeat(40) });
    assert.equal(r.ok, false);
    assert.match(r.text, /reviewer file at 0{40}/);
  });
  test('CE-reviewer-is-token-user: the token\'s own account as reviewer fails', async () => {
    await fails({ user: REVIEWER }, /the token's account \(4242\) is the reviewer/);
  });
  test('CE-bypass-on fails', async () => { await fails({ mirror: { stdout: envDoc('mirror', { bypass: true }) } }, /environment mirror: can_admins_bypass is true/); });
  test('CE-bypass-missing fails', async () => { await fails({ index: { stdout: envDoc('index', { bypass: undefined }) } }, /environment index: can_admins_bypass is missing/); });
  test('CE-self-review-off fails', async () => { await fails({ index: { stdout: envDoc('index', { selfReview: false }) } }, /environment index: prevent_self_review is not true/); });
  test('CE-two-reviewers fails', async () => {
    const reviewers = [{ type: 'User', reviewer: { id: REVIEWER } }, { type: 'User', reviewer: { id: 9 } }];
    await fails({ mirror: { stdout: envDoc('mirror', { reviewers }) } }, /environment mirror: 2 required reviewers, expected exactly 1/);
  });
  test('CE-team-reviewer fails', async () => {
    await fails({ index: { stdout: envDoc('index', { reviewers: [{ type: 'Team', reviewer: { id: REVIEWER } }] }) } }, /environment index: the required reviewer is a Team/);
  });
  test('CE-no-reviewer-rule fails', async () => {
    await fails({ index: { stdout: envDoc('index', { rules: [{ id: 12, type: 'branch_policy' }] }) } }, /environment index: 0 required_reviewers rules/);
  });
  test('CE-unknown-rule fails', async () => {
    const rules = [...envDoc('index').protection_rules, { id: 13, type: 'custom_app' }];
    await fails({ index: { stdout: envDoc('index', { rules }) } }, /environment index: a protection rule of type custom_app/);
  });
  test('CE-all-branches fails', async () => { await fails({ mirror: { stdout: envDoc('mirror', { dbp: null }) } }, /environment mirror: deployment branches are not main only/); });
  test('CE-protected-branches fails', async () => {
    await fails({ index: { stdout: envDoc('index', { dbp: { protected_branches: true, custom_branch_policies: false } }) } }, /environment index: deployment branches are not main only/);
  });
  test('CE-branch-policy-both-or-neither fails', async () => {
    await fails({ index: { stdout: envDoc('index', { dbp: { protected_branches: true, custom_branch_policies: true } }) } }, /environment index: deployment branches are not main only/);
    await fails({ mirror: { stdout: envDoc('mirror', { dbp: { protected_branches: false, custom_branch_policies: false } }) } }, /environment mirror: deployment branches are not main only/);
  });
  test('CE-other-branch fails', async () => {
    await fails({ indexPolicies: { stdout: policies([{ name: 'release', type: 'branch' }]) } }, /environment index: branch policies release; expected exactly main/);
  });
  test('CE-second-branch fails', async () => {
    await fails({ mirror: { stdout: envDoc('mirror') }, mirrorPolicies: { stdout: policies([{ name: 'main', type: 'branch' }, { name: 'release', type: 'branch' }]) } }, /environment mirror: branch policies main, release; expected exactly main/);
  });
  test('CE-tag-policy fails', async () => {
    await fails({ indexPolicies: { stdout: policies([{ name: 'main', type: 'tag' }]) } }, /environment index: branch policies main \(tag\); expected exactly main/);
  });
  test('CE-policies-incomplete fails', async () => {
    await fails({ indexPolicies: { stdout: [{ total_count: 2, branch_policies: [{ name: 'main', type: 'branch' }] }] } }, /environment index: .*the list is incomplete/);
  });
  test('CE-environment-missing fails', async () => {
    await fails({ mirror: { stdout: '{"message":"Not Found","status":"404"}', exit: 1, stderr: 'gh: Not Found (HTTP 404)\n' } }, /environment mirror: .*exited 1/);
  });
});

describe('C-ENV1 Administration probe (GET repos/eve-cyno/plugins/keys)', () => {
  test('CE-probe-only-403: 403, the exact message and x-ratelimit-remaining above 0 pass', async () => {
    const r = await run({ admin: http(403, PROBE_MESSAGE, '1') });
    assert.equal(r.ok, true, r.text);
    assert.match(r.text, /PASS probe Administration/);
  });
  test('CE-probe-ratelimit-403: x-ratelimit-remaining 0 fails', async () => { await fails({ admin: http(403, PROBE_MESSAGE, '0') }, /FAIL probe Administration: .*x-ratelimit-remaining 0/); });
  test('CE-probe-ratelimit-missing: no x-ratelimit-remaining fails', async () => { await fails({ admin: http(403, PROBE_MESSAGE, null) }, /FAIL probe Administration: .*x-ratelimit-remaining missing/); });
  test('CE-probe-ratelimit-twice: two x-ratelimit-remaining headers fail', async () => {
    const a = http(403, PROBE_MESSAGE, '4999');
    await fails({ admin: { ...a, stdout: a.stdout.replace('X-Ratelimit-Remaining: 4999', 'X-Ratelimit-Remaining: 4999\r\nX-Ratelimit-Remaining: 0') } }, /FAIL probe Administration: .*x-ratelimit-remaining 4999, 0/);
  });
  test('CE-probe-429 fails', async () => { await fails({ admin: http(429, 'API rate limit exceeded') }, /FAIL probe Administration: HTTP 429/); });
  test('CE-probe-other-message fails', async () => { await fails({ admin: http(403, 'API rate limit exceeded for user ID 1001.') }, /FAIL probe Administration: HTTP 403 with message "API rate limit exceeded/); });
  test('CE-probe-2xx fails', async () => { await fails({ admin: http(200) }, /FAIL probe Administration: HTTP 200/); });
  test('CE-probe-404 fails', async () => { await fails({ admin: http(404, 'Not Found') }, /FAIL probe Administration: HTTP 404/); });
  test('CE-probe-5xx fails', async () => { await fails({ admin: http(502, 'Server Error') }, /FAIL probe Administration: HTTP 502/); });
  test('CE-probe-network-error fails', async () => { await fails({ admin: { stdout: '', stderr: 'error connecting to api.github.com\n', exit: 1 } }, /FAIL probe Administration: no answer/); });
  test('CE-probe-two-answers fails', async () => {
    const one = http(403, PROBE_MESSAGE).stdout;
    await fails({ admin: { stdout: `${one}\r\n\r\n${one}`, exit: 1 } }, /FAIL probe Administration: no answer/);
  });
});

describe('C-ENV1 Actions-write probe (DELETE repos/eve-cyno/plugins/actions/artifacts/1)', () => {
  test('CE-actions-probe-only-403: 403, the exact message and x-ratelimit-remaining above 0 pass', async () => {
    const r = await run({ actions: http(403, PROBE_MESSAGE, '4999') });
    assert.equal(r.ok, true, r.text);
    assert.match(r.text, /PASS probe Actions write/);
  });
  test('CE-actions-probe-404-fails: a 404 means the token could delete artifacts', async () => { await fails({ actions: http(404, 'Not Found') }, /FAIL probe Actions write: HTTP 404 \(the token could delete workflow runs and artifacts\)/); });
  test('CE-actions-probe-ratelimit-403 fails', async () => { await fails({ actions: http(403, PROBE_MESSAGE, '0') }, /FAIL probe Actions write: .*x-ratelimit-remaining 0/); });
  test('CE-actions-probe-429 fails', async () => { await fails({ actions: http(429, 'API rate limit exceeded') }, /FAIL probe Actions write: HTTP 429/); });
  test('CE-actions-probe-other-message fails', async () => { await fails({ actions: http(403, 'Must have admin rights to Repository.') }, /FAIL probe Actions write: HTTP 403 with message "Must have admin rights/); });
  test('CE-actions-probe-204 fails', async () => { await fails({ actions: { stdout: 'HTTP/2.0 204 No Content\r\nX-Ratelimit-Remaining: 4999\r\n\r\n', exit: 0 } }, /FAIL probe Actions write: HTTP 204/); });
});

describe('C-ENV1 modes and command line', () => {
  test('CE-t2-skips-probes: --t2 sends no probe and says so', async () => {
    const r = await run({ admin: http(404, 'Not Found'), actions: http(404, 'Not Found') }, { t2: true });
    assert.equal(r.ok, true, r.text);
    assert.match(r.text, /T2: the owner accepted the token residual; no probe sent/);
    assert.ok(!r.calls.some((a) => a.includes('-i')), 'no probe request');
  });
  test('CE-cli: exit 0 on a pass, 1 on a failure, 2 on a usage error', () => {
    const cli = (args, o = {}) => {
      const { env } = stubEnv(BIN, routes(o), temps);
      return spawnSync(process.execPath, [TOOL, ...args], { encoding: 'utf8', env, cwd: good.dir });
    };
    const pass = cli(['--rev', good.rev, '--repo-dir', good.dir]);
    assert.equal(pass.status, 0, pass.stdout + pass.stderr);
    assert.equal(cli(['--rev', good.rev, '--repo-dir', good.dir], { admin: http(404, 'Not Found') }).status, 1);
    assert.equal(cli(['--rev', 'main', '--repo-dir', good.dir]).status, 2);
    assert.equal(cli(['--repo-dir', good.dir]).status, 2);
    assert.equal(cli(['--rev', good.rev, '--repo-dir', good.dir, '--t3']).status, 2);
  });
});
