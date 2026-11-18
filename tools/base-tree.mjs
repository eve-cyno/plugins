#!/usr/bin/env node
// tools/base-tree.mjs: the base tree of check.yml, the commit a pull request is checked against (C8, C10, C13, C14).
//   node tools/base-tree.mjs --rev <full commit id> --out <new or empty folder> [--repo <checkout>]
// The commit's tree is written byte for byte with git ls-tree and git cat-file (tools/lib/basetree.mjs), never with `git archive`,
// which obeys a .gitattributes inside the tree it archives (export-ignore, export-subst). Exit 0 written, 1 refused, 2 usage.
import path from 'node:path';
import { parseArgs } from 'node:util';
import { writeCommitTree } from './lib/basetree.mjs';

const USAGE = 'usage: node tools/base-tree.mjs --rev <full commit id> --out <new or empty folder> [--repo <checkout>]';
const usage = (why) => { if (why) console.error(why); console.error(USAGE); process.exit(2); };
let a;
try {
  a = parseArgs({ args: process.argv.slice(2), strict: true, options: { rev: { type: 'string' }, out: { type: 'string' }, repo: { type: 'string' } } }).values;
} catch (e) { usage(e.message); }
if (!a.out) usage('--out is needed');
if (!/^([0-9a-f]{40}|[0-9a-f]{64})$/.test(a.rev ?? '')) usage('--rev: a full commit id (40 or 64 lower-case hex)');

const r = writeCommitTree({ repo: path.resolve(a.repo ?? '.'), rev: a.rev, out: path.resolve(a.out) });
if (!r.ok) { console.error(`REFUSED: ${r.why}`); process.exit(1); }
console.log(`BASE TREE ${r.rev}: ${r.paths} paths written by git ls-tree and git cat-file (no .gitattributes applied)`);
