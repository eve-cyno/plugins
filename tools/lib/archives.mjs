// The archive checks C4-C7 (plan section 3.2): an entry version's archive downloaded from its author's URL, its size and SHA-256
// against the listing, then read and checked by the desktop app's own code (vendor/eve-cyno-host, never a copy of its rules):
//   C4 the download: https only, on the default port, no credentials; the start URL without a query or fragment; at most 5 redirects,
//      each https and checked like the start; every address a name resolves to must be public (plan 7.6), and the connection goes
//      only to the addresses that were checked (one lookup per hop, no second lookup that could move it); at most MAX_ARCHIVE_BYTES;
//      ended after ARCHIVE_IDLE_MS without progress and after ARCHIVE_TOTAL_MS in all; no content coding.
//   C5 the byte count and SHA-256 of the download equal the listing's (the values the entry pins and the app checks again).
//   C6 the app's zip reader (market/zipread readZip) with its default limits: zip64, encryption, links, bombs by ratio, total size and
//      entry count, and unsafe names are refused there.
//   C7 a plugin: the installer's staged checks (market/stagecheck checkStagedPlugin: plugin.json at the root, the manifest parser,
//      listingDifference, the loader's folder checks) in a temp folder removed at once. A theme package: theme.json and an optional
//      LICENSE at the root and nothing else, parsePackage, themeListingDifference, then what the app's theme store refuses when it
//      adds the package (themes/packages.ts addNow): a LICENSE over MAX_LICENSE_BYTES or not UTF-8, and no usable theme.
// Nothing here throws on hostile input: every refusal is {ok: false, check, error, why}. `why` never carries a URL, a header value or a
// local path; C7's reasons are the app's own messages, which may name a field of the archive's manifest, so a job summary escapes `why`
// like any other text.
import crypto from 'node:crypto';
import dns from 'node:dns';
import fs from 'node:fs';
import https from 'node:https';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const DIST = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'vendor', 'eve-cyno-host', 'host', 'dist');
const require = createRequire(import.meta.url);
const I = require(path.join(DIST, 'market', 'indexformat.js'));
const Z = require(path.join(DIST, 'market', 'zipread.js'));
const SC = require(path.join(DIST, 'market', 'stagecheck.js'));
const TP = require(path.join(DIST, 'themes', 'package.js'));

/** C4: at most this many redirects (plan 3.2; cross-origin allowed, unlike the app's mirror downloads: release hosts redirect). */
export const MAX_REDIRECTS = 5;
/** C4: the whole download, redirects included (the bound index-verify.mjs --live gives one archive read). */
export const ARCHIVE_TOTAL_MS = 600_000;
const USER_AGENT = 'EVE-Cyno-plugins-check';
const REDIRECTS = new Set([301, 302, 303, 307, 308]);

/**
 * The download bounds: the client's MAX_ARCHIVE_BYTES and ARCHIVE_IDLE_MS, MAX_REDIRECTS and ARCHIVE_TOTAL_MS. An option may lower
 * a bound (a test, a tool with a tighter need), never raise it.
 */
export function downloadLimits(o = {}) {
  const low = (v, max) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.min(v, max) : max);
  return {
    maxBytes: low(o.maxBytes, I.MAX_ARCHIVE_BYTES),
    idleMs: low(o.idleMs, I.ARCHIVE_IDLE_MS),
    totalMs: low(o.totalMs, ARCHIVE_TOTAL_MS),
    maxRedirects: low(o.maxRedirects, MAX_REDIRECTS),
  };
}

// ---- the address rule (plan 7.6 "Addresses": an allowlist) ------------------------------------------------------------------------------
// IPv4: public only outside every block of the IANA IPv4 Special-Purpose Address Registry that is not globally reachable, multicast and
// the reserved range, as the plan lists them. IPv6: public only inside 2000::/3 and outside 2001::/23, 2001:db8::/32 (documentation),
// 2002::/16 (6to4) and 3fff::/20 (documentation); everything outside 2000::/3 (::, ::1, IPv4-mapped and -compatible, NAT64, ULA,
// link-local, multicast, ...) is refused, with no unmapping. Desktop task 3.2 adds the app's own isPublicAddress; once it is vendored,
// this list goes and the vendored function is used.
const V4_NOT_PUBLIC = new net.BlockList();
for (const [a, bits] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24],
  ['192.0.2.0', 24], ['192.88.99.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24],
  ['224.0.0.0', 4], ['240.0.0.0', 4],
]) V4_NOT_PUBLIC.addSubnet(a, bits, 'ipv4');
const V6_GLOBAL = new net.BlockList();
V6_GLOBAL.addSubnet('2000::', 3, 'ipv6');
const V6_NOT_PUBLIC = new net.BlockList();
for (const [a, bits] of [['2001::', 23], ['2001:db8::', 32], ['2002::', 16], ['3fff::', 20]]) V6_NOT_PUBLIC.addSubnet(a, bits, 'ipv6');

