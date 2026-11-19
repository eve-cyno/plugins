#!/usr/bin/env node
// tools/merge-scope.mjs: the scope gate of docs/RUNBOOK.md "Publishing" steps 1.4a (before a local merge) and 1.5a (after it, before
// the push). check.yml runs the pull request's own tools/check.mjs and workflow file, so its green `checks` and `review` jobs mean
// something only when the pull request changes nothing but entries: then the jobs ran the base's own code.
//   SCOPE ENTRIES-ONLY (exit 0): every change from <base> to <head> is an added or changed regular file (mode 100644, before and
//     after) named revoked.json or entries/<id>.json, with <id> a plugin id (the vendored host's isPluginId, the grammar C2 applies).
//   SCOPE OWNER <names> (exit 3): anything else, named: a path outside those names (entries/.gitattributes and entries/.gitkeep
//     included), a deletion, a link, a submodule, an executable file, a mode or type change. The owner reads those changes in the
//     pull request before he says "merge"; a green job proves nothing about them.
// It reads git plumbing only (rev-parse, merge-base, diff-tree of two commits: no worktree, no index, no diff driver, no
// .gitattributes, no rename detection), imports nothing from the candidate repository and runs none of its code: run it from the
// trusted worktree of docs/RUNBOOK.md "Roles", never from the checkout under review. With --merge-base it compares <head> with the
// one merge base of <base> and <head> (what `git diff <base>...<head>` shows); more than one merge base is an error.
//
// Usage: node tools/merge-scope.mjs --repo-dir <checkout> --base <rev> --head <rev> [--merge-base]
// Exit 0 ENTRIES-ONLY, 3 OWNER, 1 error (no SCOPE line), 2 usage. Paths are printed as they are when they hold only
// [A-Za-z0-9._/@+=,-], else quoted with every other character as \u{hex}, so a path cannot forge a line.
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const M = createRequire(import.meta.url)(path.join(ROOT, 'vendor', 'eve-cyno-host', 'host', 'dist', 'manifest.js'));

const MAX_BUFFER = 256 * 1024 * 1024;
const SHOWN_LINES = 200;
const SHOWN_NAMES = 50;
const OID_RE = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const RAW_RE = /^:([0-7]{6}) ([0-7]{6}) ([0-9a-f]{40}|[0-9a-f]{64}) ([0-9a-f]{40}|[0-9a-f]{64}) ([A-Z])$/;
const FILE_MODE = '100644';

/** `s` on one line of printable ASCII, for messages. */
const oneLine = (s) => String(s).replace(/[^\x20-\x7e]+/g, ' ').trim().slice(0, 300);

/** `p` as it is when it holds only plain path characters, else quoted with each other character escaped: never a line break. */
export function shown(p) {
  const s = p.length > 300 ? `${p.slice(0, 300)}...` : p;
  if (/^[A-Za-z0-9._/@+=,-]+$/.test(s)) return s;
  return `"${[...s].map((c) => (/^[\x21-\x7e]$/.test(c) && c !== '"' && c !== '\\' ? c : `\\u{${c.codePointAt(0).toString(16)}}`)).join('')}"`;
}

/** Why the change `r` ({status, srcMode, dstMode, path}) needs the owner, or null when it is in scope. */
export function ownerReason(r) {
  const m = /^entries\/([^/]+)\.json$/.exec(r.path);
  if (r.path !== 'revoked.json' && !(m && M.isPluginId(m[1]))) return 'outside entries/<id>.json and revoked.json';
  if (r.status === 'D') return 'deleted';
  if (r.status !== 'A' && r.status !== 'M') return `change type ${r.status} (a link, a submodule or a type change)`;
  if (r.dstMode !== FILE_MODE) return `mode ${r.dstMode} (an entry is a regular file, mode ${FILE_MODE})`;
  if (r.status === 'M' && r.srcMode !== FILE_MODE) return `mode ${r.srcMode} to ${r.dstMode}`;
  return null;
}

