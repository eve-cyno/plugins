// Tests EN-*: entries (tools/lib/entries.mjs): reading, C1 shape, C2 id, C8 version rules, C9 mirror name, the index-build mapping.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, describe, test } from 'node:test';
import {
  readEntries, checkEntry, checkIds, checkVersionRules, mirrorUrl, checkMirrorName, checkCatalogMirrors, toListing, toIndexSource, MARKET_URL_PREFIX,
} from '../lib/entries.mjs';

const temps = [];
after(() => { for (const t of temps) fs.rmSync(t, { recursive: true, force: true }); });
const tempDir = () => { const t = fs.mkdtempSync(path.join(os.tmpdir(), 'en-test-')); temps.push(t); return t; };

const SHA_A = 'a'.repeat(64);
const SHA_B = 'b'.repeat(64);
const SHA_C = 'c'.repeat(64);
const version = (v, sha, extra = {}) => ({
  version: v, released: '2026-12-01', changes: 'Faster.',
  url: `https://github.com/example/intel/releases/download/v${v}/intel-${v}.zip`, sha256: sha, size: 1234,
  engines: '^1.20.0', permissions: { characters: 'selected', network: ['https://api.example.com'] }, ...extra,
});
const entry = (over = {}) => ({
  schema: 1, id: 'dev.example.intel', type: 'plugin', name: 'Intel Board', author: 'Example Author', summary: 'Intel reports on a map',
  description: 'Reads chat logs.\nShows reports.', categories: ['intel'], source: 'https://github.com/example/intel',
  maintainers: ['example-login'], provenance: { repo: 'example/intel', workflow: '.github/workflows/release.yml' },
  versions: [version('1.1.0', SHA_B), version('1.0.0', SHA_A)], ...over,
});
const theme = (over = {}) => ({
  schema: 1, id: 'dev.example.darkish', type: 'theme', name: 'Darkish', author: 'Example Author', summary: 'A dark theme',
  description: '', categories: ['themes'], source: 'https://github.com/example/darkish',
  versions: [{ version: '1.0.0', released: '2026-12-01', changes: '', url: 'https://github.com/example/darkish/releases/download/v1.0.0/d.zip', sha256: SHA_A, size: 99 }], ...over,
});
const problems = (e) => checkEntry(e);
const has = (list, check, re) => list.some(p => p.check === check && (re ? re.test(p.message) : true));

describe('EN reading', () => {
  test('EN-read-ok: reads entries sorted by file name, id from the file name', () => {
    const d = tempDir();
    fs.writeFileSync(path.join(d, 'dev.example.zeta.json'), JSON.stringify(entry({ id: 'dev.example.zeta' })));
    fs.writeFileSync(path.join(d, 'dev.example.intel.json'), JSON.stringify(entry()));
    const r = readEntries(d);
    assert.deepEqual(r.problems, []);
    assert.deepEqual(r.entries.map(e => e.file), ['dev.example.intel.json', 'dev.example.zeta.json']);
    assert.equal(r.entries[0].entry.id, 'dev.example.intel');
  });
  test('EN-read-gitkeep: an empty .gitkeep is the one dotfile allowed', () => {
    const d = tempDir();
    fs.writeFileSync(path.join(d, '.gitkeep'), '');
    assert.deepEqual(readEntries(d), { entries: [], problems: [] });
    fs.writeFileSync(path.join(d, '.gitkeep'), 'x');
    assert.ok(has(readEntries(d).problems, 'C1', /\.gitkeep/), 'a .gitkeep with content');
  });
  test('EN-read-dotfile: any other dotfile is refused (.gitattributes would change every later base)', () => {
    for (const name of ['.gitattributes', '.hidden.json', '.DS_Store']) {
      const d = tempDir();
      fs.writeFileSync(path.join(d, name), '*.json export-ignore\n');
      const r = readEntries(d);
      assert.ok(has(r.problems, 'C1', /<id>\.json/), name);
      assert.equal(r.problems[0].file, name);
    }
    const g = tempDir();
    fs.mkdirSync(path.join(g, '.github'));
    assert.ok(has(readEntries(g).problems, 'C1', /<id>\.json/), 'a dot folder');
  });
  test('EN-read-bad-json: not JSON is a C1 problem, never a throw', () => {
    const d = tempDir();
    fs.writeFileSync(path.join(d, 'dev.example.intel.json'), '{ nope');
    const r = readEntries(d);
    assert.equal(r.entries.length, 0);
    assert.ok(has(r.problems, 'C1', /not JSON/));
  });
  test('EN-read-not-object: an array or null is refused', () => {
    const d = tempDir();
    fs.writeFileSync(path.join(d, 'dev.example.intel.json'), '[]');
    assert.ok(has(readEntries(d).problems, 'C1', /object/));
  });
  test('EN-read-stray-file: a non-.json file is refused', () => {
    const d = tempDir();
    fs.writeFileSync(path.join(d, 'notes.txt'), 'x');
    assert.ok(has(readEntries(d).problems, 'C1', /\.json/));
  });
  test('EN-read-symlink-and-dir: a link or a folder is refused', () => {
    const d = tempDir();
    fs.writeFileSync(path.join(d, 'real.json'), '{}');
    fs.symlinkSync(path.join(d, 'real.json'), path.join(d, 'dev.example.link.json'));
    fs.mkdirSync(path.join(d, 'dev.example.dir.json'));
    const r = readEntries(d);
    assert.ok(r.problems.filter(p => /regular file/.test(p.message)).length === 2);
  });
});

