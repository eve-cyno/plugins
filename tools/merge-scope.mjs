#!/usr/bin/env node
// tools/merge-scope.mjs: the scope gate of docs/RUNBOOK.md "Publishing" steps 1.4a (before a local merge) and 1.5a (after it, before
// the push). check.yml runs the pull request's own tools/check.mjs and workflow file, so its green `checks` and `review` jobs mean
// something only when the pull request changes nothing but entries: then the jobs ran the base's own code.
//   SCOPE ENTRIES-ONLY (exit 0): every change from <base> to <head> is an added or changed regular file (mode 100644, before and
//     after) named revoked.json or entries/<id>.json, with <id> a plugin id (the vendored host's isPluginId, the grammar C2 applies).
//   SCOPE OWNER <names> (exit 3): anything else, named: a path outside those names (entries/.gitattributes and entries/.gitkeep
//     included), a deletion, a link, a submodule, an executable file, a mode or type change. The owner reads those changes in the
//     pull request before he says "merge"; a green job proves nothing about them.
//   SCOPE UNREAD <names> (exit 4, only with --read <H>): an owner path of <head> that the owner did not read at <H> (step 1.5a, after
//     the merge): <head> does not hold the object <H> names at that path (a file main changed too, a path only the merge commit
//     holds), or <H> holds it as the merge base of <base> and <H> did, so the compare view <merge base>...<H> of step 1.4a never
//     showed it. The objects are compared, never the printed names. Before that, <head> must be the merge of <H> on <base>, with
//     exactly the parents <base> and <H> in that order, as its commit object names them; anything else (a fast-forward, a squash,
//     an octopus, swapped parents, the merge of another head than <H>) is an error.
// It reads git plumbing only (rev-parse, merge-base, diff-tree of two commits: no worktree, no index, no diff driver, no
// .gitattributes, no .gitmodules, no replace refs, no rename detection), imports nothing from the candidate repository and runs
// none of its code: run it from the trusted worktree of docs/RUNBOOK.md "Roles", never from the checkout under review. With
// --merge-base it compares <head> with the one merge base of <base> and <head> (what `git diff <base>...<head>` shows); more than
// one merge base is an error.
//
// Usage: node tools/merge-scope.mjs --repo-dir <checkout> --base <rev> --head <rev> [--merge-base] [--read <full commit id>]
// --read takes <H> by all 40 (or 64) hex digits only, as the owner's "merge" names it; a short id or a ref name is a usage error.
// Exit 0 ENTRIES-ONLY, 3 OWNER, 4 UNREAD, 1 error (no SCOPE line), 2 usage. Paths are printed as they are when they hold only
// [A-Za-z0-9._/@+=,-], else quoted with every other character as \u{hex}, so a path cannot forge a line.
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { gitArgs, gitEnv } from './lib/gitsafe.mjs';

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

/**
 * Runs git without a shell in `repoDir`, minus the variables that redirect it and with replace refs off (a refs/replace entry
 * would show another commit or tree in place of the one named; tools/lib/gitsafe.mjs): { out: Buffer } or { why }.
 */
