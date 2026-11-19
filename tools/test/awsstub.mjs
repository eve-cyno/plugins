// A stub `aws` for the tests of tools/publish/ (plan task 2.4): an R2 bucket kept in one JSON file, answered through the s3api calls
// the upload step makes (get-object with a byte range, which a 0-byte object answers with InvalidRange as S3 and R2 do; head-object;
// put-object with --if-match or --if-none-match) and the runner-image
// check (--version, put-object --generate-cli-skeleton). It is written beside the stub gh of ghstub.mjs into a temp folder that is the
// only entry of PATH the tools see, so the real aws and gh are never found: no network, no credential. The upload step gives aws a
// minimal environment of its own, so the stub finds the case's bucket file and log through aws-paths.json beside it (pointStub()).
// Every call is appended to the log with the credential variables the call saw (the tests set fake values only). Faults script a lost answer, a 412, a network error or
// another writer: { op: 'put-object' | 'get-object' | 'head-object', key, nth (1-based count of that op on that key), result?, before?,
// after? }, where `before` and `after` are { key: bytes (base64) | null } written into the bucket before the call is answered or after
// it took effect. result: get-object and head-object 'network' | 'error', head-object also 'no-etag'; put-object 'network-landed' | 'network-lost' | '412' | 'error' | 'no-etag' (the write
// lands and the answer names no ETag).
// serveBucket() serves the same file over http://127.0.0.1 as the custom domain serves the bucket: each object with its stored
// Cache-Control, Content-Type and ETag, 404 for a missing key. The bucket file's `edge` stands for what the edge serves instead of the
// bucket (a cache behind or ahead of it, an answer of its own): { key: object (served in place of the bucket's) | null (404) |
// { status } (that status, no body) }; the stub aws never reads it.
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { makeGhStub } from './ghstub.mjs';

export const md5Etag = (b) => `"${crypto.createHash('md5').update(b).digest('hex')}"`;

/** Makes the stub folder (gh, git and aws) in a new temp folder registered in `temps`; returns its path. */
export function makeStubBin(temps) {
  const bin = makeGhStub(temps);
  fs.writeFileSync(path.join(bin, 'aws'), `#!${process.execPath}
const fs = require('node:fs');
const crypto = require('node:crypto');
const e = process.env;
const argv = process.argv.slice(2);
const where = JSON.parse(fs.readFileSync(require('node:path').join(__dirname, 'aws-paths.json'), 'utf8'));
const st = JSON.parse(fs.readFileSync(where.bucket, 'utf8'));
const opt = (n) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : undefined; };
const entry = { argv, env: { keyId: e.AWS_ACCESS_KEY_ID ?? null, secret: e.AWS_SECRET_ACCESS_KEY ?? null, region: e.AWS_DEFAULT_REGION ?? null,
  attempts: e.AWS_MAX_ATTEMPTS ?? null, other: Object.keys(e).filter((k) => /^(R2_|GH_TOKEN|GITHUB_TOKEN)/.test(k)) } };
const save = () => fs.writeFileSync(where.bucket, JSON.stringify(st));
const log = () => fs.appendFileSync(where.log, JSON.stringify(entry) + '\\n');
const etag = (b) => '"' + crypto.createHash('md5').update(b).digest('hex') + '"';
if (argv[0] === '--version') { log(); process.stdout.write(st.version + '\\n'); process.exit(0); }
if (argv[0] === 's3api' && argv[1] === 'put-object' && argv.includes('--generate-cli-skeleton')) {
  log();
  const sk = { Bucket: '', Key: '', Body: '', CacheControl: '', ContentType: '', IfMatch: '', IfNoneMatch: '' };
  for (const k of st.skeletonDrop) delete sk[k];
  process.stdout.write(JSON.stringify(sk, null, 4) + '\\n');
  process.exit(0);
}
const op = argv[1];
const key = opt('--key');
const count = (st.counts[op + ' ' + key] ?? 0) + 1;
st.counts[op + ' ' + key] = count;
const fault = st.faults.find((f) => f.op === op && f.key === key && f.nth === count);
entry.fault = fault ? (fault.result ?? 'writer') : null;
const apply = (m) => { for (const [k, v] of Object.entries(m ?? {})) { if (v === null) delete st.objects[k]; else st.objects[k] = { b64: v, etag: etag(Buffer.from(v, 'base64')), contentType: 'application/octet-stream', cacheControl: '' }; } };
const net = () => { log(); save(); process.stderr.write('\\nCould not connect to the endpoint URL: "https://stub.invalid/' + key + '"\\n'); process.exit(255); };
const service = (code, msg) => { log(); save(); process.stderr.write('\\nAn error occurred (' + code + ') when calling the ' + ({ 'put-object': 'PutObject', 'head-object': 'HeadObject' }[op] ?? 'GetObject') + ' operation: ' + msg + '\\n'); process.exit(254); };
if (fault) apply(fault.before);
if (op === 'get-object') {
  if (fault?.result === 'network') net();
  if (fault?.result === 'error') service('InternalError', 'We encountered an internal error. Please try again.');
  const o = st.objects[key];
  if (!o) service('NoSuchKey', 'The specified key does not exist.');
  const all = Buffer.from(o.b64, 'base64');
  if (opt('--range') !== undefined && all.length === 0) service('InvalidRange', 'The requested range is not satisfiable');
  const m = /^bytes=0-(\\d+)$/.exec(opt('--range') ?? '');
  const b = m ? all.subarray(0, Number(m[1]) + 1) : all;
  fs.writeFileSync(argv[argv.length - 1], b);
  if (fault) apply(fault.after);
  log(); save();
  process.stdout.write(JSON.stringify({ AcceptRanges: 'bytes', ContentLength: b.length, ContentRange: 'bytes 0-' + (b.length - 1) + '/' + all.length,
    ETag: o.etag, CacheControl: o.cacheControl, ContentType: o.contentType, Metadata: {} }, null, 4) + '\\n');
  process.exit(0);
}
if (op === 'head-object') {
  if (fault?.result === 'network') net();
  if (fault?.result === 'error') service('InternalError', 'We encountered an internal error. Please try again.');
  const o = st.objects[key];
  if (!o) service('404', 'Not Found');
  if (fault) apply(fault.after);
  log(); save();
  process.stdout.write(JSON.stringify({ AcceptRanges: 'bytes', ContentLength: Buffer.from(o.b64, 'base64').length,
    ...(fault?.result === 'no-etag' ? {} : { ETag: o.etag }), CacheControl: o.cacheControl, ContentType: o.contentType, Metadata: {} }, null, 4) + '\\n');
  process.exit(0);
}
if (op === 'put-object') {
  const body = fs.readFileSync(opt('--body'));
  entry.bodySha = crypto.createHash('sha256').update(body).digest('hex');
  if (fault?.result === 'network-lost') net();
  if (fault?.result === '412') service('PreconditionFailed', 'At least one of the pre-conditions you specified did not hold');
  if (fault?.result === 'error') service('AccessDenied', 'Access Denied');
  const cur = st.objects[key];
  const im = opt('--if-match');
  const inm = opt('--if-none-match');
  if (im !== undefined && (!cur || cur.etag !== im)) service('PreconditionFailed', 'At least one of the pre-conditions you specified did not hold');
  if (inm !== undefined && cur) service('PreconditionFailed', 'At least one of the pre-conditions you specified did not hold');
  st.objects[key] = { b64: body.toString('base64'), etag: etag(body), contentType: opt('--content-type') ?? '', cacheControl: opt('--cache-control') ?? '' };
  if (fault) apply(fault.after);
  if (fault?.result === 'network-landed') net();
  log(); save();
  process.stdout.write(JSON.stringify(fault?.result === 'no-etag' ? { ChecksumCRC32: 'AAAAAA==' } : { ETag: etag(body), ChecksumCRC32: 'AAAAAA==' }, null, 4) + '\\n');
  process.exit(0);
}
log();
process.stderr.write('stub: no such aws call\\n');
process.exit(97);
`, { mode: 0o755 });
  return bin;
}

