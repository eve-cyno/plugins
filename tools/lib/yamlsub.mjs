// tools/lib/yamlsub.mjs: a strict reader for the YAML subset this repository's workflow files are written in (static tests C-WF1 to
// C-WF11, tools/test/workflows.test.mjs). It reads block mappings, block sequences, one-line plain and quoted scalars, flow sequences
// of plain words and literal block scalars (`|`, `|-`). It refuses everything else: tabs, carriage returns, anchors, aliases, tags,
// flow mappings, folded scalars, scalars over several lines, duplicate keys, a sequence at its key's own indentation, document
// markers. So a workflow written outside the subset fails the tests instead of being read one way here and another way by GitHub.
// No dependency: the repository's only packages are the host's ajv and semver, and npm ci runs in the jobs that hold secrets.

export class YamlSubsetError extends Error {}

const KEY_RE = /^([A-Za-z0-9_][A-Za-z0-9_.-]*):(?: +(.*))?$/;
const WORD_RE = /^[A-Za-z0-9_.\/-]+$/;
const isSeqItem = (text) => text === '-' || text.startsWith('- ');

/**
 * Parses `src`. Returns { value, spans, lines }: `value` is the document (mappings are objects without a prototype, sequences arrays,
 * scalars strings, an empty value null), `spans` maps every mapping and sequence to { start, end }, the indexes of its first and last
 * line in `lines` (the source split at '\n'). Throws YamlSubsetError with the line number on anything outside the subset.
 */
