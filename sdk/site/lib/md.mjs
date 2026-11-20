// A small Markdown renderer for the subset the plugin-api README, POLICY.md, CONTRIBUTING.md and the site's own guides use:
// headings (with ids), paragraphs, bullet and numbered lists (nested, lazy continuation lines), fenced code, block quotes, tables,
// rules, and inline code, links, bold and emphasis. Raw HTML in the source is escaped, never passed through. No dependency.
// Output markup uses the classes of the design entry (site/design/plugin-docs-2026-11-20.html).

const ENTITY = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ENTITY[c]);
/** Escape for element content (code): the two quote characters stay as they are. */
export const escText = (s) => String(s).replace(/[&<>]/g, (c) => ENTITY[c]);

/** A URL fragment id for a heading: lowercase, runs of non-alphanumerics become one dash. */
export function slugify(text) {
  const s = String(text).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return s || 'section';
}

const SAFE_URL = /^(?:https?:|mailto:|#|@@[\w/-]+$|\/|\.{0,2}\/|[A-Za-z0-9_.-]+(?:[/?#][^:]*)?$)/;
const CODE_MARK = '';
const ICONS = { note: 'i-info', tip: 'i-tip', warning: 'i-warn' };

/**
 * Inline Markdown to HTML. `opts.link(href)` may rewrite a link target (it gets the raw target, returns the target to write);
 * a target that is not http(s), mailto, a fragment or a relative path is written as plain text, never as a link.
 */
export function renderInline(text, opts = {}) {
  const codes = [];
  let s = String(text).replace(/(`+)([\s\S]*?[^`])\1(?!`)/g, (_, _t, body) => {
    codes.push(`<code>${escText(body.replace(/^ (.*) $/s, '$1'))}</code>`);
    return `${CODE_MARK}${codes.length - 1}${CODE_MARK}`;
  });
  s = s.replace(/<(https?:\/\/[^>\s]+)>/g, (_, url) => {
    codes.push(`<a href="${esc(url)}">${esc(url)}</a>`);
    return `${CODE_MARK}${codes.length - 1}${CODE_MARK}`;
  });
  s = esc(s);
  s = s.replace(/\[([^\]]+)\]\(((?:[^()\s]|\([^()\s]*\))+)\)/g, (m, label, href) => {
    const raw = href.replace(/&amp;/g, '&');
    const target = opts.link ? opts.link(raw) : raw;
    if (target == null || !SAFE_URL.test(target)) return label;
    return `<a href="${esc(target)}">${label}</a>`;
  });
  s = s.replace(/\*\*([^*]+?)\*\*/g, '<b>$1</b>');
  s = s.replace(/(^|[^\w*])\*([^*\s][^*]*?)\*(?![\w*])/g, '$1<em>$2</em>');
  return s.replace(new RegExp(`${CODE_MARK}(\\d+)${CODE_MARK}`, 'g'), (_, i) => codes[Number(i)]);
}

const FENCE = /^(\s*)(`{3,}|~{3,})\s*([^`\s]*)\s*(.*)$/;
const BULLET = /^(\s*)([-*+])\s+(.*)$/;
const NUMBERED = /^(\s*)(\d+)[.)]\s+(.*)$/;
const HEADING = /^(#{1,6})\s+(.*?)\s*#*\s*$/;
const RULE = /^\s*([-*_])(\s*\1){2,}\s*$/;
const TABLE_SEP = /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?\s*$/;

const indentOf = (line) => line.length - line.trimStart().length;

function splitCells(line) {
  let t = line.trim();
  if (t.startsWith('|')) t = t.slice(1);
  if (t.endsWith('|') && !t.endsWith('\\|')) t = t.slice(0, -1);
  const cells = [];
  let cur = '';
  let inCode = false;
  for (let i = 0; i < t.length; i++) {
    const c = t[i];
    if (c === '`') inCode = !inCode;
    if (c === '\\' && t[i + 1] === '|') { cur += '|'; i++; continue; }
    if (c === '|' && !inCode) { cells.push(cur.trim()); cur = ''; continue; }
    cur += c;
  }
  cells.push(cur.trim());
  return cells;
}

/** The design's `.code` block for a label and the text of the code (escaped here). `badge` is `accept`, `refuse` or ''. */
export function codeBlockHtml(label, text, badge = '') {
  const b = badge === 'accept' ? '<span class="badge badge-ok">accept</span>' : badge === 'refuse' ? '<span class="badge badge-bad">refuse</span>' : '';
  return `<div class="code" data-copy-scope>\n<div class="code-head"><span class="code-label">${esc(label)}</span>${b}<button class="code-copy" type="button" data-copy aria-label="Copy code"><svg class="ico" aria-hidden="true"><use href="#i-copy"/></svg><span data-copy-label>Copy</span></button></div>\n<pre><code>${escText(text)}</code></pre>\n</div>`;
}

function codeBlock(lang, extra, bodyLines) {
  const words = extra.split(/\s+/).filter(Boolean);
  let badge = '';
  let code = '';
  for (const w of words) {
    if (w === 'accept') badge = 'accept';
    else if (w.startsWith('refuse')) { badge = 'refuse'; code = w.split(':')[1] || ''; }
  }
  return codeBlockHtml([lang || 'text', code].filter(Boolean).join(' · '), bodyLines.join('\n'), badge);
}

/**
 * Markdown to `{ html, headings }`. `headings` lists every heading as `{ level, id, text }` in source order (ids are unique within
 * one call, or across calls that share `opts.ids`, a Set). `opts.shift` moves heading levels (a `##` becomes `<h3>` with shift 1).
 */
export function renderMarkdown(source, opts = {}) {
  const ids = opts.ids ?? new Set();
  const headings = [];
  const shift = opts.shift ?? 0;
  const inline = (t) => renderInline(t, opts);

  function uniqueId(text) {
    const base = slugify(text);
    let id = base;
    for (let n = 2; ids.has(id); n++) id = `${base}-${n}`;
    ids.add(id);
    return id;
  }

  function blocks(lines) {
    const out = [];
    let i = 0;
    while (i < lines.length) {
      const line = lines[i];
      if (!line.trim()) { i++; continue; }

      const f = FENCE.exec(line);
      if (f) {
        const body = [];
        i++;
        while (i < lines.length && !(lines[i].trim().startsWith(f[2]) && lines[i].trim().replace(/[`~]/g, '') === '')) {
          body.push(lines[i].startsWith(f[1]) ? lines[i].slice(f[1].length) : lines[i].trimStart());
          i++;
        }
        i++;
        out.push(codeBlock(f[3], f[4], body));
        continue;
      }

      const h = HEADING.exec(line);
      if (h) {
        const level = Math.min(6, h[1].length + shift);
        const text = h[2];
        const id = uniqueId(text);
        headings.push({ level: h[1].length, id, text });
        out.push(`<h${level} id="${id}">${inline(text)}<a class="h-anchor" href="#${id}" aria-label="Link to this section">#</a></h${level}>`);
        i++;
        continue;
      }

      if (RULE.test(line) && !BULLET.test(line)) { out.push('<hr>'); i++; continue; }

      if (line.includes('|') && i + 1 < lines.length && TABLE_SEP.test(lines[i + 1]) && lines[i + 1].includes('-')) {
        const head = splitCells(line);
        i += 2;
        const rows = [];
        while (i < lines.length && lines[i].trim() && lines[i].includes('|')) rows.push(splitCells(lines[i++]));
        const th = head.map((c) => `<th>${inline(c)}</th>`).join('');
        const tr = rows.map((r) => `<tr>${head.map((_, k) => `<td>${inline(r[k] ?? '')}</td>`).join('')}</tr>`).join('\n');
        out.push(`<div class="tbl"><table>\n<thead><tr>${th}</tr></thead>\n<tbody>\n${tr}\n</tbody>\n</table></div>`);
        continue;
      }

      if (/^\s*>/.test(line)) {
        const quoted = [];
        while (i < lines.length && /^\s*>/.test(lines[i])) quoted.push(lines[i++].replace(/^\s*> ?/, ''));
        let kind = 'note';
        let title = '';
        const m = /^\[!(NOTE|TIP|WARNING)\]\s*(.*)$/i.exec(quoted[0] ?? '');
        if (m) { kind = m[1].toLowerCase(); title = m[2]; quoted.shift(); }
        const inner = blocks(quoted).join('\n');
        const head = title ? `<p class="callout-title">${inline(title)}</p>` : '';
        out.push(`<aside class="callout" data-kind="${kind}"><svg class="ico" aria-hidden="true"><use href="#${ICONS[kind]}"/></svg><div>${head}${inner}</div></aside>`);
        continue;
      }

      const lm = BULLET.exec(line) || NUMBERED.exec(line);
      if (lm) {
        const ordered = !BULLET.test(line);
        const baseIndent = lm[1].length;
        const items = [];
        while (i < lines.length) {
          const cur = lines[i];
          const m = (ordered ? NUMBERED : BULLET).exec(cur);
          if (!m || m[1].length !== baseIndent) break;
          const itemLines = [m[3]];
          i++;
          while (i < lines.length) {
            const nxt = lines[i];
            if (!nxt.trim()) {
              // a blank line followed by a deeper-indented line keeps the item open
              let j = i;
              while (j < lines.length && !lines[j].trim()) j++;
              if (j < lines.length && indentOf(lines[j]) > baseIndent && !(FENCE.test(lines[j]) && indentOf(lines[j]) <= baseIndent)) { itemLines.push(''); i++; continue; }
              break;
            }
            const sib = (ordered ? NUMBERED : BULLET).exec(nxt);
            if (sib && sib[1].length === baseIndent) break;
            if (indentOf(nxt) <= baseIndent && (HEADING.test(nxt) || FENCE.test(nxt) || BULLET.test(nxt) || NUMBERED.test(nxt))) break;
            itemLines.push(indentOf(nxt) > baseIndent ? nxt.slice(Math.min(indentOf(nxt), baseIndent + 2)) : nxt);
            i++;
          }
          items.push(itemLines);
        }
        const tag = ordered ? 'ol' : 'ul';
        const lis = items.map((il) => {
          const inner = blocks(il);
          const loose = il.some((l) => !l.trim());
          const text = inner.map((b, k) => (!loose && k === 0 && b.startsWith('<p>') && b.endsWith('</p>') && !b.slice(3, -4).includes('<p>') ? b.slice(3, -4) : b)).join('\n');
          return `<li>${text}</li>`;
        });
        out.push(`<${tag}>\n${lis.join('\n')}\n</${tag}>`);
        continue;
      }

      // paragraph: consecutive lines until a blank line or the start of another block
      const para = [line.trim()];
      i++;
      while (i < lines.length) {
        const nxt = lines[i];
        if (!nxt.trim() || FENCE.test(nxt) || HEADING.test(nxt) || /^\s*>/.test(nxt) || BULLET.test(nxt) || NUMBERED.test(nxt)) break;
        if (nxt.includes('|') && i + 1 < lines.length && TABLE_SEP.test(lines[i + 1])) break;
        para.push(nxt.trim());
        i++;
      }
      out.push(`<p>${inline(para.join(' '))}</p>`);
    }
    return out;
  }

  const html = blocks(String(source).replace(/\r\n?/g, '\n').split('\n')).join('\n');
  return { html, headings };
}
