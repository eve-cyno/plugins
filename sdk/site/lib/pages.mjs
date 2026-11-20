// The page registry: for each page of plan section 3, its title, navigation place and body, built from its source of truth.
// A page whose prose is hand-written (Overview, Local testing, ...) reads `site/content/<slug>.md` (slashes become dashes) when that
// file exists; until it does, the page is a stub that says so and lists the sources it will follow. Pages built from a source
// (declarations, the README, the manifest schema, POLICY.md, CONTRIBUTING.md, the scaffold) are complete in their generated parts.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { assignDeclarations, firstSentence, interfaceMembers, namespacesOf } from './dts.mjs';
import { codeBlockHtml, esc, escText, renderInline, renderMarkdown, slugify } from './md.mjs';
import { REPO } from './page.mjs';
import { frozenParts, parseReadme } from './readme.mjs';
import { rowsToHtml, schemaRows } from './schema.mjs';

/** A sentence for a table cell or a lede: empty when it is too long to read at a glance. */
const short = (s) => (s.length <= 220 ? s : '');
const ANCHOR = (id) => `<a class="h-anchor" href="#${id}" aria-label="Link to this section">#</a>`;
const ico = (id) => `<svg class="ico" aria-hidden="true"><use href="#${id}"/></svg>`;

/** The body of one page: html chunks, the "On this page" list and the heading ids already used. */
class Body {
  constructor(mdOpts) { this.parts = []; this.toc = []; this.ids = new Set(); this.mdOpts = mdOpts; }

  raw(html) { this.parts.push(html); return this; }

  h2(text, id = slugify(text)) {
    let uid = id;
    for (let n = 2; this.ids.has(uid); n++) uid = `${id}-${n}`;
    this.ids.add(uid);
    this.toc.push({ id: uid, text });
    this.parts.push(`<h2 id="${uid}">${esc(text)}${ANCHOR(uid)}</h2>`);
    return this;
  }

  p(text) { this.parts.push(`<p>${renderInline(text, this.mdOpts)}</p>`); return this; }

  /** Markdown; its `##` headings (level 2 in the source) join the page's list. `shift` moves heading levels. */
  md(source, extra = {}) {
    const { html, headings } = renderMarkdown(source, { ...this.mdOpts, ids: this.ids, ...extra });
    for (const h of headings) if (h.level + (extra.shift ?? 0) === 2) this.toc.push({ id: h.id, text: h.text });
    this.parts.push(html);
    return this;
  }

  callout(kind, title, text) {
    const icon = { note: 'i-info', tip: 'i-tip', warning: 'i-warn' }[kind];
    this.parts.push(`<aside class="callout" data-kind="${kind}">${ico(icon)}<div><p class="callout-title">${esc(title)}</p><p>${renderInline(text, this.mdOpts)}</p></div></aside>`);
    return this;
  }

  /** `dl.facts` rows: [term, markdown text]. */
  facts(rows) {
    this.parts.push(`<dl class="facts">\n${rows.map(([t, d]) => `<dt>${esc(t)}</dt><dd>${renderInline(d, this.mdOpts)}</dd>`).join('\n')}\n</dl>`);
    return this;
  }

  code(label, text, badge = '') { this.parts.push(codeBlockHtml(label, text, badge)); return this; }

  html() { return this.parts.join('\n'); }
}

/**
 * CONTRIBUTING.md as the submitting page embeds it: without its title and without "Run the checks locally", whose `npm ci` and
 * `npm test` run the index repository's own tests, not an author's project (the page's own text explains `npm run check`).
 */
