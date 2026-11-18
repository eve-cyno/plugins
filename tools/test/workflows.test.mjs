// Static tests of the three workflows (plan task 1.8, rules C-WF1 to C-WF11) and of the strict YAML reader they are read with.
// Every rule passes on this repository's own .github/workflows, and every rule is shown failing on a copy broken one way per case
// (a mutant), so each failing case proves that its rule sees exactly that change. Nothing here runs a workflow, a network request or
// a tool of task 1.7; the rules read the files only.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { YamlSubsetError, parseYaml } from '../lib/yamlsub.mjs';
import { GUARD_STEP, MAIN_HEAD_STEP, RULES, jobLines, loadWorkflows, todoPins } from '../lib/wfrules.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const WF_DIR = path.join(ROOT, '.github', 'workflows');
const STRICT_PINS = process.env.EVECYNO_PIN_STRICT === '1';

const temps = [];
after(() => { for (const t of temps) fs.rmSync(t, { recursive: true, force: true }); });
const tempDir = () => { const t = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-test-')); temps.push(t); return t; };

const real = loadWorkflows(ROOT);

// The canonical steps, as text, so the mutants above can remove them from one job.
const GUARD_TEXT = stepText(GUARD_STEP);
const MAIN_HEAD_TEXT = stepText(MAIN_HEAD_STEP);
function stepText(step) {
  return [`      - name: ${step.name}`, '        run: |', ...step.run.replace(/\n$/, '').split('\n').map((l) => `          ${l}`), '', ''].join('\n');
}

/**
 * A copy of the workflows, the tool sources (tools/*.mjs, tools/lib/*.mjs) and tools/reviewer.json with `edits` applied, loaded like
 * the real ones. An edit is { file, from, to } on a workflow (the text must occur exactly once, or at least once with `all`),
 * { file, job, from, to } (the same, inside one job's lines only), { path, from, to } on a repository path, or { file | path, text }
 * (writes the whole file; null deletes it).
 */
function mutant(edits) {
  const t = tempDir();
  const dir = path.join(t, '.github', 'workflows');
  fs.mkdirSync(dir, { recursive: true });
  for (const f of fs.readdirSync(WF_DIR)) fs.copyFileSync(path.join(WF_DIR, f), path.join(dir, f));
  for (const sub of ['tools', 'tools/lib']) {
    fs.mkdirSync(path.join(t, sub), { recursive: true });
    for (const f of fs.readdirSync(path.join(ROOT, sub))) {
      if (f.endsWith('.mjs') || (sub === 'tools' && f === 'reviewer.json')) fs.copyFileSync(path.join(ROOT, sub, f), path.join(t, sub, f));
    }
  }
  for (const e of edits) {
    const p = e.path ? path.join(t, e.path) : path.join(dir, e.file);
    if ('text' in e) {
      if (e.text === null) fs.rmSync(p);
      else fs.writeFileSync(p, e.text);
      continue;
    }
    const src = fs.readFileSync(p, 'utf8');
    let lo = 0;
    let hi = src.length;
    if (e.job) {
      const r = jobLines(src, e.job);
      assert.ok(r, `mutant: ${e.file} has no job ${e.job}`);
      const lines = src.split('\n');
      lo = lines.slice(0, r.start).join('\n').length + (r.start > 0 ? 1 : 0);
      hi = lo + lines.slice(r.start, r.end + 1).join('\n').length;
    }
    const part = src.slice(lo, hi);
    const n = part.split(e.from).length - 1;
    assert.ok(n >= 1, `mutant: ${e.file ?? e.path}${e.job ? ` job ${e.job}` : ''} does not contain ${JSON.stringify(e.from)}`);
    if (!e.all) assert.equal(n, 1, `mutant: ${e.file ?? e.path} contains ${JSON.stringify(e.from)} ${n} times`);
    const next = e.all ? part.split(e.from).join(e.to) : part.replace(e.from, () => e.to);
    fs.writeFileSync(p, src.slice(0, lo) + next + src.slice(hi));
  }
  return loadWorkflows(t);
}

/** The rule passes on the real workflows and reports a problem matching `re` on the mutant. */
function refuses(rule, edits, re) {
  assert.deepEqual(RULES[rule](real), [], `${rule} passes on the real workflows`);
  const problems = RULES[rule](mutant(edits));
  assert.ok(problems.some((p) => re.test(p)), `${rule}: expected a problem matching ${re}, got ${JSON.stringify(problems)}`);
}

describe('YS: the strict YAML subset reader', () => {
  const bad = (src, re) => assert.throws(() => parseYaml(src), (e) => e instanceof YamlSubsetError && re.test(e.message));

  test('YS-values: mappings, sequences, scalars, flow sequences and literal blocks', () => {
    const { value } = parseYaml([
      '# a comment',
      'on:',
      '  workflow_dispatch:',
      'a: plain value # comment',
      "b: 'it''s'",
      'c: "say \\"hi\\" \\\\"',
      'd: [build, sign, sign-test]',
      'e: []',
      'f: ${{ x == \'y\' }}',
      'g: |',
      '  line 1',
      '',
      '    line 2 # not a comment',
      'h: |-',
      '  no newline',
      'i:',
      '  - one',
      '  - k: v',
      '    l: w',
      '  -   m: deeper',
      'j: a#b',
      '',
    ].join('\n'));
    assert.deepEqual(JSON.parse(JSON.stringify(value)), {
      on: { workflow_dispatch: null },
      a: 'plain value', b: "it's", c: 'say "hi" \\', d: ['build', 'sign', 'sign-test'], e: [], f: "${{ x == 'y' }}",
      g: 'line 1\n\n  line 2 # not a comment\n', h: 'no newline', i: ['one', { k: 'v', l: 'w' }, { m: 'deeper' }], j: 'a#b',
    });
  });

  test('YS-spans: the raw lines of a nested block', () => {
    const src = 'jobs:\n  a:\n    steps:\n      - run: x\n      - run: |\n          y\n  b:\n    steps: []\n';
    const { value, spans, lines } = parseYaml(src);
    const s = spans.get(value.jobs.a.steps);
    assert.deepEqual(lines.slice(s.start, s.end + 1), ['      - run: x', '      - run: |', '          y']);
    assert.deepEqual(jobLines(src, 'b'), { start: 7, end: 7 });
  });

  test('YS-refuses what it does not read the way GitHub does', () => {
    bad('a: &x 1\n', /anchor|alias|tag|indicator/);
    bad('a: *x\n', /anchor|alias|tag|indicator/);
    bad('a: !!str x\n', /anchor|alias|tag|indicator/);
    bad('a: {b: 1}\n', /flow mapping|indicator/);
    bad('a:\n\tb: 1\n', /tab/);
    bad('a: 1\na: 2\n', /duplicate key a/);
    bad('a: one\n  two\n', /indentation/);
    bad('a: >\n  folded\n', /folded|indicator/);
    bad('---\na: 1\n', /document|key/);
    bad('a:\n- x\n', /sequence item/);
    bad("a: 'open\n", /unterminated/);
    bad('a: "\\n"\n', /escape/);
    bad('a: |+\n  x\n', /block scalar header/);
    bad('a:value\n', /key: value/);
    bad('a: b: c\n', /": "/);
    bad('a: [x, {y}]\n', /flow sequence/);
    bad('a: |\n    x\n  y\n', /less indented/);
    bad('a: 1\r\n', /carriage return/);
    bad('- a\n', /mapping/);
  });
});

describe('C-WF1 triggers', () => {
  test('C-WF1 the real workflows pass', () => assert.deepEqual(RULES['C-WF1'](real), []));
  test('C-WF1 refuses pull_request_target', () => refuses('C-WF1', [{ file: 'check.yml', from: '\n  pull_request:\n', to: '\n  pull_request_target:\n' }], /pull_request_target/));
  test('C-WF1 refuses an added workflow_run trigger', () => refuses('C-WF1', [{ file: 'publish.yml', from: '\non:\n', to: '\non:\n  workflow_run:\n    workflows: [check]\n' }], /workflow_run/));
  test('C-WF1 refuses issue_comment written as a list', () => refuses('C-WF1', [{ file: 'check.yml', from: '\non:\n  pull_request:\n    branches: [main]\n', to: '\non: [pull_request, issue_comment]\n' }], /issue_comment/));
  test('C-WF1 refuses a fourth workflow file', () => refuses('C-WF1', [{ file: 'extra.yml', text: 'name: x\non: push\npermissions:\n  actions: write\njobs: {}\n' }], /extra\.yml/));
  test('C-WF1 refuses resign.yml without its schedule', () => refuses('C-WF1', [{ file: 'resign.yml', from: "  schedule:\n    - cron: '17 6 * * 1'\n", to: '' }], /resign\.yml: triggers/));
});

describe('C-WF2 actions pinned by full SHA', () => {
  test('C-WF2 the real workflows pass (TODO-PIN is reported below, never accepted as a pin)', () => assert.deepEqual(RULES['C-WF2'](real), []));
  test('C-WF2 refuses a tag', () => refuses('C-WF2', [{ file: 'check.yml', job: 'checks', from: '@3d3c42e5aac5ba805825da76410c181273ba90b1', to: '@v7' }], /not pinned/));
  test('C-WF2 refuses a short SHA', () => refuses('C-WF2', [{ file: 'resign.yml', job: 'check', from: '@3d3c42e5aac5ba805825da76410c181273ba90b1', to: '@3d3c42e' }], /not pinned/));
  test('C-WF2 refuses upper-case hex', () => refuses('C-WF2', [{ file: 'publish.yml', job: 'sign', from: 'actions/upload-artifact@cf430e030ddbb5b0abf93d22962f4752f3646cd9', to: 'actions/upload-artifact@CF430E030DDBB5B0ABF93D22962F4752F3646CD9' }], /not pinned/));
  test('C-WF2 refuses a local action', () => refuses('C-WF2', [{ file: 'check.yml', job: 'checks', from: 'actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1', to: './.github/actions/checkout' }], /not pinned/));
  test('C-WF2 refuses a docker image', () => refuses('C-WF2', [{ file: 'check.yml', job: 'checks', from: 'actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1', to: 'docker://alpine:3' }], /not pinned/));
  test('C-WF2 refuses a uses: the structure did not see', () => refuses('C-WF2', [{ file: 'check.yml', from: '\njobs:\n', to: '\nx: |\n  uses: a/b@v1\njobs:\n' }], /uses: lines/));
  test('C-WF2 a TODO-PIN is reported with its place', () => {
    const ws = mutant([{ file: 'check.yml', job: 'checks', from: '@3d3c42e5aac5ba805825da76410c181273ba90b1', to: '@TODO-PIN' }]);
    assert.ok(todoPins(ws).some((t) => /check\.yml job checks step \d+: actions\/checkout@TODO-PIN/.test(t)), JSON.stringify(todoPins(ws)));
    assert.deepEqual(RULES['C-WF2'](ws), []);
  });
  const todos = todoPins(real);
  const todo = todos.length > 0 && !STRICT_PINS ? `${todos.length} uses: wait for a verified SHA (EVECYNO_PIN_STRICT=1 fails): ${todos.join('; ')}` : false;
  test('C-WF2 no TODO-PIN remains', { todo }, () => assert.deepEqual(todos, []));
});

describe('C-WF3 no expressions inside run', () => {
  test('C-WF3 the real workflows pass', () => assert.deepEqual(RULES['C-WF3'](real), []));
  test('C-WF3 refuses an input inside run', () => refuses('C-WF3', [{ file: 'publish.yml', from: '          printf \'%s\\n\' "$LIFT"', to: '          printf \'%s\\n\' "${{ inputs.lift }}"' }], /publish\.yml job build step \d+: run holds an expression/));
  test('C-WF3 refuses event data inside run', () => refuses('C-WF3', [{ file: 'check.yml', job: 'review', from: '--author "$PR_AUTHOR"', to: '--author "${{ github.event.pull_request.user.login }}"' }], /check\.yml job review/));
});

describe('C-WF4 no lifetime override', () => {
  test('C-WF4 the real workflows pass', () => assert.deepEqual(RULES['C-WF4'](real), []));
  test('C-WF4 refuses --lifetime-days', () => refuses('C-WF4', [{ file: 'resign.yml', from: 'tools/build-index.mjs resign ', to: 'tools/build-index.mjs resign --lifetime-days 30 ' }], /lifetime-days/));
});

describe('C-WF5 secrets, variables and permissions', () => {
  test('C-WF5 the real workflows pass', () => assert.deepEqual(RULES['C-WF5'](real), []));
  test('C-WF5 refuses an index secret outside environment index', () => refuses('C-WF5', [{ file: 'publish.yml', job: 'build', from: '      TARGET: ${{ inputs.target }}\n', to: '      TARGET: ${{ inputs.target }}\n      K: ${{ secrets.MINISIGN_INDEX_KEY }}\n' }], /job build: secret MINISIGN_INDEX_KEY/));
  test('C-WF5 refuses an R2 secret outside environment mirror', () => refuses('C-WF5', [{ file: 'resign.yml', job: 'verify', from: '    steps:\n', to: '    env:\n      R: ${{ secrets.R2_SECRET_ACCESS_KEY }}\n    steps:\n' }], /job verify: secret R2_SECRET_ACCESS_KEY/));
  test('C-WF5 refuses an R2 secret in the index job', () => refuses('C-WF5', [{ file: 'resign.yml', job: 'sign', from: '      HEAD_COMMENT: ${{ needs.head.outputs.head_comment }}\n', to: '      HEAD_COMMENT: ${{ needs.head.outputs.head_comment }}\n      R: ${{ secrets.R2_ACCESS_KEY_ID }}\n' }], /job sign: secret R2_ACCESS_KEY_ID/));
  test('C-WF5 refuses a secret this repository does not name', () => refuses('C-WF5', [{ file: 'publish.yml', job: 'upload', from: '          GH_TOKEN: ${{ github.token }}\n', to: '          GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}\n' }], /secret GITHUB_TOKEN/));
  test('C-WF5 refuses toJSON(secrets)', () => refuses('C-WF5', [{ file: 'publish.yml', job: 'sign', from: '      HEAD_SHA256: ${{ needs.build.outputs.head_sha256 }}\n', to: '      HEAD_SHA256: ${{ needs.build.outputs.head_sha256 }}\n      ALL: ${{ toJSON( secrets ) }}\n' }], /toJSON\(secrets\)/));
  test('C-WF5 refuses secrets: inherit', () => refuses('C-WF5', [{ file: 'resign.yml', from: '\n  verify:\n', to: '\n  other:\n    uses: eve-cyno/plugins/.github/workflows/x.yml@0123456789012345678901234567890123456789\n    secrets: inherit\n  verify:\n' }], /secrets: inherit/));
  test('C-WF5 refuses a secret at workflow level', () => refuses('C-WF5', [{ file: 'resign.yml', from: '\npermissions:\n', to: '\nenv:\n  K: ${{ secrets.MINISIGN_INDEX_KEY }}\npermissions:\n' }], /outside the jobs/));
  test('C-WF5 refuses contents: write', () => refuses('C-WF5', [{ file: 'publish.yml', job: 'upload', from: '      contents: read\n', to: '      contents: write\n' }], /job upload: permissions/));
  test('C-WF5 refuses actions: read on the sign job', () => refuses('C-WF5', [{ file: 'publish.yml', job: 'sign', from: '      contents: read\n', to: '      contents: read\n      actions: read\n' }], /job sign: permissions/));
  test('C-WF5 refuses actions: read on resign.yml upload', () => refuses('C-WF5', [{ file: 'resign.yml', job: 'upload', from: '      contents: read\n', to: '      contents: read\n      actions: read\n' }], /resign\.yml job upload: permissions/));
  test('C-WF5 refuses a job without permissions', () => refuses('C-WF5', [{ file: 'check.yml', job: 'review', from: '    permissions:\n      contents: read\n', to: '' }], /job review: permissions/));
  test('C-WF5 refuses write-all at workflow level', () => refuses('C-WF5', [{ file: 'check.yml', from: '\npermissions:\n  contents: read\n', to: '\npermissions: write-all\n' }], /workflow permissions/));
  test('C-WF5 refuses an environment on another job', () => refuses('C-WF5', [{ file: 'publish.yml', job: 'build', from: '    timeout-minutes: 120\n', to: '    timeout-minutes: 120\n    environment: index\n' }], /job build: environment/));
  test('C-WF5 refuses a mirror variable outside mirror', () => refuses('C-WF5', [{ file: 'publish.yml', job: 'verify', from: '      TARGET: ${{ inputs.target }}\n', to: '      TARGET: ${{ inputs.target }}\n      B: ${{ vars.R2_BUCKET }}\n' }], /job verify: variable R2_BUCKET/));
  test('C-WF5 refuses another variable', () => refuses('C-WF5', [{ file: 'publish.yml', job: 'upload', from: '          R2_BUCKET: ${{ vars.R2_BUCKET }}\n', to: '          R2_BUCKET: ${{ vars.OTHER }}\n' }], /variable OTHER/));
  test('C-WF5 refuses bracket access to secrets', () => refuses('C-WF5', [{ file: 'publish.yml', job: 'sign', from: '${{ secrets.MINISIGN_INDEX_KEY }}', to: "${{ secrets['MINISIGN_INDEX_KEY'] }}" }], /secrets\[/));
});

describe('C-WF6 workflow-level concurrency', () => {
  test('C-WF6 the real workflows pass', () => assert.deepEqual(RULES['C-WF6'](real), []));
  test('C-WF6 refuses cancel-in-progress true', () => refuses('C-WF6', [{ file: 'publish.yml', from: '  cancel-in-progress: false\n', to: '  cancel-in-progress: true\n' }], /publish\.yml: concurrency/));
  test('C-WF6 refuses a missing queue', () => refuses('C-WF6', [{ file: 'resign.yml', from: '  queue: max\n', to: '' }], /resign\.yml: concurrency/));
  test('C-WF6 refuses another group', () => refuses('C-WF6', [{ file: 'resign.yml', from: '  group: index-sign\n', to: '  group: resign\n' }], /resign\.yml: concurrency/));
  test('C-WF6 refuses a job-level concurrency', () => refuses('C-WF6', [{ file: 'publish.yml', job: 'verify', from: '    timeout-minutes: 120\n', to: '    timeout-minutes: 120\n    concurrency: verify\n' }], /job verify: concurrency/));
  test('C-WF6 refuses the index-sign group in check.yml', () => refuses('C-WF6', [{ file: 'check.yml', from: '\npermissions:\n', to: '\nconcurrency:\n  group: index-sign\npermissions:\n' }], /check\.yml/));
});

describe('C-WF7 the two sign jobs', () => {
  test('C-WF7 the real workflows pass', () => assert.deepEqual(RULES['C-WF7'](real), []));
  test('C-WF7 refuses one changed character in the steps', () => refuses('C-WF7', [{ file: 'resign.yml', from: 'signature from the eve-cyno/plugins signing workflow', to: 'signature from the eve-cyno/plugins signing workflow.' }], /steps differ/));
  test('C-WF7 refuses another env key', () => refuses('C-WF7', [{ file: 'resign.yml', job: 'sign', from: '      HEAD_COMMENT:', to: '      HEAD_TRUSTED:' }], /env/));
  test('C-WF7 refuses an env value from another job', () => refuses('C-WF7', [{ file: 'publish.yml', job: 'sign', from: '${{ needs.build.outputs.head_sha256 }}', to: '${{ needs.upload.outputs.head_sha256 }}' }], /env/));
  test('C-WF7 refuses another difference outside steps and env', () => refuses('C-WF7', [{ file: 'resign.yml', job: 'sign', from: '    timeout-minutes: 15\n', to: '    timeout-minutes: 16\n' }], /timeout-minutes/));
  test('C-WF7 refuses a job name (approved-base.mjs finds the job by its id)', () => refuses('C-WF7', [{ file: 'publish.yml', job: 'sign', from: '    runs-on: ubuntu-24.04\n', to: '    name: Sign\n    runs-on: ubuntu-24.04\n' }], /key name/));
  test('C-WF7 refuses an if on the resign sign job', () => refuses('C-WF7', [{ file: 'resign.yml', job: 'sign', from: '    needs: head\n', to: '    needs: head\n    if: always()\n' }], /resign\.yml job sign: if/));
  const both = (from, to) => [{ file: 'publish.yml', job: 'sign', from, to }, { file: 'resign.yml', job: 'sign', from, to }];
  test('C-WF7 refuses a full checkout in both', () => refuses('C-WF7', both('          sparse-checkout: vendor/eve-cyno-host/host/src/keys\n          sparse-checkout-cone-mode: false\n', ''), /checkout/));
  test('C-WF7 refuses npm in both', () => refuses('C-WF7', both('          sudo apt-get update -qq\n', '          sudo apt-get update -qq\n          npm ci\n'), /npm/));
  test('C-WF7 refuses setup-node in both', () => refuses('C-WF7', both('      - name: Install minisign (Ubuntu\'s package)\n', '      - name: Node\n        uses: actions/setup-node@0123456789012345678901234567890123456789\n      - name: Install minisign (Ubuntu\'s package)\n'), /actions\/setup-node/));
  test('C-WF7 refuses a head artifact kept 30 days', () => refuses('C-WF7', [{ file: 'publish.yml', job: 'build', from: '          name: head\n          path: ${{ runner.temp }}/work/index/index.json\n          if-no-files-found: error\n          retention-days: 90\n', to: '          name: head\n          path: ${{ runner.temp }}/work/index/index.json\n          if-no-files-found: error\n          retention-days: 30\n' }], /artifact head.*retention-days 90/));
  test('C-WF7 refuses a catalog artifact without retention', () => refuses('C-WF7', [{ file: 'resign.yml', job: 'head', from: '          name: catalog\n          path: ${{ runner.temp }}/work/index/catalog/\n          if-no-files-found: error\n          retention-days: 90\n', to: '          name: catalog\n          path: ${{ runner.temp }}/work/index/catalog/\n          if-no-files-found: error\n' }], /artifact catalog/));
  test('C-WF7 refuses an artifact it does not know', () => refuses('C-WF7', [{ file: 'publish.yml', job: 'build', from: '          name: archives.json\n', to: '          name: archives\n' }], /artifact archives /));
});

describe('C-WF8 target test never reaches index', () => {
  test('C-WF8 the real workflows pass', () => assert.deepEqual(RULES['C-WF8'](real), []));
  test('C-WF8 refuses a sign job without its target', () => refuses('C-WF8', [{ file: 'publish.yml', job: 'sign', from: "    if: ${{ inputs.target == 'production' }}\n", to: '' }], /job sign: if/));
  test('C-WF8 refuses sign-test in index', () => refuses('C-WF8', [{ file: 'publish.yml', job: 'sign-test', from: '    timeout-minutes: 15\n', to: '    timeout-minutes: 15\n    environment: index\n' }], /sign-test/));
  test('C-WF8 refuses an upload without sign-test in needs', () => refuses('C-WF8', [{ file: 'publish.yml', from: '    needs: [build, sign, sign-test]\n', to: '    needs: [build, sign]\n' }], /job upload: needs/));
  test('C-WF8 refuses another upload if', () => refuses('C-WF8', [{ file: 'publish.yml', from: "${{ !cancelled() && needs.build.result == 'success' &&", to: "${{ always() && needs.build.result == 'success' &&" }], /job upload: if/));
  test('C-WF8 refuses a third target', () => refuses('C-WF8', [{ file: 'publish.yml', from: '          - production\n', to: '          - production\n          - staging\n' }], /target/));
  test('C-WF8 refuses another job', () => refuses('C-WF8', [{ file: 'publish.yml', from: '\n  verify:\n', to: '\n  extra:\n    runs-on: ubuntu-24.04\n    steps: []\n  verify:\n' }], /jobs/));
});

describe('C-WF9 one commit per run, no re-runs', () => {
  test('C-WF9 the real workflows pass', () => assert.deepEqual(RULES['C-WF9'](real), []));
  test('C-WF9 refuses a sha input', () => refuses('C-WF9', [{ file: 'publish.yml', from: '      repair:\n', to: '      sha:\n        type: string\n      repair:\n' }], /input sha/));
  test('C-WF9 refuses a checkout of a branch', () => refuses('C-WF9', [{ file: 'resign.yml', job: 'upload', from: '          ref: ${{ github.sha }}\n', to: '          ref: main\n' }], /resign\.yml job upload step \d+: checkout/));
  test('C-WF9 refuses a checkout without ref', () => refuses('C-WF9', [{ file: 'publish.yml', job: 'verify', from: '          ref: ${{ github.sha }}\n', to: '' }], /publish\.yml job verify step \d+: checkout/));
  test('C-WF9 refuses a job without the run-attempt guard', () => refuses('C-WF9', [{ file: 'publish.yml', job: 'verify', from: GUARD_TEXT, to: '' }], /job verify: the first step/));
  test('C-WF9 refuses a changed guard', () => refuses('C-WF9', [{ file: 'resign.yml', job: 'sign', from: '[ "${GITHUB_RUN_ATTEMPT:-}" = 1 ]', to: '[ "${GITHUB_RUN_ATTEMPT:-}" -ge 1 ]' }, { file: 'publish.yml', job: 'sign', from: '[ "${GITHUB_RUN_ATTEMPT:-}" = 1 ]', to: '[ "${GITHUB_RUN_ATTEMPT:-}" -ge 1 ]' }], /job sign: the first step/));
  test('C-WF9 refuses a build job without the head-of-main check', () => refuses('C-WF9', [{ file: 'publish.yml', job: 'build', from: MAIN_HEAD_TEXT, to: '' }], /job build: the second step/));
  test('C-WF9 refuses continue-on-error', () => refuses('C-WF9', [{ file: 'resign.yml', job: 'verify', from: '    timeout-minutes: 120\n', to: '    timeout-minutes: 120\n    continue-on-error: true\n' }], /continue-on-error/));
});

describe('C-WF10 resign.yml upload', () => {
  test('C-WF10 the real workflows pass', () => assert.deepEqual(RULES['C-WF10'](real), []));
  test('C-WF10 refuses another needs', () => refuses('C-WF10', [{ file: 'resign.yml', from: '    needs: [head, sign]\n', to: '    needs: [sign]\n' }], /job upload: needs/));
  test('C-WF10 refuses an if override', () => refuses('C-WF10', [{ file: 'resign.yml', from: '    needs: [head, sign]\n', to: '    needs: [head, sign]\n    if: ${{ !cancelled() }}\n' }], /job upload: if/));
  test('C-WF10 refuses a head job that always runs', () => refuses('C-WF10', [{ file: 'resign.yml', from: "    if: ${{ needs.check.outputs.needed == 'true' }}\n", to: '' }], /job head: if/));
  test('C-WF10 refuses inputs on resign.yml', () => refuses('C-WF10', [{ file: 'resign.yml', from: '\n  workflow_dispatch:\n', to: '\n  workflow_dispatch:\n    inputs:\n      lift:\n        type: string\n' }], /inputs/));
});

describe('C-WF11 the reviewer id comes only from tools/reviewer.json', () => {
  test('C-WF11 the real files pass', () => assert.deepEqual(RULES['C-WF11'](real), []));
  test('C-WF11 refuses a reviewer variable in a workflow', () => refuses('C-WF11', [{ file: 'publish.yml', job: 'upload', from: '      TARGET: ${{ inputs.target }}\n', to: '      TARGET: ${{ inputs.target }}\n      APPROVER: ${{ vars.REVIEWER_ID }}\n' }], /publish\.yml: names a reviewer outside a comment/));
  test('C-WF11 refuses a reviewer input', () => refuses('C-WF11', [{ file: 'publish.yml', from: '      repair:\n', to: '      reviewer:\n        type: string\n      repair:\n' }], /publish\.yml: names a reviewer outside a comment/));
  test('C-WF11 refuses the id as a literal in a workflow', () => refuses('C-WF11', [{ path: 'tools/reviewer.json', text: '{"reviewerId": 98765432}\n' }, { file: 'resign.yml', job: 'check', from: '    timeout-minutes: 30\n', to: '    timeout-minutes: 30\n    env:\n      X: 98765432\n' }], /resign\.yml: holds the reviewer id 98765432/));
  test('C-WF11 refuses the id as a literal in a tool', () => refuses('C-WF11', [{ path: 'tools/reviewer.json', text: '{"reviewerId": 98765432}\n' }, { path: 'tools/approved-base.mjs', from: '// tools/approved-base.mjs:', to: 'const ID = 98765432;\n// tools/approved-base.mjs:' }], /tools\/approved-base\.mjs: holds the reviewer id 98765432/));
  test('C-WF11 refuses a tool that reads the reviewer file itself', () => refuses('C-WF11', [{ path: 'tools/approved-base.mjs', from: '// tools/approved-base.mjs:', to: "const F = 'tools/reviewer.json';\n// tools/approved-base.mjs:" }], /tools\/approved-base\.mjs: names the reviewer file or its key/));
  test('C-WF11 refuses a reviewer argument or environment variable in a tool', () => refuses('C-WF11', [{ path: 'tools/check-envs.mjs', from: '// tools/check-envs.mjs:', to: "const A = process.argv.indexOf('--reviewer');\n// tools/check-envs.mjs:" }], /tools\/check-envs\.mjs: a reviewer argument or environment variable/));
  test('C-WF11 refuses lib/reviewer.mjs reading the environment', () => refuses('C-WF11', [{ path: 'tools/lib/reviewer.mjs', from: '// tools/lib/reviewer.mjs:', to: 'const E = process.env.X;\n// tools/lib/reviewer.mjs:' }], /tools\/lib\/reviewer\.mjs: reads process\.env or process\.argv/));
  test('C-WF11 refuses a reviewer file of another shape', () => refuses('C-WF11', [{ path: 'tools/reviewer.json', text: '{"reviewerId": "98765432"}\n' }], /tools\/reviewer\.json/));
});
