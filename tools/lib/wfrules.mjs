// tools/lib/wfrules.mjs: the static rules C-WF1 to C-WF12 over .github/workflows (plan task 1.8, sections 3.4, 4.2, 4.3, 6.4 and 8).
// Each rule takes the loaded workflows and returns its problems, one line each; an empty list is a pass. The workflows are read with
// the strict subset reader of yamlsub.mjs, so a file this code cannot read the way GitHub does fails every rule. The rules read the
// files only; they run nothing.
import crypto from 'node:crypto';
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
/**
 * C-WF5: the contexts that hold values only some jobs may read, with their names and what a read of one is called. Each pattern
 * finds every read of the context: GitHub reads a context name in any case (Secrets, VARS) and skips whitespace between tokens, so
 * the name in any case is a read, and only `<context>.<NAME>` with nothing between the three reads one value by its name.
 */
const VALUE_CONTEXTS = Object.freeze([['secrets', SECRET_ENV, 'secret'], ['vars', VAR_ENV, 'variable']]
  .map(([ctx, table, kind]) => Object.freeze({ ctx, table, kind, re: new RegExp(`\\b${ctx}\\b(?:\\.([A-Za-z_][A-Za-z0-9_]*))?`, 'gi') })));
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
/** publish.yml verify's if (C-WF12): upload ran and succeeded, whichever of sign and sign-test was skipped. */
export const VERIFY_IF = "!cancelled() && needs.upload.result == 'success'";
/** The only runner a job may name (C-WF5): GitHub's hosted Ubuntu 24.04, never a self-hosted machine or a label list. */
const RUNNER = 'ubuntu-24.04';
/**
 * C-WF7: the steps of both sign jobs, in order: each step's name and the SHA-256 of the whole step as canonical JSON (mapping keys
 * sorted at every level, see canon), so an added, removed or moved step fails, and so does a changed run, env, with, if or uses.
 * A change to a sign job changes this list in the same commit, and the rules a reviewer runs from a trusted checkout still hold the
 * old list: a pull request cannot change a sign job and its pin together.
 */
const SIGN_STEPS = Object.freeze([
  ['Refuse a re-run', '8ea6e265a2443446ea87f4fddd360381ee7796e64f405200a9720653eea0112c'],
  ['Check out the pinned public keys only', 'cb29b1bbdc7a735b26a9d8e7f6f5838b06fa16e4122d0f253836b766940e668e'],
  ['Check that nothing but the public keys is checked out', '639ad37b784da6761d76deee1a28fde5312203e188284c48204433867af60e4c'],
  ['Download the head', 'fe25c749d019cae6983c395f5a5a2f09511eb2ec2b625c4929c8b5a39922221a'],
  ['Check the head', '8a0d87ce6388f3144fc26c3fe3b6a1cc40b412dc8b9e79b7d89af507691b2174'],
  ["Install minisign (Ubuntu's package)", 'e74c83aee20fa376add918ba57699f7e1852f9a74c1311c9f5cc92bc803e3cd8'],
  ["Check that minisign is Ubuntu's", 'e5989d9baec687b69fe7aa9a51125caa3528af68cad3ff8ff16943200f706559'],
  ['Sign with the index key', '120d06026e3722118571fe2949bbba6171d78577f3ea2fa52a593fbe0b9d1107'],
  ['Shred the secret key file', '7276c82848efebf6e90d2632b8a3676ea1a0d5a3b7334d18cf975d1e5fe7e429'],
  ['Verify against the pinned public key', '5d07dbb8daf6499905bc75259a00860baa377ea431026fb0b6aed7582cdeb942'],
  ['Keep the signature (90 days)', 'acb7e8e3707bde5c119117b71dc661f5b452c85c5516274e555f68804d227861'],
].map(Object.freeze));
const PIN_HOW = 'a changed sign job needs its new pin in SIGN_STEPS, tools/lib/wfrules.mjs, read with the change';
/**
 * C-WF12: the jobs whose skip ends a run on purpose, so every job after them may keep GitHub's default if and be skipped with them:
 * resign.yml head (check found no re-sign needed; sign, upload and verify have nothing to do). C-WF10 pins head's if.
 */
