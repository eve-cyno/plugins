// A line-based reader for the tsc-emitted declaration file (api/<version>.d.ts). It does not use the TypeScript compiler API: the
// file is machine-written, four-space indented, one exported declaration at column 0 with its doc comment above it. The reader
// keeps each declaration's exact source text, so a page can show the declarations as they are and a test can compare them.

const COMMENT_LINE = /^\s*(?:\/\*\*|\*|\/\/)/;

/** Net bracket depth change of one source line, ignoring string literals and comment lines. */
function depthDelta(line) {
  if (COMMENT_LINE.test(line)) return 0;
  const bare = line.replace(/'(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*"|`(?:[^`\\]|\\.)*`/g, "''");
  let d = 0;
  for (const c of bare) {
    if (c === '{' || c === '(' || c === '[') d++;
    else if (c === '}' || c === ')' || c === ']') d--;
  }
  return d;
}

/** The text of a doc comment without its `/** *\/` frame and line stars. */
export function docText(raw) {
  if (!raw) return '';
  return raw
    .replace(/^\s*\/\*\*+\s?/, '')
    .replace(/\s*\*+\/\s*$/, '')
    .split('\n')
    .map((l) => l.replace(/^\s*\*\s?/, ''))
    .join('\n')
    .trim();
}

const NAME = /^export\s+(?:declare\s+)?(interface|type|function|const|class|enum)\s+([A-Za-z_$][\w$]*)/;

/**
 * Every top-level exported declaration, in source order: `{ kind, name, doc, docRaw, code, text, line }`. `text` is the exact
 * source (doc comment included), `code` is the same without the doc comment, `line` is the 1-based line of the declaration.
 */
export function parseDts(source) {
  const lines = String(source).replace(/\r\n?/g, '\n').split('\n');
  const decls = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) { i++; continue; }
    let docRaw = null;
    if (line.startsWith('/**')) {
      let j = i;
      while (j < lines.length && !lines[j].includes('*/')) j++;
      docRaw = lines.slice(i, j + 1).join('\n');
      i = j + 1;
      if (i >= lines.length) break;
    } else if (line.startsWith('//')) { i++; continue; }
    const first = lines[i];
    if (!/^[A-Za-z]/.test(first)) { i++; continue; }
    const decl = [];
    let depth = 0;
    let k = i;
    for (; k < lines.length; k++) {
      decl.push(lines[k]);
      depth += depthDelta(lines[k]);
      const t = lines[k].trimEnd();
      if (depth <= 0 && (t.endsWith(';') || t.endsWith('}'))) break;
    }
    const code = decl.join('\n');
    const m = NAME.exec(code);
    if (m) {
      decls.push({
        kind: m[1], name: m[2], doc: docText(docRaw), docRaw, code,
        text: (docRaw ? `${docRaw}\n` : '') + code, line: i + 1,
      });
    }
    i = k + 1;
  }
  return decls;
}

/**
 * The members of an interface declaration at its first indent level: `{ name, optional, doc, signature }`. A member's signature
 * runs over several lines until its brackets close and a line ends with `;`.
 */
export function interfaceMembers(decl) {
  const body = decl.code.split('\n').slice(1, -1);
  const members = [];
  let doc = null;
  for (let i = 0; i < body.length; i++) {
    const line = body[i];
    if (/^ {4}\/\*\*/.test(line)) {
      let j = i;
      while (j < body.length && !body[j].includes('*/')) j++;
      doc = body.slice(i, j + 1).join('\n');
      i = j;
      continue;
    }
    const m = /^ {4}(?:readonly\s+)?([A-Za-z_$][\w$]*|\[[^\]]+\])(\??)\s*[(:<]/.exec(line);
    if (!m) continue;
    const sig = [line];
    let depth = depthDelta(line);
    while (!(depth <= 0 && sig[sig.length - 1].trimEnd().endsWith(';')) && i + 1 < body.length) {
      i++;
      sig.push(body[i]);
      depth += depthDelta(body[i]);
    }
    members.push({ name: m[1], optional: m[2] === '?', doc: docText(doc), signature: sig.join('\n').trim().replace(/;$/, ''), line: line.trim() });
    doc = null;
  }
  return members;
}

const stripComments = (code) => code.replace(/\/\*[\s\S]*?\*\//g, '');

/** The names from `known` that the declaration's code (comments excluded) uses, other than its own name. */
export function referencedNames(decl, known) {
  const used = new Set();
  const bare = stripComments(decl.code).replace(/'(?:[^'\\]|\\.)*'/g, "''");
  for (const m of bare.matchAll(/[A-Za-z_$][\w$]*/g)) if (m[0] !== decl.name && known.has(m[0])) used.add(m[0]);
  return used;
}

/** The first sentence of a doc text, on one line, for a table cell. */
export function firstSentence(doc) {
  const flat = String(doc).replace(/\s+/g, ' ').trim();
  const m = /^(.+?[.!?])(?:\s|$)/.exec(flat);
  return m ? m[1] : flat;
}

/**
 * The namespaces of `interface EveCyno`: `[{ name, type, optional }]` in source order. `account?: Reserved` is a namespace
 * entry too (`reserved: true`): the host has no API there yet.
 */
export function namespacesOf(decls) {
  const root = decls.find((d) => d.name === 'EveCyno' && d.kind === 'interface');
  if (!root) throw new Error('the declaration file has no `interface EveCyno`');
  return interfaceMembers(root).map((m) => {
    const type = /:\s*([A-Za-z_$][\w$]*)\s*$/.exec(m.signature)?.[1];
    return { name: m.name, type, optional: m.optional, reserved: type === 'Reserved', doc: m.doc };
  });
}

/**
 * Where every exported declaration is shown. Returns a Map from page slug to declarations in source order:
 *   `api`            EveCyno, getEveCyno and what only EveCyno names (Reserved)
 *   `api/<ns>`       the namespace's interface and the types only that namespace names (transitively)
 *   `api/types`      everything else (named by no namespace, or by two or more)
 * Each declaration lands on exactly one page.
 */
export function assignDeclarations(decls) {
  const byName = new Map(decls.map((d) => [d.name, d]));
  const known = new Set(byName.keys());
  const nss = namespacesOf(decls).filter((n) => !n.reserved);
  const nsTypes = new Set(nss.map((n) => n.type));
  const closure = (rootName) => {
    const seen = new Set();
    const stack = [rootName];
    while (stack.length) {
      const name = stack.pop();
      if (seen.has(name)) continue;
      seen.add(name);
      for (const ref of referencedNames(byName.get(name), known)) if (!nsTypes.has(ref) && ref !== 'EveCyno') stack.push(ref);
    }
    return seen;
  };
  const owners = new Map();
  for (const n of nss) for (const name of closure(n.type)) owners.set(name, [...(owners.get(name) ?? []), n.name]);

  const pageOf = (d) => {
    if (d.name === 'EveCyno' || d.name === 'getEveCyno') return 'api';
    const o = owners.get(d.name);
    if (o?.length === 1) return `api/${o[0]}`;
    if (!o && referencedNames(byName.get('EveCyno'), known).has(d.name)) return 'api';
    return 'api/types';
  };
  const pages = new Map();
  for (const d of decls) {
    const p = pageOf(d);
    if (!pages.has(p)) pages.set(p, []);
    pages.get(p).push(d);
  }
  return pages;
}
