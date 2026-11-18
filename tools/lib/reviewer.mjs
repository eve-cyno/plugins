// tools/lib/reviewer.mjs: the reviewer account's numeric GitHub user id (plan 4.2, "The reviewer account in code"). The only place
// that reads it: tools/reviewer.json, either at a given commit through `git show <rev>:tools/reviewer.json` (check-envs.mjs and
// approved-base.mjs, which never read the local checkout) or in the checked-out tree (the workflow tools, which run at github.sha).
// Never from an argument, an environment variable or an Actions variable (static test C-WF11). The file is exactly
// {"reviewerId": <positive integer>}; the committed placeholder and any other shape are refused.
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

export const REVIEWER_FILE = 'tools/reviewer.json';
const REV_RE = /^[0-9a-f]{40}$/;

/** { id } from the text of the reviewer file, or { error }. */
export function parseReviewer(text) {
  let v;
  try { v = JSON.parse(text); } catch { return { error: `${REVIEWER_FILE} is not JSON` }; }
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return { error: `${REVIEWER_FILE} is not an object` };
  if ('placeholder' in v) {
    return { error: `${REVIEWER_FILE} holds the placeholder: the owner writes the reviewer account's numeric GitHub user id (docs/RUNBOOK.md, The reviewer account)` };
  }
  const keys = Object.keys(v);
  if (keys.length !== 1 || keys[0] !== 'reviewerId') return { error: `${REVIEWER_FILE} must be exactly {"reviewerId": <id>}` };
  const id = v.reviewerId;
  if (!Number.isSafeInteger(id) || id <= 0) return { error: `${REVIEWER_FILE}: reviewerId must be a positive whole number` };
  return { id };
}

/**
 * { id } from the reviewer file as committed at `rev` (40 hex) in the git repository `repoDir`, or { error }. Never rejects. `env`
 * is the environment git runs with (the caller's; this module reads no environment of its own).
 */
export function readReviewerAt(repoDir, rev, env) {
  if (typeof rev !== 'string' || !REV_RE.test(rev)) return Promise.resolve({ error: `the commit ${JSON.stringify(rev)} is not 40 lower-case hex` });
  if (env === null || typeof env !== 'object') return Promise.resolve({ error: 'no environment for git was given' });
  const childEnv = { ...env };
  for (const k of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES']) delete childEnv[k];
  return new Promise((resolve) => {
    execFile('git', ['-C', repoDir, 'show', `${rev}:${REVIEWER_FILE}`], { env: childEnv, encoding: 'utf8', maxBuffer: 65536, timeout: 30_000, windowsHide: true },
      (err, stdout) => {
        if (err) return resolve({ error: `the reviewer file at ${rev} could not be read (${err.code === 'ENOENT' ? 'git not found' : 'git show failed'})` });
        const r = parseReviewer(stdout);
        resolve(r.error ? { error: `at ${rev}: ${r.error}` } : r);
      });
  });
}

/** { id } from the reviewer file of the checked-out tree at `root`, or { error }. */
export function readReviewerFile(root) {
  let text;
  try { text = fs.readFileSync(path.join(root, REVIEWER_FILE), 'utf8'); } catch (e) { return { error: `${REVIEWER_FILE}: ${e.code ?? e.message}` }; }
  return parseReviewer(text);
}
