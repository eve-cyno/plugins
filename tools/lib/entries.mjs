// Entries of the index repository: reading entries/*.json, and the checks C1 (shape), C2 (id), C8 (version rules) and C9 (mirror
// name), plus the mapping to the source format of the vendored index-build.mjs. Every rule the client has comes from the vendored
// host modules (vendor/eve-cyno-host/host/dist); this file copies none of them.
// A check returns problems: [{check, file?, message}]; an empty list passes. No check throws on hostile input.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import Ajv2020 from 'ajv/dist/2020.js';
import semver from 'semver';
import { sameEntry as sameValue } from './diff.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const DIST = path.join(ROOT, 'vendor', 'eve-cyno-host', 'host', 'dist');
const require = createRequire(import.meta.url);
const I = require(path.join(DIST, 'market', 'indexformat.js'));
const M = require(path.join(DIST, 'manifest.js'));
const Z = require(path.join(DIST, 'market', 'zipread.js'));

export const MARKET_URL_PREFIX = I.MARKET_URL_PREFIX;

const ajv = new Ajv2020({ allErrors: true, strict: true });
const validateShape = ajv.compile(JSON.parse(fs.readFileSync(path.join(ROOT, 'schemas', 'entry.v1.json'), 'utf8')));

const isObj = (v) => typeof v === 'object' && v !== null && !Array.isArray(v);
const prob = (check, message, file) => ({ check, ...(file === undefined ? {} : { file }), message });
const pick = (o, keys) => Object.fromEntries(keys.filter(k => Object.hasOwn(o, k)).map(k => [k, o[k]]));
const label = (e) => (isObj(e) && typeof e.id === 'string' ? e.id.slice(0, 100) : 'entry');
const shortSha = (s) => (typeof s === 'string' ? s.slice(0, 12) : String(s));

/** The mirror URL of an archive: prefix + 'archives/' + sha256 + '.zip' (M1, C9). */
export const mirrorUrl = (sha256) => `${MARKET_URL_PREFIX}archives/${sha256}.zip`;

/** C9: null when `url` is exactly the mirror URL of `sha256`, else the reason. */
export function checkMirrorName(url, sha256) {
  return url === mirrorUrl(sha256) ? null : `the archive URL is not the mirror name ${mirrorUrl(sha256)} (it is ${typeof url === 'string' ? JSON.stringify(url.slice(0, 200)) : typeof url})`;
}

/** C9 over a catalog-shaped {plugins: [...]}: every version's archive URL is the mirror name of its own SHA-256. */
export function checkCatalogMirrors(catalog) {
  const out = [];
  for (const l of Array.isArray(catalog?.plugins) ? catalog.plugins : []) {
    for (const v of Array.isArray(l?.versions) ? l.versions : []) {
      const why = checkMirrorName(v?.archive?.url, v?.archive?.sha256);
      if (why) out.push(prob('C9', `${label(l)} ${v?.version}: ${why}`));
    }
  }
  return out;
}

/** Whether a version is listed: a merged version marked `"unlisted": true` stays in its entry, pinned, but out of the catalog. */
export const isListed = (v) => v?.unlisted !== true;

/** The listing of an entry with `versions`: the host's fields only, each archive at its mirror URL. */
function listingOf(entry, versions) {
  return {
    ...pick(entry, ['id', 'type', 'name', 'author', 'firstParty', 'summary', 'description', 'categories', 'source']),
    versions: versions.map(v => ({
      ...pick(v, ['version', 'released', 'changes']),
      archive: { url: mirrorUrl(v.sha256), sha256: v.sha256, size: v.size },
      ...(entry.type === 'plugin' ? pick(v, ['engines', 'permissions']) : {}),
    })),
  };
}

/** The catalog listing of an entry: its listed versions (never an unlisted one). Needs a shape-valid entry. */
export const toListing = (entry) => listingOf(entry, entry.versions.filter(isListed));

const stamp = (ms) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');

/**
 * The host's read-back of the entry: its listed versions as one listing (the app's limits, 50 versions at most), and each unlisted
 * version as a listing of its own, so a version keeps the app's shape after it is unlisted. An entry with no listed version is read
 * through its unlisted ones only.
 */
function hostProblems(entry) {
  const listed = entry.versions.filter(isListed);
  const groups = [...(listed.length > 0 ? [listed] : []), ...entry.versions.filter(v => !isListed(v)).map(v => [v])];
  for (const versions of groups) {
    const out = listingProblems(listingOf(entry, versions));
    if (out.length > 0) return out;
  }
  return [];
}

