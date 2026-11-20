// The built API pages cannot drift from the vendored sources: every declaration, every README heading and every namespace is read
// here with its own small parser (regexes over the raw text), not with the generator's.
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { build } from '../build.mjs';
import { EXCLUDED_SECTIONS, SECTION_PAGES, SPLIT_SECTIONS } from '../lib/readme.mjs';

const API = new URL('../../vendor/plugin-api/', import.meta.url);
const VERSION = JSON.parse(readFileSync(new URL('PIN.json', API), 'utf8')).version;
const DTS = readFileSync(new URL(`${VERSION}.d.ts`, API), 'utf8');
const README = readFileSync(new URL('README.md', API), 'utf8');
const un = (s) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&');

let tmp;
let site;
before(() => { tmp = mkdtempSync(join(tmpdir(), 'plugin-docs-drift-')); site = build({ out: join(tmp, 'o'), indexLive: false }); });
after(() => rmSync(tmp, { recursive: true, force: true }));
const page = (slug) => readFileSync(join(tmp, 'o', 'plugins', slug === 'index' ? '' : slug, 'index.html'), 'utf8');

/** The export blocks of the d.ts: a block runs from its `export` line, with the doc comment above it, to the line before the next one. */
function exportBlocks() {
  const lines = DTS.split('\n');
  const starts = lines.flatMap((l, i) => (/^export (type|interface|declare function|declare const|declare class)\s+(\w+)/.test(l) ? [i] : []));
  return starts.map((at) => {
    const m = /^export (?:type|interface|declare function|declare const|declare class)\s+(\w+)/.exec(lines[at]);
    let first = at;
    if (/^\s*\*\//.test(lines[at - 1] ?? '')) { first = at - 1; while (!/^\/\*\*/.test(lines[first])) first -= 1; }
    return { name: m[1], at, first };
  });
}

/** Every `<pre><code>` declaration block on the API pages: the labelled ones of the form `Name · api/<version>.d.ts`. */
function pageDeclarations() {
  const out = [];
  const slugs = ['api', 'api/types', ...[...DTS.matchAll(/^export interface EveCyno \{([\s\S]*?)^\}/gm)].flatMap((m) => [...m[1].matchAll(/^\s+(?:readonly )?(\w+)\??:/gm)].map((x) => `api/${x[1]}`))];
  for (const slug of new Set(slugs)) {
    let h;
    try { h = page(slug); } catch { continue; }
    for (const m of h.matchAll(/<span class="code-label">(\w+) · api\/[\d.]+\.d\.ts<\/span>[\s\S]*?<pre><code>([\s\S]*?)<\/code><\/pre>/g)) out.push({ slug, name: m[1], text: un(m[2]) });
  }
  return out;
}

test('every exported name of the d.ts is declared on exactly one page', () => {
  const names = exportBlocks().map((b) => b.name);
  assert.ok(names.length > 100, `${names.length} exports read`);
  const onPages = pageDeclarations();
  for (const n of names) assert.equal(onPages.filter((d) => d.name === n).length, 1, `${n} must be on exactly one page`);
  assert.equal(onPages.length, names.length, 'a page declares a name the d.ts does not export');
});

test('the declarations of all pages, in d.ts order, are the d.ts text with nothing left over', () => {
  const decls = pageDeclarations().map((d) => ({ ...d, at: DTS.indexOf(d.text) }));
  for (const d of decls) assert.ok(d.at >= 0, `${d.name}: the page text is not in the d.ts`);
  decls.sort((x, y) => x.at - y.at);
  let rest = '';
  let cursor = 0;
  for (const d of decls) {
    assert.ok(d.at >= cursor, `${d.name} overlaps the block before it`);
    rest += DTS.slice(cursor, d.at);
    cursor = d.at + d.text.length;
  }
  rest += DTS.slice(cursor);
  assert.equal(rest.trim(), '', 'text of the d.ts that no page shows');
  assert.ok(decls.length > 100);
});

test('every README heading is mapped to a page or excluded, and no map entry is stale', () => {
  const headings = [];
  let fence = false;
  for (const line of README.split('\n')) {
    if (/^(```|~~~)/.test(line)) fence = !fence;
    const m = !fence && /^(#{2,3}) (.*?)\s*$/.exec(line);
    if (m) headings.push({ level: m[1].length, key: m[2].replace(/\s*\([^)]*\)\s*$/, '').trim() });
  }
  const known = new Set([...Object.keys(SECTION_PAGES), ...Object.keys(SPLIT_SECTIONS), ...Object.keys(EXCLUDED_SECTIONS)]);
  let parent = null;
  for (const h of headings) {
    if (h.level === 2) parent = h.key;
    assert.ok(known.has(h.key) || (h.level === 3 && known.has(parent)), `README heading "${h.key}" is not mapped or excluded`);
  }
  for (const k of known) assert.ok(headings.some((h) => h.key === k), `the map names "${k}", which the README does not have`);
});

test('the namespaces of the API page are the members of EveCyno, in order', () => {
  const iface = /^export interface EveCyno \{([\s\S]*?)^\}/m.exec(DTS);
  assert.ok(iface, 'EveCyno interface');
  const members = [...iface[1].matchAll(/^ {4}(\w+)\??: \w+;/gm)].map((m) => m[1]);
  assert.ok(members.length >= 27, `${members.length} members read`);
  const rows = [...page('api').matchAll(/<a href="\/plugins\/api\/(\w+)\/"><span class="p-name">/g)].map((m) => m[1]);
  assert.deepEqual(rows, members.filter((m) => m !== 'account'));
  for (const slug of rows) assert.ok(site.pages.some((p) => p.slug === `api/${slug}`), `api/${slug} is built`);
});