/** Points the stub aws of `bin` at one case's bucket file and log. */
export function pointStub(bin, { bucket, log }) {
  fs.writeFileSync(path.join(bin, 'aws-paths.json'), JSON.stringify({ bucket, log }));
}

/** A bucket file: { objects: { key: { b64, etag, contentType, cacheControl } }, faults, counts, version, skeletonDrop, edge }. */
export function writeBucket(file, { objects = {}, faults = [], version = 'aws-cli/2.31.9 Python/3.13.7 Linux/6.11.0-1012-azure exe/x86_64.ubuntu.24', skeletonDrop = [], edge = {} } = {}) {
  fs.writeFileSync(file, JSON.stringify({ objects, faults, counts: {}, version, skeletonDrop, edge }));
}
export const readBucket = (file) => JSON.parse(fs.readFileSync(file, 'utf8')).objects;
/** One bucket object for `bytes` with the headers the upload step gives it. */
export const object = (bytes, contentType, cacheControl) => ({ b64: Buffer.from(bytes).toString('base64'), etag: md5Etag(bytes), contentType, cacheControl });

/**
 * Serves the bucket file `bucketFile()` (a function, so one server serves each case's bucket) at http://127.0.0.1:<port>/<key>.
 * Resolves { port, close(), requests } (requests: { url, at } in order).
 */
export function serveBucket(bucketFile) {
  const requests = [];
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      requests.push({ url: req.url, at: Date.now() });
      const key = decodeURIComponent(new URL(req.url, 'http://127.0.0.1').pathname.slice(1));
      const f = bucketFile();
      const st = f && fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : null;
      const e = st?.edge && Object.hasOwn(st.edge, key) ? st.edge[key] : undefined;
      if (e && typeof e.status === 'number') { res.writeHead(e.status, { 'Content-Type': 'text/plain' }); res.end(); return; }
      const o = e === undefined ? st?.objects[key] : e;
      if (!o) { res.writeHead(404, { 'Content-Type': 'text/plain' }); res.end('not found'); return; }
      const b = Buffer.from(o.b64, 'base64');
      res.writeHead(200, { 'Cache-Control': o.cacheControl, 'Content-Type': o.contentType, ETag: o.etag, 'Content-Length': b.length });
      res.end(b);
    });
    server.listen(0, '127.0.0.1', () => resolve({ port: server.address().port, close: () => server.close(), requests }));
  });
}

/** The aws log of a run: [{ argv, env, fault, bodySha }]. */
export const readAwsLog = (file) => fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
/** The S3 calls of a log as { op, key, ifMatch, ifNoneMatch, cacheControl, contentType, bodySha, fault }. */
export const s3Calls = (log) => log.filter((c) => c.argv[0] === 's3api' && !c.argv.includes('--generate-cli-skeleton')).map((c) => {
  const opt = (n) => { const i = c.argv.indexOf(n); return i >= 0 ? c.argv[i + 1] : undefined; };
  return { op: c.argv[1], key: opt('--key'), ifMatch: opt('--if-match'), ifNoneMatch: opt('--if-none-match'), cacheControl: opt('--cache-control'),
    contentType: opt('--content-type'), range: opt('--range'), bodySha: c.bodySha, fault: c.fault };
});
