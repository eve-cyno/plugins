// DF-*: C10, C11, C14, C17 (tools/lib/diff.mjs). Each failing case is the proof of the line it guards (mutants: see the commit message).
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { checkEntry, enginesReach, firstPartyExempt, permissionsDiff, sameEntry, wasmReason, wasmWays } from '../lib/diff.mjs';

const ver = (version, permissions = {}, extra = {}) => ({ version, engines: '^1.20.0', permissions, ...extra });
const entry = (versions, extra = {}) => ({ id: 'dev.example.intel', name: 'Intel Board', author: 'Example Author', maintainers: ['alice'], versions, ...extra });

describe('permissions diff (C10)', () => {
  test('DF-same: identical permissions are no escalation', () => {
    assert.equal(permissionsDiff(ver('1.0.0', { network: ['https://a.example'] }), ver('1.1.0', { network: ['https://a.example'] })).escalation, false);
  });
  test('DF-narrower: fewer permissions are no escalation', () => {
    assert.equal(permissionsDiff(ver('1.0.0', { esi: ['esi-skills.read_skills.v1'], overlays: true }), ver('1.1.0', {})).escalation, false);
  });
  test('DF-network: a new origin is an escalation', () => {
    assert.equal(permissionsDiff(ver('1.0.0', {}), ver('1.1.0', { network: ['https://a.example'] })).escalation, true);
  });
  test('DF-flag: a new flag is an escalation', () => {
    assert.equal(permissionsDiff(ver('1.0.0', {}), ver('1.1.0', { overlays: true })).escalation, true);
  });
  test('DF-characters: characters selected to all is an escalation', () => {
    assert.equal(permissionsDiff(ver('1.0.0', { characters: 'selected' }), ver('1.1.0', { characters: 'all' })).escalation, true);
  });
  test('DF-background: background turned on is reported', () => {
    assert.equal(permissionsDiff(ver('1.0.0'), ver('1.1.0', {}, { background: true })).background, true);
    assert.equal(permissionsDiff(ver('1.0.0', {}, { background: true }), ver('1.1.0', {}, { background: true })).background, false);
  });
});