function git(repoDir, args, env) {
  const r = spawnSync('git', gitArgs(repoDir, args), { env: gitEnv(env), maxBuffer: MAX_BUFFER, timeout: 120_000, windowsHide: true });
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

/**
 * The changes from commit `from` to commit `to`: { changes: [{status, srcMode, dstMode, path, raw}] } or { why }. `raw` is the
 * path's bytes as a latin1 string, the key that compares paths (decoded, two different byte paths can read the same).
 * --ignore-submodules=none: a .gitmodules in the working folder (ignore = all) or diff.ignoreSubmodules would hide a gitlink.
 */
function changesOf(repoDir, from, to, env) {
  const r = git(repoDir, ['diff-tree', '-r', '-z', '--raw', '--no-renames', '--no-ext-diff', '--no-textconv', '--ignore-submodules=none', '--end-of-options', from, to], env);
  if (r.why) return r;
  const fields = r.out.toString('latin1').split('\0');
  if (fields.pop() !== '') return { why: 'git diff-tree output does not end with NUL' };
  const changes = [];
  for (let i = 0; i < fields.length; i += 2) {
    const h = RAW_RE.exec(fields[i]);
    if (!h || i + 1 >= fields.length) return { why: `git diff-tree printed a record it cannot read (${shown(fields[i].slice(0, 120))})` };
    // Paths are bytes; decoded as UTF-8 a byte that is not UTF-8 becomes U+FFFD, which no in-scope name holds.
    changes.push({ srcMode: h[1], dstMode: h[2], status: h[5], path: Buffer.from(fields[i + 1], 'latin1').toString('utf8'), raw: fields[i + 1] });
  }
  return { changes };
}

/**
 * The parents of commit `oid` as its own object names them, in order: { parents } or { why }. It reads the commit object (git
 * cat-file commit, replace refs off), so a graft or a refs/replace entry cannot change the list. It parses the header as git does:
 * the first line is `tree <oid>`, and the parents are only the `parent <oid>` lines directly after it; the first other line ends
 * them, so a `parent` line further down (after the author line, say) is no parent to git and none here. A `parent ` line in that
 * run whose id is not 40 or 64 lowercase hex is an error.
 */
function parentsOf(repoDir, oid, env) {
  const r = git(repoDir, ['cat-file', 'commit', oid], env);
  if (r.why) return r;
  const lines = r.out.toString('latin1').split('\n');
  if (!/^tree (?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(lines[0])) return { why: `commit ${oid} does not start with a tree line` };
  const parents = [];
  for (const l of lines.slice(1)) {
    if (!l.startsWith('parent ')) break;
    // git also reads an id it would not write (uppercase hex, say) as a parent; one this parser cannot read is an error, never
    // the end of the list, or an octopus would read as the merge of <H> on <B>.
    const m = /^parent ([0-9a-f]{40}|[0-9a-f]{64})$/.exec(l);
    if (!m) return { why: `commit ${oid} has a parent line that does not name a full lowercase id (${shown(l.slice(0, 120))})` };
    parents.push(m[1]);
  }
  return { parents };
}

/** The one merge base of commits `a` and `b`: { oid } or { why }; more than one is an error (RUNBOOK 1.4a: rebase, then step 1). */
function oneMergeBase(repoDir, a, b, env) {
  const mb = git(repoDir, ['merge-base', '--all', '--end-of-options', a, b], env);
  if (mb.why) return { why: `no merge base of ${a} and ${b} (${mb.why})` };
  const all = mb.out.toString('utf8').split('\n').filter(Boolean);
  if (all.length !== 1 || !OID_RE.test(all[0])) {
    return { why: `${a} and ${b} have ${all.length} merge bases: rebase the pull request on main, then start again at step 1 of "Publishing"` };
  }
  return { oid: all[0] };
}

/**
 * The scope of `head` against `base` in `repoDir`: { ok: true, lines, owner: [paths], unread: [paths] } (owner empty:
 * ENTRIES-ONLY; unread not empty: UNREAD) or { ok: false, why }. `mergeBase`: compare with the one merge base of the two.
 * `read`: the commit <H> the owner read; every owner path must be the object <H> names there, and one <H> changed from the merge
 * base of `base` and <H> (so the compare view <merge base>...<H> showed it), else it is unread.
 */
export function mergeScope({ repoDir, base, head, mergeBase = false, read = null, env = process.env }) {
  const b = commitOf(repoDir, base, env);
  if (b.why) return { ok: false, why: b.why };
  const h = commitOf(repoDir, head, env);
  if (h.why) return { ok: false, why: h.why };
  let from = b.oid;
  let header = `base ${b.oid}, head ${h.oid}`;
  if (mergeBase) {
    const mb = oneMergeBase(repoDir, b.oid, h.oid, env);
    if (mb.why) return { ok: false, why: mb.why };
    from = mb.oid;
    header = `base ${b.oid} (merge base ${from}), head ${h.oid}`;
  }
  const c = changesOf(repoDir, from, h.oid, env);
  if (c.why) return { ok: false, why: c.why };
  const lines = [header];
  const owner = [];
  for (const [i, r] of c.changes.entries()) {
    const why = ownerReason(r);
    if (why) owner.push(r);
    if (i < SHOWN_LINES) lines.push(`${why ? 'owner' : 'entry'} ${r.status} ${shown(r.path)}${why ? `: ${why}` : ''}`);
  }
  if (c.changes.length > SHOWN_LINES) lines.push(`... ${c.changes.length - SHOWN_LINES} more changes (${c.changes.length} in all)`);
  const unread = [];
  if (read !== null) {
    const r = commitOf(repoDir, read, env);
    if (r.why) return { ok: false, why: r.why };
    // 64 hex digits in a SHA-1 repository (or 40 in a SHA-256 one) name no object, so git reads them as a ref name, and a tag of
    // that name could point anywhere: <H> must be the commit its id names, nothing it resolves to.
    if (r.oid !== read) return { ok: false, why: `--read ${shown(read)} resolves to ${r.oid}, not to itself: name <H> by its own full id` };
    // Step 1.5 makes the merge with `git merge --no-ff <H>` on <B>: exactly the parents <B> and <H>, in that order. A fast-forward,
    // a squash, an octopus (another branch's change rides along) or swapped parents is no merge of what the owner read.
    const p = parentsOf(repoDir, h.oid, env);
    if (p.why) return { ok: false, why: p.why };
    if (p.parents.length !== 2 || p.parents[0] !== b.oid || p.parents[1] !== r.oid) {
      const n = p.parents.length;
      return {
        ok: false,
        why: '--head is not the merge of --read on --base: git reset --hard <B>, do not push, and start again at step 1 of "Publishing" '
          + `(${h.oid} has ${n} parent${n === 1 ? '' : 's'}${n ? ` ${p.parents.map((x) => x.slice(0, 12)).join(' ')}` : ''}; `
          + `step 1.5 makes exactly ${b.oid.slice(0, 12)} then ${r.oid.slice(0, 12)})`,
      };
    }
    const mb = oneMergeBase(repoDir, b.oid, r.oid, env);
    if (mb.why) return { ok: false, why: mb.why };
    const notAsRead = changesOf(repoDir, r.oid, h.oid, env);
    if (notAsRead.why) return { ok: false, why: notAsRead.why };
    const inView = changesOf(repoDir, mb.oid, r.oid, env);
    if (inView.why) return { ok: false, why: inView.why };
    const differs = new Set(notAsRead.changes.map((x) => x.raw));
    const shownInView = new Set(inView.changes.map((x) => x.raw));
    for (const o of owner) {
      const why = differs.has(o.raw) ? `not the object ${r.oid} names`
        : !shownInView.has(o.raw) ? `unchanged from the merge base ${mb.oid} to ${r.oid}, so not in the compare view` : null;
      if (!why) continue;
      if (unread.length < SHOWN_LINES) lines.push(`unread ${o.status} ${shown(o.path)}: ${why}`);
      unread.push(o.path);
    }
    if (unread.length > SHOWN_LINES) lines.push(`... ${unread.length - SHOWN_LINES} more unread paths (${unread.length} in all)`);
    if (unread.length === 0) lines.push(`read ${r.oid} (merge base ${mb.oid}): ${owner.length} owner paths, each the object ${r.oid} names and changed by it`);
  }
  return { ok: true, lines, owner: owner.map((o) => o.path), unread };
}

const USAGE = 'usage: node tools/merge-scope.mjs --repo-dir <checkout> --base <rev> --head <rev> [--merge-base] [--read <full commit id>]';

function main(argv) {
  let a;
  try {
    a = parseArgs({
      args: argv, strict: true, allowPositionals: false,
      options: { 'repo-dir': { type: 'string' }, base: { type: 'string' }, head: { type: 'string' }, 'merge-base': { type: 'boolean' }, read: { type: 'string' } },
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
  if (a.read !== undefined && !OID_RE.test(a.read)) {
    process.stderr.write(`--read must name a commit by all 40 (or 64) hex digits, as the owner's "merge" names <H>; never a short id or a ref name\n${USAGE}\n`);
    return 2;
  }
  const r = mergeScope({ repoDir: path.resolve(a['repo-dir']), base: a.base, head: a.head, mergeBase: a['merge-base'] === true, read: a.read ?? null });
  if (!r.ok) {
    process.stderr.write(`ERROR ${oneLine(r.why)}\n`);
    return 1;
  }
  const named = (ps) => `${ps.slice(0, SHOWN_NAMES).map(shown).join(' ')}${ps.length > SHOWN_NAMES ? ` ... (${ps.length} paths in all)` : ''}`;
  const verdict = r.unread.length > 0 ? `SCOPE UNREAD ${named(r.unread)}` : r.owner.length === 0 ? 'SCOPE ENTRIES-ONLY' : `SCOPE OWNER ${named(r.owner)}`;
  process.stdout.write(`${[...r.lines, verdict].join('\n')}\n`);
  return r.unread.length > 0 ? 4 : r.owner.length === 0 ? 0 : 3;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  process.exitCode = main(process.argv.slice(2));
}
