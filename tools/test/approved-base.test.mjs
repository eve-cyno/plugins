// Tests of tools/approved-base.mjs (plan 4.5 step 1 and 2): <A> is the commit of the newest other run of publish.yml or resign.yml
// that this repository started by an event of that workflow (publish.yml: a dispatch; resign.yml: a dispatch or its schedule), with
// an approval of environment index by the environment's only required reviewer and successful sign and upload jobs; the compare
// status of <A> to <B> must be ahead or identical. GitHub is a stub gh on PATH (ghstub.mjs) answering with bodies shaped like
// the REST answers of the environment, runs, approvals, jobs and compare endpoints; the reviewer is read from the environment.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { after, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { approvedBase } from '../approved-base.mjs';
import { REVIEWER as WHO, envDoc, makeGhStub, stubEnv, userReviewer } from './ghstub.mjs';

const TOOL = fileURLToPath(new URL('../approved-base.mjs', import.meta.url));
const temps = [];
after(() => { for (const t of temps) fs.rmSync(t, { recursive: true, force: true }); });
const BIN = makeGhStub(temps);
const R = 'repos/eve-cyno/plugins';
const REVIEWER = WHO.id;
const sha = (c) => c.repeat(40);
const B = sha('b');
const A = sha('a');
/** The login or the id of the test reviewer, anywhere in a text. */
const NAMES_REVIEWER = new RegExp(`${WHO.login}|${WHO.id}`, 'i');

/** One workflow run as the list and get endpoints answer it. */
function run(id, wf, headSha, created) {
  return {
    id, name: wf.replace('.yml', ''), path: `.github/workflows/${wf}`, head_branch: 'main', head_sha: headSha,
    event: wf === 'resign.yml' ? 'schedule' : 'workflow_dispatch', status: 'completed', conclusion: 'success', run_attempt: 1,
    created_at: created, html_url: `https://github.com/eve-cyno/plugins/actions/runs/${id}`,
    head_repository: { id: 901, node_id: 'R_plugins', name: 'plugins', full_name: 'eve-cyno/plugins' },
  };
}
/**
 * A pull_request run of a publish.yml that a fork changed to run on pull_request: the fork's branch is named main, so the run has
 * the path and head_branch of a run of main; its head repository is the fork.
 */
const forkRun = (id, created, o = {}) => ({ ...run(id, 'publish.yml', sha('f'), created), event: 'pull_request',
  head_repository: { id: 977, node_id: 'R_fork', name: 'plugins', full_name: 'someone/plugins' }, ...o });
const approval = (user, envs, state = 'approved') => ({
  environments: envs.map((name, i) => ({ id: i + 1, node_id: `EN_${name}`, name })), state, comment: '', user: { login: `user-${user}`, id: user, type: 'User' },
});
/** The jobs of every attempt of a run (GET .../jobs?filter=all): [name, conclusion, attempt (default 1)]. */
const jobs = (runId, list) => [{ total_count: list.length, jobs: list.map(([name, conclusion, attempt = 1], i) => ({ id: runId * 10 + i, run_id: runId, name, status: 'completed', conclusion, run_attempt: attempt })) }];
const JOBS = (id) => `${R}/actions/runs/${id}/jobs?filter=all&per_page=100`;
const PUBLISHED = (id) => ({ approvals: [approval(REVIEWER, ['index']), approval(REVIEWER, ['mirror'])], jobs: jobs(id, [['build', 'success'], ['sign', 'success'], ['sign-test', 'skipped'], ['upload', 'success'], ['verify', 'success']]) });

