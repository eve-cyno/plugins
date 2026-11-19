// tools/lib/r2.mjs: the bucket behind plugins.eve-cyno.dev through the R2 S3 API, with the AWS CLI of the runner image (plan 4.2 job
// upload, 6.4). Every call is the `aws` program with a fixed argument list and no shell. The credentials are the mirror environment's
// R2_ACCESS_KEY_ID and R2_SECRET_ACCESS_KEY (the names publish.yml and resign.yml pass to the upload step); takeCredentials() removes
// them, and every AWS_* variable, from this process's environment before anything runs, so they reach the aws child only, as its
// standard AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY, never as an argument. Text that aws prints is cut to one line and has both
// values replaced by *** before anyone sees it.
// - Reads are get-object with a byte range (never more than `max` + 1 bytes reach the disk): {status: 'ok', bytes, etag},
//   {status: 'too-large', etag} (more than `max` bytes), {status: 'missing'} (no such key) or {status: 'error', why}. A 0-byte object
//   answers a ranged GET with InvalidRange (HTTP 416); then head-object must show ContentLength 0 and an ETag, and the read is
//   {status: 'ok', bytes: <empty>, etag}, so an empty live object is read as one and never blocks a repair. Any other head-object
//   answer, a missing object included, is an error.
// - Writes are put-object, always conditional (--if-match <ETag> or --if-none-match '*'), with the object's Content-Type and
//   Cache-Control: {status: 'ok', etag (null when the answer named none)} or {status: 'precondition' (412) | 'missing' | 'network' |
//   'error', why}.
// - One retry, for a network error only (aws exit 255 or a time-out); the CLI's own retries are off (AWS_MAX_ATTEMPTS=1), so a write
//   is sent at most twice and the caller decides what a failure means (recovery R1).
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { oneLine } from './github.mjs';

/** Cache-Control of the content-addressed files (catalog/<sha256>.json, archives/<sha256>.zip) and of the head and its signature. */
export const IMMUTABLE = 'public, max-age=31536000, immutable';
export const NO_CACHE = 'no-cache';
/** Content-Type by file name (plan 6.4). */
export const contentTypeOf = (key) => (key.endsWith('.zip') ? 'application/zip' : key.endsWith('.minisig') ? 'text/plain' : 'application/json');

const NAMES = ['R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY', 'R2_ACCOUNT_ID', 'R2_BUCKET'];
const MAX_OUTPUT = 1024 * 1024;

/**
 * Takes the mirror's values out of `env` (deleted from it, with every AWS_* variable): {creds} or {why}. Call it before anything else,
 * so no other child (the vendored verifier, gh, git) inherits them.
 */
export function takeCredentials(env = process.env) {
  const v = {};
  for (const k of NAMES) { v[k] = env[k]; delete env[k]; }
  for (const k of Object.keys(env)) if (k.startsWith('AWS_')) delete env[k];
  const missing = NAMES.filter(k => typeof v[k] !== 'string' || v[k] === '');
  if (missing.length > 0) return { why: `not set in the environment mirror: ${missing.join(', ')} (docs/RUNBOOK.md, Secrets)` };
  if (!/^[0-9a-f]{32}$/.test(v.R2_ACCOUNT_ID)) return { why: 'R2_ACCOUNT_ID is not a Cloudflare account id (32 lower-case hex)' };
  if (!/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(v.R2_BUCKET)) return { why: 'R2_BUCKET is not an R2 bucket name' };
  if (/\s/.test(v.R2_ACCESS_KEY_ID) || /\s/.test(v.R2_SECRET_ACCESS_KEY)) return { why: 'R2_ACCESS_KEY_ID or R2_SECRET_ACCESS_KEY holds white space' };
  return { creds: { accountId: v.R2_ACCOUNT_ID, bucket: v.R2_BUCKET, keyId: v.R2_ACCESS_KEY_ID, secret: v.R2_SECRET_ACCESS_KEY } };
}

