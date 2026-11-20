// Task 1.5: the trust pages (Local testing, Permissions and grants, Archive rules, Checks C1 to C17, Signing and the index).
// Every example a page marks accept or refuse runs here through the vendored host code (the manifest parser, the names rule, the zip
// reader and the installer's staged checks), and every list or number a page repeats is compared with the code it comes from: the
// data allowlist, the shared hosts, the revocable kinds, the permission keys, the zip limits, the listing fields, the check ids, the
// review classes and the index limits. The examples are read from the page source (site/content/<slug>.md) and must be on the built
// page exactly as written.
import assert from 'node:assert/strict';
import { closeSync, existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { ARCHIVE_TOTAL_MS, MAX_REDIRECTS } from '../../../tools/lib/archives.mjs';
import { checkEntry as reviewEntry, checkNames } from '../../../tools/lib/diff.mjs';
import { checkIds } from '../../../tools/lib/entries.mjs';
import { zip } from '../../../tools/test/zipwrite.mjs';
import { build, readChecks, REPO_ROOT } from '../build.mjs';
import { namespacesOf, parseDts } from '../lib/dts.mjs';

const require = createRequire(import.meta.url);
const HOST = join(REPO_ROOT, 'vendor', 'eve-cyno-host', 'host', 'dist');
const { parseManifest, SHARED_HOSTS, DEFAULT_STORAGE_MB, OPTIONAL_API } = require(join(HOST, 'manifest.js'));
const { requested, REVOKE_KINDS, GrantStore, ensureGrant } = require(join(HOST, 'grants.js'));
const { toWindowInfo } = require(join(HOST, 'windowsview.js'));
const { nameAllowed } = require(join(HOST, 'market', 'names.js'));
const { DATA_ALLOWLIST, PACK_IDS } = require(join(HOST, 'dataallow.js'));
const { readZip, ZIP_LIMITS, entryNameProblem } = require(join(HOST, 'market', 'zipread.js'));
const { checkStagedPlugin } = require(join(HOST, 'market', 'stagecheck.js'));
const I = require(join(HOST, 'market', 'indexformat.js'));
const { inspectPluginDir, openPluginFile } = require(join(HOST, 'loader.js'));

const SDK = join(REPO_ROOT, 'sdk');
const API_VERSION = JSON.parse(readFileSync(join(SDK, 'vendor', 'plugin-api', 'PIN.json'), 'utf8')).version;
const NAMESPACE_NAMES = new Set(namespacesOf(parseDts(readFileSync(join(SDK, 'vendor', 'plugin-api', `${API_VERSION}.d.ts`), 'utf8'))).map((n) => n.name));
const SCHEMA = JSON.parse(readFileSync(join(HOST, 'schemas', 'manifest.v1.json'), 'utf8'));
const CONTENT = fileURLToPath(new URL('../content/', import.meta.url));
const PAGES = ['local-testing', 'permissions', 'packaging', 'checks', 'signing'];
const MiB = 1024 * 1024;

const tmp = mkdtempSync(join(tmpdir(), 'plugin-docs-trust-'));
let off;
let live;
before(() => {
  off = build({ out: join(tmp, 'off'), indexLive: false }).out;
  live = build({ out: join(tmp, 'live'), indexLive: true }).out;
});
after(() => rmSync(tmp, { recursive: true, force: true }));

const html = (out, slug) => readFileSync(join(out, 'plugins', slug, 'index.html'), 'utf8');
const unesc = (s) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&');
const mainOf = (out, slug) => /<main[\s\S]*<\/main>/.exec(html(out, slug))[0];
const textOf = (page) => unesc(page.replace(/<(script|style|svg)[\s\S]*?<\/\1>/g, ' ').replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ');
const source = (slug) => readFileSync(join(CONTENT, `${slug}.md`), 'utf8').replace(/\r\n?/g, '\n');
const ticks = (s) => [...s.matchAll(/`([^`]+)`/g)].map((m) => m[1]);
/** The one source line that starts with `lead`. */
const lineOf = (slug, lead) => {
  const lines = source(slug).split('\n').filter((l) => l.startsWith(lead));
  assert.equal(lines.length, 1, `${slug}: one line starts with "${lead}"`);
  return lines[0];
};

/** The source list item that starts with `- <lead>`, its continuation lines joined to it with one space. */
const bulletOf = (slug, lead) => {
  const lines = source(slug).split('\n');
  const at = lines.findIndex((l) => l.startsWith(`- ${lead}`));
  assert.ok(at >= 0, `${slug}: a list item starts with "- ${lead}"`);
  const item = [lines[at]];
  for (let i = at + 1; i < lines.length && /^ {2}\S/.test(lines[i]); i++) item.push(lines[i].trim());
  return item.join(' ');
};
/** The sentences of a Markdown text (a full stop, a question mark or an exclamation mark ends one). */
const sentencesOf = (text) => text.split(/(?<=[.!?])\s+/).filter(Boolean);

/** The rows of the source table whose header row starts with `| <first> |`, as cell lists (raw Markdown). */
function tableOf(slug, first) {
  const lines = source(slug).split('\n');
  const at = lines.findIndex((l) => new RegExp(`^\\|\\s*${first}\\s*\\|`).test(l));
  assert.ok(at >= 0, `${slug}: a table headed "${first}"`);
  const rows = [];
  for (let i = at + 2; i < lines.length && lines[i].startsWith('|'); i++) {
    const cells = [];
    let cur = '';
    let code = false;
    for (const c of lines[i].trim().slice(1, -1)) {
      if (c === '`') code = !code;
      if (c === '|' && !code) { cells.push(cur.trim()); cur = ''; } else cur += c;
    }
    cells.push(cur.trim());
    rows.push(cells);
  }
  return rows;
}

