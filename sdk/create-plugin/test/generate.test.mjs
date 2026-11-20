import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { GenerateError, render, validateAnswers, writeProject } from '../lib/generate.mjs';
import { authorProblem, displayProblem, idProblem, nameProblem } from '../lib/rules.mjs';

const HERE = fileURLToPath(new URL('..', import.meta.url));
const REPO = fileURLToPath(new URL('../../../', import.meta.url));
const BIN = join(HERE, 'bin', 'create-plugin.mjs');
const DIST = join(REPO, 'vendor', 'eve-cyno-host', 'host', 'dist');
const require = createRequire(import.meta.url);
const M = require(join(DIST, 'manifest.js'));
const Z = require(join(DIST, 'market', 'zipread.js'));
const N = require(join(DIST, 'market', 'names.js'));

const ANSWERS = { id: 'com.example.hello-ledger', name: 'Hello Ledger', author: 'Example Author', description: 'Shows a greeting on its tile.' };
const tmp = () => mkdtempSync(join(tmpdir(), 'create-plugin-'));

function walk(dir, base = dir, out = new Map()) {
  for (const e of readdirSync(dir).sort()) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) walk(p, base, out);
    else out.set(p.slice(base.length + 1), readFileSync(p));
  }
  return out;
}

test('render: the file map for fixed answers', () => {
  const files = render(ANSWERS);
  assert.deepEqual([...files.keys()], [
    '.gitignore',
    'README.md',
    'entry/com.example.hello-ledger.json',
    'package.json',
    'plugin.json',
    'scripts/archive.mjs',
    'scripts/build.mjs',
    'scripts/check.mjs',
    'scripts/entry.mjs',
    'scripts/zip.mjs',
    'src/main.ts',
    'static/main.html',
    'static/style.css',
    'test/manifest.test.mjs',
    'tsconfig.json',
    'types/eve-cyno-plugin-api/LICENSE',
    'types/eve-cyno-plugin-api/index.d.ts',
  ]);
});

