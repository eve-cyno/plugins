import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { build, DESIGN_DIR, DESIGN_SNAPSHOT, readChecks, REPO_ROOT } from '../build.mjs';
import { namespacesOf, parseDts } from '../lib/dts.mjs';
import { DROPPED_TEXT, EXCLUDED_SECTIONS, frozenParts, mapSections, parseReadme, readReadme, REWRITES, SECTION_PAGES, SPLIT_SECTIONS } from '../lib/readme.mjs';
import { schemaCounts } from '../lib/schema.mjs';

const API = new URL('../../vendor/plugin-api/', import.meta.url);
const API_VERSION = JSON.parse(readFileSync(new URL('PIN.json', API), 'utf8')).version;
const DECLS = parseDts(readFileSync(new URL(`${API_VERSION}.d.ts`, API), 'utf8'));
const NAMESPACES = namespacesOf(DECLS).filter((n) => !n.reserved).map((n) => n.name);

/** Every page of plan section 3 (P1 to P16), as slugs under /plugins/. */
const PLAN_PAGES = [
  'index', 'start', 'tutorial', 'local-testing', 'api', ...NAMESPACES.map((n) => `api/${n}`), 'api/types', 'api/versions',
  'manifest', 'permissions', 'packaging', 'submitting', 'checks', 'policy', 'signing', 'licence',
];

const tmp = mkdtempSync(join(tmpdir(), 'plugin-docs-site-'));
const pageFile = (out, slug) => join(out, 'plugins', slug === 'index' ? '' : slug, 'index.html');
const html = (out, slug) => readFileSync(pageFile(out, slug), 'utf8');
let off;
let live;

before(() => {
  off = build({ out: join(tmp, 'off'), indexLive: false });
  live = build({ out: join(tmp, 'live'), indexLive: true });
});
after(() => rmSync(tmp, { recursive: true, force: true }));

