// The page shell, ported from the design entry (site/design/plugin-docs-2026-11-20.html): top bar, status banner, left navigation,
// article frame, footer. Class names, ids and data-* hooks are the design's, byte for byte. The icon sprite and the footer (Fenris
// disclaimer included) are cut out of the pinned snapshot, so they cannot drift from it. What the build adds: real URLs instead of
// the design's `#page=` hash links, the navigation from the API namespaces, one status banner from the INDEX_LIVE flag, and the
// search index. No script is written here except the search index (JSON, not code) and the design's own `data-site.js`.
import { readFileSync } from 'node:fs';
import { esc } from './md.mjs';

export const SITE_NAME = 'EVE-CYNO plugin docs';
export const DISCORD = 'https://discord.gg/XZzkH38dt9';
export const REPO = 'https://github.com/eve-cyno/plugins';

const LOCKUP = '<a class="lockup pd-lockup" href="HOME" aria-label="EVE-CYNO plugin docs home"><svg class="pd-mark" viewBox="0 0 64 64" role="img" aria-hidden="true" focusable="false"><path d="M48.85 14.86A24 24 0 1 0 48.85 49.14" fill="none" stroke="currentColor" stroke-width="6"/><path d="M32 23L41 32L32 41L23 32Z" fill="currentColor"/><path d="M45 29.5L63 32L45 34.5Z" fill="currentColor"/></svg><span class="pd-wm">EVE-CYNO<small>Plugins</small></span></a>';
const ico = (id) => `<svg class="ico" aria-hidden="true"><use href="#${id}"/></svg>`;

/** The pinned snapshot's sprite and footer, cut out as text. Throws when the snapshot no longer has the expected markers. */
export function loadDesign(snapshotPath) {
  const html = readFileSync(snapshotPath, 'utf8');
  const cut = (start, end) => {
    const a = html.indexOf(start);
    const b = html.indexOf(end, a);
    if (a < 0 || b < 0) throw new Error(`design snapshot: no block between ${start} and ${end}`);
    return html.slice(a, b + end.length);
  };
  return {
    sprite: cut('<svg width="0" height="0" style="position:absolute" aria-hidden="true">', '</svg>'),
    footer: cut('<footer class="site-foot">', '</footer>'),
    bannerNotLive: cut('<aside class="status-banner" data-state="not-live"', '</aside>'),
    bannerLive: cut('<aside class="status-banner" data-state="live"', '</aside>'),
  };
}

/**
 * Builds the shared parts for one site: `site.url(slug)` and `site.render(page)`.
 * `site`: { base, indexLive, apiVersion, design, nav, pages, searchIndex }.
 *   nav: [{ cap, items: [{ slug, label, tag? , group? }] }], where an item with `group: [{ title, open?, slugs: [{slug,label}] }]`
 *   holds the namespace sub-lists. `pages`: the ordered page list (for the pager).
 */