// The first-party exemption (vendored firstpartyallow.js, owner rulings Q1 = A1, Q2 = P1): the official first-party install of an id on
// FIRST_PARTY_ALLOWLIST keeps `chatlogs` in host `requested` although it can send data out, so the app asks for them again when a version
// adds them. C10 reads the same rule from the entry: the id, the entry's `firstParty` mark, and this index being the official one.
describe('first-party chatlogs (C10)', () => {
  const INTEL = 'dev.evecyno.intel';
  const project = (id, versions, extra = {}) => {
    const x = entry(versions, { id, name: 'Intel', author: 'EVE-Cyno', firstParty: true, ...extra });
    delete x.maintainers;
    return x;
  };
  const sends = { network: ['https://a.example'] }; // can send data out (windowsview.js canSendOut): HT-M1 drops chatlogs for others
  const noChat = ver('1.0.0', { ...sends, logs: ['gamelogs'] });
  const chat = ver('1.1.0', { ...sends, logs: ['gamelogs', 'chatlogs'] });
  const escalates = (head, base) => checkEntry(head, base, { prAuthor: null }).flags.includes('escalation');

  test('DF-fp-chatlogs: the first-party Intel entry gaining chatlogs is an escalation that names them', () => {
    const base = project(INTEL, [noChat]), head = project(INTEL, [chat, noChat]);
    const d = permissionsDiff(noChat, chat, firstPartyExempt(head, base));
    assert.equal(d.escalation, true);
    assert.deepEqual(d.delta.logs, ['chatlogs']);
    assert.equal(escalates(head, base), true);
  });
  test('DF-fp-chatlogs-other: the same versions under another id, or without the firstParty mark, count no chatlogs', () => {
    const cases = [
      ['another dev.evecyno. id', (v) => project('dev.evecyno.map', v)],
      ['a third-party id marked firstParty', (v) => project('dev.example.intel', v)],
      ['Intel with firstParty false', (v) => project(INTEL, v, { firstParty: false })],
      ['Intel with firstParty "true"', (v) => project(INTEL, v, { firstParty: 'true' })],
      ['Intel without firstParty', (v) => { const x = project(INTEL, v); delete x.firstParty; return x; }],
    ];
    for (const [label, mk] of cases) {
      const base = mk([noChat]), head = mk([chat, noChat]);
      assert.deepEqual(firstPartyExempt(head, base), { before: false, after: false }, label);
      const d = permissionsDiff(noChat, chat, firstPartyExempt(head, base));
      assert.equal(d.escalation, false, label);
      assert.deepEqual(d.delta.logs, [], label);
      assert.equal(escalates(head, base), false, label);
    }
  });
  test('DF-fp-chatlogs-same: an Intel update that asks for the same permissions is no escalation', () => {
    const was = ver('1.0.0', { ...sends, logs: ['chatlogs'] }), now = ver('1.1.0', { ...sends, logs: ['chatlogs'] });
    const base = project(INTEL, [was]), head = project(INTEL, [now, was]);
    assert.deepEqual(firstPartyExempt(head, base), { before: true, after: true });
    assert.equal(permissionsDiff(was, now, firstPartyExempt(head, base)).escalation, false);
    assert.equal(escalates(head, base), false);
    assert.deepEqual(firstPartyExempt(head, null), { before: true, after: true }, 'a new entry: the head alone');
  });
  test('DF-fp-chatlogs-mark-set: Intel marked first-party only on the head compares its version before as not exempt (fail closed)', () => {
    // A grant made while the entry was not first-party holds no chatlogs, so the app asks for them again.
    const was = ver('1.0.0', { ...sends, logs: ['chatlogs'] }), now = ver('1.1.0', { ...sends, logs: ['chatlogs'] });
    const base = project(INTEL, [was], { firstParty: false }), head = project(INTEL, [now, was]);
    assert.deepEqual(firstPartyExempt(head, base), { before: false, after: true });
    assert.deepEqual(permissionsDiff(was, now, firstPartyExempt(head, base)).delta.logs, ['chatlogs']);
    assert.equal(escalates(head, base), true);
    assert.deepEqual(firstPartyExempt(project(INTEL, [now, was], { firstParty: false }), project(INTEL, [was])), { before: false, after: false }, 'the mark dropped');
  });
  test('DF-chatlogs-third-party: a third-party plugin that can send data out adds chatlogs with no escalation (HT-M1), a sealed one escalates', () => {
    assert.deepEqual(checkEntry(entry([chat, noChat]), entry([noChat]), { prAuthor: 'alice' }).flags, []);
    assert.equal(permissionsDiff(noChat, chat).escalation, false, 'no first-party input: not exempt');
    const sealedOld = ver('1.0.0', { logs: ['gamelogs'] }), sealedNew = ver('1.1.0', { logs: ['gamelogs', 'chatlogs'] });
    assert.deepEqual(checkEntry(entry([sealedNew, sealedOld]), entry([sealedOld]), { prAuthor: 'alice' }).flags, ['escalation']);
  });
});

