// Tests of tools/check-envs.mjs (C-ENV1, plan 4.1). GitHub is a stub gh on PATH (ghstub.mjs) that answers from canned bodies shaped
// like GitHub's REST answers; the run's commit <B> is a temp git repository. The reviewer is read from the environments, never from
// the repository, and its login and id must appear nowhere at <B>. The probe rule is fail-closed: a refusal probe passes only on HTTP
// 403 with the exact message "Resource not accessible by personal access token" and an x-ratelimit-remaining above 0, and the two
// secrets lists (Secrets and Environments, granted for good on 2026-11-18) only on HTTP 200 with a list of secrets. The six secrets
// and variables the workflows read are listed with their updated_at in their environments, the two variables' values are checked
// and never printed, and none of the names MINISIGN_* and R2_* may be set at repository or organization level.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { after, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { PROBES, PROBE_ENV, PROBE_MESSAGE, checkEnvs } from '../check-envs.mjs';
import { REVIEWER, envDoc, makeGhStub, repoWith, stubEnv, userReviewer } from './ghstub.mjs';

const TOOL = fileURLToPath(new URL('../check-envs.mjs', import.meta.url));
const temps = [];
after(() => { for (const t of temps) fs.rmSync(t, { recursive: true, force: true }); });
const BIN = makeGhStub(temps);

const R = 'repos/eve-cyno/plugins';
const good = repoWith({ 'README.md': 'The plugin index.\n', 'tools/x.mjs': 'export const n = 19876543;\nexport const s = "reviewer-accounts";\n' }, temps);
/** The login or the id of the test reviewer, anywhere in a text. */
const NAMES_REVIEWER = new RegExp(`${REVIEWER.login}|${REVIEWER.id}`, 'i');

const policies = (list = [{ id: 1, node_id: 'DBP_x', name: 'main', type: 'branch' }]) => [{ total_count: list.length, branch_policies: list }];
const TEXT = { 200: 'OK', 204: 'No Content', 403: 'Forbidden', 404: 'Not Found', 422: 'Unprocessable Entity', 429: 'Too Many Requests', 502: 'Bad Gateway' };
/** `gh api -i` output: status line, headers, a blank line, the body (an empty list of secrets on a 2xx unless `body` is given). */
function http(status, message, remaining = '4999', body) {
  const head = [`HTTP/2.0 ${status} ${TEXT[status] ?? 'X'}`, 'Content-Type: application/json; charset=utf-8', 'X-Ratelimit-Limit: 5000'];
  if (remaining !== null) head.push(`X-Ratelimit-Remaining: ${remaining}`);
  const ok = status < 300;
  body ??= ok ? '{"total_count":0,"secrets":[]}' : JSON.stringify({ message, documentation_url: 'https://docs.github.com/rest', status: String(status) });
  return { stdout: `${head.join('\r\n')}\r\n\r\n${body}`, exit: ok ? 0 : 1, stderr: ok ? '' : `gh: ${message} (HTTP ${status})\n` };
}
const keyOf = (a) => `${(a.find((x) => x.startsWith('--method=')) ?? '').slice(9)} ${a[a.length - 1]}`;
const probeKey = (pr) => `${pr.method} ${pr.endpoint}`;
const ENV_GET = `GET ${R}/environments/${PROBE_ENV}`;
const ENV_PUT = `PUT ${R}/environments/${PROBE_ENV}`;
const ALLOWED = PROBES.filter((p) => p.expect === 200);
const DENIED = PROBES.filter((p) => p.expect === 403);