/** The runs a case lists: [{ run, approvals, jobs }]; `under` is the run under review. */
function routes({ under, others, compare = 'ahead', publishPages, environment, extra = {} }) {
  const all = [under, ...others];
  const of = (wf) => all.filter((x) => x.run.path.endsWith(wf)).map((x) => x.run);
  const page = (list) => [{ total_count: list.length, workflow_runs: list }];
  const r = {
    [`GET ${R}/environments/index`]: environment ?? { stdout: envDoc('index') },
    [`GET ${R}/actions/runs/${under.run.id}`]: { stdout: under.run },
    [`GET ${R}/actions/workflows/publish.yml/runs?per_page=100`]: { stdout: publishPages ?? page(of('publish.yml')) },
    [`GET ${R}/actions/workflows/resign.yml/runs?per_page=100`]: { stdout: page(of('resign.yml')) },
    ...extra,
  };
  for (const x of all) {
    r[`GET ${R}/actions/runs/${x.run.id}/approvals`] ??= { stdout: x.approvals ?? [] };
    r[`GET ${JOBS(x.run.id)}`] ??= { stdout: x.jobs ?? jobs(x.run.id, []) };
  }
  for (const x of others) r[`GET ${R}/compare/${x.run.head_sha}...${B}`] = { stdout: { status: compare, ahead_by: 1, behind_by: 0, total_commits: 1, files: [] } };
  return r;
}

const UNDER = { run: run(300, 'publish.yml', B, '2026-12-10T10:00:00Z'), ...PUBLISHED(300) };
const GOOD = { run: run(200, 'publish.yml', A, '2026-12-01T10:00:00Z'), ...PUBLISHED(200) };

async function call(spec, { runId = 300 } = {}) {
  const { env, log } = stubEnv(BIN, routes(spec), temps);
  const r = await approvedBase({ runId, env });
  const text = r.lines.join('\n');
  assert.doesNotMatch(text, NAMES_REVIEWER, 'the reviewer\'s login and id are never printed');
  return { ...r, text, calls: log() };
}
/** The case finds <A> = GOOD's commit after skipping `skipped` with a line matching `why`. */
async function skips(skipped, why) {
  const r = await call({ under: UNDER, others: [skipped, GOOD] });
  assert.equal(r.code, 0, r.text);
  assert.match(r.text, new RegExp(`^A ${A} from run 200 `, 'm'));
  assert.match(r.text, new RegExp(`^skip run ${skipped.run.id} .*${why}`, 'm'));
  assert.match(r.text, new RegExp(`compare ${A}\\.\\.\\.${B}: ahead`));
  assert.match(r.text, new RegExp(`https://github\\.com/eve-cyno/plugins/compare/${A}\\.\\.\\.${B}`));
  assert.match(r.text, /^Read every change other than the entries\/<id>\.json files and revoked\.json \(anything else in entries\/ too\): https:/m);
  return r;
}