export function parseYaml(src) {
  if (typeof src !== 'string') throw new YamlSubsetError('the source is not a string');
  if (src.charCodeAt(0) === 0xfeff) throw new YamlSubsetError('line 1: a byte order mark');
  const raw = src.split('\n');
  raw.forEach((l, k) => {
    if (l.includes('\t')) throw new YamlSubsetError(`line ${k + 1}: a tab`);
    if (l.includes('\r')) throw new YamlSubsetError(`line ${k + 1}: a carriage return`);
  });
  const lines = raw.map((l, k) => {
    const text = l.replace(/^ +/, '');
    return { n: k + 1, indent: l.length - text.length, text: text.replace(/ +$/, ''), raw: l };
  });
  const spans = new WeakMap();
  const fail = (L, why) => { throw new YamlSubsetError(`line ${L.n}: ${why}`); };
  const blankOrComment = (L) => L.text === '' || L.text.startsWith('#');
  const skip = (i) => { while (i < lines.length && blankOrComment(lines[i])) i++; return i; };

  /** A one-line scalar value (plain, quoted or a flow sequence), with its trailing comment removed. */
  function inline(L, s) {
    const rest = (r) => { if (r !== '' && !/^ +#/.test(r)) fail(L, `text after a closing quote or bracket: ${JSON.stringify(r)}`); };
    if (s.startsWith("'")) {
      let out = '';
      for (let k = 1; ;) {
        const q = s.indexOf("'", k);
        if (q < 0) fail(L, 'an unterminated single-quoted scalar');
        out += s.slice(k, q);
        if (s[q + 1] === "'") { out += "'"; k = q + 2; continue; }
        rest(s.slice(q + 1));
        return out;
      }
    }
    if (s.startsWith('"')) {
      let out = '';
      for (let k = 1; k < s.length; k++) {
        const c = s[k];
        if (c === '"') { rest(s.slice(k + 1)); return out; }
        if (c === '\\') {
          const d = s[k + 1];
          if (d !== '\\' && d !== '"') fail(L, `an escape this reader does not read: \\${d ?? ''}`);
          out += d;
          k++;
          continue;
        }
        out += c;
      }
      fail(L, 'an unterminated double-quoted scalar');
    }
    if (s.startsWith('[')) {
      const close = s.indexOf(']');
      if (close < 0) fail(L, 'an unterminated flow sequence');
      const body = s.slice(1, close).trim();
      rest(s.slice(close + 1));
      if (/[\[\]{}'"#]/.test(body)) fail(L, 'a flow sequence of anything but plain words');
      if (body === '') return [];
      return body.split(',').map((w) => {
        const t = w.trim();
        if (!WORD_RE.test(t)) fail(L, `a flow sequence item that is not a plain word: ${JSON.stringify(t)}`);
        return t;
      });
    }
    if (/^[&*!]/.test(s)) fail(L, 'an anchor, alias or tag');
    if (s.startsWith('{')) fail(L, 'a flow mapping');
    if (s.startsWith('>')) fail(L, 'a folded scalar');
    if (/^[%@`|,?\]}]/.test(s) || isSeqItem(s) || s.startsWith(': ')) fail(L, `a scalar that starts with an indicator: ${JSON.stringify(s)}`);
    const hash = s.search(/ #/);
    const v = (hash < 0 ? s : s.slice(0, hash)).replace(/ +$/, '');
    if (v.includes(': ') || v.endsWith(':')) fail(L, `a plain scalar that holds ": " or ends with ":": ${JSON.stringify(v)}`);
    return v;
  }

  /** A literal block scalar whose header is on line i (inside a mapping at `indent`). */
  function literal(i, indent, header) {
    const m = /^\|(-?)(?: +#.*)?$/.exec(header);
    if (!m) fail(lines[i], `a block scalar header this reader does not read: ${JSON.stringify(header)}`);
    const body = [];
    let contentIndent = null;
    let last = i;
    let j = i + 1;
    for (; j < lines.length; j++) {
      const L = lines[j];
      if (L.raw.trim() === '') { body.push(''); continue; }
      if (contentIndent === null) {
        if (L.indent <= indent) break;
        contentIndent = L.indent;
      }
      if (L.indent < contentIndent) {
        if (L.indent > indent) fail(L, 'a block scalar line less indented than its first line');
        break;
      }
      body.push(L.raw.slice(contentIndent));
      last = j;
    }
    if (contentIndent === null) fail(lines[i], 'an empty block scalar');
    while (body.length > 0 && body[body.length - 1] === '') body.pop();
    return { value: body.join('\n') + (m[1] === '-' ? '' : '\n'), next: last + 1, last };
  }

  /** The value after `key:` on line i of a mapping at `indent`: inline, a literal block, a nested block or null. */
  function value(i, indent, rest) {
    const L = lines[i];
    if (rest === '' || rest.startsWith('#')) {
      const j = skip(i + 1);
      if (j < lines.length && lines[j].indent > indent) return node(j, lines[j].indent);
      return { value: null, next: i + 1, last: i };
    }
    if (rest.startsWith('|')) return literal(i, indent, rest);
    return { value: inline(L, rest), next: i + 1, last: i };
  }

  function mapping(i, indent) {
    const obj = Object.create(null);
    const start = i;
    let last = i;
    while (i < lines.length) {
      const L = lines[i];
      if (L.indent < indent) break;
      if (L.indent > indent) fail(L, 'unexpected indentation');
      if (isSeqItem(L.text)) fail(L, 'a sequence item where a mapping key was expected');
      const m = KEY_RE.exec(L.text);
      if (!m) fail(L, `not a "key: value" line: ${JSON.stringify(L.text)}`);
      if (m[1] in obj) fail(L, `duplicate key ${m[1]}`);
      const r = value(i, indent, m[2] ?? '');
      obj[m[1]] = r.value;
      last = r.last;
      i = skip(r.next);
    }
    spans.set(obj, { start, end: last });
    return { value: obj, next: i, last };
  }

  function sequence(i, indent) {
    const arr = [];
    const start = i;
    let last = i;
    while (i < lines.length) {
      const L = lines[i];
      if (L.indent < indent) break;
      if (L.indent > indent) fail(L, 'unexpected indentation');
      if (!isSeqItem(L.text)) fail(L, 'a mapping key where a sequence item was expected');
      const after = L.text.slice(2);
      const pad = after.length - after.replace(/^ +/, '').length;
      const item = after.slice(pad);
      let r;
      if (item === '' || item.startsWith('#')) {
        const j = skip(i + 1);
        if (!(j < lines.length && lines[j].indent > indent)) fail(L, 'an empty sequence item');
        r = node(j, lines[j].indent);
      } else if (isSeqItem(item)) {
        fail(L, 'a nested sequence on one line');
      } else if (KEY_RE.test(item)) {
        lines[i] = { ...L, indent: indent + 2 + pad, text: item };
        r = mapping(i, indent + 2 + pad);
      } else if (item.startsWith('|')) {
        fail(L, 'a block scalar as a sequence item');
      } else {
        r = { value: inline(L, item), next: i + 1, last: i };
      }
      arr.push(r.value);
      last = r.last;
      i = skip(r.next);
    }
    spans.set(arr, { start, end: last });
    return { value: arr, next: i, last };
  }

  function node(i, indent) {
    return isSeqItem(lines[i].text) ? sequence(i, indent) : mapping(i, indent);
  }

  const first = skip(0);
  if (first >= lines.length) throw new YamlSubsetError('an empty document');
  if (lines[first].indent !== 0) fail(lines[first], 'the document does not start at column 1');
  if (isSeqItem(lines[first].text)) fail(lines[first], 'the document is not a mapping');
  const doc = mapping(first, 0);
  const end = skip(doc.next);
  if (end < lines.length) fail(lines[end], 'unexpected content after the document');
  return { value: doc.value, spans, lines: raw };
}
