#!/usr/bin/env node
// tools/check-envs.mjs: C-ENV1 (plan 4.1), run by the coordinator with the agents' token before every approval of environment index
// or mirror (4.5). It reads ids, settings and the names of secrets and variables, never a secret's value (GitHub returns none), and
// the values of the two mirror variables only to check them; it prints neither value. It passes only when:
// - both environments index and mirror exist, with can_admins_bypass false, deployment branches "selected" with exactly the
//   branch policy main, protection rules of the types required_reviewers and branch_policy only (no wait timer, no custom rule),
//   prevent_self_review false (the owner both dispatches and approves; on, GitHub would refuse his approval) and exactly one
//   required reviewer, a User, read from the environment (tools/lib/reviewer.mjs); both environments name the same user;
// - that user's login and id appear nowhere at <B>: in no path, no file and no commit (author, committer, message) reachable
//   from <B> (the repository never holds them, plan 4.2); hits are named by path or commit, with the login masked;
// - six probes of the token answer as the owner set it up (PROBES). Four must be refused: HTTP 403 with the message PROBE_MESSAGE
//   exactly and an x-ratelimit-remaining above 0 (Administration, Deployments approve, Actions write, and creating an environment);
//   any other answer fails, a 404 included. Two must be allowed: the Secrets and Environments permissions are the token's for good
//   (owner decision 2026-11-18, so agents set secrets with the scripted flows), and their secrets lists must answer HTTP 200 with a
//   list (names only; nothing of it is printed).
//   Requests: three read lists; two name a run or an artifact that does not exist, and the approve request asks to reject; one PUT
//   names the environment PROBE_ENV, which a GET must first show does not exist (exactly 404; on any other answer the PUT is not
//   sent). That PUT is the only probe that could change something: a token wrongly allowed to make it creates PROBE_ENV, and the
//   check then fails with an ALARM line, first in the output and on stderr, that names the environment the owner deletes;
// - the six secrets and variables the workflows read (STORED) are each set once in their environment with a valid updated_at, which
//   is printed for the reviewer to compare with the day the owner or the coordinator set it (docs/RUNBOOK.md); R2_BUCKET is
//   eve-cyno-plugins and R2_ACCOUNT_ID is 32 lower-case hex (ok or fail only, never the value);
// - no secret or variable named MINISIGN_* or R2_* is set at repository or organization level (OUTSIDE): one there reaches every
//   job of the repository without an approval of index or mirror. Listing the variables needs read access to Variables; a list
//   that cannot be read, or did not come back whole, fails closed.
// The agents' token was switched on 2026-11-18 (plan 4.1, Q16: T1 done), so there is no mode without the probes (the former --t2 is
// a usage error): with one account as dispatcher and approver, the token's refusals are the safeguard.
//
// Usage: node tools/check-envs.mjs --rev <B, 40 hex> [--repo-dir <git checkout holding B>]
// Exit 0 PASS, 1 FAIL (an ALARM included), 2 usage. The reviewer's login and id are never printed; ids of runs and settings only.
import { execFile } from 'node:child_process';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import { REPO, getAll, getJson, oneLine, probe } from './lib/github.mjs';
import { reviewerOf } from './lib/reviewer.mjs';