describe('EN C1 shape', () => {
  test('EN-c1-valid: plugin and theme pass', () => {
    assert.deepEqual(problems(entry()), []);
    assert.deepEqual(problems(theme()), []);
  });
  test('EN-c1-valid-no-optionals: no maintainers, provenance or workflow', () => {
    const e = entry(); delete e.maintainers; delete e.provenance;
    assert.deepEqual(problems(e), []);
    assert.deepEqual(problems(entry({ provenance: { repo: 'example/intel' } })), []);
  });
  test('EN-c1-unknown-key: an unknown entry or version key is refused', () => {
    assert.ok(has(problems(entry({ flag: true })), 'C1'));
    const e = entry(); e.versions[0].extra = 1;
    assert.ok(has(problems(e), 'C1'));
  });
  test('EN-c1-schema-number: schema must be 1', () => {
    assert.ok(has(problems(entry({ schema: 2 })), 'C1'));
  });
  test('EN-c1-sha256: 64 lower hex only', () => {
    for (const bad of ['A'.repeat(64), 'a'.repeat(63), 'a'.repeat(65), 'g'.repeat(64)]) {
      const e = entry(); e.versions[0].sha256 = bad;
      assert.ok(has(problems(e), 'C1'), bad);
    }
  });
  test('EN-c1-size: 1 to 33,554,432', () => {
    for (const [size, ok] of [[0, false], [1, true], [33554432, true], [33554433, false], [1.5, false], ['9', false]]) {
      const e = entry(); e.versions[0].size = size;
      assert.equal(problems(e).length === 0, ok, String(size));
    }
  });
  test('EN-c1-url: canonical https only, no userinfo, query, fragment, over 2048', () => {
    const base = 'https://github.com/example/intel/releases/download/v1.1.0/i.zip';
    for (const bad of ['http://github.com/a.zip', 'https://u:p@github.com/a.zip', `${base}?x=1`, `${base}#f`, 'https://GitHub.com/a.zip',
      `https://github.com/${'a'.repeat(2048)}.zip`, 'ftp://github.com/a.zip', 'not a url']) {
      const e = entry(); e.versions[0].url = bad;
      assert.ok(has(problems(e), 'C1'), bad);
    }
  });
  test('EN-c1-maintainers: at most 5 GitHub logins', () => {
    assert.ok(has(problems(entry({ maintainers: ['a', 'b', 'c', 'd', 'e', 'f'] })), 'C1'));
    assert.deepEqual(problems(entry({ maintainers: ['a', 'b', 'c', 'd', 'e'] })), []);
    assert.deepEqual(problems(entry({ maintainers: [] })), []);
    for (const bad of ['has space', 'a'.repeat(40), '', 'ünï', 'a_b']) assert.ok(has(problems(entry({ maintainers: [bad] })), 'C1'), bad);
  });
  test('EN-c1-provenance: owner/name only', () => {
    for (const bad of ['example', 'a/b/c', 'https://github.com/a/b', '/b', 'a/']) assert.ok(has(problems(entry({ provenance: { repo: bad } })), 'C1'), bad);
    assert.ok(has(problems(entry({ provenance: { repo: 'a/b', extra: 1 } })), 'C1'));
    assert.ok(has(problems(entry({ provenance: { workflow: 'x.yml' } })), 'C1'));
  });
  test('EN-c1-versions-required: a plugin needs at least one version', () => {
    assert.ok(has(problems(entry({ versions: [] })), 'C1'));
  });
  test('EN-c1-theme-no-engines: a theme version has no engines or permissions', () => {
    const t = theme(); t.versions[0].engines = '^1.0.0';
    assert.ok(has(problems(t), 'C1'));
    const u = theme(); u.versions[0].permissions = {};
    assert.ok(has(problems(u), 'C1'));
  });
  test('EN-c1-host-listing: the host listingProblem refuses a bad field', () => {
    const bad = problems(entry({ summary: 'two\nlines' }));
    assert.ok(has(bad, 'C1', /host/), JSON.stringify(bad));
    assert.ok(has(problems(entry({ type: 'widget' })), 'C1'));
  });
  test('EN-c1-host-category: an unknown category is refused (the app would remove it)', () => {
    assert.ok(has(problems(entry({ categories: ['intel', 'nonsense'] })), 'C1'));
  });
  test('EN-c1-host-order: versions not newest first are refused by the read-back', () => {
    const bad = problems(entry({ versions: [version('1.0.0', SHA_A), version('1.1.0', SHA_B)] }));
    assert.ok(bad.length > 0);
  });
  test('EN-c1-host-permissions: a malformed permissions object is refused', () => {
    const e = entry(); e.versions[0].permissions = { network: ['http://api.example.com'] };
    assert.ok(has(problems(e), 'C1'));
  });
  test('EN-c1-never-throws: junk input gives problems, not an exception', () => {
    for (const junk of [null, 5, 'x', [], { versions: 5 }, { id: 5 }]) assert.ok(problems(junk).length > 0);
  });
});

