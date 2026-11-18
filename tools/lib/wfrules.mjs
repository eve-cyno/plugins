// tools/lib/wfrules.mjs: the static rules C-WF1 to C-WF11 over .github/workflows (plan task 1.8, sections 3.4, 4.2, 4.3, 6.4 and 8).
// Each rule takes the loaded workflows and returns its problems, one line each; an empty list is a pass. The workflows are read with
// the strict subset reader of yamlsub.mjs, so a file this code cannot read the way GitHub does fails every rule. The rules read the
// files only; they run nothing.
import fs from 'node:fs';
import path from 'node:path';
import { parseYaml } from './yamlsub.mjs';

/** The three workflows and their only triggers (C-WF1). */
export const TRIGGERS = Object.freeze({
  'check.yml': ['pull_request'],
  'publish.yml': ['workflow_dispatch'],
  'resign.yml': ['schedule', 'workflow_dispatch'],
});
const SIGNING = ['publish.yml', 'resign.yml'];
const FORBIDDEN_TRIGGERS = ['pull_request_target', 'workflow_run', 'issue_comment'];
export const KEYS_DIR = 'vendor/eve-cyno-host/host/src/keys';
const SHA_EXPR = '${{ github.sha }}';

/** The first step of every job of publish.yml and resign.yml (C-WF9): a re-run, even of failed jobs only, never signs or uploads. */
export const GUARD_STEP = Object.freeze({
  name: 'Refuse a re-run',
  run: '[ "${GITHUB_RUN_ATTEMPT:-}" = 1 ] || { echo "::error::this is attempt ${GITHUB_RUN_ATTEMPT:-?} of the run; a re-run never builds, signs or uploads: dispatch a new run"; exit 1; }\n',
});

/** The second step of publish.yml's build and resign.yml's head (C-WF9): the run's one commit is still the head of main. */
export const MAIN_HEAD_STEP = Object.freeze({
  name: 'Check that the run is on the head of main',
  run: [
    'set -euo pipefail',
    'fail() { echo "::error::$1"; exit 1; }',
    '[ "${GITHUB_REF:-}" = refs/heads/main ] || fail "this workflow runs only on main, not on ${GITHUB_REF:-no ref}"',
    '[[ "${GITHUB_SHA:-}" =~ ^[0-9a-f]{40}$ ]] || fail "the run names no commit"',
    'head=$(git ls-remote --exit-code "$GITHUB_SERVER_URL/$GITHUB_REPOSITORY.git" refs/heads/main | cut -f1) || fail "the head of main could not be read"',
    '[ "$head" = "$GITHUB_SHA" ] || fail "the run\'s commit $GITHUB_SHA is no longer the head of main ($head): dispatch a new run"',
    'echo "commit $GITHUB_SHA is the head of main"',
  ].join('\n') + '\n',
});

const SECRET_ENV = Object.freeze({ MINISIGN_INDEX_KEY: 'index', MINISIGN_INDEX_PASSWORD: 'index', R2_ACCESS_KEY_ID: 'mirror', R2_SECRET_ACCESS_KEY: 'mirror' });
const VAR_ENV = Object.freeze({ R2_ACCOUNT_ID: 'mirror', R2_BUCKET: 'mirror' });
const JOB_ENV = Object.freeze({ 'publish.yml': { sign: 'index', upload: 'mirror' }, 'resign.yml': { sign: 'index', upload: 'mirror' } });
const ACTIONS_READ = Object.freeze({ 'publish.yml': ['build', 'upload'] });
const ARTIFACT_DAYS = Object.freeze({ head: '90', signature: '90', catalog: '90', 'archives.json': '35', 'test-key': '35' });
const SIGN_NEEDS = Object.freeze({ 'publish.yml': 'build', 'resign.yml': 'head' });
const SIGN_KEYS = ['env', 'environment', 'if', 'needs', 'permissions', 'runs-on', 'steps', 'timeout-minutes'];
const NO_CODE_RE = /\b(npm|npx|node|aws|corepack|yarn|pnpm)\b/;
const PIN_RE = /^[A-Za-z0-9-]+\/[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_./-]+)?@[0-9a-f]{40}$/;
/** A `uses:` line as C-WF2 wants it written: the action, its 40-hex commit and the release tag as a trailing comment. */
const USES_LINE_RE = /^ *(?:- +)?uses: +([A-Za-z0-9-]+\/[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_./-]+)?)@([0-9a-f]{40}) +# (v[0-9]+\.[0-9]+\.[0-9]+)$/;
export const UPLOAD_IF = "!cancelled() && needs.build.result == 'success' && ((inputs.target == 'production' && needs.sign.result == 'success') || (inputs.target == 'test' && needs.sign-test.result == 'success'))";

