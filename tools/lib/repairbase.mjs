// tools/lib/repairbase.mjs: the base of recovery R2 (plan 4.2 "Recovery R2", 4.5 step 5), shared by the build step
// (tools/build-index.mjs base --repair true) and the upload step (tools/publish/upload.mjs --repair true), which compute it each on
// their own. A live index that does not verify is never a base: the base comes from GitHub, never from the mirror.
// - The candidates: the runs of publish.yml and resign.yml on main other than the run under review, newest first (by created_at, then
//   id), created less than 90 days ago, that have an approval of environment index by the environment's only required reviewer (read
//   now, tools/lib/reviewer.mjs) and exactly one job sign that concluded success in attempt 1 (reviewRun reads the jobs of every
//   attempt; a re-run's later attempts never sign), from the newest down to <A> (the newest of them whose
//   upload job also succeeded; tools/approved-base.mjs); runs before <A> are no candidates. A run created 90 days ago or more is never
//   one: its artifacts are past their retention.
// - Each candidate's head, signature and catalog artifacts come from the artifacts API (GET .../actions/runs/<id>/artifacts, then
//   .../actions/artifacts/<id>/zip, read with the app's zip reader). One that is missing, listed with expired: true, or listed twice
//   stops the repair (ARTIFACT MISSING), so deleting an artifact never drops a candidate's revocations silently; one that is not the
//   single file it should be, or a catalog that is not the one its verified head names, stops it too (ARTIFACT UNREADABLE).
// - A candidate counts only when its signature verifies its head with the given keys (the pinned index keys) and the trusted
//   comment. The base is the verified candidate with the newest generated (on a tie the newer run); the revocations a run may drop
//   without a lift are measured against the union of every verified candidate's revocations. No verified candidate: NO VERIFIED BASE.
// - The floor the new head must exceed is the base head's generated, raised (never lowered) to the generated of the unsigned live head
//   when that head parses and is at most 5 minutes ahead of now; one further ahead is ignored and printed. Nothing else of the live
//   head is read, and its catalog is never a base.
// Every failed request, list that did not come back whole, or environment that does not name exactly one reviewer is an ERROR, never
// fewer candidates. The reviewer's login and id are never printed. Nothing here writes a file.
import path from 'node:path';
import { createRequire } from 'node:module';
import { REPO, getAll, getBytes, oneLine } from './github.mjs';
import { readReviewer } from './reviewer.mjs';
import { HEAD_MAX_AHEAD_MS, ROOT, revKey } from './indexbuild.mjs';
import { label, listRuns, notOnMain, reviewRun, wfOf } from '../approved-base.mjs';

const require = createRequire(import.meta.url);
const I = require(path.join(ROOT, 'vendor', 'eve-cyno-host', 'host', 'dist', 'market', 'indexformat.js'));
const Z = require(path.join(ROOT, 'vendor', 'eve-cyno-host', 'host', 'dist', 'market', 'zipread.js'));

const R = `repos/${REPO}`;
/** Plan 4.2: head, signature and catalog artifacts are kept 90 days, so a run younger than that must still have them. */
export const RETENTION_MS = 90 * 86_400_000;
export const ARTIFACTS = Object.freeze(['head', 'signature', 'catalog']);
const FILE = Object.freeze({ head: 'index.json', signature: 'index.json.minisig' });
const CATALOG_FILE_RE = /^[0-9a-f]{64}\.json$/;
const MANUAL = "the owner's manual path (docs/RUNBOOK.md; plan 5.4)";
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const cap = (name) => (name === 'head' ? I.MAX_HEAD_BYTES : name === 'signature' ? I.MAX_INDEX_SIG_BYTES : I.MAX_CATALOG_BYTES);

/** The one file of an artifact's zip: { bytes, name } or { why }. */
export function artifactFile(zipBytes, name) {
  const z = Z.readZip(zipBytes, { maxEntries: 1, maxUnpacked: cap(name), maxRatio: 1000 });
  if (!z.ok) return { why: `the zip reader refuses it (${z.reason})` };
  const f = z.entries[0];
  if (z.entries.length !== 1 || f.dir) return { why: 'it does not hold exactly one file' };
  const ok = FILE[name] ? f.name === FILE[name] : CATALOG_FILE_RE.test(f.name);
  if (!ok) return { why: `it holds ${oneLine(f.name)}, not ${FILE[name] ?? '<sha256>.json'}` };
  return { bytes: f.data, name: f.name };
}