/** True only for a plain IPv4 or IPv6 address text that is public by the rule above (no brackets, no zone id). */
export function isPublicAddress(ip) {
  if (typeof ip !== 'string' || ip.includes('%')) return false;
  const family = net.isIP(ip);
  if (family === 4) return !V4_NOT_PUBLIC.check(ip, 'ipv4');
  if (family === 6) return V6_GLOBAL.check(ip, 'ipv6') && !V6_NOT_PUBLIC.check(ip, 'ipv6');
  return false;
}

const systemLookup = async (host) => (await dns.promises.lookup(host, { all: true, order: 'verbatim' })).map(a => ({ address: a.address, family: a.family }));

// ---- C4: the download -------------------------------------------------------------------------------------------------------------------
const WHY = {
  bad_url: 'not a plain https URL (a query, a fragment or no host)',
  not_https: 'not an https URL (the start or a redirect)',
  credentials: 'a user name or password in the URL (the start or a redirect)',
  port: 'a port other than 443 (the start or a redirect)',
  too_many_redirects: `more than ${MAX_REDIRECTS} redirects`,
  lookup_failed: 'its host name does not resolve',
  private_address: 'its host resolves to an address that is not public (loopback, private, link-local, metadata, ...)',
  http_status: 'the server did not answer 200',
  content_encoding: 'the server sent it with a content coding (the bytes would not be the archive)',
  too_large: `larger than ${I.MAX_ARCHIVE_BYTES} bytes`,
  timeout: 'the server stopped sending, or the download took too long',
  offline: 'the connection failed or broke off (network, TLS or a truncated body)',
};
const failed = (error, extra = {}) => ({ ok: false, error, why: extra.status ? `${WHY[error]} (HTTP ${extra.status})` : WHY[error], ...extra });

/** Why `raw` may not be fetched (a WHY key), or null. A redirect may carry a query (release hosts sign their asset URLs). */
function urlProblem(raw, start) {
  let u;
  try { u = new URL(raw); } catch { return 'bad_url'; }
  if (u.protocol !== 'https:') return 'not_https';
  if (u.username || u.password) return 'credentials';
  if (u.port !== '') return 'port';
  if (!u.hostname) return 'bad_url';
  if (start && (u.search || u.hash || raw.includes('?') || raw.includes('#'))) return 'bad_url';
  return null;
}

/** The checked addresses of the URL's host: an IP literal as it is, a name through one lookup; every one must pass `addressOk`. */
async function addressesOf(u, o) {
  const host = u.hostname.replace(/^\[|\]$/g, '');
  const literal = net.isIP(host);
  let answers;
  if (literal) answers = [{ address: host, family: literal }];
  else {
    try { answers = await o.lookup(host); } catch { return { error: 'lookup_failed' }; }
    if (!Array.isArray(answers) || answers.length === 0) return { error: 'lookup_failed' };
  }
  const addresses = answers.map(a => ({ address: String(a?.address), family: a?.family === 6 ? 6 : 4 }));
  if (!addresses.every(a => o.addressOk(a.address))) return { error: 'private_address' };
  return { host, literal: literal !== 0, addresses };
}

/** One GET to the checked addresses only; resolves {res} or {error}, never rejects. */
function request(u, target, o, ctl) {
  return new Promise(resolve => {
    const { addresses } = target;
    const opts = {
      protocol: 'https:', hostname: target.host, port: o.connectPort ?? 443, path: u.pathname + u.search, method: 'GET', agent: false,
      setHost: false, headers: { Host: u.host, 'User-Agent': USER_AGENT, Accept: '*/*', 'Accept-Encoding': 'identity' },
      rejectUnauthorized: true, ...(o.ca ? { ca: o.ca } : {}), ...(target.literal ? {} : { servername: target.host }),
      // The checked addresses, never a second lookup (Node asks for `all` answers when it tries several in turn).
      lookup: (_h, lo, cb) => (lo?.all ? cb(null, addresses.map(a => ({ ...a }))) : cb(null, addresses[0].address, addresses[0].family)),
    };
    let req;
    try { req = https.request(opts); } catch { resolve({ error: 'bad_url' }); return; }
    ctl.req = req;
    req.on('error', () => resolve({ error: 'offline' }));
    // A redirect or a refused answer is destroyed unread: its late error is dropped here, a body's reaches readBody.
    req.on('response', res => { res.on('error', () => {}); resolve({ res }); });
    req.end();
  });
}

