#!/usr/bin/env node
// Builds a plugin index folder (R20-R23):
//   node scripts/index-build.mjs <src.json> <out-dir> [--lifetime-days <n>] [--prefix <URL>] [--key <pub file>...]
//   node scripts/index-build.mjs --resign <signed index folder> <out-dir> [--lifetime-days <n>] [--test-key | --key <pub file>...] [--prefix <URL>]
//   node scripts/index-build.mjs --head-from <unsigned folder> [--lifetime-days <n>] [--prefix <URL>] [--key <pub file>...]
// Build:
// - <src.json> holds {plugins: [...], revoked: [...], flags?: {...}} (docs/release-checklist.md, "The plugin index"). Each listing
//   version names its archive as a local .zip file, relative to the folder of <src.json>. Only the known fields are taken over.
// - It writes, in <out-dir> (a new folder; by convention under release-index/, which git ignores):
//     archives/<sha256>.zip    a copy of each archive, named by its SHA-256 (content-addressed, so immutable);
//     catalog/<sha256>.json    the catalog, named by its own SHA-256;
//     index.json               the head: generated now, expires --lifetime-days later (default 60, D36; at most 90, what the app
//                              accepts), naming the catalog by URL, size and SHA-256.
//   Every URL is under https://plugins.eve-cyno.dev/v1/ (MARKET_URL_PREFIX).
// - The head and the catalog are parsed back with the app's own parser (host/dist) before anything is kept: what this writes is what
//   the app accepts, with no listing dropped, no type ignored, no category removed and the versions newest first.
// Re-sign (before the head expires, checklist step 7):
// - It verifies the signed folder's head first: its signature with the index keys only (the pinned product keys, or with --test-key the
//   committed TEST index key), the parser and the trusted comment. Then it reads the one catalog file that head names (no other catalog
//   file) and checks its size and SHA-256 against it, the catalog parser (no listing dropped), and each archive the catalog names.
// - <out-dir> gets the same catalog and archives (written from the verified bytes, the archives copied and hashed again) and a new
//   head: generated now, expires --lifetime-days later, the same catalog URL, size and SHA-256 and the same flags. Only the new
//   head and its signature are uploaded.
// - With --test-key, <out-dir> also gets TEST-KEY-ONLY.txt (TEST_KEY_MARKER, written first): its catalog and archives were checked
//   against a head signed with the TEST key only (its secret is public), so release-sign.sh refuses to have that folder's head signed
//   with the product keys, and the signing and verify commands printed for it carry --test-key.
// Head from (DP3 1.D; the publishing workflow of eve-cyno/plugins, whose build-index.mjs writes the catalog):
// - <unsigned folder> holds catalog/<sha256>.json, its only catalog file, named by its SHA-256 (archives/ is optional: it is not read).
//   It gets index.json, in place: generated now, expires --lifetime-days later, naming that catalog by URL, size and SHA-256, no
//   flags. Nothing else in the folder changes.
// - It refuses (nothing written) a folder that holds a signature (*.minisig) or a head already, a catalog the app would refuse, drop a
//   listing of, ignore a listing of, change a listing of or drop by its admission (index-verify.mjs check 4, release-lib.mjs
//   catalogProblems), and a catalog generated after now (the app refuses a catalog newer than its head).
// Every form also takes (DP3 1.D: a test location or a private source; the app reads only the product prefix with the product keys):
// - --prefix <canonical folder URL>: every URL of the index is under that folder instead of MARKET_URL_PREFIX (https; http only on
//   127.0.0.1, a local test server); the upload keys follow its path.
// - --key <pub file> (once or twice: a primary and a standby; never a release key): the index is for those keys. --resign verifies the
//   signed head with them (not with --test-key). The folder written gets CUSTOM-KEY-ONLY.txt first (release-lib.mjs
//   CUSTOM_KEY_MARKER), so release-sign.sh refuses to have its head signed.
// Each form prints the signing step (for the product prefix and keys the release-sign.sh command with purpose index, the manual fallback
// of the publishing workflow of eve-cyno/plugins; otherwise the trusted comment to sign with that key), the verify command and the
// upload commands in their order, each path relative to the repository root and quoted for the shell. It never signs and never
// uploads; it reads no credential.
// Refuses (exit 1, nothing kept): an existing <out-dir>, one on another drive than this repository (Windows), a source the app would
// read otherwise, a missing or oversized archive, a signed folder that does not verify, a minisign secret key in the repository, the
// folders it reads or writes or this machine's minisign folders. Usage: exit 2.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { CUSTOM_KEY_MARKER, ROOT, TEST_KEY_MARKER, catalogProblems, customKeys, hashFile, loadHost, loadHostMarket, prefixProblem, refuseSecretKeys, relToRoot,
  shown, shq, writeCustomKeyMarker } from './release-lib.mjs';