describe('entry flags (C10, C11, C14, C17)', () => {
  test('DF-escalation-flag: an escalating new version is flagged, not refused', () => {
    const base = entry([ver('1.0.0')]);
    const head = entry([ver('1.1.0', { overlays: true }), ver('1.0.0')]);
    const r = checkEntry(head, base, { prAuthor: 'alice' });
    assert.deepEqual(r.refusals, []);
    assert.deepEqual(r.flags, ['escalation']);
  });
  test('DF-background-flag: background added is flagged escalation', () => {
    const r = checkEntry(entry([ver('1.1.0', {}, { background: true }), ver('1.0.0')]), entry([ver('1.0.0')]), { prAuthor: 'alice' });
    assert.deepEqual(r.flags, ['escalation']);
  });
  test('DF-clean: no change in permissions gives no flag', () => {
    const r = checkEntry(entry([ver('1.1.0'), ver('1.0.0')]), entry([ver('1.0.0')]), { prAuthor: 'alice' });
    assert.deepEqual(r.flags, []);
  });
  test('DF-compare-adjacent: a version is compared with the next older one, not the oldest', () => {
    const base = entry([ver('1.1.0', { overlays: true }), ver('1.0.0')]);
    const head = entry([ver('1.2.0', { overlays: true }), ver('1.1.0', { overlays: true }), ver('1.0.0')]);
    assert.deepEqual(checkEntry(head, base, { prAuthor: 'alice' }).flags, []);
  });
  test('DF-compare-listed: an unlisted version is not the version before (the head decides what is unlisted)', () => {
    const base = entry([ver('1.1.0', { overlays: true }, { unlisted: true }), ver('1.0.0')]);
    const head = entry([ver('1.2.0', { overlays: true }), ver('1.1.0', { overlays: true }, { unlisted: true }), ver('1.0.0')]);
    assert.deepEqual(checkEntry(head, base, { prAuthor: 'alice' }).flags, ['escalation']);
    const unlistedNow = entry([ver('1.2.0', { overlays: true }), ver('1.1.0', { overlays: true }, { unlisted: true }), ver('1.0.0')]);
    assert.deepEqual(checkEntry(unlistedNow, entry([ver('1.1.0', { overlays: true }), ver('1.0.0')]), { prAuthor: 'alice' }).flags, ['escalation']);
    assert.deepEqual(checkEntry(entry([ver('1.2.0', { overlays: true }), ver('1.1.0', { overlays: true }), ver('1.0.0')]), entry([ver('1.1.0', { overlays: true }), ver('1.0.0')]), { prAuthor: 'alice' }).flags, []);
  });
  test('DF-unlisted-not-added: an unlisted version the base does not name (a live catalog leaves it out) is not compared or flagged', () => {
    const base = entry([ver('1.0.0')]);
    assert.deepEqual(checkEntry(entry([ver('1.1.0', { overlays: true }, { unlisted: true, engines: '^2.0.0' }), ver('1.0.0')]), base, { prAuthor: 'alice' }).flags, []);
    assert.deepEqual(checkEntry(entry([ver('1.1.0', { overlays: true }, { engines: '^2.0.0' }), ver('1.0.0')]), base, { prAuthor: 'alice' }).flags.sort(), ['engines', 'escalation']);
  });
  test('DF-compare-unlisted-fallback: no listed lower version compares with an unlisted one (the greatest lower one on the base, any listing state)', () => {
    const head = (perms, extra = {}) => entry([ver('2.0.0', perms, extra), ver('1.1.0', { overlays: true }, { unlisted: true }), ver('1.0.0', {}, { unlisted: true })]);
    const sameBase = entry([ver('1.1.0', { overlays: true }), ver('1.0.0')]);
    assert.deepEqual(checkEntry(head({ overlays: true }), sameBase, { prAuthor: 'alice' }).flags, [], 'unlisted in this pull request: 1.1.0, not 1.0.0');
    assert.deepEqual(checkEntry(head({ overlays: true, network: ['https://b.example'] }), sameBase, { prAuthor: 'alice' }).flags, ['escalation']);
    assert.deepEqual(checkEntry(head({ overlays: true }, { background: true }), sameBase, { prAuthor: 'alice' }).flags, ['escalation'], 'background turned on');
    const unlistedBase = entry([ver('1.1.0', { overlays: true }, { unlisted: true }), ver('1.0.0', {}, { unlisted: true })]);
    assert.deepEqual(checkEntry(head({ overlays: true }), unlistedBase, { prAuthor: 'alice' }).flags, [], 'unlisted by an earlier pull request');
    assert.deepEqual(checkEntry(head({ overlays: true, network: ['https://b.example'] }), unlistedBase, { prAuthor: 'alice' }).flags, ['escalation']);
    const listedLow = entry([ver('2.0.0', { overlays: true }), ver('1.1.0', {}, { unlisted: true }), ver('1.0.0', { overlays: true })]);
    assert.deepEqual(checkEntry(listedLow, entry([ver('1.1.0', {}, { unlisted: true }), ver('1.0.0', { overlays: true })]), { prAuthor: 'alice' }).flags, [], 'a listed lower version comes first');
    const headOnly = entry([ver('2.0.0', { overlays: true }), ver('1.5.0', { overlays: true }, { unlisted: true }), ver('1.0.0', {}, { unlisted: true })]);
    assert.deepEqual(checkEntry(headOnly, entry([ver('1.0.0')]), { prAuthor: 'alice' }).flags, ['escalation'], 'an unlisted version the base does not name is never the version before');
  });
  test('DF-no-lower-version: no lower version on a known id flags escalation (fail closed); a new id is new', () => {
    assert.deepEqual(checkEntry(entry([ver('2.0.0'), ver('1.5.0')]), entry([ver('2.0.0')]), { prAuthor: 'alice' }).flags, ['escalation']);
    assert.deepEqual(checkEntry(entry([ver('1.0.0', {}, { unlisted: true }), ver('0.9.0')]), entry([ver('1.0.0', {}, { unlisted: true })]), { prAuthor: 'alice' }).flags, ['escalation']);
    assert.deepEqual(checkEntry(entry([ver('1.1.0'), ver('1.0.0')]), null, { prAuthor: 'alice' }).flags, ['new']);
  });
  test('DF-revoked: an added version of an id that a revocation names is flagged revoked', () => {
    const base = entry([ver('1.0.0')]);
    const head = entry([ver('1.1.0'), ver('1.0.0')]);
    const flags = (h, revoked) => checkEntry(h, base, { prAuthor: 'alice', revoked }).flags;
    assert.deepEqual(flags(head, [{ id: 'dev.example.intel', versions: ['1.0.0'] }]), ['revoked']);
    assert.deepEqual(flags(head, [null, 'x', { id: 'dev.example.intel', versions: '*' }]), ['revoked'], 'all versions; a malformed item is skipped');
    assert.deepEqual(flags(head, [{ id: 'dev.other.tool', versions: '*' }]), [], 'another id');
    assert.deepEqual(flags(base, [{ id: 'dev.example.intel', versions: ['1.0.0'] }]), [], 'no added version');
    assert.deepEqual(flags(entry([ver('1.1.0', {}, { unlisted: true }), ver('1.0.0')]), [{ id: 'dev.example.intel', versions: ['1.0.0'] }]), [], 'an unlisted version is never an added one');
    assert.deepEqual(checkEntry(head, base, { prAuthor: 'alice' }).flags, [], 'no revocations given');
  });
  test('DF-base-version-untouched: versions already on base are not re-compared', () => {
    const base = entry([ver('1.1.0', { overlays: true }), ver('1.0.0')]);
    assert.deepEqual(checkEntry(base, base, { prAuthor: 'alice' }).flags, []);
  });
  test('DF-new: no base entry flags new', () => {
    assert.deepEqual(checkEntry(entry([ver('1.0.0')]), null).flags, ['new']);
  });
  test('DF-identity-name: a changed name or author is flagged identity', () => {
    const base = entry([ver('1.0.0')]);
    assert.deepEqual(checkEntry(entry([ver('1.0.0')], { author: 'Someone Else' }), base, { prAuthor: 'alice' }).flags, ['identity']);
    assert.ok(checkEntry(entry([ver('1.0.0')], { name: 'Intel Board 2' }), base, { prAuthor: 'alice' }).flags.includes('identity'));
  });
  test('DF-identity-type: a changed type under the same id is flagged identity', () => {
    const tv = (version) => ({ version });
    assert.deepEqual(checkEntry(entry([tv('1.0.0')], { type: 'theme' }), entry([tv('1.0.0')], { type: 'plugin' }), { prAuthor: 'alice' }).flags, ['identity']);
    assert.deepEqual(checkEntry(entry([ver('1.0.0')], { type: 'plugin' }), entry([ver('1.0.0')], { type: 'plugin' }), { prAuthor: 'alice' }).flags, []);
  });
  test('DF-identity-provenance: a provenance repository that changes (with its source) or is dropped is flagged identity', () => {
    const declared = (repo, extra = {}) => ({ source: `https://github.com/${repo}`, provenance: { repo, ...extra } });
    const base = entry([ver('1.0.0')], declared('example/intel'));
    const flags = (over) => checkEntry(entry([ver('1.0.0')], over), base, { prAuthor: 'alice' }).flags;
    assert.deepEqual(flags(declared('other/intel')), ['identity'], 'another repository');
    assert.deepEqual(flags({ source: 'https://github.com/example/intel' }), ['identity'], 'provenance dropped');
    assert.deepEqual(flags(declared('Example/Intel')), [], 'GitHub names are case-insensitive');
    assert.deepEqual(flags(declared('example/intel', { workflow: '.github/workflows/release.yml' })), [], 'a workflow named in the same repository');
    assert.deepEqual(checkEntry(entry([ver('1.0.0')], declared('example/intel')), entry([ver('1.0.0')], { source: 'https://github.com/example/intel' }), { prAuthor: 'alice' }).flags, [], 'provenance added');
  });
  test('DF-identity-maintainers: any change to the maintainers is flagged identity; order and case are not a change', () => {
    const base = entry([ver('1.0.0')], { maintainers: ['alice', 'bob'] });
    const flags = (maintainers) => checkEntry(entry([ver('1.0.0')], { maintainers }), base, { prAuthor: 'alice' }).flags;
    assert.deepEqual(flags(['alice', 'bob', 'mallory']), ['identity'], 'one added');
    assert.deepEqual(flags(['alice']), ['identity'], 'one removed');
    assert.deepEqual(flags(['alice', 'carol']), ['identity'], 'one replaced');
    assert.deepEqual(flags(undefined), ['identity'], 'all dropped');
    assert.deepEqual(flags(['BOB', 'Alice']), [], 'order and case');
    assert.deepEqual(checkEntry(entry([ver('1.0.0')], { maintainers: [] }), entry([ver('1.0.0')], { maintainers: undefined }), { prAuthor: null }).flags, [], 'none and an empty list');
  });
  test('DF-maintainer: a PR author outside the base maintainers who changes the entry is flagged identity, case-insensitively inside', () => {
    const base = entry([ver('1.0.0')]);
    const head = entry([ver('1.1.0'), ver('1.0.0')]);
    assert.deepEqual(checkEntry(head, base, { prAuthor: 'mallory' }).flags, ['identity']);
    assert.deepEqual(checkEntry(head, base, { prAuthor: 'ALICE' }).flags, []);
    assert.deepEqual(checkEntry(entry([ver('1.0.0')], { summary: 'x' }), base, { prAuthor: 'mallory' }).flags, ['identity'], 'any field');
  });
  test('DF-untouched: an entry whose JSON the PR does not change needs no maintainer (key order aside)', () => {
    const base = entry([ver('1.0.0')]);
    assert.deepEqual(checkEntry(base, base, { prAuthor: 'mallory' }).flags, []);
    const reordered = Object.fromEntries(Object.entries(structuredClone(base)).reverse());
    reordered.versions = reordered.versions.map(v => Object.fromEntries(Object.entries(v).reverse()));
    assert.deepEqual(checkEntry(reordered, base, { prAuthor: 'mallory' }).flags, []);
    assert.equal(sameEntry(reordered, base), true);
    assert.equal(sameEntry(entry([ver('1.0.0', { overlays: true })]), base), false, 'a nested value');
    assert.equal(sameEntry(entry([ver('1.0.0'), ver('0.9.0')]), base), false, 'an array length');
    assert.equal(sameEntry(base, null), false);
  });
  test('DF-first-party: setting firstParty is flagged', () => {
    const base = entry([ver('1.0.0')], { maintainers: [] });
    const r = checkEntry(entry([ver('1.0.0')], { maintainers: [], firstParty: true }), base, { prAuthor: null });
    assert.ok(r.flags.includes('first-party'));
  });
  test('DF-first-party-new: a new first-party entry authored EVE-Cyno passes C3 and is flagged new and first-party', () => {
    const project = (extra = {}) => {
      const x = entry([ver('0.2.0')], { id: 'dev.evecyno.miningledger', name: 'Mining Ledger', author: 'EVE-Cyno', firstParty: true, ...extra });
      if (!('maintainers' in extra)) delete x.maintainers;
      return x;
    };
    const r = checkEntry(project(), null, { prAuthor: 'example-login' });
    assert.deepEqual(r.refusals, []);
    assert.deepEqual(r.flags, ['new', 'first-party']);
    const third = project();
    delete third.firstParty;
    const t = checkEntry(third, null, { prAuthor: 'example-login' });
    assert.deepEqual(t.refusals, ['C3 name or author of dev.evecyno.miningledger is reserved or not allowed'], 'without firstParty');
    assert.deepEqual(t.flags, ['new']);
    const m = checkEntry(project({ maintainers: ['alice'] }), null, { prAuthor: 'alice' });
    assert.deepEqual(m.refusals, ['C3 first-party entry dev.evecyno.miningledger lists maintainers'], 'with maintainers');
    // A first-party entry names no maintainers, so C14 sends every later change of it to review, whoever opens the pull request; C3
    // flags it first-party too (DF-first-party-change).
    const update = project({ versions: [ver('0.3.0'), ver('0.2.0')] });
    const u = checkEntry(update, project(), { prAuthor: 'example-login' });
    assert.deepEqual(u.refusals, []);
    assert.deepEqual(u.flags, ['first-party', 'identity'], 'an update of a first-party entry');
  });
  test('DF-first-party-change: any change to an entry that is first-party on the base or the head is flagged first-party; an untouched one is not', () => {
    const project = (extra = {}) => {
      const x = entry([ver('0.2.0')], { id: 'dev.evecyno.miningledger', name: 'Mining Ledger', author: 'EVE-Cyno', firstParty: true, description: 'Mining totals.', ...extra });
      delete x.maintainers;
      return x;
    };
    const flags = (head, base, prAuthor = 'example-login') => checkEntry(head, base, { prAuthor }).flags;
    assert.deepEqual(flags(project({ description: 'Edited by someone else.' }), project()), ['first-party', 'identity'], 'the description edited by a third-party login');
    assert.deepEqual(flags(project({ description: 'Edited by someone else.' }), project(), null), ['first-party'], 'without a login: first-party all the same');
    const dropped = project();
    delete dropped.firstParty;
    assert.deepEqual(flags(dropped, project(), null), ['first-party'], 'firstParty dropped');
    assert.deepEqual(flags(project(), project()), [], 'an entry the pull request leaves as it was');
    assert.deepEqual(flags(Object.fromEntries(Object.entries(project()).reverse()), project()), [], 'key order is not a change');
    assert.deepEqual(flags(entry([ver('1.0.0')], { description: 'Edited.' }), entry([ver('1.0.0')]), 'alice'), [], 'a change to an entry that is not first-party');
  });
});