describe('approved-base: <A> skips every run that is not an approved, signed and uploaded other run', () => {
  test('AB-good: the newest other run with an approved index and successful sign and upload is <A>', async () => {
    const r = await skips({ run: run(250, 'resign.yml', sha('c'), '2026-12-05T06:17:00Z'), approvals: [], jobs: jobs(250, [['check', 'success'], ['head', 'skipped'], ['sign', 'skipped'], ['upload', 'skipped'], ['verify', 'skipped']]) }, "no approval of index by the environment's reviewer");
    assert.ok(!r.calls.some((a) => /compare\/c{40}/.test(a[a.length - 1])), 'no compare for a skipped run');
  });
  test('AB-skip-noop-resign: a re-sign that ended at check', () => skips({ run: run(250, 'resign.yml', sha('c'), '2026-12-05T06:17:00Z'), approvals: [], jobs: jobs(250, [['check', 'success'], ['head', 'skipped'], ['sign', 'skipped'], ['upload', 'skipped'], ['verify', 'skipped']]) }, 'no approval of index'));
  test('AB-skip-test-run: a target test run (mirror approval only)', () => skips({ run: run(251, 'publish.yml', sha('c'), '2026-12-05T10:00:00Z'), approvals: [approval(REVIEWER, ['mirror'])], jobs: jobs(251, [['build', 'success'], ['sign', 'skipped'], ['sign-test', 'success'], ['upload', 'success'], ['verify', 'success']]) }, 'no approval of index'));
  test('AB-skip-other-user: index approved by another user', () => skips({ run: run(252, 'publish.yml', sha('c'), '2026-12-05T10:00:00Z'), approvals: [approval(777, ['index']), approval(777, ['mirror'])], jobs: PUBLISHED(252).jobs }, 'no approval of index'));
  test('AB-skip-rejected: index rejected by the reviewer account', () => skips({ run: run(253, 'publish.yml', sha('c'), '2026-12-05T10:00:00Z'), approvals: [approval(REVIEWER, ['index'], 'rejected')], jobs: jobs(253, [['build', 'success'], ['sign', 'skipped'], ['upload', 'skipped']]) }, 'no approval of index'));
  test('AB-skip-under-review: the run under review itself, even approved, signed and uploaded', async () => {
    const r = await skips({ run: run(254, 'publish.yml', sha('c'), '2026-12-05T10:00:00Z'), approvals: [], jobs: jobs(254, []) }, 'no approval of index');
    assert.match(r.text, /^skip run 300 .*the run under review/m);
    assert.ok(!r.calls.some((a) => a[a.length - 1] === `${R}/actions/runs/300/approvals`), 'the run under review is never a candidate');
  });
  test('AB-skip-upload-failed: sign succeeded, upload failed', () => skips({ run: run(255, 'publish.yml', sha('c'), '2026-12-05T10:00:00Z'), approvals: [approval(REVIEWER, ['index']), approval(REVIEWER, ['mirror'])], jobs: jobs(255, [['build', 'success'], ['sign', 'success'], ['upload', 'failure']]) }, 'job upload concluded failure'));
  test('AB-skip-mirror-refused: index approved, mirror refused, upload skipped', () => skips({ run: run(256, 'resign.yml', sha('c'), '2026-12-05T06:17:00Z'), approvals: [approval(REVIEWER, ['index']), approval(REVIEWER, ['mirror'], 'rejected')], jobs: jobs(256, [['check', 'success'], ['head', 'success'], ['sign', 'success'], ['upload', 'skipped']]) }, 'job upload concluded skipped'));
  test('AB-skip-sign-failed: index approved, sign failed', () => skips({ run: run(257, 'publish.yml', sha('c'), '2026-12-05T10:00:00Z'), approvals: [approval(REVIEWER, ['index'])], jobs: jobs(257, [['build', 'success'], ['sign', 'failure'], ['upload', 'skipped']]) }, 'job sign concluded failure'));
  test('AB-skip-two-sign-jobs: a run with two jobs named sign', () => skips({ run: run(258, 'publish.yml', sha('c'), '2026-12-05T10:00:00Z'), approvals: [approval(REVIEWER, ['index'])], jobs: jobs(258, [['sign', 'success'], ['sign', 'success'], ['upload', 'success']]) }, '2 jobs named sign'));
  test('AB-approved-no-sign: an approved run whose attempt 1 has no job sign is an ERROR (job sign is what asks for the approval)', async () => {
    const lists = [[1, []], [1, [['build', 'success'], ['upload', 'skipped']]], [2, [['build', 'success'], ['upload', 'skipped'], ['sign', 'skipped', 2]]]];
    for (const [attempt, list] of lists) {
      const r = await call({ under: UNDER, others: [{ run: { ...run(259, 'publish.yml', sha('c'), '2026-12-05T10:00:00Z'), run_attempt: attempt }, approvals: [approval(REVIEWER, ['index'])], jobs: jobs(259, list) }, GOOD] });
      assert.equal(r.code, 1, r.text);
      assert.match(r.text, /^ERROR: run 259 \(publish\.yml, created [^)]*\): approved, 0 jobs named sign in attempt 1/m);
      assert.doesNotMatch(r.text, /^A /m, 'no older run becomes <A> past it');
    }
  });
  test('AB-order: the newest across both workflows wins', async () => {
    const resign = { run: run(260, 'resign.yml', sha('d'), '2026-12-08T06:17:00Z'), approvals: [approval(REVIEWER, ['index']), approval(REVIEWER, ['mirror'])], jobs: jobs(260, [['check', 'success'], ['head', 'success'], ['sign', 'success'], ['upload', 'success']]) };
    const r = await call({ under: UNDER, others: [GOOD, resign] });
    assert.equal(r.code, 0, r.text);
    assert.match(r.text, new RegExp(`^A ${sha('d')} from run 260 \\(resign\\.yml`, 'm'));
  });
  test('AB-order-tie: on equal created_at the higher run id is newer', async () => {
    const twin = { run: run(199, 'resign.yml', sha('d'), GOOD.run.created_at), approvals: [approval(REVIEWER, ['index']), approval(REVIEWER, ['mirror'])], jobs: jobs(199, [['sign', 'success'], ['upload', 'success']]) };
    const r = await call({ under: UNDER, others: [twin, GOOD] });
    assert.equal(r.code, 0, r.text);
    assert.match(r.text, new RegExp(`^A ${A} from run 200 `, 'm'));
  });
  // A fork may change publish.yml to run on pull_request and name its branch main: such a run has the path and the head_branch of
  // a run of main, and jobs named sign and upload of its own. A run whose head repository is not this one is skipped before its
  // approvals or jobs are read (a re-run of it could otherwise stop every review with an ERROR).
  const notRead = (r, id) => {
    for (const end of [`${R}/actions/runs/${id}/approvals`, JOBS(id)]) assert.ok(!r.calls.some((a) => a[a.length - 1] === end), `${end} is not read`);
  };
  test('approved-base skips a pull_request run on a fork branch named main', async () => {
    const created = '2026-12-05T10:00:00Z';
    for (const [x, event] of [[forkRun(270, created), 'pull_request'],
      [forkRun(270, created, { event: 'pull_request_target' }), 'pull_request_target'], [forkRun(270, created, { event: 'push' }), 'push'],
      [forkRun(270, created, { event: 'workflow_run' }), 'workflow_run'], [forkRun(270, created, { event: undefined }), 'none'],
      [forkRun(270, created, { event: 'Workflow_Dispatch' }), 'Workflow_Dispatch']]) {
      // Approved, signed and uploaded, and newer than run 200: without the rule it would be <A>.
      const r = await skips({ run: x, ...PUBLISHED(270) }, `started by event ${event}, not workflow_dispatch$`);
      notRead(r, 270);
    }
  });
  // A run of this repository started by another event (a commit on main that added `on: push` to publish.yml) is never <A>, but it
  // is reviewed: its index approval and a successful sign mean its signed head may have gone live, so it is no first publish.
  test('AB-own-other-event: an own-repository run of another event is read, may count as signed, and is never <A>', async () => {
    const created = '2026-12-05T10:00:00Z';
    const own = (event, wf = 'publish.yml') => ({ ...run(273, wf, sha('c'), created), event });
    const UPLOAD_FAILED = jobs(273, [['build', 'success'], ['sign', 'success'], ['upload', 'failure']]);
    for (const [x, list, events] of [[own('push'), PUBLISHED(273).jobs, 'workflow_dispatch'], [own('push'), UPLOAD_FAILED, 'workflow_dispatch'],
      [own('pull_request'), PUBLISHED(273).jobs, 'workflow_dispatch'], [own('push', 'resign.yml'), PUBLISHED(273).jobs, 'workflow_dispatch or schedule']]) {
      const approvals = PUBLISHED(273).approvals;
      const alone = await call({ under: UNDER, others: [{ run: x, approvals, jobs: list }] });
      assert.equal(alone.code, 1, alone.text);
      assert.match(alone.text, new RegExp(`^skip run 273 .*started by event ${x.event}, not ${events}$`, 'm'));
      assert.match(alone.text, /^NOT A FIRST PUBLISH: run 273 \([a-z]+\.yml, created [^)]*\) has an approval of index/m);
      assert.doesNotMatch(alone.text, /^(A |FIRST PUBLISH)/m);
      assert.ok(alone.calls.some((a) => a[a.length - 1] === JOBS(273)), 'an own-repository run is reviewed whatever its event');
      const r = await skips({ run: x, approvals, jobs: list }, `started by event ${x.event}, not ${events}$`);
      assert.ok(r.calls.some((a) => a[a.length - 1] === JOBS(273)));
    }
    const unsigned = { run: own('push'), approvals: [], jobs: jobs(273, [['build', 'success'], ['sign', 'skipped'], ['upload', 'skipped']]) };
    assert.equal((await call({ under: UNDER, others: [unsigned] })).code, 3, 'an own push run that signed nothing: still a first publish');
  });
  test('AB-events-per-workflow: publish.yml counts a dispatch only, resign.yml a dispatch or its schedule', async () => {
    const created = '2026-12-05T10:00:00Z';
    const scheduled = { run: { ...run(274, 'publish.yml', sha('c'), created), event: 'schedule' }, ...PUBLISHED(274) };
    await skips(scheduled, 'started by event schedule, not workflow_dispatch$');
    for (const event of ['schedule', 'workflow_dispatch']) {
      const resign = { run: { ...run(275, 'resign.yml', sha('d'), created), event }, ...PUBLISHED(275) };
      const r = await call({ under: UNDER, others: [resign, GOOD] });
      assert.equal(r.code, 0, r.text);
      assert.match(r.text, new RegExp(`^A ${sha('d')} from run 275 \\(resign\\.yml`, 'm'), event);
    }
    const under = await call({ under: { ...UNDER, run: { ...UNDER.run, event: 'schedule' } }, others: [GOOD] });
    assert.equal(under.code, 1, under.text);
    assert.match(under.text, /^ERROR: run 300: started by event schedule, not workflow_dispatch$/m);
  });
  test('approved-base skips a run whose head repository is not eve-cyno/plugins', async () => {
    const created = '2026-12-05T10:00:00Z';
    const own = run(271, 'publish.yml', sha('c'), created);
    for (const [repo, named] of [[{ id: 977, full_name: 'someone/plugins' }, 'someone/plugins'], [null, 'none'], [undefined, 'none'],
      [{ id: 901, name: 'plugins' }, 'none'], [{ full_name: 'eve-cyno/plugins-old' }, 'eve-cyno/plugins-old'],
      [{ full_name: 'Eve-Cyno/Plugins' }, 'Eve-Cyno/Plugins'], ['eve-cyno/plugins', 'none']]) {
      const r = await skips({ run: { ...own, head_repository: repo }, ...PUBLISHED(271) }, `its head repository is ${named}, not eve-cyno/plugins$`);
      notRead(r, 271);
    }
    const resign = { ...run(272, 'resign.yml', sha('d'), created), head_repository: { full_name: 'someone/plugins' } };
    notRead(await skips({ run: resign, ...PUBLISHED(272) }, 'its head repository is someone/plugins, not eve-cyno/plugins$'), 272);
  });
  test('AB-under-review-foreign: a run under review that a fork or another repository started is an ERROR', async () => {
    for (const [under, re] of [[forkRun(300, '2026-12-10T10:00:00Z'), /^ERROR: run 300: started by event pull_request, not workflow_dispatch$/m],
      [{ ...UNDER.run, head_repository: { full_name: 'someone/plugins' } }, /^ERROR: run 300: its head repository is someone\/plugins, not eve-cyno\/plugins$/m]]) {
      const r = await call({ under: { ...UNDER, run: under }, others: [GOOD] });
      assert.equal(r.code, 1, r.text);
      assert.match(r.text, re);
      assert.equal(r.lines.length, 1, 'nothing else is read or printed');
    }
  });
});

