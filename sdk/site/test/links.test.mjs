// Every internal link and anchor of the built site resolves; external links come from a fixed list and are never fetched.
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { after, before, test } from 'node:test';
import { build } from '../build.mjs';

/** Every external URL a page may link to. A new one is a decision: add it here with the reason. */
export const EXTERNAL_ALLOWLIST = new Set([
  'https://discord.gg/XZzkH38dt9', // the project Discord
  'https://github.com/eve-cyno/plugins', // the plugin repository
  'https://wiki.eveuniversity.org/', // EVE University Wiki attribution (CC-BY-SA)
  'https://creativecommons.org/licenses/by-sa/4.0/', // licence of that attribution
  'https://eve-cyno.dev', // the project site
  'https://data.eve-cyno.dev/docs', // the data API docs
]);
const EXTERNAL_PREFIX_ALLOWLIST = [
  'https://github.com/eve-cyno/plugins/', // files of the plugin repository
];

let tmp;
let files; // path under out -> html text
before(() => {
  tmp = mkdtempSync(join(tmpdir(), 'plugin-docs-links-'));
  build({ out: join(tmp, 'o'), indexLive: false });
  files = new Map();
  const walk = (d) => { for (const e of readdirSync(d)) { const p = join(d, e); if (statSync(p).isDirectory()) walk(p); else if (p.endsWith('.html')) files.set(p, readFileSync(p, 'utf8')); } };
  walk(join(tmp, 'o'));
});
after(() => rmSync(tmp, { recursive: true, force: true }));

const stripCode = (h) => h.replace(/<pre[\s\S]*?<\/pre>/g, '').replace(/<!--[\s\S]*?-->/g, '').replace(/<script[\s\S]*?<\/script>/g, '');
const idsOf = (h) => new Set([...h.matchAll(/\b(?:id|name)="([^"]+)"/g)].map((m) => m[1]));
const linksOf = (h) => [...stripCode(h).matchAll(/\b(?:href|src)="([^"]*)"/g)].map((m) => m[1].replace(/&amp;/g, '&'));

/** The file a path under the site root names: a folder holds its index.html. */
function fileOf(path) {
  const p = join(tmp, 'o', decodeURI(path));
  if (existsSync(p) && statSync(p).isFile()) return p;
  const idx = join(p, 'index.html');
  return existsSync(idx) ? idx : null;
}

test('every internal href and src resolves to a built file', () => {
  assert.ok(files.size >= 42);
  let checked = 0;
  for (const [file, h] of files) {
    for (const l of linksOf(h)) {
      if (/^(https?:|mailto:)/.test(l) || l.startsWith('#')) continue;
      assert.ok(l.startsWith('/'), `${relative(tmp, file)}: relative link ${l}`);
      assert.ok(fileOf(l.split('#')[0].split('?')[0]), `${relative(tmp, file)}: ${l} is not a built file`);
      checked += 1;
    }
  }
  assert.ok(checked > 500, `only ${checked} internal links checked`);
});

test('every #anchor resolves to an id of its page, or of the page it points to', () => {
  let checked = 0;
  for (const [file, h] of files) {
    const own = idsOf(h);
    for (const l of linksOf(h)) {
      if (/^(https?:|mailto:)/.test(l)) continue;
      const [path, frag] = l.split('#');
      if (frag === undefined || frag === '' || frag === 'top') continue; // #top scrolls to the top by the HTML rule
      const target = path === '' ? own : idsOf(readFileSync(fileOf(path) ?? assert.fail(`${relative(tmp, file)}: ${l}`), 'utf8'));
      assert.ok(target.has(frag), `${relative(tmp, file)}: ${l} has no id "${frag}"`);
      checked += 1;
    }
  }
  assert.ok(checked > 300, `only ${checked} anchors checked`);
});

test('every search index entry points to a built page and an id on it', () => {
  const page = [...files.values()][0];
  const m = /<script type="application\/json" data-search-index>([\s\S]*?)<\/script>/.exec(page);
  assert.ok(m, 'search index');
  const entries = JSON.parse(m[1]);
  assert.ok(entries.length >= 42);
  for (const e of entries) {
    const [path, frag] = e.u.split('#');
    const f = fileOf(path);
    assert.ok(f, `search entry ${e.u}`);
    if (frag) assert.ok(idsOf(readFileSync(f, 'utf8')).has(frag), `search entry ${e.u}`);
  }
});

test('external links come from the allowlist (they are not fetched)', () => {
  const seen = new Set();
  for (const [file, h] of files) {
    for (const l of linksOf(h)) {
      if (!/^https?:/.test(l)) continue;
      seen.add(l);
      const ok = EXTERNAL_ALLOWLIST.has(l) || EXTERNAL_PREFIX_ALLOWLIST.some((p) => l.startsWith(p));
      assert.ok(ok, `${relative(tmp, file)}: external link ${l} is not in the allowlist`);
      assert.ok(l.startsWith('https://'), `${relative(tmp, file)}: ${l} is not https`);
    }
  }
  assert.ok(seen.has('https://github.com/eve-cyno/plugins'));
});
