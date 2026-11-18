// tools/lib/github.mjs: the GitHub REST reads of check-envs.mjs and approved-base.mjs, through the gh CLI with a fixed argument list
// and no shell. The repository is always eve-cyno/plugins and the host always github.com (an argument, never the environment); gh
// brings its own login, which this code never reads. Every failure is an { error }, never an exception and never a guessed value.
import { execFile } from 'node:child_process';

export const REPO = 'eve-cyno/plugins';
export const HOST = 'github.com';
export const TIMEOUT_MS = 120_000;
const MAX_OUTPUT = 32 * 1024 * 1024;
const HEADERS = ['-H', 'Accept: application/vnd.github+json', '-H', 'X-GitHub-Api-Version: 2022-11-28'];

/** One line, printable ASCII only, so no answer can start a workflow command or a fake output line. */
export const oneLine = (s) => String(s).replace(/[^\x20-\x7e]+/g, ' ').trim().slice(0, 300);
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/** Runs gh without a shell. Resolves to { code, stdout, stderr } or { error }; never rejects. */
export function runGh(args, { env = process.env, timeoutMs = TIMEOUT_MS } = {}) {
  const childEnv = { ...env, GH_PROMPT_DISABLED: '1', GH_NO_UPDATE_NOTIFIER: '1', GH_PAGER: 'cat', NO_COLOR: '1' };
  for (const k of ['GH_HOST', 'GH_REPO', 'GH_FORCE_TTY', 'GH_DEBUG', 'DEBUG']) delete childEnv[k];
  return new Promise((resolve) => {
    let child;
    try {
      child = execFile('gh', args, { env: childEnv, encoding: 'utf8', maxBuffer: MAX_OUTPUT, timeout: timeoutMs, killSignal: 'SIGKILL', windowsHide: true },
        (err, stdout, stderr) => {
          if (!err) return resolve({ code: 0, stdout, stderr });
          if (err.code === 'ENOENT') return resolve({ error: 'gh not found on PATH' });
          if (err.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') return resolve({ error: `gh passed the output limit (${MAX_OUTPUT} bytes)` });
          if (err.killed) return resolve({ error: `gh did not finish within ${timeoutMs} ms` });
          if (typeof err.code === 'number') return resolve({ code: err.code, stdout, stderr });
          return resolve({ error: `gh failed: ${oneLine(err.signal ?? err.message)}` });
        });
    } catch (err) {
      return resolve({ error: `gh could not start: ${oneLine(err.message)}` });
    }
    child.stdin?.end();
  });
}

/** GET one endpoint: { value } (its JSON) or { error }. */
export async function getJson(endpoint, opts) {
  const r = await runGh(['api', `--hostname=${HOST}`, '--method=GET', ...HEADERS, endpoint], opts);
  if (r.error) return { error: `${endpoint}: ${r.error}` };
  if (r.code !== 0) return { error: `${endpoint}: gh api exited ${r.code}: ${oneLine(r.stderr)}` };
  try { return { value: JSON.parse(r.stdout) }; } catch { return { error: `${endpoint}: the answer is not one JSON value` }; }
}

/**
 * GET every page of a list endpoint whose pages are { total_count, <key>: [...] } (`--paginate --slurp`): { items } or { error }.
 * Fails closed: a page of another shape, pages that disagree on total_count, an item read twice or fewer items than total_count is
 * an error ("the list is incomplete"), never a shorter list.
 */
export async function getAll(endpoint, key, opts) {
  const r = await runGh(['api', `--hostname=${HOST}`, '--method=GET', ...HEADERS, '--paginate', '--slurp', endpoint], opts);
  if (r.error) return { error: `${endpoint}: ${r.error}` };
  if (r.code !== 0) return { error: `${endpoint}: gh api exited ${r.code}: ${oneLine(r.stderr)}` };
  let pages;
  try { pages = JSON.parse(r.stdout); } catch { return { error: `${endpoint}: the answer is not one JSON value` }; }
  if (!Array.isArray(pages) || pages.length === 0) return { error: `${endpoint}: no pages` };
  const items = [];
  let total = null;
  for (const p of pages) {
    if (!isObj(p) || !Number.isSafeInteger(p.total_count) || !Array.isArray(p[key])) return { error: `${endpoint}: a page is not { total_count, ${key} }` };
    if (total !== null && p.total_count !== total) return { error: `${endpoint}: the pages disagree on total_count; the list is incomplete` };
    total = p.total_count;
    items.push(...p[key]);
  }
  const ids = items.map((x) => (isObj(x) ? x.id : undefined)).filter((id) => id !== undefined);
  if (new Set(ids).size !== ids.length) return { error: `${endpoint}: an item was read twice; the list is incomplete` };
  if (items.length !== total) return { error: `${endpoint}: ${items.length} of ${total} items read; the list is incomplete` };
  return { items };
}

/**
 * The parts of a `gh api -i` answer: { status, headers, body } (headers: lower-case name to the list of its values; body: the
 * JSON value or null), or { error } when it is not exactly one HTTP answer.
 */
export function parseHttp(text) {
  const sep = /\r?\n\r?\n/.exec(text);
  if (!sep) return { error: 'no blank line after the headers' };
  const head = text.slice(0, sep.index).split(/\r?\n/);
  const m = /^HTTP\/[0-9.]+ ([1-5][0-9]{2})(?: .*)?$/.exec(head[0]);
  if (!m) return { error: `not an HTTP status line: ${oneLine(head[0])}` };
  const headers = new Map();
  for (const l of head.slice(1)) {
    const k = l.indexOf(':');
    if (k <= 0) return { error: `a header line without a name: ${oneLine(l)}` };
    const name = l.slice(0, k).trim().toLowerCase();
    headers.set(name, [...(headers.get(name) ?? []), l.slice(k + 1).trim()]);
  }
  const rest = text.slice(sep.index + sep[0].length);
  if (/^\s*HTTP\//.test(rest) || /\r?\n\r?\nHTTP\//.test(rest)) return { error: 'more than one HTTP answer' };
  let body = null;
  try { body = JSON.parse(rest); } catch { body = null; }
  return { status: Number(m[1]), headers, body };
}

/**
 * One request read with its status line and headers (`gh api -i`): the parts of parseHttp, or { error }. `fields` are gh's body
 * arguments (`-f key=value`, `-F key=value`), placed before the endpoint, which stays the last argument.
 */
export async function probe(method, endpoint, opts, fields = []) {
  const r = await runGh(['api', `--hostname=${HOST}`, '-i', `--method=${method}`, ...HEADERS, ...fields, endpoint], opts);
  if (r.error) return { error: r.error };
  if (!r.stdout) return { error: `gh api exited ${r.code} with no answer: ${oneLine(r.stderr)}` };
  return parseHttp(r.stdout);
}
