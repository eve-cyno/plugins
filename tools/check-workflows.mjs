#!/usr/bin/env node
// tools/check-workflows.mjs: this checkout's static workflow rules (tools/lib/wfrules.mjs, C-WF1 onwards) over another checkout's
// .github/workflows and the files the rules read beside them (docs/RUNBOOK.md "Before every index and mirror approval", step 1). In
// `npm test` the rules guard only this repository's own files; here the coordinator runs them from the trusted worktree over the
// tree of the run's commit <B>, so a run is not approved while its workflows break a rule. Every rule of RULES runs, the rules added
// later included. The rules read files only; nothing of the other checkout is imported or run.
// The rules open what they find by name and follow links, and the YAML reader prints a line it cannot read: a link
// .github/workflows to a folder outside the tree would print that folder's files. So before any rule runs, every path under
// .github, and the folders tools and docs the rules walk from, is read with lstat: a link, or anything under .github that is
// neither a regular file nor a folder (a FIFO would block the read), is a TREE FAIL line and no rule runs.
//
// Usage: node tools/check-workflows.mjs --dir <checkout or tree folder>
// Prints one PASS or FAIL line per rule (a FAIL line per problem), then WORKFLOWS PASS (<n> rules) or WORKFLOWS FAIL <rules>; or
// TREE FAIL lines, then WORKFLOWS FAIL tree. Exit 0 PASS, 1 FAIL, 2 usage. Every printed character is printable ASCII, so a file
// name cannot forge a line.
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { RULES, loadWorkflows } from './lib/wfrules.mjs';

const MAX_PROBLEMS = 50;
/** `s` on one line of printable ASCII: every other character as \u{hex}. */
const oneLine = (s) => [...String(s)].map((c) => (/^[\x20-\x7e]$/.test(c) ? c : `\\u{${c.codePointAt(0).toString(16)}}`)).join('').slice(0, 500);

/** The folders the rules walk from (wfrules.mjs filesUnder); inside them the walk reads no link. */
const WALK_ROOTS = ['tools', 'docs'];

/**
 * What the rules may not read below `dir`, one line each: a link at or under .github or at a walk root, and anything under .github
 * that is neither a regular file nor a folder. Nothing is opened but folders, read with lstat.
 */
export function treeProblems(dir) {
  const problems = [];
  const look = (rel, deep) => {
    let st;
    try { st = fs.lstatSync(path.join(dir, ...rel.split('/'))); } catch (e) { if (e.code === 'ENOENT') return; problems.push(`${rel}: cannot be read (${e.code ?? e.message})`); return; }
    if (st.isSymbolicLink()) { problems.push(`${rel}: a link (the rules read no link: it can point out of the tree)`); return; }
    if (!deep) return;
    if (st.isDirectory()) {
      let names;
      try { names = fs.readdirSync(path.join(dir, ...rel.split('/'))).sort(); } catch (e) { problems.push(`${rel}: cannot be listed (${e.code ?? e.message})`); return; }
      for (const n of names) look(`${rel}/${n}`, true);
    } else if (!st.isFile()) problems.push(`${rel}: neither a regular file nor a folder`);
  };
  look('.github', true);
  for (const r of WALK_ROOTS) look(r, false);
  return problems;
}

/** The rules over the checkout `dir`: { ok, lines, failed: [rule names] }. A rule that throws fails. */
export function checkWorkflows(dir) {
  const refused = treeProblems(dir);
  if (refused.length > 0) {
    const lines = refused.slice(0, MAX_PROBLEMS).map((p) => `TREE FAIL ${oneLine(p)}`);
    if (refused.length > MAX_PROBLEMS) lines.push(`TREE FAIL ... ${refused.length - MAX_PROBLEMS} more problems`);
    return { ok: false, lines: [...lines, 'WORKFLOWS FAIL tree'], failed: ['tree'] };
  }
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