const RUN_GATES = Object.freeze({ 'resign.yml': ['head'] });
/**
 * C-WF12: the only job whose if, written exactly as PINNED_IFS pins it, is taken whole instead of term by term: publish.yml upload,
 * whose pin needs sign or sign-test by target inside an ||, never both as top-level terms. Every other pinned if after a job that
 * can be skipped is read term by term like any if.
 */
const WHOLE_IFS = Object.freeze({ 'publish.yml': Object.freeze(['upload']) });
/**
 * The job ifs the rules pin (C-WF8, C-WF10, C-WF12). Each is compared with the value as written, which must be exactly
 * `${{ <pin> }}`: GitHub never trims an if, and any text outside its `${{ }}` makes it a string that is always true (see expr).
 */
const PINNED_IFS = Object.freeze({
  'publish.yml': Object.freeze({ sign: "inputs.target == 'production'", 'sign-test': "inputs.target == 'test'", upload: UPLOAD_IF, verify: VERIFY_IF }),
  'resign.yml': Object.freeze({ head: "needs.check.outputs.needed == 'true'" }),
});
const isPinned = (f, id) => Object.hasOwn(PINNED_IFS, f) && Object.hasOwn(PINNED_IFS[f], id);
const pinText = (f, id) => `\${{ ${PINNED_IFS[f][id]} }}`;
/** Job `id` of workflow `f` has an if pinned in PINNED_IFS, written exactly as pinned. */
const hasPinnedIf = (f, id, job) => isPinned(f, id) && isMap(job) && job.if === pinText(f, id);
/** The UTF-8 reader of the workflow files: a byte that is not UTF-8 is refused, never replaced; a byte order mark is kept. */
const UTF8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

const isMap = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const keys = (v) => (isMap(v) ? Object.keys(v) : []);
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const sorted = (a) => [...a].sort();
const listOf = (v) => (typeof v === 'string' ? [v] : Array.isArray(v) ? v : []);
const where = (f, id, k) => `${f} job ${id}${k ? ` step ${k}` : ''}`;
/**
 * The expression GitHub evaluates for an if, with its whitespace collapsed, or null when GitHub reads the value as no one expression.
 * A value without `${{` is an expression as it is. A value with one is an expression only when it is exactly one `${{ ... }}` with
 * nothing before or after it, its end the first `}}` outside single quotes (TemplateReader.ParseScalar in GitHub's runner). Text
 * outside it, even one space or the line break a `|` block ends with, makes GitHub evaluate format('...{0}...', ...), a non-empty
 * string, so the if is always true. The value is never trimmed, since GitHub does not trim it. A value that is not text is returned
 * as it is.
 */
export function expr(v) {
  if (typeof v !== 'string') return v;
  const collapse = (s) => s.replace(/\s+/g, ' ').trim();
  if (!v.includes('${{')) return collapse(v);
  if (!v.startsWith('${{')) return null;
  let quoted = false;
  for (let k = 3; k < v.length; k++) {
    if (v[k] === "'") quoted = !quoted;
    else if (!quoted && v[k] === '}' && v[k - 1] === '}') {
      const e = collapse(v.slice(3, k - 1));
      return k === v.length - 1 && e !== '' ? e : null;
    }
  }
  return null;
}
/**
 * The expressions of a text: each runs from a `${{` to the first `}}` outside single quotes, where GitHub ends it (see expr), so a
 * `}}` in a string literal never hides the rest of the expression. An expression whose quote is never closed runs to the end. The
 * text is a parsed key or value (see texts), never a raw line: a quote in a YAML comment, or the '' a YAML single-quoted value
 * writes for one quote, would move the end of an expression and hide the rest of it.
 */
function exprs(text) {
  const out = [];
  for (let from = text.indexOf('${{'); from !== -1;) {
    let quoted = false;
    let k = from + 3;
    for (; k < text.length; k++) {
      if (text[k] === "'") quoted = !quoted;
      else if (!quoted && text[k] === '}' && text[k + 1] === '}') break;
    }
    out.push(text.slice(from + 3, k));
    from = text.indexOf('${{', k + 2);
  }
  return out;
}
/**
 * Every text of a parsed node, as GitHub reads it: the mapping keys and the scalar values at every level, comments gone and quotes
 * read, but nothing inside a node of `skip`.
 */
