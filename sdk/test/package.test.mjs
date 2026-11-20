// The SDK package itself: `npm test` runs every test of the SDK, and the package pins, with a lockfile, the TypeScript that the
// template's projects build with. `npm ci` in sdk/ so puts that TypeScript in the npm cache, which the scaffold test installs from
// offline: on a machine that ran it, the scaffold test runs instead of skipping.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { render } from '../create-plugin/lib/generate.mjs';

const SDK = fileURLToPath(new URL('..', import.meta.url));
const pkg = JSON.parse(readFileSync(join(SDK, 'package.json'), 'utf8'));
const GLOBS = ['site/test/**/*.test.mjs', 'create-plugin/test/**/*.test.mjs', 'test/**/*.test.mjs'];

/** Every *.test.mjs file under `dir`, relative to the SDK, with / separators; node_modules and the template are not SDK tests. */
function testFiles(dir, out = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    const rel = relative(SDK, p).split(sep).join('/');
    if (e.isDirectory()) { if (e.name !== 'node_modules' && rel !== 'create-plugin/template') testFiles(p, out); } else if (e.name.endsWith('.test.mjs')) out.push(rel);
  }
  return out;
}

test('npm test runs the site, create-plugin and SDK tests, and no SDK test is outside them', () => {
  for (const g of GLOBS) assert.ok(pkg.scripts.test.includes(`"${g}"`), `npm test runs ${g}`);
  const files = testFiles(SDK);
  assert.ok(files.length >= 10, `${files.length} test files`);
  for (const f of files) assert.ok(GLOBS.some((g) => f.startsWith(g.slice(0, g.indexOf('**')))), `${f} is run by npm test`);
});

test('the SDK pins the template\'s TypeScript as a dev dependency, with a lockfile', () => {
  const want = JSON.parse(render({ id: 'dev.example.my-plugin', name: 'My Plugin', author: 'Example Author', description: 'A plugin.' }).get('package.json')).devDependencies.typescript;
  assert.match(want, /^\d+\.\d+\.\d+$/, 'the template pins an exact version');
  assert.equal(pkg.devDependencies?.typescript, want);
  const lock = JSON.parse(readFileSync(join(SDK, 'package-lock.json'), 'utf8'));
  assert.equal(lock.packages[''].devDependencies.typescript, want);
  const ts = lock.packages['node_modules/typescript'];
  assert.equal(ts.version, want);
  assert.match(ts.integrity, /^sha512-/);
  assert.ok(!pkg.dependencies, 'the SDK has no runtime dependency');
});

test('the SDK needs the Node of the scaffold package (zlib.crc32 of the template zip script)', () => {
  const scaffold = JSON.parse(readFileSync(join(SDK, 'create-plugin', 'package.json'), 'utf8'));
  assert.equal(pkg.engines?.node, scaffold.engines.node);
});