export const PROBE_MESSAGE = 'Resource not accessible by personal access token';
/** The environment the create probe names. It must not exist; a token that may create it fails C-ENV1, and the owner deletes it. */
export const PROBE_ENV = 'c-env1-probe-denied';
const R = `repos/${REPO}`;
const DELETE_IT = `the owner deletes it (Settings, Environments, ${PROBE_ENV}, Delete environment)`;
const ENVIRONMENTS = ['index', 'mirror'];
const RULE_TYPES = new Set(['required_reviewers', 'branch_policy']);
const REV_RE = /^[0-9a-f]{40}$/;
/** expect 403: refused exactly (probeProblem); expect 200: allowed, a list of secrets. `creates`: the probe's environment must not exist. */
export const PROBES = Object.freeze([
  { key: 'admin', name: 'Administration', expect: 403, method: 'GET', endpoint: `${R}/keys`, on404: '' },
  { key: 'env', name: 'Environments', expect: 200, method: 'GET', endpoint: `${R}/environments/index/secrets` },
  { key: 'secrets', name: 'Secrets', expect: 200, method: 'GET', endpoint: `${R}/actions/secrets` },
  {
    key: 'deploy', name: 'Deployments (approve)', expect: 403, method: 'POST', endpoint: `${R}/actions/runs/1/pending_deployments`,
    fields: ['-f', 'state=rejected', '-f', 'comment=C-ENV1 probe: changes nothing', '-F', 'environment_ids[]=1'],
    on404: ' (the token may be able to approve deployments)',
  },
  { key: 'actions', name: 'Actions write', expect: 403, method: 'DELETE', endpoint: `${R}/actions/artifacts/1`, on404: ' (the token may be able to delete workflow runs and artifacts)' },
  { key: 'envcreate', name: 'Administration (create environment)', expect: 403, method: 'PUT', endpoint: `${R}/environments/${PROBE_ENV}`, on404: '', creates: PROBE_ENV },
]);
/**
 * The secrets and variables the workflows read, each in its environment: the reviewer compares the printed updated_at with the day
 * it was set. `value` checks a variable's value (never printed); `rule` says what it must be.
 */
export const STORED = Object.freeze([
  { kind: 'secret', name: 'MINISIGN_INDEX_KEY', env: 'index' },
  { kind: 'secret', name: 'MINISIGN_INDEX_PASSWORD', env: 'index' },
  { kind: 'secret', name: 'R2_ACCESS_KEY_ID', env: 'mirror' },
  { kind: 'secret', name: 'R2_SECRET_ACCESS_KEY', env: 'mirror' },
  { kind: 'variable', name: 'R2_ACCOUNT_ID', env: 'mirror', value: (v) => /^[0-9a-f]{32}$/.test(v), rule: 'a Cloudflare account id (32 lower-case hex)', shown: 'a Cloudflare account id (32 lower-case hex; not printed)' },
  { kind: 'variable', name: 'R2_BUCKET', env: 'mirror', value: (v) => v === 'eve-cyno-plugins', rule: 'eve-cyno-plugins', shown: 'eve-cyno-plugins' },
]);
/** The lists outside the environments where no name MINISIGN_* or R2_* may be set (the repository's own and the organization's). */
export const OUTSIDE = Object.freeze([
  { what: 'repository secrets', endpoint: `${R}/actions/secrets?per_page=100`, key: 'secrets' },
  { what: 'organization secrets', endpoint: `${R}/actions/organization-secrets?per_page=100`, key: 'secrets' },
  { what: 'repository variables', endpoint: `${R}/actions/variables?per_page=30`, key: 'variables' },
  { what: 'organization variables', endpoint: `${R}/actions/organization-variables?per_page=30`, key: 'variables' },
]);
const OWN_NAME_RE = /^(?:MINISIGN_|R2_)/i;
const STAMP_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/;
const UNREADABLE = 'a list that cannot be read fails closed';
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
  if (pr.expect === 200) {
    if (answer.status !== 200) return `HTTP ${answer.status}, expected 200 (the agents' token holds Secrets and Environments, read and write, owner decision 2026-11-18)`;
    const b = answer.body;
    if (!isObj(b) || !Number.isSafeInteger(b.total_count) || !Array.isArray(b.secrets)) return 'HTTP 200 but not a list of secrets { total_count, secrets }';
    return '';
  }
  if (pr.creates && answer.status >= 200 && answer.status < 300) return `HTTP ${answer.status}: the agents' token created or changed the environment ${pr.creates}; ${DELETE_IT}`;
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
 * Returns { ok, lines, alarms } (alarms: lines that are also first in `lines`, for something the check itself may have created).
 */