function* texts(v, skip = new Set()) {
  if (skip.has(v)) return;
  if (typeof v === 'string') yield v;
  else if (Array.isArray(v)) for (const x of v) yield* texts(x, skip);
  else if (isMap(v)) for (const [k, x] of Object.entries(v)) { yield k; yield* texts(x, skip); }
}
/** The most of an expression a problem line shows: one line per problem stays short, whatever the length of the expression. */
const SHOWN = 200;
const shown = (e) => (e.length > SHOWN ? `${e.slice(0, SHOWN)}...` : e);
/** `v` as canonical JSON: the mapping keys sorted at every level. */
const canon = (v) => (isMap(v) ? `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canon(v[k])}`).join(',')}}`
  : Array.isArray(v) ? `[${v.map(canon).join(',')}]` : JSON.stringify(v ?? null));
const sha256 = (s) => crypto.createHash('sha256').update(s, 'utf8').digest('hex');
const orList = (a) => (a.length < 2 ? a.join('') : `${a.slice(0, -1).join(', ')} or ${a[a.length - 1]}`);
const isUpload = (s) => isMap(s) && typeof s.uses === 'string' && s.uses.startsWith('actions/upload-artifact@');
const isCheckout = (s) => isMap(s) && typeof s.uses === 'string' && s.uses.startsWith('actions/checkout@');
const stepsOf = (job) => (isMap(job) && Array.isArray(job.steps) ? job.steps : []);
const jobsOf = (w) => (w && isMap(w.doc.jobs) ? w.doc.jobs : Object.create(null));
/** The ifs of a job and of its steps written without `${{`: GitHub reads each such value whole as one expression. */
const bareIfs = (job) => [job, ...stepsOf(job)].map((n) => (isMap(n) ? n.if : undefined)).filter((v) => typeof v === 'string' && !v.includes('${{'));

function triggersOf(on) {
  if (typeof on === 'string') return [on];
  if (Array.isArray(on)) return on.map(String);
  return keys(on);
}

/** The text of a workflow file, or an error when it is not valid UTF-8 (another reader may decode such a byte another way). */
function readUtf8(file) {
  const bytes = fs.readFileSync(file);
  try {
    return UTF8.decode(bytes);
  } catch {
    throw new Error('not valid UTF-8 (a byte this reader would replace and another reader may decode as a character, a line break among them)');
  }
}

/**
 * Reads every file of <root>/.github/workflows. A file that is not valid UTF-8 or is outside the YAML subset is an error that every
 * rule reports.
 */
export function loadWorkflows(root) {
  const ws = { root, files: [], wf: Object.create(null), errors: [] };
  const dir = path.join(root, '.github', 'workflows');
  let names;
  try { names = fs.readdirSync(dir).sort(); } catch (e) { ws.errors.push(`.github/workflows: ${e.code ?? e.message}`); return ws; }
  for (const f of names) {
    ws.files.push(f);
    try {
      const text = readUtf8(path.join(dir, f));
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
    // A comment starts at a # at the start of a line or after a space (tabs are refused): a # after U+00A0 is text to YAML.
    const code = w.text.replace(/(^| )#.*$/gm, '$1');
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
 * secret or variable, no read of a whole context (toJSON(secrets), vars.*, an index), no secrets: inherit, nothing outside the jobs,
 * each read found in any case, in every ${{ }} of every parsed key and value (texts, never the raw lines) and in every if written
 * without one (VALUE_CONTEXTS), a read of a whole context named once per expression, cut to SHOWN characters; index only on sign,
 * mirror only on upload; permissions contents: read everywhere, actions: read only on publish.yml's build and upload, nothing writes.
 * Every job runs on runs-on: ubuntu-24.04 itself: no container, no services, no self-hosted runner or label list; no env at
 * workflow level (it would reach every job, the sign jobs included).
 */
function cwf5(ws) {
  const p = [...ws.errors];
  for (const [f, w] of Object.entries(ws.wf)) {
    if ('env' in w.doc) p.push(`${f}: env at workflow level (it reaches every job, the sign jobs included; set env on a job or a step)`);
    // GitHub reads function and context names in any case: toJson(Secrets) and FROMJSON(vars) are toJSON(secrets) and fromJSON(vars).
    for (const m of w.text.matchAll(/\b(to|from)JSON\s*\(\s*(secrets|vars)\s*\)/gi)) p.push(`${f}: ${m[1].toLowerCase()}JSON(${m[2].toLowerCase()})`);
    if (/^\s*secrets\s*:\s*inherit\b/m.test(w.text)) p.push(`${f}: secrets: inherit`);
    for (const m of w.text.matchAll(/\b(secrets|vars)\s*\[/gi)) p.push(`${f}: ${m[1].toLowerCase()}[...] (only ${m[1].toLowerCase()}.<NAME> is read)`);
    const perms = w.doc.permissions;
    if (!isMap(perms) || !same(keys(perms), ['contents']) || perms.contents !== 'read') p.push(`${f}: workflow permissions must be exactly contents: read`);
    const jobs = jobsOf(w);
    const inJobs = new Set(Object.values(jobs).filter(isMap));
    for (const t of texts(w.doc, inJobs)) {
      for (const e of exprs(t)) if (/\b(secrets|vars)\b/i.test(e)) p.push(`${f}: a secret or variable outside the jobs: \${{${shown(e)}}}`);
    }
    for (const [id, job] of Object.entries(jobs)) {
      if (!isMap(job)) { p.push(`${where(f, id)}: not a mapping`); continue; }
      for (const k of ['container', 'services']) if (k in job) p.push(`${where(f, id)}: ${k} (a job runs on GitHub's hosted runner itself, with no image in or beside it)`);
      if (job['runs-on'] !== RUNNER) p.push(`${where(f, id)}: runs-on ${JSON.stringify(job['runs-on'] ?? null)}, expected ${RUNNER} (GitHub's hosted runner only)`);
      const env = job.environment;
      const want = JOB_ENV[f]?.[id];
      if (env !== undefined && typeof env !== 'string') p.push(`${where(f, id)}: environment must be a plain name`);
      else if (env !== want) p.push(`${where(f, id)}: environment ${env ?? 'none'}, expected ${want ?? 'none'}`);
      if ('secrets' in job) p.push(`${where(f, id)}: passes secrets to a reusable workflow`);
      for (const e of [...[...texts(job)].flatMap(exprs), ...bareIfs(job)]) {
        for (const { ctx, table, kind, re } of VALUE_CONTEXTS) {
          let whole = false;
          for (const m of e.matchAll(re)) {
            const n = m[1];
            if (n === undefined) whole = true;
            else if (!Object.hasOwn(table, n)) p.push(`${where(f, id)}: ${kind} ${n} is not one this repository names`);
            else if (table[n] !== env) p.push(`${where(f, id)}: ${kind} ${n} belongs only in a job with environment ${table[n]}`);
          }
          // One problem per expression and context, not per read: each would hold the expression.
          if (whole) p.push(`${where(f, id)}: the whole ${ctx} context in \${{${shown(e)}}} (only ${ctx}.<NAME> is read; not ${ctx}.*, an index or a spaced dot)`);
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
 * check out only the public keys folder and run no npm, Node or AWS CLI. Their steps are exactly SIGN_STEPS: each step's name and
 * the SHA-256 of the whole step. Head, signature and catalog artifacts are kept 90 days.
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
    if (steps.length !== SIGN_STEPS.length) p.push(`${where(f, 'sign')}: ${steps.length} steps, the pinned list has ${SIGN_STEPS.length} (${PIN_HOW})`);
    for (let k = 0; k < Math.min(steps.length, SIGN_STEPS.length); k++) {
      const [name, sum] = SIGN_STEPS[k];
      const got = { name: isMap(steps[k]) ? steps[k].name ?? null : null, sum: sha256(canon(steps[k])) };
      if (got.name !== name || got.sum !== sum) {
        p.push(`${where(f, 'sign', k + 1)}: ${JSON.stringify(got.name)} sha256 ${got.sum}, pinned ${JSON.stringify(name)} sha256 ${sum} (${PIN_HOW})`);
        break;
      }
    }
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

/**
 * C-WF8 (publish.yml): no job that runs for target test names index; sign, sign-test and upload have the ifs PINNED_IFS pins,
 * written exactly, and upload has the plan's needs.
 */
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
  if (!hasPinnedIf(f, 'sign', jobs.sign)) p.push(`${where(f, 'sign')}: if must be exactly ${pinText(f, 'sign')}`);
  const st = jobs['sign-test'];
  if (!isMap(st) || 'environment' in st || !hasPinnedIf(f, 'sign-test', st)) p.push(`${where(f, 'sign-test')}: must have no environment and if exactly ${pinText(f, 'sign-test')}`);
  const up = jobs.upload;
  if (!isMap(up) || !same(listOf(up.needs), ['build', 'sign', 'sign-test'])) p.push(`${where(f, 'upload')}: needs must be exactly [build, sign, sign-test]`);
  if (!hasPinnedIf(f, 'upload', up)) p.push(`${where(f, 'upload')}: if must be exactly ${pinText(f, 'upload')}`);
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
  if (!hasPinnedIf(f, 'head', head)) p.push(`${where(f, 'head')}: if must be exactly ${pinText(f, 'head')}`);
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
/** Any quoted literal. */
const ANY_QUOTED_RE = String.raw`["'][^"'\n]+["']`;
const whoLiteral = (quoted) => new RegExp(String.raw`${WHO_RE}\s*[!=]==?\s*${quoted}|${quoted}\s*[!=]==?\s*${WHO_RE}`);
const ID_LITERAL_RES = [
  /\b(?:user|actor|owner|approver|reviewer|login)[_-]?id["']?\s*(?:[:=]|[!=]==?)\s*["']?[0-9]+/i,
  /\.id\s*[!=]==?\s*["']?[0-9]+|["']?[0-9]+["']?\s*[!=]==?\s*[A-Za-z_$][\w$.?]*\.id\b/,
];
/**
 * A user id or login written as a literal: a name for a user's, actor's, owner's, approver's or reviewer's id or login given or
 * compared with a literal, a `.id` or a `.login` (or an Actions actor) compared with one, either way round.
 */
const LITERAL_USER_RES = [...ID_LITERAL_RES, whoLiteral(QUOTED_RE)];
/**
 * LITERAL_USER_RES for a workflow line, which is matched in lower case (GitHub reads context and property names in any case). A
 * workflow expression has no typeof, so no literal is let through as one of its answers: in lower case 'String' would be one.
 */
const WF_LITERAL_USER_RES = [...ID_LITERAL_RES, whoLiteral(ANY_QUOTED_RE)];
/**
 * A YAML line without its comment: a `#` at the start or after a space (U+0020; tabs are refused). A `#` after U+00A0 or another
 * Unicode space is text to YAML, never a comment.
 */
const uncommented = (line) => line.replace(/(^| )#.*$/, '');

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
      // GitHub reads context and property names in any case (GitHub.Actor, sender.ID), so a workflow line is matched in lower case.
      if (WF_LITERAL_USER_RES.some((re) => re.test(code.toLowerCase()))) p.push(`${f}: a user id or login written as a literal (line ${i + 1})`);
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

/** The top-level && terms of an expression (outside parentheses and quotes), or null with an || at the top level or bad nesting. */
function andTerms(e) {
  const out = [];
  let depth = 0;
  let from = 0;
  for (let k = 0; k < e.length; k++) {
    const c = e[k];
    if (c === "'") {
      for (k++; k < e.length && !(e[k] === "'" && e[k + 1] !== "'"); k += e[k] === "'" ? 2 : 1);
      if (k >= e.length) return null;
    } else if (c === '(') depth++;
    else if (c === ')') { if (--depth < 0) return null; }
    else if (depth === 0 && e.startsWith('||', k)) return null;
    else if (depth === 0 && e.startsWith('&&', k)) { out.push(e.slice(from, k).trim()); from = k + 2; k++; }
  }
  if (depth !== 0) return null;
  out.push(e.slice(from).trim());
  return out;
}

/**
 * C-WF12: GitHub gives a job without an if the default success(), which is false when any job before it in the needs chain was
 * skipped, not only the ones it names (publish run 44491400412: sign-test signed, sign was skipped, upload ran on its own if and
 * verify was skipped, a green run with no read-back). So a job after a job with an if keeps the default only when that job is a run
 * gate (RUN_GATES); otherwise its own if is one expression (expr: text outside its `${{ }}` makes it always true), has !cancelled()
 * as a top-level && term, calls no always(), success() or failure() in any case (GitHub reads function names in any case), and has
 * needs.<job>.result == 'success' as a top-level && term for each job it names, so nothing around it (an ||, a second comparison)
 * can make it true without that job's success. Only publish.yml upload's if, written exactly as PINNED_IFS pins it, is not read
 * term by term (WHOLE_IFS): its whole if is the reviewed one (it needs sign or sign-test by target). Every needs names a job of
 * the file. publish.yml verify: needs exactly [upload] and if exactly `${{ VERIFY_IF }}`.
 */
function cwf12(ws) {
  const p = [...ws.errors];
  for (const [f, w] of Object.entries(ws.wf)) {
    const jobs = jobsOf(w);
    const needsOf = (id) => listOf(isMap(jobs[id]) ? jobs[id].needs : undefined);
    for (const [id, job] of Object.entries(jobs)) {
      if (!isMap(job)) continue;
      for (const n of needsOf(id)) if (!isMap(jobs[n])) p.push(`${where(f, id)}: needs ${n}, not a job of ${f}`);
      const before = new Set();
      for (const todo = [...needsOf(id)]; todo.length > 0;) {
        const n = todo.pop();
        if (before.has(n) || !isMap(jobs[n])) continue;
        before.add(n);
        todo.push(...needsOf(n));
      }
      const skippable = [...before].filter((n) => 'if' in jobs[n] && !(RUN_GATES[f] ?? []).includes(n)).sort();
      if (skippable.length === 0 || ((WHOLE_IFS[f] ?? []).includes(id) && hasPinnedIf(f, id, job))) continue;
      if (!('if' in job)) {
        p.push(`${where(f, id)}: no if, so GitHub skips it whenever ${orList(skippable)} is skipped (give it if: \${{ !cancelled() && needs.<job>.result == 'success' }} for each job it needs)`);
        continue;
      }
      const e = expr(job.if);
      if (e === null) p.push(`${where(f, id)}: if is not one expression: GitHub reads text outside its \${{ }} as a string, always true (got ${JSON.stringify(job.if)})`);
      const terms = typeof e === 'string' ? andTerms(e) : null;
      if (!terms || !terms.includes('!cancelled()')) p.push(`${where(f, id)}: if must have !cancelled() as a top-level && term (got ${JSON.stringify(e)})`);
      const status = typeof e === 'string' ? /\b(always|success|failure)\s*\(/i.exec(e) : null;
      if (status) p.push(`${where(f, id)}: if calls ${status[1]}() (only !cancelled() decides on the jobs before it)`);
      for (const n of needsOf(id)) {
        if (!terms || !terms.includes(`needs.${n}.result == 'success'`)) p.push(`${where(f, id)}: if does not require needs.${n}.result == 'success' as a top-level && term`);
      }
    }
  }
  const pw = ws.wf['publish.yml'];
  if (!pw) return [...p, 'publish.yml: missing'];
  const v = jobsOf(pw).verify;
  if (!isMap(v) || !same(listOf(v.needs), ['upload']) || !hasPinnedIf('publish.yml', 'verify', v)) p.push(`publish.yml job verify: needs must be exactly [upload] and if exactly ${pinText('publish.yml', 'verify')}`);
  return [...new Set(p)];
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
  'C-WF12': cwf12,
});
