// PB-repair-*: the candidate collector of recovery R2 (tools/lib/repairbase.mjs; plan 4.2 "Recovery R2", 4.5 step 5, task 2.4). The
// candidates are the runs of publish.yml and resign.yml, newest first, from <A> (the newest other run with an approval of index by the
// environment's reviewer and successful sign and upload jobs) to the newest, that have such an approval and a successful sign, created
// less than 90 days ago. Their head, signature and catalog artifacts come from the artifacts API; a missing or expired one stops the
// repair. The base is the verified candidate with the newest generated, the comparison set for lifts the union of the verified
// candidates' revocations, and the unsigned live head only raises the floor. GitHub is the stub gh of ghstub.mjs (no network, no
// token); the index key is a throwaway key made in this run.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, describe, test } from 'node:test';
import { createRequire } from 'node:module';
import { repairBase } from '../lib/repairbase.mjs';
import { ROOT, indexKeys, revKey } from '../lib/indexbuild.mjs';
import { throwawaySigner } from '../lib/throwaway.mjs';
import { REVIEWER as WHO, envDoc, makeGhStub, stubEnv } from './ghstub.mjs';
import { zip } from './zipwrite.mjs';

const require = createRequire(import.meta.url);
const I = require(path.join(ROOT, 'vendor', 'eve-cyno-host', 'host', 'dist', 'market', 'indexformat.js'));
const temps = [];
after(() => { for (const t of temps) fs.rmSync(t, { recursive: true, force: true }); });
const BIN = makeGhStub(temps);
const R = 'repos/eve-cyno/plugins';
const P = I.MARKET_URL_PREFIX;
const DAY = 86_400_000;
const NOW = Date.now();
const stamp = (ms) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
const NAMES_REVIEWER = new RegExp(`${WHO.login}|${WHO.id}`, 'i');

const signer = throwawaySigner(); // stands in for the pinned index key
const stranger = throwawaySigner(); // a key the app does not trust
const keyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'repair-keys-'));
temps.push(keyDir);
fs.writeFileSync(path.join(keyDir, 'index.pub'), signer.pubText);
const KEYS = indexKeys([path.join(keyDir, 'index.pub')]).keys;

const rev = (id, versions = '*') => ({ id, versions, reason: `Revoked ${id}.`, date: '2026-11-01' });
const R0 = rev('dev.example.zero'), R1 = rev('dev.example.one', ['1.0.0']), R2 = rev('dev.example.two');

/** A signed index generated at `g` (ms): head, signature and catalog bytes as the build and sign jobs leave them. */
function index(g, revoked, s = signer) {
  const catalog = Buffer.from(JSON.stringify({ schema: 1, generated: stamp(g), plugins: [], revoked }));
  const head = Buffer.from(JSON.stringify({ schema: 1, generated: stamp(g), expires: stamp(g + 60 * DAY), catalog: { url: `${P}catalog/${sha(catalog)}.json`, sha256: sha(catalog), size: catalog.length } }));
  return { head, sig: Buffer.from(s.sign(head, I.indexComment(stamp(g)))), catalog, generated: stamp(g) };
}
/** An unsigned head an R2-token holder could write: it names a catalog without any revocation. */
function unsignedHead(g) {
  const catalog = Buffer.from(JSON.stringify({ schema: 1, generated: stamp(g), plugins: [], revoked: [] }));
  return Buffer.from(JSON.stringify({ schema: 1, generated: stamp(g), expires: stamp(g + 60 * DAY), catalog: { url: `${P}catalog/${sha(catalog)}.json`, sha256: sha(catalog), size: catalog.length } }));
}

