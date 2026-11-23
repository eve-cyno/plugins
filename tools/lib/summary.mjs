// The job summary of tools/check.mjs and tools/build-index.mjs (plan 3.2, 3.4). Every line starts with a fixed word, so text from an
// entry, an archive or a server (a manifest field, a URL) never starts a line and never holds a workflow command (`::...`, `##[...`):
//   PASS <check> <text>          a check passed
//   FAIL <check> <text>          a check refused (the job fails)
//   FLAG <class> <check> <text>  a review class is set (tools/check.mjs review fails with NEEDS REVIEW <classes>)
//   NOTE <text>                  information
// and one verdict line at the end. Untrusted text is cleaned to one printable line of at most 500 characters before it is kept.
// The Markdown summary escapes it again; GitHub annotations (::error / ::warning) escape it with the runner's own rules.
import fs from 'node:fs';

/**
 * The review classes, in the order the verdict names them (plan 3.2: C3, C10, C11, C13, C14, C15, C17; `revoked` added for C15, then
 * `wasm` for R1 of plan dp4 W1: an added version whose plugin.json sets `wasm: true`, set by C10, last).
 */
export const CLASSES = ['new', 'escalation', 'identity', 'first-party', 'engines', 'maintenance', 'multi-entry', 'revocation', 'lift', 'revoked', 'wasm'];

// Control characters (C0, DEL, C1), the line and paragraph separators and the bidirectional controls, as code points so no
// literal separator can end up in this file.
const UNPRINTABLE = new RegExp(`[${[[0x00, 0x1f], [0x7f, 0x9f], [0x200e, 0x200f], [0x2028, 0x202e], [0x2066, 0x2069]]
  .map(([a, b]) => `\\u${a.toString(16).padStart(4, '0')}-\\u${b.toString(16).padStart(4, '0')}`).join('')}]+`, 'g');
/**
 * One printable line: control characters, line and paragraph separators and bidirectional controls become spaces, and every `##[`
 * becomes `# #[` (the runner reads that older command form anywhere in a line, not only at its start as it reads `::`).
 */
export const clean = (s) => String(s).replace(UNPRINTABLE, ' ').replace(/\s+/g, ' ').replace(/##\[/g, '# #[').trim().slice(0, 500);
/** Markdown text that renders as the characters it holds (no link, emphasis, code span, HTML or table cell). */
export const md = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/([\\`*_{}[\]()#+!|~])/g, '\\$1');
/** A workflow command's message or property, escaped as the runner unescapes it. */
const cmd = (s, prop = false) => {
  const t = s.replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
  return prop ? t.replace(/:/g, '%3A').replace(/,/g, '%2C') : t;
};

/** A report: collects lines, counts refusals and review classes, prints each line as it comes. */
export function createReport({ out = (l) => console.log(l), annotate = process.env.GITHUB_ACTIONS === 'true' } = {}) {
  const lines = [];
  const flags = new Map();
  let failed = 0;
  const add = (line) => { lines.push(line); out(line); };
  return {
    pass(check, text) { add(`PASS ${check} ${clean(text)}`); },
    fail(check, text) {
      failed++;
      const t = clean(text);
      add(`FAIL ${check} ${t}`);
      if (annotate) out(`::error title=${cmd(`FAIL ${check}`, true)}::${cmd(t)}`);
    },
    flag(cls, check, text) {
      if (!CLASSES.includes(cls)) throw new Error(`unknown review class ${cls}`);
      const t = clean(text);
      if (!flags.has(cls)) flags.set(cls, []);
      flags.get(cls).push(t);
      add(`FLAG ${cls} ${check} ${t}`);
      if (annotate) out(`::warning title=${cmd(`NEEDS REVIEW ${cls}`, true)}::${cmd(t)}`);
    },
    note(text) { add(`NOTE ${clean(text)}`); },
    get failed() { return failed; },
    /** The review classes set, in CLASSES order. */
    get classes() { return CLASSES.filter(c => flags.has(c)); },
    get lines() { return [...lines]; },
    /** Prints the verdict, appends the Markdown summary to `file` (when given) and returns it. */
    finish(verdict, { title, file } = {}) {
      out(verdict);
      if (file) {
        const body = [`## ${md(clean(title ?? 'checks'))}`, '', ...lines.map(l => `- ${md(l)}`), '', `**${md(verdict)}**`, ''].join('\n');
        fs.appendFileSync(file, `${body}\n`);
      }
      return verdict;
    },
  };
}