test('render: no licence file and no copyright holder; the README states MIT-0 and asks the author to add a licence', () => {
  const files = render(ANSWERS);
  assert.ok(!files.has('LICENSE'), 'no LICENSE: a licence names its copyright holder, and the project is the author\'s');
  for (const [path, content] of files) {
    if (path.startsWith('types/')) continue; // the API's declarations keep their own MIT licence and notice
    assert.doesNotMatch(String(content), /Copyright|Bythlak/i, path);
  }
  const readme = files.get('README.md');
  assert.match(readme, /The files this project started from are under MIT-0 \("MIT No Attribution"/);
  assert.match(readme, /you owe no notice/);
  assert.match(readme, /add a `LICENSE` file with the licence you pick and a `license` field to `package\.json`/);
});

test('render: plugin.json carries the answers, the API minor and no permission', () => {
  const m = JSON.parse(render(ANSWERS).get('plugin.json'));
  assert.equal(m.id, ANSWERS.id);
  assert.equal(m.name, ANSWERS.name);
  assert.equal(m.author, ANSWERS.author);
  assert.equal(m.description, ANSWERS.description);
  assert.equal(m.version, '0.1.0');
  assert.deepEqual(m.engines, { 'eve-cyno-api': '^1.29' });
  assert.deepEqual(m.permissions, {});
  assert.equal(m.main, 'main.html');
  assert.deepEqual(m.activationEvents, ['onStartup']);
  assert.ok(m.contributes.commands.some(c => c.id === m.contributes.tile.action.command));
});

test('render: the manifest passes the vendored host parseManifest', () => {
  const m = M.parseManifest(JSON.parse(render(ANSWERS).get('plugin.json')));
  assert.equal(m.id, ANSWERS.id);
  assert.equal(m.version, '0.1.0');
});

test('render: awkward but valid answers stay valid JSON and HTML', () => {
  const a = { id: 'com.example.quote-test', name: 'A "quoted" <b> & name', author: 'O\'Neil \\ Co', description: 'Line "one" & <two>.' };
  assert.deepEqual(validateAnswers(a), []);
  const files = render(a);
  const m = M.parseManifest(JSON.parse(files.get('plugin.json')));
  assert.equal(m.name, a.name);
  const entry = JSON.parse(files.get('entry/com.example.quote-test.json'));
  assert.equal(entry.author, a.author);
  const html = files.get('static/main.html');
  assert.ok(!html.includes('<b>'));
  assert.ok(html.includes('&lt;b&gt; &amp;'));
});

test('render: the entry stub has the index fields and no provenance', () => {
  const e = JSON.parse(render(ANSWERS).get('entry/com.example.hello-ledger.json'));
  assert.equal(e.schema, 1);
  assert.equal(e.id, ANSWERS.id);
  assert.equal(e.type, 'plugin');
  assert.equal(e.name, ANSWERS.name);
  assert.equal(e.author, ANSWERS.author);
  assert.equal(e.summary, ANSWERS.description);
  assert.deepEqual(e.categories, ['tools']);
  assert.equal(e.source, null);
  assert.deepEqual(e.maintainers, []);
  assert.ok(!('provenance' in e));
  assert.equal(e.versions.length, 1);
  assert.equal(e.versions[0].version, '0.1.0');
  assert.equal(e.versions[0].engines, '^1.29');
  assert.deepEqual(e.versions[0].permissions, {});
  assert.match(e.versions[0].url, /^https:\/\//);
});

test('render: the generated package.json is private, builds with typescript 7.0.2 only', () => {
  const p = JSON.parse(render(ANSWERS).get('package.json'));
  assert.equal(p.private, true);
  assert.equal(p.type, 'module');
  assert.ok(!('license' in p));
  assert.deepEqual(Object.keys(p.scripts).sort(), ['build', 'check', 'entry', 'pack', 'test']);
  assert.deepEqual(p.devDependencies, { typescript: '7.0.2' });
  assert.ok(!p.dependencies);
  assert.equal(p.version, '0.1.0');
});

test('determinism: two writes of the same answers give the same bytes', () => {
  const a = join(tmp(), 'one');
  const b = join(tmp(), 'two');
  writeProject(a, ANSWERS);
  writeProject(b, ANSWERS);
  const wa = walk(a), wb = walk(b);
  assert.deepEqual([...wa.keys()], [...wb.keys()]);
  for (const [k, v] of wa) assert.ok(v.equals(wb.get(k)), k);
  assert.deepEqual([...wa.keys()], [...render(ANSWERS).keys()].sort());
});

test('determinism: different ids change the entry file name and nothing else is shared by accident', () => {
  const x = render({ ...ANSWERS, id: 'com.example.other-one' });
  assert.ok(x.has('entry/com.example.other-one.json'));
  assert.ok(!x.has('entry/com.example.hello-ledger.json'));
});

test('bundled types equal the vendored plugin-api 1.29.0 byte for byte', () => {
  const vendor = join(REPO, 'sdk', 'vendor', 'plugin-api');
  const files = render(ANSWERS);
  assert.ok(Buffer.from(files.get('types/eve-cyno-plugin-api/index.d.ts')).equals(readFileSync(join(vendor, '1.29.0.d.ts'))));
  assert.ok(Buffer.from(files.get('types/eve-cyno-plugin-api/LICENSE')).equals(readFileSync(join(vendor, 'LICENSE'))));
});

test('package.json eveCynoApi, the template engines range and the vendored pin agree', () => {
  const pkg = JSON.parse(readFileSync(join(HERE, 'package.json'), 'utf8'));
  const pin = JSON.parse(readFileSync(join(REPO, 'sdk', 'vendor', 'plugin-api', 'PIN.json'), 'utf8'));
  assert.equal(pkg.eveCynoApi, pin.version);
  assert.equal(pkg.name, '@eve-cyno/create-plugin');
  assert.equal(pkg.private, true);
  assert.equal(pkg.license, 'MIT');
  assert.deepEqual(Object.keys(pkg.bin), ['create-plugin']);
  assert.ok(!('publishConfig' in pkg));
  assert.ok(!('dependencies' in pkg));
  const [major, minor] = pin.version.split('.');
  assert.equal(JSON.parse(render(ANSWERS).get('plugin.json')).engines['eve-cyno-api'], `^${major}.${minor}`);
  assert.equal(M.HOST_API.version, pin.version);
  assert.deepEqual(pkg.files.sort(), ['LICENSE', 'README.md', 'bin/', 'lib/', 'template/']);
});

test('the template holds no host (PolyForm) file and no token is left unfilled', () => {
  for (const [path, content] of render(ANSWERS)) {
    assert.ok(!path.includes('vendor'), path);
    if (!path.startsWith('types/')) assert.ok(!String(content).includes('{{'), path);
  }
});

const BAD = [
  ['an id with capitals', { id: 'Com.Example.Tool' }],
  ['an id with two segments', { id: 'example.tool' }],
  ['an id of the host prefix', { id: 'eve-cyno.host.tool' }],
  ['an id holding the host mark', { id: 'com.evecyno.tool' }],
  ['an id holding the host mark with a hyphen', { id: 'com.example.eve-cyno-tool' }],
  ['an id whose first segment is a device name', { id: 'nul.example.tool' }],
  ['a long id', { id: `com.example.${'a'.repeat(100)}` }],
  ['an empty name', { name: '' }],
  ['a name over 60 characters', { name: 'n'.repeat(61) }],
  ['a name with a newline', { name: 'two\nlines' }],
  ['a reserved name', { name: 'Settings' }],
  ['a name that reads as the host', { name: 'EVE Cyno Helper' }],
  ['an author that reads as the host', { author: 'The EVE-Cyno Team' }],
  ['no author', { author: '' }],
  ['a description over 120 characters', { description: 'd'.repeat(121) }],
  ['an empty description', { description: '' }],
];

for (const [label, patch] of BAD) {
  test(`refusal writes nothing: ${label}`, () => {
    const dir = join(tmp(), 'out');
    const answers = { ...ANSWERS, ...patch };
    assert.notDeepEqual(validateAnswers(answers), []);
    assert.throws(() => writeProject(dir, answers), GenerateError);
    assert.ok(!existsSync(dir));
  });
}

test('refusal writes nothing: a non-empty target folder is left as it was', () => {
  const dir = join(tmp(), 'out');
  mkdirSync(dir);
  writeFileSync(join(dir, 'keep.txt'), 'mine');
  assert.throws(() => writeProject(dir, ANSWERS), GenerateError);
  assert.deepEqual(readdirSync(dir), ['keep.txt']);
});

test('an existing empty folder is accepted', () => {
  const dir = join(tmp(), 'out');
  mkdirSync(dir);
  writeProject(dir, ANSWERS);
  assert.ok(existsSync(join(dir, 'plugin.json')));
});

test('rules agree with the vendored host: ids', () => {
  const ids = [
    'com.example.tool', 'dev.me.tool-2', 'a.b.c', 'com.example.a-b-c.d', 'Com.example.tool', 'example.tool', 'com..tool', 'com.example.-tool',
    'com.example.tool_x', '1com.example.tool', 'eve-cyno.host.tool', 'eve-cyno.hostile.tool', 'nul.example.tool', 'COM1.example.tool', 'com1.example.tool',
    'com.example.con', 'aux.example.tool', 'lpt3.a.b', `com.example.${'a'.repeat(100)}`, 'com.example.tool.', '',
  ];
  for (const id of ids) {
    const host = M.isPluginId(id) && !id.startsWith(M.HOST_ID_PREFIX) && !Z.isDeviceNameId(id);
    const mine = idProblem(id) === null;
    // the scaffold also refuses the host's mark inside an id (stricter than the host); every other id answers alike
    const mark = /evei?cyno/.test(id.toLowerCase().replace(/[^a-z0-9]/g, '').replace(/l/g, 'i'));
    assert.equal(mine, host && !mark, `id ${JSON.stringify(id)}`);
  }
});

const NAMES = [
  'Hello Ledger', 'Mining Ledger', 'Cyno Tool', 'My Home', 'Home', 'home', 'HOME', 'Settings', 'settings!', 'Characters', 'Marketplace', 'Market',
  'EVE-Cyno', 'eve cyno', 'EVECYNO', 'EVE Cyno Helper', 'My EVE-Cyno Tool', 'EVE|Cyno', 'EVElCyno', 'EVE1Cyno', 'eve_cyno', 'e.v.e c.y.n.o', 'EVE-Cyn0', 'H0me', '3VE Cyno', 'EVE5Cyno',
  'ＥＶＥ-Cyno', 'Settings', 'Hóme', 'Café Tool', 'Zażółć gęślą', '\u{1F680} Rocket', 'Rocket \u{1F680}',
];

test('rules agree with the vendored host: names and authors (ASCII and NFKC forms)', () => {
  for (const s of NAMES) {
    const host = N.nameAllowed({ name: s, author: undefined }, 'market', false) === true;
    assert.equal(nameProblem(s) === null, host && M.isDisplayText(s, 60), `name ${JSON.stringify(s)}`);
    const hostA = N.nameAllowed({ name: 'Fine', author: s }, 'market', false) === true;
    assert.equal(authorProblem(s) === null, hostA && M.isDisplayText(s, 60), `author ${JSON.stringify(s)}`);
  }
});

test('rules agree with the vendored host: display text', () => {
  const texts = ['', ' ', 'a', ' padded ', 'tab\there', 'bell\u0007', 'zero​width', 'bidi‮flip', 'ok - fine', '⠀', 'é́', 'é́́',
    '\u{1F468}‍\u{1F469}', 'a‍b', '️', 'a️', 'x'.repeat(60), 'x'.repeat(61), 'ㅤ', 'privateuse', '   ', '...', ' nbsp'];
  for (const s of texts) {
    assert.equal(displayProblem(s.trim(), 60) === null, M.isDisplayText(s.trim(), 60), `text ${JSON.stringify(s)}`);
    assert.equal(displayProblem(s.trim(), 5) === null, M.isDisplayText(s.trim(), 5), `text(5) ${JSON.stringify(s)}`);
  }
});

test('CLI: --version prints the scaffold and the API version', () => {
  const out = execFileSync(process.execPath, [BIN, '--version'], { encoding: 'utf8' });
  assert.match(out, /^@eve-cyno\/create-plugin 0\.\d+\.\d+ \(plugin API 1\.29\.0\)\n$/);
});

test('CLI: --yes with every answer writes the project', () => {
  const cwd = tmp();
  const r = spawnSync(process.execPath, [BIN, 'proj', '--id', ANSWERS.id, '--name', ANSWERS.name, '--author', ANSWERS.author, '--description', ANSWERS.description, '--yes'], { cwd, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual([...walk(join(cwd, 'proj')).keys()], [...render(ANSWERS).keys()].sort());
});

test('CLI: the folder defaults to the last id segment and the name to its title case', () => {
  const cwd = tmp();
  const r = spawnSync(process.execPath, [BIN, '--id', 'com.example.hello-ledger', '--author', 'Me', '--yes'], { cwd, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  const m = JSON.parse(readFileSync(join(cwd, 'hello-ledger', 'plugin.json'), 'utf8'));
  assert.equal(m.name, 'Hello Ledger');
  assert.equal(m.author, 'Me');
});

test('CLI: prompts read the missing answers from stdin', () => {
  const cwd = tmp();
  const r = spawnSync(process.execPath, [BIN, 'asked'], { cwd, encoding: 'utf8', input: `${ANSWERS.id}\n${ANSWERS.name}\n${ANSWERS.author}\n${ANSWERS.description}\n` });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(JSON.parse(readFileSync(join(cwd, 'asked', 'plugin.json'), 'utf8')).id, ANSWERS.id);
});

test('CLI: a refusal exits 1, names the problem and writes nothing', () => {
  const cwd = tmp();
  const r = spawnSync(process.execPath, [BIN, 'proj', '--id', 'Bad.Id', '--author', 'Me', '--yes'], { cwd, encoding: 'utf8' });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /id/);
  assert.ok(!existsSync(join(cwd, 'proj')));
});

test('CLI: --yes without an id or an author is a usage error and writes nothing', () => {
  const cwd = tmp();
  const r = spawnSync(process.execPath, [BIN, 'proj', '--yes'], { cwd, encoding: 'utf8' });
  assert.equal(r.status, 2);
  assert.deepEqual(readdirSync(cwd), []);
});

test('CLI: an unknown flag is refused', () => {
  const r = spawnSync(process.execPath, [BIN, '--nope'], { cwd: tmp(), encoding: 'utf8' });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /--nope/);
});
