#!/usr/bin/env node
// tools/check-envs.mjs: C-ENV1 (plan 4.1), run by the coordinator with the agents' token before every approval of environment index
// or mirror (4.5). It reads only ids and settings, never a secret's value, and passes only when:
// - both environments index and mirror exist, with can_admins_bypass false, deployment branches "selected" with exactly the
//   branch policy main, protection rules of the types required_reviewers and branch_policy only (no wait timer, no custom rule),
//   prevent_self_review false (the owner both dispatches and approves; on, GitHub would refuse his approval) and exactly one
//   required reviewer, a User, read from the environment (tools/lib/reviewer.mjs); both environments name the same user;
// - that user's login and id appear nowhere at <B>: in no path, no file and no commit (author, committer, message) reachable
//   from <B> (the repository never holds them, plan 4.2); hits are named by path or commit, with the login masked;
// - five probes of the token answer HTTP 403 with the message PROBE_MESSAGE exactly and an x-ratelimit-remaining above 0 (PROBES:
//   Administration, Environments, Secrets, Deployments approve, Actions write). Each request changes nothing: three read lists,
//   two name a run or an artifact that does not exist, and the approve request asks to reject. Any other answer fails, a 404
//   included.
// The agents' token was switched on 2026-11-18 (plan 4.1, Q16: T1 done), so there is no mode without the probes (the former --t2 is
// a usage error): with one account as dispatcher and approver, the token's refusals are the safeguard.
//
// Usage: node tools/check-envs.mjs --rev <B, 40 hex> [--repo-dir <git checkout holding B>]
// Exit 0 PASS, 1 FAIL, 2 usage. The reviewer's login and id are never printed; ids of runs and settings only.
import { execFile } from 'node:child_process';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import { REPO, getAll, getJson, oneLine, probe } from './lib/github.mjs';
import { reviewerOf } from './lib/reviewer.mjs';

