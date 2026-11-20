#!/usr/bin/env node
// The plugin docs site generator. Zero dependencies. Reads the vendored plugin API (declarations and README), the vendored host's
// manifest schema, the index repository's POLICY.md, CONTRIBUTING.md, entry schema and check tools, and the scaffold's template,
// and writes static HTML (one file per URL) plus the design's CSS and script.
//
//   node site/build.mjs [--out <dir>] [--base /plugins/] [--index-live]
//
// --index-live (or INDEX_LIVE=true) draws the "Marketplace is open" banner on every page. It is off by default: the public index
// is not published, and no page may say it is. `build()` is the same thing as a function, for the tests.
import { copyFileSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { render as renderScaffold } from '../create-plugin/lib/generate.mjs';
import { parseDts } from './lib/dts.mjs';
import { copyFonts, fontsCss } from './lib/fonts.mjs';
import { loadDesign, makeSite, REPO } from './lib/page.mjs';
import { ANSWERS, buildNav, buildPages, buildSearchIndex } from './lib/pages.mjs';
import { frozenParts, mapSections, readReadme } from './lib/readme.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
export const SDK_ROOT = resolve(HERE, '..');
export const REPO_ROOT = resolve(SDK_ROOT, '..');
export const DESIGN_DIR = join(HERE, 'design');
export const FONTS_DIR = join(HERE, 'assets', 'fonts');
export const DESIGN_SNAPSHOT = join(DESIGN_DIR, 'plugin-docs-2026-11-20.html');
const ASSETS = ['site-base.css', 'data-docs.css', 'plugin-docs.css', 'data-site.js', 'favicon.svg', 'favicon-small.svg'];
const CALL_LIMIT = '100 calls, refilled at 100 a second';

export const HEADERS = `/*
  Content-Security-Policy: default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; font-src 'self'; img-src 'self' data:; connect-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'
  X-Content-Type-Options: nosniff
  Referrer-Policy: strict-origin-when-cross-origin
`;

const read = (...p) => readFileSync(join(...p), 'utf8');

/** The check ids (C1 to C17) named in the index repository's check tools, and the review classes of summary.mjs. */
export function readChecks(repoRoot) {
  const files = [join(repoRoot, 'tools', 'check.mjs'), ...readdirSync(join(repoRoot, 'tools', 'lib')).filter((f) => f.endsWith('.mjs')).map((f) => join(repoRoot, 'tools', 'lib', f))];
  const ids = new Set();
  for (const f of files) for (const m of readFileSync(f, 'utf8').matchAll(/\bC(1[0-7]|[1-9])\b/g)) ids.add(Number(m[1]));
  const classes = /export const CLASSES = \[([^\]]*)\]/.exec(read(repoRoot, 'tools', 'lib', 'summary.mjs'));
  if (!classes) throw new Error('tools/lib/summary.mjs: no CLASSES list');
  return { checkIds: [...ids].sort((a, b) => a - b).map((n) => `C${n}`), classes: [...classes[1].matchAll(/'([^']+)'/g)].map((m) => m[1]) };
}

/** Everything the pages are built from, read once. */
export function gather({ repoRoot = REPO_ROOT, sdkRoot = SDK_ROOT, contentDir = join(HERE, 'content') } = {}) {
  const apiDir = join(sdkRoot, 'vendor', 'plugin-api');
  const apiVersion = JSON.parse(read(apiDir, 'PIN.json')).version;
  const readme = mapSections(readReadme(join(apiDir, 'README.md')));
  const entryText = readme.byPage.get('api')?.find((s) => s.key === 'Entry point')?.body ?? '';
  if (!entryText.includes(CALL_LIMIT)) throw new Error(`the API README no longer says "${CALL_LIMIT}" (site/build.mjs CALL_LIMIT)`);
  const hostDist = join(repoRoot, 'vendor', 'eve-cyno-host', 'host', 'dist');
  const { checkIds, classes } = readChecks(repoRoot);
  return {
    apiVersion,
    decls: parseDts(read(apiDir, `${apiVersion}.d.ts`)),
    readme,
    frozen: frozenParts(readme.split.get('frozen').body),
    manifestSchema: JSON.parse(read(hostDist, 'schemas', 'manifest.v1.json')),
    entrySchema: JSON.parse(read(repoRoot, 'schemas', 'entry.v1.json')),
    dataAllow: createRequire(import.meta.url)(join(hostDist, 'dataallow.js')).DATA_ALLOWLIST,
    scaffold: renderScaffold(ANSWERS),
    policy: read(repoRoot, 'POLICY.md'),
    contributing: read(repoRoot, 'CONTRIBUTING.md'),
    checkIds,
    classes,
    callLimit: CALL_LIMIT,
    contentDir,
    repoUrl: (path) => `${REPO}/blob/main/${path.replace(/^\.?\//, '')}`,
  };
}

const flagOn = (v) => /^(1|true|yes|on)$/i.test(String(v ?? ''));

/**
 * Builds the site into `out` (pages under `out + base`). Returns `{ out, base, indexLive, pages: [{ slug, url, file }] }`.
 * Files are written over what is there; build into a fresh directory.
 */
export function build({ out, base = '/plugins/', indexLive = flagOn(process.env.INDEX_LIVE), ...sources } = {}) {
  if (!out) throw new Error('build: out is required');
  if (!/^\/(?:[\w.-]+\/)*$/.test(base)) throw new Error(`build: base must start and end with "/" (got ${base})`);
  const ctx = gather(sources);
  const { pages } = buildPages({ ...ctx, indexLive });
  const design = loadDesign(DESIGN_SNAPSHOT);
  const slugs = new Set(pages.map((p) => p.slug));
  const order = pages.map((p) => p.slug);
  const url = (slug) => (slug === 'index' ? base : `${base}${slug}/`);
  const site = makeSite({ base, indexLive, apiVersion: ctx.apiVersion, design, nav: buildNav(pages), order, searchIndex: buildSearchIndex(pages, url) });
  for (const p of pages) site.pageIndex.set(p.slug, { label: p.navLabel, mono: Boolean(p.mono) });

  const root = join(out, base);
  const written = [];
  for (const page of pages) {
    const resolved = { ...page, body: page.body.replace(/href="@@([^"#]+)(#[^"]*)?"/g, (_, slug, frag = '') => {
      if (!slugs.has(slug)) throw new Error(`page ${page.slug}: link to unknown page "${slug}"`);
      return `href="${url(slug)}${frag}"`;
    }) };
    const file = join(root, page.slug === 'index' ? '' : page.slug, 'index.html');
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, site.render(resolved));
    written.push({ slug: page.slug, url: url(page.slug), file });
  }
  mkdirSync(join(root, 'assets'), { recursive: true });
  for (const name of ASSETS) copyFileSync(join(DESIGN_DIR, name), join(root, 'assets', name));
  writeFileSync(join(root, 'assets', 'fonts.css'), fontsCss());
  copyFonts(FONTS_DIR, join(root, 'assets'));
  writeFileSync(join(out, '_headers'), HEADERS);
  // Cloudflare Pages: the host root has no page of its own, so send it to the docs (only when they live at /plugins/).
  if (base === '/plugins/') writeFileSync(join(out, '_redirects'), '/ /plugins/ 302\n');
  return { out, base, indexLive, apiVersion: ctx.apiVersion, pages: written };
}

function main(argv) {
  const opt = { out: join(HERE, 'dist'), base: '/plugins/', indexLive: flagOn(process.env.INDEX_LIVE) };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--out') opt.out = resolve(argv[++i]);
    else if (a === '--base') opt.base = argv[++i];
    else if (a === '--index-live') opt.indexLive = true;
    else throw new Error(`unknown argument ${a}`);
  }
  const r = build(opt);
  console.log(`built ${r.pages.length} pages into ${join(r.out, r.base)} (API ${r.apiVersion}, index ${r.indexLive ? 'LIVE' : 'not live'})`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main(process.argv.slice(2)); } catch (e) { console.error(e.message); process.exit(1); }
}