const USAGE = 'usage: node scripts/index-build.mjs <src.json> <out-dir> [--lifetime-days <1-90>] [--prefix <URL>] [--key <pub file>...]\n'
  + '       node scripts/index-build.mjs --resign <signed index folder> <out-dir> [--lifetime-days <1-90>] [--test-key | --key <pub file>...] [--prefix <URL>]\n'
  + '       node scripts/index-build.mjs --head-from <unsigned folder> [--lifetime-days <1-90>] [--prefix <URL>] [--key <pub file>...]';
const usage = (why) => {
  if (why) console.error(why);
  console.error(USAGE);
  process.exit(2);
};
const args = process.argv.slice(2);
const pos = [];
let daysArg = null, resign = false, testKey = false, headFrom = false, prefixArg = null;
const keyArgs = [];
/** The value of the option at args[i] (the next word; never another option). */
const valueOf = (i) => (i + 1 < args.length && !args[i + 1].startsWith('--') ? args[i + 1] : usage(`${args[i]} needs a value`));
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === '--lifetime-days') { if (daysArg !== null || i + 1 >= args.length) usage(); daysArg = args[++i]; }
  else if (a === '--resign') { if (resign) usage(); resign = true; }
  else if (a === '--test-key') { if (testKey) usage(); testKey = true; }
  else if (a === '--head-from') { if (headFrom) usage(); headFrom = true; }
  else if (a === '--prefix') { if (prefixArg !== null) usage('--prefix is given once'); prefixArg = valueOf(i++); }
  else if (a === '--key') keyArgs.push(path.resolve(valueOf(i++)));
  else if (a.startsWith('--')) usage();
  else pos.push(a);
}
if (resign && headFrom) usage('--resign and --head-from: one or the other');
if (pos.length !== (headFrom ? 1 : 2)) usage();
if (testKey && !resign) usage('--test-key goes with --resign only (it verifies the signed head with the committed TEST index key)');
if (testKey && keyArgs.length > 0) usage('--test-key and --key: one or the other (--test-key is the committed TEST index key)');
if (prefixArg !== null && prefixProblem(prefixArg)) usage(`--prefix ${prefixArg}: ${prefixProblem(prefixArg)}`);
const { indexformat: I, minisign: S, trustkeys: T } = loadHost();
const custom = keyArgs.length > 0 ? customKeys(keyArgs, S, T) : null;
if (custom?.why) usage(custom.why);
const DAY_MS = 86_400_000, MAX_DAYS = I.MAX_INDEX_LIFETIME_MS / DAY_MS;
const days = daysArg === null ? I.DEFAULT_INDEX_LIFETIME_DAYS : /^[1-9][0-9]?$/.test(daysArg) ? Number(daysArg) : NaN;
if (!Number.isInteger(days) || days < 1 || days > MAX_DAYS) usage(`--lifetime-days: a whole number of days from 1 to ${MAX_DAYS} (the app accepts at most ${MAX_DAYS})`);