describe('EN C2 id', () => {
  const f = (file, e) => ({ file, entry: e });
  test('EN-c2-ok', () => assert.deepEqual(checkIds([f('dev.example.intel.json', entry())]), []));
  test('EN-c2-filename: file name must equal id', () => {
    assert.ok(has(checkIds([f('other.example.name.json', entry())]), 'C2', /file name/));
  });
  test('EN-c2-bad-id: not a plugin id', () => {
    for (const id of ['intel', 'Dev.Example.Intel', 'dev.example', 'dev..example.x']) {
      assert.ok(has(checkIds([f(`${id}.json`, entry({ id }))]), 'C2', /plugin id/), id);
    }
  });
  test('EN-c2-host-prefix: eve-cyno.host. is reserved', () => {
    assert.ok(has(checkIds([f('eve-cyno.host.x.json', entry({ id: 'eve-cyno.host.x' }))]), 'C2', /reserved/));
  });
  test('EN-c2-device-name: a Windows device name as first segment', () => {
    for (const id of ['nul.example.intel', 'com1.example.intel', 'con.example.intel']) {
      assert.ok(has(checkIds([f(`${id}.json`, entry({ id }))]), 'C2', /device/), id);
    }
  });
  test('EN-c2-unique: the same id in two files', () => {
    const r = checkIds([f('dev.example.intel.json', entry()), f('dev.example.intel.json.bak.json', entry())]);
    assert.ok(has(r, 'C2', /duplicate/));
  });
  test('EN-c2-id-not-string: no throw', () => {
    assert.ok(has(checkIds([f('x.json', { id: 5 })]), 'C2'));
  });
});