const isMap = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const keys = (v) => (isMap(v) ? Object.keys(v) : []);
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const sorted = (a) => [...a].sort();
const listOf = (v) => (typeof v === 'string' ? [v] : Array.isArray(v) ? v : []);
const where = (f, id, k) => `${f} job ${id}${k ? ` step ${k}` : ''}`;
/** The expression inside `${{ }}` with its whitespace collapsed; a value without the wrapper is collapsed as it is. */
export const expr = (v) => (typeof v === 'string' ? v.trim().replace(/^\$\{\{([\s\S]*)\}\}$/, '$1').replace(/\s+/g, ' ').trim() : v);
const exprs = (text) => [...text.matchAll(/\$\{\{([\s\S]*?)\}\}/g)].map((m) => m[1]);
const isUpload = (s) => isMap(s) && typeof s.uses === 'string' && s.uses.startsWith('actions/upload-artifact@');
const isCheckout = (s) => isMap(s) && typeof s.uses === 'string' && s.uses.startsWith('actions/checkout@');
const stepsOf = (job) => (isMap(job) && Array.isArray(job.steps) ? job.steps : []);
const jobsOf = (w) => (w && isMap(w.doc.jobs) ? w.doc.jobs : Object.create(null));

function triggersOf(on) {
  if (typeof on === 'string') return [on];
  if (Array.isArray(on)) return on.map(String);
  return keys(on);
}

/** Reads every file of <root>/.github/workflows. A file outside the YAML subset is an error that every rule reports. */
export function loadWorkflows(root) {
  const ws = { root, files: [], wf: Object.create(null), errors: [] };
  const dir = path.join(root, '.github', 'workflows');
  let names;
  try { names = fs.readdirSync(dir).sort(); } catch (e) { ws.errors.push(`.github/workflows: ${e.code ?? e.message}`); return ws; }
  for (const f of names) {
    ws.files.push(f);
    try {
      const text = fs.readFileSync(path.join(dir, f), 'utf8');
      const { value, spans, lines } = parseYaml(text);
      ws.wf[f] = { text, doc: value, spans, lines };
    } catch (e) {
      ws.errors.push(`${f}: ${e.message}`);
    }
  }
  return ws;
}

/** The lines (first and last index) of job `id` of a workflow source, or null. */
export function jobLines(src, id) {
  const { value, spans } = parseYaml(src);
  const job = isMap(value.jobs) ? value.jobs[id] : undefined;
  return isMap(job) ? spans.get(job) : null;
}

function spanText(w, node) {
  const s = w.spans.get(node);
  return s ? w.lines.slice(s.start, s.end + 1).join('\n') : '';
}

function* jobsIn(ws, files = Object.keys(ws.wf)) {
  for (const f of files) {
    const w = ws.wf[f];
    if (!w) continue;
    for (const [id, job] of Object.entries(jobsOf(w))) yield { f, w, id, job };
  }
}

function* stepsIn(ws, files) {
  for (const j of jobsIn(ws, files)) for (const [k, step] of stepsOf(j.job).entries()) yield { ...j, k: k + 1, step };
}

function usesOf(ws) {
  const out = [];
  for (const { f, id, job } of jobsIn(ws)) {
    if (isMap(job) && 'uses' in job) out.push({ at: where(f, id), uses: job.uses });
    stepsOf(job).forEach((s, k) => { if (isMap(s) && 'uses' in s) out.push({ at: where(f, id, k + 1), uses: s.uses }); });
  }
  return out;
}