/** The body of a 200, held to the byte cap; the idle timer is re-armed by each chunk. */
async function readBody(res, L, ctl, arm) {
  const declared = res.headers['content-length'];
  if (declared !== undefined && !(Number(declared) <= L.maxBytes)) return failed('too_large');
  const coding = String(res.headers['content-encoding'] ?? '').trim().toLowerCase();
  if (coding !== '' && coding !== 'identity') return failed('content_encoding');
  const hash = crypto.createHash('sha256');
  const chunks = [];
  let size = 0;
  try {
    for await (const c of res) {
      size += c.length;
      if (size > L.maxBytes) return failed('too_large');
      arm();
      hash.update(c);
      chunks.push(c);
    }
  } catch { return failed(ctl.expired ? 'timeout' : 'offline'); }
  if (ctl.expired) return failed('timeout');
  if (!res.complete) return failed('offline'); // Node 24 already fails a short body in the loop ('aborted'); kept in case that changes
  return { ok: true, bytes: Buffer.concat(chunks, size), size, sha256: hash.digest('hex') };
}

/**
 * C4: GET `url` within the bounds above. Resolves {ok: true, bytes, size, sha256, redirects} or {ok: false, error, why, status?};
 * never throws. Options for tests only (the tools pass none): `lookup(host)` -> [{address, family}], `addressOk(address)` (default
 * isPublicAddress), `ca` (trusted instead of the system roots), `connectPort` (the TCP port, the URL keeping the default one), and
 * lower bounds (downloadLimits).
 */
export async function downloadArchive(url, opts = {}) {
  const L = downloadLimits(opts);
  const o = { lookup: opts.lookup ?? systemLookup, addressOk: opts.addressOk ?? isPublicAddress, ca: opts.ca, connectPort: opts.connectPort };
  const ctl = { req: null, res: null, expired: false };
  let stop;
  const stopped = new Promise(resolve => { stop = resolve; });
  const expire = () => {
    if (ctl.expired) return;
    ctl.expired = true;
    ctl.res?.destroy();
    ctl.req?.destroy();
    stop({ stopped: true });
  };
  let idle = null;
  const arm = () => { clearTimeout(idle); idle = setTimeout(expire, L.idleMs); };
  const total = setTimeout(expire, L.totalMs);
  const race = async (p) => { const r = await Promise.race([p, stopped]); return r?.stopped ? failed('timeout') : r; };
  const drop = () => { ctl.res?.destroy(); ctl.req?.destroy(); ctl.res = null; ctl.req = null; };
  try {
    const first = urlProblem(url, true);
    if (first) return failed(first);
    let u = new URL(url);
    for (let redirects = 0; ; redirects++) {
      arm();
      const target = await race(addressesOf(u, o));
      if (target.ok === false) return target;
      if (target.error) return failed(target.error);
      const got = await race(request(u, target, o, ctl));
      if (got.ok === false) return got;
      if (got.error) return failed(got.error);
      const res = got.res;
      ctl.res = res;
      const status = res.statusCode ?? 0;
      if (REDIRECTS.has(status) && typeof res.headers.location === 'string') {
        drop(); // its body never flows
        if (redirects >= L.maxRedirects) return failed('too_many_redirects');
        let next;
        try { next = new URL(res.headers.location, u).href; } catch { return failed('bad_url'); }
        const problem = urlProblem(next, false);
        if (problem) return failed(problem);
        u = new URL(next);
        continue;
      }
      if (status !== 200) { drop(); return failed('http_status', { status }); }
      const body = await race(readBody(res, L, ctl, arm));
      return body.ok ? { ...body, redirects } : body;
    }
  } finally {
    clearTimeout(idle);
    clearTimeout(total);
    drop();
  }
}

