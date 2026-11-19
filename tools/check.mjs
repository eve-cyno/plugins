#!/usr/bin/env node
// tools/check.mjs: every check of plan 3.2 (C1-C17) over a base tree and a head tree, with the vendored host code.
//
//   refuse  --base <dir> --head <dir> [--summary <file>] [--archive-cache <dir>]        check.yml, job checks
//     C1 entry shape and flags.json, C2 ids, C3 names (refusals), C4-C7 the archive of every version not on the base, C8 version
//     rules, C12 provenance (declared only), C15 revocations (the host's rules; an added one dated today or yesterday, UTC), C16 the
//     whole index built, signed with a throwaway key made in the run and verified by the vendored index-verify.mjs --key --archives,
//     C9 the mirror names of that catalog. Exit 1 on any FAIL.
//   review  --base <dir> --head <dir> [--author <login>] [--summary <file>] [--archive-cache <dir>]   check.yml, job review
//     The review classes: first-party (C3), escalation and identity (C10: the host's delta of requested permissions, background turned
//     on, or no lower version to compare with on a known id; name, author or type changed, the provenance repository changed or
//     dropped, the maintainers changed; the background flag and optional permissions read from each archive's plugin.json), new (C11),
//     maintenance (C13: anything changed but entries/<id>.json and revoked.json), multi-entry (C13: more than one entry file changed),
//     identity (C14: the author is not a maintainer of a base entry the pull request changes or removes), revocation and lift (C15),
//     revoked (C15: an added version of an id that revoked.json names, on the base or the head), engines (C17). Exit 3 with
//     NEEDS REVIEW <classes> when any is set.
//   publish --base <dir> --head <dir> --target production|test [--summary <file>] [--archive-cache <dir>]   publish.yml, job build
//     The refusals of `refuse` against the live base (tools/build-index.mjs base: catalog.json, or an empty tree for a first or a test
//     publish; with --repair true a verified candidate run's catalog and the union of revocations, recovery R2), C15 only "well-formed, not in the future" (UTC), C8 on SHA-256 and size (a catalog holds no author URL); the review
//     classes are printed as information.
// A base folder is a tree (entries/, revoked.json) or a base written by build-index.mjs base (catalog.json). Archives come from
// --archive-cache (<sha256>.zip; checked like a download, C5) or from the author's URL (C4), and are kept there. A version on the base
// (C16's whole index, C10's version before an added one) is read from the mirror first: --mirror-url <prefix> (default the production
// prefix, the test one for publish --target test; `none` for no mirror) archives/<sha256>.zip, used only when it is the pinned size and
// SHA-256, so a broken author link holds up no other pull request. An added version always comes from its author's URL (C4).
// Lines: PASS / FAIL / FLAG / NOTE (tools/lib/summary.mjs); the last line is CHECKS PASSED, CHECKS FAILED <n>, NEEDS REVIEW <classes>
// or NO REVIEW NEEDED. Exit 0 passed, 1 refused, 2 usage, 3 needs review.
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { createRequire } from 'node:module';
import semver from 'semver';
import { MARKET_URL_PREFIX, checkCatalogMirrors, checkEntry as entryProblems, checkIds, checkVersionRules, isListed, readEntries, toListing } from './lib/entries.mjs';
import { checkArchiveBytes } from './lib/archives.mjs';
import { checkEntry as diffEntry, checkNames, versionBefore } from './lib/diff.mjs';
import { checkProvenance } from './lib/provenance.mjs';
import { PREFIXES, ROOT, buildIndex, obtainArchive, prefixProblem, readJson, refusalLines, revKey, runVendored } from './lib/indexbuild.mjs';
import { createReport } from './lib/summary.mjs';
import { throwawaySigner } from './lib/throwaway.mjs';

const require = createRequire(import.meta.url);
const I = require(path.join(ROOT, 'vendor', 'eve-cyno-host', 'host', 'dist', 'market', 'indexformat.js'));
const USAGE = 'usage: node tools/check.mjs refuse|review|publish --base <dir> --head <dir> [--author <login>] [--target production|test] [--summary <file>] [--archive-cache <dir>] [--mirror-url <prefix>|none]';
const usage = (why) => { if (why) console.error(why); console.error(USAGE); process.exit(2); };