/**
 * The fenced blocks of a page source. Words after the language: `accept`, `refuse:<code>`, and test data the page never shows:
 * `why:<words>` (a fragment of the refusal message, `_` for a space), `ignored:<kind>` (accepted, but a third-party plugin gets no
 * grant for it), `kept:<kind>` (accepted, and a third-party plugin is asked for it).
 */
function fences(slug) {
  const out = [];
  const lines = source(slug).split('\n');
  for (let i = 0; i < lines.length; i++) {
    const m = /^(`{3,})(\S*)\s*(.*)$/.exec(lines[i]);
    if (!m) continue;
    const body = [];
    for (i++; i < lines.length && lines[i] !== m[1]; i++) body.push(lines[i]);
    const words = m[3].split(/\s+/).filter(Boolean);
    const of = (k) => words.filter((w) => w.startsWith(`${k}:`)).map((w) => w.slice(k.length + 1));
    const refuse = words.find((w) => w === 'refuse' || w.startsWith('refuse:'));
    out.push({
      slug, lang: m[2] || 'text', verdict: words.includes('accept') ? 'accept' : refuse ? 'refuse' : null, code: refuse?.split(':')[1] ?? '',
      why: of('why').map((w) => w.replaceAll('_', ' '))[0], ignored: of('ignored'), kept: of('kept'), body: body.join('\n'),
    });
  }
  return out;
}
const examples = () => PAGES.flatMap((slug) => fences(slug).filter((f) => f.verdict));

// ---- the plugin every archive example and loader case is made of: the template's answers, nothing asked for

const LISTING = { id: 'dev.example.my-plugin', name: 'My Plugin', author: 'Example Author' };
const VERSION = { version: '0.1.0', engines: '^1.29', permissions: {} };
const MANIFEST = { ...LISTING, version: VERSION.version, engines: { 'eve-cyno-api': VERSION.engines }, main: 'main.html', permissions: {} };

/** Whether a parsed manifest's request (the host's `requested`) holds `kind` for a built-in plugin (`builtIn`) or any other. */
function asks(p, builtIn, kind) {
  const g = requested(p, builtIn);
  if (kind === 'database') return g.databaseMB > 0;
  if (kind === 'chatlogs') return g.logs.includes('chatlogs');
  throw new Error(`unknown grant kind ${kind}`);
}

function runManifest(f) {
  const at = `${f.slug}: ${f.body.slice(0, 80)}`;
  const m = JSON.parse(f.body);
  if (f.verdict === 'accept') {
    const p = parseManifest(m);
    assert.equal(nameAllowed(p, 'manual', false), true, at);
    for (const k of f.ignored) { assert.equal(asks(p, false, k), false, `${at}: ${k} ignored`); assert.equal(asks(p, true, k), true, `${at}: ${k} for built-in`); }
    for (const k of f.kept) assert.equal(asks(p, false, k), true, `${at}: ${k} kept`);
    return;
  }
  assert.ok(f.code, `${at}: a refuse block names its code`);
  if (f.code === 'reserved_name' || f.code === 'reserved_author') {
    assert.equal(nameAllowed(parseManifest(m), 'manual', false), f.code, at);
    return;
  }
  assert.throws(() => parseManifest(m), (e) => e.code === f.code && (!f.why || e.message.includes(f.why)), at);
}

/** An archive example: one entry name per line; `plugin.json (field: "value")` writes that field over the template manifest. */
function runArchive(f) {
  const entries = f.body.split('\n').filter((l) => l.trim()).map((line) => {
    const m = /^(\S+)(?:\s+\((\w+): "([^"]*)"\))?$/.exec(line.trim());
    assert.ok(m, `${f.slug}: archive line "${line}"`);
    const [, name, key, value] = m;
    if (name.endsWith('/')) return { name };
    const data = /(^|\/)plugin\.json$/.test(name) ? JSON.stringify({ ...MANIFEST, ...(key ? { [key]: value } : {}) }) : `/* ${name} */\n`;
    return { name, data };
  });
  const r = readZip(zip(entries));
  if (!r.ok) return r.reason;
  const root = mkdtempSync(join(tmp, 'stage-'));
  const s = checkStagedPlugin(r.entries, root, LISTING, VERSION);
  return s.ok ? null : s.error;
}

// ---- tests

test('the five trust pages have their written text, with no stub or draft note', () => {
  for (const slug of PAGES) {
    assert.ok(existsSync(join(CONTENT, `${slug}.md`)), `site/content/${slug}.md exists`);
    for (const out of [off, live]) {
      const text = textOf(mainOf(out, slug));
      assert.doesNotMatch(text, /This page is a stub|written in a later step|\bDraft\b/, slug);
    }
  }
});

test('every accept and refuse block on the trust pages is on the built page exactly as written', () => {
  for (const slug of PAGES) {
    const src = fences(slug).filter((f) => f.verdict);
    const shown = [...html(off, slug).matchAll(/<span class="code-label">([^<]*)<\/span><span class="badge badge-(ok|bad)">(accept|refuse)<\/span>[\s\S]*?<pre><code>([\s\S]*?)<\/code><\/pre>/g)];
    assert.deepEqual(
      shown.map((b) => [unesc(b[1]), b[3], unesc(b[4])]),
      src.map((f) => [[f.lang, f.verdict === 'refuse' ? f.code : ''].filter(Boolean).join(' · '), f.verdict, f.body]),
      slug,
    );
  }
});

test('manifest examples: accept passes the vendored parser and names rule, refuse fails with the code (and message) it names', () => {
  const all = examples().filter((f) => f.lang === 'json');
  assert.ok(all.filter((f) => f.verdict === 'accept').length >= 3, 'three or more accept blocks');
  assert.ok(all.filter((f) => f.verdict === 'refuse').length >= 5, 'five or more refuse blocks');
  assert.ok(all.some((f) => f.ignored.includes('database')) && all.some((f) => f.ignored.includes('chatlogs')) && all.some((f) => f.kept.includes('chatlogs')));
  for (const f of all) runManifest(f);
});

test('archive examples: accept passes the vendored zip reader and staged install checks, refuse fails with the code it names', () => {
  const all = examples().filter((f) => f.lang === 'zip');
  assert.ok(all.some((f) => f.verdict === 'accept'));
  assert.ok(new Set(all.filter((f) => f.verdict === 'refuse').map((f) => f.code)).size >= 3, 'three or more refusal codes');
  for (const f of all) assert.equal(runArchive(f), f.verdict === 'accept' ? null : f.code, `${f.slug}: ${f.body}`);
});

test('every block with a verdict is a manifest or an archive example', () => {
  for (const f of examples()) assert.ok(['json', 'zip'].includes(f.lang), `${f.slug}: ${f.lang} block`);
});

test('permissions: the built-in ids named are DATA_ALLOWLIST, and every pack is named', () => {
  const text = textOf(mainOf(off, 'permissions'));
  assert.deepEqual([...new Set(text.match(/\bdev\.evecyno\.[a-z][a-z0-9-]*/g))].sort(), [...DATA_ALLOWLIST.keys()].sort());
  for (const p of PACK_IDS) assert.ok(text.includes(p), p);
  assert.deepEqual([...new Set([...DATA_ALLOWLIST.values()].flat())].sort(), [...PACK_IDS].sort());
});

test('permissions: the table has one row per schema permission key, and names only API namespaces', () => {
  const rows = tableOf('permissions', 'Key');
  const keys = rows.map((r) => /^`([^`]+)`$/.exec(r[0])?.[1]);
  assert.deepEqual([...keys].sort(), Object.keys(SCHEMA.properties.permissions.properties).sort());
  for (const r of rows) for (const ns of ticks(r[1])) assert.ok(NAMESPACE_NAMES.has(ns), `${r[0]}: ${ns} is a namespace`);
});

test('permissions: the shared hosts are SHARED_HOSTS and the revocable parts are REVOKE_KINDS', () => {
  assert.deepEqual(ticks(lineOf('permissions', 'The shared hosts are')).sort(), [...SHARED_HOSTS].sort());
  assert.deepEqual(ticks(lineOf('permissions', 'Settings > Privacy can take back')).sort(), [...REVOKE_KINDS].sort());
  const rows = new Map(tableOf('permissions', 'Key').map((r) => [r[0], r[2]]));
  assert.ok(rows.get('`storage`').includes(`the default is ${DEFAULT_STORAGE_MB} MB`));
  const optional = OPTIONAL_API.split('.').slice(0, 2).join('.');
  assert.ok(rows.get('`optional`').includes(`\`^${optional}\``) && source('permissions').includes(`Optional items need \`^${optional}\``));
});

test('permissions: optional items count for the chat-log rule switched on or off, for window names only when granted', async () => {
  // The page: one intro that says nothing about optional items, and each rule with its own optional-item sentence.
  const lines = source('permissions').split('\n');
  const at = lines.findIndex((l) => l.startsWith('A plugin can send data out when'));
  assert.ok(at >= 0, 'the "can send data out" paragraph');
  const intro = lines.slice(at, lines.indexOf('', at)).join(' ');
  assert.doesNotMatch(intro, /optional/i, 'the shared intro names no optional-item rule');
  const chat = bulletOf('permissions', 'gets no `chat`');
  const names = bulletOf('permissions', 'sees no character name');
  assert.match(chat, /Optional items count here whether the user switches them on or off/);
  assert.match(names, /Here only what the user granted counts: an optional item the user switched off is no way out/);
  // The host: a plugin whose only way out is an optional origin, installed with that origin switched off and with it switched on.
  const m = parseManifest({ ...MANIFEST, permissions: { windows: true, logs: ['chatlogs'], optional: { network: ['https://api.example.com'] } } });
  const client = { id: 1, kind: 'client', character: 'Example Pilot', x: 0, y: 0, w: 800, h: 600, minimized: false };
  const other = { id: 2, kind: 'other', extra: 'example-program', x: 0, y: 0, w: 800, h: 600, minimized: false };
  const root = mkdtempSync(join(tmp, 'grants-'));
  for (const declined of [true, false]) {
    const store = new GrantStore(join(root, `${declined}.json`));
    store.load();
    let asked;
    const prompter = { ask: async (q) => { asked = q; return { decision: 'allow', ...(declined ? { declined: { network: ['https://api.example.com'] } } : {}) }; } };
    const g = await ensureGrant(store, prompter, m, {}, undefined, { recordDeny: false, fresh: true });
    const at2 = declined ? 'origin switched off' : 'origin switched on';
    // Chat logs: dropped from the request whatever the switch says, so the prompt never asks and the grant never holds them.
    assert.ok(!asked.delta.logs.includes('chatlogs'), `${at2}: the prompt does not ask for chatlogs`);
    assert.ok(!g.logs.includes('chatlogs') && !store.get(m.id).granted.logs.includes('chatlogs'), `${at2}: no chatlogs granted`);
    // Window names and classes: read from the stored grant, which never holds a declined item.
    assert.equal(store.get(m.id).granted.network.length, declined ? 0 : 1, `${at2}: the stored grant`);
    const ctx = { granted: g, hostKey: Buffer.alloc(32), pluginId: m.id, providesServices: false, active: 1, toDip: (r) => r, vault: new Map() };
    assert.equal(toWindowInfo(client, ctx).character, declined ? client.character : undefined, `${at2}: WindowInfo.character`);
    assert.equal(toWindowInfo(other, ctx).windowClass, declined ? other.extra : undefined, `${at2}: windowClass`);
  }
});

test('archive rules: the limits table is ZIP_LIMITS, the name segment rule and MAX_ARCHIVE_BYTES', () => {
  const rows = new Map(tableOf('packaging', 'Limit').map((r) => [r[0], r[1]]));
  // One name of 255 bytes is the most; with two-byte letters it is reached at 128 characters, inside the path limit.
  assert.equal(entryNameProblem('é'.repeat(127)), null);
  assert.equal(entryNameProblem('é'.repeat(128)), 'too_long');
  assert.equal(entryNameProblem('a'.repeat(ZIP_LIMITS.maxPath)), null);
  assert.equal(entryNameProblem('a'.repeat(ZIP_LIMITS.maxPath + 1)), 'too_long');
  const want = {
    Entries: `${ZIP_LIMITS.maxEntries}`,
    'Unpacked size': `${ZIP_LIMITS.maxUnpacked / MiB} MiB`,
    'Archive file': `${I.MAX_ARCHIVE_BYTES / MiB} MiB`,
    'Compression of one entry': `${ZIP_LIMITS.maxRatio} times`,
    'Path length': `${ZIP_LIMITS.maxPath} characters`,
    'Folder depth': `${ZIP_LIMITS.maxDepth}`,
    'One name in a path': '255 bytes',
  };
  assert.deepEqual([...rows.keys()].sort(), Object.keys(want).sort());
  for (const [k, v] of Object.entries(want)) assert.ok(rows.get(k).includes(v), `${k}: ${v} in "${rows.get(k)}"`);
});

test('archive rules: the listing fields named are the ones listingDifference compares', () => {
  const body = /function listingDifference\([^)]*\) \{([\s\S]*?)\n\}/.exec(readFileSync(join(HOST, 'market', 'indexformat.js'), 'utf8'))[1];
  const compared = [...body.matchAll(/return '(\w+)'/g)].map((m) => m[1]);
  assert.deepEqual(compared, ['id', 'version', 'name', 'author', 'engines', 'permissions']);
  assert.deepEqual(ticks(lineOf('packaging', 'The listing repeats')), compared);
});

test('checks: one row per check id the index tools name, and the review classes in CLASSES order with the checks that set them', () => {
  const { checkIds, classes } = readChecks(REPO_ROOT);
  assert.deepEqual(tableOf('checks', 'Check').map((r) => r[0]), checkIds);
  const tool = readFileSync(join(REPO_ROOT, 'tools', 'check.mjs'), 'utf8');
  const setBy = new Map(classes.map((c) => [c, new Set()]));
  const map = /\{ (new: [^}]*)\}\[f\]/.exec(tool)[1];
  for (const m of map.matchAll(/'?([a-z-]+)'?: '([C\d ]+)'/g)) for (const id of m[2].split(' ')) setBy.get(m[1]).add(id);
  for (const m of tool.matchAll(/R\.flag\('([a-z-]+)', '(C\d+)'/g)) setBy.get(m[1]).add(m[2]);
  const rows = tableOf('checks', 'Class');
  assert.deepEqual(rows.map((r) => ticks(r[0])[0]), classes);
  for (const r of rows) assert.deepEqual(r[1].split(/,\s*/).sort(), [...setBy.get(ticks(r[0])[0])].sort(), r[0]);
});

test('checks: the C2 and C3 rows and the first-party class are the id, name and first-party rules of the index tools', () => {
  const rows = new Map(tableOf('checks', 'Check').map((r) => [r[0], r[2]]));
  // C2: both reserved id prefixes, the project's one bound to FIRST_PARTY_ID_PREFIX of tools/lib/entries.mjs.
  const fp = /\bconst FIRST_PARTY_ID_PREFIX = '([^']+)';/.exec(readFileSync(join(REPO_ROOT, 'tools', 'lib', 'entries.mjs'), 'utf8'))?.[1];
  assert.ok(fp, 'FIRST_PARTY_ID_PREFIX in tools/lib/entries.mjs');
  const { HOST_ID_PREFIX } = require(join(HOST, 'manifest.js'));
  const c2 = rows.get('C2');
  assert.ok(c2.includes(`does not start with \`${HOST_ID_PREFIX}\``), `C2 names ${HOST_ID_PREFIX}`);
  assert.ok(c2.includes(`does not start with \`${fp}\` unless the entry is first-party`), `C2 names ${fp} for first-party entries only`);
  const file = (id, extra = {}) => ({ file: `${id}.json`, entry: { id, ...extra } });
  assert.ok(checkIds([file(`${fp}my-plugin`)]).some((p) => p.check === 'C2' && p.message.includes(fp)), `${fp} without firstParty`);
  assert.deepEqual(checkIds([file(`${fp}my-plugin`, { firstParty: true })]), [], `${fp} with firstParty`);
  assert.ok(checkIds([file(`${HOST_ID_PREFIX}my-plugin`, { firstParty: true })]).some((p) => p.message.includes(HOST_ID_PREFIX)), `${HOST_ID_PREFIX} even first-party`);
  // C3: a reserved name is refused unless the entry is first-party; a first-party entry with maintainers is refused.
  assert.match(rows.get('C3'), /a reserved name or author \(allowed in a first-party entry only\)/);
  assert.match(rows.get('C3'), /a first-party entry that lists maintainers/);
  const entry = { ...LISTING, type: 'plugin', versions: [] };
  assert.equal(checkNames({ ...entry, name: 'EVE-Cyno Tools' }, null, []).length, 1);
  assert.deepEqual(checkNames({ ...entry, name: 'EVE-Cyno Tools', firstParty: true }, null, []), []);
  assert.equal(checkNames({ ...entry, firstParty: true, maintainers: ['example-author'] }, null, []).length, 1);
  // The first-party class: any change to an entry that is first-party before or after the pull request, a firstParty flip included.
  const when = tableOf('checks', 'Class').find((r) => ticks(r[0])[0] === 'first-party')[2];
  assert.match(when, /first-party \(`firstParty: true`\) before or after the pull request, and the pull request changes anything in it, setting or dropping `firstParty` included/);
  const fpFlag = (head, base) => reviewEntry(head, base).flags.includes('first-party');
  const fpEntry = { ...entry, firstParty: true };
  assert.equal(fpFlag({ ...fpEntry, summary: 'Changed.' }, fpEntry), true, 'a first-party entry changed elsewhere than its flag');
  assert.equal(fpFlag(fpEntry, fpEntry), false, 'a first-party entry left as it was');
  assert.equal(fpFlag(fpEntry, entry), true, 'firstParty set');
  assert.equal(fpFlag(entry, fpEntry), true, 'firstParty dropped');
  assert.equal(fpFlag(fpEntry, null), true, 'a new first-party entry');
  assert.equal(fpFlag({ ...entry, summary: 'Changed.' }, entry), false, 'a change to an entry that is not first-party');
});