const fail = (msg) => { console.error(`REFUSED: ${msg}`); process.exit(1); };
const input = path.resolve(pos[0]), out = headFrom ? input : path.resolve(pos[1]);
const outRel = relToRoot(out);
if (outRel === null) fail(`${shown(out)}: the index folder must be on the drive of this repository (the printed commands name it from the repository root)`);
const keyRels = keyArgs.map(k => relToRoot(k));
for (const [i, r] of keyRels.entries()) if (r === null) fail(`--key ${shown(keyArgs[i])}: the key file must be on the drive of this repository (the printed commands name it from the repository root)`);
refuseSecretKeys([out, ...(resign ? [input] : [])]);
if (headFrom) {
  let st = null;
  try { st = fs.lstatSync(out); } catch { /* refused below */ }
  if (!st?.isDirectory()) fail(`${shown(out)}: not a folder (--head-from writes the head into the folder that holds the catalog)`);
} else if (fs.existsSync(out)) fail(`${shown(out)} exists: build into a new folder (a signature in it would no longer match)`);

const P = prefixArg ?? I.MARKET_URL_PREFIX;
const ids = custom ? custom.keys.map(k => k.keyId).join(' and ') : '';
if (P !== I.MARKET_URL_PREFIX) console.log(`NOTE --prefix: every URL of the index is under ${P}; the app reads only ${I.MARKET_URL_PREFIX}`);
if (custom) {
  console.log(`NOTE --key: this index is for the key${custom.keys.length > 1 ? 's' : ''} ${ids} only; the app trusts the product index keys alone.`);
  console.log(`  The folder gets ${CUSTOM_KEY_MARKER}: release-sign.sh refuses to have its head signed.`);
}
const J = JSON.stringify;
const isObj = (v) => typeof v === 'object' && v !== null && !Array.isArray(v);
/** JSON with sorted keys: the read-back compares content, not key order. */
const C = (v) => J(v, (_k, x) => (isObj(x) ? Object.fromEntries(Object.keys(x).sort().map(k => [k, x[k]])) : x));
const sha256 = (b) => crypto.createHash('sha256').update(b).digest('hex');
const pick = (o, keys) => Object.fromEntries(keys.filter(k => Object.hasOwn(o, k)).map(k => [k, o[k]]));
const nameOf = (l, i) => (typeof l?.id === 'string' && /^[a-z0-9.-]{1,100}$/.test(l.id) ? l.id : `plugins[${i}]`);
const stamp = (ms) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
const hashOr = async (file, where) => { try { return await hashFile(file); } catch { return fail(`${where}: cannot be read`); } };
/** A small file of a signed folder: a regular file of at most `max` bytes. */
function readCapped(file, max, where) {
  let st;
  try { st = fs.lstatSync(file); } catch { return fail(`${where}: missing`); }
  if (!st.isFile()) fail(`${where}: not a regular file (a link or a folder)`);
  if (st.size > max) fail(`${where}: larger than ${max} bytes`);
  try { return fs.readFileSync(file); } catch { return fail(`${where}: cannot be read`); }
}