describe('engines reach (C17)', () => {
  test('DF-engines-ok: a range that admits the host major passes', () => {
    assert.equal(enginesReach('^1.20.0', '1.27.0'), true);
    assert.equal(enginesReach('>=1.0.0', '1.27.0'), true);
  });
  test('DF-engines-future: a range above the host major is flagged', () => {
    assert.equal(enginesReach('^2.0.0', '1.27.0'), false);
    assert.deepEqual(checkEntry(entry([ver('1.1.0', {}, { engines: '^2.0.0' }), ver('1.0.0')]), entry([ver('1.0.0')]), { prAuthor: 'alice' }).flags, ['engines']);
  });
  test('DF-engines-theme: a theme version has no engines and is never flagged engines', () => {
    const tv = (version) => ({ version });
    assert.deepEqual(checkEntry(entry([tv('2.1.0'), tv('2.0.0')], { type: 'theme' }), entry([tv('2.0.0')], { type: 'theme' }), { prAuthor: 'alice' }).flags, []);
    assert.deepEqual(checkEntry(entry([tv('2.0.0')], { type: 'theme' }), null).flags, ['new']);
  });
  test('DF-engines-garbage: a range that does not parse admits nothing', () => {
    assert.equal(enginesReach('not a range', '1.27.0'), false);
    assert.equal(enginesReach(undefined, '1.27.0'), false);
  });
});

