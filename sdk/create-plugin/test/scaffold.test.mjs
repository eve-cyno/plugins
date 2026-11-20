// End to end: generate a plugin with the CLI, install TypeScript (offline first), then run the generated build, test, pack,
// entry and check scripts. The built manifest goes through the vendored host's parseManifest, the archive through its reader,
// and tools/check.mjs of this repository must say `refuse` passes and `review` lists only `new`.
// Skipped, with a message, only when typescript 7.0.2 is not in the npm cache (no network is used) and the SDK's own dev dependencies
// are not installed: `npm ci` in sdk/ installs the same TypeScript and so puts it in the cache.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = fileURLToPath(new URL('..', import.meta.url));
const REPO = fileURLToPath(new URL('../../../', import.meta.url));
const BIN = join(HERE, 'bin', 'create-plugin.mjs');
const DIST = join(REPO, 'vendor', 'eve-cyno-host', 'host', 'dist');
const require = createRequire(import.meta.url);
const M = require(join(DIST, 'manifest.js'));
const Z = require(join(DIST, 'market', 'zipread.js'));

const ID = 'com.example.hello-ledger';
const ZIP = `${ID}-0.1.0.zip`;
const URL_ = `https://github.com/example/example-plugin/releases/download/v0.1.0/${ZIP}`;
const sha = b => createHash('sha256').update(b).digest('hex');
const run = (cwd, args) => spawnSync(process.execPath, args, { cwd, encoding: 'utf8', timeout: 240_000 });

