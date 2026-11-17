// tools/lib/provenance.mjs: check C12 (plan 3.2). When an entry declares `provenance`, its archive must carry a GitHub artifact
// attestation made in the repository that the entry's `source` names, by the declared workflow when one is declared, on a
// GitHub-hosted runner. `gh attestation verify` does the cryptography (bundle, certificate chain, transparency log); this module
// runs it with a fixed argument list and no shell, then binds every attestation in its JSON answer to the entry again, because
// gh's own --signer-workflow is a regular-expression prefix. Anything it does not expect refuses (fail closed).
import { execFile } from 'node:child_process';
import path from 'node:path';

export const ISSUER = 'https://token.actions.githubusercontent.com';
export const PREDICATE = 'https://slsa.dev/provenance/v1';
export const TIMEOUT_MS = 120_000;
export const MAX_OUTPUT = 4 * 1024 * 1024;
const HOST = 'github.com';
// ASCII only, so no Unicode case fold can make two names equal; an owner or a name never starts with a dash.
const REPO = '[A-Za-z0-9][A-Za-z0-9-]{0,38}/[A-Za-z0-9_.][A-Za-z0-9_.-]{0,99}';
const REPO_RE = new RegExp(`^${REPO}$`);
const SOURCE_RE = new RegExp(`^https://github\\.com/(${REPO})$`);
const SIGNER_RE = new RegExp(`^https://github\\.com/(${REPO})/([^@]+)@(.+)$`);
const WORKFLOW_RE = /^\.github\/workflows\/[A-Za-z0-9_.-]+\.ya?ml$/;
const SHA256_RE = /^[0-9a-f]{64}$/;

const isObj = (v) => typeof v === 'object' && v !== null && !Array.isArray(v);
const validRepo = (r) => typeof r === 'string' && REPO_RE.test(r) && !/\/\.\.?$/.test(r);
const sameRepo = (a, b) => a.toLowerCase() === b.toLowerCase();
const show = (v) => JSON.stringify(v ?? null).slice(0, 200);
/** gh's stderr as one printable line: no workflow command (`::...`) can start a line of the job log. */
const oneLine = (s) => String(s).replace(/[^\x21-\x7e]+/g, ' ').trim().slice(0, 300);

/** The `owner/name` of a `https://github.com/<owner>/<name>` link, or null for any other value. */
export function githubRepoOf(url) {
  const m = typeof url === 'string' ? SOURCE_RE.exec(url) : null;
  return m && validRepo(m[1]) ? m[1] : null;
}

/** Why the declared provenance is malformed or not bound to the entry's `source`, or null (also when none is declared). */
export function provenanceProblem(entry) {
  const p = entry.provenance;
  if (p === undefined) return null;
  if (!isObj(p) || Object.keys(p).some(k => k !== 'repo' && k !== 'workflow')) return 'provenance must be { repo, workflow? }';
  if (!validRepo(p.repo)) return `provenance.repo ${show(p.repo)} is not owner/name`;
  if (p.workflow !== undefined && (typeof p.workflow !== 'string' || !WORKFLOW_RE.test(p.workflow))) {
    return `provenance.workflow ${show(p.workflow)} is not a .github/workflows/<file>.yml path`;
  }
  const fromSource = githubRepoOf(entry.source);
  if (fromSource === null) return `source ${show(entry.source)} is not a https://github.com/<owner>/<name> link, so provenance cannot be bound to it`;
  if (fromSource !== p.repo) return `provenance.repo ${show(p.repo)} is not the repository of source ${show(entry.source)}`;
  return null;
}

/** gh's arguments: every value in one `--flag=value` word and the archive alone after `--`, so no value can read as a flag. */
export function attestationArgs(archive, provenance) {
  const args = ['attestation', 'verify', `--hostname=${HOST}`, `--repo=${provenance.repo}`];
  if (provenance.workflow !== undefined) args.push(`--signer-workflow=${HOST}/${provenance.repo}/${provenance.workflow}`);
  args.push(`--cert-oidc-issuer=${ISSUER}`, `--predicate-type=${PREDICATE}`, '--deny-self-hosted-runners', '--format=json', '--', archive);
  return args;
}

