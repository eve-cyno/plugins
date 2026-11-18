// A stub `gh` for the tests of tools/check-envs.mjs, tools/approved-base.mjs and tools/lib/reviewer.mjs. It is written into a temp
// folder that is the only entry of PATH the tools see, so the real gh is never found: no network, no token. It answers
// `<method> <endpoint>` (the last argument) from a routes file (STUB_ROUTES) and appends its arguments to a log (STUB_LOG). The real
// git is linked beside it, because check-envs.mjs reads the run's commit with git to look for the reviewer's login and id.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** Makes the stub folder in a new temp folder (registered in `temps`) and returns its path. */
export function makeGhStub(temps) {
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'gh-stub-'));
  temps.push(bin);
  fs.writeFileSync(path.join(bin, 'gh'), `#!${process.execPath}
const fs = require('node:fs');
const argv = process.argv.slice(2);
const e = process.env;
fs.appendFileSync(e.STUB_LOG, JSON.stringify(argv) + '\\n');
const m = argv.find((a) => a.startsWith('--method='));
const key = (m ? m.slice(9) : 'GET') + ' ' + argv[argv.length - 1];
const routes = JSON.parse(fs.readFileSync(e.STUB_ROUTES, 'utf8'));
const r = routes[key];
if (!r) { process.stderr.write('stub: no route for ' + key + '\\n'); process.exit(97); }
if (r.stdout !== undefined) process.stdout.write(typeof r.stdout === 'string' ? r.stdout : JSON.stringify(r.stdout));
if (r.stderr) process.stderr.write(r.stderr);
process.exitCode = r.exit === undefined ? 0 : r.exit;
`, { mode: 0o755 });
  const git = spawnSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).stdout.trim();
  if (!git) throw new Error('git is not on PATH');
  fs.symlinkSync(git, path.join(bin, 'git'));
  return bin;
}

/** The environment for one tool run against the stub: PATH is the stub folder only. Returns { env, log() }. */
export function stubEnv(bin, routes, temps) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gh-run-'));
  temps.push(dir);
  const routesFile = path.join(dir, 'routes.json');
  const logFile = path.join(dir, 'log.jsonl');
  fs.writeFileSync(routesFile, JSON.stringify(routes));
  fs.writeFileSync(logFile, '');
  const env = { PATH: bin, HOME: dir, STUB_ROUTES: routesFile, STUB_LOG: logFile };
  const log = () => fs.readFileSync(logFile, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  return { env, log };
}

const GIT_ENV = {
  GIT_AUTHOR_NAME: 'test', GIT_AUTHOR_EMAIL: 'test@example.invalid', GIT_COMMITTER_NAME: 'test',
  GIT_COMMITTER_EMAIL: 'test@example.invalid', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null',
};

/**
 * A temp git repository whose commit <B> holds `files` ({ path: text }), made with `message` and the author `author` ({ name, email },
 * a neutral test identity by default); `later` ({ path: text }), when given, is committed on top of <B> and left in the working tree,
 * so a tool that reads HEAD or the checkout instead of <B> sees it. Returns { dir, rev }.
 */
export function repoWith(files, temps, { message = 'B', author, later } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'b-repo-'));
  temps.push(dir);
  const env = { ...process.env, ...GIT_ENV, ...(author ? { GIT_AUTHOR_NAME: author.name, GIT_AUTHOR_EMAIL: author.email } : {}) };
  const git = (...a) => {
    const r = spawnSync('git', ['-C', dir, ...a], { encoding: 'utf8', env });
    if (r.status !== 0) throw new Error(`git ${a.join(' ')}: ${r.stderr}`);
    return r.stdout.trim();
  };
  const write = (tree) => {
    for (const [p, text] of Object.entries(tree)) {
      fs.mkdirSync(path.dirname(path.join(dir, p)), { recursive: true });
      fs.writeFileSync(path.join(dir, p), text);
    }
  };
  git('init', '-q');
  write(files);
  git('add', '.');
  git('commit', '-q', '-m', message);
  const rev = git('rev-parse', 'HEAD');
  if (later) {
    write(later);
    git('add', '.');
    git('commit', '-q', '-m', 'later');
  }
  return { dir, rev };
}

/** The test reviewer: the one required reviewer of both environments in the canned answers. */
export const REVIEWER = Object.freeze({ id: 987654, login: 'reviewer-account' });

/**
 * An environment as GET /repos/{owner}/{repo}/environments/{name} answers it, set up as docs/RUNBOOK.md says (one required reviewer,
 * prevent_self_review false, admin bypass off, selected branches); `o` overrides single parts.
 */
export function envDoc(name, o = {}) {
  return {
    id: name === 'index' ? 7 : 8, node_id: 'EN_x', name, url: `https://api.github.com/repos/eve-cyno/plugins/environments/${name}`,
    html_url: `https://github.com/eve-cyno/plugins/deployments/activity_log?environments_filter=${name}`,
    created_at: '2026-11-18T10:00:00Z', updated_at: '2026-11-18T10:00:00Z',
    can_admins_bypass: 'bypass' in o ? o.bypass : false,
    protection_rules: o.rules ?? [
      { id: 11, node_id: 'GA_r', prevent_self_review: 'selfReview' in o ? o.selfReview : false, type: 'required_reviewers',
        reviewers: o.reviewers ?? [{ type: 'User', reviewer: { login: REVIEWER.login, id: REVIEWER.id, type: 'User', site_admin: false } }] },
      { id: 12, node_id: 'GA_b', type: 'branch_policy' },
    ],
    deployment_branch_policy: 'dbp' in o ? o.dbp : { protected_branches: false, custom_branch_policies: true },
  };
}
/** A User entry of a required_reviewers rule. */
export const userReviewer = (id, login = `user-${id}`) => ({ type: 'User', reviewer: { login, id, type: 'User' } });
