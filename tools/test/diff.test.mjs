// DF-*: C10, C11, C14, C17 (tools/lib/diff.mjs). Each failing case is the proof of the line it guards (mutants: see the commit message).
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { checkEntry, enginesReach, permissionsDiff } from '../lib/diff.mjs';

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
  test('DF-maintainer: a PR author outside the base maintainers is flagged identity, case-insensitively inside', () => {
    const base = entry([ver('1.0.0')]);
    assert.deepEqual(checkEntry(base, base, { prAuthor: 'mallory' }).flags, ['identity']);
    assert.deepEqual(checkEntry(base, base, { prAuthor: 'ALICE' }).flags, []);
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
  test('DF-engines-garbage: a range that does not parse admits nothing', () => {
    assert.equal(enginesReach('not a range', '1.27.0'), false);
    assert.equal(enginesReach(undefined, '1.27.0'), false);
  });
});
