// tools/lib/yamlsub.mjs: a strict reader for the YAML subset this repository's workflow files are written in (static tests C-WF1 to
// C-WF12, tools/test/workflows.test.mjs). It reads block mappings, block sequences, one-line plain and quoted scalars, flow sequences
// of plain words and literal block scalars (`|`, `|-`). It refuses everything else: tabs, carriage returns, U+0085, U+2028 and
// U+2029 (line breaks to YAML 1.1 readers such as YamlDotNet), U+FEFF (a byte order mark) on any line, anchors, aliases, tags, flow
// mappings, folded scalars, scalars over several lines, duplicate keys, a sequence at its key's own indentation, document markers.
// A blank line is one of spaces (U+0020) alone: any other space character is text, as it is to YAML. Inside a literal block a line
// of spaces is blank only up to the block's indentation, and the spaces beyond it are text, as they are to YAML; a leading blank
// line wider than the block's first line is refused (an error to YAML). A flow sequence item loses its U+0020 spaces only. So a
// workflow written outside the subset fails the tests instead of being read one way here and another way by GitHub.
// No dependency: the repository's only packages are the host's ajv and semver, and npm ci runs in the jobs that hold secrets.

export class YamlSubsetError extends Error {}

const KEY_RE = /^([A-Za-z0-9_][A-Za-z0-9_.-]*):(?: +(.*))?$/;
const WORD_RE = /^[A-Za-z0-9_.\/-]+$/;
const isSeqItem = (text) => text === '-' || text.startsWith('- ');
/**
 * `s` without its leading and trailing U+0020 spaces. Never trim(): it also strips U+00A0, U+3000 and U+2000 to U+200A, which are
 * text to YAML.
 */
const unspace = (s) => s.replace(/^ +| +$/g, '');
/**
 * The characters YAML 1.1 reads as line breaks besides LF and CR (YamlDotNet's IsBreak). This reader splits at LF only, so a step
 * written after one of them inside a comment line would be a comment here and a step to such a reader: refused on any line.
 */
const OTHER_BREAKS = Object.freeze({ '\u0085': 'U+0085 (next line)', '\u2028': 'U+2028 (line separator)', '\u2029': 'U+2029 (paragraph separator)' });
const OTHER_BREAK_RE = /[\u0085\u2028\u2029]/;
// What libyaml refuses: C0 controls but tab, LF and CR (those are handled on their own), DEL, the C1 controls (U+0085 is reported as a
// line break first), U+FFFE and U+FFFF.
const CONTROL_RE = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\ufffe\uffff]/;

/**
 * Parses `src`. Returns { value, spans, lines }: `value` is the document (mappings are objects without a prototype, sequences arrays,
 * scalars strings, an empty value null), `spans` maps every mapping and sequence to { start, end }, the indexes of its first and last
 * line in `lines` (the source split at '\n'). Throws YamlSubsetError with the line number on anything outside the subset.
 */
export function parseYaml(src) {
  if (typeof src !== 'string') throw new YamlSubsetError('the source is not a string');
  const raw = src.split('\n');
  raw.forEach((l, k) => {
    if (l.includes('\ufeff')) throw new YamlSubsetError(`line ${k + 1}: a byte order mark (U+FEFF)`);
    if (l.includes('\t')) throw new YamlSubsetError(`line ${k + 1}: a tab`);
    if (l.includes('\r')) throw new YamlSubsetError(`line ${k + 1}: a carriage return`);
    const b = OTHER_BREAK_RE.exec(l);
    if (b) throw new YamlSubsetError(`line ${k + 1}: ${OTHER_BREAKS[b[0]]}, a line break to some YAML readers`);
    const c = CONTROL_RE.exec(l);
    if (c) throw new YamlSubsetError(`line ${k + 1}: a control character (U+${c[0].charCodeAt(0).toString(16).toUpperCase().padStart(4, '0')}) that YAML readers refuse or skip`);
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
      const body = unspace(s.slice(1, close));
      rest(s.slice(close + 1));
      if (/[\[\]{}'"#]/.test(body)) fail(L, 'a flow sequence of anything but plain words');
      if (body === '') return [];
      return body.split(',').map((w) => {
        const t = unspace(w);
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

  /**
   * A literal block scalar whose header is on line i (inside a mapping at `indent`). Its indentation is its first text line's. As
   * to YAML (libyaml, PyYAML), a line of spaces alone is blank when it is no wider than that indentation and text beyond it, so
   * 'a: |-\n  x\n     \n' is 'x\n   '. A blank line before the first text line and wider than it is refused: YAML takes its
   * spaces as the indentation, so the block ends before its text and the document is an error.
   */
  function literal(i, indent, header) {
    const m = /^\|(-?)(?: +#.*)?$/.exec(header);
    if (!m) fail(lines[i], `a block scalar header this reader does not read: ${JSON.stringify(header)}`);
    const body = [];
    let contentIndent = null;
    let widest = null;
    let last = i;
    let j = i + 1;
    for (; j < lines.length; j++) {
      const L = lines[j];
      // Spaces alone, never trim(): it also strips U+00A0, U+3000, U+2000 to U+200A and U+FEFF, which are text to YAML.
      if (/^ *$/.test(L.raw) && (contentIndent === null || L.raw.length <= contentIndent)) {
        if (contentIndent === null && (widest === null || L.raw.length > widest.raw.length)) widest = L;
        body.push('');
        continue;
      }
      if (contentIndent === null) {
        if (L.indent <= indent) break;
        if (widest !== null && widest.raw.length > L.indent) fail(widest, 'a leading blank line of a block scalar wider than its first line (YAML takes its spaces as the indentation)');
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