/** What a finished aws call means: ok, precondition (412, or 409 for a conditional write that raced), missing, network or error. */
export function kindOf(r) {
  if (r.error) return 'error';
  if (r.timedOut) return 'network';
  if (r.code === 0) return 'ok';
  if (/\((?:PreconditionFailed|ConditionalRequestConflict|412|409)\)/.test(r.stderr)) return 'precondition';
  if (/\((?:NoSuchKey|404)\)/.test(r.stderr)) return 'missing';
  if (r.code === 255) return 'network';
  return 'error';
}

/**
 * A client of one bucket. `workDir` is a private folder for the CLI's home and the downloaded bytes (removed by the caller). Returns
 * {endpoint, checkCli(), get(key, max), put(key, file, {cacheControl, ifMatch | ifNoneMatch: '*'}), redact(text)}.
 */
export function r2Client(creds, { workDir, timeoutMs = 600_000 }) {
  const endpoint = `https://${creds.accountId}.r2.cloudflarestorage.com`;
  const redact = (s) => [creds.keyId, creds.secret].reduce((t, x) => t.split(x).join('***'), oneLine(s));
  const env = {
    PATH: process.env.PATH ?? '', HOME: workDir, LC_ALL: 'C.UTF-8',
    AWS_ACCESS_KEY_ID: creds.keyId, AWS_SECRET_ACCESS_KEY: creds.secret, AWS_DEFAULT_REGION: 'auto',
    AWS_CONFIG_FILE: path.join(workDir, 'no-aws-config'), AWS_SHARED_CREDENTIALS_FILE: path.join(workDir, 'no-aws-credentials'),
    AWS_EC2_METADATA_DISABLED: 'true', AWS_PAGER: '', AWS_CLI_AUTO_PROMPT: 'off', AWS_MAX_ATTEMPTS: '1', AWS_RETRY_MODE: 'standard',
    // R2 takes the S3 API's checksums only where they are required (Cloudflare's guidance for AWS CLI 2.23 and later).
    AWS_REQUEST_CHECKSUM_CALCULATION: 'when_required', AWS_RESPONSE_CHECKSUM_VALIDATION: 'when_required',
  };
  const aws = (args, ms = timeoutMs) => new Promise((resolve) => {
    try {
      execFile('aws', args, { env, encoding: 'utf8', maxBuffer: MAX_OUTPUT, timeout: ms, killSignal: 'SIGKILL', windowsHide: true }, (err, stdout, stderr) => {
        if (!err) return resolve({ code: 0, stdout, stderr });
        if (err.code === 'ENOENT') return resolve({ error: 'aws not found on PATH' });
        if (err.killed) return resolve({ timedOut: true, stdout: stdout ?? '', stderr: `no answer within ${ms} ms` });
        if (typeof err.code === 'number') return resolve({ code: err.code, stdout: stdout ?? '', stderr: stderr ?? '' });
        return resolve({ error: `aws failed: ${oneLine(err.signal ?? err.message)}` });
      });
    } catch (e) { resolve({ error: `aws could not start: ${oneLine(e.message)}` }); }
  });
  const whyOf = (r, k) => (r.error ? r.error : `${k}: ${redact(r.stderr || `aws exited ${r.code}`)}`);
  /** True when a get-object answer is InvalidRange (HTTP 416): what a ranged GET of a 0-byte object answers. */
  const invalidRange = (r) => !r.error && !r.timedOut && r.code !== 0 && /\((?:InvalidRange|416)\)/.test(r.stderr ?? '');
  const s3 = (op, key) => ['s3api', op, '--endpoint-url', endpoint, '--bucket', creds.bucket, '--key', key, '--output', 'json'];
  let n = 0;
  /** The read of a key whose ranged GET answered InvalidRange: ok with empty bytes when head-object shows a 0-byte object, else an error. */
  const readEmpty = async (key) => {
    for (let attempt = 1; ; attempt++) {
      const r = await aws(s3('head-object', key));
      const k = kindOf(r);
      if (k === 'network' && attempt === 1) continue;
      if (k !== 'ok') return { status: 'error', why: `get-object answered InvalidRange and head-object ${whyOf(r, k)}` };
      let h;
      try { h = JSON.parse(r.stdout); } catch { return { status: 'error', why: 'get-object answered InvalidRange and head-object answered no JSON' }; }
      if (h === null || typeof h !== 'object' || h.ContentLength !== 0) {
        return { status: 'error', why: `get-object answered InvalidRange, but head-object shows not a 0-byte object (ContentLength ${oneLine(JSON.stringify(h?.ContentLength))})` };
      }
      if (typeof h.ETag !== 'string' || h.ETag === '') return { status: 'error', why: 'get-object answered InvalidRange and head-object named no ETag' };
      return { status: 'ok', bytes: Buffer.alloc(0), etag: h.ETag };
    }
  };

  return {
    endpoint,
    redact,
    /** The runner-image check (plan 6.4): {version} or {why}. */
    async checkCli() {
      const v = await aws(['--version'], 60_000);
      if (v.error) return { why: v.error };
      const m = /^aws-cli\/(\d+)\.(\d+)\.(\d+)\s/.exec(`${v.stdout ?? ''}${v.stderr ?? ''}`.trim() + ' ');
      if (v.code !== 0 || !m) return { why: 'aws --version names no aws-cli version' };
      const version = `${m[1]}.${m[2]}.${m[3]}`;
      if (m[1] !== '2') return { why: `aws-cli ${version} is not version 2` };
      const s = await aws(['s3api', 'put-object', '--generate-cli-skeleton', 'input'], 60_000);
      let sk = null;
      try { sk = s.code === 0 ? JSON.parse(s.stdout) : null; } catch { /* below */ }
      if (!sk || typeof sk !== 'object') return { why: `aws-cli ${version}: s3api put-object --generate-cli-skeleton gave no JSON` };
      const lack = ['IfMatch', 'IfNoneMatch'].filter(k => !Object.hasOwn(sk, k)).map(k => (k === 'IfMatch' ? '--if-match' : '--if-none-match'));
      if (lack.length > 0) {
        return { why: `aws-cli ${version}: s3api put-object takes no ${lack.join(' or ')}, which the compare-and-swap needs; the workflow must install a pinned AWS CLI release with a checked hash first (plan 6.4)` };
      }
      return { version };
    },
    async get(key, max) {
      const out = path.join(workDir, `get-${++n}`);
      for (let attempt = 1; ; attempt++) {
        fs.rmSync(out, { force: true });
        const r = await aws([...s3('get-object', key), '--range', `bytes=0-${max}`, out]);
        const k = kindOf(r);
        if (k === 'network' && attempt === 1) continue;
        try {
          if (k === 'missing') return { status: 'missing' };
          if (invalidRange(r)) return await readEmpty(key);
          if (k !== 'ok') return { status: 'error', why: whyOf(r, k) };
          let etag;
          try { etag = JSON.parse(r.stdout).ETag; } catch { return { status: 'error', why: 'get-object answered no JSON' }; }
          if (typeof etag !== 'string' || etag === '') return { status: 'error', why: 'get-object named no ETag' };
          let bytes;
          try { bytes = fs.readFileSync(out); } catch { return { status: 'error', why: 'get-object wrote no file' }; }
          return bytes.length > max ? { status: 'too-large', etag } : { status: 'ok', bytes, etag };
        } finally { fs.rmSync(out, { force: true }); }
      }
    },
    async put(key, file, { cacheControl, ifMatch, ifNoneMatch }) {
      const cond = typeof ifMatch === 'string' && ifMatch !== '' ? ['--if-match', ifMatch] : ifNoneMatch === '*' ? ['--if-none-match', '*'] : null;
      if (!cond) throw new Error('r2 put: every write is conditional');
      for (let attempt = 1; ; attempt++) {
        const r = await aws([...s3('put-object', key), '--body', file, '--content-type', contentTypeOf(key), '--cache-control', cacheControl, ...cond]);
        const k = kindOf(r);
        if (k === 'network' && attempt === 1) continue;
        if (k !== 'ok') return { status: k, why: whyOf(r, k), attempts: attempt };
        let etag = null;
        try { const e = JSON.parse(r.stdout).ETag; if (typeof e === 'string' && e !== '') etag = e; } catch { /* the answer was lost: null */ }
        return { status: 'ok', etag, attempts: attempt };
      }
    },
  };
}