// A plan: what goes into <out-dir>. archives: published path (archives/<name>) -> {file, sha256, size, where}.
/** From a source file: the catalog and a head built now. */
async function planBuild() {
  const srcDir = path.dirname(input);
  let src;
  try { src = JSON.parse(fs.readFileSync(input, 'utf8')); } catch { fail(`${shown(input)}: not a readable JSON file`); }
  if (!isObj(src) || !Array.isArray(src.plugins) || !Array.isArray(src.revoked)) fail(`${shown(input)}: needs a "plugins" and a "revoked" list`);
  // The catalog from the source's known fields; each archive hashed where it is (the copies are hashed again when written).
  const archives = new Map();
  const plugins = [];
  for (const [i, l] of src.plugins.entries()) {
    const id = nameOf(l, i);
    if (!isObj(l)) fail(`${id}: not an object`);
    if (l.type !== 'plugin' && l.type !== 'theme') fail(`the listing ${id} has an unknown type (the app ignores it): "plugin" or "theme"`);
    if (!Array.isArray(l.versions)) fail(`the listing ${id} has no "versions" list`);
    const versions = [];
    for (const [j, v] of l.versions.entries()) {
      if (!isObj(v) || typeof v.archive !== 'string' || !v.archive) fail(`${id} versions[${j}]: "archive" names no file`);
      if (l.type === 'theme' && (Object.hasOwn(v, 'engines') || Object.hasOwn(v, 'permissions'))) fail(`${id} versions[${j}]: a theme version has no "engines" or "permissions"`);
      const file = path.resolve(srcDir, v.archive), where = shown(file, srcDir);
      let st;
      try { st = fs.lstatSync(file); } catch { fail(`${id} versions[${j}]: ${where}: not found`); }
      if (!st.isFile()) fail(`${id} versions[${j}]: ${where}: not a regular file (a link or a folder)`);
      if (st.size < 1 || st.size > I.MAX_ARCHIVE_BYTES) fail(`${id} versions[${j}]: ${where}: ${st.size} bytes is outside 1..${I.MAX_ARCHIVE_BYTES}`);
      const h = await hashOr(file, `${id} versions[${j}]: ${where}`);
      const name = `archives/${h.sha256}.zip`;
      if (!archives.has(name)) archives.set(name, { file, sha256: h.sha256, size: h.size, where });
      versions.push({ ...pick(v, ['version', 'released', 'changes']), archive: { url: `${P}${name}`, sha256: h.sha256, size: h.size },
        ...(l.type === 'plugin' ? pick(v, ['engines', 'permissions']) : {}) });
    }
    plugins.push({ ...pick(l, ['id', 'type', 'name', 'author', 'firstParty', 'summary', 'description', 'categories', 'source']), versions });
  }
  const generated = stamp(Date.now());
  const expires = stamp(Date.parse(generated) + days * DAY_MS);
  const revoked = src.revoked.map(r => (isObj(r) ? pick(r, ['id', 'versions', 'reason', 'date']) : r)); // a malformed one: the parser refuses it below
  const catBytes = Buffer.from(J({ schema: 1, generated, plugins, revoked }, null, 2) + '\n', 'utf8');
  const catSha = sha256(catBytes);
  const head = { schema: 1, generated, expires, catalog: { url: `${P}catalog/${catSha}.json`, sha256: catSha, size: catBytes.length }, ...(src.flags !== undefined ? { flags: src.flags } : {}) };
  const headBytes = Buffer.from(J(head, null, 2) + '\n', 'utf8');
  // Read back with the app's own parser: nothing dropped, ignored, removed or reordered.
  for (const [i, l] of plugins.entries()) {
    const why = I.listingProblem(l, P);
    if (why) fail(`the app drops the listing ${nameOf(l, i)} (${why})`);
  }
  let parsedHead, parsed;
  try { parsedHead = I.parseIndexHead(headBytes, P); } catch (e) { fail(`the app would not accept this head (${e?.message ?? 'bad_index'})`); }
  try { parsed = I.parseCatalog(catBytes, parsedHead, { prefix: P }); } catch (e) { fail(`the app would not accept this catalog (${e?.message ?? 'bad_index'})`); }
  if (parsed.dropped !== 0 || parsed.plugins.length !== plugins.length) fail(`the app reads ${parsed.plugins.length} of ${plugins.length} listings`);
  for (const [i, l] of plugins.entries()) {
    const p = parsed.plugins[i], id = nameOf(l, i);
    if (J(p.categories) !== J(l.categories)) fail(`the listing ${id} has an unknown category (the app removes it): ${I.CATEGORIES.join(', ')}`);
    if (J(p.versions.map(v => v.version)) !== J(l.versions.map(v => v.version))) fail(`the versions of ${id} are not newest first`);
    // The permissions are compared after the app's normalisation (the catalog keeps them as written); everything else as written.
    const strip = (x) => ({ ...x, firstParty: x.firstParty ?? false, versions: x.versions.map(v => { const { permissions: _p, ...rest } = v; return rest; }) });
    if (C(strip(p)) !== C(strip(l))) fail(`the app reads the listing ${id} differently than it is written`);
  }
  if (C(parsed.revoked) !== C(revoked)) fail('the app reads the revocations differently than they are written');
  if (C(parsedHead.flags) !== C(src.flags ?? {})) fail('the app reads the flags differently than they are written');
  return { generated, expires, headBytes, catBytes, catName: `catalog/${catSha}.json`, archives, listings: plugins.length, revocations: revoked.length, from: null };
}