export function makeSite({ base, indexLive, apiVersion, design, nav, order, searchIndex }) {
  const url = (slug) => (slug === 'index' ? base : `${base}${slug}/`);
  const asset = (name) => `${base}assets/${name}`;
  const rewrite = (html) => html.replace(/href="#page=([^"]+)"/g, (_, slug) => `href="${url(slug)}"`);
  const stateHtml = indexLive ? design.bannerLive.replace('role="status" aria-label="Marketplace status" hidden>', 'role="status" aria-label="Marketplace status">') : design.bannerNotLive;
  const banner = rewrite(stateHtml);
  const lockup = (home) => LOCKUP.replace('HOME', home);

  function navHtml(current) {
    const link = (item, cls) => `<a class="${cls}" href="${url(item.slug)}" data-nav="${esc(item.slug)}"${item.slug === current ? ' aria-current="page"' : ''}>${esc(item.label)}</a>`;
    const parts = nav.map((sec) => {
      const lis = sec.items.map((it) => {
        const tag = it.tag && !indexLive ? `<span class="nav-tag" data-state-tag="not-live">${esc(it.tag)}</span>` : '';
        let head = link(it, 'nav-link');
        if (tag) head = head.replace('</a>', `${tag}</a>`);
        if (!it.groups) return `<li>${head}</li>`;
        const subs = it.groups.map((g, gi) => {
          const open = gi === 0 || g.items.some((x) => x.slug === current);
          const lis2 = g.items.map((x) => `<li>${link(x, 'nav-tool')}</li>`).join('\n              ');
          return `<details class="nav-sub"${open ? ' open' : ''}>\n            <summary>${ico('i-chev')}${esc(g.title)}<span class="n">${g.items.length}</span></summary>\n            <ul>\n              ${lis2}\n            </ul>\n          </details>`;
        }).join('\n          ');
        return `<li>${head}\n          ${subs}\n        </li>`;
      }).join('\n        ');
      const ext = sec.external ? `\n        <li><a class="nav-link" href="${esc(sec.external.href)}">${esc(sec.external.label)}${ico('i-ext')}</a></li>` : '';
      return `      <p class="nav-cap">${esc(sec.cap)}</p>\n      <ul class="nav-list">\n        ${lis}${ext}\n      </ul>`;
    }).join('\n');
    return `<aside class="docs-nav" data-drawer aria-label="Documentation">
    <div class="nav-head">
      ${lockup(url('index'))}
      <button class="icon-btn" type="button" data-drawer-close aria-label="Close menu">${ico('i-close')}</button>
    </div>
    <div class="nav-meta">
      <span class="nav-ver">API ${esc(apiVersion)}</span>
      <span class="nav-status"><i aria-hidden="true"></i>index: <span data-slot="index-state">${indexLive ? 'live' : 'not live'}</span></span>
    </div>
    <nav aria-label="Docs pages">
${parts}
    </nav>
    <a class="nav-discord" href="${DISCORD}">${ico('i-discord')}<span><b>Questions?</b>Ask on the EVE-Cyno Discord</span></a>
  </aside>`;
  }

  function topbar(section) {
    const cur = (name) => (section === name ? ' aria-current="page"' : '');
    return `<header class="topbar">
  <div class="topbar-in">
    <button class="icon-btn topbar-menu" type="button" data-drawer-open aria-label="Open documentation menu" aria-expanded="false">${ico('i-menu')}</button>
    ${lockup(url('index'))}
    <nav class="topnav" aria-label="Main">
      <a href="${url('start')}"${cur('docs')}>Docs</a>
      <a href="${url('api')}"${cur('api')}>API</a>
      <a href="${url('manifest')}"${cur('manifest')}>Manifest</a>
    </nav>
    <div class="topbar-actions">
      <div class="search" data-search>
        <div class="search-field">
          ${ico('i-search')}
          <input class="search-input" id="docsSearch" type="search" placeholder="Search plugin docs" aria-label="Search plugin docs" autocomplete="off" spellcheck="false" role="combobox" aria-expanded="false" aria-autocomplete="list" data-search-input>
          <kbd class="kbd" aria-hidden="true">/</kbd>
          <button class="search-close" type="button" data-search-close aria-label="Close search">${ico('i-close')}</button>
        </div>
        <div class="search-results" role="listbox" aria-label="Search results" data-search-results hidden></div>
      </div>
      <button class="icon-btn search-toggle" type="button" data-search-toggle aria-label="Search">${ico('i-search')}</button>
      <a class="btn-ghost topbar-discord" href="${DISCORD}" aria-label="EVE-Cyno Discord">${ico('i-discord')}<span class="label">Discord</span></a>
    </div>
  </div>
</header>`;
  }

  function article(page) {
    const i = order.indexOf(page.slug);
    const prev = i > 0 ? order[i - 1] : null;
    const next = i >= 0 && i < order.length - 1 ? order[i + 1] : null;
    const pg = (slug, dir) => {
      if (!slug) return '';
      const label = site.pageIndex.get(slug);
      const mono = label.mono ? ' mono' : '';
      return dir === 'prev'
        ? `<a class="prev" href="${url(slug)}"><span class="pg-k">${ico('i-back')}Previous</span><span class="pg-t${mono}">${esc(label.label)}</span></a>`
        : `<a class="next" href="${url(slug)}"><span class="pg-k">Next${ico('i-arrow')}</span><span class="pg-t${mono}">${esc(label.label)}</span></a>`;
    };
    const crumbs = [`<li><a href="${url('index')}">Docs</a></li>`];
    for (const c of page.crumbs ?? []) crumbs.push(`<li><a href="${url(c.slug)}">${esc(c.label)}</a></li>`);
    crumbs.push(`<li aria-current="page">${esc(page.crumb ?? page.navLabel)}</li>`);
    const badges = (page.badges ?? []).map((b) => `<span class="badge ${b.cls ?? 'badge-plain'}">${esc(b.text)}</span>`).join('');
    const toc = (page.toc ?? []).map((t) => `<li><a href="#${esc(t.id)}">${esc(t.text)}</a></li>`).join('\n      ');
    return `<article class="doc" data-page="${esc(page.slug)}">
  <header class="doc-head">
    <ol class="crumbs">${crumbs.join('')}</ol>
    <h1${page.mono ? ' class="mono"' : ''}>${esc(page.title)}</h1>
    ${badges ? `<div class="doc-badges">${badges}</div>` : ''}
    <p class="doc-lede">${page.ledeHtml ?? esc(page.lede)}</p>
  </header>
  <details class="toc" data-toc open>
    <summary>${ico('i-chev')}On this page</summary>
    <ul>
      ${toc}
    </ul>
    <div class="toc-more"><a href="${DISCORD}">${ico('i-discord')}Ask on Discord</a><a href="#top">${ico('i-up')}Back to top</a></div>
  </details>
  <div class="doc-body prose">
${page.body}

    <nav class="pager" aria-label="Previous and next page">
      ${pg(prev, 'prev')}
      ${pg(next, 'next')}
    </nav>
    <p class="doc-foot"><span>Mistake on this page? <a href="${DISCORD}">EVE-Cyno Discord</a></span><span>${esc(page.source)} · <span data-slot="version">api ${esc(apiVersion)}</span></span></p>
  </div>
</article>`;
  }

  const site = {
    url,
    pageIndex: new Map(),
    /** A full HTML document for one page. */
    render(page) {
      const title = `${page.title} · ${SITE_NAME}`;
      const search = JSON.stringify(searchIndex).replace(/</g, '\\u003c').replace(new RegExp('\\u2028', 'g'), '\\u2028').replace(new RegExp('\\u2029', 'g'), '\\u2029');
      return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>${esc(title)}</title>
<meta name="description" content="${esc(page.description ?? page.lede ?? SITE_NAME)}">
<link rel="icon" href="${asset('favicon.svg')}" type="image/svg+xml">
<link rel="icon" type="image/svg+xml" sizes="16x16" href="${asset('favicon-small.svg')}">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@300;400;500;600;700&family=JetBrains+Mono:wght@400;500;600&display=swap" rel="stylesheet">
<link rel="stylesheet" href="${asset('site-base.css')}">
<link rel="stylesheet" href="${asset('data-docs.css')}">
<link rel="stylesheet" href="${asset('plugin-docs.css')}">
</head>
<body class="docs-page">
<a class="skip" href="#main">Skip to content</a>

${design.sprite}

${topbar(page.section)}
<div class="scrim" data-drawer-scrim></div>

${banner}

<div class="docs">

  ${navHtml(page.slug)}

  <main class="docs-main" id="main">

${article(page)}

  </main>
</div>

${rewrite(design.footer)}

<script type="application/json" data-search-index>${search}</script>
<script src="${asset('data-site.js')}" defer></script>
</body>
</html>
`;
    },
  };
  return site;
}
