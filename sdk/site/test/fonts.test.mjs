// The fonts are self-hosted: no page or _headers names a font host, every @font-face url resolves to a built file with the pinned
// sha256, and the licence files ship in the build output.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { after, before, test } from 'node:test';
import { build, FONTS_DIR } from '../build.mjs';
import { FONT_FILES } from '../lib/fonts.mjs';

const sha = (b) => createHash('sha256').update(b).digest('hex');
let out;
let assets;
before(() => {
  out = mkdtempSync(join(tmpdir(), 'plugin-docs-fonts-'));
  build({ out, indexLive: false });
  assets = join(out, 'plugins', 'assets');
});
after(() => rmSync(out, { recursive: true, force: true }));

/** file name -> sha256 from the table of FONTS.md. */
const pins = () => new Map([...readFileSync(join(FONTS_DIR, 'FONTS.md'), 'utf8').matchAll(/^\| `([^`]+)` \| `([0-9a-f]{64})` \|$/gm)].map((m) => [m[1], m[2]]));

const walk = (d) => readdirSync(d).flatMap((e) => (statSync(join(d, e)).isDirectory() ? walk(join(d, e)) : [join(d, e)]));

test('no built page, stylesheet or _headers names a font host', () => {
  const files = walk(out).filter((f) => /\.(html|css|js)$/.test(f) || f.endsWith('_headers'));
  assert.ok(files.length > 20);
  for (const f of files) assert.doesNotMatch(readFileSync(f, 'utf8'), /googleapis|gstatic|fonts\.google/i, f);
  const csp = /Content-Security-Policy: (.*)/.exec(readFileSync(join(out, '_headers'), 'utf8'))[1];
  assert.match(csp, /font-src 'self'(;|$)/);
});

test('every page loads fonts.css before plugin-docs.css', () => {
  const page = readFileSync(join(out, 'plugins', 'start', 'index.html'), 'utf8');
  assert.ok(page.indexOf('assets/fonts.css') > 0 && page.indexOf('assets/fonts.css') < page.indexOf('assets/plugin-docs.css'));
});

test('every @font-face url resolves to a built file with the pinned sha256, font-display swap', () => {
  const css = readFileSync(join(assets, 'fonts.css'), 'utf8');
  const rules = css.match(/@font-face \{[^}]*\}/g);
  assert.equal(rules.length, FONT_FILES.length);
  const pin = pins();
  const seen = new Set();
  for (const r of rules) {
    assert.match(r, /font-display: swap;/);
    const m = /src: url\("([^"]+)"\) format\("woff2"\)/.exec(r);
    assert.ok(m, r);
    assert.match(m[1], /^fonts\/[\w-]+\.woff2$/);
    const file = resolve(assets, m[1]);
    assert.ok(existsSync(file), m[1]);
    const name = m[1].slice('fonts/'.length);
    assert.equal(sha(readFileSync(file)), pin.get(name), name);
    seen.add(name);
  }
  assert.equal(seen.size, FONT_FILES.length);
  for (const f of FONT_FILES) assert.ok(pin.has(f.file), `${f.file} has no pin`);
  assert.deepEqual([...new Set(FONT_FILES.map((f) => f.family))].sort(), ['JetBrains Mono', 'Space Grotesk']);
});

test('the licence files ship in the build output with the full OFL text and the copyright lines', () => {
  const pin = pins();
  for (const [name, holder] of [['LICENSE-space-grotesk.txt', 'The Space Grotesk Project Authors'], ['LICENSE-jetbrains-mono.txt', 'The JetBrains Mono Project Authors']]) {
    const text = readFileSync(join(assets, 'fonts', name), 'utf8');
    assert.equal(sha(Buffer.from(text)), pin.get(name), name);
    assert.match(text, new RegExp(`Copyright 2020 ${holder}`));
    assert.match(text, /SIL OPEN FONT LICENSE Version 1\.1 - 26 February 2007/);
    assert.match(text, /PERMISSION & CONDITIONS/);
    assert.match(text, /DISCLAIMER/);
  }
});
