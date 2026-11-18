#!/usr/bin/env node
// tools/approved-base.mjs: plan 4.5 steps 1 and 2 as a convenience for the reviewer, who still confirms every line on the run pages
// and against the reviewer's own offline list (docs/RUNBOOK.md). Given the run under review (its commit is <B>), it prints:
// - <A>: the commit of the newest OTHER run of publish.yml or resign.yml (by created_at, then id) that has an approval of
//   environment index by the reviewer account (GET .../actions/runs/<id>/approvals) and exactly one job sign and one job upload,
//   both concluded success (GET .../actions/runs/<id>/jobs, the run's latest attempt), with one "skip" line for every newer run and
//   why it does not count;
// - the compare status of <A> to <B> (GET .../compare/<A>...<B>) and the compare view to read.
// The reviewer account's id is the one committed at <B> (tools/lib/reviewer.mjs, `git show`), never the local checkout's.
// Fail closed: any request that fails, or a list that did not come back whole, is an ERROR, never "no approved run".
//
// Usage: node tools/approved-base.mjs --run <run id> [--repo-dir <git checkout holding <B>>]
// Exit 0: <A> found and <B> is ahead of it or identical; 1: NO APPROVAL or ERROR; 2: usage; 3: FIRST PUBLISH (no approved run
// found; allowed only under the runbook's first-publish rule).
import path from 'node:path';
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import { HOST, REPO, getAll, getJson, oneLine } from './lib/github.mjs';
import { readReviewerAt } from './lib/reviewer.mjs';

const R = `repos/${REPO}`;
const WORKFLOWS = ['publish.yml', 'resign.yml'];
const SHA_RE = /^[0-9a-f]{40}$/;
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const wfOf = (run) => (isObj(run) && typeof run.path === 'string' ? WORKFLOWS.find((w) => run.path === `.github/workflows/${w}`) : undefined);
const label = (run) => `run ${run.id} (${wfOf(run)}, created ${oneLine(run.created_at)})`;

/** Why a run does not count as approved, signed and uploaded ('' when it counts). Throws { error } on a failed request. */
async function whyNot(run, id, opts) {
  const ap = await getJson(`${R}/actions/runs/${run.id}/approvals`, opts);
  if (ap.error) throw ap;
  if (!Array.isArray(ap.value)) throw { error: `${R}/actions/runs/${run.id}/approvals: the answer is not a list` };
  const approved = ap.value.some((a) => isObj(a) && a.state === 'approved' && isObj(a.user) && a.user.id === id
    && Array.isArray(a.environments) && a.environments.some((e) => isObj(e) && e.name === 'index'));
  if (!approved) return 'no approval of index by the reviewer account';
  const jobs = await getAll(`${R}/actions/runs/${run.id}/jobs?per_page=100`, 'jobs', opts);
  if (jobs.error) throw jobs;
  for (const name of ['sign', 'upload']) {
    const js = jobs.items.filter((j) => isObj(j) && j.name === name);
    if (js.length !== 1) return `${js.length} jobs named ${name}`;
    if (js[0].conclusion !== 'success') return `job ${name} concluded ${oneLine(js[0].conclusion ?? 'nothing yet')}`;
  }
  return '';
}