let a, mode;
try {
  const p = parseArgs({ args: process.argv.slice(2), strict: true, allowPositionals: true, options: Object.fromEntries(['base', 'head', 'author', 'target', 'summary', 'archive-cache', 'mirror-url'].map(k => [k, { type: 'string' }])) });
  a = p.values;
  mode = p.positionals[0];
  if (p.positionals.length !== 1 || !['refuse', 'review', 'publish'].includes(mode)) usage();
} catch (e) { usage(e.message); }
if (!a.base || !a.head) usage('--base and --head are needed');
if (a.author !== undefined && (mode !== 'review' || !/^[A-Za-z0-9-]{1,39}(\[bot\])?$/.test(a.author))) usage('--author: a GitHub login, review only');
if ((a.target !== undefined) !== (mode === 'publish') || (a.target !== undefined && !['production', 'test'].includes(a.target))) usage('--target production|test goes with publish only');
const mirror = a['mirror-url'] === 'none' ? null : (a['mirror-url'] ?? PREFIXES[a.target ?? 'production']);
if (mirror !== null && prefixProblem(mirror)) usage(`--mirror-url: ${prefixProblem(mirror)}`);

const R = createReport();
const isObj = (v) => typeof v === 'object' && v !== null && !Array.isArray(v);
const sha256 = (b) => crypto.createHash('sha256').update(b).digest('hex');
const stamp = (ms) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
const day = (ms) => new Date(ms).toISOString().slice(0, 10);
const NOW = Date.now();
const headDir = path.resolve(a.head), baseDir = path.resolve(a.base);
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'evecyno-check-'));
const cache = a['archive-cache'] ? path.resolve(a['archive-cache']) : path.join(work, 'cache');
fs.mkdirSync(cache, { recursive: true });

/** The listing the app holds for an entry (the vendored parseCatalog of toListing), or null. */
function hostListing(entry) {
  try {
    const generated = stamp(NOW);
    const cat = Buffer.from(JSON.stringify({ schema: 1, generated, plugins: [toListing(entry)], revoked: [] }));
    const c = I.parseCatalog(cat, { generated, catalog: { sha256: sha256(cat), size: cat.length } }, { prefix: MARKET_URL_PREFIX });
    return c.plugins.length === 1 ? c.plugins[0] : null;
  } catch { return null; }
}

/** The head tree: its valid entries (C1, C2), revoked.json and flags.json. */
function readHead(dir) {
  const read = readEntries(path.join(dir, 'entries'));
  for (const p of read.problems) R.fail(p.check, `entries/${p.file ?? ''}: ${p.message}`);
  const valid = [];
  for (const { file, entry } of read.entries) {
    const ps = entryProblems(entry);
    for (const p of ps) R.fail(p.check, `entries/${file}: ${p.message}`);
    if (ps.length === 0) valid.push(entry);
  }
  const ids = checkIds(read.entries);
  for (const p of ids) R.fail(p.check, `entries/${p.file}: ${p.message}`);
  if (read.problems.length === 0 && R.failed === 0) R.pass('C1 C2', `${valid.length} entries: shape, host listing rules and ids`);
  const rev = readJson(dir, 'revoked.json');
  if (!Array.isArray(rev.value)) R.fail('C15', `revoked.json: ${rev.why ?? (rev.missing ? 'missing' : 'not a JSON list')}`);
  const flags = readJson(dir, 'flags.json');
  if (!flags.missing && !(isObj(flags.value) && Object.keys(flags.value).length === 0)) R.fail('C1', 'flags.json must be {} (flags are reserved)');
  return { entries: valid.filter(e => !ids.some(p => p.file === `${e.id}.json`)), revoked: Array.isArray(rev.value) ? rev.value : [] };
}