/** Runs git without a shell in `repoDir`, minus the variables that redirect it: { out: Buffer } or { why }. */
function git(repoDir, args, env) {
  const childEnv = { ...env };
  for (const k of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES', 'GIT_NAMESPACE']) delete childEnv[k];
  const r = spawnSync('git', ['-C', repoDir, ...args], { env: childEnv, maxBuffer: MAX_BUFFER, timeout: 120_000, windowsHide: true });
  if (r.error) return { why: `git could not run (${r.error.code ?? r.error.message})` };
  if (r.status !== 0) return { why: `git ${args[0]} exited ${r.status ?? r.signal}: ${oneLine(r.stderr.toString('utf8').trim().split('\n')[0] ?? '')}` };
  return { out: r.stdout };
}

/** The full commit id of `rev` in `repoDir`: { oid } or { why }. */
function commitOf(repoDir, rev, env) {
  const r = git(repoDir, ['rev-parse', '--verify', '--quiet', '--end-of-options', `${rev}^{commit}`], env);
  if (r.why) return { why: `${shown(rev)} is not a commit of ${shown(repoDir)}` };
  const oid = r.out.toString('utf8').trim();
  return OID_RE.test(oid) ? { oid } : { why: `git rev-parse answered ${shown(oid)} for ${shown(rev)}` };
}

/** The changes from commit `from` to commit `to`: { changes: [{status, srcMode, dstMode, path}] } or { why }. */
function changesOf(repoDir, from, to, env) {
  const r = git(repoDir, ['diff-tree', '-r', '-z', '--raw', '--no-renames', '--no-ext-diff', '--no-textconv', '--end-of-options', from, to], env);
  if (r.why) return r;
  const fields = r.out.toString('latin1').split('\0');
  if (fields.pop() !== '') return { why: 'git diff-tree output does not end with NUL' };
  const changes = [];
  for (let i = 0; i < fields.length; i += 2) {
    const h = RAW_RE.exec(fields[i]);
    if (!h || i + 1 >= fields.length) return { why: `git diff-tree printed a record it cannot read (${shown(fields[i].slice(0, 120))})` };
    // Paths are bytes; decoded as UTF-8 a byte that is not UTF-8 becomes U+FFFD, which no in-scope name holds.
    changes.push({ srcMode: h[1], dstMode: h[2], status: h[5], path: Buffer.from(fields[i + 1], 'latin1').toString('utf8') });
  }
  return { changes };
}

/**
 * The scope of `head` against `base` in `repoDir`: { ok: true, lines, owner: [paths] } (owner empty: ENTRIES-ONLY) or
 * { ok: false, why }. `mergeBase`: compare with the one merge base of the two.
 */
export function mergeScope({ repoDir, base, head, mergeBase = false, env = process.env }) {
  const b = commitOf(repoDir, base, env);
  if (b.why) return { ok: false, why: b.why };
  const h = commitOf(repoDir, head, env);
  if (h.why) return { ok: false, why: h.why };
  let from = b.oid;
  let header = `base ${b.oid}, head ${h.oid}`;
  if (mergeBase) {
    const mb = git(repoDir, ['merge-base', '--all', '--end-of-options', b.oid, h.oid], env);
    if (mb.why) return { ok: false, why: `no merge base of ${b.oid} and ${h.oid} (${mb.why})` };
    const all = mb.out.toString('utf8').split('\n').filter(Boolean);
    if (all.length !== 1 || !OID_RE.test(all[0])) {
      return { ok: false, why: `${b.oid} and ${h.oid} have ${all.length} merge bases: rebase the pull request on main, or let step 1.5a decide on the merge commit` };
    }
    from = all[0];
    header = `base ${b.oid} (merge base ${from}), head ${h.oid}`;
  }
  const c = changesOf(repoDir, from, h.oid, env);
  if (c.why) return { ok: false, why: c.why };
  const lines = [header];
  const owner = [];
  for (const [i, r] of c.changes.entries()) {
    const why = ownerReason(r);
    if (why) owner.push(r.path);
    if (i < SHOWN_LINES) lines.push(`${why ? 'owner' : 'entry'} ${r.status} ${shown(r.path)}${why ? `: ${why}` : ''}`);
  }
  if (c.changes.length > SHOWN_LINES) lines.push(`... ${c.changes.length - SHOWN_LINES} more changes (${c.changes.length} in all)`);
  return { ok: true, lines, owner };
}

const USAGE = 'usage: node tools/merge-scope.mjs --repo-dir <checkout> --base <rev> --head <rev> [--merge-base]';

function main(argv) {
  let a;
  try {
    a = parseArgs({
      args: argv, strict: true, allowPositionals: false,
      options: { 'repo-dir': { type: 'string' }, base: { type: 'string' }, head: { type: 'string' }, 'merge-base': { type: 'boolean' } },
    }).values;
  } catch (e) {
    process.stderr.write(`${oneLine(e.message)}\n${USAGE}\n`);
    return 2;
  }
  for (const k of ['repo-dir', 'base', 'head']) {
    if (typeof a[k] !== 'string' || a[k] === '' || a[k].startsWith('-')) {
      process.stderr.write(`--${k} is needed, and must not start with "-"\n${USAGE}\n`);
      return 2;
    }
  }
  const r = mergeScope({ repoDir: path.resolve(a['repo-dir']), base: a.base, head: a.head, mergeBase: a['merge-base'] === true });
  if (!r.ok) {
    process.stderr.write(`ERROR ${oneLine(r.why)}\n`);
    return 1;
  }
  const names = r.owner.slice(0, SHOWN_NAMES).map(shown).join(' ');
  const more = r.owner.length > SHOWN_NAMES ? ` ... (${r.owner.length} paths in all)` : '';
  process.stdout.write(`${[...r.lines, r.owner.length === 0 ? 'SCOPE ENTRIES-ONLY' : `SCOPE OWNER ${names}${more}`].join('\n')}\n`);
  return r.owner.length === 0 ? 0 : 3;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  process.exitCode = main(process.argv.slice(2));
}