// R1 (plan dp4 W1 3.2, owner answer OQ-3 (a)): every added version whose archive's plugin.json sets `wasm: true` is flagged `wasm`, and
// the reason names its ways out, read through the vendored host's canSendOut (grants.js wasmReach: the required part, every optional
// item and a provided service). check.mjs puts the archive's `wasm`, `permissions` (the optional items included) and the services it
// provides (`provides`) on each version; these tests give them directly.
describe('WebAssembly (R1)', () => {
  const W = '^1.30.0';
  const wv = (version, permissions = {}, extra = {}) => ver(version, permissions, { engines: W, wasm: true, ...extra });
  const flagsOf = (head, base) => checkEntry(head, base, { prAuthor: 'alice' });
  test('DF-wasm-sealed: an added wasm version with no way out is flagged wasm, its reason says no way out', () => {
    const r = flagsOf(entry([wv('1.1.0'), ver('1.0.0')]), entry([ver('1.0.0')]));
    assert.deepEqual(r.flags, ['wasm']);
    assert.deepEqual(r.wasm, [{ version: '1.1.0', ways: [] }]);
    assert.match(wasmReason([]), /no way out/);
  });
  test('DF-wasm-ways: each way out is named: required network, optional network, a consumed service, a provided service, ai, account', () => {
    assert.deepEqual(wasmWays(wv('1.1.0', { network: ['https://a.example'] })), ['required network https://a.example']);
    assert.deepEqual(wasmWays(wv('1.1.0', { optional: { network: ['https://b.example'] } })), ['optional network https://b.example']);
    assert.deepEqual(wasmWays(wv('1.1.0', { services: { 'evecyno.map': '^1.0.0' } })), ['consumed service evecyno.map']);
    assert.deepEqual(wasmWays(wv('1.1.0', {}, { provides: [{ id: 'dev.example.feed', version: '1.0.0' }] })), ['a provided service']);
    assert.deepEqual(wasmWays(wv('1.1.0', { ai: true })), ['ai']);
    assert.deepEqual(wasmWays(wv('1.1.0', { account: true })), ['account']);
    const all = wasmWays(wv('1.1.0', { network: ['https://a.example'], optional: { network: ['https://b.example'] }, services: { 'evecyno.map': '^1.0.0' }, ai: true }));
    assert.deepEqual(all, ['required network https://a.example', 'optional network https://b.example', 'consumed service evecyno.map', 'ai']);
    assert.match(wasmReason(all), /ways out: required network https:\/\/a\.example; optional network https:\/\/b\.example; consumed service evecyno\.map; ai$/);
  });
  test('DF-wasm-not-a-way: files, clipboard, overlays and esi are no way out (canSendOut), so the reason says no way out', () => {
    assert.deepEqual(wasmWays(wv('1.1.0', { files: true, clipboard: ['read'], overlays: true, esi: ['esi-skills.read_skills.v1'] })), []);
  });
  test('DF-wasm-false: wasm false or absent sets no wasm flag', () => {
    assert.deepEqual(flagsOf(entry([ver('1.1.0', {}, { wasm: false }), ver('1.0.0')]), entry([ver('1.0.0')])).flags, []);
    assert.deepEqual(flagsOf(entry([ver('1.1.0'), ver('1.0.0')]), entry([ver('1.0.0')])).wasm, []);
  });
  test('DF-wasm-known: a version already on the base is never flagged again (publish mode against the live catalog)', () => {
    const base = entry([wv('1.1.0'), ver('1.0.0')]);
    assert.deepEqual(flagsOf(base, base).flags, []);
    const r = flagsOf(entry([ver('1.2.0'), wv('1.1.0'), ver('1.0.0')]), base);
    assert.deepEqual(r.wasm, [], 'a later version without wasm');
  });
  test('DF-wasm-each: every added wasm version is flagged with its own ways; a new entry is new and wasm; an unlisted one is not added', () => {
    const r = flagsOf(entry([wv('1.2.0', { ai: true }), wv('1.1.0'), ver('1.0.0')]), entry([ver('1.0.0')]));
    assert.deepEqual(r.wasm, [{ version: '1.2.0', ways: ['ai'] }, { version: '1.1.0', ways: [] }]);
    assert.deepEqual(r.flags.sort(), ['escalation', 'wasm']);
    assert.deepEqual(checkEntry(entry([wv('1.0.0')]), null).flags, ['new', 'wasm']);
    assert.deepEqual(flagsOf(entry([wv('1.1.0', {}, { unlisted: true }), ver('1.0.0')]), entry([ver('1.0.0')])).flags, []);
  });
  test('DF-wasm-no-lower: an added wasm version with nothing to compare with is still flagged wasm', () => {
    assert.deepEqual(flagsOf(entry([wv('2.0.0'), ver('1.5.0')]), entry([ver('2.0.0')])).flags.sort(), ['escalation']);
    assert.deepEqual(flagsOf(entry([wv('1.5.0'), ver('2.0.0')]), entry([ver('2.0.0')])).flags.sort(), ['escalation', 'wasm']);
  });
});