/** The base: a tree (entries as written) or build-index.mjs base's catalog.json (listings as entries without author URLs). */
function readBase(dir) {
  const meta = readJson(dir, 'BASE.json');
  const cat = readJson(dir, 'catalog.json');
  if (!cat.missing) {
    if (!isObj(cat.value) || !Array.isArray(cat.value.plugins) || !Array.isArray(cat.value.revoked)) { R.fail('base', 'catalog.json is not a catalog'); return null; }
    const entries = cat.value.plugins.filter(l => isObj(l) && typeof l.id === 'string' && Array.isArray(l.versions)).map(l => ({
      id: l.id, type: l.type, name: l.name, author: l.author, firstParty: l.firstParty === true, maintainers: [],
      versions: l.versions.map(v => ({ version: v.version, sha256: v.archive?.sha256, size: v.archive?.size, engines: v.engines, permissions: v.permissions })),
    }));
    // A repair base (build-index.mjs base --repair true, recovery R2) is a verified candidate run's catalog, not the live one; its lifts
    // count against the union of every verified candidate's revocations, as the compare step counts them.
    const repair = meta.value?.kind === 'repair';
    if (repair && !Array.isArray(meta.value.union)) { R.fail('base', 'the repair base names no union of revocations'); return null; }
    R.note(`base: ${repair ? `the repair base (run ${meta.value.baseRun}'s verified catalog; its revocations: the union of ${meta.value.union.length})` : 'the live catalog'}${meta.value?.generated ? ` of the head generated ${meta.value.generated}` : ''} (${entries.length} listings)`);
    return { kind: 'catalog', entries: new Map(entries.map(e => [e.id, e])), revoked: repair ? meta.value.union : cat.value.revoked };
  }
  let st = null;
  try { st = fs.lstatSync(path.join(dir, 'entries')); } catch { /* checked below */ }
  if (!st?.isDirectory()) { R.fail('base', 'the base folder holds neither entries/ nor catalog.json'); return null; }
  const read = readEntries(path.join(dir, 'entries'));
  for (const p of read.problems) R.note(`base entries/${p.file ?? ''}: ${p.message} (left out of the base)`);
  const rev = readJson(dir, 'revoked.json');
  if (!rev.missing && !Array.isArray(rev.value)) { R.fail('base', `base revoked.json: ${rev.why ?? 'not a JSON list'}`); return null; }
  const entries = read.entries.map(x => x.entry).filter(e => typeof e.id === 'string' && Array.isArray(e.versions));
  return { kind: 'tree', entries: new Map(entries.map(e => [e.id, e])), revoked: rev.value ?? [] };
}

const onBase = (b, version) => (b?.versions ?? []).some(v => v?.version === version);
/** Whether a revocation of `base` names `version` of `id` (a list of versions, or "*"). */
const revokedOn = (base, id, version) => base.revoked.some(r => isObj(r) && r.id === id
  && (r.versions === '*' || (Array.isArray(r.versions) && r.versions.includes(version))));

// ---- C4-C7, C12: the archive of every listed version not on the base ----------------------------------------------------------------------
async function checkArchives(head, base) {
  for (const e of head.entries) {
    // An unlisted version is not published (C8 refuses one added unlisted, so it was checked when it was added).
    const todo = e.versions.filter(v => isListed(v) && !onBase(base.entries.get(e.id), v.version));
    if (todo.length === 0) continue;
    const l = hostListing(e);
    if (!l) { R.fail('C1', `${e.id}: the app does not read the listing`); continue; }
    for (const v of todo) {
      const at = `${e.id} ${v.version}`;
      const lv = l.versions.find(x => x.version === v.version);
      const got = await obtainArchive(v, { cache });
      if (!got.ok) { R.fail('C4', `${at}: ${got.why}`); continue; }
      const c = checkArchiveBytes(got.bytes, l, lv, { tmpdir: work });
      if (!c.ok) { R.fail(c.check, `${at}: ${c.why}`); continue; }
      R.pass('C4-C7', `${at}: ${v.size} bytes, SHA-256 as pinned, the app's reader and staged checks pass`);
      if (e.provenance === undefined) continue;
      const p = await checkProvenance({ entry: e, archive: path.join(cache, `${v.sha256}.zip`), sha256: v.sha256 });
      if (p.problem) R.fail('C12', `${at}: ${p.problem}`);
      else R.pass('C12', `${at}: ${p.attestations} attestation(s) bound to ${e.provenance.repo}`);
    }
  }
}

// ---- C3, C8 -----------------------------------------------------------------------------------------------------------------------------
function checkRules(head, base) {
  const before = R.failed;
  for (const e of head.entries) {
    let b = base.entries.get(e.id) ?? null;
    // A live catalog names no author URL: C8 holds a live version to its SHA-256 and size (plan 4.2). It also leaves out the versions
    // its revocations name and the unlisted ones, and an entry with no version left; such a head version was merged before, so C8
    // counts it as on the base with its own pins (the PR checks held it to C8 against the base tree; C4-C7 still check a revoked one
    // here, since the live catalog does not list it).
    if (base.kind === 'catalog') {
      const live = (b?.versions ?? []).map(v => ({ ...v, url: e.versions.find(x => x.version === v.version)?.url }));
      const kept = e.versions.filter(v => !onBase(b, v.version) && (revokedOn(base, e.id, v.version) || !isListed(v)))
        .map(v => ({ version: v.version, url: v.url, sha256: v.sha256, size: v.size, ...(isListed(v) ? {} : { unlisted: true }) }));
      if (b || kept.length > 0) b = { ...(b ?? { id: e.id }), versions: [...live, ...kept] };
    }
    for (const p of checkVersionRules(e, b)) R.fail(p.check, p.message);
    for (const why of checkNames(e, base.entries.get(e.id) ?? null, head.entries)) R.fail('C3', why.replace(/^C3 /, ''));
  }
  // A merged entry is never removed (its versions are unlisted instead), so its id never comes back with other bytes under old versions.
  for (const id of base.entries.keys()) {
    if (!head.entries.some(e => e.id === id)) R.fail('C8', `${id}: a merged entry is never removed (set "unlisted": true on its versions)`);
  }
  if (R.failed === before) R.pass('C3 C8', 'names, authors and version rules against the base');
}

// ---- C15 --------------------------------------------------------------------------------------------------------------------------------
function checkRevocations(head, base) {
  const before = R.failed;
  try {
    const generated = stamp(NOW);
    const cat = Buffer.from(JSON.stringify({ schema: 1, generated, plugins: [], revoked: head.revoked }));
    I.parseCatalog(cat, { generated, catalog: { sha256: sha256(cat), size: cat.length } }, { prefix: MARKET_URL_PREFIX });
  } catch (e) { R.fail('C15', `revoked.json: the app refuses the whole index for it (${e?.message ?? 'bad_index'})`); return; }
  const was = new Map(base.revoked.filter(isObj).map(r => [revKey(r), JSON.stringify(r)]));
  const today = day(NOW), yesterday = day(NOW - 86_400_000);
  for (const r of head.revoked) {
    const added = was.get(revKey(r)) !== JSON.stringify(r);
    if (r.date > today) R.fail('C15', `${revKey(r)}: dated ${r.date}, in the future (UTC)`);
    else if (mode === 'refuse' && added && r.date !== today && r.date !== yesterday) R.fail('C15', `${revKey(r)}: an added revocation is dated today or yesterday (UTC), not ${r.date}`);
  }
  if (R.failed === before) R.pass('C15', `${head.revoked.length} revocations: the host's rules${mode === 'refuse' ? ', added ones dated today or yesterday (UTC)' : ', none in the future (UTC)'}`);
}
function revocationFlags(head, base) {
  const now = new Map(head.revoked.filter(isObj).map(r => [revKey(r), JSON.stringify(r)]));
  const was = new Map(base.revoked.filter(isObj).map(r => [revKey(r), JSON.stringify(r)]));
  for (const [k, j] of now) if (was.get(k) !== j) R.flag('revocation', 'C15', `${was.has(k) ? 'changed' : 'added'}: ${k}`);
  for (const k of was.keys()) if (!now.has(k)) R.flag('lift', 'C15', `removed: ${k} (publish.yml needs it in its lift input)`);
}

// ---- C16, C9 ----------------------------------------------------------------------------------------------------------------------------
async function checkWholeIndex() {
  const out = path.join(work, 'c16', 'index');
  const b = await buildIndex({ tree: headDir, prefix: MARKET_URL_PREFIX, out, cache, mirror });
  if (!b.ok) { R.fail('C16', `the index does not build: ${b.why}`); return; }
  const signer = throwawaySigner();
  const pub = path.join(work, 'c16', 'throwaway.pub');
  fs.writeFileSync(pub, signer.pubText);
  fs.writeFileSync(path.join(out, 'index.json.minisig'), signer.sign(b.headBytes, I.indexComment(b.head.generated)));
  const v = await runVendored('index-verify.mjs', [out, '--key', pub, '--archives']);
  if (v.code !== 0) { for (const l of refusalLines(v)) R.fail('C16', `index-verify.mjs: ${l}`); if (refusalLines(v).length === 0) R.fail('C16', `index-verify.mjs exit ${v.code}`); return; }
  R.pass('C16', `the whole index builds, signs with a throwaway key and verifies with index-verify.mjs --key --archives (${b.archives.length} archives)`);
  const mirrors = checkCatalogMirrors(JSON.parse(b.catalogBytes.toString('utf8')));
  for (const p of mirrors) R.fail(p.check, p.message);
  if (mirrors.length === 0) R.pass('C9', 'every archive URL is its mirror name (archives/<sha256>.zip)');
}

// ---- review classes ---------------------------------------------------------------------------------------------------------------------
/**
 * The background flag and optional permissions of a version's plugin.json, read from its archive after the C5-C7 checks, or null.
 * `live`: the version is on the base, so the mirror is read before its author's URL. An unlisted version (the version before an added
 * one when no lower one is listed) is read as a listing of its own, as the app reads one back (entries.mjs): the entry's listing leaves
 * it out.
 */
async function manifestOf(entry, v, live) {
  const { unlisted: _, ...asListed } = v;
  const l = hostListing(isListed(v) ? entry : { ...entry, versions: [asListed] });
  const lv = l?.versions.find(x => x.version === v.version);
  if (!lv || typeof v.url !== 'string') return null;
  const got = await obtainArchive(v, { cache, mirror: live ? mirror : null });
  if (!got.ok) return null;
  const c = checkArchiveBytes(got.bytes, l, lv, { tmpdir: work });
  return c.ok ? c.manifest : null;
}
async function entryFlags(head, base) {
  for (const e of head.entries) {
    const b = base.entries.get(e.id) ?? null;
    let he = e, be = b;
    if (e.type === 'plugin') {
      // C10 reads `background` and optional permissions from the archives of each added version and of the version before it
      // (diff.mjs versionBefore: the greatest lower listed one, else the greatest lower one on the base; the head says which are unlisted).
      const need = new Set();
      for (const v of e.versions) {
        if (onBase(b, v.version) || !isListed(v) || !semver.valid(v.version)) continue; // an unlisted version is never added (C8)
        need.add(v.version);
        let prev = null;
        try { prev = versionBefore(v, e, b); } catch { /* a version that is not semver: diffEntry below throws too and flags escalation */ }
        if (prev) need.add(prev.version);
      }
      const read = new Map();
      for (const ver of need) {
        const hv = e.versions.find(x => x.version === ver);
        const m = hv ? await manifestOf(e, hv, onBase(b, ver)) : (b && base.kind === 'tree' ? await manifestOf(b, b.versions.find(x => x.version === ver), true) : null);
        if (m === null) R.flag('escalation', 'C10', `${e.id} ${ver}: its plugin.json could not be read to compare background and optional permissions`);
        read.set(ver, m);
      }
      const deco = (v) => {
        const m = read.get(v?.version);
        return m ? { ...v, background: m.background === true, ...(m.optionalPermissions ? { optionalPermissions: m.optionalPermissions } : {}) } : v;
      };
      he = { ...e, versions: e.versions.map(deco) };
      be = b ? { ...b, versions: b.versions.map(deco) } : null;
    }
    // A catalog names no maintainers (nor provenance): against one they are not compared (the pull request's review compared them).
    if (be && base.kind === 'catalog') be = { ...be, maintainers: e.maintainers };
    let r;
    try { r = diffEntry(he, be, { others: head.entries, prAuthor: a.author ?? null, revoked: [...base.revoked, ...head.revoked] }); } catch (err) {
      R.flag('escalation', 'C10', `${e.id}: the permissions could not be compared (${err?.message ?? 'error'})`);
      continue;
    }
    const why = {
      new: 'a new entry (no entry of this id on the base)',
      escalation: 'a new version asks for more than the version before it, turns background on, or has no lower version to compare with',
      identity: 'the name, author or type changed, the provenance repository changed or was dropped, the maintainers changed, or the pull request changes the entry and its author is not a maintainer of the base entry',
      'first-party': 'firstParty set or changed',
      engines: 'a new version\'s engines admit no host API major that a released host supports',
      revoked: 'a new version of an id that revoked.json names (on the base or the head)',
    };
    for (const f of r.flags) R.flag(f, { new: 'C11', escalation: 'C10', identity: 'C10 C14', 'first-party': 'C3', engines: 'C17', revoked: 'C15' }[f], `${e.id}: ${why[f]}`);
  }
  for (const [id, b] of base.entries) {
    if (head.entries.some(e => e.id === id)) continue;
    if (a.author && !(b.maintainers ?? []).some(m => typeof m === 'string' && m.toLowerCase() === a.author.toLowerCase())) R.flag('identity', 'C14', `${id}: the entry is removed by a login that is not one of its maintainers`);
  }
}

/** C13: every path other than entries/<id>.json and revoked.json whose content, type or mode differs between the two trees. */
function treeFiles(dir) {
  const out = new Map();
  const add = (rel) => {
    const f = path.join(dir, rel);
    let st;
    try { st = fs.lstatSync(f); } catch { out.set(rel, 'missing'); return; }
    if (st.isSymbolicLink()) out.set(rel, `link ${fs.readlinkSync(f)}`);
    else if (st.isFile()) out.set(rel, `file ${st.mode & 0o111 ? 'x' : '-'} ${sha256(fs.readFileSync(f))}`);
    else out.set(rel, 'other');
  };
  if (fs.existsSync(path.join(dir, '.git'))) {
    // a checkout: the files of its commit, not what npm ci or a build added beside them
    for (const rel of execFileSync('git', ['-C', dir, 'ls-files', '-z'], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 }).split('\0').filter(Boolean)) add(rel);
    return out;
  }
  const walk = (rel) => {
    for (const d of fs.readdirSync(path.join(dir, rel), { withFileTypes: true })) {
      const r = rel ? `${rel}/${d.name}` : d.name;
      if (d.isDirectory()) walk(r); else add(r);
    }
  };
  walk('');
  return out;
}
function scopeFlag() {
  // An entry file sits at the top of entries/ and is no dotfile; anything else there (.gitattributes, .gitkeep, a folder) is maintenance.
  const inScope = (p) => /^entries\/[^/.][^/]*\.json$/.test(p) || p === 'revoked.json';
  const h = treeFiles(headDir), b = treeFiles(baseDir);
  const all = [...new Set([...h.keys(), ...b.keys()])].filter(p => h.get(p) !== b.get(p)).sort();
  const changed = all.filter(p => !inScope(p));
  if (changed.length > 0) R.flag('maintenance', 'C13', `${changed.length} path(s) outside entries/<id>.json and revoked.json: ${changed.slice(0, 10).join(', ')}${changed.length > 10 ? ', ...' : ''}`);
  else R.pass('C13', 'only entries/<id>.json and revoked.json change');
  // One entry file per pull request (CONTRIBUTING.md): more is not refused, but read by a maintainer.
  const entryFiles = all.filter(p => inScope(p) && p !== 'revoked.json');
  if (entryFiles.length > 1) R.flag('multi-entry', 'C13', `${entryFiles.length} entry files change: ${entryFiles.slice(0, 10).join(', ')}${entryFiles.length > 10 ? ', ...' : ''} (one entry file per pull request)`);
}

// ---- run --------------------------------------------------------------------------------------------------------------------------------
let code = 0, verdict;
try {
  R.note(`archives: the cache, then ${mirror ? `the mirror ${mirror}archives/<sha256>.zip for a version on the base (the pinned size and SHA-256 only), then the author's URL` : "the author's URL (no mirror)"}`);
  const head = readHead(headDir);
  const base = readBase(baseDir);
  if (base) {
    if (mode === 'review') {
      if (base.kind === 'tree') scopeFlag(); else R.note('C13: the base is a catalog, not a tree: no scope check');
      if (!a.author) R.note('C14: no --author: the maintainer check is not run');
      await entryFlags(head, base);
      revocationFlags(head, base);
    } else {
      checkRules(head, base);
      checkRevocations(head, base);
      await checkArchives(head, base);
      if (R.failed === 0) await checkWholeIndex();
      else R.note('C16 and C9 are not run: an earlier check refused');
      if (mode === 'publish') { await entryFlags(head, base); revocationFlags(head, base); }
    }
  }
  if (R.failed > 0) { code = 1; verdict = `CHECKS FAILED ${R.failed}`; }
  else if (mode === 'review') { code = R.classes.length ? 3 : 0; verdict = R.classes.length ? `NEEDS REVIEW ${R.classes.join(' ')}` : 'NO REVIEW NEEDED'; }
  else {
    if (mode === 'publish' && R.classes.length) R.note(`review classes (information: the owner merged after review): ${R.classes.join(' ')}`);
    verdict = 'CHECKS PASSED';
  }
} catch (e) {
  R.fail('check', `the check itself failed (${e?.message ?? 'error'}): nothing passed`);
  code = 1;
  verdict = `CHECKS FAILED ${R.failed}`;
} finally {
  fs.rmSync(work, { recursive: true, force: true });
}
R.finish(verdict, { title: `tools/check.mjs ${mode}`, file: a.summary });
process.exit(code);