/** From a signed folder: the catalog its verified head names, and a new head for that same catalog. */
async function planResign() {
  const dir = input;
  const headBytes0 = readCapped(path.join(dir, 'index.json'), I.MAX_HEAD_BYTES, 'index.json');
  const sigText = readCapped(path.join(dir, 'index.json.minisig'), I.MAX_INDEX_SIG_BYTES, 'index.json.minisig').toString('utf8');
  const keys = testKey ? [S.parsePublicKey(fs.readFileSync(path.join(ROOT, 'host', 'test', 'keys', 'test-index.pub'), 'utf8'))] : custom ? custom.keys : T.trustedKeys('index', false);
  if (testKey) {
    console.log(`NOTE --test-key: the signed head is verified with the committed TEST index key ${keys[0].keyId} only; no product build trusts it.`);
    console.log(`  The new folder gets ${TEST_KEY_MARKER}: release-sign.sh signs its head only with --test-key, never with the product keys.`);
  }
  if (keys.length === 0) fail('no index key is pinned in this build (PRODUCT_KEYS.index in host/src/trustkeys.ts is empty)');
  const checked = I.verifyIndexHead(headBytes0, sigText, keys, P);
  if (!checked.ok) {
    const v = S.verifyMinisign(headBytes0, sigText, keys);
    fail(`the head in ${shown(dir)} does not verify (${v.ok ? checked.reason : v.reason}): re-sign only a folder whose head verifies with the index keys`);
  }
  const old = checked.head;
  // The one catalog file the verified head names (catalog/<sha256>.json: the parser holds its URL to exactly that form).
  const catName = old.catalog.url.slice(P.length);
  const catBytes = readCapped(path.join(dir, ...catName.split('/')), old.catalog.size, catName);
  if (!I.catalogMatches(catBytes, old)) fail(`${catName}: its size or SHA-256 does not match the signed head`);
  let cat;
  try { cat = I.parseCatalog(catBytes, old, { prefix: P }); } catch (e) { fail(`${catName}: the app refuses it (${e?.message ?? 'bad_index'})`); }
  if (cat.dropped > 0) fail(`${catName}: the app drops ${cat.dropped} of its listings: build the index again from its source`);
  const archives = new Map();
  for (const l of cat.plugins) for (const v of l.versions) {
    const name = v.archive.url.slice(P.length); // archives/<name>, the name checked by the parser
    if (archives.has(name)) continue;
    const file = path.join(dir, ...name.split('/'));
    let st;
    try { st = fs.lstatSync(file); } catch { fail(`${name}: missing from ${shown(dir)}`); }
    if (!st.isFile()) fail(`${name}: not a regular file (a link or a folder)`);
    const h = await hashOr(file, name);
    if (h.size !== v.archive.size || h.sha256 !== v.archive.sha256) fail(`${name}: its size or SHA-256 does not match the signed catalog`);
    archives.set(name, { file, sha256: h.sha256, size: h.size, where: name });
  }
  const generated = stamp(Date.now());
  if (Date.parse(generated) <= Date.parse(old.generated)) fail(`the signed head was generated ${old.generated}, not before now (${generated}) by this machine's clock: check the clock`);
  const expires = stamp(Date.parse(generated) + days * DAY_MS);
  const flags = Object.keys(old.flags).length > 0 ? { ...old.flags } : undefined;
  const headBytes = Buffer.from(J({ schema: 1, generated, expires, catalog: { ...old.catalog }, ...(flags ? { flags } : {}) }, null, 2) + '\n', 'utf8');
  try { I.parseCatalog(catBytes, I.parseIndexHead(headBytes, P), { prefix: P }); } catch (e) { fail(`the app would not accept the new head (${e?.message ?? 'bad_index'})`); }
  return { generated, expires, headBytes, catBytes, catName, archives, listings: cat.plugins.length, revocations: cat.revoked.length, from: old.generated };
}

