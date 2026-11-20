// The plugin-api README is the prose reference of the API pages. This file holds the section map (which page shows which README
// section) and the exclusion list (which text stays out, and why). `mapSections` throws on a heading that is neither mapped nor
// excluded, and on a map entry that names a heading the README no longer has, so a README change never silently adds or loses
// text on the site. A heading is matched without its trailing parenthesis (the version suffix changes with every minor).
import { readFileSync } from 'node:fs';

/** README heading (no parenthesis) -> the page slug that shows it. A `###` heading with no entry goes where its `##` parent goes. */
export const SECTION_PAGES = {
  'Entry point': 'api',
  'Marketplace archives and updates': 'packaging',
  'Manifest limits': 'manifest',
  'Optional permissions': 'manifest',
  'Appearance and tile': 'manifest',
  'Running in the background': 'manifest',
  Files: 'api/files',
  'Game events': 'api/gamelog',
  'Data packs': 'api/data',
  AI: 'api/ai',
  'EVE data API': 'api/dataapi',
  Chat: 'api/chat',
  'Fitting engine': 'api/fit',
  Database: 'api/db',
  Theme: 'api/theme',
  'Gesture grants': 'api/services',
  Window: 'api/window',
  Notifications: 'api/notifications',
  ESI: 'api/esi',
  'Character groups': 'api/characters',
  Clipboard: 'api/clipboard',
  Windows: 'api/windows',
  Overlays: 'api/overlays',
  Thumbnails: 'api/thumbnails',
  Hotkeys: 'api/hotkeys',
};

/** Sections with a special reading: `Frozen surface` is split by `frozenParts` (history to api/versions, engines rule to api). */
export const SPLIT_SECTIONS = { 'Frozen surface': 'frozen' };

/** README headings that stay off the site, with the reason. */
export const EXCLUDED_SECTIONS = {
  'Trying the OS capabilities': 'an owner check mode of the desktop test build, not something a plugin author can run',
};

/** Text removed from a mapped section before it is rendered: `{ section, pattern, reason }`. Each pattern must match once. */
export const DROPPED_TEXT = [
  {
    section: 'Entry point',
    pattern: /\s*In this repository `npm --prefix host run build:plugin-api`\s+builds them\./,
    reason: 'a build step of the desktop repository',
  },
  {
    section: 'Chat',
    pattern: /\s*`ChatNamespace` in `src\/index\.ts` is the reference\./,
    reason: 'names a source file of the desktop repository; the declaration on the chat page is the reference',
  },
  {
    section: 'Data packs',
    pattern: / \(`host\/src\/grants\.ts`, `basisOf`\)/,
    reason: 'names a source file of the desktop repository',
  },
  {
    section: 'Database',
    pattern: /\s*Test builds treat the `dev\.evecyno\.\*` fixtures as built in\./,
    reason: 'a desktop test-build detail an author cannot use',
  },
  {
    section: 'Database',
    pattern: /\n*\*\*Testing a plugin that uses `db`\.\*\*[^\n]*/,
    reason: 'names a private package of the desktop repository (store-core) an author cannot install',
  },
];

/** A trailing project tag in a README heading (`(DP1-B5b)`): an internal work-item name an author cannot use. */
const HEADING_TAG = /\s*\(DP\d+-[A-Za-z0-9]+\)\s*$/;

/** The text above the first `##`: the licence note of the package inside the desktop repository, not for authors. */
export const EXCLUDED_PREAMBLE = 'the package licence note names the desktop repository licence; the site has its own Licences page';

const key = (heading) => heading.replace(/\s*\([^)]*\)\s*$/, '').trim();