const STAMP = '2026-11-18T19:00:00Z';
const ACCOUNT = '0123456789abcdef0123456789abcdef';
const secretList = (names, at = STAMP) => [{ total_count: names.length, secrets: names.map((name) => ({ name, created_at: '2026-11-01T08:00:00Z', updated_at: at })) }];
const variableList = (vars, at = STAMP) => [{ total_count: vars.length, variables: vars.map(([name, value]) => ({ name, value, created_at: '2026-11-01T08:00:00Z', updated_at: at })) }];
const STORED = {
  indexSecrets: `GET ${R}/environments/index/secrets?per_page=100`,
  mirrorSecrets: `GET ${R}/environments/mirror/secrets?per_page=100`,
  mirrorVariables: `GET ${R}/environments/mirror/variables?per_page=30`,
  repoSecrets: `GET ${R}/actions/secrets?per_page=100`,
  orgSecrets: `GET ${R}/actions/organization-secrets?per_page=100`,
  repoVariables: `GET ${R}/actions/variables?per_page=30`,
  orgVariables: `GET ${R}/actions/organization-variables?per_page=30`,
};
const STORED_DEFAULT = {
  indexSecrets: { stdout: secretList(['MINISIGN_INDEX_KEY', 'MINISIGN_INDEX_PASSWORD']) },
  mirrorSecrets: { stdout: secretList(['R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY']) },
  mirrorVariables: { stdout: variableList([['R2_ACCOUNT_ID', ACCOUNT], ['R2_BUCKET', 'eve-cyno-plugins']]) },
  repoSecrets: { stdout: secretList(['DISCORD_WEBHOOK']) },
  orgSecrets: { stdout: secretList([]) },
  repoVariables: { stdout: variableList([['SITE', 'plugins.eve-cyno.dev']]) },
  orgVariables: { stdout: variableList([]) },
};

function routes(o = {}) {
  const r = {
    [`GET ${R}/environments/index`]: o.index ?? { stdout: envDoc('index') },
    [`GET ${R}/environments/mirror`]: o.mirror ?? { stdout: envDoc('mirror') },
    [`GET ${R}/environments/index/deployment-branch-policies?per_page=100`]: o.indexPolicies ?? { stdout: policies() },
    [`GET ${R}/environments/mirror/deployment-branch-policies?per_page=100`]: o.mirrorPolicies ?? { stdout: policies() },
  };
  for (const pr of PROBES) r[probeKey(pr)] = o.probes?.[pr.key] ?? (pr.expect === 200 ? http(200) : http(403, PROBE_MESSAGE));
  r[ENV_GET] = o.probeEnvGet ?? http(404, 'Not Found');
  for (const [k, route] of Object.entries(STORED)) r[route] = o.stored?.[k] ?? STORED_DEFAULT[k];
  return r;
}

async function run(o = {}, { repo = good, rev } = {}) {
  const { env, log } = stubEnv(BIN, routes(o), temps);
  const r = await checkEnvs({ rev: rev ?? repo.rev, repoDir: repo.dir, env });
  assert.equal(r.lines.some((l) => l.startsWith('ALARM')), r.alarms.length > 0, 'every alarm is also an output line');
  return { ...r, text: r.lines.join('\n'), calls: log() };
}
const fails = async (o, re, opts) => {
  const r = await run(o, opts);
  assert.equal(r.ok, false, r.text);
  assert.match(r.text, re);
  assert.match(r.text, /C-ENV1 FAIL/);
  assert.doesNotMatch(r.text, NAMES_REVIEWER, 'the reviewer\'s login and id are never printed');
  return r;
};