/** One listing through listingProblem, then parseCatalog (nothing dropped, categories and order unchanged). */
function listingProblems(listing) {
  const out = [];
  const why = I.listingProblem(listing, MARKET_URL_PREFIX);
  if (why) return [prob('C1', `host listingProblem: the app drops this listing (${why})`)];
  try {
    const generated = stamp(Date.now());
    const catBytes = Buffer.from(JSON.stringify({ schema: 1, generated, plugins: [listing], revoked: [] }), 'utf8');
    const sha = crypto.createHash('sha256').update(catBytes).digest('hex');
    const headBytes = Buffer.from(JSON.stringify({
      schema: 1, generated, expires: stamp(Date.now() + 86_400_000),
      catalog: { url: `${MARKET_URL_PREFIX}catalog/${sha}.json`, sha256: sha, size: catBytes.length },
    }), 'utf8');
    const head = I.parseIndexHead(headBytes, MARKET_URL_PREFIX);
    const parsed = I.parseCatalog(catBytes, head, { prefix: MARKET_URL_PREFIX });
    if (parsed.dropped !== 0 || parsed.plugins.length !== 1) return [prob('C1', 'host parseCatalog: the app would drop this listing')];
    const p = parsed.plugins[0];
    if (JSON.stringify(p.categories) !== JSON.stringify(listing.categories)) out.push(prob('C1', `host parseCatalog: an unknown category (the app removes it); known: ${I.CATEGORIES.join(', ')}`));
    if (JSON.stringify(p.versions.map(v => v.version)) !== JSON.stringify(listing.versions.map(v => v.version))) out.push(prob('C1', 'host parseCatalog: the versions are not newest first'));
  } catch (e) {
    out.push(prob('C1', `host parseCatalog: ${e?.message ?? 'refused'}`));
  }
  return out;
}

/** C1: the entry's shape. The schema covers this repository's own fields; the host covers every listing field. */
export function checkEntry(entry) {
  if (!isObj(entry)) return [prob('C1', 'the entry is not a JSON object')];
  if (!validateShape(entry)) {
    return validateShape.errors.map(e => prob('C1', `schema: ${e.instancePath || '/'} ${e.message}${e.params?.additionalProperty ? ` (${e.params.additionalProperty})` : ''}`));
  }
  const out = [];
  for (const v of entry.versions) {
    const why = urlProblem(v.url);
    if (why) out.push(prob('C1', `${label(entry)} ${String(v.version).slice(0, 60)}: url ${why}`));
  }
  return out.length ? out : hostProblems(entry);
}

/** The author's archive URL: canonical form (what the URL parser gives back), https, no userinfo, query or fragment, at most 2,048 characters. */
function urlProblem(u) {
  if (typeof u !== 'string' || u.length > 2048) return 'is not a string of at most 2048 characters';
  let x;
  try { x = new URL(u); } catch { return 'is not a URL'; }
  if (x.protocol !== 'https:') return 'is not https:';
  if (x.href !== u) return 'is not in canonical form';
  if (x.username || x.password) return 'has userinfo';
  if (x.search || x.hash || u.includes('?') || u.includes('#')) return 'has a query or fragment';
  return null;
}

/**
 * C2 over entries [{file, entry}]: the file name is `<id>.json`, the id is a plugin id, not the host's prefix, not a Windows device
 * name, and unique across all entries.
 */
export function checkIds(files) {
  const out = [];
  const seen = new Map();
  for (const { file, entry } of files) {
    const id = isObj(entry) ? entry.id : undefined;
    if (typeof id !== 'string') { out.push(prob('C2', 'the id is not a string', file)); continue; }
    if (file !== `${id}.json`) out.push(prob('C2', `the file name must be "${id.slice(0, 100)}.json" (the id)`, file));
    if (!M.isPluginId(id)) out.push(prob('C2', 'the id is not a plugin id (lower-case dotted, 3 or more segments, at most 100 characters)', file));
    else {
      if (id.startsWith(M.HOST_ID_PREFIX)) out.push(prob('C2', `the id prefix ${M.HOST_ID_PREFIX} is reserved for the host`, file));
      if (Z.isDeviceNameId(id)) out.push(prob('C2', 'the first segment of the id is a Windows device name', file));
    }
    if (seen.has(id)) out.push(prob('C2', `duplicate id, also in ${seen.get(id)}`, file));
    else seen.set(id, file);
  }
  return out;
}

/**
 * C8: versions newest first and strictly increasing by semver; against `base` (the entry on the base branch, or null): a version
 * that is on the base stays in the entry (it is unlisted with `"unlisted": true`, never removed) exactly as it was merged, its url,
 * sha256, size, engines, permissions, released and changes, and stays unlisted once it is; adding `"unlisted": true` is the one change
 * allowed. An added version is listed and strictly above every base version, unlisted ones included. So a version number, once
 * merged, never comes back with other bytes, across any number of pull requests, and an unlisted version, whose archive no check reads
 * again, never claims other permissions than the ones it was reviewed with (C10 compares with it).
 */