const sha = (buf) => createHash('sha256').update(buf).digest('hex');
const classesOf = (text) => new Set([...text.matchAll(/\bclass="([^"]*)"/g)].flatMap((m) => m[1].split(/\s+/).filter(Boolean)));

test('every page of plan section 3 is built, once, and the build says so', () => {
  assert.deepEqual(off.pages.map((p) => p.slug).sort(), [...PLAN_PAGES].sort());
  assert.equal(new Set(PLAN_PAGES).size, PLAN_PAGES.length);
  assert.equal(NAMESPACES.length, 27);
  for (const slug of PLAN_PAGES) assert.ok(html(join(tmp, 'off'), slug).startsWith('<!DOCTYPE html>'), slug);
});

test('exactly one status banner per page, from the INDEX_LIVE flag (off by default)', () => {
  const dflt = build({ out: join(tmp, 'default') });
  assert.equal(dflt.indexLive, false);
  for (const slug of PLAN_PAGES) {
    const a = html(join(tmp, 'off'), slug);
    assert.equal((a.match(/class="status-banner"/g) ?? []).length, 1, slug);
    assert.match(a, /class="status-banner" data-state="not-live"/);
    assert.doesNotMatch(a, /data-state="live"/);
    assert.match(a, /<span data-slot="index-state">not live<\/span>/);
    const b = html(join(tmp, 'live'), slug);
    assert.equal((b.match(/class="status-banner"/g) ?? []).length, 1, slug);
    assert.match(b, /class="status-banner" data-state="live" role="status" aria-label="Marketplace status">/);
    assert.doesNotMatch(b, /data-state="not-live"/);
    assert.match(b, /<span data-slot="index-state">live<\/span>/);
  }
  assert.match(html(join(tmp, 'off'), 'submitting'), /data-state-tag="not-live">not open</);
  assert.doesNotMatch(html(join(tmp, 'live'), 'submitting'), /data-state-tag/);
});

test('with the flag off, no page says the Marketplace or the index is live', () => {
  const claims = [/marketplace is (?:now )?(?:open|live)/i, /index is (?:now )?(?:open|live|published)/i, /can be installed from there/i, /install(?:ed)? from the marketplace/i];
  for (const slug of PLAN_PAGES) {
    const text = html(join(tmp, 'off'), slug);
    for (const re of claims) assert.doesNotMatch(text, re, `${slug}: ${re}`);
  }
  assert.match(html(join(tmp, 'live'), 'index'), /The plugin Marketplace is open/);
});

test('the footer, the Fenris disclaimer included, is the design footer on every page', () => {
  const design = readFileSync(DESIGN_SNAPSHOT, 'utf8');
  const dla = [...design.matchAll(/<p class="dla">([\s\S]*?)<\/p>/g)].map((m) => m[1]);
  assert.equal(dla.length, 2);
  for (const slug of PLAN_PAGES) {
    const page = html(join(tmp, 'off'), slug);
    assert.deepEqual([...page.matchAll(/<p class="dla">([\s\S]*?)<\/p>/g)].map((m) => m[1]), dla, slug);
    assert.match(page, /Fenris Creations hf/);
  }
});

test('no script on a page except the search index (JSON) and the design script', () => {
  for (const slug of PLAN_PAGES) {
    const page = html(join(tmp, 'off'), slug);
    const scripts = [...page.matchAll(/<script\b([^>]*)>/g)].map((m) => m[1].trim());
    assert.equal(scripts.length, 2, slug);
    assert.ok(scripts.includes('type="application/json" data-search-index'), slug);
    assert.ok(scripts.includes('src="/plugins/assets/data-site.js" defer'), slug);
    assert.doesNotMatch(page, /\son[a-z]+\s*=|javascript:|data-demo|site-base-standin|#page=/i, slug);
  }
});

test('styles: fonts, site-base, data-docs, then plugin-docs last; design files copied byte for byte', () => {
  const page = html(join(tmp, 'off'), 'start');
  const sheets = [...page.matchAll(/<link rel="stylesheet" href="([^"]+)">/g)].map((m) => m[1]);
  assert.deepEqual(sheets, ['/plugins/assets/fonts.css', '/plugins/assets/site-base.css', '/plugins/assets/data-docs.css', '/plugins/assets/plugin-docs.css']);
  assert.ok(page.indexOf('plugin-docs.css') > page.indexOf('data-docs.css'));
  for (const name of readdirSync(join(tmp, 'off', 'plugins', 'assets')).filter((n) => n !== 'fonts' && n !== 'fonts.css')) {
    assert.equal(sha(readFileSync(join(tmp, 'off', 'plugins', 'assets', name))), sha(readFileSync(join(DESIGN_DIR, name))), name);
  }
  assert.match(readFileSync(join(tmp, 'off', '_headers'), 'utf8'), /Content-Security-Policy: default-src 'self'; script-src 'self'/);
});

test('_redirects: one rule sends / to /plugins/ with 302, only for the /plugins/ base', () => {
  const rules = readFileSync(join(tmp, 'off', '_redirects'), 'utf8').split('\n').filter((l) => l.trim() && !l.startsWith('#'));
  assert.deepEqual(rules, ['/ /plugins/ 302']);
  const other = mkdtempSync(join(tmpdir(), 'docs-base-'));
  try {
    build({ out: other, base: '/docs/', indexLive: false });
    assert.equal(existsSync(join(other, '_redirects')), false);
  } finally { rmSync(other, { recursive: true, force: true }); }
});

test('class names and data hooks come from the design: nothing invented', () => {
  const design = readFileSync(DESIGN_SNAPSHOT, 'utf8');
  const css = ['site-base.css', 'data-docs.css', 'plugin-docs.css'].map((f) => readFileSync(join(DESIGN_DIR, f), 'utf8')).join('\n');
  const allowed = new Set([...classesOf(design), ...[...css.matchAll(/\.([A-Za-z_][\w-]*)/g)].map((m) => m[1])]);
  const hooks = new Set([...design.matchAll(/\b(data-[a-z-]+)/g)].map((m) => m[1]));
  for (const slug of PLAN_PAGES) {
    const page = html(join(tmp, 'off'), slug);
    for (const c of classesOf(page)) assert.ok(allowed.has(c), `${slug}: class ${c} is not in the design`);
    for (const tag of page.matchAll(/<[a-zA-Z][^>]*>/g)) {
      for (const m of tag[0].matchAll(/\s(data-[a-z-]+)/g)) assert.ok(hooks.has(m[1]), `${slug}: ${m[1]} is not in the design`);
    }
    const ids = [...page.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]);
    assert.equal(new Set(ids).size, ids.length, `${slug}: duplicate id ${ids.find((x, i) => ids.indexOf(x) !== i)}`);
  }
});

test('the design pins in PINS.md match the files', () => {
  const pins = readFileSync(join(DESIGN_DIR, 'PINS.md'), 'utf8');
  const snapshot = readFileSync(DESIGN_SNAPSHOT, 'utf8');
  const [first, ...rest] = snapshot.split('\n');
  // The design file's own sha256 is the provenance record (line 1 and the table); the bytes below line 1 are that file with one
  // internal work-item name and one plan reference cut, and PINS.md pins their sha256 too.
  assert.ok(first.startsWith('<!-- source: the EVE-Cyno design system, version 1795200790-9e70, file project/eve-cyno/project/plugin-docs.html (sha256 ff6791d7bd3b112364308c3478c0ff7fe7fa71ecdc51fdfca36b6df9420b8153);'), first);
  const committed = /the bytes below line 1 here have sha256 `([0-9a-f]{64})`/.exec(pins)?.[1];
  assert.ok(committed, 'PINS.md pins the committed snapshot bytes');
  assert.equal(sha(rest.join('\n')), committed);
  assert.match(pins, /`plugin-docs-2026-11-20\.html` \| `plugin-docs\.html` \| `ff6791d7bd3b112364308c3478c0ff7fe7fa71ecdc51fdfca36b6df9420b8153` \|/);
  for (const name of ['plugin-docs.css', 'site-base.css', 'data-docs.css', 'data-site.js', 'favicon.svg', 'favicon-small.svg']) {
    const row = new RegExp(`\`${name}\`[^\\n]*\`([0-9a-f]{64})\``).exec(pins);
    assert.ok(row, `${name} has a pin`);
    assert.equal(sha(readFileSync(join(DESIGN_DIR, name))), row[1], name);
  }
  assert.ok(pins.includes('ff6791d7bd3b112364308c3478c0ff7fe7fa71ecdc51fdfca36b6df9420b8153'));
  assert.equal(`${/<style id="plugin-docs-css">([\s\S]*?)<\/style>/.exec(snapshot)[1]}`, readFileSync(join(DESIGN_DIR, 'plugin-docs.css'), 'utf8'));
});

test('the plugin docs CSS sets the orange product colour, not the data green', () => {
  const css = readFileSync(join(tmp, 'off', 'plugins', 'assets', 'plugin-docs.css'), 'utf8');
  assert.ok(css.includes('--mode: var(--c-red)'), 'mode is orange');
  assert.ok(!css.includes('--cy-accent: var(--c-green)'), 'no green lockup accent');
});

test('the design files name no private link, design id or work item', () => {
  // A claude.ai link, a design id (22 letters and digits, mixed case), the old source tag, an internal work-item name.
  const banned = [/claude\.ai/i, /claude-design-artifact/, /\b(?=[A-Za-z0-9]*[A-Z])(?=[A-Za-z0-9]*[a-z])(?=[A-Za-z0-9]*\d)[A-Za-z0-9]{22}\b/, /\blane-[a-z]/, /\btask \d+\.\d+/, /\bplan \d+\.\d+/i, /open_design_sync/];
  for (const name of readdirSync(DESIGN_DIR)) {
    const text = readFileSync(join(DESIGN_DIR, name), 'utf8');
    for (const re of banned) assert.doesNotMatch(text, re, `${name}: ${re}`);
  }
});

test('the pinned snapshot has no font-host reference, and the footer is the design\'s', () => {
  const snapshot = readFileSync(DESIGN_SNAPSHOT, 'utf8');
  assert.doesNotMatch(snapshot, /googleapis|gstatic|fonts\.google/i);
  const foot = /<footer class="site-foot">[\s\S]*?<\/footer>/.exec(snapshot)[0];
  assert.match(foot, /Free tools for EVE pilots\. Not an official EVE Online or Fenris Creations service\./);
  assert.match(foot, /A free, non-commercial fan project\. Donations are voluntary and unlock nothing\./);
  assert.match(foot, /<a href="https:\/\/discord\.gg\/XZzkH38dt9">Discord<\/a>/);
  for (const name of readdirSync(DESIGN_DIR)) assert.doesNotMatch(readFileSync(join(DESIGN_DIR, name), 'utf8'), /Hobby-run|\bCCP\b/, name);
  for (const slug of off.pages.map((p) => p.slug)) {
    const page = html(join(tmp, 'off'), slug);
    assert.ok(page.includes('Free tools for EVE pilots. Not an official EVE Online or Fenris Creations service.'), slug);
    assert.ok(page.includes('A free, non-commercial fan project. Donations are voluntary and unlock nothing.'), slug);
    assert.doesNotMatch(page, /Hobby-run|\bCCP\b/, slug);
  }
});

test('the search index lists every page once, with a URL that exists', () => {
  const page = html(join(tmp, 'off'), 'index');
  const index = JSON.parse(/<script type="application\/json" data-search-index>([\s\S]*?)<\/script>/.exec(page)[1]);
  assert.equal(index.length, PLAN_PAGES.length);
  assert.deepEqual(index.map((i) => i.u).sort(), off.pages.map((p) => p.url).sort());
  assert.equal(index.filter((i) => i.k === 'tool').length, 27);
});

test('source of truth: the namespace list, the manifest rows, the check ids', () => {
  const api = html(join(tmp, 'off'), 'api');
  const rows = [...api.matchAll(/<a href="\/plugins\/api\/([a-z]+)\/"><span class="p-name">/g)].map((m) => m[1]);
  assert.deepEqual(rows, NAMESPACES);
  assert.match(api, /<span class="p-name">account<\/span><\/td><td>reserved</);

  const schema = JSON.parse(readFileSync(join(REPO_ROOT, 'vendor/eve-cyno-host/host/dist/schemas/manifest.v1.json'), 'utf8'));
  const counts = schemaCounts(schema);
  assert.deepEqual(counts, { top: 15, required: 5, permissions: 20, contributes: 9 });
  const manifest = html(join(tmp, 'off'), 'manifest');
  for (const key of Object.keys(schema.properties)) assert.match(manifest, new RegExp(`<span class="p-name">${key}</span>`), key);
  for (const key of Object.keys(schema.properties.permissions.properties)) assert.match(manifest, new RegExp(`<span class="p-name">permissions\\.${key}</span>`), key);
  for (const key of Object.keys(schema.properties.contributes.properties)) assert.match(manifest, new RegExp(`<span class="p-name">contributes\\.${key}</span>`), key);

  const { checkIds, classes } = readChecks(REPO_ROOT);
  assert.equal(checkIds.length, 17);
  const checks = html(join(tmp, 'off'), 'checks');
  for (const id of checkIds) assert.match(checks, new RegExp(`<code>${id}</code>`));
  for (const c of classes) assert.match(checks, new RegExp(`<code>${c}</code>`));
});

test('source of truth: the declarations of every API page equal the d.ts text', () => {
  const seen = [];
  const un = (s) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
  for (const slug of PLAN_PAGES.filter((s) => s.startsWith('api'))) {
    const page = html(join(tmp, 'off'), slug);
    for (const m of page.matchAll(/<span class="code-label">(\w+) · api\/[\d.]+\.d\.ts<\/span>[\s\S]*?<pre><code>([\s\S]*?)<\/code><\/pre>/g)) {
      const d = DECLS.find((x) => x.name === m[1]);
      assert.ok(d, m[1]);
      assert.equal(un(m[2]), d.text, `${slug}: ${m[1]}`);
      seen.push(m[1]);
    }
  }
  assert.deepEqual(seen.sort(), DECLS.map((d) => d.name).sort());
});

test('source of truth: POLICY.md, CONTRIBUTING.md, the scaffold and the README history', () => {
  const policy = html(join(tmp, 'off'), 'policy');
  for (const h of parseReadme(readFileSync(join(REPO_ROOT, 'POLICY.md'), 'utf8')).sections) assert.match(policy, new RegExp(`<h2 id="[^"]+">${h.heading.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}<`), h.heading);
  const submitting = html(join(tmp, 'off'), 'submitting');
  assert.match(submitting, /entries\/&lt;id&gt;\.json|entries\/<code>/);
  assert.match(submitting, /<span class="p-name">versions<\/span>/);
  const tutorial = html(join(tmp, 'off'), 'tutorial');
  assert.match(tutorial, /<span class="code-label">plugin\.json<\/span>/);
  assert.match(tutorial, /eve-cyno-api/);
  const start = html(join(tmp, 'off'), 'start');
  assert.match(start, /data-panel="manifest" hidden>/);
  const frozen = frozenParts(readReadme(new URL('README.md', API).pathname).sections.find((s) => s.key === 'Frozen surface').body);
  const versions = html(join(tmp, 'off'), 'api/versions');
  const named = new Set([...frozen.snapshots.matchAll(/`api\/(\d+\.\d+\.\d+)\.d\.ts`/g)].map((m) => m[1]));
  assert.ok(named.size >= 20);
  for (const v of named) assert.ok(versions.includes(`api/${v}.d.ts`), v);
  for (const v of ['1.1.0', '1.17.0', '1.29.0']) assert.match(versions, new RegExp(`<h2 id="v${v.replaceAll('.', '-')}">`));
});

test('the README section map covers every heading and names none that is gone', () => {
  const readme = readReadme(new URL('README.md', API).pathname);
  const m = mapSections(readme);
  assert.ok(m.excluded.length >= 1);
  assert.throws(() => mapSections(parseReadme(`${readFileSync(new URL('README.md', API), 'utf8')}\n## A new section\n\ntext`)), /"A new section" is neither mapped/);
  assert.throws(() => mapSections({ ...readme, sections: readme.sections.filter((s) => s.key !== 'Chat') }), /names "Chat"/);
});

test('hand-written pages read site/content/<slug>.md when it exists', () => {
  const dir = join(tmp, 'content');
  mkdirSync(dir);
  writeFileSync(join(dir, 'local-testing.md'), '## Reload\n\nThe folder reloads on every build.\n');
  writeFileSync(join(dir, 'api-types.md'), 'unused\n');
  const r = build({ out: join(tmp, 'content-out'), contentDir: dir });
  const withContent = html(join(tmp, 'content-out'), 'local-testing');
  assert.match(withContent, /The folder reloads on every build\./);
  assert.doesNotMatch(withContent, /This page is a stub/);
  const empty = join(tmp, 'no-content');
  mkdirSync(empty);
  assert.match(html(build({ out: join(tmp, 'no-content-out'), contentDir: empty }).out, 'local-testing'), /This page is a stub/);
  assert.equal(r.pages.length, PLAN_PAGES.length);
});

test('a base other than /plugins/ moves every link', () => {
  const r = build({ out: join(tmp, 'rebased'), base: '/docs/plugins/' });
  const page = readFileSync(join(tmp, 'rebased', 'docs', 'plugins', 'start', 'index.html'), 'utf8');
  assert.match(page, /href="\/docs\/plugins\/assets\/site-base\.css"/);
  assert.doesNotMatch(page, /href="\/plugins\//);
  assert.equal(r.pages.length, PLAN_PAGES.length);
  assert.throws(() => build({ out: join(tmp, 'bad'), base: 'plugins' }), /base must start and end/);
});

test('the manifest page examples: accept passes the vendored parseManifest, refuse throws the code it names', async () => {
  const { createRequire } = await import('node:module');
  const { parseManifest } = createRequire(import.meta.url)(join(REPO_ROOT, 'vendor/eve-cyno-host/host/dist/manifest.js'));
  const un = (s) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&amp;/g, '&');
  const page = html(join(tmp, 'off'), 'manifest');
  const blocks = [...page.matchAll(/<span class="code-label">([^<]*)<\/span><span class="badge badge-(ok|bad)">(accept|refuse)<\/span>[\s\S]*?<pre><code>([\s\S]*?)<\/code><\/pre>/g)];
  assert.ok(blocks.some((b) => b[3] === 'accept') && blocks.some((b) => b[3] === 'refuse'));
  for (const [, label, , verdict, code] of blocks) {
    const manifest = JSON.parse(un(code));
    if (verdict === 'accept') assert.doesNotThrow(() => parseManifest(manifest), label);
    else assert.throws(() => parseManifest(manifest), (e) => e.code === label.split(' · ')[1], label);
  }
});

test('manifest page: one row per schema property, recursively (an independent walk of the schema)', () => {
  const schema = JSON.parse(readFileSync(join(REPO_ROOT, 'vendor/eve-cyno-host/host/dist/schemas/manifest.v1.json'), 'utf8'));
  const deref = (n) => (n?.$ref ? schema.$defs[n.$ref.replace('#/$defs/', '')] : n);
  const paths = [];
  const walk = (node, prefix) => {
    const n = deref(node);
    for (const [k, v] of Object.entries(n.properties ?? {})) {
      const path = prefix ? `${prefix}.${k}` : k;
      paths.push(path);
      const c = deref(v);
      if (c.properties) walk(c, path);
      else if (c.type === 'array' && c.items && deref(c.items).properties) walk(c.items, `${path}[]`);
    }
  };
  walk(schema, '');
  assert.ok(paths.length > 50);
  const manifest = html(join(tmp, 'off'), 'manifest');
  const shown = [...manifest.matchAll(/<span class="p-name">([^<]+)<\/span>/g)].map((m) => m[1].replace(/&lt;/g, '<'));
  assert.deepEqual(shown.sort(), paths.sort());
});

// ---- Task 1.4: guide pages (index, start, tutorial, submitting, policy, licence) and the README-derived pages

import { render as renderScaffold } from '../../create-plugin/lib/generate.mjs';
import { ANSWERS } from '../lib/pages.mjs';

const textOf = (page) => page.replace(/<pre[\s\S]*?<\/pre>/g, ' ').replace(/<(script|style|svg)[\s\S]*?<\/\1>/g, ' ').replace(/<\/?(?:code|a|b|em|span)\b[^>]*>/g, '').replace(/<[^>]+>/g, ' ')
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&').replace(/\s+/g, ' ');
const unescapeCode = (s) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
const main = (out, slug) => /<main[\s\S]*<\/main>/.exec(html(out, slug))?.[0] ?? html(out, slug);

test('API pages built from the README name no desktop-internal path, command or test build', () => {
  const internal = [/src\/index\.ts/, /host\/src/, /packages\/[a-z-]+/, /npm --prefix/, /selftest/, /store-core/, /dev\.evecyno\.\*/, /test build/i, /In this repository/, /cynod/i, /owner check/i, /not verified yet/i, /dataallow/i, /devfolder/i, /Plugins > Developer/, /resolves to built/];
  const slugs = PLAN_PAGES.filter((s) => s.startsWith('api') || ['manifest', 'packaging', 'permissions', 'local-testing', 'start', 'tutorial'].includes(s));
  assert.ok(slugs.length > 30);
  for (const slug of slugs) {
    const text = textOf(main(join(tmp, 'off'), slug));
    for (const re of internal) assert.doesNotMatch(text, re, `${slug}: ${re}`);
  }
});

test('README prose: every paragraph, list item and code block of a mapped section is on its page, minus DROPPED_TEXT and REWRITES', () => {
  // An independent read of the README: `##` and `###` headings outside fences; a `###` section goes where its `##` parent goes unless
  // the map names it. The split and excluded sections are left out (api/versions and the drift test cover them).
  const keyOf = (h) => h.replace(/\s*\([^)]*\)\s*$/, '').trim();
  const sections = [];
  let cur = null;
  let top = null;
  let fence = false;
  for (const line of readFileSync(new URL('README.md', API), 'utf8').replace(/\r\n?/g, '\n').split('\n')) {
    if (/^(```|~~~)/.test(line)) fence = !fence;
    const h = !fence && /^(#{2,3})\s+(.*?)\s*$/.exec(line);
    if (h) {
      if (h[1] === '##') top = keyOf(h[2]);
      cur = { key: keyOf(h[2]), top, lines: [] };
      sections.push(cur);
    } else if (cur) cur.lines.push(line);
  }
  const norm = (s) => s.replace(/[`<>]|\*\*/g, '').replace(/\s+/g, ' ').trim();
  let units = 0;
  for (const s of sections) {
    if (s.top in SPLIT_SECTIONS || s.top in EXCLUDED_SECTIONS) continue;
    const slug = SECTION_PAGES[s.key] ?? SECTION_PAGES[s.top];
    assert.ok(slug, `README section "${s.key}" has a page`);
    let body = s.lines.join('\n');
    for (const d of DROPPED_TEXT) if (d.section === s.top) body = body.replace(d.pattern, '');
    for (const w of REWRITES) if (w.section === s.top) body = body.replace(w.pattern, w.replacement);
    // Units: a paragraph, one list item with its continuation lines, or one fenced code block.
    const prose = [];
    const code = [];
    let para = null;
    let block = null;
    for (const line of body.split('\n')) {
      if (block) { if (/^(```|~~~)/.test(line)) { code.push(block.join('\n')); block = null; } else block.push(line); continue; }
      if (/^(```|~~~)/.test(line)) { para = null; block = []; continue; }
      if (!line.trim()) { para = null; continue; }
      const item = /^\s*(?:[-*+]|\d+[.)])\s+(.*)$/.exec(line);
      if (item || para === null) { para = [item ? item[1] : line]; prose.push(para); } else para.push(line);
    }
    const page = main(join(tmp, 'off'), slug);
    const text = textOf(page).replace(/[<>]/g, '').replace(/\s+/g, ' ');
    const blocks = [...page.matchAll(/<pre><code>([\s\S]*?)<\/code><\/pre>/g)].map((m) => unescapeCode(m[1]));
    for (const p of prose) { const t = norm(p.join(' ')); assert.ok(text.includes(t), `${slug} (${s.key}): ${t.slice(0, 80)}`); units++; }
    for (const c of code) { assert.ok(blocks.some((b) => b.includes(c)), `${slug} (${s.key}) code: ${c.slice(0, 60)}`); units++; }
  }
  assert.ok(units >= 150, `${units} README units checked`);
});

test('overview: says what a plugin is, names the sandbox, and with the flag off says the Marketplace is not open', () => {
  const text = textOf(main(join(tmp, 'off'), 'index'));
  assert.match(text, /plugin\.json/);
  assert.match(text, /sandbox/i);
  assert.match(text, /Marketplace is not open|not open yet|not live/i);
  assert.doesNotMatch(text, /Marketplace is (?:now )?(?:open|live)|(?<!nobody )can install|install it from/i);
  const live = textOf(main(join(tmp, 'live'), 'index'));
  assert.doesNotMatch(live, /not open yet|not live/i);
});

test('start: on-npm note with the clone alternative, the npm install step, and the not-open callout follows the flag', () => {
  const text = textOf(main(join(tmp, 'off'), 'start'));
  assert.match(text, /scaffold is on npm/i);
  assert.match(text, /npm create @eve-cyno\/plugin@latest/);
  assert.match(text, /node sdk\/create-plugin\/bin\/create-plugin\.mjs/);
  assert.doesNotMatch(text, /not on npm|is not published|once the package/i);
  assert.match(text, /npm install/);
  assert.match(text, /Nobody can install your plugin yet/);
  // The Node minimum is the template zip script's (zlib.crc32), in the text and the badge.
  const need = /use Node (\d+\.\d+) or newer/.exec(readFileSync(join(REPO_ROOT, 'sdk', 'create-plugin', 'template', 'scripts', 'zip.mjs'), 'utf8'))[1];
  assert.ok(text.includes(`You need Node ${need} or newer`), `start text: Node ${need}`);
  assert.ok(html(join(tmp, 'off'), 'start').includes(`>Node ${need} or newer</span>`), `start badge: Node ${need}`);
  assert.ok(html(join(tmp, 'off'), 'start').includes(`"s":"Node ${need}+, one command, a running plugin"`), `search index summary: Node ${need}`);
  const live = textOf(main(join(tmp, 'live'), 'start'));
  assert.doesNotMatch(live, /Nobody can install your plugin yet|not open yet|not live/i);
});

test('start and tutorial are the template output: tree, plugin.json, main.ts and every shown file equal generate.mjs', () => {
  const files = renderScaffold(ANSWERS);
  const start = html(join(tmp, 'off'), 'start');
  const panel = (name) => unescapeCode(new RegExp(`<pre data-panel="${name}"[^>]*><code>([\\s\\S]*?)</code></pre>`).exec(start)[1]);
  assert.equal(panel('manifest'), files.get('plugin.json'));
  assert.equal(panel('main'), files.get('src/main.ts'));
  assert.equal(panel('tree'), `my-plugin/\n${[...files.keys()].map((k) => `  ${k}`).join('\n')}`);
  const tutorial = html(join(tmp, 'off'), 'tutorial');
  const shown = [...files.keys()].filter((p) => /^(plugin\.json|package\.json|tsconfig\.json|src\/|static\/|test\/|entry\/)/.test(p));
  assert.ok(shown.length >= 8);
  for (const path of shown) {
    const re = new RegExp(`<span class="code-label">${path.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')}</span>[\\s\\S]*?<pre><code>([\\s\\S]*?)</code></pre>`);
    const m = re.exec(tutorial);
    assert.ok(m, `tutorial shows ${path}`);
    assert.equal(unescapeCode(m[1]), files.get(path), path);
  }
  const prose = textOf(main(join(tmp, 'off'), 'tutorial'));
  for (const word of ['getEveCyno|eveCyno', 'theme', 'onCommand', 'setSummary', 'contributes', 'engines']) assert.match(prose, new RegExp(word), word);
  assert.doesNotMatch(prose, /This page shows every file|written in a later step/);
});

test('submitting: the CONTRIBUTING.md text is embedded, the repository-side "Run the checks locally" is not, author text points to npm run check', () => {
  const contributing = readFileSync(join(REPO_ROOT, 'CONTRIBUTING.md'), 'utf8');
  const text = textOf(main(join(tmp, 'off'), 'submitting'));
  const items = [];
  let skip = false;
  let fence = false;
  for (const line of contributing.split('\n')) {
    if (/^```/.test(line)) { fence = !fence; continue; }
    if (fence) continue;
    const h = /^##\s+(.*)$/.exec(line);
    if (h) { skip = h[1] === 'Run the checks locally'; if (!skip) items.push({ heading: h[1] }); continue; }
    if (skip || /^#\s/.test(line) || !line.trim()) continue;
    if (/^\s*(\d+\.|-)\s+/.test(line) || !items.length || items[items.length - 1].heading) items.push({ text: line.replace(/^\s*(\d+\.|-)\s+/, '') });
    else items[items.length - 1].text += ` ${line.trim()}`;
  }
  const norm = (s) => s.replace(/[`<>]/g, '').replace(/\s+/g, ' ').trim();
  assert.ok(items.length >= 12);
  for (const it of items) assert.ok(text.replace(/[<>]/g, '').includes(norm(it.heading ?? it.text)), `embedded: ${(it.heading ?? it.text).slice(0, 50)}`);
  assert.doesNotMatch(html(join(tmp, 'off'), 'submitting'), /<h2 id="run-the-checks-locally"|<pre><code>npm ci\nnpm test/);
  assert.match(html(join(tmp, 'off'), 'submitting'), /npm run check -- --plugins/);
  assert.match(text, /SHA-256/);
});

test('policy: POLICY.md is embedded in full (every paragraph and list item)', () => {
  const policy = readFileSync(join(REPO_ROOT, 'POLICY.md'), 'utf8').replace(/^# .*\n+/, '');
  const text = textOf(main(join(tmp, 'off'), 'policy')).replace(/[<>]/g, '');
  const blocks = policy.split(/\n\n+/).map((b) => b.replace(/^##\s+.*\n?/gm, '').replace(/[`<>]/g, '').replace(/\s+/g, ' ').trim()).filter(Boolean);
  assert.ok(blocks.length >= 10);
  for (const b of blocks) assert.ok(text.includes(b), b.slice(0, 60));
});

test('licence: the four pieces of plan section 5, each with its licence, and the Fenris disclaimer in the body', () => {
  const text = textOf(main(join(tmp, 'off'), 'licence'));
  const table = html(join(tmp, 'off'), 'licence');
  assert.match(table, /create-plugin<\/code>[\s\S]*?<td>MIT<\/td>/);
  assert.match(text, /MIT-0/);
  assert.match(text, /plugin API[^.]*MIT|MIT[^.]*plugin API/i);
  assert.match(text, /documentation[^.]*MIT|MIT[^.]*documentation/i);
  assert.match(text, /PolyForm Strict/);
  assert.match(text, /EVE Online and all related materials are the property of Fenris Creations/);
  assert.match(text, /not affiliated with Fenris Creations/);
  assert.doesNotMatch(text, /Draft|written in a later step/);
});

test('content conditionals: live and not-live blocks follow the flag', () => {
  const dir = join(tmp, 'cond');
  mkdirSync(dir);
  writeFileSync(join(dir, 'index.md'), '## A\n\n<!-- not-live -->\nNOT-LIVE-TEXT\n<!-- /not-live -->\n\n<!-- live -->\nLIVE-TEXT\n<!-- /live -->\n');
  const a = html(build({ out: join(tmp, 'cond-off'), contentDir: dir, indexLive: false }).out, 'index');
  const b = html(build({ out: join(tmp, 'cond-on'), contentDir: dir, indexLive: true }).out, 'index');
  assert.match(a, /NOT-LIVE-TEXT/); assert.doesNotMatch(a, /(?<!NOT-)LIVE-TEXT/);
  assert.match(b, /LIVE-TEXT/); assert.doesNotMatch(b, /NOT-LIVE-TEXT/);
  writeFileSync(join(dir, 'index.md'), '<!-- live -->\nunclosed\n');
  assert.throws(() => build({ out: join(tmp, 'cond-bad'), contentDir: dir }), /unclosed|index\.md/);
});

test('no member table has an all-empty "What it does" column, and a documented one keeps it', () => {
  const withCol = [];
  for (const slug of NAMESPACES.map((n) => `api/${n}`)) {
    for (const [, table] of html(off.out ?? join(tmp, 'off'), slug).matchAll(/<table>([\s\S]*?)<\/table>/g)) {
      if (!table.includes('<th>What it does</th>')) continue;
      const cells = [...table.matchAll(/<tr><td>.*?<\/td><td>.*?<\/td><td>(.*?)<\/td><\/tr>/g)].map((m) => m[1].trim());
      assert.ok(cells.length > 0 && cells.some((c) => c !== ''), `${slug}: every "What it does" cell is empty`);
      withCol.push(slug);
    }
  }
  assert.ok(withCol.length > 0, 'no namespace page keeps the "What it does" column');
});
