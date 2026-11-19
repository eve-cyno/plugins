// DF-*: C10, C11, C14, C17 (tools/lib/diff.mjs). Each failing case is the proof of the line it guards (mutants: see the commit message).
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { checkEntry, enginesReach, permissionsDiff, sameEntry } from '../lib/diff.mjs';

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
