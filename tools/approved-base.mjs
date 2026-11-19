#!/usr/bin/env node
// tools/approved-base.mjs: plan 4.5 steps 1 and 2 as a convenience for the reviewer, who still confirms every line on the run pages
// and against the reviewer's own offline list (docs/RUNBOOK.md). Given the run under review (its commit is <B>), it prints:
// - <A>: the commit of the newest OTHER run of publish.yml or resign.yml (by created_at, then id) that has an approval of
//   environment index by the environment's reviewer (GET .../actions/runs/<id>/approvals) and exactly one job sign and one job upload,
//   both concluded success (GET .../actions/runs/<id>/jobs, the run's latest attempt), with one "skip" line for every newer run and
//   why it does not count; a newer run on a later attempt than its first (a re-run) is an ERROR, since the jobs list shows only that
//   attempt;
// - the compare status of <A> to <B> (GET .../compare/<A>...<B>) and the compare view to read.
// The reviewer is the only required reviewer of environment index, read now from GitHub (tools/lib/reviewer.mjs); no login or id is
// written in the repository, and this tool prints neither. Fail closed: any request that fails, a list that did not come back whole,
// or an environment that does not name exactly one reviewer is an ERROR, never "no approved run".
//
// Usage: node tools/approved-base.mjs --run <run id>
// Exit 0: <A> found and <B> is ahead of it or identical; 1: NO APPROVAL, NOT A FIRST PUBLISH (no <A>, but a run has an approved index
// and a successful sign: its signed head may have gone live, as recovery R2 counts it) or ERROR; 2: usage; 3: FIRST PUBLISH (no run
// has an approved index and a successful sign; allowed only under the runbook's first-publish rule).
import path from 'node:path';
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import { HOST, REPO, getAll, getJson, oneLine } from './lib/github.mjs';
import { readReviewer } from './lib/reviewer.mjs';

const R = `repos/${REPO}`;
const WORKFLOWS = ['publish.yml', 'resign.yml'];
const SHA_RE = /^[0-9a-f]{40}$/;
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
/** The workflow file (publish.yml or resign.yml) of a run, or undefined. */
export const wfOf = (run) => (isObj(run) && typeof run.path === 'string' ? WORKFLOWS.find((w) => run.path === `.github/workflows/${w}`) : undefined);
export const label = (run) => `run ${run.id} (${wfOf(run)}, created ${oneLine(run.created_at)})`;

/**
 * Every run of publish.yml and resign.yml, newest first (by created_at, then id). Throws { error } on a failed request, a list that
 * did not come back whole, or a run without an id or created_at.
 */
export async function listRuns(opts) {
  const runs = [];
  for (const wf of WORKFLOWS) {
    const list = await getAll(`${R}/actions/workflows/${wf}/runs?per_page=100`, 'workflow_runs', opts);
    if (list.error) throw list;
    runs.push(...list.items);
  }
  for (const r of runs) {
    if (!isObj(r) || !Number.isSafeInteger(r.id) || typeof r.created_at !== 'string') throw { error: 'a listed run has no id or created_at' };
  }
  return runs.sort((x, y) => (x.created_at === y.created_at ? y.id - x.id : x.created_at < y.created_at ? 1 : -1));
}

/** Why a listed run is not a run of main with a commit, as a skip line's reason ('' when it is one). */
export function notOnMain(run) {
  if (!wfOf(run)) return `a run of ${oneLine(run.path)}`;
  if (run.head_branch !== 'main') return `on ${oneLine(run.head_branch)}, not on main`;
  if (typeof run.head_sha !== 'string' || !SHA_RE.test(run.head_sha)) return 'names no commit';
  return '';
}

/**
 * A run's review state: { why } when it has no approval of environment index by the user `id` (the environment's reviewer), else
 * { why: '', sign, upload }, each '' when the run has exactly one job of that name and it concluded success, or why not. Throws
 * { error } on a failed request, and on a run whose run_attempt is not 1 (a re-run): GitHub lists the jobs of a run's latest attempt
 * only, and a later attempt fails at its first step, so an earlier attempt that signed and uploaded would read as skipped.
 */