/** From an unsigned folder (--head-from): a head built now for the one catalog the folder holds. */
async function planHeadFrom() {
  const dir = input;
  let names;
  try { names = fs.readdirSync(dir); } catch (e) { fail(`${shown(dir)} cannot be listed (${e?.code ?? 'error'})`); }
  const sig = names.find(n => n.toLowerCase().endsWith('.minisig'));
  if (sig !== undefined) fail(`${shown(dir)} holds a signature (${sig}): --head-from writes the head of an unsigned folder only`);
  const had = names.find(n => n.toLowerCase() === 'index.json');
  if (had !== undefined) fail(`${shown(dir)}: ${had} exists: --head-from writes the head of a folder that has none`);
  const catDir = path.join(dir, 'catalog');
  let cats = [];
  try { if (fs.lstatSync(catDir).isDirectory()) cats = fs.readdirSync(catDir); } catch { /* none */ }
  if (cats.length === 0) fail(`${shown(dir)} holds no catalog file (catalog/<sha256>.json)`);
  if (cats.length > 1) fail(`${shown(dir)} holds ${cats.length} catalog files: the head names one, catalog/<sha256>.json`);
  const m = /^([0-9a-f]{64})\.json$/.exec(cats[0]);
  if (!m) fail(`catalog/${cats[0]}: not named <sha256>.json`);
  const catName = `catalog/${cats[0]}`;
  const catBytes = readCapped(path.join(catDir, cats[0]), I.MAX_CATALOG_BYTES, catName);
  if (sha256(catBytes) !== m[1]) fail(`${catName}: its SHA-256 does not match its name`);
  const generated = stamp(Date.now());
  // A catalog newer than the head is refused by the app (R23): said here before the parser's own refusal.
  let raw = null;
  try { raw = JSON.parse(catBytes.toString('utf8')); } catch { /* the parser refuses it below */ }
  if (isObj(raw) && typeof raw.generated === 'string' && Date.parse(raw.generated) > Date.parse(generated)) {
    fail(`${catName}: the catalog was generated ${raw.generated}, after now (${generated}) by this machine's clock: check the clock, or build the catalog again`);
  }
  const expires = stamp(Date.parse(generated) + days * DAY_MS);
  const headBytes = Buffer.from(J({ schema: 1, generated, expires, catalog: { url: `${P}${catName}`, sha256: m[1], size: catBytes.length } }, null, 2) + '\n', 'utf8');
  let head, cat;
  try { head = I.parseIndexHead(headBytes, P); } catch (e) { fail(`the app would not accept this head (${e?.message ?? 'bad_index'})`); }
  try { cat = I.parseCatalog(catBytes, head, { prefix: P }); } catch (e) { fail(`${catName}: the app refuses the catalog (${e?.message ?? 'bad_index'})`); }
  const problems = catalogProblems(I, loadHostMarket(), catBytes, cat, P);
  if (problems.length > 0) fail(`${catName}: ${problems.join('; ')}`);
  return { generated, expires, headBytes, catBytes, catName, archives: new Map(), listings: cat.plugins.length, revocations: cat.revoked.length, from: null };
}

const plan = resign ? await planResign() : headFrom ? await planHeadFrom() : await planBuild();
const marked = `${resign ? 'made by scripts/index-build.mjs --resign' : headFrom ? 'given its head by scripts/index-build.mjs --head-from' : 'made by scripts/index-build.mjs'} --key (${ids})`;

