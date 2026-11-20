import assert from 'node:assert/strict';
import { test } from 'node:test';
import { esc, renderInline, renderMarkdown, slugify } from '../lib/md.mjs';

test('slugify makes stable ids', () => {
  assert.equal(slugify('Frozen surface (1.29.0)'), 'frozen-surface-1-29-0');
  assert.equal(slugify('  --  '), 'section');
});

test('inline: code, bold, emphasis and links; raw HTML is escaped', () => {
  assert.equal(renderInline('use `a<b` and **bold** and *soft*'), 'use <code>a&lt;b</code> and <b>bold</b> and <em>soft</em>');
  assert.equal(renderInline('<script>alert(1)</script>'), '&lt;script&gt;alert(1)&lt;/script&gt;');
  assert.equal(renderInline('[x](https://e.example/a?b=1&c=2)'), '<a href="https://e.example/a?b=1&amp;c=2">x</a>');
  assert.equal(renderInline('snake_case_name and 2*3*4'), 'snake_case_name and 2*3*4');
});

test('inline: a link with an unsafe scheme is written as its text', () => {
  assert.equal(renderInline('[x](javascript:alert(1))'), 'x');
  assert.equal(renderInline('[x](data:text/html;base64,AA)'), 'x');
});

test('inline: the link hook rewrites or drops a target', () => {
  assert.equal(renderInline('[a](x.md)', { link: (h) => `/p/${h}` }), '<a href="/p/x.md">a</a>');
  assert.equal(renderInline('[a](x.md)', { link: () => null }), 'a');
});

test('headings get unique ids, an anchor and the level shift', () => {
  const { html, headings } = renderMarkdown('## Files\n\ntext\n\n## Files\n\n### Sub', { shift: 1 });
  assert.deepEqual(headings.map((h) => [h.level, h.id]), [[2, 'files'], [2, 'files-2'], [3, 'sub']]);
  assert.match(html, /<h3 id="files">Files<a class="h-anchor" href="#files" aria-label="Link to this section">#<\/a><\/h3>/);
  assert.match(html, /<h4 id="sub">/);
});

test('paragraphs join hard-wrapped lines', () => {
  assert.equal(renderMarkdown('one\ntwo\n\nthree').html, '<p>one two</p>\n<p>three</p>');
});

test('fenced code is escaped and carries the verdict badge', () => {
  const { html } = renderMarkdown('```json refuse:incompatible_api\n{ "a": "<b>" }\n```');
  assert.match(html, /<span class="code-label">json · incompatible_api<\/span><span class="badge badge-bad">refuse<\/span>/);
  assert.match(html, /<pre><code>\{ "a": "&lt;b&gt;" \}<\/code><\/pre>/);
  assert.match(renderMarkdown('```json accept\n{}\n```').html, /badge badge-ok">accept/);
  assert.match(renderMarkdown('```\nx\n```').html, /code-label">text</);
});

test('a fence is closed only by a fence of its own kind', () => {
  const { html } = renderMarkdown('````\n```\ninner\n```\n````\n\nafter');
  assert.match(html, /<code>```\ninner\n```<\/code>/);
  assert.match(html, /<p>after<\/p>/);
});

test('lists: tight items, continuation lines, nesting, numbered', () => {
  const src = '- one\n  more\n- two\n  - inner a\n  - inner b\n- three\n\n1. first\n2. second';
  const { html } = renderMarkdown(src);
  assert.match(html, /<li>one more<\/li>/);
  assert.match(html, /<li>two\n<ul>\n<li>inner a<\/li>\n<li>inner b<\/li>\n<\/ul><\/li>/);
  assert.match(html, /<ol>\n<li>first<\/li>\n<li>second<\/li>\n<\/ol>/);
});

test('tables: header, rows, a pipe inside code and an escaped pipe', () => {
  const { html } = renderMarkdown('| A | B |\n|---|---|\n| `x|y` | a \\| b |\n| 2 | |');
  assert.match(html, /<div class="tbl"><table>/);
  assert.match(html, /<th>A<\/th><th>B<\/th>/);
  assert.match(html, /<td><code>x\|y<\/code><\/td><td>a \| b<\/td>/);
  assert.match(html, /<td>2<\/td><td><\/td>/);
});

test('block quote becomes a callout, [!WARNING] picks the kind and title', () => {
  const { html } = renderMarkdown('> [!WARNING] Careful\n> It breaks.');
  assert.match(html, /<aside class="callout" data-kind="warning">/);
  assert.match(html, /<p class="callout-title">Careful<\/p><p>It breaks\.<\/p>/);
  assert.match(renderMarkdown('> plain').html, /data-kind="note"/);
});

test('a README-shaped sample renders without losing text', () => {
  const src = '## Entry point\n\n`import { getEveCyno } from \'@eve-cyno/plugin-api\'` resolves to JS.\n\n**Call limit.** 100 calls.';
  const { html } = renderMarkdown(src);
  assert.match(html, /<code>import \{ getEveCyno \} from '@eve-cyno\/plugin-api'<\/code> resolves to JS\./);
  assert.match(html, /<b>Call limit\.<\/b> 100 calls\./);
});

test('esc covers the five characters', () => {
  assert.equal(esc(`<&>"'`), '&lt;&amp;&gt;&quot;&#39;');
});
