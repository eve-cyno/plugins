#!/usr/bin/env node
// tools/publish/verify-live.mjs: the verify job of publish.yml and resign.yml (plan 4.2 job verify, 6.2): the live index read back
// after an upload, as the app reads it, with no environment and no secret.
//   node tools/publish/verify-live.mjs --target production|test --in <folder> [--summary <file>]
// For tests only: --prefix <URL> (a local server) and --key <pub>... (target production: instead of the pinned index keys).
// target test reads https://plugins.eve-cyno.dev/test/v1/ and verifies with the run's throwaway public key, <folder>/test.pub (the
// test-key artifact); target production reads /v1/ with the pinned index keys, and <folder> is not read.
// What index-verify.mjs --live --archives checks, paced (tools/lib/liveread.mjs: at most 50 requests per 10 s): every file downloaded
// once into a temp folder, then the vendored index-verify.mjs on that folder with --archives (signature, head, catalog, each archive
// and its contents), plus the checks only --live makes: the head and its signature served with Cache-Control: no-cache, and the head's
// generated not ahead of the server's Date by more than 5 minutes. A catalog or archive served without an immutable Cache-Control is
// a NOTE. Exit 0 when everything passed, 1 when anything failed (a red verify is never re-run: docs/RUNBOOK.md), 2 usage.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { createReport } from '../lib/summary.mjs';
import { PREFIXES, indexKeys, prefixProblem, runVendored } from '../lib/indexbuild.mjs';
import { downloadServed } from '../lib/liveread.mjs';
import { noCache } from '../../vendor/eve-cyno-host/scripts/release-lib.mjs';

const USAGE = 'usage: node tools/publish/verify-live.mjs --target production|test --in <folder> [--summary <file>]\n       tests only: [--prefix <URL>] [--key <pub>...]';
const usage = (why) => { if (why) console.error(why); console.error(USAGE); process.exit(2); };
let a;
try {
  a = parseArgs({ args: process.argv.slice(2), strict: true, allowPositionals: false,
    options: { target: { type: 'string' }, in: { type: 'string' }, summary: { type: 'string' }, prefix: { type: 'string' }, key: { type: 'string', multiple: true } } }).values;
} catch (e) { usage(e.message); }
if (a.target !== 'production' && a.target !== 'test') usage('--target: production or test');
if (typeof a.in !== 'string' || a.in === '') usage('--in <folder> is required');
if (a.target === 'test' && a.key) usage('--key: target test verifies with the run\'s throwaway key, test.pub in the input folder');
if (a.prefix !== undefined && prefixProblem(a.prefix)) usage(`--prefix: ${prefixProblem(a.prefix)}`);
const P = a.prefix ?? PREFIXES[a.target];

const R = createReport();
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'evecyno-verify-live-'));
const end = (code, verdict) => {
  R.finish(verdict, { title: `tools/publish/verify-live.mjs ${a.target}`, file: a.summary });
  fs.rmSync(work, { recursive: true, force: true });
  process.exit(code);
};

const keyFiles = a.target === 'test' ? [path.join(path.resolve(a.in), 'test.pub')] : (a.key ?? []).map(k => path.resolve(k));
if (a.target === 'test' && !fs.existsSync(keyFiles[0])) { R.fail('input', 'target test: the run\'s throwaway public key test.pub is not in the input folder'); end(1, 'LIVE NOT VERIFIED'); }
const keyed = indexKeys(keyFiles);
if (keyed.why) { R.fail('input', keyed.why); end(1, 'LIVE NOT VERIFIED'); }

const dir = path.join(work, 'live');
const d = await downloadServed({ prefix: P, dir });
if (!d.ok) { R.fail('read', `the live index cannot be read back: ${d.why}`); end(1, 'LIVE NOT VERIFIED'); }
R.note(`read ${P}: index.json, index.json.minisig, ${d.catalogName} and ${d.archives.length} archives (paced)`);
for (const name of ['index.json', 'index.json.minisig']) {
  const cc = d.served[name].cacheControl;
  if (noCache(cc)) R.pass('cache', `${name} is served with Cache-Control: no-cache`);
  else R.fail('cache', `${name} is served with Cache-Control "${cc}", not no-cache`);
}
const date = Date.parse(d.served['index.json'].date ?? '');
if (!Number.isFinite(date)) R.fail('date', 'index.json is served without a Date header to check its generated against');
else if (Date.parse(d.head.generated) > date + 300_000) R.fail('date', `generated ${d.head.generated} is ahead of the server's clock (Date: ${new Date(date).toISOString()})`);
else R.pass('date', `generated ${d.head.generated}, not ahead of the server's clock`);
const mutable = [d.catalogName, ...d.archives].filter(n => !/(?:^|[\s,])immutable(?:$|[\s,])/i.test(d.served[n].cacheControl));
if (mutable.length > 0) R.note(`served without an immutable Cache-Control: ${mutable.slice(0, 5).join(', ')}${mutable.length > 5 ? ` and ${mutable.length - 5} more` : ''}`);

const v = await runVendored('index-verify.mjs', [dir, '--archives', '--prefix', P, ...keyFiles.flatMap(k => ['--key', k])]);
for (const l of v.stdout.split('\n')) {
  if (l.startsWith('FAIL ')) R.fail('index-verify', l.slice(5));
  else if (l.startsWith('WARN ') || l.startsWith('INDEX VERIFY ')) R.note(`index-verify: ${l}`);
}
if (v.code !== 0 && !v.stdout.includes('FAIL ')) R.fail('index-verify', `exit ${v.code}: ${v.stderr.split('\n').find(Boolean) ?? 'no output'}`);
if (R.failed > 0) end(1, `LIVE NOT VERIFIED ${R.failed}`);
end(0, `LIVE VERIFIED ${P} generated ${d.head.generated}`);