test('checks: the C4 download bounds are the index tools\' own, and the local run is the template\'s command', () => {
  const c4 = tableOf('checks', 'Check').find((r) => r[0] === 'C4')[2];
  for (const v of [`${MAX_REDIRECTS} redirects`, `${I.ARCHIVE_IDLE_MS / 1000} s`, `${ARCHIVE_TOTAL_MS / 1000} s`, `${I.MAX_ARCHIVE_BYTES / MiB} MiB`]) assert.ok(c4.includes(v), `C4: ${v}`);
  const md = source('checks');
  assert.ok(md.includes('npm run check -- --plugins <clone>'));
  const tpl = readFileSync(join(SDK, 'create-plugin', 'template', 'scripts', 'check.mjs'), 'utf8');
  for (const line of ['the index checks pass', 'a maintainer reviews it', 'the clone has no node_modules: run npm ci in it once', '--mirror-url', 'gh attestation verify']) {
    assert.ok(tpl.includes(line), `template: ${line}`);
  }
  const tool = readFileSync(join(REPO_ROOT, 'tools', 'check.mjs'), 'utf8');
  for (const v of ['CHECKS PASSED', 'CHECKS FAILED', 'NEEDS REVIEW', 'NO REVIEW NEEDED']) assert.ok(tool.includes(v) && md.includes(v), v);
});