// ---- C5-C7 ------------------------------------------------------------------------------------------------------------------------------
const refused = (check, error, why) => ({ ok: false, check, error, why });
const codeOf = (e) => (typeof e?.message === 'string' ? e.message : 'bad');

/** C6: the client's reader with its default limits (never a second argument: the marketplace reads with ZIP_LIMITS). */
export function readArchive(bytes) {
  return Z.readZip(bytes);
}

/** C7 for a theme package: what the installer (themeBytes) and the app's theme store (addNow) refuse; a reason, or null. */
function themeProblem(entries, l, v) {
  const json = entries.find(e => e.name === 'theme.json' && !e.dir)?.data ?? null;
  const license = entries.find(e => e.name === 'LICENSE' && !e.dir)?.data ?? null;
  if (json === null || entries.some(e => e.dir || (e.name !== 'theme.json' && e.name !== 'LICENSE'))) {
    return ['archive', 'a theme archive holds theme.json and LICENSE only, at its root'];
  }
  let pkg;
  try { pkg = TP.parsePackage(json); } catch (e) { return ['archive', `the app refuses its theme.json (${codeOf(e)})`]; }
  const d = I.themeListingDifference(pkg, l, v);
  if (d !== null) return ['listing_mismatch', `its theme.json ${d} differs from the listing`];
  if (license !== null) {
    if (license.length > TP.MAX_LICENSE_BYTES) return ['archive', `its LICENSE is larger than ${TP.MAX_LICENSE_BYTES} bytes`];
    try { new TextDecoder('utf-8', { fatal: true }).decode(license); } catch { return ['archive', 'its LICENSE is not valid UTF-8']; }
  }
  const resolved = TP.resolvePackage(pkg);
  if (resolved.themes.length === 0) return ['archive', `the app finds no usable theme in it (${resolved.refused[0]?.reason ?? 'none declared'})`.slice(0, 200)];
  return null;
}

/** C7 for a plugin: the installer's staged checks, unpacked into a temp folder below `tmpdir` that is removed at once. */
function pluginCheck(entries, l, v, tmpdir) {
  let root;
  try { root = fs.mkdtempSync(path.join(tmpdir, 'evecyno-plugins-check-')); } catch (e) {
    return refused('C7', 'disk', `no temp folder to unpack it in (${e?.code ?? 'error'})`);
  }
  try {
    const c = SC.checkStagedPlugin(entries, root, l, v);
    return c.ok ? { ok: true, manifest: c.manifest } : refused('C7', c.error, c.why);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

/**
 * C5-C7 on downloaded `bytes` for the parsed listing `l` at version `v` (as the vendored parseCatalog gives them: the size and SHA-256
 * are the listing's). Resolves {ok: true, manifest?} or {ok: false, check, error, why}. `o.tmpdir`: the parent of the staging folder.
 */
export function checkArchiveBytes(bytes, l, v, o = {}) {
  if (bytes.length !== v.archive.size) return refused('C5', 'size_mismatch', `${bytes.length} bytes; the entry pins ${v.archive.size}`);
  if (crypto.createHash('sha256').update(bytes).digest('hex') !== v.archive.sha256) {
    return refused('C5', 'hash_mismatch', 'its SHA-256 is not the one the entry pins');
  }
  const z = readArchive(bytes);
  if (!z.ok) return refused('C6', z.reason, `the app refuses the archive (${z.reason}${z.entry === undefined ? '' : ` at entry ${z.entry}`})`);
  if (l.type === 'theme') {
    const p = themeProblem(z.entries, l, v);
    return p === null ? { ok: true } : refused('C7', p[0], p[1]);
  }
  return pluginCheck(z.entries, l, v, o.tmpdir ?? os.tmpdir());
}

/**
 * C4-C7: the archive of `l` at `v` downloaded from `url` (the entry's own URL, not the mirror) and checked. Resolves
 * {ok: true, bytes, size, sha256, manifest?} or {ok: false, check, error, why}. `o`: downloadArchive's options and `tmpdir`.
 */
export async function checkArchive(url, l, v, o = {}) {
  const d = await downloadArchive(url, o);
  if (!d.ok) return refused('C4', d.error, d.why);
  const c = checkArchiveBytes(d.bytes, l, v, o);
  return c.ok ? { ...c, bytes: d.bytes, size: d.size, sha256: d.sha256 } : c;
}
