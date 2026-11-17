// AR-*: the archive checks C4-C7 (tools/lib/archives.mjs). The archive bytes come from author-controlled URLs, so every bound is
// tested at its edge: the download (https only, the redirect rule, public addresses only, the byte cap, the idle and total time
// limits), the hash and size (C5), the client's zip reader with its default limits (C6: the hostile archives of the plan's threat
// table) and the staged plugin and theme checks (C7). No test reaches the network: an HTTPS server on 127.0.0.1 with a certificate
// made in the run, names resolved by a fake lookup, and the address rule opened for 127.0.0.1 only where a test needs to connect.
import { after, before, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import https from 'node:https';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { FLAG_ENCRYPTED, S_IFLNK, zerosAtExactRatio, zerosAtMostRatio, zip, zip64Extra } from './zipwrite.mjs';
import * as A from '../lib/archives.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const require = createRequire(import.meta.url);
const DIST = path.join(ROOT, 'vendor', 'eve-cyno-host', 'host', 'dist');
const I = require(path.join(DIST, 'market', 'indexformat.js'));
const Z = require(path.join(DIST, 'market', 'zipread.js'));
const TP = require(path.join(DIST, 'themes', 'package.js'));

const P = I.MARKET_URL_PREFIX;
const MAX = I.MAX_ARCHIVE_BYTES;
const MIB = 1_048_576;
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');

// ---- fixtures -------------------------------------------------------------------------------------------------------------------------
const PERMS = { characters: 'selected', network: ['https://api.example.com'] };
const manifest = (over = {}) => ({
  id: 'dev.example.intel', name: 'Intel Board', author: 'Example Author', version: '1.1.0', engines: { 'eve-cyno-api': '^1.20.0' },
  esiCompatibilityDate: '2026-08-18', main: 'index.html', permissions: PERMS, ...over,
});
const pluginZip = (m = manifest(), extra = []) => zip([
  { name: 'plugin.json', data: JSON.stringify(m) }, { name: 'index.html', data: '<!doctype html><title>Intel</title>' }, ...extra,
]);
const themePkg = (over = {}, roles = {}) => ({
  schema: 1, id: 'dev.example.dusk', name: 'Dusk Themes', author: 'Example Author', version: '2.0.0',
  themes: [{ id: 'day', name: 'Day', scheme: 'light', roles }], ...over,
});
const themeZip = (t = themePkg(), license, extra = []) => zip([
  // LICENSE stored: a long repeated text deflates past the reader's 100:1 ratio
  { name: 'theme.json', data: JSON.stringify(t) }, ...(license === undefined ? [] : [{ name: 'LICENSE', data: license, method: 0 }]), ...extra,
]);

/** The listing and version the app would hold for `bytes`, parsed by the vendored catalog parser as the tools build them. */
function listed(bytes, o = {}) {
  const type = o.type ?? 'plugin';
  const v = {
    version: o.version ?? (type === 'theme' ? '2.0.0' : '1.1.0'), released: '2026-12-01', changes: '',
    archive: { url: `${P}archives/${sha(bytes)}.zip`, sha256: o.sha256 ?? sha(bytes), size: o.size ?? bytes.length },
  };
  if (type === 'plugin') Object.assign(v, { engines: '^1.20.0', permissions: o.permissions ?? PERMS });
  const raw = {
    id: type === 'theme' ? 'dev.example.dusk' : 'dev.example.intel', type, name: type === 'theme' ? 'Dusk Themes' : 'Intel Board',
    author: o.author ?? 'Example Author', summary: 'A test listing', description: '', categories: [type === 'theme' ? 'themes' : 'intel'],
    source: null, versions: [v],
  };
  const cat = Buffer.from(JSON.stringify({ schema: 1, generated: '2026-12-01T00:00:00Z', plugins: [raw], revoked: [] }));
  const c = I.parseCatalog(cat, { generated: '2026-12-01T00:00:00Z', catalog: { sha256: sha(cat), size: cat.length } }, { prefix: P });
  assert.equal(c.plugins.length, 1, 'the test listing parses');
  return { l: c.plugins[0], v: c.plugins[0].versions[0] };
}
/** checkArchiveBytes with the listing built from the bytes themselves (C5 passes), into a temp folder this test owns. */
function checkOwn(bytes, o = {}) {
  const { l, v } = listed(bytes, o);
  return A.checkArchiveBytes(bytes, l, v, { tmpdir: TMP });
}

// ---- a self-signed certificate made in the run (DER by hand: no openssl, no key file) ---------------------------------------------------
function der(tag, ...parts) {
  const body = Buffer.concat(parts), n = body.length;
  const len = n < 0x80 ? [n] : n < 0x100 ? [0x81, n] : [0x82, n >> 8, n & 0xff];
  return Buffer.concat([Buffer.from([tag, ...len]), body]);
}
const seq = (...p) => der(0x30, ...p);
function oid(s) {
  const [a, b, ...rest] = s.split('.').map(Number);
  const out = [40 * a + b];
  for (const n of rest) {
    const enc = [n & 0x7f];
    for (let x = n >>> 7; x > 0; x >>>= 7) enc.unshift((x & 0x7f) | 0x80);
    out.push(...enc);
  }
  return der(0x06, Buffer.from(out));
}
const utcTime = (d) => der(0x17, Buffer.from(`${d.toISOString().replace(/[-:T]/g, '').slice(2, 14)}Z`));
function selfSignedCert(names) {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const alg = seq(oid('1.2.840.10045.4.3.2')); // ecdsa-with-SHA256
  const name = seq(der(0x31, seq(oid('2.5.4.3'), der(0x0c, Buffer.from('eve-cyno-plugins archive test')))));
  const serial = crypto.randomBytes(8);
  serial[0] = (serial[0] & 0x7f) | 0x01;
  const now = Date.now();
  const tbs = seq(
    der(0xa0, der(0x02, Buffer.from([2]))), der(0x02, serial), alg, name,
    seq(utcTime(new Date(now - 3_600_000)), utcTime(new Date(now + 86_400_000))), name,
    publicKey.export({ type: 'spki', format: 'der' }),
    der(0xa3, seq(
      seq(oid('2.5.29.19'), der(0x01, Buffer.from([0xff])), der(0x04, seq(der(0x01, Buffer.from([0xff]))))), // basicConstraints CA
      seq(oid('2.5.29.17'), der(0x04, seq(...names.map(n => der(0x82, Buffer.from(n)))))), // subjectAltName dNSName
    )),
  );
  const cert = seq(tbs, alg, der(0x03, Buffer.concat([Buffer.from([0]), crypto.sign('sha256', tbs, privateKey)])));
  return {
    cert: `-----BEGIN CERTIFICATE-----\n${cert.toString('base64').match(/.{1,64}/g).join('\n')}\n-----END CERTIFICATE-----\n`,
    key: privateKey.export({ type: 'pkcs8', format: 'pem' }),
  };
}

// ---- the local HTTPS server and the fake name lookup ----------------------------------------------------------------------------------
let server, port, CA, TMP;
const routes = new Map(); // `${Host}${path}` -> handler
let hits = [], lookups = [];
const NAMES = { 'pub.test': ['127.0.0.1'], 'cdn.test': ['127.0.0.1'], 'priv.test': ['10.0.0.7'], 'meta.test': ['169.254.169.254'] };
const fakeLookup = async (host) => {
  lookups.push(host);
  const a = NAMES[host];
  if (!a) throw Object.assign(new Error('not found'), { code: 'ENOTFOUND' });
  return a.map(address => ({ address, family: address.includes(':') ? 6 : 4 }));
};
/** Options that reach the local server: the fake lookup, 127.0.0.1 allowed (and nothing else), the test CA, the server's port. */
const local = (over = {}) => ({ lookup: fakeLookup, addressOk: (a) => a === '127.0.0.1', ca: CA, connectPort: port, ...over });
const serve = (where, body, headers = {}) => routes.set(where, (_req, res) => { res.writeHead(200, { 'Content-Length': body.length, ...headers }); res.end(body); });
const redirect = (where, location, status = 302) => routes.set(where, (_req, res) => { res.writeHead(status, { Location: location, 'Content-Length': 0 }); res.end(); });

before(async () => {
  const t = selfSignedCert(['pub.test', 'cdn.test', 'priv.test', 'meta.test']);
  CA = t.cert;
  server = https.createServer({ key: t.key, cert: t.cert }, (req, res) => {
    hits.push(`${req.headers.host}${req.url}`);
    const h = routes.get(`${req.headers.host}${req.url}`);
    if (h) h(req, res);
    else { res.writeHead(404, { 'Content-Length': 0 }); res.end(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  port = server.address().port;
  TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'evecyno-plugins-artest-'));
});
after(() => {
  server.closeAllConnections();
  server.close();
  fs.rmSync(TMP, { recursive: true, force: true });
});
beforeEach(() => { routes.clear(); hits = []; lookups = []; });

// ---- the bounds come from the vendored client code ------------------------------------------------------------------------------------
describe('AR-limits', () => {
  test('AR-limits-defaults: the download bounds are the client constants and the plan\'s redirect rule', () => {
    const L = A.downloadLimits({});
    assert.equal(L.maxBytes, I.MAX_ARCHIVE_BYTES);
    assert.equal(L.maxBytes, 33_554_432);
    assert.equal(L.idleMs, I.ARCHIVE_IDLE_MS);
    assert.equal(L.idleMs, 60_000);
    assert.equal(L.maxRedirects, 5);
    assert.equal(L.totalMs, 600_000);
  });
  test('AR-limits-no-widening: an option can lower a bound, never raise it', () => {
    const L = A.downloadLimits({ maxBytes: MAX * 2, idleMs: 10 ** 9, totalMs: 10 ** 9, maxRedirects: 50 });
    assert.equal(L.maxBytes, MAX);
    assert.equal(L.idleMs, I.ARCHIVE_IDLE_MS);
    assert.equal(L.totalMs, 600_000);
    assert.equal(L.maxRedirects, 5);
    const low = A.downloadLimits({ maxBytes: 10, idleMs: 20, totalMs: 30, maxRedirects: 1 });
    assert.equal(low.maxBytes, 10);
    assert.equal(low.idleMs, 20);
    assert.equal(low.totalMs, 30);
    assert.equal(low.maxRedirects, 1);
  });
});

// ---- the address rule (plan 7.6) ------------------------------------------------------------------------------------------------------
describe('AR-public', () => {
  const refused = [
    '0.0.0.0', '0.255.255.255', '10.0.0.1', '10.255.255.255', '100.64.0.1', '100.127.255.255', '127.0.0.1', '127.255.255.254',
    '169.254.169.254', '169.254.0.1', '172.16.0.1', '172.31.255.255', '192.0.0.1', '192.0.0.255', '192.0.2.1', '192.88.99.1',
    '192.168.1.1', '192.168.255.255', '198.18.0.1', '198.19.255.255', '198.51.100.1', '203.0.113.1', '224.0.0.1', '239.255.255.255',
    '240.0.0.1', '255.255.255.254', '255.255.255.255',
    '::', '::1', '::ffff:8.8.8.8', '::ffff:10.0.0.1', '::ffff:808:808', '::8.8.8.8', '64:ff9b::808:808', '64:ff9b:1::1', '100::1',
    '100:0:0:1::1', '5f00::1', 'fc00::1', 'fd12:3456::1', 'fe80::1', 'fec0::1', 'ff02::1', '1fff:ffff:ffff::1', '4000::1',
    '2001::1', '2001:0:4136:e378::1', '2001:1ff:ffff::1', '2001:db8::1', '2001:db8:ffff::1', '2002:808:808::1', '2002::1', '3fff::1',
    '3fff:fff:ffff::1',
  ];
  const accepted = [
    '1.1.1.1', '8.8.8.8', '9.255.255.255', '11.0.0.0', '100.63.255.255', '100.128.0.0', '126.255.255.255', '128.0.0.0',
    '169.253.255.255', '169.255.0.0', '172.15.255.255', '172.32.0.0', '192.0.1.0', '192.0.3.0', '192.88.98.255', '192.88.100.0',
    '192.167.255.255', '192.169.0.0', '198.17.255.255', '198.20.0.0', '198.51.99.255', '198.51.101.0', '203.0.112.255', '203.0.114.0',
    '223.255.255.255',
    '2001:200::1', '2001:4860:4860::8888', '2606:4700:4700::1111', '2003::1', '2620:4f:8000::1', '3ffe::1', '3fff:1000::1',
    '2001:db7:ffff::1', '2001:db9::1', '2001:ffff::1', '2003:ffff::1',
  ];
  test('AR-public-refused: every block the plan lists is not public', () => {
    for (const a of refused) assert.equal(A.isPublicAddress(a), false, a);
  });
  test('AR-public-accepted: the address just outside each block is public', () => {
    for (const a of accepted) assert.equal(A.isPublicAddress(a), true, a);
  });
  test('AR-public-not-an-address: names, brackets, zone ids and non-strings are refused', () => {
    for (const a of ['example.com', '', '[::1]', '[2001:4860:4860::8888]', 'fe80::1%eth0', '2001:4860:4860::8888%1', ' 8.8.8.8', null, 8]) {
      assert.equal(A.isPublicAddress(a), false, String(a));
    }
  });
});

// ---- C4: the download -----------------------------------------------------------------------------------------------------------------
describe('C4 download', () => {
  test('AR-url-refused: only a plain https URL on the default port starts a download (nothing is looked up)', async () => {
    const cases = [
      ['http://pub.test/a.zip', 'not_https'], ['ftp://pub.test/a.zip', 'not_https'], ['file:///etc/passwd', 'not_https'],
      ['https://user:pass@pub.test/a.zip', 'credentials'], ['https://user@pub.test/a.zip', 'credentials'],
      ['https://pub.test:8443/a.zip', 'port'], ['https://pub.test/a.zip?x=1', 'bad_url'], ['https://pub.test/a.zip#f', 'bad_url'],
      ['not a url', 'bad_url'],
    ];
    for (const [url, error] of cases) {
      const r = await A.downloadArchive(url, local());
      assert.equal(r.ok, false, url);
      assert.equal(r.error, error, url);
    }
    assert.equal(lookups.length, 0);
    assert.equal(hits.length, 0);
  });

  test('AR-download-ok: bytes, size and SHA-256 of a plain answer; the host is looked up once and the URL path is sent', async () => {
    const body = pluginZip();
    serve('pub.test/releases/intel-1.1.0.zip', body);
    const r = await A.downloadArchive('https://pub.test/releases/intel-1.1.0.zip', local());
    assert.equal(r.ok, true, r.why);
    assert.equal(r.size, body.length);
    assert.equal(r.sha256, sha(body));
    assert.equal(r.bytes.equals(body), true);
    assert.equal(r.redirects, 0);
    assert.deepEqual(lookups, ['pub.test']);
    assert.deepEqual(hits, ['pub.test/releases/intel-1.1.0.zip']);
  });

  test('AR-request-headers: the GET names the URL\'s host, asks for the bytes as they are and sends no credential', async () => {
    let seen = null;
    routes.set('pub.test/a.zip', (req, res) => { seen = { ...req.headers }; res.writeHead(200, { 'Content-Length': 2 }); res.end('ok'); });
    const r = await A.downloadArchive('https://pub.test/a.zip', local());
    assert.equal(r.ok, true, r.why);
    assert.equal(seen.host, 'pub.test');
    assert.equal(seen['accept-encoding'], 'identity');
    assert.equal(seen['user-agent'], 'EVE-Cyno-plugins-check');
    for (const h of ['authorization', 'cookie', 'proxy-authorization']) assert.equal(seen[h], undefined, h);
  });

  test('AR-private-start: by default a name that resolves to a non-public address is refused before any connection', async () => {
    serve('pub.test/a.zip', pluginZip());
    for (const host of ['pub.test', 'priv.test', 'meta.test']) {
      const r = await A.downloadArchive(`https://${host}/a.zip`, { lookup: fakeLookup, ca: CA, connectPort: port });
      assert.equal(r.ok, false, host);
      assert.equal(r.error, 'private_address', host);
    }
    assert.equal(hits.length, 0);
  });

  test('AR-private-literal: an IP literal is checked as it is, without a lookup', async () => {
    for (const url of ['https://127.0.0.1/a.zip', 'https://[::1]/a.zip', 'https://169.254.169.254/latest/meta-data', 'https://[::ffff:7f00:1]/a.zip', 'https://10.1.2.3/a.zip']) {
      const r = await A.downloadArchive(url, { lookup: fakeLookup, ca: CA, connectPort: port });
      assert.equal(r.ok, false, url);
      assert.equal(r.error, 'private_address', url);
    }
    assert.equal(lookups.length, 0);
    assert.equal(hits.length, 0);
  });

  test('AR-private-mixed: one non-public answer among public ones refuses the host', async () => {
    const lookup = async () => [{ address: '8.8.8.8', family: 4 }, { address: '10.0.0.1', family: 4 }];
    const r = await A.downloadArchive('https://pub.test/a.zip', { lookup, ca: CA, connectPort: port });
    assert.equal(r.ok, false);
    assert.equal(r.error, 'private_address');
  });

  test('AR-lookup-failed: no answer or a failed lookup refuses', async () => {
    for (const lookup of [async () => [], async () => { throw new Error('ENOTFOUND'); }, async () => null]) {
      const r = await A.downloadArchive('https://pub.test/a.zip', local({ lookup }));
      assert.equal(r.ok, false);
      assert.equal(r.error, 'lookup_failed');
    }
    const r = await A.downloadArchive('https://nowhere.test/a.zip', local());
    assert.equal(r.error, 'lookup_failed');
  });

  test('AR-redirect-followed: 301, 302, 303, 307 and 308 to another https origin, a query on the hop allowed', async () => {
    const body = pluginZip();
    serve('cdn.test/asset/1?sig=abc&exp=9', body);
    for (const status of [301, 302, 303, 307, 308]) {
      redirect('pub.test/a.zip', 'https://cdn.test/asset/1?sig=abc&exp=9', status);
      const r = await A.downloadArchive('https://pub.test/a.zip', local());
      assert.equal(r.ok, true, `${status} ${r.why}`);
      assert.equal(r.sha256, sha(body));
      assert.equal(r.redirects, 1);
    }
  });

  test('AR-redirect-relative: a relative Location resolves against the current URL', async () => {
    const body = pluginZip();
    serve('pub.test/files/final.zip', body);
    redirect('pub.test/files/start.zip', 'final.zip');
    const r = await A.downloadArchive('https://pub.test/files/start.zip', local());
    assert.equal(r.ok, true, r.why);
    assert.equal(r.size, body.length);
  });

  test('AR-redirect-five: five redirects pass, the sixth is refused', async () => {
    const body = pluginZip();
    serve('pub.test/final', body);
    const chain = (n) => {
      for (let i = 0; i < n; i++) redirect(`pub.test/r${i}`, i === n - 1 ? 'https://pub.test/final' : `https://pub.test/r${i + 1}`);
    };
    chain(5);
    const five = await A.downloadArchive('https://pub.test/r0', local());
    assert.equal(five.ok, true, five.why);
    assert.equal(five.redirects, 5);
    routes.clear();
    serve('pub.test/final', body);
    chain(6);
    hits = [];
    const six = await A.downloadArchive('https://pub.test/r0', local());
    assert.equal(six.ok, false);
    assert.equal(six.error, 'too_many_redirects');
    assert.equal(hits.includes('pub.test/final'), false);
  });

  test('AR-redirect-http: a redirect to http (or any other scheme) is refused and never followed', async () => {
    for (const loc of ['http://pub.test/a.zip', 'http://cdn.test/asset', 'ftp://cdn.test/a.zip', 'data:application/zip;base64,UEsFBg==']) {
      redirect('pub.test/a.zip', loc);
      lookups = [];
      const r = await A.downloadArchive('https://pub.test/a.zip', local());
      assert.equal(r.ok, false, loc);
      assert.equal(r.error, 'not_https', loc);
      assert.deepEqual(lookups, ['pub.test'], loc);
    }
  });

  test('AR-redirect-private: a redirect to a name or literal with a non-public address is refused before it connects', async () => {
    for (const loc of ['https://priv.test/a.zip', 'https://meta.test/latest', 'https://169.254.169.254/latest', 'https://[fd00::1]/a.zip']) {
      redirect('pub.test/a.zip', loc);
      hits = [];
      const r = await A.downloadArchive('https://pub.test/a.zip', local());
      assert.equal(r.ok, false, loc);
      assert.equal(r.error, 'private_address', loc);
      assert.deepEqual(hits, ['pub.test/a.zip'], loc);
    }
  });

  test('AR-redirect-other-refusals: credentials, a port, a broken Location, no Location', async () => {
    const cases = [['https://u:p@cdn.test/a.zip', 'credentials'], ['https://cdn.test:8443/a.zip', 'port'], ['https://[bad/a.zip', 'bad_url']];
    for (const [loc, error] of cases) {
      redirect('pub.test/a.zip', loc);
      const r = await A.downloadArchive('https://pub.test/a.zip', local());
      assert.equal(r.ok, false, loc);
      assert.equal(r.error, error, loc);
    }
    routes.set('pub.test/a.zip', (_req, res) => { res.writeHead(302, { 'Content-Length': 0 }); res.end(); });
    const none = await A.downloadArchive('https://pub.test/a.zip', local());
    assert.equal(none.error, 'http_status');
    assert.equal(none.status, 302);
  });

  test('AR-status: any answer but 200 or a followed redirect is refused with its status', async () => {
    for (const status of [404, 500, 204, 206, 300, 304, 305]) {
      routes.set('pub.test/a.zip', (_req, res) => { res.writeHead(status, { Location: 'https://cdn.test/x' }); res.end(); });
      const r = await A.downloadArchive('https://pub.test/a.zip', local());
      assert.equal(r.ok, false, String(status));
      assert.equal(r.error, 'http_status', String(status));
      assert.equal(r.status, status);
    }
  });

  test('AR-pinned: each hop connects to the address it checked; the lookup runs once per hop', async () => {
    const body = pluginZip();
    serve('cdn.test/x', body);
    redirect('pub.test/a.zip', 'https://cdn.test/x');
    const r = await A.downloadArchive('https://pub.test/a.zip', local());
    assert.equal(r.ok, true, r.why);
    assert.deepEqual(lookups, ['pub.test', 'cdn.test']);
  });

  test('AR-content-encoding: a body sent with a content coding is refused (its bytes are not the archive)', async () => {
    serve('pub.test/a.zip', pluginZip(), { 'Content-Encoding': 'gzip' });
    const r = await A.downloadArchive('https://pub.test/a.zip', local());
    assert.equal(r.ok, false);
    assert.equal(r.error, 'content_encoding');
    serve('pub.test/b.zip', pluginZip(), { 'Content-Encoding': 'identity' });
    assert.equal((await A.downloadArchive('https://pub.test/b.zip', local())).ok, true);
  });

  test('AR-size-cap-header: a declared length over 32 MiB is refused at once', async () => {
    routes.set('pub.test/a.zip', (_req, res) => { res.writeHead(200, { 'Content-Length': MAX + 1 }); res.write(Buffer.alloc(16)); });
    const r = await A.downloadArchive('https://pub.test/a.zip', local({ idleMs: 3000 }));
    assert.equal(r.ok, false);
    assert.equal(r.error, 'too_large');
  });

  const chunked = (total) => (_req, res) => {
    res.writeHead(200, {}); // no Content-Length: chunked
    const chunk = Buffer.alloc(MIB, 7);
    let left = total;
    const pump = () => {
      while (left > 0) {
        const c = left >= MIB ? chunk : chunk.subarray(0, left);
        left -= c.length;
        if (!res.write(c)) { res.once('drain', pump); return; }
      }
      res.end();
    };
    res.on('error', () => {});
    pump();
  };
  test('AR-size-cap-stream: an undeclared body is cut off past 32 MiB; exactly 32 MiB passes', async () => {
    routes.set('pub.test/over.zip', chunked(MAX + 1));
    const over = await A.downloadArchive('https://pub.test/over.zip', local());
    assert.equal(over.ok, false);
    assert.equal(over.error, 'too_large');
    routes.set('pub.test/exact.zip', chunked(MAX));
    const exact = await A.downloadArchive('https://pub.test/exact.zip', local());
    assert.equal(exact.ok, true, exact.why);
    assert.equal(exact.size, MAX);
  });

  test('AR-size-cap-lowered: a lower cap (a tool\'s option) is honoured at its edge', async () => {
    serve('pub.test/a.zip', Buffer.alloc(1000, 1));
    assert.equal((await A.downloadArchive('https://pub.test/a.zip', local({ maxBytes: 1000 }))).ok, true);
    const r = await A.downloadArchive('https://pub.test/a.zip', local({ maxBytes: 999 }));
    assert.equal(r.error, 'too_large');
  });

  test('AR-truncated: a body that ends before its declared length is refused', async () => {
    routes.set('pub.test/a.zip', (req, res) => { res.writeHead(200, { 'Content-Length': 100 }); res.write(Buffer.alloc(50)); setTimeout(() => req.socket.destroy(), 20); });
    const r = await A.downloadArchive('https://pub.test/a.zip', local());
    assert.equal(r.ok, false);
    assert.equal(r.error, 'offline');
  });

  test('AR-idle-headers: a server that never answers ends the download after the idle time', async () => {
    routes.set('pub.test/a.zip', () => { /* never answers */ });
    const t0 = Date.now();
    const r = await A.downloadArchive('https://pub.test/a.zip', local({ idleMs: 300 }));
    assert.equal(r.ok, false);
    assert.equal(r.error, 'timeout');
    assert.ok(Date.now() - t0 < 2500);
  });

  test('AR-idle-body: a body that stops ends the download after the idle time', async () => {
    routes.set('pub.test/a.zip', (_req, res) => { res.writeHead(200, { 'Content-Length': 1000 }); res.write(Buffer.alloc(10)); });
    const r = await A.downloadArchive('https://pub.test/a.zip', local({ idleMs: 300 }));
    assert.equal(r.ok, false);
    assert.equal(r.error, 'timeout');
  });

  test('AR-idle-rearmed: a slow body that keeps making progress is not cut off by the idle time', async () => {
    routes.set('pub.test/a.zip', (_req, res) => {
      res.writeHead(200, { 'Content-Length': 8 });
      let n = 0;
      const t = setInterval(() => { res.write(Buffer.from([n])); if (++n === 8) { clearInterval(t); res.end(); } }, 100);
      res.on('close', () => clearInterval(t));
    });
    const r = await A.downloadArchive('https://pub.test/a.zip', local({ idleMs: 400 }));
    assert.equal(r.ok, true, r.why);
    assert.equal(r.size, 8);
  });

  test('AR-idle-lookup: a lookup that never answers ends the download after the idle time', async () => {
    const r = await A.downloadArchive('https://pub.test/a.zip', local({ lookup: () => new Promise(() => {}), idleMs: 300 }));
    assert.equal(r.ok, false);
    assert.equal(r.error, 'timeout');
  });

  test('AR-total: a body that trickles forever ends at the total time limit', async () => {
    routes.set('pub.test/a.zip', (_req, res) => {
      res.writeHead(200, {});
      const t = setInterval(() => res.write(Buffer.from([1])), 40);
      res.on('close', () => clearInterval(t));
    });
    const t0 = Date.now();
    const r = await A.downloadArchive('https://pub.test/a.zip', local({ idleMs: 1000, totalMs: 500 }));
    assert.equal(r.ok, false);
    assert.equal(r.error, 'timeout');
    assert.ok(Date.now() - t0 < 2500);
  });

  test('AR-tls: a certificate the client does not trust is refused (no test CA: the system roots only)', async () => {
    serve('pub.test/a.zip', pluginZip());
    const r = await A.downloadArchive('https://pub.test/a.zip', local({ ca: undefined }));
    assert.equal(r.ok, false);
    assert.equal(r.error, 'offline');
    assert.equal(hits.length, 0);
  });
});

// ---- C5: hash and size ----------------------------------------------------------------------------------------------------------------
describe('C5 hash and size', () => {
  test('AR-hash-mismatch: other bytes than the entry pins are refused (an archive swapped after review)', () => {
    const good = pluginZip(), swapped = pluginZip(manifest({ name: 'Intel Board' }), [{ name: 'evil.js', data: 'x' }]);
    const { l, v } = listed(good);
    const same = Buffer.from(good);
    same[same.length - 30] ^= 0xff; // same length, one byte changed
    for (const bytes of [same]) {
      const r = A.checkArchiveBytes(bytes, l, v, { tmpdir: TMP });
      assert.equal(r.ok, false);
      assert.equal(r.check, 'C5');
      assert.equal(r.error, 'hash_mismatch');
    }
    const r = A.checkArchiveBytes(swapped, listed(good, { size: swapped.length }).l, listed(good, { size: swapped.length }).v, { tmpdir: TMP });
    assert.equal(r.check, 'C5');
    assert.equal(r.error, 'hash_mismatch');
  });
  test('AR-size-mismatch: a byte count other than the entry\'s is refused before the hash', () => {
    const good = pluginZip();
    for (const size of [good.length + 1, good.length - 1]) {
      const r = checkOwn(good, { size });
      assert.equal(r.ok, false);
      assert.equal(r.check, 'C5');
      assert.equal(r.error, 'size_mismatch');
    }
  });
  test('AR-hash-case: the pinned SHA-256 is compared as the lower hex the entry must hold', () => {
    const good = pluginZip();
    const { l, v } = listed(good);
    const r = A.checkArchiveBytes(good, l, { ...v, archive: { ...v.archive, sha256: v.archive.sha256.toUpperCase() } }, { tmpdir: TMP });
    assert.equal(r.check, 'C5');
  });
});

// ---- C6: the client's zip reader with its default limits (the hostile archives of the threat table) --------------------------------------
describe('C6 hostile archives', () => {
  const refusedAt = (bytes, reason) => {
    const r = checkOwn(bytes);
    assert.equal(r.ok, false, reason);
    assert.equal(r.check, 'C6', `${reason}: ${r.check} ${r.why}`);
    assert.equal(r.error, reason);
    assert.match(r.why, new RegExp(`\\(${reason}`));
  };
  /** C6 passed: the next refusal is C7's (none of these archives holds a plugin.json). */
  const passesReader = (bytes, what) => {
    const r = checkOwn(bytes);
    assert.equal(r.ok, false, what);
    assert.equal(r.check, 'C7', `${what}: ${r.check} ${r.why}`);
  };

  test('AR-zip-limits: the reader runs with the client\'s defaults', () => {
    assert.deepEqual({ ...Z.ZIP_LIMITS }, { maxEntries: 2000, maxUnpacked: 67_108_864, maxRatio: 100, maxPath: 200, maxDepth: 16 });
  });
  test('AR-zip-ratio: 100:1 passes, 101:1 is refused', () => {
    const at100 = zerosAtExactRatio(100, 1500);
    passesReader(zip([{ name: 'a.bin', data: at100.data, raw: at100.raw }]), 'ratio 100');
    const at101 = zerosAtExactRatio(101, 1500);
    refusedAt(zip([{ name: 'a.bin', data: at101.data, raw: at101.raw }]), 'ratio');
  });
  test('AR-zip-total: 64 MiB unpacked passes, 64 MiB + 1 is refused', () => {
    const half = 32 * MIB;
    const a = zerosAtMostRatio(half, 100), c = zerosAtMostRatio(half + 1, 100);
    passesReader(zip([{ name: 'a.bin', data: a.data, raw: a.raw }, { name: 'b.bin', data: a.data, raw: a.raw }]), '64 MiB');
    refusedAt(zip([{ name: 'a.bin', data: a.data, raw: a.raw }, { name: 'c.bin', data: c.data, raw: c.raw }]), 'too_large');
  });
  test('AR-zip-count: 2,000 entries pass, 2,001 are refused', () => {
    const many = (n) => zip(Array.from({ length: n }, (_, i) => ({ name: `f/${String(i).padStart(4, '0')}.txt`, data: 'x', method: 0 })));
    passesReader(many(2000), '2000 entries');
    refusedAt(many(2001), 'too_many');
  });
  test('AR-zip-lying-size: an entry that inflates past its declared size is refused', () => {
    refusedAt(zip([{ name: 'a.bin', data: Buffer.alloc(100_000), usize: 1000 }]), 'too_large');
  });
  test('AR-zip-zip64: a zip64 extra field or end locator is refused', () => {
    refusedAt(zip([{ name: 'a.bin', data: 'x', extra: zip64Extra(1, 3) }]), 'zip64');
    refusedAt(zip([{ name: 'a.bin', data: 'x' }], { zip64Locator: true }), 'zip64');
  });
  test('AR-zip-encrypted: an encrypted entry is refused', () => {
    refusedAt(zip([{ name: 'a.bin', data: 'x', flags: FLAG_ENCRYPTED }]), 'encrypted');
  });
  test('AR-zip-traversal: a parent, absolute, drive or backslash path is refused', () => {
    for (const name of ['../evil.js', 'a/../../evil.js', '/etc/evil', 'C:/evil.js', 'a\\..\\evil.js', 'a/./b.js']) {
      refusedAt(zip([{ name: 'plugin.json', data: '{}' }, { name, data: 'x' }]), 'bad_name');
    }
  });
  test('AR-zip-link: a symbolic link entry is refused', () => {
    refusedAt(zip([{ name: 'plugin.json', data: '{}' }, { name: 'index.html', data: '/etc/passwd', mode: S_IFLNK | 0o777, method: 0 }]), 'link');
  });
  test('AR-zip-duplicate: two entries one folder can not tell apart are refused', () => {
    refusedAt(zip([{ name: 'a.txt', data: 'x' }, { name: 'A.txt', data: 'y' }]), 'duplicate');
  });
  test('AR-zip-crc: a wrong CRC-32 is refused', () => {
    refusedAt(zip([{ name: 'a.bin', data: 'hello', crc: 0x12345678 }]), 'crc');
  });
  test('AR-zip-not-zip: bytes that are no archive are refused', () => {
    refusedAt(Buffer.from('not an archive at all'), 'not_zip');
  });
});

// ---- C7: the staged plugin checks and the theme check ---------------------------------------------------------------------------------
describe('C7 plugin', () => {
  test('AR-plugin-ok: an archive that holds the listed plugin passes and hands back its manifest', () => {
    const r = checkOwn(pluginZip());
    assert.equal(r.ok, true, r.why);
    assert.equal(r.manifest.id, 'dev.example.intel');
    assert.equal(r.manifest.version, '1.1.0');
    assert.equal(fs.readdirSync(TMP).length, 0, 'the staging folder is removed');
  });
  test('AR-plugin-no-manifest: no plugin.json at the root (only in a folder) is refused', () => {
    const r = checkOwn(zip([{ name: 'intel/plugin.json', data: JSON.stringify(manifest()) }, { name: 'intel/index.html', data: 'x' }]));
    assert.equal(r.check, 'C7');
    assert.equal(r.error, 'archive');
    assert.match(r.why, /no plugin\.json/);
  });
  test('AR-plugin-bad-manifest: a plugin.json the app refuses is refused', () => {
    for (const data of ['{', JSON.stringify({ ...manifest(), permissions: { bogus: true } }), JSON.stringify({ ...manifest(), id: 'Not An Id' })]) {
      const r = checkOwn(zip([{ name: 'plugin.json', data }, { name: 'index.html', data: 'x' }]));
      assert.equal(r.ok, false, data.slice(0, 40));
      assert.equal(r.check, 'C7');
    }
  });
  test('AR-plugin-listing-mismatch: permissions, author, version or engines other than the entry\'s are refused', () => {
    const cases = [
      [manifest({ permissions: { ...PERMS, network: ['https://api.example.com', 'https://evil.example.net'] } }), 'permissions'],
      [manifest({ author: 'Someone Else' }), 'author'],
      [manifest({ version: '1.2.0' }), 'version'],
      [manifest({ engines: { 'eve-cyno-api': '^1.21.0' } }), 'engines'],
    ];
    for (const [m, field] of cases) {
      const r = checkOwn(pluginZip(m));
      assert.equal(r.ok, false, field);
      assert.equal(r.check, 'C7');
      assert.equal(r.error, 'listing_mismatch', field);
      assert.match(r.why, new RegExp(field));
    }
    assert.equal(fs.readdirSync(TMP).length, 0, 'every staging folder is removed');
  });
  test('AR-plugin-main-missing: the loader\'s folder check runs (a main file the archive lacks is refused)', () => {
    const r = checkOwn(zip([{ name: 'plugin.json', data: JSON.stringify(manifest({ main: 'app.html' })) }, { name: 'index.html', data: 'x' }]));
    assert.equal(r.ok, false);
    assert.equal(r.check, 'C7');
  });
});

describe('C7 theme', () => {
  const themeCheck = (bytes, o = {}) => checkOwn(bytes, { type: 'theme', ...o });
  test('AR-theme-ok: theme.json alone, or with a LICENSE of up to 64 KiB, passes', () => {
    assert.equal(themeCheck(themeZip()).ok, true);
    const r = themeCheck(themeZip(themePkg(), 'x'.repeat(TP.MAX_LICENSE_BYTES)));
    assert.equal(r.ok, true, r.why);
  });
  test('AR-theme-files: anything but theme.json and LICENSE at the root is refused', () => {
    for (const extra of [[{ name: 'main.js', data: 'x' }], [{ name: 'fonts/', data: '' }], [{ name: 'a/theme.json', data: '{}' }], [{ name: 'LICENSE/', data: '' }]]) {
      const r = themeCheck(themeZip(themePkg(), undefined, extra));
      assert.equal(r.ok, false, extra[0].name);
      assert.equal(r.check, 'C7');
      assert.match(r.why, /theme\.json and LICENSE only/);
    }
    const none = themeCheck(zip([{ name: 'LICENSE', data: 'MIT' }]));
    assert.equal(none.check, 'C7');
  });
  test('AR-theme-bad-json: a theme.json the app refuses is refused', () => {
    for (const data of ['{', JSON.stringify({ ...themePkg(), schema: 2 }), JSON.stringify({ ...themePkg(), themes: [] })]) {
      const r = themeCheck(zip([{ name: 'theme.json', data }]));
      assert.equal(r.ok, false, data.slice(0, 40));
      assert.equal(r.check, 'C7');
    }
  });
  test('AR-theme-mismatch: a theme.json whose id, version, name or author differs from the listing is refused', () => {
    for (const [over, field] of [[{ version: '2.0.1' }, 'version'], [{ name: 'Other' }, 'name'], [{ author: 'Someone Else' }, 'author']]) {
      const r = themeCheck(themeZip(themePkg(over)));
      assert.equal(r.ok, false, field);
      assert.equal(r.error, 'listing_mismatch', field);
    }
  });
  test('AR-theme-license-cap: a LICENSE over 64 KiB is refused (the app\'s theme store cap)', () => {
    const r = themeCheck(themeZip(themePkg(), 'x'.repeat(TP.MAX_LICENSE_BYTES + 1)));
    assert.equal(r.ok, false);
    assert.equal(r.check, 'C7');
    assert.match(r.why, /LICENSE/);
  });
  test('AR-theme-license-utf8: a LICENSE that is not UTF-8 is refused', () => {
    const r = themeCheck(themeZip(themePkg(), Buffer.from([0x4d, 0x49, 0x54, 0xff, 0xfe])));
    assert.equal(r.ok, false);
    assert.match(r.why, /LICENSE/);
  });
  test('AR-theme-unusable: a package with no theme the app can use is refused', () => {
    const r = themeCheck(themeZip(themePkg({}, { '--c-fg': '#eff1f5', '--c-void': '#eff1f5' })));
    assert.equal(r.ok, false);
    assert.equal(r.check, 'C7');
    assert.match(r.why, /no usable theme/);
  });
});

// ---- C4-C7 end to end -----------------------------------------------------------------------------------------------------------------
describe('checkArchive', () => {
  test('AR-e2e-ok: downloaded from the author\'s URL and checked against the listing', async () => {
    const body = pluginZip();
    serve('pub.test/intel.zip', body);
    const { l, v } = listed(body);
    const r = await A.checkArchive('https://pub.test/intel.zip', l, v, { ...local(), tmpdir: TMP });
    assert.equal(r.ok, true, r.why);
    assert.equal(r.sha256, sha(body));
    assert.equal(r.size, body.length);
    assert.equal(r.bytes.equals(body), true);
    assert.equal(r.manifest.id, 'dev.example.intel');
  });
  test('AR-e2e-swapped: the author\'s file changed after the review is refused at C5', async () => {
    const body = pluginZip();
    const { l, v } = listed(body);
    const swapped = Buffer.from(body);
    swapped[10] ^= 0x01;
    serve('pub.test/intel.zip', swapped);
    const r = await A.checkArchive('https://pub.test/intel.zip', l, v, { ...local(), tmpdir: TMP });
    assert.equal(r.check, 'C5');
    assert.equal(r.error, 'hash_mismatch');
  });
  test('AR-e2e-bomb: a zip bomb served as pinned is refused at C6', async () => {
    const x = zerosAtExactRatio(101, 1500);
    const body = zip([{ name: 'plugin.json', data: JSON.stringify(manifest()) }, { name: 'index.html', data: x.data, raw: x.raw }]);
    serve('pub.test/intel.zip', body);
    const { l, v } = listed(body);
    const r = await A.checkArchive('https://pub.test/intel.zip', l, v, { ...local(), tmpdir: TMP });
    assert.equal(r.check, 'C6');
    assert.equal(r.error, 'ratio');
  });
  test('AR-e2e-download-failed: a failed download is refused at C4 with its reason', async () => {
    const { l, v } = listed(pluginZip());
    const r = await A.checkArchive('http://pub.test/intel.zip', l, v, { ...local(), tmpdir: TMP });
    assert.equal(r.check, 'C4');
    assert.equal(r.error, 'not_https');
    assert.equal(typeof r.why, 'string');
  });
});