/**
 * Recovery R2's base for the run `runId` (its id: never a candidate). `env`: the environment gh runs with (GH_TOKEN with actions:
 * read); `keys`: the index keys a candidate must verify with; `prefix`: the index's URL prefix; `liveHead`: the live head's bytes as
 * served, or null. Resolves { ok: true, lines, base, union, floor, candidates } or { ok: false, why, lines }; never rejects.
 * base: { run, workflow, headBytes, sigBytes, head, catalogName, catalogBytes, catalog }; union: the revocations; floor: { generated,
 * source }; candidates: [{ run, workflow, verified, generated? }].
 */
export async function repairBase({ runId, env, keys, prefix, liveHead = null, now = Date.now() }) {
  const lines = [];
  const stop = (why) => ({ ok: false, why, lines });
  const opts = { env };
  try {
    const reviewer = await readReviewer('index', opts);
    if (reviewer.error) return stop(`ERROR: ${oneLine(reviewer.error)}`);
    lines.push('reviewer: the only required reviewer of environment index, read now (login and id not printed)');

    // ---- the candidate runs
    const picked = [];
    let foundA = false;
    for (const run of await listRuns(opts)) {
      if (run.id === runId) { lines.push(`skip ${label(run)}: the run under review`); continue; }
      const off = notOnMain(run);
      if (off) { lines.push(`skip ${wfOf(run) ? label(run) : `run ${run.id}`}: ${off}`); continue; }
      const created = Date.parse(run.created_at);
      if (!Number.isFinite(created)) return stop(`ERROR: ${label(run)} has no valid created_at`);
      if (now - created >= RETENTION_MS) {
        lines.push(`stop at ${label(run)}: it and every older run were created 90 days ago or more (artifacts past retention): no candidates`);
        break;
      }
      const s = await reviewRun(run, reviewer.id, opts);
      if (s.why || s.sign) { lines.push(`skip ${label(run)}: ${s.why || s.sign}`); continue; }
      picked.push(run);
      if (!s.upload) {
        lines.push(`<A> ${label(run)}: the newest other run with an approved index and successful sign and upload; older runs are no candidates`);
        foundA = true;
        break;
      }
      lines.push(`candidate ${label(run)}: an approved index and a successful sign; ${s.upload}`);
    }
    if (!foundA) lines.push('no <A> younger than 90 days: every run younger than 90 days with an approved index and a successful sign is a candidate');
    if (picked.length === 0) {
      return stop(`NO VERIFIED BASE: no run younger than 90 days has an approval of index by the environment's reviewer and a successful sign; ${MANUAL}`);
    }

    // ---- their artifacts: all listed and current before any is downloaded
    const ids = new Map();
    const missing = [];
    for (const run of picked) {
      const l = await getAll(`${R}/actions/runs/${run.id}/artifacts?per_page=100`, 'artifacts', opts);
      if (l.error) throw l;
      const byName = {};
      for (const name of ARTIFACTS) {
        const as = l.items.filter((x) => isObj(x) && x.name === name);
        if (as.length === 0) missing.push(`run ${run.id} (${wfOf(run)}) has no ${name} artifact`);
        else if (as.length > 1) missing.push(`run ${run.id} (${wfOf(run)}) lists ${as.length} artifacts named ${name}`);
        else if (as[0].expired !== false) missing.push(`run ${run.id} (${wfOf(run)}): its ${name} artifact has expired`);
        else if (!Number.isSafeInteger(as[0].id) || as[0].id <= 0) missing.push(`run ${run.id} (${wfOf(run)}): its ${name} artifact has no id`);
        else byName[name] = as[0].id;
      }
      ids.set(run.id, byName);
    }
    if (missing.length > 0) {
      return stop(`ARTIFACT MISSING: ${missing.join('; ')}. Every candidate younger than 90 days keeps its head, signature and catalog, so no revocation is dropped silently; the repair stops: ${MANUAL}`);
    }

    // ---- download, verify, read the catalogs
    const verified = [];
    const candidates = [];
    for (const run of picked) {
      const who = `run ${run.id} (${wfOf(run)})`;
      const got = {};
      for (const name of ARTIFACTS) {
        const b = await getBytes(`${R}/actions/artifacts/${ids.get(run.id)[name]}/zip`, opts);
        if (b.error) throw b;
        const f = artifactFile(b.bytes, name);
        if (f.why) return stop(`ARTIFACT UNREADABLE: ${who}: its ${name} artifact: ${f.why}; the repair stops: ${MANUAL}`);
        got[name] = f;
      }
      const v = I.verifyIndexHead(got.head.bytes, got.signature.bytes.toString('utf8'), keys, prefix);
      if (!v.ok) {
        lines.push(`${who}: its signature does not verify its head with the index keys (${v.reason}): not counted`);
        candidates.push({ run: run.id, workflow: wfOf(run), verified: false });
        continue;
      }
      const catalogName = v.head.catalog.url.slice(prefix.length);
      if (`catalog/${got.catalog.name}` !== catalogName || !I.catalogMatches(got.catalog.bytes, v.head)) {
        return stop(`ARTIFACT UNREADABLE: ${who}: its catalog artifact is not the catalog its verified head names (name, size and SHA-256); the repair stops: ${MANUAL}`);
      }
      let catalog;
      try { catalog = I.parseCatalog(got.catalog.bytes, v.head, { prefix }); } catch (e) {
        return stop(`ARTIFACT UNREADABLE: ${who}: the app refuses its catalog (${oneLine(e?.message ?? 'bad_index')}); the repair stops: ${MANUAL}`);
      }
      lines.push(`${who}: verifies; generated ${v.head.generated}, ${catalog.plugins.length} listings, ${catalog.revoked.length} revocations`);
      verified.push({ run: run.id, workflow: wfOf(run), headBytes: got.head.bytes, sigBytes: got.signature.bytes, head: v.head, catalogName, catalogBytes: got.catalog.bytes, catalog });
      candidates.push({ run: run.id, workflow: wfOf(run), verified: true, generated: v.head.generated });
    }
    if (verified.length === 0) {
      return stop(`NO VERIFIED BASE: no candidate's signature verifies its head with the index keys; ${MANUAL}`);
    }

    // ---- the base, the union, the floor
    const base = verified.reduce((b, c) => (Date.parse(c.head.generated) > Date.parse(b.head.generated) ? c : b));
    const union = new Map();
    for (const c of verified) for (const r of c.catalog.revoked) if (!union.has(revKey(r))) union.set(revKey(r), r);
    lines.push(`base: run ${base.run} (${base.workflow}), generated ${base.head.generated}; ${union.size} revocations in the union of ${verified.length} verified candidates`);
    let floor = { generated: base.head.generated, source: `run ${base.run}'s verified head` };
    let live = null;
    if (liveHead !== null) { try { live = I.parseIndexHead(liveHead, prefix); } catch { live = null; } }
    if (liveHead === null) lines.push('floor: no live head was read');
    else if (live === null) lines.push('floor: the live head does not parse; nothing of it is used');
    else if (Date.parse(live.generated) > now + HEAD_MAX_AHEAD_MS) {
      lines.push(`floor: the unsigned live head's generated ${live.generated} is more than 5 minutes ahead of now: ignored (the sign job refuses such a head)`);
    } else if (Date.parse(live.generated) > Date.parse(floor.generated)) {
      floor = { generated: live.generated, source: 'the unsigned live head (its generated only; it is never a base)' };
    } else lines.push(`floor: the unsigned live head's generated ${live.generated} is not newer than the base: the floor stays`);
    lines.push(`floor ${floor.generated} from ${floor.source}: the new head must be newer`);
    return { ok: true, lines, base, union: [...union.values()], floor, candidates };
  } catch (e) {
    return stop(`ERROR: ${oneLine(e && e.error ? e.error : e)}`);
  }
}
