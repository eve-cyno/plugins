import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';

const read = path => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const manifest = JSON.parse(read('plugin.json'));
const pkg = JSON.parse(read('package.json'));

test('the id is a plugin id and not the host\'s', () => {
  assert.match(manifest.id, /^[a-z][a-z0-9-]*(\.[a-z][a-z0-9-]*){2,}$/);
  assert.ok(manifest.id.length <= 100);
  assert.ok(!manifest.id.startsWith('eve-cyno.host.'));
});

test('the version is the package version and the entry stub names it', () => {
  assert.equal(manifest.version, pkg.version);
  const entry = JSON.parse(read(`entry/${manifest.id}.json`));
  assert.equal(entry.id, manifest.id);
  assert.equal(entry.versions[0].version, manifest.version);
});

test('engines name the API minor the bundled types describe', () => {
  assert.deepEqual(manifest.engines, { 'eve-cyno-api': '^1.30' });
  assert.match(read('types/eve-cyno-plugin-api/index.d.ts'), /export declare function getEveCyno/);
});

test('the plugin asks for no permission, as the README says', () => {
  assert.deepEqual(manifest.permissions, {});
  assert.match(read('README.md'), /no permission/i);
});

test('the main page and its style are in static/', () => {
  assert.equal(manifest.main, 'main.html');
  assert.ok(existsSync(new URL('../static/main.html', import.meta.url)));
  assert.ok(existsSync(new URL('../static/style.css', import.meta.url)));
});

test('every command the tile action names is declared', () => {
  const ids = manifest.contributes.commands.map(c => c.id);
  assert.ok(ids.includes(manifest.contributes.tile.action.command));
});
