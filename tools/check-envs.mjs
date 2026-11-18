#!/usr/bin/env node
// tools/check-envs.mjs: C-ENV1 (plan 4.1), run by the coordinator before every approval of environment index or mirror (4.5 step 4).
// It reads only ids and settings, never a secret, and passes only when:
// - both environments index and mirror exist, with can_admins_bypass false, deployment branches "selected" with exactly the
//   branch policy main, one protection rule of type required_reviewers (beside branch_policy, nothing else) with prevent_self_review
//   on and exactly one reviewer, a User whose id equals the reviewer id committed at <B> (tools/lib/reviewer.mjs, `git show`);
// - that id differs from the id of the token's own account (`gh api user`);
// - under T1 (the default), two probes of the token answer HTTP 403 with the message PROBE_MESSAGE exactly and an
//   x-ratelimit-remaining above 0: GET repos/eve-cyno/plugins/keys (needs Administration read) and DELETE
//   repos/eve-cyno/plugins/actions/artifacts/1 (needs Actions write; the id names no artifact of this repository, so the request
//   changes nothing). Any other answer fails, a 404 of the second one included (the token could delete runs and artifacts).
// `--t2` (the owner accepted the token residual, plan 4.1) skips the probes and says so.
//
// Usage: node tools/check-envs.mjs --rev <B, 40 hex> [--repo-dir <git checkout holding B>] [--t2]
// Exit 0 PASS, 1 FAIL, 2 usage. Logins are never printed; ids and settings only.
import path from 'node:path';
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import { REPO, getAll, getJson, oneLine, probe } from './lib/github.mjs';
import { readReviewerAt } from './lib/reviewer.mjs';

export const PROBE_MESSAGE = 'Resource not accessible by personal access token';
const R = `repos/${REPO}`;
const ENVIRONMENTS = ['index', 'mirror'];
const RULE_TYPES = new Set(['required_reviewers', 'branch_policy']);
export const PROBES = Object.freeze([
  { name: 'Administration', method: 'GET', endpoint: `${R}/keys`, on404: '' },
  { name: 'Actions write', method: 'DELETE', endpoint: `${R}/actions/artifacts/1`, on404: ' (the token could delete workflow runs and artifacts)' },
]);
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/** The problems of one environment as GET .../environments/<name> answers it. */
function environmentProblems(doc, id) {
  const p = [];
  if (!isObj(doc)) return ['the answer is not an object'];
  if (!('can_admins_bypass' in doc) || doc.can_admins_bypass === undefined) p.push('can_admins_bypass is missing');
  else if (doc.can_admins_bypass !== false) p.push(`can_admins_bypass is ${JSON.stringify(doc.can_admins_bypass)}`);
  const rules = Array.isArray(doc.protection_rules) ? doc.protection_rules : null;
  if (!rules) p.push('protection_rules is missing');
  for (const r of rules ?? []) if (!isObj(r) || !RULE_TYPES.has(r.type)) p.push(`a protection rule of type ${oneLine(isObj(r) ? r.type : r)}`);
  const rr = (rules ?? []).filter((r) => isObj(r) && r.type === 'required_reviewers');
  if (rules && rr.length !== 1) p.push(`${rr.length} required_reviewers rules, expected exactly 1`);
  if (rr.length === 1) {
    const rule = rr[0];
    if (rule.prevent_self_review !== true) p.push('prevent_self_review is not true');
    const list = Array.isArray(rule.reviewers) ? rule.reviewers : [];
    if (list.length !== 1) p.push(`${list.length} required reviewers, expected exactly 1`);
    else {
      const one = list[0];
      if (!isObj(one) || one.type !== 'User') p.push(`the required reviewer is a ${oneLine(isObj(one) ? one.type : one)}, not a User`);
      else if (!isObj(one.reviewer) || one.reviewer.id !== id) p.push(`the required reviewer is user ${oneLine(isObj(one.reviewer) ? one.reviewer.id : '?')}, not the reviewer id ${id}`);
    }
  }
  const dbp = doc.deployment_branch_policy;
  if (!isObj(dbp) || dbp.protected_branches !== false || dbp.custom_branch_policies !== true) p.push('deployment branches are not main only (deployment_branch_policy must be selected branches)');
  return p;
}

/** The problems of the branch policies of one environment (exactly one policy: the branch main). */
function policyProblems(items) {
  const named = items.map((x) => (isObj(x) ? `${oneLine(x.name)}${x.type === 'branch' ? '' : ` (${oneLine(x.type ?? 'no type')})`}` : '?'));
  const ok = items.length === 1 && isObj(items[0]) && items[0].name === 'main' && items[0].type === 'branch';
  return ok ? [] : [`branch policies ${named.join(', ') || 'none'}; expected exactly main`];
}