const wfRun = (id, wf, daysAgo) => ({
  id, name: wf.replace('.yml', ''), path: `.github/workflows/${wf}`, head_branch: 'main', head_sha: String(id).padStart(40, 'c'),
  event: 'workflow_dispatch', status: 'completed', run_attempt: 1, created_at: stamp(NOW - daysAgo * DAY), html_url: `https://github.com/eve-cyno/plugins/actions/runs/${id}`,
});
const approval = (user, env) => ({ environments: [{ id: 1, name: env }], state: 'approved', comment: '', user: { login: `user-${user}`, id: user, type: 'User' } });
/** The jobs of every attempt of a run (GET .../jobs?filter=all): [name, conclusion, attempt (default 1)]. */
const jobsOf = (id, list) => [{ total_count: list.length, jobs: list.map(([name, conclusion, attempt = 1], i) => ({ id: id * 10 + i, run_id: id, name, status: 'completed', conclusion, run_attempt: attempt })) }];

/**
 * One run of a case: `ix` its index (artifacts), `upload` the upload job's conclusion, `sign` the sign job's, `approvedBy` the user
 * whose approval of index it has (null: none), `drop` the artifacts it lacks, `expired` the ones listed with expired: true.
 */
function runOf(id, wf, daysAgo, ix, { upload = 'success', sign = 'success', approvedBy = WHO.id, drop = [], expired = [], later = [] } = {}) {
  return { run: wfRun(id, wf, daysAgo), ix, upload, sign, approvedBy, drop, expired, later };
}
const ARTS = { head: (ix) => zip([{ name: 'index.json', data: ix.head }]), signature: (ix) => zip([{ name: 'index.json.minisig', data: ix.sig }]),
  catalog: (ix) => zip([{ name: `${sha(ix.catalog)}.json`, data: ix.catalog }]) };
const artId = (runId, name) => runId * 10 + ['head', 'signature', 'catalog'].indexOf(name) + 1;

function routes(runs, { extra = {}, zips = {} } = {}) {
  const under = wfRun(300, 'publish.yml', 0);
  const list = (wf) => {
    const l = [under, ...runs.map((x) => x.run)].filter((r) => r.path.endsWith(wf));
    return [{ total_count: l.length, workflow_runs: l }];
  };
  const r = {
    [`GET ${R}/environments/index`]: { stdout: envDoc('index') },
    [`GET ${R}/actions/workflows/publish.yml/runs?per_page=100`]: { stdout: list('publish.yml') },
    [`GET ${R}/actions/workflows/resign.yml/runs?per_page=100`]: { stdout: list('resign.yml') },
  };
  for (const x of runs) {
    const id = x.run.id;
    r[`GET ${R}/actions/runs/${id}/approvals`] = { stdout: x.approvedBy === null ? [] : [approval(x.approvedBy, 'index'), approval(x.approvedBy, 'mirror')] };
    r[`GET ${R}/actions/runs/${id}/jobs?filter=all&per_page=100`] = { stdout: jobsOf(id, [['build', 'success'], ['sign', x.sign], ['upload', x.upload], ['verify', x.upload === 'success' ? 'success' : 'skipped'], ...x.later]) };
    const arts = ['head', 'signature', 'catalog'].filter((n) => !x.drop.includes(n)).map((name) => ({
      id: artId(id, name), node_id: 'MDg6QXJ0aWZhY3Q=', name, size_in_bytes: 100, expired: x.expired.includes(name),
      created_at: x.run.created_at, expires_at: stamp(Date.parse(x.run.created_at) + 90 * DAY), workflow_run: { id, head_branch: 'main', head_sha: x.run.head_sha },
    }));
    if (x.ix) arts.push({ id: id * 10 + 9, name: 'archives.json', size_in_bytes: 2, expired: false });
    r[`GET ${R}/actions/runs/${id}/artifacts?per_page=100`] = { stdout: [{ total_count: arts.length, artifacts: arts }] };
    if (x.ix) for (const name of ['head', 'signature', 'catalog']) r[`GET ${R}/actions/artifacts/${artId(id, name)}/zip`] = { b64: (zips[`${id} ${name}`] ?? ARTS[name](x.ix)).toString('base64') };
  }
  return { ...r, ...extra };
}