export function authorFacing(contributing) {
  const cut = contributing.replace(/^# .*\n+/, '').replace(/^## Run the checks locally\n[\s\S]*?(?=^## |(?![\s\S]))/m, '');
  if (cut.includes('## Run the checks locally') || cut === contributing) throw new Error('CONTRIBUTING.md: the "Run the checks locally" section moved (site/lib/pages.mjs authorFacing)');
  return cut;
}

/** The slug of a page as a content file name: `api/types` is `api-types.md`. */
const contentName = (slug) => `${slug.replaceAll('/', '-')}.md`;

/**
 * Status-dependent text in a content file: `<!-- not-live -->...<!-- /not-live -->` is kept only while the INDEX_LIVE flag is off
 * and `<!-- live -->...<!-- /live -->` only while it is on. A marker without its partner fails the build.
 */
export function applyIndexState(text, live, name) {
  const out = text.replace(/<!-- (not-live|live) -->\n?([\s\S]*?)<!-- \/\1 -->\n?/g, (_, kind, inner) => ((kind === 'live') === Boolean(live) ? inner : ''));
  const stray = /<!-- \/?(?:not-)?live -->/.exec(out);
  if (stray) throw new Error(`content ${name}: unpaired marker ${stray[0]}`);
  return out;
}

export const STUB_NOTE = 'This page is a stub. Its text is written in a later step of the plugin docs work. The sources it follows are listed here.';

const FILES_SHOWN = [/^plugin\.json$/, /^package\.json$/, /^tsconfig\.json$/, /^src\//, /^static\//, /^test\//, /^entry\//];
export const ANSWERS = { id: 'dev.example.my-plugin', name: 'My Plugin', author: 'Example Author', description: 'A plugin made with the EVE-Cyno plugin template.' };

/**
 * Builds every page. `ctx` (made by build.mjs): apiVersion, decls, readme (mapSections result), readmeFrozen, manifestSchema,
 * entrySchema, scaffold (Map of generated files), policy, contributing, checkIds, classes, dataAllow, contentDir, repoUrl(path).
 * Returns `[{ slug, section, title, navLabel, ... , body, toc }]` in reading order; `nav` and `searchIndex` come from the same list.
 */
export function buildPages(ctx) {
  const namespaces = namespacesOf(ctx.decls);
  const declPages = assignDeclarations(ctx.decls);
  const apiNs = namespaces.filter((n) => !n.reserved);
  const nsType = new Map(apiNs.map((n) => [n.name, ctx.decls.find((d) => d.name === n.type)]));
  const srcFile = `api/${ctx.apiVersion}.d.ts`;
  const mdOpts = {
    link: (href) => {
      if (/^(https?:|mailto:|#|@@)/.test(href)) return href;
      if (/^[A-Za-z0-9_./-]+\.(md|json|mjs)(#.*)?$/.test(href)) return ctx.repoUrl(href.replace(/#.*$/, ''));
      return null;
    },
  };
  const newBody = () => new Body(mdOpts);
  const contentOf = (slug) => {
    const f = join(ctx.contentDir, contentName(slug));
    return existsSync(f) ? applyIndexState(readFileSync(f, 'utf8'), ctx.indexLive, contentName(slug)) : null;
  };
  /** Hand-written prose: the content file when present, else the stub note and the sources. */
  const prose = (body, slug, sources) => {
    const text = contentOf(slug);
    if (text) body.md(text);
    else {
      body.callout('note', 'Draft', STUB_NOTE);
      body.h2('Sources').facts(sources);
    }
    return body;
  };
  const declBlocks = (body, decls) => { for (const d of decls) body.code(`${d.name} · ${srcFile}`, d.text); };
  const readmeBlocks = (body, slug) => { for (const s of ctx.readme.byPage.get(slug) ?? []) body.md(`${'#'.repeat(s.level)} ${s.heading}\n\n${s.body}`); };

  const pages = [];
  const add = (p) => pages.push({ source: '', crumbs: [], ...p });

  // ---------- Get started
  {
    const body = newBody();
    prose(body, 'index', [
      ['Status flag', 'the build flag `INDEX_LIVE` (off by default), shown in the banner of every page'],
      ['Sandbox facts', 'the plugin API README and `api/' + ctx.apiVersion + '.d.ts`'],
    ]);
    add({
      slug: 'index', section: 'docs', nav: 'Get started', navLabel: 'Overview', title: 'Plugin docs overview',
      lede: 'What an EVE-Cyno plugin is, what it can reach, and how to build one.',
      badges: [{ text: `Plugin API ${ctx.apiVersion}` }], body: body.html(), toc: body.toc,
      source: 'Hand-written, status from the INDEX_LIVE flag', summary: 'Plugin overview',
    });
  }
  {
    const body = newBody();
    const files = ctx.scaffold;
    const tree = [...files.keys()].map((k) => `  ${k}`).join('\n');
    body.h2('Before you start').p('You need Node 22.2 or newer, npm, and the EVE-Cyno desktop app with the developer folder section of Settings > Plugins. A plugin is a folder with a `plugin.json`, one HTML page and a script. It runs in a sandbox and reaches the app only through the [plugin API](@@api).');
    if (!ctx.indexLive) {
      body.raw(`<aside class="callout" data-kind="warning">${ico('i-warn')}<div><p class="callout-title">Nobody can install your plugin yet</p><p>The Marketplace is not live. A plugin you build here runs on your machine, from a folder you chose. You cannot publish it, and no one else can find it. Build it anyway: the same folder is what you will submit.</p></div></aside>`);
    }
    const startText = contentOf('start');
    if (startText) body.md(startText);
    body.h2('Create, build, load');
    const cmd = (c) => `<div class="cmd" data-copy-scope><pre><code>${escText(c)}</code></pre><button class="code-copy" type="button" data-copy aria-label="Copy command">${ico('i-copy')}<span data-copy-label>Copy</span></button></div>`;
    body.raw(`<ol class="steps">
<li><span class="step-t">Create the project</span>${cmd('npm create @eve-cyno/plugin my-plugin')}</li>
<li><span class="step-t">Build it</span>${cmd('cd my-plugin && npm run build')}</li>
<li><span class="step-t">Load the folder</span><p>In the app open <b>Settings &gt; Plugins</b>. Below the plugin list, switch on <b>Load a plugin from a folder</b>, press <b>Choose folder…</b> and pick <code>dist/&lt;your-id&gt;</code>. After each build press <b>Reload</b>.</p></li>
</ol>`);
    body.h2('What you get').p('The template asks for no permission, which is the smallest thing a reviewer can read. One command and one tile action show where `contributes` goes.');
    const tab = (name, label, sel) => `<button class="code-tab" type="button" role="tab" aria-selected="${sel}"${sel ? '' : ' tabindex="-1"'} data-tab="${name}">${esc(label)}</button>`;
    const pre = (name, text, hidden) => `<pre data-panel="${name}"${hidden ? ' hidden' : ''}><code>${escText(text)}</code></pre>`;
    body.raw(`<div class="code" data-tabs data-tab-group="start-file" data-copy-scope>
<div class="code-head">
<div class="code-tabs" role="tablist" aria-label="Generated files">
${tab('tree', 'Files', true)}
${tab('manifest', 'plugin.json', false)}
${tab('main', 'src/main.ts', false)}
</div>
<button class="code-copy" type="button" data-copy aria-label="Copy code">${ico('i-copy')}<span data-copy-label>Copy</span></button>
</div>
${pre('tree', `my-plugin/\n${tree}`, false)}
${pre('manifest', files.get('plugin.json'), true)}
${pre('main', files.get('src/main.ts'), true)}
</div>
<p class="code-cap">Generated at build time from the template, so these tabs always match what <code>npm create</code> writes.</p>`);
    body.h2('What a folder plugin may do').p('A plugin loaded from the developer folder gets the same API as an installed one. These rules stay the same either way.');
    body.raw(`<div class="tbl"><table>
<thead><tr><th>Rule</th><th>Value</th><th>Where it is enforced</th></tr></thead>
<tbody>
<tr><td>Call budget per plugin</td><td class="num">${ctx.callLimit}</td><td>every method except <code>services.result</code></td></tr>
<tr><td>Refused call</td><td><code>rate_limited</code></td><td>before the call runs, nothing happened</td></tr>
<tr><td>Permissions</td><td>only those in <code>plugin.json</code></td><td>the manifest, checked when the folder loads</td></tr>
<tr><td>Engine range</td><td><code>${esc(files.get('plugin.json').match(/"eve-cyno-api":\s*"([^"]+)"/)[1])}</code> or lower</td><td><code>incompatible_api</code> if the app is older</td></tr>
</tbody>
</table></div>`);
    body.h2('Next steps');
    body.raw(`<div class="linkcards">
<a class="linkcard" href="@@tutorial">${ico('i-terminal')}<span class="lc-t">Tutorial</span>${ico('i-arrow').replace('class="ico"', 'class="go"')}<span class="lc-s">Read the generated plugin line by line.</span></a>
<a class="linkcard" href="@@manifest">${ico('i-braces')}<span class="lc-t">plugin.json reference</span>${ico('i-arrow').replace('class="ico"', 'class="go"')}<span class="lc-s">Every property, its type and its limits.</span></a>
</div>`);
    add({
      slug: 'start', section: 'docs', nav: 'Get started', navLabel: 'Getting started', title: 'Getting started',
      lede: 'Create a plugin from the template, build it and load it in the desktop app. About five minutes, no account and no permission request.',
      badges: [{ text: 'Node 22.2 or newer' }, { text: `Plugin API ${ctx.apiVersion}` }, { text: 'Local only for now' }],
      body: body.html(), toc: body.toc, source: 'Built from the template and the API declarations', summary: 'Node 22.2+, one command, a running plugin',
    });
  }
  {
    const body = newBody();
    const text = contentOf('tutorial');
    if (text) body.md(text);
    else body.callout('note', 'Draft', 'This page shows every file the template writes, as the template holds it. The walk-through text is written in a later step.');
    for (const [path, content] of ctx.scaffold) {
      if (!FILES_SHOWN.some((re) => re.test(path))) continue;
      body.h2(path, `file-${slugify(path)}`).code(path, content);
    }
    add({
      slug: 'tutorial', section: 'docs', nav: 'Get started', navLabel: 'Tutorial', title: 'Tutorial',
      lede: 'Walk through the plugin the template generates, file by file.', badges: [{ text: `Plugin API ${ctx.apiVersion}` }],
      body: body.html(), toc: body.toc, source: 'Code blocks read from the template files', summary: 'Walk through the generated plugin',
    });
  }
  {
    const body = prose(newBody(), 'local-testing', [
      ['Developer folder', 'Settings > Plugins, section below the plugin list: one folder, off by default, with Choose folder… and Reload'],
      ['Plan', 'plan section 3, page P4; reviewed before it is written (it states a trust boundary)'],
    ]);
    add({
      slug: 'local-testing', section: 'docs', nav: 'Get started', navLabel: 'Local testing', title: 'Local testing',
      lede: 'Load a plugin folder in the app, reload it after every build, and know what a folder plugin may and may not do.',
      body: body.html(), toc: body.toc, source: 'Hand-written from the developer folder code', summary: 'Load a folder from Settings > Plugins',
    });
  }

  // ---------- Plugin API
  {
    const body = newBody();
    body.h2('Declaration');
    body.p('The `eveCyno` global of a plugin page has the shape of the `EveCyno` interface, the list below.');
    declBlocks(body, declPages.get('api') ?? []);
    body.h2('Namespaces');
    const rows = namespaces.map((n) => {
      const t = nsType.get(n.name);
      const what = n.reserved ? 'Reserved. The type exists; no method does.' : short(firstSentence(t?.doc ?? '')) || `The \`${n.name}\` namespace.`;
      const link = n.reserved ? `<span class="p-name">${esc(n.name)}</span>` : `<a href="@@api/${n.name}"><span class="p-name">${esc(n.name)}</span></a>`;
      return `<tr><td>${link}</td><td>${n.reserved ? 'reserved' : n.optional ? 'optional' : 'always present'}</td><td>${renderInline(what, mdOpts)}</td></tr>`;
    });
    body.raw(`<div class="tbl params"><table>\n<thead><tr><th>Namespace</th><th>Present</th><th>What it is</th></tr></thead>\n<tbody>\n${rows.join('\n')}\n</tbody>\n</table></div>`);
    readmeBlocks(body, 'api');
    body.h2('Engines rule').md(ctx.frozen.engines);
    add({
      slug: 'api', section: 'api', nav: 'Plugin API', navLabel: 'API overview', title: 'Plugin API',
      lede: 'The one entry point, the namespaces behind it, the call limit and the engines rule.',
      badges: [{ text: `Plugin API ${ctx.apiVersion}` }, { text: `${namespaces.filter((n) => !n.reserved).length} namespaces` }],
      body: body.html(), toc: body.toc, source: `Generated from ${srcFile} and the API README`, summary: 'getEveCyno, namespaces, the call limit',
    });
  }
  for (const n of apiNs) {
    const t = nsType.get(n.name);
    const body = newBody();
    body.h2('Declaration', `${n.name}-decl`);
    body.p('Read the namespace from the `eveCyno` global.');
    declBlocks(body, declPages.get(`api/${n.name}`) ?? []);
    const members = t ? interfaceMembers(t) : [];
    if (members.length) {
      body.h2('Members', `${n.name}-members`);
      const documented = members.some((m) => firstSentence(m.doc));
      const rows = members.map((m) => {
        const flat = m.signature.replace(/\s+/g, ' ');
        const ret = /\)\s*:\s*(.+)$/.exec(flat)?.[1] ?? /^[\w$]+\??\s*:\s*(.+)$/.exec(flat)?.[1] ?? '';
        const what = firstSentence(m.doc);
        return `<tr><td><span class="p-name">${esc(m.name)}</span></td><td><span class="p-type">${esc(ret)}</span></td>${documented ? `<td>${renderInline(what, mdOpts)}</td>` : ''}</tr>`;
      });
      body.raw(`<div class="tbl params"><table>\n<thead><tr><th>Member</th><th>Type</th>${documented ? '<th>What it does</th>' : ''}</tr></thead>\n<tbody>\n${rows.join('\n')}\n</tbody>\n</table></div>`);
    }
    readmeBlocks(body, `api/${n.name}`);
    const sentence = short(firstSentence(t?.doc ?? ''));
    add({
      slug: `api/${n.name}`, section: 'api', nav: 'Plugin API', navLabel: n.name, title: n.name, mono: true,
      crumbs: [{ slug: 'api', label: 'API' }],
      lede: sentence || `The \`${n.name}\` namespace of the plugin API.`, ledeHtml: renderInline(sentence || `The \`${n.name}\` namespace of the plugin API.`, mdOpts),
      badges: [{ text: n.optional ? 'optional' : 'always present', cls: n.optional ? 'badge-plain' : 'badge-ok' }],
      body: body.html(), toc: body.toc, source: `Generated from ${srcFile}`, summary: `Namespace ${n.name}`, group: n.optional ? 'Optional' : 'Always present',
    });
  }
  {
    const body = newBody();
    body.h2('Declarations').p('Exported types that no single namespace owns: shared by two or more namespaces, or by none.');
    declBlocks(body, declPages.get('api/types') ?? []);
    add({
      slug: 'api/types', section: 'api', nav: 'Plugin API', navLabel: 'All other types', title: 'All other types',
      crumbs: [{ slug: 'api', label: 'API' }], lede: 'The exported types that are not on a namespace page.',
      body: body.html(), toc: body.toc, source: `Generated from ${srcFile}`, summary: 'Shared exported types',
    });
  }
  {
    const body = newBody();
    body.p('Each entry names what one minor added to the frozen surface. A plugin that uses an addition needs that minor in `engines.eve-cyno-api`.');
    for (const h of ctx.frozen.history) body.h2(h.version, `v${h.version.replaceAll('.', '-')}`).md(h.text.replace(/^\d+\.\d+\.\d+ (\w)/, (_, c) => c.toUpperCase()));
    body.h2('Older snapshots').md(ctx.frozen.snapshots);
    add({
      slug: 'api/versions', section: 'api', nav: 'Plugin API', navLabel: 'What each version added', title: 'What each version added',
      crumbs: [{ slug: 'api', label: 'API' }], lede: `The history of the plugin API, from 1.1.0 to ${ctx.apiVersion}.`,
      body: body.html(), toc: body.toc, source: 'Generated from the API README history', summary: 'What each minor added',
    });
  }

  // ---------- Reference
  {
    const body = newBody();
    const rows = schemaRows(ctx.manifestSchema);
    const top = rows.filter((r) => !/^(permissions|contributes)\./.test(r.path));
    body.h2('Properties', 'manifest-props').p(`${Object.keys(ctx.manifestSchema.properties).length} top-level properties. The tables are generated from the manifest schema, one row per property.`);
    body.raw(rowsToHtml(top));
    for (const [prefix, title] of [['permissions', 'Permissions'], ['contributes', 'Contributes']]) {
      body.h2(title, `manifest-${prefix}`).raw(rowsToHtml(rows.filter((r) => r.path.startsWith(`${prefix}.`)), { head: 'Key' }));
    }
    const text = contentOf('manifest');
    body.h2('Accepted and refused', 'manifest-examples');
    body.p('A block marked accept must pass the app\'s manifest parser, and a block marked refuse must fail with the code it names. A later step checks every block on this page against the parser.');
    body.code('plugin.json', JSON.stringify({ id: 'dev.example.hello', name: 'Hello', version: '0.1.0', engines: { 'eve-cyno-api': '^1.29' }, main: 'main.html' }, null, 2), 'accept');
    body.code('plugin.json · incompatible_api', JSON.stringify({ id: 'dev.example.hello', name: 'Hello', version: '0.1.0', engines: { 'eve-cyno-api': '^2.0' }, main: 'main.html' }, null, 2), 'refuse');
    if (text) body.md(text);
    readmeBlocks(body, 'manifest');
    add({
      slug: 'manifest', section: 'manifest', nav: 'Reference', navLabel: 'plugin.json', title: 'plugin.json', mono: true,
      lede: 'The manifest names your plugin, says which API it needs and lists every permission it asks for. The app refuses a plugin whose manifest breaks a rule below.',
      badges: [{ text: 'schema manifest.v1' }, { text: `${ctx.manifestSchema.required.length} required` }],
      body: body.html(), toc: body.toc, source: 'Generated from manifest.v1.json and the API README', summary: 'Every manifest property',
    });
  }
  {
    const body = newBody();
    const text = contentOf('permissions');
    if (text) body.md(text);
    else body.callout('note', 'Draft', STUB_NOTE);
    body.h2('Permission keys', 'permission-keys');
    const rows = schemaRows(ctx.manifestSchema).filter((r) => /^permissions\.[^.]+$/.test(r.path));
    body.raw(rowsToHtml(rows, { head: 'Key' }));
    body.h2('Built-in plugins only', 'built-in-only');
    const allow = [...ctx.dataAllow].map(([id, packs]) => `\`${id}\` (${packs.map((p) => `\`${p}\``).join(', ')})`).join(', ');
    body.p(`\`permissions.data\` is refused for every plugin id except these built-in plugins: ${allow}.`);
    body.facts([['Source', 'The built-in plugin list of the app and the schema `permissions` object']]);
    add({
      slug: 'permissions', section: 'docs', nav: 'Reference', navLabel: 'Permissions and grants', title: 'Permissions and grants',
      lede: 'What each permission unlocks, how consent works, and what a built-in plugin gets that a third-party plugin does not.',
      body: body.html(), toc: body.toc, source: 'Generated keys and allowlist; prose in a later step', summary: 'What each permission unlocks',
    });
  }
  {
    const body = newBody();
    const text = contentOf('packaging');
    if (text) body.md(text);
    readmeBlocks(body, 'packaging');
    if (!text) body.callout('note', 'Draft', 'The archive limits are the README text above. Worked examples and the check IDs are written in a later step.');
    add({
      slug: 'packaging', section: 'docs', nav: 'Reference', navLabel: 'Archive rules', title: 'Archive rules',
      lede: 'The zip layout and limits of a plugin archive, and what the listing has to repeat from plugin.json.',
      body: body.html(), toc: body.toc, source: 'Generated from the API README', summary: 'Zip layout and limits',
    });
  }

  // ---------- Publish
  {
    const body = newBody();
    const text = contentOf('submitting');
    if (text) body.md(text);
    body.md(authorFacing(ctx.contributing));
    body.h2('Entry file fields', 'entry-fields').p('The schema below covers the repository\'s own fields. The listing fields are checked by the app\'s catalog rules.');
    body.raw(rowsToHtml(schemaRows(ctx.entrySchema, { notes: {} }), { head: 'Field' }));
    add({
      slug: 'submitting', section: 'docs', nav: 'Publish', navLabel: 'Submitting a plugin', title: 'Submitting a plugin', tag: 'not open',
      lede: 'The entry pull request: one file, a release archive at an https URL, its SHA-256 and size.',
      body: body.html(), toc: body.toc, source: 'CONTRIBUTING.md and entry.v1.json, embedded', summary: 'The entry pull request',
    });
  }
  {
    const body = newBody();
    const text = contentOf('checks');
    if (text) body.md(text);
    else body.callout('note', 'Draft', STUB_NOTE);
    body.h2('Check IDs', 'check-ids').p(`The checks run by the index repository: ${ctx.checkIds.map((c) => `\`${c}\``).join(', ')}.`);
    body.h2('Review classes', 'review-classes').p(`A change that sets a class is held for a person to read: ${ctx.classes.map((c) => `\`${c}\``).join(', ')}.`);
    body.facts([['Source', '`tools/check.mjs`, `tools/lib/*.mjs` and `tools/lib/summary.mjs` `CLASSES` of the plugin index repository']]);
    add({
      slug: 'checks', section: 'docs', nav: 'Publish', navLabel: 'Checks C1 to C17', title: 'Checks C1 to C17',
      lede: 'What the index checks run on a submission, and how to run them on your own machine.',
      body: body.html(), toc: body.toc, source: 'Check IDs read from the index tools', summary: 'What review runs',
    });
  }
  {
    const body = newBody();
    body.md(ctx.policy.replace(/^# .*\n+/, ''));
    add({
      slug: 'policy', section: 'docs', nav: 'Publish', navLabel: 'Review policy', title: 'Review policy',
      lede: 'What gets a plugin listed, held for review or refused.', body: body.html(), toc: body.toc,
      source: 'POLICY.md, embedded', summary: 'What gets a plugin refused',
    });
  }
  {
    const body = newBody();
    const text = contentOf('signing');
    if (text) body.md(text);
    else body.callout('note', 'Draft', STUB_NOTE);
    const sections = parseReadme(ctx.policy).sections.filter((s) => ['Mirroring', 'Revocation'].includes(s.key));
    for (const s of sections) body.md(`## ${s.heading}\n\n${s.body}`);
    add({
      slug: 'signing', section: 'docs', nav: 'Publish', navLabel: 'Signing and the index', title: 'Signing and the index',
      lede: 'What the signed index means for an author: the mirror, revocation and lift.', body: body.html(), toc: body.toc,
      source: 'POLICY.md sections; prose in a later step', summary: 'What the signed index means for an author',
    });
  }
  {
    const body = newBody();
    const text = contentOf('licence');
    if (text) body.md(text);
    else {
      body.h2('Licences', 'licences').raw(`<div class="tbl"><table>
<thead><tr><th>Piece</th><th>Licence</th></tr></thead>
<tbody>
<tr><td>The scaffold package <code>@eve-cyno/create-plugin</code></td><td>MIT</td></tr>
<tr><td>The files the scaffold writes into your project</td><td>MIT-0: you owe no notice and pick any licence for your plugin</td></tr>
<tr><td>The plugin API types (bundled and vendored)</td><td>MIT</td></tr>
<tr><td>This documentation site, code and text</td><td>MIT</td></tr>
</tbody>
</table></div>`);
      body.callout('note', 'Draft', 'Wording and the full notices are written in a later step. The disclaimer about EVE Online and Fenris Creations is in the footer of every page.');
    }
    add({
      slug: 'licence', section: 'docs', nav: 'Project', navLabel: 'Licences', title: 'Licences',
      lede: 'The licences of the SDK, the template output and these docs.', body: body.html(), toc: body.toc,
      source: 'Hand-written', summary: 'SDK, template output and docs',
    });
  }

  // `@@slug` in a body is a link to another page; build.mjs turns it into that page's URL and fails on an unknown slug
  return { pages, namespaces };
}

/** The navigation (as `makeSite` takes it) from the built pages. */
export function buildNav(pages) {
  const by = (slug) => pages.find((p) => p.slug === slug);
  const item = (slug) => ({ slug, label: by(slug).navLabel, tag: by(slug).tag });
  const ns = pages.filter((p) => p.slug.startsWith('api/') && p.group);
  const groups = ['Always present', 'Optional'].map((title) => ({ title, items: ns.filter((p) => p.group === title).map((p) => item(p.slug)) }));
  return [
    { cap: 'Get started', items: ['index', 'start', 'tutorial', 'local-testing'].map(item) },
    { cap: 'Plugin API', items: [{ ...item('api'), groups }, item('api/types'), item('api/versions')] },
    { cap: 'Reference', items: ['manifest', 'permissions', 'packaging'].map(item) },
    { cap: 'Publish', items: ['submitting', 'checks', 'policy', 'signing'].map(item) },
    { cap: 'Project', items: [item('licence')], external: { href: REPO, label: 'Plugin repository' } },
  ];
}

/** The search index the design's `data-site.js` reads: `[{ t, u, k, s }]`. */
export function buildSearchIndex(pages, url) {
  return pages.map((p) => ({ t: p.navLabel, u: url(p.slug), k: p.group ? 'tool' : 'page', s: p.summary ?? '' }));
}