describe('EN C8 version rules', () => {
  test('EN-c8-ok-new-version', () => {
    const base = entry();
    const head = entry({ versions: [version('1.2.0', SHA_C), ...base.versions] });
    assert.deepEqual(checkVersionRules(head, base), []);
  });
  test('EN-c8-no-base: a new entry is checked for order only', () => {
    assert.deepEqual(checkVersionRules(entry(), null), []);
  });
  test('EN-c8-unlist-allowed: removing an old version is fine', () => {
    assert.deepEqual(checkVersionRules(entry({ versions: [version('1.1.0', SHA_B)] }), entry()), []);
  });
  test('EN-c8-order: not newest first', () => {
    assert.ok(has(checkVersionRules(entry({ versions: [version('1.0.0', SHA_A), version('1.1.0', SHA_B)] }), null), 'C8', /newest first/));
  });
  test('EN-c8-duplicate-version', () => {
    assert.ok(has(checkVersionRules(entry({ versions: [version('1.0.0', SHA_A), version('1.0.0', SHA_B)] }), null), 'C8'));
  });
  test('EN-c8-semver-not-string-order: 1.10.0 is above 1.9.0', () => {
    assert.deepEqual(checkVersionRules(entry({ versions: [version('1.10.0', SHA_B), version('1.9.0', SHA_A)] }), null), []);
  });
  test('EN-c8-prerelease-order: 1.0.0 is above 1.0.0-rc.1', () => {
    assert.deepEqual(checkVersionRules(entry({ versions: [version('1.0.0', SHA_B), version('1.0.0-rc.1', SHA_A)] }), null), []);
  });
  test('EN-c8-immutable-url / sha / size', () => {
    for (const [k, v] of [['url', 'https://github.com/example/other/a.zip'], ['sha256', SHA_C], ['size', 4321]]) {
      const head = entry(); head.versions[1][k] = v;
      assert.ok(has(checkVersionRules(head, entry()), 'C8', /1\.0\.0/), k);
    }
  });
  test('EN-c8-new-below-base-max: an added version must exceed every base version', () => {
    const head = entry({ versions: [version('1.1.0', SHA_B), version('1.0.5', SHA_C), version('1.0.0', SHA_A)] });
    assert.ok(has(checkVersionRules(head, entry()), 'C8', /1\.0\.5/));
  });
  test('EN-c8-new-below-base-max-after-unlist: unlisting the top does not lower the floor', () => {
    const head = entry({ versions: [version('1.0.5', SHA_C), version('1.0.0', SHA_A)] });
    assert.ok(has(checkVersionRules(head, entry()), 'C8', /1\.0\.5/));
  });
  test('EN-c8-bad-semver: no throw', () => {
    assert.ok(has(checkVersionRules(entry({ versions: [version('nope', SHA_A)] }), null), 'C8'));
    assert.ok(checkVersionRules({}, null).length > 0);
  });
});

