// A stub `gh` for the tests of tools/check-envs.mjs and tools/approved-base.mjs. It is written into a temp folder that is the only
// entry of PATH the tools see, so the real gh is never found: no network, no token. It answers `<method> <endpoint>` (the last
// argument) from a routes file (STUB_ROUTES) and appends its arguments to a log (STUB_LOG). The real git is linked beside it, because
// the tools read the reviewer file with `git show <rev>:<path>`.
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
 * A temp git repository whose commit <B> holds tools/reviewer.json with `atB` (text); `working` (text), when given, is committed on
 * top of <B> and left in the working tree, so a tool that reads HEAD or the checkout instead of <B> sees it. Returns { dir, rev }.
 */
export function repoWithReviewer(atB, working, temps) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rv-repo-'));
  temps.push(dir);
  const git = (...a) => {
    const r = spawnSync('git', ['-C', dir, ...a], { encoding: 'utf8', env: { ...process.env, ...GIT_ENV } });
    if (r.status !== 0) throw new Error(`git ${a.join(' ')}: ${r.stderr}`);
    return r.stdout.trim();
  };
  git('init', '-q');
  fs.mkdirSync(path.join(dir, 'tools'));
  fs.writeFileSync(path.join(dir, 'tools', 'reviewer.json'), atB);
  git('add', '.');
  git('commit', '-q', '-m', 'B');
  const rev = git('rev-parse', 'HEAD');
  if (working !== undefined) {
    fs.writeFileSync(path.join(dir, 'tools', 'reviewer.json'), working);
    git('commit', '-q', '-am', 'later');
  }
  return { dir, rev };
}