export const PROBE_MESSAGE = 'Resource not accessible by personal access token';
const R = `repos/${REPO}`;
const ENVIRONMENTS = ['index', 'mirror'];
const RULE_TYPES = new Set(['required_reviewers', 'branch_policy']);
const REV_RE = /^[0-9a-f]{40}$/;
export const PROBES = Object.freeze([
  { key: 'admin', name: 'Administration', method: 'GET', endpoint: `${R}/keys`, on404: '' },
  { key: 'env', name: 'Environments', method: 'GET', endpoint: `${R}/environments/index/secrets`, on404: '' },
  { key: 'secrets', name: 'Secrets', method: 'GET', endpoint: `${R}/actions/secrets`, on404: '' },
  {
    key: 'deploy', name: 'Deployments (approve)', method: 'POST', endpoint: `${R}/actions/runs/1/pending_deployments`,
    fields: ['-f', 'state=rejected', '-f', 'comment=C-ENV1 probe: changes nothing', '-F', 'environment_ids[]=1'],
    on404: ' (the token may be able to approve deployments)',
  },
  { key: 'actions', name: 'Actions write', method: 'DELETE', endpoint: `${R}/actions/artifacts/1`, on404: ' (the token may be able to delete workflow runs and artifacts)' },
]);
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/** The problems of one environment as GET .../environments/<name> answers it, its reviewer aside (reviewerOf). */
function environmentProblems(doc) {
  const p = [];
  if (!isObj(doc)) return ['the answer is not an object'];
  if (!('can_admins_bypass' in doc) || doc.can_admins_bypass === undefined) p.push('can_admins_bypass is missing');
  else if (doc.can_admins_bypass !== false) p.push(`can_admins_bypass is ${JSON.stringify(doc.can_admins_bypass)}`);
  const rules = Array.isArray(doc.protection_rules) ? doc.protection_rules : [];
  for (const r of rules) if (!isObj(r) || !RULE_TYPES.has(r.type)) p.push(`a protection rule of type ${oneLine(isObj(r) ? r.type : r)}`);
  const rr = rules.filter((r) => isObj(r) && r.type === 'required_reviewers');
  if (rr.length === 1) {
    const v = rr[0].prevent_self_review;
    if (v === undefined) p.push('prevent_self_review is missing, expected false');
    else if (v !== false) p.push(`prevent_self_review is ${oneLine(JSON.stringify(v))}, expected false (the owner dispatches and approves)`);
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

/** Runs git without a shell in `repoDir`, with the caller's environment minus the variables that redirect it. Never rejects. */
function git(repoDir, args, env) {
  const childEnv = { ...env };
  for (const k of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES']) delete childEnv[k];
  return new Promise((resolve) => {
    execFile('git', ['-C', repoDir, '-c', 'log.showSignature=false', '-c', 'core.quotePath=false', ...args],
      { env: childEnv, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: 120_000, windowsHide: true },
      (err, stdout) => resolve(err ? { code: typeof err.code === 'number' ? err.code : -1, stdout: stdout ?? '' } : { code: 0, stdout }));
  });
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\-]/g, '\\$&');
/** The login or the id as a whole word (git grep -w: a word is letters, digits and underscore), any case. */
const wordRe = (who, flags = 'i') => new RegExp(`(?<![A-Za-z0-9_])(?:${escapeRe(who.login)}|${who.id})(?![A-Za-z0-9_])`, flags);
const masked = (s, who) => oneLine(s.replace(new RegExp(`(?<![A-Za-z0-9_])${escapeRe(who.login)}(?![A-Za-z0-9_])`, 'gi'), '<login>')
  .replace(new RegExp(`(?<![0-9])${who.id}(?![0-9])`, 'g'), '<id>'));
const listed = (n, one, many, items) => `${n} ${n === 1 ? one : many} (${items.slice(0, 20).join(', ')}${n > 20 ? ', ...' : ''})`;

/**
 * Where the reviewer `who` ({ id, login }) appears at commit `rev` of `repoDir`: { paths, files, commits } (paths masked, commits as
 * full ids), or { error }. Reads the tree and the history of `rev` only, never the checkout.
 */
export async function identityHits(repoDir, rev, who, env) {
  if (typeof rev !== 'string' || !REV_RE.test(rev)) return { error: `the commit ${oneLine(JSON.stringify(rev))} is not 40 lower-case hex` };
  const cannot = { error: `the commit ${rev} could not be read (fetch it into the checkout given with --repo-dir)` };
  const re = wordRe(who);
  const tree = await git(repoDir, ['ls-tree', '-r', '-z', '--name-only', '--full-tree', rev], env);
  if (tree.code !== 0) return cannot;
  const paths = tree.stdout.split('\0').filter((p) => p && re.test(p)).map((p) => masked(p, who));
  const grep = await git(repoDir, ['grep', '-z', '-l', '-i', '-w', '-F', '-e', who.login, '-e', String(who.id), rev, '--'], env);
  if (grep.code !== 0 && grep.code !== 1) return cannot;
  const files = grep.code === 1 ? [] : grep.stdout.split('\0').filter(Boolean).map((p) => masked(p.startsWith(`${rev}:`) ? p.slice(rev.length + 1) : p, who));
  const log = await git(repoDir, ['log', '--no-mailmap', '--format=%x01%H%x00%an%x00%ae%x00%cn%x00%ce%x00%B', rev], env);
  if (log.code !== 0) return cannot;
  const commits = log.stdout.split('\x01').filter(Boolean).filter((c) => re.test(c)).map((c) => c.slice(0, 40));
  return { paths, files, commits };
}

/**
 * Runs C-ENV1. `rev` is <B>, `repoDir` a git checkout that holds it, `env` the environment gh and git run with (the agents' token).
 * Returns { ok, lines }.
 */
export async function checkEnvs({ rev, repoDir, env }) {
  const lines = [];
  let ok = true;
  const fail = (what, why) => { ok = false; lines.push(`FAIL ${what}: ${why}`); };
  const opts = { env };

  const reviewers = new Map();
  for (const name of ENVIRONMENTS) {
    const what = `environment ${name}`;
    const doc = await getJson(`${R}/environments/${name}`, opts);
    if (doc.error) { fail(what, doc.error); continue; }
    const p = environmentProblems(doc.value);
    const who = reviewerOf(doc.value);
    if (who.error) p.push(who.error);
    else reviewers.set(name, who);
    const pol = await getAll(`${R}/environments/${name}/deployment-branch-policies?per_page=100`, 'branch_policies', opts);
    if (pol.error) p.push(pol.error);
    else p.push(...policyProblems(pol.items));
    if (p.length) for (const x of p) fail(what, x);
    else lines.push(`PASS ${what}: main only, one required reviewer (a User; not printed), self-review prevention off, admin bypass off`);
  }
  const [a, b] = ENVIRONMENTS.map((n) => reviewers.get(n));
  if (a && b && a.id !== b.id) fail('reviewer', 'index and mirror name different reviewers');
  else if (a && b) lines.push('PASS reviewer: index and mirror name the same single user');

  const people = [...new Map([...reviewers.values()].map((w) => [w.id, w])).values()];
  if (people.length === 0) fail('identity', `no reviewer was read, so ${rev} could not be checked for the reviewer's login and id`);
  for (const who of people) {
    const h = await identityHits(repoDir, rev, who, env);
    if (h.error) { fail('identity', h.error); continue; }
    const parts = [];
    if (h.paths.length) parts.push(listed(h.paths.length, 'path', 'paths', h.paths));
    if (h.files.length) parts.push(listed(h.files.length, 'file', 'files', h.files));
    if (h.commits.length) parts.push(listed(h.commits.length, 'commit', 'commits', h.commits));
    if (parts.length) fail('identity', `the required reviewer's login or id is written at ${rev} in ${parts.join(', ')}`);
    else lines.push('PASS identity: the required reviewer\'s login and id appear in no path, file or commit at <B>');
  }

  for (const pr of PROBES) {
    const why = probeProblem(await probe(pr.method, pr.endpoint, opts, pr.fields ?? []), pr);
    if (why) fail(`probe ${pr.name}`, why);
    else lines.push(`PASS probe ${pr.name}: ${pr.method} ${pr.endpoint} answered HTTP 403 "${PROBE_MESSAGE}"`);
  }
  lines.push(ok ? 'C-ENV1 PASS' : 'C-ENV1 FAIL');
  return { ok, lines };
}

const USAGE = 'usage: node tools/check-envs.mjs --rev <40 hex commit> [--repo-dir <git checkout>]';

async function main(argv) {
  let a;
  try {
    a = parseArgs({ args: argv, strict: true, allowPositionals: false, options: { rev: { type: 'string' }, 'repo-dir': { type: 'string' } } }).values;
  } catch (e) {
    process.stderr.write(`${oneLine(e.message)}\n${USAGE}\n`);
    return 2;
  }
  if (typeof a.rev !== 'string' || !REV_RE.test(a.rev)) {
    process.stderr.write(`--rev must be the run's commit, 40 lower-case hex\n${USAGE}\n`);
    return 2;
  }
  const r = await checkEnvs({ rev: a.rev, repoDir: path.resolve(a['repo-dir'] ?? '.'), env: process.env });
  process.stdout.write(`${r.lines.join('\n')}\n`);
  return r.ok ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).then((code) => { process.exitCode = code; });
}