export function checkVersionRules(head, base) {
  const out = [];
  const id = label(head);
  const versions = Array.isArray(head?.versions) ? head.versions : null;
  if (!versions) return [prob('C8', `${id}: no versions list`)];
  let prev = null;
  for (const v of versions) {
    const s = v?.version;
    if (typeof s !== 'string' || semver.valid(s) !== s) { out.push(prob('C8', `${id}: "${String(s).slice(0, 60)}" is not a semver version`)); prev = null; continue; }
    if (prev !== null && !semver.lt(s, prev)) out.push(prob('C8', `${id}: versions must be newest first and strictly decreasing down the list (${s} after ${prev})`));
    prev = s;
  }
  const baseVersions = Array.isArray(base?.versions) ? base.versions : [];
  const onBase = new Map(baseVersions.map(v => [v?.version, v]));
  const floor = baseVersions.map(v => v?.version).filter(s => typeof s === 'string' && semver.valid(s)).sort(semver.rcompare)[0];
  for (const v of versions) {
    const b = onBase.get(v?.version);
    if (b) {
      // Every field, by JSON value (a field left out equals one that is undefined), but `unlisted`, checked on its own below.
      for (const k of new Set([...Object.keys(b), ...Object.keys(v)])) {
        if (k !== 'unlisted' && !sameValue(v[k], b[k])) out.push(prob('C8', `${id} ${v.version}: ${k} of a merged version never changes (add a new version instead)`));
      }
      if (!isListed(b) && isListed(v)) out.push(prob('C8', `${id} ${v.version}: an unlisted version stays unlisted (add a new version instead)`));
      continue;
    }
    if (!isListed(v)) out.push(prob('C8', `${id} ${String(v?.version).slice(0, 60)}: an added version is listed ("unlisted" marks a merged version only)`));
    if (floor !== undefined && typeof v?.version === 'string' && semver.valid(v.version) && !semver.gt(v.version, floor)) {
      out.push(prob('C8', `${id} ${v.version}: an added version must be above every version already merged (${floor})`));
    }
  }
  const inHead = new Set(versions.map(v => v?.version));
  for (const b of baseVersions) {
    if (!inHead.has(b?.version)) out.push(prob('C8', `${id} ${String(b?.version).slice(0, 60)}: a merged version is never removed (set "unlisted": true; it stays pinned)`));
  }
  return out;
}

/**
 * Reads entries/*.json of `dir`: {entries: [{file, entry}] sorted by file name, problems}; nothing here throws. entries/ holds
 * `<id>.json` files and an empty `.gitkeep`, nothing else (C1): any other dotfile is refused, a `.gitattributes` above all, which would
 * change what git does with the entries (export-ignore, export-subst), and so is a folder at any depth.
 */
export function readEntries(dir) {
  const entries = [], problems = [];
  let names;
  try { names = fs.readdirSync(dir).sort(); } catch { return { entries, problems: [prob('C1', 'the entries folder cannot be read')] }; }
  for (const file of names) {
    const full = path.join(dir, file);
    let st;
    try { st = fs.lstatSync(full); } catch { problems.push(prob('C1', 'cannot be read', file)); continue; }
    if (file === '.gitkeep') {
      if (!st.isFile() || st.size !== 0) problems.push(prob('C1', '.gitkeep must be an empty regular file', file));
      continue;
    }
    if (file.startsWith('.')) { problems.push(prob('C1', 'entries/ holds <id>.json files and an empty .gitkeep only, no other dotfile', file)); continue; }
    if (!st.isFile()) { problems.push(prob('C1', 'not a regular file (a link or a folder): entries/ holds <id>.json files only, at its top level', file)); continue; }
    if (!file.endsWith('.json')) { problems.push(prob('C1', 'entries are .json files only', file)); continue; }
    let value;
    try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(fs.readFileSync(full))); } catch { problems.push(prob('C1', 'not JSON (UTF-8)', file)); continue; }
    if (!isObj(value)) { problems.push(prob('C1', 'the entry is not a JSON object', file)); continue; }
    entries.push({ file, entry: value });
  }
  return { entries, problems };
}

const revokes = (rev, id, version) => rev.some(r => r?.id === id && (r.versions === '*' || (Array.isArray(r.versions) && r.versions.includes(version))));

/**
 * The index-build.mjs source {plugins, revoked}: entries sorted by id, known listing fields only, `archive` from
 * archiveFile(id, version) (a path relative to the source file); unlisted versions and versions that `revoked` revokes are left out,
 * and so is a listing with none left (the app shows an installed revoked plugin from the revocation alone, R28). `revoked` is passed
 * on unchanged.
 */
export function toIndexSource(entries, revoked, archiveFile) {
  const plugins = [];
  for (const e of [...entries].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))) {
    const versions = e.versions.filter(v => isListed(v) && !revokes(revoked, e.id, v.version)).map(v => ({
      ...pick(v, ['version', 'released', 'changes']),
      archive: archiveFile(e.id, v.version),
      ...(e.type === 'plugin' ? pick(v, ['engines', 'permissions']) : {}),
    }));
    if (versions.length === 0) continue;
    plugins.push({ ...pick(e, ['id', 'type', 'name', 'author', 'firstParty', 'summary', 'description', 'categories', 'source']), versions });
  }
  return { plugins, revoked };
}