/** Why one element of gh's JSON answer is not an attestation of this archive by the declared repository and workflow, or null. */
function attestationProblem(item, { repo, workflow }, sha256) {
  const r = isObj(item) ? item.verificationResult : undefined;
  const st = isObj(r) ? r.statement : undefined;
  const c = isObj(r) && isObj(r.signature) ? r.signature.certificate : undefined;
  if (!isObj(st) || !isObj(c)) return 'no statement or no certificate';
  if (st.predicateType !== PREDICATE) return `predicate type ${show(st.predicateType)} is not ${PREDICATE}`;
  if (!Array.isArray(st.subject) || !st.subject.some(s => isObj(s) && isObj(s.digest) && s.digest.sha256 === sha256)) {
    return 'no subject has the archive SHA-256';
  }
  if (c.issuer !== ISSUER) return `issuer ${show(c.issuer)} is not ${ISSUER}`;
  if (c.runnerEnvironment !== 'github-hosted') return `runner ${show(c.runnerEnvironment)} is not github-hosted`;
  const source = githubRepoOf(c.sourceRepositoryURI);
  if (source === null || !sameRepo(source, repo)) return `source repository ${show(c.sourceRepositoryURI)} is not ${repo}`;
  if (c.subjectAlternativeName !== c.buildSignerURI) return `SubjectAlternativeName ${show(c.subjectAlternativeName)} is not the build signer`;
  const m = typeof c.buildSignerURI === 'string' ? SIGNER_RE.exec(c.buildSignerURI) : null;
  if (m === null || !validRepo(m[1]) || !sameRepo(m[1], repo)) return `signer ${show(c.buildSignerURI)} is not a workflow of ${repo}`;
  if (workflow !== undefined ? m[2] !== workflow : !WORKFLOW_RE.test(m[2])) {
    return `signer workflow ${show(m[2])} is not ${workflow ?? 'a .github/workflows/<file>.yml path'}`;
  }
  return null;
}

/** Runs gh without a shell. Resolves to { stdout } or { error }; never rejects. */
function runGh(args, env, timeoutMs) {
  const childEnv = { ...env, GH_PROMPT_DISABLED: '1', GH_NO_UPDATE_NOTIFIER: '1' };
  delete childEnv.GH_HOST; // the host is the --hostname argument, never the environment
  return new Promise((resolve) => {
    let child;
    try {
      child = execFile('gh', args, { env: childEnv, encoding: 'utf8', maxBuffer: MAX_OUTPUT, timeout: timeoutMs, killSignal: 'SIGKILL',
        windowsHide: true }, (err, stdout, stderr) => {
        if (!err) return resolve({ stdout });
        if (err.code === 'ENOENT') return resolve({ error: 'gh not found on PATH' });
        if (err.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') return resolve({ error: `gh attestation verify passed the output limit (${MAX_OUTPUT} bytes)` });
        if (err.killed) return resolve({ error: `gh attestation verify did not finish within ${timeoutMs} ms` });
        if (typeof err.code === 'number') return resolve({ error: `gh attestation verify exited ${err.code}: ${oneLine(stderr)}` });
        return resolve({ error: `gh attestation verify failed: ${oneLine(err.signal ?? err.message)}` });
      });
    } catch (err) {
      return resolve({ error: `gh attestation verify could not start: ${oneLine(err.message)}` });
    }
    child.stdin?.end();
  });
}

/**
 * C12 for one archive of an entry. Resolves to { declared: false, problem: null } when the entry declares no provenance,
 * { declared: true, problem: null, attestations: n } when gh verified n attestations and each is bound to the entry, and
 * { declared: true, problem: '<one line>' } otherwise. `archive` is the downloaded file (an absolute path), `sha256` its hash (C5).
 */
export async function checkProvenance({ entry, archive, sha256, env = process.env, timeoutMs = TIMEOUT_MS }) {
  if (entry.provenance === undefined) return { declared: false, problem: null };
  const refuse = (problem) => ({ declared: true, problem });
  const bad = provenanceProblem(entry);
  if (bad) return refuse(bad);
  if (typeof archive !== 'string' || !path.isAbsolute(archive)) return refuse(`archive ${show(archive)} is not an absolute path`);
  if (typeof sha256 !== 'string' || !SHA256_RE.test(sha256)) return refuse(`archive SHA-256 ${show(sha256)} is not 64 lower hex`);
  const run = await runGh(attestationArgs(archive, entry.provenance), env, timeoutMs);
  if (run.error) return refuse(run.error);
  let list;
  try { list = JSON.parse(run.stdout); } catch { return refuse('gh attestation verify output is not one JSON value'); }
  if (!Array.isArray(list)) return refuse('gh attestation verify output is not a JSON array');
  if (list.length === 0) return refuse('gh attestation verify output holds no verified attestation');
  for (const [i, item] of list.entries()) {
    const p = attestationProblem(item, entry.provenance, sha256);
    if (p) return refuse(`attestation ${i + 1} of ${list.length}: ${p}`);
  }
  return { declared: true, problem: null, attestations: list.length };
}
