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
  // POLICY.md: the EVE-Cyno name or author is reserved for entries marked firstParty, which only the project merges.
  const project = (extra = {}) => {
    const x = e('dev.evecyno.miningledger', 'Mining Ledger', { author: 'EVE-Cyno', firstParty: true, ...extra });
    if (!('maintainers' in extra)) delete x.maintainers;
    return x;
  };
  test('NM-first-party-author: a first-party entry authored EVE-Cyno, with no maintainers, passes', () => {
    assert.deepEqual(checkNames(project(), null, []), []);
    assert.deepEqual(checkNames(project({ maintainers: [] }), null, []), [], 'an empty maintainers list is none');
    assert.deepEqual(checkNames(project({ name: 'EVE-Cyno Mining Ledger' }), null, []), [], 'the host\'s name too');
  });
  test('NM-first-party-author-unset: the same entry without firstParty === true is refused', () => {
    for (const fp of [undefined, false, 'true', 1]) {
      const x = project({ firstParty: fp });
      if (fp === undefined) delete x.firstParty;
      assert.deepEqual(checkNames(x, null, []), ['C3 name or author of dev.evecyno.miningledger is reserved or not allowed'], `firstParty ${String(fp)}`);
    }
    const third = project({ maintainers: ['alice'] });
    delete third.firstParty;
    assert.deepEqual(checkNames(third, null, []), ['C3 name or author of dev.evecyno.miningledger is reserved or not allowed'], 'a third party with maintainers');
  });
  test('NM-third-party-lookalike: a third-party name or author that reads as EVE-Cyno is refused', () => {
    // ASCII forms, a stroke where the hyphen was, separators, fullwidth (NFKC), Greek and Cyrillic letters (confusables).
    const forms = ['EVE-Cyno', 'EVE-Cyno Tools', 'eve cyno', 'EVECYNO', 'EVEIcyno', 'EVElCyno', 'EVE1Cyno', 'EVE|Cyno', 'E.V.E-Cyno',
      'ＥＶＥ－Ｃｙｎｏ', 'ΕVΕ-Cyno', 'EVE-Cуno', 'EVE-Суnо', 'Team ЕVЕ‑Cyno'];
    for (const f of forms) {
      assert.equal(checkNames(e('dev.example.a', 'Fine Name', { author: f }), null, []).length, 1, `author ${f}`);
      assert.equal(checkNames(e('dev.example.a', f), null, []).length, 1, `name ${f}`);
    }
  });
  test('NM-first-party-author-maintainers: a first-party entry authored EVE-Cyno that lists maintainers is refused', () => {
    assert.deepEqual(checkNames(project({ maintainers: ['alice'] }), null, []), ['C3 first-party entry dev.evecyno.miningledger lists maintainers']);
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
