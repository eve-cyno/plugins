// NM-*: C3 names (tools/lib/diff.mjs checkNames), over the host's listingAdmit and foldName.
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { checkNames } from '../lib/diff.mjs';

const e = (id, name, extra = {}) => ({ id, name, author: 'Example Author', maintainers: ['alice'], versions: [], ...extra });

describe('names (C3)', () => {
  test('NM-ok: an ordinary name passes', () => {
    assert.deepEqual(checkNames(e('dev.example.intel', 'Intel Board'), null, []), []);
  });
  test('NM-reserved: a reserved name is refused', () => {
    assert.equal(checkNames(e('dev.example.a', 'Settings'), null, []).length, 1);
    assert.equal(checkNames(e('dev.example.a', 'EVE-Cyno Tools'), null, []).length, 1);
  });
  test('NM-reserved-cyrillic: a Cyrillic lookalike of a reserved name is refused', () => {
    // U+0443 (Cyrillic u) reads as y, so this folds to contain evecyno.
    assert.equal(checkNames(e('dev.example.a', 'EVE-Cуno Marketplace'), null, []).length, 1);
    assert.equal(checkNames(e('dev.example.a', 'Номе'), null, []).length, 1, 'Cyrillic Home lookalike');
    assert.equal(checkNames(e('dev.example.a', 'Привет'), null, []).length, 0, 'a Cyrillic word that is no lookalike passes');
  });
  test('NM-reserved-author: an author that reads as the host is refused', () => {
    assert.equal(checkNames(e('dev.example.a', 'Fine Name', { author: 'EVE-Cyno Team' }), null, []).length, 1);
  });
  test('NM-first-party: a first-party entry may use a reserved name', () => {
    assert.deepEqual(checkNames(e('eve-cyno.marketplace', 'Marketplace', { firstParty: true, maintainers: [] }), null, []), []);
  });
  test('NM-first-party-maintainers: a first-party entry with maintainers is refused', () => {
    assert.equal(checkNames(e('eve-cyno.x', 'Fine Name', { firstParty: true }), null, []).length, 1);
  });
  test('NM-device-name: an id that starts with a Windows device name is refused', () => {
    assert.equal(checkNames(e('con.example', 'Fine Name'), null, []).length, 1);
  });
  test('NM-lookalike-ascii: a name that folds to another entry\'s is refused', () => {
    assert.equal(checkNames(e('dev.example.b', 'intel-board'), null, [e('dev.example.a', 'Intel Board')]).length, 1);
  });
  test('NM-lookalike-cyrillic: a Cyrillic lookalike of another entry\'s name is refused', () => {
    // U+0456 Cyrillic i and U+043E Cyrillic o read as i and o.
    assert.equal(checkNames(e('dev.example.b', 'Cynо іntel'), null, [e('dev.example.a', 'Cynoi Intel')]).length, 0, 'different words stay apart');
    assert.equal(checkNames(e('dev.example.b', 'Іntel Bоard'), null, [e('dev.example.a', 'Intel Board')]).length, 1);
  });
  test('NM-lookalike-self: an entry never collides with itself, and an unchanged name is not rechecked', () => {
    const a = e('dev.example.a', 'Intel Board');
    assert.deepEqual(checkNames(a, a, [a]), []);
    assert.deepEqual(checkNames(a, a, [e('dev.example.b', 'intel board')]), [], 'an old collision is not this PR\'s');
  });
  test('NM-lookalike-renamed: a rename into a collision is refused', () => {
    assert.equal(checkNames(e('dev.example.a', 'Intel  Board'), e('dev.example.a', 'Old'), [e('dev.example.b', 'Intel Board')]).length, 1);
  });
});
