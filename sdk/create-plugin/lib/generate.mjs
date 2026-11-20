// The generator: answers in, a map of project files out, then (writeProject) the files on disk. No clock, no random value and no
// environment read, so the same answers give the same bytes. A refusal throws before the first file or folder is created.
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { authorProblem, descriptionProblem, idProblem, nameProblem } from './rules.mjs';

export const TEMPLATE_DIR = fileURLToPath(new URL('../template/', import.meta.url));
export const PACKAGE = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

export class GenerateError extends Error {
  constructor(problems) {
    super(problems.join('\n'));
    this.name = 'GenerateError';
    this.problems = problems;
  }
}

/** Every problem of the answers, as readable lines; an empty list means the answers are accepted. */
export function validateAnswers(a) {
  const checks = [['id', idProblem], ['name', nameProblem], ['author', authorProblem], ['description', descriptionProblem]];
  const problems = [];
  for (const [field, check] of checks) {
    const why = check(a?.[field]);
    if (why) problems.push(`${field}: ${why}`);
  }
  return problems;
}

const ESCAPE = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const MODES = {
  raw: v => v,
  json: v => JSON.stringify(v),
  html: v => v.replace(/[&<>"']/g, c => ESCAPE[c]),
};
const TOKEN = /\{\{(\w+)(?:\|(\w+))?\}\}/g;

function fill(text, values, where) {
  return text.replace(TOKEN, (_, key, mode = 'raw') => {
    if (!(key in values) || !(mode in MODES)) throw new Error(`template ${where}: unknown token ${key}|${mode}`);
    return MODES[mode](values[key]);
  });
}

function walk(dir, out = []) {
  for (const e of readdirSync(dir).sort()) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}

// Where a template file lands: `_gitignore` is `.gitignore` (npm drops a real one from a package) and `__ID__` is the plugin id.
const target = (rel, id) => rel.split('/').map(s => (s === '_gitignore' ? '.gitignore' : s.replaceAll('__ID__', id))).join('/');

/**
 * The project as a Map of posix path to text, sorted by path. Throws GenerateError when the answers are refused. The bundled API
 * declarations (`types/`) are copied as they are, never filled.
 */
export function render(answers) {
  const a = { id: answers?.id, name: answers?.name?.trim(), author: answers?.author?.trim(), description: answers?.description?.trim() };
  const problems = validateAnswers(a);
  if (problems.length) throw new GenerateError(problems);
  const files = [];
  for (const p of walk(TEMPLATE_DIR)) {
    const rel = relative(TEMPLATE_DIR, p).split(sep).join('/');
    const text = readFileSync(p, 'utf8');
    files.push([target(rel, a.id), rel.startsWith('types/') ? text : fill(text, a, rel)]);
  }
  files.sort(([x], [y]) => (x < y ? -1 : x > y ? 1 : 0));
  return new Map(files);
}

/** The last id segment: the default folder name, and (title-cased) the default display name. */
export const lastSegment = id => id.split('.').pop();
export const titleCase = s => s.split('-').filter(Boolean).map(w => w[0].toUpperCase() + w.slice(1)).join(' ');

/** Writes the project into `dir` (created when missing, empty when it exists). Refuses a non-empty folder before writing anything. */
export function writeProject(dir, answers) {
  const files = render(answers);
  if (existsSync(dir)) {
    if (!statSync(dir).isDirectory()) throw new GenerateError([`${dir} exists and is not a folder`]);
    if (readdirSync(dir).length > 0) throw new GenerateError([`${dir} is not empty: pick an empty or new folder`]);
  }
  for (const [rel, text] of files) {
    const p = join(dir, ...rel.split('/'));
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, text);
  }
  return [...files.keys()];
}
