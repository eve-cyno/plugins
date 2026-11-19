// The tree of one commit written into a folder, byte for byte (tools/base-tree.mjs; check.yml's base tree for C8, C10, C13 and C14).
// It reads the commit with `git ls-tree -r -z --full-tree` and `git cat-file --batch`, which never apply .gitattributes. `git archive`
// does, and reads them from the archived tree itself (core.attributesFile does not turn that off): a merged `.gitattributes` with
// export-ignore would empty every later base, and export-subst would rewrite files in it. Regular files keep their executable bit, a
// link is written as a link, except at or under .github, which refuses: tools/check-workflows.mjs reads that folder of a written
// tree (RUNBOOK approval step 1), and a link there could point out of it. A submodule or any other mode refuses (fail closed).
// After writing, the folder must hold exactly the tree's paths, each hashed again as a git object equal to the one the tree names.
// git runs with replace refs off and without the variables that redirect it (tools/lib/gitsafe.mjs): a refs/replace entry would
// write another commit's tree under the id named, and GIT_DIR or GIT_OBJECT_DIRECTORY would read another repository.
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { gitArgs, gitEnv } from './gitsafe.mjs';

const MAX_BUFFER = 1024 * 1024 * 1024;
const MODES = { 100644: 'file', 100755: 'exec', 120000: 'link' };

function git(repo, args, input) {
  const r = spawnSync('git', gitArgs(repo, args), { input, maxBuffer: MAX_BUFFER, env: gitEnv(process.env) });
  if (r.error) return { why: `git could not run (${r.error.code ?? r.error.message})` };
  if (r.status !== 0) return { why: `git ${args[0]} exited ${r.status}` };
  return { out: r.stdout };
}

/** Why the tree path `p` may not be written below the output folder, or null. */
function pathProblem(p) {
  if (p.length === 0 || p.startsWith('/')) return 'an empty or absolute path';
  for (const c of p.split('/')) if (c === '' || c === '.' || c === '..' || c.toLowerCase() === '.git') return `the path component ${JSON.stringify(c)}`;
  return null;
}

/** The objects of `git cat-file --batch` output, in order: [{oid, type, data}], or {why}. */
function parseBatch(buf, count) {
  const out = [];
  let at = 0;
  while (out.length < count) {
    const nl = buf.indexOf(0x0a, at);
    if (nl < 0) return { why: 'git cat-file output ends early' };
    const head = buf.subarray(at, nl).toString('utf8').split(' ');
    if (head.length !== 3) return { why: `git cat-file names an object it cannot read (${head.join(' ').slice(0, 80)})` };
    const size = Number(head[2]);
    if (!Number.isSafeInteger(size) || size < 0 || nl + 1 + size + 1 > buf.length) return { why: 'git cat-file output is cut' };
    out.push({ oid: head[0], type: head[1], data: buf.subarray(nl + 1, nl + 1 + size) });
    at = nl + 1 + size + 1;
  }
  return { objects: out };
}

/** The git object id of a blob holding `data`, in the repository's object format. */
const blobId = (format, data) => crypto.createHash(format === 'sha256' ? 'sha256' : 'sha1').update(`blob ${data.length}\0`).update(data).digest('hex');

/** Every path below `dir` that is not a folder, with forward slashes. */
function listFiles(dir, rel = '', out = []) {
  for (const d of fs.readdirSync(path.join(dir, rel), { withFileTypes: true })) {
    const r = rel ? `${rel}/${d.name}` : d.name;
    if (d.isDirectory()) listFiles(dir, r, out); else out.push(r);
  }
  return out;
}

/** Makes the parents of `file` below `root`, each a real folder (never through a link). Throws on anything else. */
function makeParents(root, rel) {
  let at = root;
  for (const c of rel.split('/').slice(0, -1)) {
    at = path.join(at, c);
    let st = null;
    try { st = fs.lstatSync(at); } catch { /* new */ }
    if (st === null) fs.mkdirSync(at, { mode: 0o755 });
    else if (!st.isDirectory()) throw new Error(`${rel}: a parent is not a folder`);
  }
}