if (headFrom) {
  // ---- write, in place: the marker first, then the head (a head that fails to write is removed; the marker stays) ------------------------
  let started = false;
  try {
    if (custom) writeCustomKeyMarker(out, marked);
    started = true;
    fs.writeFileSync(path.join(out, 'index.json'), plan.headBytes, { flag: 'wx' });
  } catch (e) {
    // a head this run began to write goes (one that appeared meanwhile, EEXIST, is not this run's and stays)
    if (started && e?.code !== 'EEXIST') { try { fs.rmSync(path.join(out, 'index.json'), { force: true }); } catch { /* the message below still says it */ } }
    fail(`${shown(out)}: the head could not be written (${e?.code ?? 'error'}); the folder holds no head from this run`);
  }
} else {
  // ---- write: the folder is new; anything that fails from here on removes it --------------------------------------------------------------
  try { fs.mkdirSync(path.dirname(out), { recursive: true }); fs.mkdirSync(out); } catch (e) { fail(`${shown(out)} cannot be made (${e?.code ?? 'error'})`); }
  try {
    // The markers first: no head of a --test-key or --key run is ever in this folder without its marker (a failed write removes the whole
    // folder below).
    if (custom) writeCustomKeyMarker(out, marked);
    if (testKey) {
      fs.writeFileSync(path.join(out, TEST_KEY_MARKER), [
        'This folder was made by scripts/index-build.mjs --resign --test-key.',
        'Its catalog and archives were checked only against a head signed with the committed TEST index key, whose secret is public.',
        'scripts/release-sign.sh therefore refuses to have its index.json signed with the product index keys (purpose index without',
        '--test-key). To re-sign the published index, run index-build.mjs --resign without --test-key on the published folder.', ''].join('\n'), { flag: 'wx' });
    }
    fs.mkdirSync(path.join(out, 'archives'));
    fs.mkdirSync(path.join(out, 'catalog'));
    for (const [name, a] of plan.archives) {
      const dest = path.join(out, ...name.split('/'));
      fs.copyFileSync(a.file, dest, fs.constants.COPYFILE_EXCL);
      const copy = await hashFile(dest); // the copy is what gets uploaded
      if (copy.sha256 !== a.sha256 || copy.size !== a.size) throw Object.assign(new Error('changed'), { changed: a.where });
    }
    fs.writeFileSync(path.join(out, ...plan.catName.split('/')), plan.catBytes, { flag: 'wx' });
    fs.writeFileSync(path.join(out, 'index.json'), plan.headBytes, { flag: 'wx' });
  } catch (e) {
    try { fs.rmSync(out, { recursive: true, force: true }); } catch { /* the message below still says it */ }
    fail(e?.changed ? `${e.changed} changed while the index was built; nothing was kept` : `${shown(out)} could not be written (${e?.code ?? 'error'}); nothing was kept`);
  }
}

