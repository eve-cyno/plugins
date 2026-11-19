#!/usr/bin/env node
// tools/check-workflows.mjs: this checkout's static workflow rules (tools/lib/wfrules.mjs, C-WF1 onwards) over another checkout's
// .github/workflows and the files the rules read beside them (docs/RUNBOOK.md "Before every index and mirror approval", step 1). In
// `npm test` the rules guard only this repository's own files; here the coordinator runs them from the trusted worktree over the
// tree of the run's commit <B>, so a run is not approved while its workflows break a rule. Every rule of RULES runs, the rules added
// later included. The rules read files only; nothing of the other checkout is imported or run.
//
// Usage: node tools/check-workflows.mjs --dir <checkout or tree folder>
// Prints one PASS or FAIL line per rule (a FAIL line per problem), then WORKFLOWS PASS (<n> rules) or WORKFLOWS FAIL <rules>.
// Exit 0 PASS, 1 FAIL, 2 usage. Every printed character is printable ASCII, so a file name cannot forge a line.
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { RULES, loadWorkflows } from './lib/wfrules.mjs';

const MAX_PROBLEMS = 50;
/** `s` on one line of printable ASCII: every other character as \u{hex}. */
const oneLine = (s) => [...String(s)].map((c) => (/^[\x20-\x7e]$/.test(c) ? c : `\\u{${c.codePointAt(0).toString(16)}}`)).join('').slice(0, 500);

/** The rules over the checkout `dir`: { ok, lines, failed: [rule names] }. A rule that throws fails. */
export function checkWorkflows(dir) {
  const ws = loadWorkflows(dir);
  const lines = [];
  const failed = [];
  for (const [name, rule] of Object.entries(RULES)) {
    let problems;
    try { problems = rule(ws); } catch (e) { problems = [`the rule threw: ${e?.message ?? e}`]; }
    if (!Array.isArray(problems)) problems = [`the rule returned ${typeof problems}, not a list`];
    if (problems.length === 0) { lines.push(`${name} PASS`); continue; }
    failed.push(name);
    for (const p of problems.slice(0, MAX_PROBLEMS)) lines.push(`${name} FAIL ${oneLine(p)}`);
    if (problems.length > MAX_PROBLEMS) lines.push(`${name} FAIL ... ${problems.length - MAX_PROBLEMS} more problems`);
  }
  const n = Object.keys(RULES).length;
  lines.push(failed.length === 0 && n > 0 ? `WORKFLOWS PASS (${n} rules)` : `WORKFLOWS FAIL ${failed.join(' ') || '(no rules)'}`);
  return { ok: failed.length === 0 && n > 0, lines, failed };
}

const USAGE = 'usage: node tools/check-workflows.mjs --dir <checkout or tree folder>';

function main(argv) {
  let a;
  try {
    a = parseArgs({ args: argv, strict: true, allowPositionals: false, options: { dir: { type: 'string' } } }).values;
  } catch (e) {
    process.stderr.write(`${oneLine(e.message)}\n${USAGE}\n`);
    return 2;
  }
  if (typeof a.dir !== 'string' || a.dir === '') {
    process.stderr.write(`--dir is needed\n${USAGE}\n`);
    return 2;
  }
  const r = checkWorkflows(path.resolve(a.dir));
  process.stdout.write(`${r.lines.join('\n')}\n`);
  return r.ok ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  process.exitCode = main(process.argv.slice(2));
}
