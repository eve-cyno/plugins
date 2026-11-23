// The property tables of the plugin.json reference, read from the vendored host's manifest schema
// (vendor/eve-cyno-host/host/dist/schemas/manifest.v1.json). One row per schema property, recursively for objects and for the
// objects inside arrays, so a property added to the schema adds a row and the drift test notices a page that lost one.
import { esc } from './md.mjs';

/** Hand-written notes for the top-level properties (the schema holds the limits, not the meaning). Keyed by property path. */
export const NOTES = {
  id: 'Reverse-domain style, unique. The prefix `eve-cyno.host.` is reserved.',
  name: 'Shown in Settings > Plugins. Plain text only.',
  author: 'Shown next to the name.',
  version: 'Semantic version, for example `0.1.0`.',
  engines: 'The plugin API range the plugin needs, `{ "eve-cyno-api": "^1.29" }`. The app refuses with `incompatible_api` when it is older.',
  main: 'Path of the page the app loads, inside the plugin folder.',
  description: 'One or two sentences for the plugin list.',
  icon: 'A lowercase name.',
  color: 'Accent colour of the tile, `#rrggbb`.',
  activationEvents: 'When the plugin starts, for example `onStartup`.',
  background: 'Keep running when its window is closed.',
  suspendUnderPressure: 'Let the app pause a background plugin when the machine is under load.',
  wasm: 'Let the pages and Workers compile WebAssembly (API 1.30.0): a manifest that writes the key, `true` or `false`, needs `{ "eve-cyno-api": "^1.30" }`. It is no permission. Compile only `.wasm` files from your archive, built from the public source your entry names; the index has a maintainer review every version that sets it.',
  esiCompatibilityDate: 'The ESI compatibility date the plugin was written against.',
  permissions: 'What the plugin asks for. See Permissions and grants.',
  contributes: 'Commands, status items, the tile action, settings and services the plugin adds to the app.',
};

function resolve(schema, node) {
  let n = node;
  for (let guard = 0; n && n.$ref && guard < 8; guard++) {
    const name = /^#\/\$defs\/(.+)$/.exec(n.$ref)?.[1];
    if (!name || !schema.$defs?.[name]) throw new Error(`manifest schema: unresolved ${n.$ref}`);
    n = schema.$defs[name];
  }
  return n;
}

const list = (a) => a.map((v) => `\`${v}\``).join(', ');

function typeOf(schema, node) {
  const n = resolve(schema, node);
  if (n.enum) return 'enum';
  if (n.type === 'array') {
    const it = n.items ? resolve(schema, n.items) : null;
    return `array of ${it ? (it.enum ? 'enum' : it.type ?? 'any') : 'any'}`;
  }
  return n.type ?? 'any';
}

/** The limits of a node as sentences, in a fixed order. */
export function constraints(schema, node) {
  const n = resolve(schema, node);
  const out = [];
  if (n.enum) out.push(`One of ${list(n.enum)}.`);
  if (n.type === 'array' && n.items) {
    const it = resolve(schema, n.items);
    if (it.enum) out.push(`Items: ${list(it.enum)}.`);
    if (it.maxLength) out.push(`Each item at most ${it.maxLength} characters.`);
    if (it.pattern) out.push(`Each item matches \`${it.pattern}\`.`);
  }
  if (n.minLength != null && n.maxLength != null) out.push(`${n.minLength} to ${n.maxLength} characters.`);
  else if (n.maxLength != null) out.push(`At most ${n.maxLength} characters.`);
  else if (n.minLength != null) out.push(`At least ${n.minLength} characters.`);
  if (n.pattern) out.push(`Matches \`${n.pattern}\`.`);
  if (n.minimum != null && n.maximum != null) out.push(`${n.minimum} to ${n.maximum}.`);
  else if (n.maximum != null) out.push(`At most ${n.maximum}.`);
  else if (n.minimum != null) out.push(`At least ${n.minimum}.`);
  if (n.minItems != null && n.maxItems != null) out.push(`${n.minItems} to ${n.maxItems} items.`);
  else if (n.maxItems != null) out.push(`At most ${n.maxItems} items.`);
  else if (n.minItems != null) out.push(`At least ${n.minItems} items.`);
  if (n.uniqueItems) out.push('Items are unique.');
  if (n.maxProperties != null) out.push(`At most ${n.maxProperties} entries.`);
  if (n.propertyNames?.pattern) out.push(`Keys match \`${n.propertyNames.pattern}\`.`);
  if (n.additionalProperties && typeof n.additionalProperties === 'object') {
    const v = resolve(schema, n.additionalProperties);
    if (v.pattern) out.push(`Values match \`${v.pattern}\`.`);
  }
  return out;
}

/**
 * Rows `{ path, required, type, notes }` for every property below `schema`, depth first in schema order. `path` is dotted;
 * an array of objects adds `[]` (`contributes.commands[].id`). `$defs` entries are followed through `$ref`. `notes` maps a top-level
 * property to its hand-written note (the manifest's by default; pass `{}` for another schema).
 */
export function schemaRows(schema, { node = schema, prefix = '', notes = NOTES } = {}) {
  const n = resolve(schema, node);
  const rows = [];
  const props = n.properties ?? {};
  const required = new Set(n.required ?? []);
  for (const [key, child] of Object.entries(props)) {
    const path = prefix ? `${prefix}.${key}` : key;
    const c = resolve(schema, child);
    rows.push({ path, required: required.has(key), type: typeOf(schema, child), notes: { hand: prefix ? '' : notes[key] ?? '', limits: constraints(schema, child) } });
    if (c.properties) rows.push(...schemaRows(schema, { node: c, prefix: path, notes }));
    else if (c.type === 'array' && c.items) {
      const it = resolve(schema, c.items);
      if (it.properties) rows.push(...schemaRows(schema, { node: it, prefix: `${path}[]`, notes }));
    }
  }
  return rows;
}

/** Inline code (backticks) in a note to HTML; everything else is escaped. */
const noteHtml = (text) => text.split(/(`[^`]*`)/).map((p) => (p.startsWith('`') && p.endsWith('`') && p.length > 1 ? `<code>${esc(p.slice(1, -1))}</code>` : esc(p))).join('');

/** The rows as the design's `.tbl.params` table. */
export function rowsToHtml(rows, { head = 'Property' } = {}) {
  const body = rows.map((r) => {
    const notes = [r.notes.hand, ...r.notes.limits].filter(Boolean).map(noteHtml).join(' ');
    return `<tr><td><span class="p-name">${esc(r.path)}</span>${r.required ? '<span class="p-req">required</span>' : ''}</td><td><span class="p-type">${esc(r.type)}</span></td><td>${notes}</td></tr>`;
  });
  return `<div class="tbl params"><table>\n<thead><tr><th>${esc(head)}</th><th>Type</th><th>Notes</th></tr></thead>\n<tbody>\n${body.join('\n')}\n</tbody>\n</table></div>`;
}

/** The top-level properties and the rows below `permissions` and `contributes`, counted: `{ top, permissions, contributes, required }`. */
export function schemaCounts(schema) {
  return {
    top: Object.keys(schema.properties).length,
    required: (schema.required ?? []).length,
    permissions: Object.keys(resolve(schema, schema.properties.permissions).properties).length,
    contributes: Object.keys(resolve(schema, schema.properties.contributes).properties).length,
  };
}