// ---- the next steps (run from the repository root: every path in them is relative to it and quoted for the shell) ------------------------
const rel = (name) => shq(name ? (outRel === '.' ? name : `${outRel}/${name}`) : outRel);
const o = (s = '') => console.log(s);
if (plan.from) o(`RE-SIGNED index ${plan.generated} in ${shown(out)} (the signed head it replaces was generated ${plan.from})`);
else if (headFrom) o(`HEAD index ${plan.generated} for ${plan.catName} in ${shown(out)}`);
else o(`BUILT index ${plan.generated} in ${shown(out)}`);
o(`  index.json  generated ${plan.generated}, expires ${plan.expires} (${days} days)`);
o(`  ${plan.catName}  ${plan.catBytes.length} bytes, ${plan.listings} listings, ${plan.revocations} revocations${plan.from ? ' (the same catalog)' : ''}`);
for (const [name, a] of plan.archives) o(`  ${name}  ${a.size} bytes`);
o();
o('Run the commands below from the repository root.');
o();
// --test-key: the commands of the TEST key only (release-sign.sh refuses this folder's head without it: TEST_KEY_MARKER).
const tk = testKey ? ' --test-key' : '';
// --prefix and --key: carried by every verify command (release-sign.sh signs only for the product prefix with the product keys).
const product = custom === null && P === I.MARKET_URL_PREFIX;
const ex = `${P !== I.MARKET_URL_PREFIX ? ` --prefix ${shq(P)}` : ''}${keyRels.map(k => ` --key ${shq(k)}`).join('')}`;
if (product) {
  o('SIGN through the signing workflow (docs/release-checklist.md, "The plugin index"): read index.json first, then, within 24 hours');
  o('of this build (release-sign.sh refuses an older head),');
  o(`  scripts/release-sign.sh ${rel('index.json')} index "${I.indexComment(plan.generated)}"${tk}`);
  o('It writes index.json.minisig next to index.json once the signature verifies (nothing in the folder may change any more).');
} else {
  o(`SIGN index.json with ${custom ? `the secret key of ${ids}` : `the index key of ${P}`} (minisign, prehashed: never -l), with exactly this trusted comment:`);
  o(`  ${I.indexComment(plan.generated)}`);
  o(`and write the signature as index.json.minisig next to index.json (nothing in the folder may change any more). release-sign.sh signs only for`);
  o(`${I.MARKET_URL_PREFIX} with the product index keys${custom ? `, and refuses a folder that holds ${CUSTOM_KEY_MARKER}` : ''}.`);
}
o();
o('VERIFY before any upload');
o(`  node scripts/index-verify.mjs ${rel('')}${ex}${tk} --archives`);
o('and compare it with the index that is published now (reads only): it fails when this index is older than the published one (a stale folder is a');
o('rollback for every app that holds the published one) and warns for each published revocation this one lacks');
o(`  node scripts/index-verify.mjs ${rel('')}${ex}${tk} --live`);
o();
const IMMUTABLE = '--cache-control="public, max-age=31536000, immutable"';
const keyBase = new URL(P).pathname.slice(1); // v1/ for the product prefix: the bucket's keys follow the prefix's path
const put = (name, type, cache) => o(`  npx wrangler r2 object put "$EVECYNO_INDEX_BUCKET/${keyBase}${name}" --file=${rel(name)} --content-type=${type} ${cache} --remote`);
const bucket = P === I.MARKET_URL_PREFIX ? 'the plugins bucket' : `the bucket that serves ${P}`;
if (plan.from) {
  o(`UPLOAD the signature, then the head (nothing here uploads; needs \`npx wrangler login\` and EVECYNO_INDEX_BUCKET set to ${bucket}).`);
  o('The catalog and the archives it names are published already and do not change:');
} else {
  o(`UPLOAD in this order (nothing here uploads; needs \`npx wrangler login\` and EVECYNO_INDEX_BUCKET set to ${bucket}):`);
  if (headFrom) o('  (first the archives the catalog names, archives/<sha256>.zip, from where they are kept: this folder need not hold them)');
  for (const [name] of plan.archives) put(name, 'application/zip', IMMUTABLE);
  put(plan.catName, 'application/json', IMMUTABLE);
}
put('index.json.minisig', 'text/plain', '--cache-control=no-cache');
put('index.json', 'application/json', '--cache-control=no-cache');
if (!plan.from) o('The archives and the catalog first (each named by its SHA-256, so never changed in place and named by nothing until the head names them), then the');
else o('The');
o(`${plan.from ? 'signature, then index.json' : 'signature, then index.json last'}: run those two commands back to back. R2 replaces two files, not one, so for the seconds between them the published`);
o('signature does not match the published head, in whichever order they go. An app that checks in that window gets verify_failed: it keeps the list and');
o('the revocations it holds, but Install and Update are off (the block is kept across a restart) until a later check verifies a head; it retries once');
o('10 minutes later, then every 4 hours. If the second upload fails, a signature without its head fails every check the same way: upload the head again at once.');
o('The files are never in a state where the head names a file that is not there yet.');
o();
o('THEN, straight away');
o(`  node scripts/index-verify.mjs --live${ex} --archives`);
