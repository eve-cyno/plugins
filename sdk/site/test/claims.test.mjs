// What the site may claim. With INDEX_LIVE off, no page says the Marketplace or the index is open, every page carries the status
// banner, and every page carries the Fenris Creations disclaimer.
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { build } from '../build.mjs';

let tmp;
let off;
let live;
before(() => {
  tmp = mkdtempSync(join(tmpdir(), 'plugin-docs-claims-'));
  off = build({ out: join(tmp, 'off'), indexLive: false });
  live = build({ out: join(tmp, 'live'), indexLive: true });
});
after(() => rmSync(tmp, { recursive: true, force: true }));

const read = (out, slug) => readFileSync(join(out, 'plugins', slug === 'index' ? '' : slug, 'index.html'), 'utf8');
const prose = (h) => h.replace(/<(script|style|svg)[\s\S]*?<\/\1>/g, ' ').replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/&#39;/g, "'").replace(/\s+/g, ' ');

// Sentences that say the Marketplace or the plugin index is open. A page may say it is NOT open; these patterns do not match that.
const LIVE_CLAIMS = [
  /marketplace (?:is|has) (?:now )?(?:open|live|launched|opened)/i,
  /(?:plugin )?index (?:is|has) (?:now )?(?:open|live|published|launched)/i,
  /now (?:open|live) (?:for|to) (?:submissions|authors)/i,
  /can be installed from (?:there|the marketplace)/i,
  /install(?:ed)? (?:it )?from the marketplace/i,
  /submit (?:it )?now/i,
  /available in the marketplace/i,
];

test('the page set is non-empty and the same with the flag on and off', () => {
  assert.ok(off.pages.length >= 42);
  assert.deepEqual(off.pages.map((p) => p.slug), live.pages.map((p) => p.slug));
});

test('with INDEX_LIVE off, no page claims the Marketplace or the index is live', () => {
  for (const { slug } of off.pages) {
    const text = prose(read(join(tmp, 'off'), slug));
    for (const re of LIVE_CLAIMS) assert.doesNotMatch(text, re, `${slug}: ${re}`);
    assert.doesNotMatch(read(join(tmp, 'off'), slug), /data-state="live"/, slug);
  }
});

test('the claim patterns do catch a live claim (the live build says it)', () => {
  const text = prose(read(join(tmp, 'live'), 'index'));
  assert.ok(LIVE_CLAIMS.some((re) => re.test(text)), 'no pattern matches the live overview');
});

test('every page carries exactly one status banner, not-live with the flag off', () => {
  for (const { slug } of off.pages) {
    const h = read(join(tmp, 'off'), slug);
    assert.equal((h.match(/class="status-banner"/g) ?? []).length, 1, slug);
    assert.match(h, /class="status-banner" data-state="not-live"/, slug);
  }
});

test('every page carries the Fenris Creations disclaimer', () => {
  for (const { slug } of [...off.pages, ...live.pages]) {
    for (const out of ['off', 'live']) {
      const text = prose(read(join(tmp, out), slug));
      assert.match(text, /Fenris Creations hf\. All rights reserved/, `${out} ${slug}`);
      assert.match(text, /not an official|Not an official/, `${out} ${slug}`);
    }
  }
});