/** Finds <A> for run `runId`. `repoDir` is a git checkout holding the run's commit; `env` the environment gh and git run with. */
export async function approvedBase({ runId, repoDir, env }) {
  const lines = [];
  const done = (code, line) => { if (line) lines.push(line); return { code, lines }; };
  const opts = { env };
  try {
    const under = await getJson(`${R}/actions/runs/${runId}`, opts);
    if (under.error) throw under;
    const u = under.value;
    if (!isObj(u) || u.id !== runId) return done(1, `ERROR: the answer for run ${runId} is not that run`);
    if (!wfOf(u)) return done(1, `ERROR: run ${runId} is a run of ${oneLine(u.path)}, not of publish.yml or resign.yml`);
    if (u.head_branch !== 'main') return done(1, `ERROR: run ${runId} is on ${oneLine(u.head_branch)}, not on main`);
    if (typeof u.head_sha !== 'string' || !SHA_RE.test(u.head_sha)) return done(1, `ERROR: run ${runId} names no commit`);
    const B = u.head_sha;
    lines.push(`B ${B} from ${label(u)}`);

    const reviewer = await readReviewerAt(repoDir, B, env);
    if (reviewer.error) return done(1, `ERROR: ${reviewer.error}`);
    lines.push(`reviewer account id ${reviewer.id} (committed at ${B})`);

    const runs = [];
    for (const wf of WORKFLOWS) {
      const list = await getAll(`${R}/actions/workflows/${wf}/runs?per_page=100`, 'workflow_runs', opts);
      if (list.error) throw list;
      runs.push(...list.items);
    }
    for (const r of runs) {
      if (!isObj(r) || !Number.isSafeInteger(r.id) || typeof r.created_at !== 'string') return done(1, 'ERROR: a listed run has no id or created_at');
    }
    runs.sort((x, y) => (x.created_at === y.created_at ? y.id - x.id : x.created_at < y.created_at ? 1 : -1));

    for (const run of runs) {
      if (run.id === runId) { lines.push(`skip ${label(run)}: the run under review`); continue; }
      if (!wfOf(run)) { lines.push(`skip run ${run.id}: a run of ${oneLine(run.path)}`); continue; }
      if (run.head_branch !== 'main') { lines.push(`skip ${label(run)}: on ${oneLine(run.head_branch)}, not on main`); continue; }
      if (typeof run.head_sha !== 'string' || !SHA_RE.test(run.head_sha)) { lines.push(`skip ${label(run)}: names no commit`); continue; }
      const why = await whyNot(run, reviewer.id, opts);
      if (why) { lines.push(`skip ${label(run)}: ${why}`); continue; }

      const A = run.head_sha;
      lines.push(`A ${A} from ${label(run)}: ${oneLine(run.html_url ?? '')}`);
      lines.push('Confirm on that run page that the index approval shown is the reviewer account\'s own, and that A is the newest entry');
      lines.push('of your own list with a successful sign and upload.');
      const cmp = await getJson(`${R}/compare/${A}...${B}`, opts);
      if (cmp.error) throw cmp;
      const status = isObj(cmp.value) ? cmp.value.status : undefined;
      lines.push(`compare ${A}...${B}: ${oneLine(status ?? 'no status')}`);
      if (status !== 'ahead' && status !== 'identical') {
        return done(1, `NO APPROVAL: compare ${A}...${B} is ${oneLine(status ?? 'no status')}: <B> does not descend from <A>`);
      }
      lines.push(`Read every change outside entries/** and revoked.json: https://${HOST}/${REPO}/compare/${A}...${B}`);
      return done(0);
    }
    return done(3, 'FIRST PUBLISH: no other run of publish.yml or resign.yml has an approval of index by the reviewer account and '
      + 'successful sign and upload jobs. Treat <B> as a first publish only while your own list has no entry with a successful upload; '
      + 'otherwise this is NO APPROVAL (runs or approvals may have been deleted).');
  } catch (e) {
    return done(1, `ERROR: ${oneLine(e && e.error ? e.error : e)}`);
  }
}

const USAGE = 'usage: node tools/approved-base.mjs --run <run id> [--repo-dir <git checkout>]';

async function main(argv) {
  let a;
  try {
    a = parseArgs({ args: argv, strict: true, allowPositionals: false, options: { run: { type: 'string' }, 'repo-dir': { type: 'string' } } }).values;
  } catch (e) {
    process.stderr.write(`${oneLine(e.message)}\n${USAGE}\n`);
    return 2;
  }
  if (typeof a.run !== 'string' || !/^[1-9][0-9]{0,15}$/.test(a.run) || !Number.isSafeInteger(Number(a.run))) {
    process.stderr.write(`--run must be a workflow run id\n${USAGE}\n`);
    return 2;
  }
  const r = await approvedBase({ runId: Number(a.run), repoDir: path.resolve(a['repo-dir'] ?? '.'), env: process.env });
  process.stdout.write(`${r.lines.join('\n')}\n`);
  return r.code;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).then((code) => { process.exitCode = code; });
}