async function collect(runs, { liveHead = null, extra, zips } = {}) {
  const { env, log } = stubEnv(BIN, routes(runs, { extra, zips }), temps);
  const r = await repairBase({ runId: 300, env, keys: KEYS, prefix: P, liveHead, now: NOW });
  const text = r.lines.join('\n') + (r.ok ? '' : `\n${r.why}`);
  assert.doesNotMatch(text, NAMES_REVIEWER, 'the reviewer\'s login and id are never printed');
  const calls = log().map((a) => a[a.length - 1]);
  return { ...r, text, calls, zipCalls: calls.filter((c) => c.endsWith('/zip')) };
}
const unionKeys = (r) => r.union.map(revKey).sort();

// The history most cases start from: O (an older uploaded run, before <A>), A (<A>: signed and uploaded), H (the half-published run:
// signed, upload failed). H is the newest.
const IX_O = index(NOW - 20 * DAY, [R0]);
const IX_A = index(NOW - 5 * DAY, [R1]);
const IX_H = index(NOW - DAY, [R2]);
const O = (o = {}) => runOf(270, 'publish.yml', 20, o.ix ?? IX_O, o);
const A = (o = {}) => runOf(280, 'resign.yml', 5, o.ix ?? IX_A, o);
const H = (o = {}) => runOf(290, 'publish.yml', 1, o.ix ?? IX_H, { upload: 'failure', ...o });