describe('approved-base: direction and failures', () => {
  test('AB-identical: <A> equal to <B> passes', async () => {
    const r = await call({ under: UNDER, others: [GOOD], compare: 'identical' });
    assert.equal(r.code, 0, r.text);
    assert.match(r.text, /: identical/);
  });
  test('AB-behind: NO APPROVAL', async () => {
    const r = await call({ under: UNDER, others: [GOOD], compare: 'behind' });
    assert.equal(r.code, 1);
    assert.match(r.text, /^NO APPROVAL: compare .* is behind/m);
  });
  test('AB-diverged: NO APPROVAL', async () => {
    const r = await call({ under: UNDER, others: [GOOD], compare: 'diverged' });
    assert.equal(r.code, 1);
    assert.match(r.text, /^NO APPROVAL: compare .* is diverged/m);
  });
  test('AB-first-publish: no approved run at all', async () => {
    const r = await call({ under: UNDER, others: [{ run: run(251, 'publish.yml', sha('c'), '2026-12-05T10:00:00Z'), approvals: [approval(REVIEWER, ['mirror'])], jobs: jobs(251, [['sign-test', 'success'], ['upload', 'success']]) }] });
    assert.equal(r.code, 3, r.text);
    assert.match(r.text, /^FIRST PUBLISH: /m);
    assert.match(r.text, /only while the Discord head log has no entry with a successful sign/);
  });
  test('AB-first-publish-signed: a run with an approved index and a successful sign but no successful upload means no first publish', async () => {
    // Its signed head may have gone live (it is a recovery R2 candidate), so a missing live head after it is a deleted head.
    const failed = { run: run(255, 'publish.yml', sha('c'), '2026-12-05T10:00:00Z'), approvals: [approval(REVIEWER, ['index']), approval(REVIEWER, ['mirror'])], jobs: jobs(255, [['build', 'success'], ['sign', 'success'], ['upload', 'failure']]) };
    const refused = { run: run(256, 'resign.yml', sha('d'), '2026-12-04T06:17:00Z'), approvals: [approval(REVIEWER, ['index']), approval(REVIEWER, ['mirror'], 'rejected')], jobs: jobs(256, [['check', 'success'], ['head', 'success'], ['sign', 'success'], ['upload', 'skipped']]) };
    for (const [others, id] of [[[failed], 255], [[refused], 256], [[failed, refused], 255]]) {
      const r = await call({ under: UNDER, others });
      assert.equal(r.code, 1, r.text);
      assert.match(r.text, new RegExp(`^NOT A FIRST PUBLISH: run ${id} \\([a-z]+\\.yml, created [^)]*\\) has an approval of index by the environment's reviewer and a successful sign`, 'm'));
      assert.match(r.text, /only a repair run \(recovery R2\)/);
      assert.doesNotMatch(r.text, /^FIRST PUBLISH/m);
    }
    const unsigned = { ...failed, jobs: jobs(255, [['build', 'success'], ['sign', 'failure'], ['upload', 'skipped']]) };
    assert.equal((await call({ under: UNDER, others: [unsigned] })).code, 3, 'a failed sign signed nothing: still a first publish');
  });
  // A re-run: every job refuses any attempt but the first at its first step, so only attempt 1 can sign or upload. The jobs are read
  // for every attempt (filter=all), and attempt 1 is judged; a later attempt's skipped sign and upload never hide what attempt 1 did.
  const rerun = (attempt, approvals, list) => ({ run: { ...run(254, 'publish.yml', sha('c'), '2026-12-05T10:00:00Z'), run_attempt: attempt }, approvals, jobs: jobs(254, list) });
  const LATER = (n) => [['build', 'failure', n], ['sign', 'skipped', n], ['upload', 'skipped', n], ['verify', 'skipped', n]];
  const BOTH = [approval(REVIEWER, ['index']), approval(REVIEWER, ['mirror'])];
  test('AB-rerun-unapproved-skip: a re-run of a run with no index approval (a target test run) is skipped and never blocks', async () => {
    const test2 = (n) => rerun(n, [approval(REVIEWER, ['mirror'])], [['build', 'success'], ['sign', 'skipped'], ['sign-test', 'success'], ['upload', 'success'], ['verify', 'failure'], ...LATER(n)]);
    for (const n of [2, 3]) {
      const r = await call({ under: UNDER, others: [test2(n), GOOD] });
      assert.equal(r.code, 0, r.text);
      assert.match(r.text, /^skip run 254 .*no approval of index by the environment's reviewer/m);
      assert.match(r.text, new RegExp(`^A ${A} from run 200 `, 'm'));
      assert.ok(r.calls.some((a) => a[a.length - 1] === JOBS(254)), 'an unapproved re-run\'s jobs are read: its attempt 1 did not sign');
      const first = await call({ under: UNDER, others: [test2(n)] });
      assert.equal(first.code, 3, `a re-run test run does not block a first publish\n${first.text}`);
      assert.match(first.text, /^FIRST PUBLISH: /m);
    }
  });
  test('AB-rerun-approval-missing: a re-run that lists no index approval but whose attempt 1 signed is an ERROR (the list may show the latest attempt only)', async () => {
    // Job sign asks for the index approval, so a sign of attempt 1 that succeeded means the approvals list lacks that approval.
    const signed = [['build', 'success'], ['sign', 'success'], ['upload', 'success'], ['verify', 'failure'], ...LATER(2)];
    for (const [approvals, others] of [[[], [GOOD]], [[approval(REVIEWER, ['mirror'])], [GOOD]], [[approval(777, ['index'])], [GOOD]], [[], []]]) {
      const r = await call({ under: UNDER, others: [rerun(2, approvals, signed), ...others] });
      assert.equal(r.code, 1, r.text);
      assert.match(r.text, /^ERROR: run 254 \(publish\.yml, created [^)]*\) lists no approval of index by the environment's reviewer, yet job sign of attempt 1 concluded success/m);
      assert.match(r.text, /read every attempt on the run page and against the Discord head log \(docs\/RUNBOOK\.md, a re-run\)/);
      assert.doesNotMatch(r.text, /^(A |FIRST PUBLISH)/m, 'neither an older <A> nor a first publish past it');
    }
    const unknown = await call({ under: UNDER, others: [rerun(undefined, [], []), GOOD] });
    assert.equal(unknown.code, 1, `no approval and no valid attempt: its jobs cannot be judged\n${unknown.text}`);
    assert.match(unknown.text, /^ERROR: run 254 .* names no valid run_attempt \(none\)/m);
  });
  test('AB-rerun-attempt-1: an approved re-run is judged by its attempt 1, read with filter=all', async () => {
    const uploaded = await call({ under: UNDER, others: [rerun(2, BOTH, [['build', 'success'], ['sign', 'success'], ['upload', 'success'], ['verify', 'failure'], ...LATER(2)]), GOOD] });
    assert.equal(uploaded.code, 0, uploaded.text);
    assert.match(uploaded.text, new RegExp(`^A ${sha('c')} from run 254 `, 'm'), 'attempt 1 signed and uploaded: the re-run is <A>');
    assert.ok(uploaded.calls.some((a) => a[a.length - 1] === JOBS(254)), 'the jobs of every attempt are read');
    const signed = await call({ under: UNDER, others: [rerun(3, BOTH, [['build', 'success'], ['sign', 'success'], ['upload', 'failure'], ...LATER(2), ...LATER(3).slice(0, 2)])] });
    assert.equal(signed.code, 1, signed.text);
    assert.match(signed.text, /^NOT A FIRST PUBLISH: run 254 /m, 'attempt 1 signed: no first publish');
    const unsigned = await call({ under: UNDER, others: [rerun(2, BOTH, [['build', 'success'], ['sign', 'failure'], ['upload', 'skipped'], ...LATER(2)]), GOOD] });
    assert.equal(unsigned.code, 0, unsigned.text);
    assert.match(unsigned.text, /^skip run 254 .*job sign concluded failure/m);
    const under = await call({ under: { ...UNDER, run: { ...UNDER.run, run_attempt: 2 } }, others: [GOOD] });
    assert.equal(under.code, 0, `the run under review is not reviewed here (its own first step refuses a re-run)\n${under.text}`);
  });
  test('AB-rerun-unreadable: an approved re-run whose attempt 1 cannot be read is an ERROR, never a skip', async () => {
    const cases = [
      [rerun(undefined, BOTH, [['sign', 'success'], ['upload', 'success']]), /names no valid run_attempt \(none\)/],
      [rerun(0, BOTH, [['sign', 'success'], ['upload', 'success']]), /names no valid run_attempt \(0\)/],
      [rerun(2, BOTH, LATER(2)), /is attempt 2 of that run, and its jobs list holds no job of attempt 1/],
      [rerun(2, BOTH, [['build', 'success'], ['sign', 'success'], ['upload', 'success', 3], ...LATER(2)]), /a job names attempt 3, not one from 1 to 2/],
      [{ ...rerun(2, BOTH, []), jobs: [{ total_count: 1, jobs: [{ id: 1, name: 'sign', conclusion: 'success' }] }] }, /a job names attempt none, not one from 1 to 2/],
      [rerun(2, BOTH, [['build', 'success'], ['sign', 'failure'], ['upload', 'skipped'], ['sign', 'success', 2], ['upload', 'skipped', 2]]), /job sign of attempt 2 concluded success/],
      [rerun(2, BOTH, [['build', 'success'], ['sign', 'success'], ['upload', 'failure'], ['upload', 'success', 2]]), /job upload of attempt 2 concluded success/],
    ];
    for (const [x, re] of cases) {
      const r = await call({ under: UNDER, others: [x, GOOD] });
      assert.equal(r.code, 1, r.text);
      assert.match(r.text, new RegExp(`^ERROR: run 254 \\(publish\\.yml, created [^)]*\\)[: ].*${re.source}`, 'm'));
      assert.match(r.text, /read every attempt on the run page and against the Discord head log \(docs\/RUNBOOK\.md, a re-run\)/);
      assert.doesNotMatch(r.text, /^A /m, 'no older run becomes <A> past it');
    }
  });
  test('AB-pagination-incomplete: a run list that did not complete fails closed', async () => {
    const r = await call({ under: UNDER, others: [GOOD], publishPages: [{ total_count: 150, workflow_runs: [UNDER.run, GOOD.run] }] });
    assert.equal(r.code, 1);
    assert.match(r.text, /^ERROR: .*the list is incomplete/m);
  });
  test('AB-api-error: an error on any request fails closed, never "first publish"', async () => {
    const extra = { [`GET ${R}/actions/runs/200/approvals`]: { stdout: '', stderr: 'gh: Server Error (HTTP 502)\n', exit: 1 } };
    const r = await call({ under: UNDER, others: [GOOD], extra });
    assert.equal(r.code, 1);
    assert.match(r.text, /^ERROR: .*approvals.*exited 1/m);
  });
  test('AB-reviewer-from-environment: only approvals by the environment\'s reviewer count, whoever it is', async () => {
    const other = { ...GOOD, approvals: [approval(777, ['index'])] };
    const r = await call({ under: UNDER, others: [other] });
    assert.equal(r.code, 3, r.text);
    const r2 = await call({ under: UNDER, others: [other], environment: { stdout: envDoc('index', { reviewers: [userReviewer(777)] }) } });
    assert.equal(r2.code, 0, r2.text);
    assert.match(r2.text, new RegExp(`^A ${A} from run 200 `, 'm'));
    assert.equal(r2.calls.filter((a) => a[a.length - 1] === `${R}/environments/index`).length, 1, 'the environment is read once');
  });
  test('AB-reviewer-unreadable: a failed environment read is an ERROR, never "first publish"', async () => {
    const r = await call({ under: UNDER, others: [], environment: { stdout: '', stderr: 'gh: Server Error (HTTP 502)\n', exit: 1 } });
    assert.equal(r.code, 1);
    assert.match(r.text, /^ERROR: .*environments\/index.*exited 1/m);
  });
  test('AB-reviewer-not-one: two reviewers, or none, is an ERROR', async () => {
    for (const reviewers of [[userReviewer(REVIEWER, WHO.login), userReviewer(777)], []]) {
      const r = await call({ under: UNDER, others: [GOOD], environment: { stdout: envDoc('index', { reviewers }) } });
      assert.equal(r.code, 1, r.text);
      assert.match(r.text, /^ERROR: environment index: [02] required reviewers, expected exactly 1/m);
    }
  });
  test('AB-unknown-workflow: a run of another workflow is not reviewed here', async () => {
    const under = { ...UNDER, run: { ...UNDER.run, path: '.github/workflows/check.yml' } };
    const r = await call({ under, others: [GOOD] });
    assert.equal(r.code, 1);
    assert.match(r.text, /^ERROR: run 300 is a run of \.github\/workflows\/check\.yml/m);
  });
  test('AB-cli: exit codes and usage', () => {
    const { env } = stubEnv(BIN, routes({ under: UNDER, others: [GOOD] }), temps);
    const cli = (args) => spawnSync(process.execPath, [TOOL, ...args], { encoding: 'utf8', env });
    const ok = cli(['--run', '300']);
    assert.equal(ok.status, 0, ok.stdout + ok.stderr);
    assert.doesNotMatch(ok.stdout + ok.stderr, NAMES_REVIEWER);
    const exit = (spec) => spawnSync(process.execPath, [TOOL, '--run', '300'], { encoding: 'utf8', env: stubEnv(BIN, routes(spec), temps).env }).status;
    assert.equal(exit({ under: UNDER, others: [GOOD], compare: 'behind' }), 1, 'NO APPROVAL exits 1');
    assert.equal(exit({ under: UNDER, others: [] }), 3, 'FIRST PUBLISH exits 3');
    for (const bad of ['x', '0', '01', '-5', '1.5']) assert.equal(cli(['--run', bad]).status, 2, bad);
    assert.equal(cli([]).status, 2);
    assert.equal(cli(['--run', '300', '--repo-dir', '.']).status, 2, 'no reviewer is read from a checkout any more');
  });
});