/** The result of one probe: '' on a pass, else why it fails. */
export function probeProblem(answer, pr) {
  if (answer.error) return `no answer (${oneLine(answer.error)})`;
  if (answer.status !== 403) return `HTTP ${answer.status}${answer.status === 404 ? pr.on404 : ''}`;
  const msg = isObj(answer.body) ? answer.body.message : undefined;
  if (msg !== PROBE_MESSAGE) return `HTTP 403 with message ${typeof msg === 'string' ? JSON.stringify(oneLine(msg)) : '(none)'}, not "${PROBE_MESSAGE}"`;
  const rem = answer.headers.get('x-ratelimit-remaining');
  if (!rem) return 'HTTP 403 with the expected message but x-ratelimit-remaining missing';
  if (rem.length !== 1 || !/^[0-9]+$/.test(rem[0]) || Number(rem[0]) <= 0) return `HTTP 403 with the expected message but x-ratelimit-remaining ${oneLine(rem.join(', '))}`;
  return '';
}

/**
 * Runs C-ENV1. `rev` is <B>, `repoDir` a git checkout that holds it, `env` the environment gh and git run with, `t2` skips the
 * probes. Returns { ok, lines }.
 */
export async function checkEnvs({ rev, repoDir, env, t2 = false }) {
  const lines = [];
  let ok = true;
  const fail = (what, why) => { ok = false; lines.push(`FAIL ${what}: ${why}`); };
  const opts = { env };

  const reviewer = await readReviewerAt(repoDir, rev, env);
  if (reviewer.error) {
    fail('reviewer id', reviewer.error);
    lines.push('C-ENV1 FAIL');
    return { ok: false, lines };
  }
  const id = reviewer.id;
  lines.push(`reviewer id ${id} (committed at ${rev})`);

  const user = await getJson('user', opts);
  if (user.error) fail('token account', user.error);
  else if (!isObj(user.value) || !Number.isSafeInteger(user.value.id)) fail('token account', 'the answer has no numeric id');
  else if (user.value.id === id) fail('token account', `the token's account (${id}) is the reviewer: approvals need a separate account`);
  else lines.push(`PASS token account ${user.value.id} is not the reviewer`);

  for (const name of ENVIRONMENTS) {
    const what = `environment ${name}`;
    const doc = await getJson(`${R}/environments/${name}`, opts);
    if (doc.error) { fail(what, doc.error); continue; }
    const p = environmentProblems(doc.value, id);
    const pol = await getAll(`${R}/environments/${name}/deployment-branch-policies?per_page=100`, 'branch_policies', opts);
    if (pol.error) p.push(pol.error);
    else p.push(...policyProblems(pol.items));
    if (p.length) for (const x of p) fail(what, x);
    else lines.push(`PASS ${what}: main only, one required reviewer (${id}), self-review prevented, admin bypass off`);
  }

  if (t2) lines.push('T2: the owner accepted the token residual; no probe sent');
  else {
    for (const pr of PROBES) {
      const why = probeProblem(await probe(pr.method, pr.endpoint, opts), pr);
      if (why) fail(`probe ${pr.name}`, why);
      else lines.push(`PASS probe ${pr.name}: ${pr.method} ${pr.endpoint} answered HTTP 403 "${PROBE_MESSAGE}"`);
    }
  }
  lines.push(ok ? 'C-ENV1 PASS' : 'C-ENV1 FAIL');
  return { ok, lines };
}

const USAGE = 'usage: node tools/check-envs.mjs --rev <40 hex commit> [--repo-dir <git checkout>] [--t2]';

async function main(argv) {
  let a;
  try {
    a = parseArgs({ args: argv, strict: true, allowPositionals: false, options: { rev: { type: 'string' }, 'repo-dir': { type: 'string' }, t2: { type: 'boolean' } } }).values;
  } catch (e) {
    process.stderr.write(`${oneLine(e.message)}\n${USAGE}\n`);
    return 2;
  }
  if (typeof a.rev !== 'string' || !/^[0-9a-f]{40}$/.test(a.rev)) {
    process.stderr.write(`--rev must be the run's commit, 40 lower-case hex\n${USAGE}\n`);
    return 2;
  }
  const r = await checkEnvs({ rev: a.rev, repoDir: path.resolve(a['repo-dir'] ?? '.'), env: process.env, t2: a.t2 === true });
  process.stdout.write(`${r.lines.join('\n')}\n`);
  return r.ok ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).then((code) => { process.exitCode = code; });
}