describe('EN C9 mirror name', () => {
  test('EN-c9-url', () => assert.equal(mirrorUrl(SHA_A), `${MARKET_URL_PREFIX}archives/${SHA_A}.zip`));
  test('EN-c9-ok', () => assert.equal(checkMirrorName(mirrorUrl(SHA_A), SHA_A), null));
  test('EN-c9-wrong-name: any other name, even one the client accepts', () => {
    for (const u of [`${MARKET_URL_PREFIX}archives/intel.zip`, `${MARKET_URL_PREFIX}archives/${SHA_B}.zip`, `${MARKET_URL_PREFIX}archives/${SHA_A}.ZIP`,
      `${MARKET_URL_PREFIX}other/${SHA_A}.zip`, `https://evil.example/v1/archives/${SHA_A}.zip`, `${MARKET_URL_PREFIX}archives/${SHA_A}.zip?x=1`, 5, undefined]) {
      assert.match(checkMirrorName(u, SHA_A) ?? '', /mirror/, String(u));
    }
  });
  test('EN-c9-toListing: the listing carries the mirror URL, never the author URL', () => {
    const l = toListing(entry());
    for (const v of l.versions) assert.equal(v.archive.url, mirrorUrl(v.archive.sha256));
    assert.deepEqual(checkCatalogMirrors({ plugins: [l] }), []);
  });
  test('EN-c9-catalog: a tampered catalog is named by id and version', () => {
    const l = toListing(entry());
    l.versions[1].archive.url = `${MARKET_URL_PREFIX}archives/x.zip`;
    const r = checkCatalogMirrors({ plugins: [l] });
    assert.equal(r.length, 1);
    assert.equal(r[0].check, 'C9');
    assert.match(r[0].message, /dev\.example\.intel 1\.0\.0/);
  });
});

describe('EN mapping to the index-build source', () => {
  const arch = (id, v) => `archives/${id}-${v}.zip`;
  test('EN-map-shape: known fields only, archive from the callback, no url/sha/size/maintainers/provenance', () => {
    const s = toIndexSource([entry()], [], arch);
    assert.equal(s.plugins.length, 1);
    const p = s.plugins[0];
    assert.deepEqual(Object.keys(p).sort(), ['author', 'categories', 'description', 'id', 'name', 'source', 'summary', 'type', 'versions']);
    assert.deepEqual(p.versions[0], {
      version: '1.1.0', released: '2026-12-01', changes: 'Faster.', archive: 'archives/dev.example.intel-1.1.0.zip',
      engines: '^1.20.0', permissions: { characters: 'selected', network: ['https://api.example.com'] },
    });
    assert.deepEqual(s.revoked, []);
  });
  test('EN-map-theme: no engines or permissions key', () => {
    const v = toIndexSource([theme()], [], arch).plugins[0].versions[0];
    assert.equal('engines' in v, false);
    assert.equal('permissions' in v, false);
  });
  test('EN-map-firstParty: kept when set', () => {
    const e = entry({ firstParty: true }); delete e.maintainers;
    assert.equal(toIndexSource([e], [], arch).plugins[0].firstParty, true);
  });
  test('EN-map-sorted: by id', () => {
    const s = toIndexSource([entry({ id: 'dev.example.zeta' }), entry(), theme()], [], arch);
    assert.deepEqual(s.plugins.map(p => p.id), ['dev.example.darkish', 'dev.example.intel', 'dev.example.zeta']);
  });
  test('EN-map-revoked-version: that version is left out, the list is kept in the source', () => {
    const rev = [{ id: 'dev.example.intel', versions: ['1.0.0'], reason: 'Bad', date: '2026-12-02' }];
    const s = toIndexSource([entry()], rev, arch);
    assert.deepEqual(s.plugins[0].versions.map(v => v.version), ['1.1.0']);
    assert.deepEqual(s.revoked, rev);
  });
  test('EN-map-revoked-all: a listing whose every version is revoked is left out', () => {
    const star = [{ id: 'dev.example.intel', versions: '*', reason: 'Bad', date: '2026-12-02' }];
    assert.deepEqual(toIndexSource([entry()], star, arch).plugins, []);
    const both = [{ id: 'dev.example.intel', versions: ['1.0.0', '1.1.0'], reason: 'Bad', date: '2026-12-02' }];
    assert.deepEqual(toIndexSource([entry()], both, arch).plugins, []);
  });
  test('EN-map-revoked-other-id: another id does not touch it', () => {
    const rev = [{ id: 'dev.example.other', versions: '*', reason: 'Bad', date: '2026-12-02' }];
    assert.equal(toIndexSource([entry()], rev, arch).plugins.length, 1);
  });
  test('EN-map-no-mutation: the inputs are not changed', () => {
    const e = entry(); const copy = structuredClone(e);
    toIndexSource([e], [], arch);
    assert.deepEqual(e, copy);
  });
});