/** C-WF1: exactly the three workflow files, each with exactly its triggers; never pull_request_target, workflow_run, issue_comment. */
function cwf1(ws) {
  const p = [...ws.errors];
  for (const f of ws.files) {
    if (!(f in TRIGGERS)) p.push(`${f}: not one of the workflows ${Object.keys(TRIGGERS).join(', ')} (a new workflow changes this rule first)`);
  }
  for (const [f, want] of Object.entries(TRIGGERS)) {
    const w = ws.wf[f];
    if (!w) { if (!ws.files.includes(f)) p.push(`${f}: missing`); continue; }
    const got = triggersOf(w.doc.on);
    for (const t of got) if (FORBIDDEN_TRIGGERS.includes(t)) p.push(`${f}: trigger ${t} is forbidden`);
    if (!same(sorted(got), sorted(want))) p.push(`${f}: triggers ${got.join(', ') || 'none'}, expected exactly ${want.join(', ')}`);
  }
  for (const [f, w] of Object.entries(ws.wf)) {
    const code = w.text.replace(/(^|\s)#.*$/gm, '$1');
    for (const t of FORBIDDEN_TRIGGERS) if (new RegExp(`(^|[^A-Za-z0-9_-])${t}($|[^A-Za-z0-9_-])`, 'm').test(code)) p.push(`${f}: names ${t}`);
  }
  return [...new Set(p)];
}

/**
 * C-WF2: every `uses:` names a commit by its full 40-hex SHA, written `owner/repo@<sha> # vX.Y.Z` (the release tag the SHA was read
 * from, docs/RUNBOOK.md "Pinned actions"), and every use of one action names the same commit and tag. Nothing else is a pin: a tag,
 * a branch, a short SHA, a local action, a docker image or a placeholder fails.
 */
function cwf2(ws) {
  const p = [...ws.errors];
  const all = usesOf(ws);
  for (const u of all) {
    if (typeof u.uses !== 'string' || !PIN_RE.test(u.uses)) p.push(`${u.at}: uses ${JSON.stringify(u.uses)} is not pinned to a 40-hex commit SHA`);
  }
  let lines = 0;
  const pins = new Map();
  for (const [f, w] of Object.entries(ws.wf)) {
    w.lines.forEach((l, i) => {
      if (!/^ *(?:- +)?uses:/.test(l)) return;
      lines++;
      const m = USES_LINE_RE.exec(l);
      if (!m) { p.push(`${f} line ${i + 1}: a uses: line must be written owner/repo@<40-hex commit> # vX.Y.Z`); return; }
      const pin = `${m[2]} # ${m[3]}`;
      if (!pins.has(m[1])) pins.set(m[1], new Map());
      if (!pins.get(m[1]).has(pin)) pins.get(m[1]).set(pin, `${f} line ${i + 1}`);
    });
  }
  for (const [action, seen] of pins) {
    if (seen.size > 1) p.push(`${action} is pinned ${seen.size} ways (one action, one commit and tag): ${[...seen].map(([pin, at]) => `${pin} at ${at}`).join('; ')}`);
  }
  if (lines !== all.length) p.push(`the files hold ${lines} uses: lines, the workflow structure ${all.length}`);
  return p;
}

/** C-WF3: no expression inside any `run:` (values reach scripts through env and arguments), no shell or defaults override. */
function cwf3(ws) {
  const p = [...ws.errors];
  for (const [f, w] of Object.entries(ws.wf)) if ('defaults' in w.doc) p.push(`${f}: defaults (a run override)`);
  for (const { f, id, job } of jobsIn(ws)) if (isMap(job) && 'defaults' in job) p.push(`${where(f, id)}: defaults (a run override)`);
  for (const { f, id, k, step } of stepsIn(ws)) {
    if (!isMap(step)) continue;
    if ('shell' in step) p.push(`${where(f, id, k)}: shell (the runner's default bash only)`);
    if (!('run' in step)) continue;
    if (typeof step.run !== 'string') p.push(`${where(f, id, k)}: run is not text`);
    else if (step.run.includes('${{')) p.push(`${where(f, id, k)}: run holds an expression; pass the value through env`);
  }
  return p;
}

/** C-WF4: no workflow sets the head lifetime (D36: the tools write 60 days). */
function cwf4(ws) {
  const p = [...ws.errors];
  for (const [f, w] of Object.entries(ws.wf)) if (/lifetime-days/.test(w.text)) p.push(`${f}: names --lifetime-days`);
  return p;
}

/**
 * C-WF5: MINISIGN_ secrets only in jobs with environment index, R2_ secrets and variables only with environment mirror, no other
 * secret or variable, no toJSON(secrets), no secrets: inherit, nothing outside the jobs; index only on sign, mirror only on upload;
 * permissions contents: read everywhere, actions: read only on publish.yml's build and upload, nothing writes.
 */
function cwf5(ws) {
  const p = [...ws.errors];
  for (const [f, w] of Object.entries(ws.wf)) {
    if (/toJSON\s*\(\s*secrets\s*\)/i.test(w.text)) p.push(`${f}: toJSON(secrets)`);
    if (/^\s*secrets\s*:\s*inherit\b/m.test(w.text)) p.push(`${f}: secrets: inherit`);
    if (/\bsecrets\s*\[/.test(w.text)) p.push(`${f}: secrets[...] (only secrets.<NAME> is read)`);
    const perms = w.doc.permissions;
    if (!isMap(perms) || !same(keys(perms), ['contents']) || perms.contents !== 'read') p.push(`${f}: workflow permissions must be exactly contents: read`);
    const jobs = jobsOf(w);
    const inJobs = Object.values(jobs).map((j) => (isMap(j) ? w.spans.get(j) : null)).filter(Boolean);
    const outside = w.lines.filter((_, k) => !inJobs.some((s) => k >= s.start && k <= s.end)).join('\n');
    for (const e of exprs(outside)) if (/\b(secrets|vars)\b/.test(e)) p.push(`${f}: a secret or variable outside the jobs: \${{${e}}}`);
    for (const [id, job] of Object.entries(jobs)) {
      if (!isMap(job)) { p.push(`${where(f, id)}: not a mapping`); continue; }
      const env = job.environment;
      const want = JOB_ENV[f]?.[id];
      if (env !== undefined && typeof env !== 'string') p.push(`${where(f, id)}: environment must be a plain name`);
      else if (env !== want) p.push(`${where(f, id)}: environment ${env ?? 'none'}, expected ${want ?? 'none'}`);
      if ('secrets' in job) p.push(`${where(f, id)}: passes secrets to a reusable workflow`);
      for (const e of exprs(spanText(w, job))) {
        for (const [table, kind] of [[SECRET_ENV, 'secret'], [VAR_ENV, 'variable']]) {
          const ctx = kind === 'secret' ? 'secrets' : 'vars';
          for (const m of e.matchAll(new RegExp(`\\b${ctx}\\.([A-Za-z_][A-Za-z0-9_]*)`, 'g'))) {
            const n = m[1];
            if (!(n in table)) p.push(`${where(f, id)}: ${kind} ${n} is not one this repository names`);
            else if (table[n] !== env) p.push(`${where(f, id)}: ${kind} ${n} belongs only in a job with environment ${table[n]}`);
          }
          if (new RegExp(`\\b${ctx}\\b(?!\\.)`).test(e)) p.push(`${where(f, id)}: the whole ${ctx} context in \${{${e}}}`);
        }
      }
      const jp = job.permissions;
      const actionsOk = (ACTIONS_READ[f] ?? []).includes(id);
      const good = isMap(jp) && jp.contents === 'read' && keys(jp).every((k) => k === 'contents' || (k === 'actions' && actionsOk && jp.actions === 'read'));
      if (!good) p.push(`${where(f, id)}: permissions must be contents: read${actionsOk ? ' (actions: read allowed)' : ''} only, got ${JSON.stringify(jp ?? null)}`);
    }
    for (const [id, e] of Object.entries(JOB_ENV[f] ?? {})) if (!isMap(jobs[id])) p.push(`${where(f, id)}: missing (the only job with environment ${e})`);
  }
  return [...new Set(p)];
}

/** C-WF6: publish.yml and resign.yml share the workflow-level group index-sign, never cancelled, queued; nothing else uses it. */
function cwf6(ws) {
  const p = [...ws.errors];
  for (const f of SIGNING) {
    const w = ws.wf[f];
    if (!w) { p.push(`${f}: missing`); continue; }
    const c = w.doc.concurrency;
    const ok = isMap(c) && same(sorted(keys(c)), ['cancel-in-progress', 'group', 'queue']) && c.group === 'index-sign'
      && c['cancel-in-progress'] === 'false' && c.queue === 'max';
    if (!ok) p.push(`${f}: concurrency must be exactly { group: index-sign, cancel-in-progress: false, queue: max }, got ${JSON.stringify(c ?? null)}`);
  }
  for (const { f, id, job } of jobsIn(ws)) if (isMap(job) && 'concurrency' in job) p.push(`${where(f, id)}: concurrency at job level`);
  for (const [f, w] of Object.entries(ws.wf)) if (!SIGNING.includes(f) && /index-sign/.test(w.text)) p.push(`${f}: names the group index-sign`);
  return p;
}

/**
 * C-WF7: the sign jobs of publish.yml and resign.yml have byte-identical steps and the same job-level env keys (HEAD_SHA256,
 * HEAD_COMMENT); they differ only in the needs job and the outputs source of that env (and publish.yml's target if, C-WF8). They
 * check out only the public keys folder and run no npm, Node or AWS CLI. Head, signature and catalog artifacts are kept 90 days.
 */
function cwf7(ws) {
  const p = [...ws.errors];
  const sign = {};
  for (const f of SIGNING) {
    const job = jobsOf(ws.wf[f]).sign;
    if (!isMap(job)) { p.push(`${f}: no sign job`); continue; }
    sign[f] = job;
    const n = SIGN_NEEDS[f];
    for (const k of keys(job)) if (!SIGN_KEYS.includes(k)) p.push(`${where(f, 'sign')}: key ${k} (allowed: ${SIGN_KEYS.join(', ')})`);
    if (!same(listOf(job.needs), [n])) p.push(`${where(f, 'sign')}: needs must be ${n}`);
    const wantEnv = { HEAD_SHA256: `\${{ needs.${n}.outputs.head_sha256 }}`, HEAD_COMMENT: `\${{ needs.${n}.outputs.head_comment }}` };
    const env = job.env;
    if (!isMap(env) || !same(sorted(keys(env)), sorted(keys(wantEnv))) || Object.entries(wantEnv).some(([k, v]) => env[k] !== v)) {
      p.push(`${where(f, 'sign')}: env must be exactly ${JSON.stringify(wantEnv)}`);
    }
    if (f === 'resign.yml' && 'if' in job) p.push(`${where(f, 'sign')}: if (it runs whenever head succeeded)`);
    const steps = stepsOf(job);
    if (steps.length === 0) p.push(`${where(f, 'sign')}: no steps`);
    const wantWith = { ref: SHA_EXPR, 'persist-credentials': 'false', 'sparse-checkout': KEYS_DIR, 'sparse-checkout-cone-mode': 'false' };
    const co = steps.filter(isCheckout);
    if (co.length !== 1 || !isMap(co[0].with) || !same(sorted(Object.entries(co[0].with)), sorted(Object.entries(wantWith)))) {
      p.push(`${where(f, 'sign')}: exactly one checkout, of ${KEYS_DIR} only, with ${JSON.stringify(wantWith)}`);
    }
    steps.forEach((s, k) => {
      if (!isMap(s)) return;
      if (typeof s.uses === 'string' && !/^actions\/(checkout|download-artifact|upload-artifact)@/.test(s.uses)) {
        p.push(`${where(f, 'sign', k + 1)}: uses ${s.uses} (only checkout, download-artifact and upload-artifact)`);
      }
      const m = typeof s.run === 'string' ? NO_CODE_RE.exec(s.run) : null;
      if (m) p.push(`${where(f, 'sign', k + 1)}: runs ${m[1]}`);
    });
    const ups = steps.filter(isUpload);
    if (ups.length !== 1 || !isMap(ups[0].with) || ups[0].with.name !== 'signature') p.push(`${where(f, 'sign')}: uploads exactly one artifact, signature`);
  }
  const [a, b] = [sign['publish.yml'], sign['resign.yml']];
  if (a && b) {
    const ta = spanText(ws.wf['publish.yml'], a.steps).split('\n');
    const tb = spanText(ws.wf['resign.yml'], b.steps).split('\n');
    if (ta.join('\n') === '' || ta.join('\n') !== tb.join('\n')) {
      let k = 0;
      while (k < ta.length && ta[k] === tb[k]) k++;
      p.push(`the sign jobs' steps differ (they must be byte-identical): first at line ${k + 1} of the steps, ${JSON.stringify(ta[k] ?? '')} and ${JSON.stringify(tb[k] ?? '')}`);
    }
    for (const k of new Set([...keys(a), ...keys(b)])) {
      if (!['needs', 'env', 'if', 'steps'].includes(k) && !same(a[k], b[k])) p.push(`the sign jobs differ in ${k}`);
    }
  }
  for (const { f, id, k, step } of stepsIn(ws, SIGNING)) {
    if (!isUpload(step)) continue;
    const name = isMap(step.with) ? step.with.name : undefined;
    const days = ARTIFACT_DAYS[name];
    if (days === undefined) p.push(`${where(f, id, k)}: artifact ${name} is not one of ${Object.keys(ARTIFACT_DAYS).join(', ')}`);
    else if (step.with['retention-days'] !== days) p.push(`${where(f, id, k)}: artifact ${name} must carry retention-days ${days}`);
  }
  return [...new Set(p)];
}

/** C-WF8 (publish.yml): no job that runs for target test names index; upload has the plan's needs and if. */
function cwf8(ws) {
  const f = 'publish.yml';
  const w = ws.wf[f];
  if (!w) return [...ws.errors, `${f}: missing`];
  const p = [...ws.errors];
  const jobs = jobsOf(w);
  const want = ['build', 'sign', 'sign-test', 'upload', 'verify'];
  if (!same(sorted(keys(jobs)), want)) p.push(`${f}: jobs ${keys(jobs).join(', ')}, expected exactly ${want.join(', ')}`);
  const wd = isMap(w.doc.on) ? w.doc.on.workflow_dispatch : undefined;
  const target = isMap(wd) && isMap(wd.inputs) ? wd.inputs.target : undefined;
  if (!isMap(target) || target.type !== 'choice' || !same(sorted(listOf(target.options)), ['production', 'test'])) {
    p.push(`${f}: input target must be a choice of exactly production and test`);
  }
  for (const [id, job] of Object.entries(jobs)) if (isMap(job) && job.environment === 'index' && id !== 'sign') p.push(`${where(f, id)}: names environment index (only sign may)`);
  if (!isMap(jobs.sign) || expr(jobs.sign.if) !== "inputs.target == 'production'") p.push(`${where(f, 'sign')}: if must be inputs.target == 'production'`);
  const st = jobs['sign-test'];
  if (!isMap(st) || 'environment' in st || expr(st.if) !== "inputs.target == 'test'") p.push(`${where(f, 'sign-test')}: must have no environment and if inputs.target == 'test'`);
  const up = jobs.upload;
  if (!isMap(up) || !same(listOf(up.needs), ['build', 'sign', 'sign-test'])) p.push(`${where(f, 'upload')}: needs must be exactly [build, sign, sign-test]`);
  if (!isMap(up) || expr(up.if) !== UPLOAD_IF) p.push(`${where(f, 'upload')}: if must be \${{ ${UPLOAD_IF} }}`);
  return p;
}

/** C-WF9 (publish.yml, resign.yml): no sha input, every checkout at github.sha, every job starts with the run-attempt guard. */
function cwf9(ws) {
  const p = [...ws.errors];
  const INPUTS = { 'publish.yml': ['lift', 'repair', 'target'], 'resign.yml': [] };
  for (const f of SIGNING) {
    const w = ws.wf[f];
    if (!w) { p.push(`${f}: missing`); continue; }
    const wd = isMap(w.doc.on) ? w.doc.on.workflow_dispatch : undefined;
    const inputs = isMap(wd) && isMap(wd.inputs) ? keys(wd.inputs) : [];
    if (inputs.includes('sha')) p.push(`${f}: input sha (the run's only commit is github.sha)`);
    if (!same(sorted(inputs), INPUTS[f])) p.push(`${f}: inputs ${inputs.join(', ') || 'none'}, expected ${INPUTS[f].join(', ') || 'none'}`);
    if (/continue-on-error/.test(w.text)) p.push(`${f}: continue-on-error`);
    const jobs = jobsOf(w);
    for (const [id, job] of Object.entries(jobs)) {
      const steps = stepsOf(job);
      if (!same(steps[0], { ...GUARD_STEP })) p.push(`${where(f, id)}: the first step must be the run-attempt guard (${GUARD_STEP.name})`);
      steps.forEach((s, k) => {
        if (isCheckout(s) && (!isMap(s.with) || s.with.ref !== SHA_EXPR)) p.push(`${where(f, id, k + 1)}: checkout must have ref: ${SHA_EXPR}`);
      });
    }
    const builder = f === 'publish.yml' ? 'build' : 'head';
    if (!same(stepsOf(jobs[builder])[1], { ...MAIN_HEAD_STEP })) p.push(`${where(f, builder)}: the second step must be the head-of-main check (${MAIN_HEAD_STEP.name})`);
  }
  return p;
}

/** C-WF10 (resign.yml): upload needs exactly [head, sign] with GitHub's default if; head runs only when check says needed. */
function cwf10(ws) {
  const f = 'resign.yml';
  const w = ws.wf[f];
  if (!w) return [...ws.errors, `${f}: missing`];
  const p = [...ws.errors];
  const jobs = jobsOf(w);
  const want = ['check', 'head', 'sign', 'upload', 'verify'];
  if (!same(sorted(keys(jobs)), want)) p.push(`${f}: jobs ${keys(jobs).join(', ')}, expected exactly ${want.join(', ')}`);
  const up = jobs.upload;
  if (!isMap(up) || !same(listOf(up.needs), ['head', 'sign'])) p.push(`${where(f, 'upload')}: needs must be exactly [head, sign]`);
  if (isMap(up) && 'if' in up) p.push(`${where(f, 'upload')}: if (GitHub's default runs it only when head and sign succeeded)`);
  const head = jobs.head;
  if (!isMap(head) || !same(listOf(head.needs), ['check'])) p.push(`${where(f, 'head')}: needs must be check`);
  if (!isMap(head) || expr(head.if) !== "needs.check.outputs.needed == 'true'") p.push(`${where(f, 'head')}: if must be needs.check.outputs.needed == 'true'`);
  const on = w.doc.on;
  const sched = isMap(on) ? on.schedule : undefined;
  if (!Array.isArray(sched) || sched.length !== 1 || !isMap(sched[0]) || !same(keys(sched[0]), ['cron']) || sched[0].cron !== '17 6 * * 1') {
    p.push(`${f}: schedule must be exactly cron '17 6 * * 1'`);
  }
  const wd = isMap(on) ? on.workflow_dispatch : undefined;
  if (!(wd === null || (isMap(wd) && keys(wd).length === 0))) p.push(`${f}: workflow_dispatch takes no inputs`);
  return p;
}

/**
 * The files whose names match `re`, with their paths relative to the root: under the folder `rel` and its subfolders (tools/test
 * and node_modules aside), or with `rel` '' the files at the root only.
 */
function filesUnder(root, rel, re) {
  const out = [];
  const walk = (r) => {
    let ents;
    try { ents = fs.readdirSync(path.join(root, r), { withFileTypes: true }); } catch { return; }
    for (const e of ents.sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const q = r ? `${r}/${e.name}` : e.name;
      if (e.isDirectory()) { if (r && q !== 'tools/test' && e.name !== 'node_modules') walk(q); continue; }
      if (e.isFile() && re.test(e.name)) out.push({ rel: q, text: fs.readFileSync(path.join(root, q), 'utf8') });
    }
  };
  walk(rel);
  return out;
}

const RULE_FILE = 'tools/lib/wfrules.mjs';
const READER = 'tools/lib/reviewer.mjs';
/** A name that stores a reviewer: a reviewer file, or a reviewer id or login key. */
const REVIEWER_KEY_RE = /reviewer[^/\s]*\.json|reviewer[_-]?(?:id|login)\b/i;
const ARG_OR_ENV_RES = [/--reviewer/i, /REVIEWER/, /(?:process\.env|\benv)\s*(?:\?\.|\.|\[\s*['"`])\s*[A-Za-z0-9_]*reviewer/i];
/** A login in code: a `.login`, or an Actions actor. */
const WHO_RE = String.raw`(?:[\w$.?]*\.login\b|\b(?:github\.)?(?:actor|triggering_actor)\b)`;
/** A quoted literal that is not one of typeof's answers. */
const QUOTED_RE = String.raw`["'](?!(?:string|number|object|undefined|boolean|function|bigint|symbol)["'])[^"'\n]+["']`;
/**
 * A user id or login written as a literal: a name for a user's, actor's, owner's, approver's or reviewer's id or login given or
 * compared with a literal, a `.id` or a `.login` (or an Actions actor) compared with one, either way round.
 */
const LITERAL_USER_RES = [
  /\b(?:user|actor|owner|approver|reviewer|login)[_-]?id["']?\s*(?:[:=]|[!=]==?)\s*["']?[0-9]+/i,
  /\.id\s*[!=]==?\s*["']?[0-9]+|["']?[0-9]+["']?\s*[!=]==?\s*[A-Za-z_$][\w$.?]*\.id\b/,
  new RegExp(String.raw`${WHO_RE}\s*[!=]==?\s*${QUOTED_RE}|${QUOTED_RE}\s*[!=]==?\s*${WHO_RE}`),
];
/** A YAML line without its comment (a `#` at the start or after whitespace). */
const uncommented = (line) => line.replace(/(^|\s)#.*$/, '');

/**
 * C-WF11 (plan 4.1, 4.2): no reviewer is written in the repository; the tools read it at run time from the environments'
 * protection rules (tools/lib/reviewer.mjs). No workflow names a reviewer outside a comment (no input, variable or secret); no
 * workflow or tool writes a user id or login as a literal; no tool takes a reviewer argument or environment variable; there is no
 * reviewer file, and no tool, workflow or document names one or a reviewer id or login key; tools/lib/reviewer.mjs exists, imports
 * only ./github.mjs and reads neither process nor a module loaded at run time. A static rule cannot know the real login and id:
 * tools/check-envs.mjs looks for them in every path, file and commit at the run's commit (C-ENV1).
 */
function cwf11(ws) {
  const p = [...ws.errors];
  for (const f of ws.files) {
    const w = ws.wf[f];
    if (!w) continue;
    w.text.split('\n').forEach((l, i) => {
      const code = uncommented(l);
      if (/reviewer/i.test(code)) p.push(`${f}: names a reviewer outside a comment (line ${i + 1})`);
      if (LITERAL_USER_RES.some((re) => re.test(code))) p.push(`${f}: a user id or login written as a literal (line ${i + 1})`);
    });
    if (REVIEWER_KEY_RE.test(w.text)) p.push(`${f}: names a reviewer file or a reviewer id or login key`);
  }
  const tools = filesUnder(ws.root, 'tools', /\.(?:mjs|cjs|js|json|sh)$/);
  for (const { rel, text } of tools) {
    if (/(^|\/)reviewer[^/]*\.json$/i.test(rel)) { p.push(`${rel}: a reviewer file (the reviewer is read from the environments, never committed)`); continue; }
    if (rel === RULE_FILE) continue;
    if (REVIEWER_KEY_RE.test(text)) p.push(`${rel}: names a reviewer file or a reviewer id or login key`);
    if (ARG_OR_ENV_RES.some((re) => re.test(text))) p.push(`${rel}: a reviewer argument or environment variable`);
    if (LITERAL_USER_RES.some((re) => re.test(text))) p.push(`${rel}: a user id or login written as a literal`);
  }
  const docs = [...filesUnder(ws.root, '', /\.(?:md|json)$/), ...filesUnder(ws.root, 'docs', /\.md$/)];
  for (const { rel, text } of docs) if (REVIEWER_KEY_RE.test(text)) p.push(`${rel}: names a reviewer file or a reviewer id or login key`);
  const reader = tools.find((t) => t.rel === READER);
  if (!reader) return [...p, `${READER}: missing`];
  for (const m of reader.text.matchAll(/^\s*import\b[^'"]*['"]([^'"]+)['"]/gm)) if (m[1] !== './github.mjs') p.push(`${READER}: imports ${m[1]} (it reads the reviewer from API data only)`);
  if (/\bprocess\b/.test(reader.text)) p.push(`${READER}: reads process (no environment, argument or working folder)`);
  if (/\bimport\s*\(|\brequire\s*\(/.test(reader.text)) p.push(`${READER}: loads a module at run time`);
  return p;
}

export const RULES = Object.freeze({
  'C-WF1': cwf1,
  'C-WF2': cwf2,
  'C-WF3': cwf3,
  'C-WF4': cwf4,
  'C-WF5': cwf5,
  'C-WF6': cwf6,
  'C-WF7': cwf7,
  'C-WF8': cwf8,
  'C-WF9': cwf9,
  'C-WF10': cwf10,
  'C-WF11': cwf11,
});