/** `{ preamble, sections: [{ level, heading, key, body, parent }] }`; a section's body stops at the next heading of any level. */
export function parseReadme(text) {
  const lines = String(text).replace(/\r\n?/g, '\n').split('\n');
  const sections = [];
  const preamble = [];
  let cur = null;
  let parent = null;
  let fence = false;
  for (const line of lines) {
    if (/^(```|~~~)/.test(line)) fence = !fence;
    const m = !fence && /^(#{2,3})\s+(.*?)\s*$/.exec(line);
    if (m) {
      const level = m[1].length;
      cur = { level, heading: m[2], key: key(m[2]), body: [], parent: level === 3 ? parent : null };
      if (level === 2) parent = cur;
      sections.push(cur);
    } else if (cur) cur.body.push(line);
    else preamble.push(line);
  }
  for (const s of sections) s.body = s.body.join('\n').replace(/^\n+|\n+$/g, '');
  return { preamble: preamble.join('\n').trim(), sections };
}

export const readReadme = (path) => parseReadme(readFileSync(path, 'utf8'));

/**
 * `{ byPage: Map(slug -> sections in README order), split: Map(kind -> section), excluded: [{ heading, reason }] }`.
 * Throws on a section that is neither mapped nor excluded and on a map entry with no section.
 */
export function mapSections(readme) {
  const byPage = new Map();
  const split = new Map();
  const excluded = [];
  const seen = new Set();
  const problems = [];
  for (const s of readme.sections) {
    const own = s.key;
    const top = s.parent ? s.parent.key : own;
    let slug = null;
    for (const k of [own, top]) {
      if (k in SECTION_PAGES) { slug = SECTION_PAGES[k]; seen.add(k); break; }
      if (k in SPLIT_SECTIONS) { split.set(SPLIT_SECTIONS[k], s); seen.add(k); slug = false; break; }
      if (k in EXCLUDED_SECTIONS) { excluded.push({ heading: s.heading, reason: EXCLUDED_SECTIONS[k] }); seen.add(k); slug = false; break; }
    }
    if (slug === null) { problems.push(`README section "${s.heading}" is neither mapped to a page nor excluded (site/lib/readme.mjs)`); continue; }
    if (slug === false) continue;
    const body = DROPPED_TEXT.reduce((t, d) => (d.section === top ? t.replace(d.pattern, '') : t), s.body);
    if (!byPage.has(slug)) byPage.set(slug, []);
    byPage.get(slug).push({ ...s, body, heading: s.heading.replace(HEADING_TAG, '') });
  }
  for (const k of [...Object.keys(SECTION_PAGES), ...Object.keys(SPLIT_SECTIONS), ...Object.keys(EXCLUDED_SECTIONS)]) {
    if (!seen.has(k)) problems.push(`the section map names "${k}", which the README no longer has (site/lib/readme.mjs)`);
  }
  for (const d of DROPPED_TEXT) {
    const sec = readme.sections.find((s) => s.key === d.section);
    if (!sec || !d.pattern.test(sec.body)) problems.push(`dropped text for "${d.section}" no longer matches (${d.reason})`);
  }
  if (problems.length) throw new Error(problems.join('\n'));
  return { byPage, split, excluded };
}

const VERSION_ENTRY = /(?:^|; )(?=\d+\.\d+\.\d+ (?:adds|added|changes|changed) )/;

/**
 * The `Frozen surface` section read as three parts. The freeze procedure (the lines before the first version line) is dropped; the
 * version history lines become `history` (newest first); the lines of the older-snapshots list become `snapshots`; the rest is the
 * `engines` rule text.
 */
export function frozenParts(body) {
  const lines = body.split('\n');
  const first = lines.findIndex((l) => /^\d+\.\d+\.\d+ /.test(l));
  const enginesAt = lines.findIndex((l) => /^A plugin's `engines/.test(l));
  if (first < 0 || enginesAt < first) throw new Error('README "Frozen surface": the version history lines or the engines rule moved');
  const histLines = lines.slice(first, enginesAt);
  const engines = lines.slice(enginesAt).join('\n').trim();
  const histTexts = [];
  const snap = [];
  for (const line of histLines) {
    const at = line.indexOf('The older snapshots');
    if (at >= 0) { histTexts.push(line.slice(0, at)); snap.push(line.slice(at)); } else if (/^\d+\.\d+\.\d+ /.test(line)) histTexts.push(line);
    else snap.push(line);
  }
  const snapshots = snap.join(' ').replace(/\s+/g, ' ').trim();
  const joined = histTexts.join('\n');
  const history = [];
  for (const line of joined.split('\n')) {
    for (const piece of line.split(VERSION_ENTRY)) {
      const m = /^(\d+\.\d+\.\d+) /.exec(piece.trim());
      if (m) history.push({ version: m[1], text: piece.trim().replace(/[;\s]+$/, '') });
    }
  }
  const num = (v) => v.split('.').map(Number);
  history.sort((a, b) => { const x = num(a.version); const y = num(b.version); return y[0] - x[0] || y[1] - x[1] || y[2] - x[2]; });
  return { history, snapshots, engines };
}