/**
 * Writes commit `rev` (a full object id) of the repository `repo` into `out` (a new folder, or an empty one). Resolves {ok: true, rev,
 * paths} or {ok: false, why}; on a refusal the folder's contents are removed again.
 */
export function writeCommitTree({ repo, rev, out }) {
  const refuse = (why) => ({ ok: false, why });
  const format = git(repo, ['rev-parse', '--show-object-format']);
  if (format.why) return refuse(`${repo} is not a git repository (${format.why})`);
  const fmt = format.out.toString('utf8').trim();
  const commit = git(repo, ['cat-file', '-t', '--end-of-options', rev]);
  if (commit.why || commit.out.toString('utf8').trim() !== 'commit') return refuse(`${rev} names no commit of ${repo}`);
  const ls = git(repo, ['ls-tree', '-r', '-z', '--full-tree', '--end-of-options', rev]);
  if (ls.why) return refuse(`the tree of ${rev} cannot be listed (${ls.why})`);
  const items = [];
  for (const rec of ls.out.toString('utf8').split('\0').filter(Boolean)) {
    const m = /^(\d{6}) (\w+) ([0-9a-f]{40,64})\t(.+)$/s.exec(rec);
    if (!m) return refuse(`git ls-tree printed a line it should not (${rec.slice(0, 80)})`);
    const [, mode, type, oid, p] = m;
    if (!MODES[mode]) return refuse(`${p}: mode ${mode} (${type}) is not a file or a link; the base tree holds files and links only`);
    const bad = pathProblem(p);
    if (bad) return refuse(`${JSON.stringify(p.slice(0, 200))}: ${bad}`);
    if (MODES[mode] === 'link' && /^\.github(?:\/|$)/i.test(p)) {
      return refuse(`${JSON.stringify(p.slice(0, 200))}: a link under .github (the workflows' folder holds files only)`);
    }
    items.push({ mode: MODES[mode], oid, path: p });
  }
  let st = null;
  try { st = fs.lstatSync(out); } catch { /* new */ }
  if (st !== null && (!st.isDirectory() || fs.readdirSync(out).length > 0)) return refuse(`${out} is not empty: write into a new or an empty folder`);
  const batch = git(repo, ['cat-file', '--batch'], items.map(i => i.oid).join('\n') + (items.length ? '\n' : ''));
  if (batch.why) return refuse(`the objects of ${rev} cannot be read (${batch.why})`);
  const parsed = parseBatch(batch.out, items.length);
  if (parsed.why) return refuse(parsed.why);
  if (st === null) fs.mkdirSync(out, { mode: 0o700 });
  try {
    for (const [n, it] of items.entries()) {
      const o = parsed.objects[n];
      if (o.oid !== it.oid || o.type !== 'blob') throw new Error(`${it.path}: git cat-file answered another object`);
      makeParents(out, it.path);
      const f = path.join(out, ...it.path.split('/'));
      if (it.mode === 'link') fs.symlinkSync(o.data, f);
      else fs.writeFileSync(f, o.data, { flag: 'wx', mode: it.mode === 'exec' ? 0o755 : 0o644 });
    }
    // The check: exactly the tree's paths, each the object the tree names, with its mode.
    const want = new Map(items.map(i => [i.path, i]));
    const have = listFiles(out);
    if (have.length !== items.length || have.some(p => !want.has(p))) throw new Error(`the folder holds ${have.length} paths, the tree ${items.length}`);
    for (const p of have) {
      const it = want.get(p), f = path.join(out, ...p.split('/'));
      const ls2 = fs.lstatSync(f);
      const kind = ls2.isSymbolicLink() ? 'link' : ls2.isFile() ? (ls2.mode & 0o111 ? 'exec' : 'file') : 'other';
      const data = kind === 'link' ? fs.readlinkSync(f, { encoding: 'buffer' }) : fs.readFileSync(f);
      if (kind !== it.mode || blobId(fmt, data) !== it.oid) throw new Error(`${p}: written as another object or mode than the tree names`);
    }
  } catch (e) {
    for (const n of fs.readdirSync(out)) fs.rmSync(path.join(out, n), { recursive: true, force: true });
    return refuse(e?.message ?? 'the tree could not be written');
  }
  return { ok: true, rev, paths: items.length };
}