test('signing: the sizes, times, trusted comment and names are the host\'s index constants', () => {
  const md = source('signing');
  const want = [
    `${I.MAX_HEAD_BYTES / 1024} KiB`, `${I.MAX_CATALOG_BYTES / MiB} MiB`, `${I.MAX_ARCHIVE_BYTES / MiB} MiB`,
    `${I.MAX_INDEX_LIFETIME_MS / 86_400_000} days`, `${I.INDEX_EVERY_MS / 3_600_000} hours`, `${I.INDEX_RETRY_MS / 60_000} minutes`,
    I.indexComment('<generated>'), I.catalogUrl('', '<sha256>'), 'archives/<sha256>.zip',
  ];
  for (const v of want) assert.ok(md.includes(v), v);
  assert.ok(I.isRevocationReason('x'.repeat(200)) && !I.isRevocationReason('x'.repeat(201)));
  assert.ok(md.includes('200 characters'));
  assert.ok(readFileSync(join(REPO_ROOT, 'tools', 'check.mjs'), 'utf8').includes('archives/<sha256>.zip'));
});

test('local testing: a folder plugin passes the installed-plugin checks of the vendored loader', { skip: process.platform === 'win32' && 'links need rights on Windows' }, () => {
  const root = mkdtempSync(join(tmp, 'folder-'));
  const make = (name, edit = () => {}) => {
    const dir = join(root, name);
    mkdirSync(dir);
    writeFileSync(join(dir, 'plugin.json'), JSON.stringify(MANIFEST));
    writeFileSync(join(dir, 'main.html'), '<!doctype html>\n');
    edit(dir);
    return name;
  };
  const refused = (name) => { const r = inspectPluginDir(root, name, true, true); return r !== null && 'refused' in r; };
  // The folder name is free for a picked folder; in the installed root it must be the id.
  const free = make('build-output');
  assert.equal(inspectPluginDir(root, free, true, true).manifest.id, MANIFEST.id);
  assert.ok('refused' in inspectPluginDir(root, free, true, false));
  // A linked folder, a linked main file, a hard-linked main file.
  symlinkSync(join(root, free), join(root, 'linked'));
  assert.ok(refused('linked'));
  assert.ok(refused(make('main-link', (d) => { rmSync(join(d, 'main.html')); writeFileSync(join(d, 'page.html'), 'x'); symlinkSync('page.html', join(d, 'main.html')); })));
  const hard = make('main-hard', (d) => linkSync(join(d, 'main.html'), join(root, 'main-copy.html')));
  assert.ok(refused(hard));
  assert.ok(!('refused' in inspectPluginDir(root, hard, false, true)), 'only the strict (installed) rule refuses a hard link');
  // plugin.json: a symbolic link is refused, a second hard link is not (the manifest reader has no link-count rule).
  assert.ok(refused(make('json-link', (d) => { writeFileSync(join(d, 'manifest.json'), JSON.stringify(MANIFEST)); rmSync(join(d, 'plugin.json')); symlinkSync('manifest.json', join(d, 'plugin.json')); })));
  const jsonHard = make('json-hard', (d) => linkSync(join(d, 'plugin.json'), join(root, 'plugin-copy.json')));
  assert.equal(inspectPluginDir(root, jsonHard, true, true).manifest.id, MANIFEST.id, 'a hard-linked plugin.json loads');
  // A file the page asks for: never one with a second hard link, never a link.
  const files = make('files', (d) => { writeFileSync(join(d, 'app.js'), 'x'); linkSync(join(d, 'app.js'), join(root, 'app-copy.js')); symlinkSync('main.html', join(d, 'alias.html')); });
  const dir = join(root, files);
  assert.equal(openPluginFile(dir, 'app.js', true), null);
  assert.equal(openPluginFile(dir, 'alias.html', true), null);
  const okFile = openPluginFile(dir, 'main.html', true);
  assert.ok(okFile && typeof okFile.fd === 'number');
  closeSync(okFile.fd);
  const md = source('local-testing');
  for (const phrase of [/folder name/i, /symbolic link/i, /hard link/i, /`id_taken`/]) assert.match(md, phrase);
  // The page's link rule names, for a second hard link, only the files the loader counts links of: `main` and a served file.
  const links = sentencesOf(bulletOf('local-testing', '**No links.**'));
  const hardLinked = links.filter((s) => /hard link/.test(s));
  assert.ok(hardLinked.length >= 2, 'a hard-link sentence for main and one for a served file');
  assert.deepEqual([...new Set(hardLinked.flatMap(ticks))], ['main'], 'a hard-link sentence names main and no other file');
  assert.ok(hardLinked.some((s) => /file the page loads/.test(s)), 'a hard-link sentence for a served file');
  assert.ok(links.some((s) => ticks(s).includes('plugin.json') && /symbolic link/.test(s) && !/hard link/.test(s)), 'plugin.json: no symbolic link');
});