export async function checkEnvs({ rev, repoDir, env }) {
  const lines = [];
  const alarms = [];
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
    if (pr.creates) {
      const g = await probe('GET', pr.endpoint, opts);
      if (g.error || g.status !== 404) {
        fail(`probe ${pr.name}`, g.status === 200 ? `the environment ${pr.creates} exists (HTTP 200); ${DELETE_IT}, so the probe names a new one`
          : `could not confirm that the environment ${pr.creates} does not exist (${g.error ? `no answer: ${oneLine(g.error)}` : `HTTP ${g.status}`}; expected 404)`);
        continue; // the PUT is sent only after a GET that answered exactly 404
      }
    }
    const answer = await probe(pr.method, pr.endpoint, opts, pr.fields ?? []);
    const why = probeProblem(answer, pr);
    if (why) fail(`probe ${pr.name}`, why);
    else if (pr.expect === 200) lines.push(`PASS probe ${pr.name}: ${pr.method} ${pr.endpoint} answered HTTP 200 (allowed, owner decision 2026-11-18)`);
    else lines.push(`PASS probe ${pr.name}: ${pr.method} ${pr.endpoint} answered HTTP 403 "${PROBE_MESSAGE}"`);
    if (pr.creates && !answer.error && answer.status >= 200 && answer.status < 300) {
      alarms.push(`ALARM: the agents' token created the environment ${pr.creates} in ${REPO}: ${DELETE_IT} and takes Administration off the token; no approval until then`);
    }
  }
  // ---- the six secrets and variables in their environments, and none of their names outside them
  const lists = new Map();
  for (const s of STORED) {
    const k = `${s.env} ${s.kind}`;
    if (!lists.has(k)) lists.set(k, await getAll(`${R}/environments/${s.env}/${s.kind}s?per_page=${s.kind === 'secret' ? 100 : 30}`, `${s.kind}s`, opts));
  }
  for (const s of STORED) {
    const what = `${s.kind} ${s.name} (environment ${s.env})`;
    const l = lists.get(`${s.env} ${s.kind}`);
    if (l.error) { fail(what, `${oneLine(l.error)} (${UNREADABLE})`); continue; }
    const found = l.items.filter((x) => isObj(x) && x.name === s.name);
    if (found.length !== 1) { fail(what, found.length === 0 ? 'not set' : `listed ${found.length} times`); continue; }
    const at = found[0].updated_at;
    if (typeof at !== 'string' || !STAMP_RE.test(at) || !Number.isFinite(Date.parse(at))) { fail(what, 'no valid updated_at'); continue; }
    if (s.value && (typeof found[0].value !== 'string' || !s.value(found[0].value))) { fail(what, `the value is not ${s.rule} (not printed)`); continue; }
    lines.push(`PASS ${what}: updated_at ${at}${s.value ? `; the value is ${s.shown}` : ''}`);
  }
  lines.push('updated_at: compare each date above with the day the owner or the coordinator set that value; a later date that nobody '
    + 'set means no approval (docs/RUNBOOK.md)');
  for (const o of OUTSIDE) {
    const l = await getAll(o.endpoint, o.key, opts);
    if (l.error) { fail(o.what, `${oneLine(l.error)} (${UNREADABLE})`); continue; }
    const names = l.items.map((x) => (isObj(x) && typeof x.name === 'string' && x.name !== '' ? x.name : null));
    if (names.includes(null)) { fail(o.what, 'an item without a name'); continue; }
    const own = names.filter((n) => OWN_NAME_RE.test(n));
    if (own.length) {
      fail(o.what, `${own.map(oneLine).join(', ')} is set outside the environments: there it reaches every job of the repository without an `
        + 'approval of index or mirror. MINISIGN_* and R2_* belong to the environments only; the owner or the coordinator deletes it');
    } else lines.push(`PASS ${o.what}: none named MINISIGN_* or R2_* (${names.length} listed; names not printed)`);
  }
  lines.push(ok ? 'C-ENV1 PASS' : 'C-ENV1 FAIL');
  return { ok, lines: [...alarms, ...lines], alarms };
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
  for (const l of r.alarms) process.stderr.write(`${l}\n`);
  process.stdout.write(`${r.lines.join('\n')}\n`);
  return r.ok ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).then((code) => { process.exitCode = code; });
}