test('scaffold: generate, install, build, test, pack, entry, check', { timeout: 600_000 }, t => {
  const work = mkdtempSync(join(tmpdir(), 'scaffold-'));
  t.after(() => rmSync(work, { recursive: true, force: true }));
  const proj = join(work, 'p');
  const g = run(work, [BIN, proj, '--yes', '--id', ID, '--name', 'Hello Ledger', '--author', 'Example Author', '--description', 'Shows a greeting on its tile.']);
  assert.equal(g.status, 0, g.stderr);

  const npm = spawnSync('npm', ['install', '--offline', '--no-audit', '--no-fund'], { cwd: proj, encoding: 'utf8', timeout: 240_000 });
  if (npm.status !== 0) {
    const sdkTypescript = existsSync(join(HERE, '..', 'node_modules', 'typescript', 'package.json'));
    if (/ENOTCACHED|ENOENT.*cache|offline/i.test(`${npm.stderr}${npm.stdout}`) && !sdkTypescript) {
      t.skip('typescript 7.0.2 is not in the npm cache; run `npm ci` in sdk/ once (it needs the network), then run this test again');
      return;
    }
    assert.fail(`npm install --offline failed for a reason other than a cache miss:\n${npm.stderr}`);
  }
  assert.ok(existsSync(join(proj, 'node_modules', 'typescript', 'package.json')), 'typescript was installed');
  const npmRun = (cwd, script, ...rest) => spawnSync('npm', ['run', '--silent', script, ...(rest.length ? ['--', ...rest] : [])], { cwd, encoding: 'utf8', timeout: 240_000 });

  for (const s of ['build', 'test']) {
    const r = npmRun(proj, s);
    assert.equal(r.status, 0, `npm run ${s}: ${r.stdout}${r.stderr}`);
  }
  // the built manifest through the vendored host's parser
  const m = M.parseManifest(JSON.parse(readFileSync(join(proj, 'dist', ID, 'plugin.json'), 'utf8')));
  assert.equal(m.id, ID);
  assert.equal(m.version, '0.1.0');
  assert.equal(m.engines['eve-cyno-api'], '^1.29');
  assert.ok(existsSync(join(proj, 'dist', ID, 'main.js')));

  // pack builds first; two runs, same bytes; a copy with other mtimes too
  assert.equal(npmRun(proj, 'pack').status, 0);
  const zip = readFileSync(join(proj, 'dist', ZIP));
  assert.equal(npmRun(proj, 'pack').status, 0);
  assert.equal(sha(readFileSync(join(proj, 'dist', ZIP))), sha(zip), 'pack is byte-identical across two runs');
  const copy = join(work, 'copy');
  cpSync(proj, copy, { recursive: true, filter: s => !/[\\/](node_modules|dist|build)$/.test(s) });
  symlinkSync(join(proj, 'node_modules'), join(copy, 'node_modules'), 'junction');
  assert.equal(npmRun(copy, 'pack').status, 0);
  assert.equal(sha(readFileSync(join(copy, 'dist', ZIP))), sha(zip), 'a copy packs the same bytes');

  const z = Z.readZip(zip);
  assert.equal(z.ok, true, JSON.stringify(z));
  assert.deepEqual(z.entries.map(e => e.name), ['main.html', 'main.js', 'plugin.json', 'style.css']);

  // entry fills the stub
  const e = npmRun(proj, 'entry', '--url', URL_, '--released', '2026-11-20');
  assert.equal(e.status, 0, e.stderr);
  const ej = join(proj, 'entry', `${ID}.json`);
  const v = JSON.parse(readFileSync(ej, 'utf8')).versions[0];
  assert.equal(v.sha256, sha(zip));
  assert.equal(v.size, zip.length);
  assert.equal(v.engines, '^1.29');
  assert.equal(v.url, URL_);

  // the repository's own tools/check.mjs, direct
  const w = join(work, 'w');
  for (const d of ['base/entries', 'head/entries', 'cache']) mkdirSync(join(w, d), { recursive: true });
  for (const d of ['base', 'head']) writeFileSync(join(w, d, 'revoked.json'), '[]\n');
  cpSync(ej, join(w, 'head', 'entries', `${ID}.json`));
  writeFileSync(join(w, 'cache', `${sha(zip)}.zip`), zip);
  const ck = mode => run(REPO, ['tools/check.mjs', mode, '--base', join(w, 'base'), '--head', join(w, 'head'), '--archive-cache', join(w, 'cache'), '--mirror-url', 'none']);
  const rf = ck('refuse'), rv = ck('review');
  assert.equal(rf.status, 0, rf.stdout);
  assert.match(rf.stdout, /\nCHECKS PASSED\n$/);
  assert.equal(rv.status, 3, rv.stdout);
  assert.match(rv.stdout, /\nNEEDS REVIEW new\n$/);

  // the generated project's own check script agrees
  const c = npmRun(proj, 'check', '--plugins', REPO);
  assert.equal(c.status, 0, `${c.stdout}${c.stderr}`);

  // a handful of the refusals, in the copy
  const refuse = (label, args, re, code = 1) => {
    const r = run(copy, args);
    assert.equal(r.status, code, `${label}: ${r.status} ${r.stdout} ${r.stderr}`);
    assert.match(r.stderr, re, label);
  };
  writeFileSync(join(copy, 'static', 'My Logo.png'), 'x');
  refuse('a name with a space', ['scripts/archive.mjs'], /not a plain name/);
  rmSync(join(copy, 'static', 'My Logo.png'));
  writeFileSync(join(copy, 'static', '.DS_Store'), 'x');
  refuse('a dotfile', ['scripts/build.mjs'], /not a plain name/);
  rmSync(join(copy, 'static', '.DS_Store'));
  mkdirSync(join(copy, 'static', 'empty'));
  refuse('an empty folder', ['scripts/build.mjs'], /empty folder/);
  rmSync(join(copy, 'static', 'empty'), { recursive: true });
  writeFileSync(join(copy, 'static', 'main.js'), '// clash');
  refuse('static/main.js clashes with the compiled one', ['scripts/build.mjs'], /comes from both/);
  rmSync(join(copy, 'static', 'main.js'));
  refuse('entry without --url', ['scripts/entry.mjs'], /--url/, 2);
  refuse('entry with an http URL', ['scripts/entry.mjs', '--url', URL_.replace('https:', 'http:')], /not https/);
  refuse('entry with a query', ['scripts/entry.mjs', '--url', `${URL_}?x=1`], /query/);
  refuse('check without --plugins', ['scripts/check.mjs'], /--plugins/, 2);
  refuse('check on a folder that is no clone', ['scripts/check.mjs', '--plugins', copy], /not a clone/);
  // an archive packed from another plugin.json is refused by entry
  const pj = join(copy, 'plugin.json');
  writeFileSync(pj, readFileSync(pj, 'utf8').replace('"permissions": {}', '"permissions": { "clipboard": true }'));
  refuse('entry on a stale archive', ['scripts/entry.mjs', '--url', URL_], /another plugin\.json/);
});