export async function reviewRun(run, id, opts) {
  if (run.run_attempt !== 1) {
    throw { error: `${label(run)} is attempt ${oneLine(run.run_attempt ?? 'unknown')} of that run, not its first: GitHub lists the jobs of `
      + "a run's latest attempt only, so whether an earlier attempt signed or uploaded cannot be read here. Read every attempt on the run "
      + 'page and against your own list (docs/RUNBOOK.md, a re-run)' };
  }
  const ap = await getJson(`${R}/actions/runs/${run.id}/approvals`, opts);
  if (ap.error) throw ap;
  if (!Array.isArray(ap.value)) throw { error: `${R}/actions/runs/${run.id}/approvals: the answer is not a list` };
  const approved = ap.value.some((a) => isObj(a) && a.state === 'approved' && isObj(a.user) && a.user.id === id
    && Array.isArray(a.environments) && a.environments.some((e) => isObj(e) && e.name === 'index'));
  if (!approved) return { why: "no approval of index by the environment's reviewer" };
  const jobs = await getAll(`${R}/actions/runs/${run.id}/jobs?per_page=100`, 'jobs', opts);
  if (jobs.error) throw jobs;
  const job = (name) => {
    const js = jobs.items.filter((j) => isObj(j) && j.name === name);
    if (js.length !== 1) return `${js.length} jobs named ${name}`;
    return js[0].conclusion === 'success' ? '' : `job ${name} concluded ${oneLine(js[0].conclusion ?? 'nothing yet')}`;
  };
  return { why: '', sign: job('sign'), upload: job('upload') };
}

/** Finds <A> for run `runId`. `env` is the environment gh runs with. */
export async function approvedBase({ runId, env }) {
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

    const reviewer = await readReviewer('index', opts);
    if (reviewer.error) return done(1, `ERROR: ${oneLine(reviewer.error)}`);
    lines.push("reviewer: the only required reviewer of environment index, read now (login and id not printed)");

    const runs = await listRuns(opts);
    let signed = null; // the newest run with an approved index and a successful sign, but no successful upload
    for (const run of runs) {
      if (run.id === runId) { lines.push(`skip ${label(run)}: the run under review`); continue; }
      const off = notOnMain(run);
      if (off) { lines.push(`skip ${wfOf(run) ? label(run) : `run ${run.id}`}: ${off}`); continue; }
      const s = await reviewRun(run, reviewer.id, opts);
      const why = s.why || s.sign || s.upload;
      if (why) {
        if (!s.why && !s.sign) signed ??= run;
        lines.push(`skip ${label(run)}: ${why}`);
        continue;
      }

      const A = run.head_sha;
      lines.push(`A ${A} from ${label(run)}: ${oneLine(run.html_url ?? '')}`);
      lines.push('Confirm on that run page that the index approval shown is your own, and that A is the newest entry');
      lines.push('of your own list with a successful sign and upload.');
      const cmp = await getJson(`${R}/compare/${A}...${B}`, opts);
      if (cmp.error) throw cmp;
      const status = isObj(cmp.value) ? cmp.value.status : undefined;
      lines.push(`compare ${A}...${B}: ${oneLine(status ?? 'no status')}`);
      if (status !== 'ahead' && status !== 'identical') {
        return done(1, `NO APPROVAL: compare ${A}...${B} is ${oneLine(status ?? 'no status')}: <B> does not descend from <A>`);
      }
      lines.push(`Read every change other than the entries/<id>.json files and revoked.json (anything else in entries/ too): https://${HOST}/${REPO}/compare/${A}...${B}`);
      return done(0);
    }
    if (signed) {
      return done(1, `NOT A FIRST PUBLISH: ${label(signed)} has an approval of index by the environment's reviewer and a successful sign `
        + "job, so its signed head may have gone live (recovery R2 counts it as a candidate) and a missing live head is a deleted one. No run "
        + 'has a successful upload, so there is no <A>: only a repair run (recovery R2) may follow, read as the runbook says for a first '
        + 'publish and for a repair; any other run under review: no approval.');
    }
    return done(3, "FIRST PUBLISH: no other run of publish.yml or resign.yml has an approval of index by the environment's reviewer and "
      + 'a successful sign job. Treat <B> as a first publish only while your own list has no entry with a successful sign; '
      + 'otherwise this is NO APPROVAL (runs or approvals may have been deleted).');
  } catch (e) {
    return done(1, `ERROR: ${oneLine(e && e.error ? e.error : e)}`);
  }
}

const USAGE = 'usage: node tools/approved-base.mjs --run <run id>';

async function main(argv) {
  let a;
  try {
    a = parseArgs({ args: argv, strict: true, allowPositionals: false, options: { run: { type: 'string' } } }).values;
  } catch (e) {
    process.stderr.write(`${oneLine(e.message)}\n${USAGE}\n`);
    return 2;
  }
  if (typeof a.run !== 'string' || !/^[1-9][0-9]{0,15}$/.test(a.run) || !Number.isSafeInteger(Number(a.run))) {
    process.stderr.write(`--run must be a workflow run id\n${USAGE}\n`);
    return 2;
  }
  const r = await approvedBase({ runId: Number(a.run), env: process.env });
  process.stdout.write(`${r.lines.join('\n')}\n`);
  return r.code;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).then((code) => { process.exitCode = code; });
}