describe('recovery R2: the candidates and the base', () => {
  test('PB-repair-revocation-union: the base is the newest verified candidate; lifts are measured against the union of <A> and every later candidate', async () => {
    const other = runOf(285, 'publish.yml', 3, index(NOW - 3 * DAY, [rev('dev.example.other')]), { approvedBy: 777 });
    const r = await collect([H(), other, A(), O()]);
    assert.equal(r.ok, true, r.text);
    assert.equal(r.base.run, 290, 'the half-published run has the newest generated');
    assert.equal(r.base.head.generated, IX_H.generated);
    assert.deepEqual(r.base.catalogBytes, IX_H.catalog);
    assert.deepEqual(unionKeys(r), [revKey(R1), revKey(R2)].sort(), 'R0 of a run before <A> and the revocation of a run approved by another user are not in it');
    assert.deepEqual(r.candidates.map((c) => [c.run, c.verified]), [[290, true], [280, true]]);
    assert.match(r.text, /^<A> run 280 /m);
    assert.match(r.text, /^skip run 285 .*no approval of index by the environment's reviewer/m);
    assert.ok(!r.calls.some((c) => c.includes('/runs/270/')), 'nothing of a run before <A> is read');
    assert.equal(r.floor.generated, IX_H.generated);
  });

  test('PB-repair-base-verified-only: a candidate whose signature does not verify never becomes the base, and its revocations are not counted', async () => {
    const forged = index(NOW - DAY, [], stranger);
    const r = await collect([H({ ix: forged }), A()]);
    assert.equal(r.ok, true, r.text);
    assert.equal(r.base.run, 280);
    assert.deepEqual(unionKeys(r), [revKey(R1)]);
    assert.deepEqual(r.candidates.map((c) => [c.run, c.verified]), [[290, false], [280, true]]);
    assert.match(r.text, /run 290 .*does not verify/);
  });

  test('PB-repair-unsigned-head-never-base: an unsigned live head, newer and without the revocations, only raises the floor', async () => {
    const live = unsignedHead(NOW - 60_000);
    const r = await collect([H(), A()], { liveHead: live });
    assert.equal(r.ok, true, r.text);
    assert.equal(r.base.run, 290, 'the base stays a verified candidate');
    assert.deepEqual(r.base.catalogBytes, IX_H.catalog);
    assert.deepEqual(unionKeys(r), [revKey(R1), revKey(R2)].sort());
    assert.equal(r.floor.generated, JSON.parse(live).generated);
    assert.match(r.floor.source, /unsigned live head/);
  });

  test('PB-repair-no-verified-base-stops: no candidate verifies, or there is none: the repair stops for the owner\'s manual path', async () => {
    const none = await collect([H({ ix: index(NOW - DAY, [R2], stranger) }), A({ ix: index(NOW - 5 * DAY, [R1], stranger) })]);
    assert.equal(none.ok, false);
    assert.match(none.why, /^NO VERIFIED BASE: /);
    assert.match(none.why, /manual path/);
    assert.match(none.why, /no candidate's signature verifies/);
    const empty = await collect([runOf(260, 'publish.yml', 2, null, { approvedBy: null })]);
    assert.equal(empty.ok, false);
    assert.match(empty.why, /^NO VERIFIED BASE: no run younger than 90 days has an approval of index/);
    assert.deepEqual(empty.calls.filter((c) => c.includes('/artifacts')), [], 'no artifact is listed without a candidate');
  });

  test('PB-repair-candidates-only: a run whose sign failed, or a run not on main, is never a candidate', async () => {
    const failedSign = runOf(295, 'publish.yml', 0.5, index(NOW - DAY / 2, []), { sign: 'failure', upload: 'skipped' });
    const branch = runOf(296, 'publish.yml', 0.4, index(NOW - DAY / 3, []));
    branch.run.head_branch = 'other';
    const r = await collect([branch, failedSign, H(), A()]);
    assert.equal(r.ok, true, r.text);
    assert.deepEqual(r.candidates.map((c) => c.run), [290, 280]);
    assert.match(r.text, /^skip run 295 .*job sign concluded failure/m);
    assert.match(r.text, /^skip run 296 .*not on main/m);
    assert.deepEqual(unionKeys(r), [revKey(R1), revKey(R2)].sort());
  });

  test('PB-repair-rerun: a re-run is judged by its attempt 1 (jobs of every attempt), so one that signed there stays a candidate', async () => {
    const LATER = [['build', 'failure', 2], ['sign', 'skipped', 2], ['upload', 'skipped', 2], ['verify', 'skipped', 2]];
    const ix = index(NOW - DAY / 2, [R0]);
    const signed = runOf(295, 'publish.yml', 0.5, ix, { upload: 'failure', later: LATER });
    signed.run.run_attempt = 2;
    const r = await collect([signed, H(), A()]);
    assert.equal(r.ok, true, r.text);
    assert.deepEqual(r.candidates.map((c) => c.run), [295, 290, 280], 'attempt 1 signed: a candidate, its revocations counted');
    assert.deepEqual(unionKeys(r), [revKey(R0), revKey(R1), revKey(R2)].sort());
    const unapproved = runOf(296, 'publish.yml', 0.4, null, { approvedBy: null, sign: 'skipped', later: LATER });
    unapproved.run.run_attempt = 2;
    const u = await collect([unapproved, H(), A()]);
    assert.equal(u.ok, true, u.text);
    assert.match(u.text, /^skip run 296 .*no approval of index by the environment's reviewer/m);
    assert.ok(u.calls.includes(`${R}/actions/runs/296/jobs?filter=all&per_page=100`), 'an unapproved re-run\'s jobs are read: attempt 1 did not sign');
    const hidden = runOf(298, 'publish.yml', 0.45, ix, { approvedBy: null, later: LATER });
    hidden.run.run_attempt = 2;
    const h = await collect([hidden, H(), A()]);
    assert.equal(h.ok, false, h.text);
    assert.match(h.why, /^ERROR: run 298 \(publish\.yml, created [^)]*\) lists no approval of index by the environment's reviewer, yet job sign of attempt 1 concluded success/);
    assert.deepEqual(h.zipCalls, [], 'nothing is downloaded');
    const unreadable = runOf(297, 'publish.yml', 0.3, ix, { later: [['sign', 'success', 2]] });
    unreadable.run.run_attempt = 2;
    const e = await collect([unreadable, H(), A()]);
    assert.equal(e.ok, false, e.text);
    assert.match(e.why, /^ERROR: run 297 \(publish\.yml, created [^)]*\): job sign of attempt 2 concluded success/);
    assert.deepEqual(e.zipCalls, [], 'nothing is downloaded');
  });

  test('PB-repair-90-days: a run created 90 days ago or more is never a candidate, so its expired artifacts do not stop the repair', async () => {
    const old = runOf(250, 'publish.yml', 91, index(NOW - 91 * DAY, [R0]), { upload: 'failure', expired: ['head', 'signature', 'catalog'] });
    const r = await collect([H(), old]);
    assert.equal(r.ok, true, r.text);
    assert.equal(r.base.run, 290, 'no <A>: the half-published run is the only candidate');
    assert.match(r.text, /^stop at run 250 .*90 days ago or more/m);
    assert.ok(!r.calls.some((c) => c.includes('/runs/250/')), 'nothing of the old run is read');
    const only = await collect([runOf(250, 'publish.yml', 91, null, { expired: ['head', 'signature', 'catalog'] })]);
    assert.equal(only.ok, false);
    assert.match(only.why, /^NO VERIFIED BASE: /);
    assert.match(only.text, /90 days/);
  });
});

describe('recovery R2: a missing artifact stops the repair', () => {
  test('PB-repair-head-artifact-missing-stops: a candidate without its head artifact stops the repair; nothing is downloaded', async () => {
    const r = await collect([H({ drop: ['head'] }), A()]);
    assert.equal(r.ok, false);
    assert.match(r.why, /^ARTIFACT MISSING: run 290 .*head/);
    assert.match(r.why, /manual path/);
    assert.deepEqual(r.zipCalls, []);
  });

  test('PB-repair-sig-artifact-missing-stops: a candidate without its signature artifact stops the repair', async () => {
    const r = await collect([H(), A({ drop: ['signature'] })]);
    assert.equal(r.ok, false);
    assert.match(r.why, /^ARTIFACT MISSING: run 280 .*signature/);
    assert.deepEqual(r.zipCalls, []);
  });

  test('PB-repair-catalog-artifact-missing-stops: a candidate without its catalog artifact stops the repair', async () => {
    const r = await collect([H({ drop: ['catalog'] }), A()]);
    assert.equal(r.ok, false);
    assert.match(r.why, /^ARTIFACT MISSING: run 290 .*catalog/);
  });

  test('PB-repair-artifact-expired-stops: an artifact listed with expired: true counts as missing', async () => {
    const r = await collect([H(), A({ expired: ['head'] })]);
    assert.equal(r.ok, false);
    assert.match(r.why, /^ARTIFACT MISSING: run 280 .*head .*expired/);
  });

  test('PB-repair-artifact-doubled-stops: two artifacts of one name are never a choice', async () => {
    const twice = { id: 2908, name: 'head', size_in_bytes: 100, expired: false };
    const listed = routes([H(), A()])[`GET ${R}/actions/runs/290/artifacts?per_page=100`].stdout[0];
    const r = await collect([H(), A()], { extra: { [`GET ${R}/actions/runs/290/artifacts?per_page=100`]: { stdout: [{ total_count: listed.total_count + 1, artifacts: [...listed.artifacts, twice] }] } } });
    assert.equal(r.ok, false);
    assert.match(r.why, /^ARTIFACT MISSING: run 290 .*lists 2 artifacts named head/);
  });

  test('PB-repair-catalog-from-artifact: the catalog is the run\'s own artifact, checked against the head; another one stops the repair', async () => {
    const ok = await collect([A()]);
    assert.equal(ok.ok, true, ok.text);
    assert.deepEqual(ok.base.catalogBytes, IX_A.catalog);
    assert.ok(ok.zipCalls.includes(`${R}/actions/artifacts/${artId(280, 'catalog')}/zip`));
    const swapped = await collect([A()], { zips: { '280 catalog': zip([{ name: `${sha(IX_A.catalog)}.json`, data: IX_O.catalog }]) } });
    assert.equal(swapped.ok, false);
    assert.match(swapped.why, /^ARTIFACT UNREADABLE: run 280 .*its catalog artifact is not the catalog its verified head names/);
    const renamed = await collect([A()], { zips: { '280 catalog': zip([{ name: `${sha(IX_O.catalog)}.json`, data: IX_A.catalog }]) } });
    assert.equal(renamed.ok, false, 'the right bytes under another catalog\'s name');
    assert.match(renamed.why, /its catalog artifact is not the catalog its verified head names/);
  });

  test('PB-repair-artifact-unreadable-stops: an artifact zip that is not one file of the expected name stops the repair', async () => {
    const two = zip([{ name: 'index.json', data: IX_A.head }, { name: 'extra.txt', data: 'x' }]);
    const r = await collect([A()], { zips: { '280 head': two } });
    assert.equal(r.ok, false);
    assert.match(r.why, /^ARTIFACT UNREADABLE: run 280 .*head/);
    const notZip = await collect([A()], { zips: { '280 signature': Buffer.from('not a zip') } });
    assert.equal(notZip.ok, false);
    assert.match(notZip.why, /^ARTIFACT UNREADABLE: run 280 .*signature/);
    const other = await collect([A()], { zips: { '280 head': zip([{ name: 'other.json', data: IX_A.head }]) } });
    assert.equal(other.ok, false);
    assert.match(other.why, /^ARTIFACT UNREADABLE: run 280 .*its head artifact: it holds other\.json, not index\.json/);
  });
});

describe('recovery R2: the floor', () => {
  test('PB-repair-floor-raised-only: the unsigned live generated raises the floor and never lowers it', async () => {
    const up = await collect([H(), A()], { liveHead: unsignedHead(NOW - 3_600_000) });
    assert.equal(up.ok, true, up.text);
    assert.equal(up.floor.generated, stamp(NOW - 3_600_000));
    assert.match(up.text, /floor .*unsigned live head/);
    const down = await collect([H(), A()], { liveHead: unsignedHead(NOW - 10 * DAY) });
    assert.equal(down.ok, true, down.text);
    assert.equal(down.floor.generated, IX_H.generated, 'an older unsigned head never lowers the floor');
    assert.match(down.floor.source, /run 290/);
    const junk = await collect([H(), A()], { liveHead: Buffer.from('not a head') });
    assert.equal(junk.ok, true, junk.text);
    assert.equal(junk.floor.generated, IX_H.generated);
  });

  test('PB-repair-future-unsigned-ignored: an unsigned generated more than 5 minutes ahead is ignored and printed', async () => {
    const r = await collect([H(), A()], { liveHead: unsignedHead(NOW + DAY) });
    assert.equal(r.ok, true, r.text);
    assert.equal(r.floor.generated, IX_H.generated);
    assert.match(r.text, /more than 5 minutes ahead.*ignored/);
    const near = await collect([H(), A()], { liveHead: unsignedHead(NOW + 120_000) });
    assert.equal(near.floor.generated, stamp(NOW + 120_000), 'within 5 minutes it counts');
  });
});

describe('recovery R2: failures are failures', () => {
  test('PB-repair-query-error-fails: an API error or an incomplete list is an ERROR, never fewer candidates', async () => {
    const e = await collect([H(), A()], { extra: { [`GET ${R}/actions/runs/290/artifacts?per_page=100`]: { stderr: 'gh: Server Error (HTTP 502)\n', exit: 1 } } });
    assert.equal(e.ok, false);
    assert.match(e.why, /^ERROR: .*artifacts.*exited 1/);
    const short = await collect([H(), A()], { extra: { [`GET ${R}/actions/runs/280/artifacts?per_page=100`]: { stdout: [{ total_count: 5, artifacts: [] }] } } });
    assert.equal(short.ok, false);
    assert.match(short.why, /^ERROR: .*incomplete/);
    const z = await collect([H(), A()], { extra: { [`GET ${R}/actions/artifacts/${artId(290, 'head')}/zip`]: { stderr: 'gh: Not Found (HTTP 404)\n', exit: 1 } } });
    assert.equal(z.ok, false);
    assert.match(z.why, /^ERROR: .*zip.*exited 1/);
    const env = await collect([H(), A()], { extra: { [`GET ${R}/environments/index`]: { stdout: envDoc('index', { reviewers: [] }) } } });
    assert.equal(env.ok, false);
    assert.match(env.why, /^ERROR: environment index: 0 required reviewers/);
  });
});