describe('C-ENV1 settings', () => {
  test('CE-pass: both environments right, <B> clean, the four refusals 403 and the two secrets lists 200: PASS; only ids, settings and secret names are read', async () => {
    const r = await run();
    assert.equal(r.ok, true, r.text);
    assert.match(r.text, /C-ENV1 PASS/);
    assert.doesNotMatch(r.text, NAMES_REVIEWER, 'neither the reviewer\'s login nor its id is printed');
    assert.deepEqual(r.calls.map(keyOf).sort(), Object.keys(routes()).sort(), 'exactly these requests');
    for (const a of r.calls) assert.ok(a.includes('--hostname=github.com'), `the host is an argument: ${a}`);
    const secretReads = r.calls.filter((a) => /secrets|variables/.test(a[a.length - 1])).map(keyOf).sort();
    assert.deepEqual(secretReads, [`GET ${R}/actions/secrets`, `GET ${R}/environments/index/secrets`, ...Object.values(STORED)].sort(),
      'the two probes and the lists of secrets and variables, all GET');
    for (const k of [...PROBES.map(probeKey), ENV_GET]) {
      const a = r.calls.find((c) => keyOf(c) === k);
      assert.ok(a.includes('-i'), `${k} is read with its status line and headers`);
    }
    for (const pr of ALLOWED) assert.match(r.text, new RegExp(`PASS probe ${pr.name}: GET \\S+ answered HTTP 200 \\(allowed`));
    for (const pr of DENIED) assert.match(r.text, new RegExp(`PASS probe ${pr.name.replace(/[()]/g, '\\$&')}: ${pr.method} \\S+ answered HTTP 403 "`));
    assert.deepEqual(r.alarms, []);
  });
  test('CE-probe-set: the six probes; Secrets and Environments are allowed (owner 2026-11-18), the other four refused', () => {
    assert.deepEqual(PROBES.map((p) => [p.key, p.name, p.expect, p.method, p.endpoint]), [
      ['admin', 'Administration', 403, 'GET', `${R}/keys`],
      ['env', 'Environments', 200, 'GET', `${R}/environments/index/secrets`],
      ['secrets', 'Secrets', 200, 'GET', `${R}/actions/secrets`],
      ['deploy', 'Deployments (approve)', 403, 'POST', `${R}/actions/runs/1/pending_deployments`],
      ['actions', 'Actions write', 403, 'DELETE', `${R}/actions/artifacts/1`],
      ['envcreate', 'Administration (create environment)', 403, 'PUT', `${R}/environments/c-env1-probe-denied`],
    ]);
    assert.equal(PROBE_ENV, 'c-env1-probe-denied');
  });
  test('CE-probe-deploy-body: the approve probe names run 1 and asks to reject, so even a wrongly allowed token approves nothing', async () => {
    const r = await run();
    const a = r.calls.find((c) => keyOf(c) === `POST ${R}/actions/runs/1/pending_deployments`);
    assert.deepEqual(a.slice(a.indexOf('-f'), -1), ['-f', 'state=rejected', '-f', 'comment=C-ENV1 probe: changes nothing', '-F', 'environment_ids[]=1']);
    for (const c of r.calls) if (c !== a) assert.ok(!c.includes('-f') && !c.includes('-F'), `no body on ${keyOf(c)}`);
  });
  test('CE-reviewer-from-api: the reviewer is the environments\' own, whoever it is', async () => {
    const other = [userReviewer(4321, 'someone-else')];
    const r = await run({ index: { stdout: envDoc('index', { reviewers: other }) }, mirror: { stdout: envDoc('mirror', { reviewers: other }) } });
    assert.equal(r.ok, true, r.text);
  });
  test('CE-mirror-other-reviewer fails', async () => {
    await fails({ mirror: { stdout: envDoc('mirror', { reviewers: [userReviewer(777)] }) } }, /FAIL reviewer: index and mirror name different reviewers/);
  });
  test('CE-bypass-on fails', async () => { await fails({ mirror: { stdout: envDoc('mirror', { bypass: true }) } }, /environment mirror: can_admins_bypass is true/); });
  test('CE-bypass-missing fails', async () => { await fails({ index: { stdout: envDoc('index', { bypass: undefined }) } }, /environment index: can_admins_bypass is missing/); });
  test('CE-self-review-on fails: the owner dispatches and approves, so prevent_self_review must be false', async () => {
    await fails({ index: { stdout: envDoc('index', { selfReview: true }) } }, /environment index: prevent_self_review is true, expected false/);
  });
  test('CE-self-review-missing fails', async () => { await fails({ mirror: { stdout: envDoc('mirror', { selfReview: undefined }) } }, /environment mirror: prevent_self_review is missing, expected false/); });
  test('CE-two-reviewers fails', async () => {
    await fails({ mirror: { stdout: envDoc('mirror', { reviewers: [userReviewer(REVIEWER.id, REVIEWER.login), userReviewer(9)] }) } }, /environment mirror: 2 required reviewers, expected exactly 1/);
  });
  test('CE-team-reviewer fails', async () => {
    await fails({ index: { stdout: envDoc('index', { reviewers: [{ type: 'Team', reviewer: { id: 5, slug: 'maintainers' } }] }) } }, /environment index: the required reviewer is a Team/);
  });
  test('CE-no-reviewer-rule fails', async () => {
    await fails({ index: { stdout: envDoc('index', { rules: [{ id: 12, type: 'branch_policy' }] }) } }, /environment index: 0 required_reviewers rules/);
  });
  test('CE-wait-timer fails', async () => {
    const rules = [...envDoc('index').protection_rules, { id: 13, node_id: 'GA_w', type: 'wait_timer', wait_timer: 30 }];
    await fails({ index: { stdout: envDoc('index', { rules }) } }, /environment index: a protection rule of type wait_timer/);
  });
  test('CE-unknown-rule fails', async () => {
    const rules = [...envDoc('mirror').protection_rules, { id: 13, type: 'custom_app' }];
    await fails({ mirror: { stdout: envDoc('mirror', { rules }) } }, /environment mirror: a protection rule of type custom_app/);
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
    await fails({ mirrorPolicies: { stdout: policies([{ name: 'main', type: 'branch' }, { name: 'release', type: 'branch' }]) } }, /environment mirror: branch policies main, release; expected exactly main/);
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

describe('C-ENV1 the reviewer\'s login and id appear nowhere at <B>', () => {
  const author = { name: 'test', email: 'test@example.invalid' };
  test('CE-identity-clean: a longer word or number that holds them is not a hit', async () => {
    const r = await run();
    assert.match(r.text, /PASS identity: the required reviewer's login and id appear in no path, file or commit at <B>/);
  });
  test('CE-identity-file-login fails (any case)', async () => {
    const repo = repoWith({ 'docs/RUNBOOK.md': 'Approved by Reviewer-Account from the phone.\n' }, temps);
    await fails({}, /FAIL identity: .*in 1 file \(docs\/RUNBOOK\.md\)/, { repo });
  });
  test('CE-identity-file-id fails', async () => {
    const repo = repoWith({ 'tools/reviewer.json': `{"reviewerId": ${REVIEWER.id}}\n`, 'a.txt': 'x\n' }, temps);
    await fails({}, /FAIL identity: .*in 1 file \(tools\/reviewer\.json\)/, { repo });
  });
  test('CE-identity-path fails, and the path is printed with the login masked', async () => {
    const repo = repoWith({ [`notes/${REVIEWER.login}.md`]: 'x\n' }, temps);
    await fails({}, /FAIL identity: .*in 1 path \(notes\/<login>\.md\)/, { repo });
  });
  test('CE-identity-commit-author fails (a GitHub noreply address names both)', async () => {
    const repo = repoWith({ 'a.txt': 'x\n' }, temps, { author: { name: 'Someone', email: `${REVIEWER.id}+${REVIEWER.login}@users.noreply.github.com` } });
    const r = await fails({}, /FAIL identity: .*in 1 commit \([0-9a-f]{40}\)/, { repo });
    assert.match(r.text, new RegExp(repo.rev));
  });
  test('CE-identity-commit-message fails', async () => {
    const repo = repoWith({ 'a.txt': 'x\n' }, temps, { author, message: `merge for ${REVIEWER.login}` });
    await fails({}, /FAIL identity: .*in 1 commit/, { repo });
  });
  test('CE-identity-at-B-only: a later commit is not <B>\'s concern, <B> is read, not the checkout', async () => {
    const repo = repoWith({ 'a.txt': 'x\n' }, temps, { later: { 'a.txt': `${REVIEWER.login}\n` } });
    assert.equal((await run({}, { repo })).ok, true);
  });
  test('CE-identity-rev-missing fails', async () => {
    await fails({}, /FAIL identity: the commit 0{40} could not be read/, { rev: '0'.repeat(40) });
  });
  test('CE-identity-no-reviewer fails: with no reviewer read there is nothing to look for', async () => {
    await fails({ index: { stdout: envDoc('index', { reviewers: [] }) }, mirror: { stdout: envDoc('mirror', { reviewers: [] }) } }, /FAIL identity: no reviewer was read/);
  });
});

describe('C-ENV1 the six probes of the agents\' token', () => {
  test('CE-probe-split: four refusals and two secrets lists, each list read only', () => {
    assert.deepEqual(DENIED.map((p) => p.key), ['admin', 'deploy', 'actions', 'envcreate']);
    assert.deepEqual(ALLOWED.map((p) => [p.key, p.method]), [['env', 'GET'], ['secrets', 'GET']]);
  });
  for (const pr of ALLOWED) {
    const at = (answer) => ({ probes: { [pr.key]: answer } });
    test(`CE-probe-${pr.key}-only-200: HTTP 200 with a list of secrets passes`, async () => {
      const r = await run(at(http(200, null, '4999', '{"total_count":2,"secrets":[{"name":"A"},{"name":"B"}]}')));
      assert.equal(r.ok, true, r.text);
      assert.match(r.text, new RegExp(`PASS probe ${pr.name}: GET ${pr.endpoint} answered HTTP 200 \\(allowed`));
    });
    test(`CE-probe-${pr.key}-403-fails: the agents' token holds Secrets and Environments for good, so a refusal fails`, async () => {
      await fails(at(http(403, PROBE_MESSAGE)), new RegExp(`FAIL probe ${pr.name}: HTTP 403, expected 200 \\(the agents' token holds Secrets and Environments`));
    });
    test(`CE-probe-${pr.key}-404-fails`, async () => { await fails(at(http(404, 'Not Found')), new RegExp(`FAIL probe ${pr.name}: HTTP 404, expected 200`)); });
    test(`CE-probe-${pr.key}-429 fails`, async () => { await fails(at(http(429, 'API rate limit exceeded')), new RegExp(`FAIL probe ${pr.name}: HTTP 429, expected 200`)); });
    test(`CE-probe-${pr.key}-204 fails: only 200`, async () => { await fails(at(http(204)), new RegExp(`FAIL probe ${pr.name}: HTTP 204, expected 200`)); });
    for (const [what, body] of [['no list', '{"total_count":0}'], ['a count that is not a number', '{"total_count":"0","secrets":[]}'], ['not JSON', '<html></html>'], ['a message', '{"message":"x"}']]) {
      test(`CE-probe-${pr.key}-not-a-list fails (${what})`, async () => {
        await fails(at(http(200, null, '4999', body)), new RegExp(`FAIL probe ${pr.name}: HTTP 200 but not a list of secrets`));
      });
    }
  }
  test('CE-probe-secret-names-not-printed: the probes print no name of their lists', async () => {
    const list = '{"total_count":2,"secrets":[{"name":"PROBE_ONLY_NAME","created_at":"2026-11-18T19:00:00Z"},{"name":"OTHER_PROBE_NAME"}]}';
    const r = await run({ probes: { env: http(200, null, '4999', list), secrets: http(200, null, '4999', list) } });
    assert.equal(r.ok, true, r.text);
    assert.doesNotMatch(r.text, /PROBE_ONLY_NAME|OTHER_PROBE_NAME|created_at/);
  });
  for (const pr of DENIED) {
    const name = pr.name.replace(/[()]/g, '\\$&');
    const at = (answer) => ({ probes: { [pr.key]: answer } });
    test(`CE-probe-${pr.key}-only-403: 403, the exact message and x-ratelimit-remaining above 0 pass`, async () => {
      const r = await run(at(http(403, PROBE_MESSAGE, '1')));
      assert.equal(r.ok, true, r.text);
      assert.match(r.text, new RegExp(`PASS probe ${name}: ${pr.method} `));
    });
    test(`CE-probe-${pr.key}-ratelimit-403: x-ratelimit-remaining 0 fails`, async () => { await fails(at(http(403, PROBE_MESSAGE, '0')), new RegExp(`FAIL probe ${name}: .*x-ratelimit-remaining 0`)); });
    test(`CE-probe-${pr.key}-429 fails`, async () => { await fails(at(http(429, 'API rate limit exceeded')), new RegExp(`FAIL probe ${name}: HTTP 429`)); });
    test(`CE-probe-${pr.key}-other-message fails`, async () => { await fails(at(http(403, 'Must have admin rights to Repository.')), new RegExp(`FAIL probe ${name}: HTTP 403 with message "Must have admin rights`)); });
    test(`CE-probe-${pr.key}-404-fails`, async () => { await fails(at(http(404, 'Not Found')), new RegExp(`FAIL probe ${name}: HTTP 404`)); });
    test(`CE-probe-${pr.key}-2xx fails`, async () => { await fails(at(http(pr.method === 'GET' ? 200 : 204)), new RegExp(`FAIL probe ${name}: HTTP 20[04]`)); });
  }
  test('CE-probe-404-meaning: a 404 on a request for a run or artifact that does not exist says what the token could do', async () => {
    await fails({ probes: { deploy: http(404, 'Not Found') } }, /FAIL probe Deployments \(approve\): HTTP 404 \(the token may be able to approve deployments\)/);
    await fails({ probes: { actions: http(404, 'Not Found') } }, /FAIL probe Actions write: HTTP 404 \(the token may be able to delete workflow runs and artifacts\)/);
  });
  test('CE-probe-422 fails', async () => { await fails({ probes: { deploy: http(422, 'Validation Failed') } }, /FAIL probe Deployments \(approve\): HTTP 422/); });
  test('CE-probe-ratelimit-missing: no x-ratelimit-remaining fails', async () => { await fails({ probes: { admin: http(403, PROBE_MESSAGE, null) } }, /FAIL probe Administration: .*x-ratelimit-remaining missing/); });
  test('CE-probe-ratelimit-twice: two x-ratelimit-remaining headers fail', async () => {
    const a = http(403, PROBE_MESSAGE, '4999');
    await fails({ probes: { deploy: { ...a, stdout: a.stdout.replace('X-Ratelimit-Remaining: 4999', 'X-Ratelimit-Remaining: 4999\r\nX-Ratelimit-Remaining: 0') } } }, /FAIL probe Deployments \(approve\): .*x-ratelimit-remaining 4999, 0/);
  });
  test('CE-probe-envcreate-created: a token that may create an environment fails loudly and names the environment to delete', async () => {
    for (const status of [200, 201, 204]) {
      const r = await fails({ probes: { envcreate: http(status, null, '4999', '{"id":1,"name":"c-env1-probe-denied"}') } },
        new RegExp(`FAIL probe Administration \\(create environment\\): HTTP ${status}: the agents' token created or changed the environment c-env1-probe-denied`));
      assert.match(r.lines[0], /^ALARM: the agents' token created the environment c-env1-probe-denied in eve-cyno\/plugins: the owner deletes it \(Settings, Environments, c-env1-probe-denied, Delete environment\) and takes Administration off the token/);
      assert.equal(r.alarms.length, 1);
      assert.equal(r.alarms[0], r.lines[0]);
    }
  });
  test('CE-probe-envcreate-new-name: a GET that answers 404 confirms the name is new, right before the PUT', async () => {
    const r = await run();
    const keys = r.calls.map(keyOf);
    assert.equal(keys.indexOf(ENV_PUT) - keys.indexOf(ENV_GET), 1, keys.join('\n'));
  });
  test('CE-probe-envcreate-exists fails: the probe must name an environment that does not exist', async () => {
    const r = await fails({ probeEnvGet: http(200, null, '4999', '{"id":1,"name":"c-env1-probe-denied"}') },
      /FAIL probe Administration \(create environment\): the environment c-env1-probe-denied exists \(HTTP 200\); the owner deletes it \(Settings, Environments, c-env1-probe-denied, Delete environment\)/);
    assert.ok(!r.calls.map(keyOf).includes(ENV_PUT), 'no PUT unless the GET answered exactly 404');
  });
  test('CE-probe-envcreate-unconfirmed fails: anything but 404 on the GET, and the PUT is never sent', async () => {
    const a = await fails({ probeEnvGet: http(403, PROBE_MESSAGE) }, /FAIL probe Administration \(create environment\): could not confirm that the environment c-env1-probe-denied does not exist \(HTTP 403; expected 404\)/);
    const b = await fails({ probeEnvGet: { stdout: '', stderr: 'error connecting to api.github.com\n', exit: 1 } }, /FAIL probe Administration \(create environment\): could not confirm that the environment c-env1-probe-denied does not exist \(no answer/);
    const c = await fails({ probeEnvGet: http(502, 'Server Error') }, /could not confirm that the environment c-env1-probe-denied does not exist \(HTTP 502; expected 404\)/);
    for (const r of [a, b, c]) {
      assert.ok(!r.calls.map(keyOf).includes(ENV_PUT), 'no PUT unless the GET answered exactly 404');
      assert.deepEqual(r.alarms, []);
    }
  });
  test('CE-probe-5xx fails', async () => { await fails({ probes: { env: http(502, 'Server Error') } }, /FAIL probe Environments: HTTP 502/); });
  test('CE-probe-network-error fails', async () => { await fails({ probes: { admin: { stdout: '', stderr: 'error connecting to api.github.com\n', exit: 1 } } }, /FAIL probe Administration: no answer/); });
  test('CE-probe-two-answers fails', async () => {
    const one = http(403, PROBE_MESSAGE).stdout;
    await fails({ probes: { actions: { stdout: `${one}\r\n\r\n${one}`, exit: 1 } } }, /FAIL probe Actions write: no answer/);
  });
});

describe('C-ENV1 the secrets and variables the workflows read', () => {
  const SIX = [['secret', 'MINISIGN_INDEX_KEY', 'index'], ['secret', 'MINISIGN_INDEX_PASSWORD', 'index'], ['secret', 'R2_ACCESS_KEY_ID', 'mirror'],
    ['secret', 'R2_SECRET_ACCESS_KEY', 'mirror'], ['variable', 'R2_ACCOUNT_ID', 'mirror'], ['variable', 'R2_BUCKET', 'mirror']];
  test('CE-stored-updated-at: each of the six is printed with its environment and updated_at, for the reviewer to compare', async () => {
    const r = await run();
    assert.equal(r.ok, true, r.text);
    for (const [kind, name, env] of SIX) assert.match(r.text, new RegExp(`^PASS ${kind} ${name} \\(environment ${env}\\): updated_at ${STAMP}`, 'm'));
    assert.match(r.text, /^PASS variable R2_ACCOUNT_ID \(environment mirror\): updated_at \S+; the value is a Cloudflare account id \(32 lower-case hex; not printed\)$/m);
    assert.match(r.text, /^PASS variable R2_BUCKET \(environment mirror\): updated_at \S+; the value is the bucket the runbook names \(not printed\)$/m);
    assert.match(r.text, /^updated_at: compare each date above with the day the owner or the coordinator set that value/m);
    assert.doesNotMatch(r.text, new RegExp(ACCOUNT), 'the account id is never printed');
    assert.doesNotMatch(r.text, /eve-cyno-plugins/, 'nor the bucket name read from the variable');
    assert.doesNotMatch(r.text, /created_at|2026-11-01/, 'only updated_at');
    for (const what of ['repository secrets', 'organization secrets', 'repository variables', 'organization variables']) {
      assert.match(r.text, new RegExp(`^PASS ${what}: none named MINISIGN_\\* or R2_\\*`, 'm'));
    }
    assert.doesNotMatch(r.text, /plugins\.eve-cyno\.dev|DISCORD_WEBHOOK/, 'no other name or value is printed');
  });
  test('CE-stored-missing fails: each of the six must be set in its environment, once', async () => {
    await fails({ stored: { indexSecrets: { stdout: secretList(['MINISIGN_INDEX_KEY']) } } }, /^FAIL secret MINISIGN_INDEX_PASSWORD \(environment index\): not set$/m);
    await fails({ stored: { mirrorSecrets: { stdout: secretList(['R2_SECRET_ACCESS_KEY']) } } }, /^FAIL secret R2_ACCESS_KEY_ID \(environment mirror\): not set$/m);
    await fails({ stored: { mirrorVariables: { stdout: variableList([['R2_ACCOUNT_ID', ACCOUNT]]) } } }, /^FAIL variable R2_BUCKET \(environment mirror\): not set$/m);
    await fails({ stored: { mirrorVariables: { stdout: variableList([['R2_BUCKET', 'eve-cyno-plugins']]) } } }, /^FAIL variable R2_ACCOUNT_ID \(environment mirror\): not set$/m);
    await fails({ stored: { indexSecrets: { stdout: secretList(['MINISIGN_INDEX_KEY', 'MINISIGN_INDEX_KEY', 'MINISIGN_INDEX_PASSWORD']) } } }, /^FAIL secret MINISIGN_INDEX_KEY \(environment index\): listed 2 times$/m);
  });
  test('CE-stored-updated-at-invalid fails', async () => {
    for (const at of [undefined, '', 'yesterday', '2026-11-18', '2026-13-45T99:00:00Z']) {
      const list = [{ total_count: 2, secrets: [{ name: 'R2_ACCESS_KEY_ID', updated_at: at }, { name: 'R2_SECRET_ACCESS_KEY', updated_at: STAMP }] }];
      await fails({ stored: { mirrorSecrets: { stdout: list } } }, /^FAIL secret R2_ACCESS_KEY_ID \(environment mirror\): no valid updated_at$/m);
    }
  });
  test('CE-stored-values fail: R2_BUCKET is eve-cyno-plugins and R2_ACCOUNT_ID 32 lower-case hex; neither value is printed', async () => {
    for (const bucket of ['eve-cyno-plugins-old', 'EVE-CYNO-PLUGINS', '', null]) {
      const r = await fails({ stored: { mirrorVariables: { stdout: variableList([['R2_ACCOUNT_ID', ACCOUNT], ['R2_BUCKET', bucket]]) } } },
        /^FAIL variable R2_BUCKET \(environment mirror\): the value is not eve-cyno-plugins \(not printed\)$/m);
      if (bucket) assert.ok(!r.text.includes(bucket), 'the wrong value is not printed');
    }
    for (const id of [ACCOUNT.toUpperCase(), `${ACCOUNT}0`, ACCOUNT.slice(1), 'not-an-account-id-not-an-account', null]) {
      const r = await fails({ stored: { mirrorVariables: { stdout: variableList([['R2_ACCOUNT_ID', id], ['R2_BUCKET', 'eve-cyno-plugins']]) } } },
        /^FAIL variable R2_ACCOUNT_ID \(environment mirror\): the value is not a Cloudflare account id \(32 lower-case hex\) \(not printed\)$/m);
      if (id) assert.ok(!r.text.includes(id), 'the value is not printed');
    }
  });
  test('CE-stored-repo-or-org-level fails: MINISIGN_* or R2_* outside the environments reach jobs without an approval', async () => {
    const cases = [
      ['repoSecrets', { stdout: secretList(['DISCORD_WEBHOOK', 'R2_SECRET_ACCESS_KEY']) }, 'repository secrets', 'R2_SECRET_ACCESS_KEY'],
      ['orgSecrets', { stdout: secretList(['MINISIGN_INDEX_KEY']) }, 'organization secrets', 'MINISIGN_INDEX_KEY'],
      ['repoVariables', { stdout: variableList([['R2_BUCKET', 'eve-cyno-plugins']]) }, 'repository variables', 'R2_BUCKET'],
      ['orgVariables', { stdout: variableList([['r2_account_id', ACCOUNT]]) }, 'organization variables', 'r2_account_id'],
      ['repoSecrets', { stdout: secretList(['MINISIGN_OTHER']) }, 'repository secrets', 'MINISIGN_OTHER'],
    ];
    for (const [k, answer, what, name] of cases) {
      const r = await fails({ stored: { [k]: answer } }, new RegExp(`^FAIL ${what}: ${name} is set outside the environments: `, 'm'));
      assert.doesNotMatch(r.text, new RegExp(ACCOUNT));
    }
  });
  test('CE-stored-unreadable fails closed: a list that cannot be read or is incomplete', async () => {
    const denied = { stdout: '{"message":"Resource not accessible by personal access token","status":"403"}', exit: 1, stderr: 'gh: Resource not accessible by personal access token (HTTP 403)\n' };
    for (const k of Object.keys(STORED)) {
      await fails({ stored: { [k]: denied } }, /^FAIL .*HTTP 403.*\(a list that cannot be read fails closed\)$/m);
    }
    await fails({ stored: { orgVariables: { stdout: [{ total_count: 3, variables: [] }] } } }, /^FAIL organization variables: .*the list is incomplete/m);
    await fails({ stored: { repoSecrets: { stdout: [{ total_count: 1, secrets: [{ created_at: STAMP }] }] } } }, /^FAIL repository secrets: an item without a name/m);
  });
});

describe('C-ENV1 command line', () => {
  test('CE-cli: exit 0 on a pass, 1 on a failure, 2 on a usage error; T1 is done, so no mode skips the probes', () => {
    const cli = (args, o = {}) => {
      const { env } = stubEnv(BIN, routes(o), temps);
      return spawnSync(process.execPath, [TOOL, ...args], { encoding: 'utf8', env, cwd: good.dir });
    };
    const pass = cli(['--rev', good.rev, '--repo-dir', good.dir]);
    assert.equal(pass.status, 0, pass.stdout + pass.stderr);
    assert.doesNotMatch(pass.stdout + pass.stderr, NAMES_REVIEWER);
    assert.equal(cli(['--rev', good.rev, '--repo-dir', good.dir], { probes: { deploy: http(404, 'Not Found') } }).status, 1);
    const created = cli(['--rev', good.rev, '--repo-dir', good.dir], { probes: { envcreate: http(200) } });
    assert.equal(created.status, 1, 'an environment the probe created is a failure');
    assert.match(created.stdout.split('\n')[0], /^ALARM: .*c-env1-probe-denied/, 'the first line of the output');
    assert.match(created.stderr, /^ALARM: the agents' token created the environment c-env1-probe-denied/m, 'and on stderr');
    assert.equal(cli(['--rev', good.rev, '--repo-dir', good.dir], { probes: { secrets: http(403, PROBE_MESSAGE) } }).status, 1);
    assert.equal(cli(['--rev', 'main', '--repo-dir', good.dir]).status, 2);
    assert.equal(cli(['--repo-dir', good.dir]).status, 2);
    const t2 = cli(['--rev', good.rev, '--repo-dir', good.dir, '--t2']);
    assert.equal(t2.status, 2, '--t2 is gone: the token is switched and the probes are the safeguard');
    assert.equal(t2.stdout, '', 'nothing is checked or sent');
  });
});