test('the trust pages reuse no heading of the parts generated after them', () => {
  for (const slug of PAGES) {
    const h2 = [...mainOf(off, slug).matchAll(/<h2 id="([^"]+)">/g)].map((m) => m[1]);
    const twice = h2.filter((id) => { const m = /^(.+)-\d+$/.exec(id); return m !== null && h2.includes(m[1]); });
    assert.deepEqual(twice, [], `${slug}: a heading that is there twice`);
  }
});

test('the trust page sources name no internal path, runbook, secret, key id or host outside the list', () => {
  const allowedHosts = new Set(['eve-cyno.dev', 'data.eve-cyno.dev', 'example.com', 'api.example.com', 'github.com', 'images.evetech.net', 'raw.githubusercontent.com', ...SHARED_HOSTS]);
  const banned = [/host\/src/, /renderer-src|hostui|hostapi/, /\bselftest/i, /\brunbook/i, /\bsecrets?\b/i, /\benvironments?\b/i, /test build/i, /In this repository/,
    /store-core/, /npm --prefix/, /dev\.evecyno\.\*/, /\b[0-9A-F]{16}\b/, /\bowner\b/i];
  for (const slug of PAGES) {
    const md = source(slug);
    for (const re of banned) assert.doesNotMatch(md, re, `${slug}: ${re}`);
    for (const m of md.matchAll(/\b[\w-]+(?:\/[\w.-]+)*\.ts\b/g)) assert.ok(m[0] === 'src/main.ts' || m[0].endsWith('.d.ts'), `${slug}: ${m[0]}`);
    for (const m of md.matchAll(/\b(?:[a-z0-9-]+\.)+(?:dev|com|net|org|io|app)\b/g)) {
      if (/^(?:dev\.evecyno|dev\.example)\./.test(m[0])) continue;
      assert.ok(allowedHosts.has(m[0]), `${slug}: host ${m[0]}`);
    }
  }
});
