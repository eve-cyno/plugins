"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.StreamFailure = exports.busyPolicy = void 0;
exports.fetchBounded = fetchBounded;
exports.downloadVerified = downloadVerified;
exports.requestStream = requestStream;
// The host's HTTPS GET for updates and the marketplace (R3): Node `https` in main, HTTPS only, no query string, no cookies, no
// credentials, a fixed User-Agent, at most 3 redirects (HTTPS only, same origin only), a byte cap and a time limit. Nothing here throws: every failure
// is a typed result. Test builds may also use http://127.0.0.1 (allowLoopbackHttp) and trust one extra CA (testCa); a product build
// ignores both options.
const http = __importStar(require("node:http"));
const https = __importStar(require("node:https"));
const fs = __importStar(require("node:fs"));
const crypto = __importStar(require("node:crypto"));
const zlib = __importStar(require("node:zlib"));
const buildinfo_1 = require("./buildinfo");
const localaddr_1 = require("./ai/localaddr");
const MAX_REDIRECTS = 3;
/**
 * Windows: how often a `.part` rename or removal is tried while a scanner holds the file (EBUSY, EPERM, EACCES). The waits double from
 * 50 ms up to `maxWaitMs`: 10 tries wait about 9 s in all, long enough for a virus scan of a fresh installer (review n4), still bounded.
 * Tests may change it.
 */
exports.busyPolicy = { win32: process.platform === 'win32', tries: 10, maxWaitMs: 2000, sleep: (ms) => new Promise(r => setTimeout(r, ms)) };
/** The URL when it is allowed: https, or (test builds, on request) http to the loopback host; never a query, fragment or credentials. */
function parseUrl(raw, allowLoopbackHttp) {
    let u;
    try {
        u = new URL(raw);
    }
    catch {
        return null;
    }
    if (u.search || u.hash || u.username || u.password || !u.hostname)
        return null;
    if (u.protocol === 'https:')
        return u;
    if (u.protocol === 'http:' && buildinfo_1.TEST_BUILD && allowLoopbackHttp && (u.hostname === '127.0.0.1' || u.hostname === 'localhost' || u.hostname === '[::1]'))
        return u;
    return null;
}
const killAll = (ctl) => { for (const r of ctl.reqs)
    r.destroy(); };
/**
 * Sends the GET and follows redirects (HTTPS only, same origin, at most 3); resolves with the first non-redirect response.
 * A redirect response is destroyed at once, with its request: its body never flows, so it needs neither bound.
 */
function open(start, o, ctl) {
    return new Promise(resolve => {
        let settled = false;
        const done = (r) => { if (!settled) {
            settled = true;
            if (!r.ok)
                killAll(ctl);
            resolve(r);
        } };
        const hop = (raw, n, origin) => {
            if (o.signal?.aborted)
                return done({ ok: false, error: 'offline' }); // aborted before (or between) the hops
            const u = parseUrl(raw, !!o.allowLoopbackHttp);
            if (!u || (origin !== null && u.origin !== origin))
                return done({ ok: false, error: 'bad_url' });
            if (o.query !== undefined && !/^\?[A-Za-z0-9=&._-]{1,64}$/.test(o.query))
                return done({ ok: false, error: 'bad_url' });
            const headers = { 'User-Agent': o.userAgent, Accept: '*/*' };
            if (o.gzip)
                headers['Accept-Encoding'] = 'gzip';
            if (o.etag)
                headers['If-None-Match'] = o.etag;
            const opts = { protocol: u.protocol, hostname: u.hostname.replace(/^\[|\]$/g, ''), port: u.port || undefined, path: u.pathname + (o.query ?? ''), method: 'GET', agent: false, headers, rejectUnauthorized: true };
            if (u.protocol === 'https:' && buildinfo_1.TEST_BUILD && o.testCa)
                opts.ca = o.testCa;
            let req;
            try {
                req = (u.protocol === 'https:' ? https : http).request(opts);
            }
            catch {
                return done({ ok: false, error: 'bad_url' });
            }
            ctl.reqs.push(req);
            req.on('error', () => done({ ok: false, error: ctl.timedOut ? 'timeout' : 'offline' }));
            req.on('response', res => {
                const s = res.statusCode ?? 0;
                if (s >= 300 && s < 400 && s !== 304) {
                    res.destroy();
                    req.destroy();
                    const loc = res.headers.location;
                    if (n >= MAX_REDIRECTS || !loc)
                        return done({ ok: false, error: 'http_status', status: s });
                    let next;
                    try {
                        next = new URL(loc, u).toString();
                    }
                    catch {
                        return done({ ok: false, error: 'bad_url' });
                    }
                    return hop(next, n + 1, u.origin);
                }
                done({ ok: true, res });
            });
            req.end();
        };
        hop(start, 0, null);
    });
}
/**
 * GET with a byte cap and one overall time limit (redirect hops included). A 304 answers only when `etag` was sent. `signal` ends the call at
 * once (its requests and sockets go) with `offline`. `retryAfter: true` (the `market.hubs` pack only) hands back the `Retry-After` header of a non-2xx
 * answer as data on the failure; nothing else of a failed answer is read, and the `Retry-After` of a 200 or a 304 never (Assets M4 F1c round 3: the Cloudflare edge
 * drops it there). `date: true` (the `market.hubs` pack only, F1c round 3) hands back the `Date` header of a 200 or a 304 as data: the server's clock at the answer,
 * from which the host counts the overrun past the held table's `nextBuildAt`. `gzip` (see Common): a gzip body that cannot be inflated, or another
 * `Content-Encoding`, is `offline` (the body could not be read as sent).
 */
async function fetchBounded(url, o) {
    const ctl = { reqs: [], timedOut: false };
    if (o.signal?.aborted)
        return { ok: false, error: 'offline' };
    const onAbort = () => killAll(ctl);
    o.signal?.addEventListener('abort', onAbort, { once: true });
    const timer = setTimeout(() => { ctl.timedOut = true; killAll(ctl); }, o.timeoutMs);
    try {
        const r = await open(url, o, ctl);
        if (!r.ok)
            return r;
        const res = r.res, status = res.statusCode ?? 0;
        const dh = res.headers.date;
        const date = o.date && typeof dh === 'string' ? { date: dh } : {}; // only when asked: every other caller gets the result it got before
        if (status === 304 && o.etag) {
            killAll(ctl);
            return { ok: true, status: 304, ...date };
        }
        if (status !== 200) {
            killAll(ctl);
            const ra = res.headers['retry-after'];
            return o.retryAfter && typeof ra === 'string' ? { ok: false, error: 'http_status', status, retryAfter: ra } : { ok: false, error: 'http_status', status };
        }
        const len = Number(res.headers['content-length']);
        if (Number.isFinite(len) && len > o.maxBytes) {
            killAll(ctl);
            return { ok: false, error: 'too_large' };
        }
        const etag = typeof res.headers.etag === 'string' ? res.headers.etag : null;
        const enc = o.gzip ? String(res.headers['content-encoding'] ?? '').trim().toLowerCase() : '';
        if (enc !== '' && enc !== 'identity' && enc !== 'gzip') {
            killAll(ctl);
            return { ok: false, error: 'offline' };
        }
        const inflate = enc === 'gzip' ? zlib.createGunzip() : null;
        // The inflated body is held to the gzip cap; an identity body of an opted-in call to both caps; any other call to its own maxBytes, as before.
        const outMax = inflate && o.gzip ? o.gzip.maxBytes : o.gzip ? Math.min(o.gzip.maxBytes, o.maxBytes) : o.maxBytes;
        return await new Promise(resolve => {
            const chunks = [];
            let total = 0, out = 0, settled = false, ended = false;
            const finish = (x) => {
                if (settled)
                    return;
                settled = true;
                if (!x.ok) {
                    killAll(ctl);
                    inflate?.destroy();
                }
                resolve(x);
            };
            // The decoded body (the wire body when nothing is inflated), held to its cap.
            const keep = (c) => {
                out += c.length;
                if (out > outMax) {
                    finish({ ok: false, error: 'too_large' });
                    return;
                }
                chunks.push(c);
            };
            const done = () => finish({ ok: true, status: 200, body: Buffer.concat(chunks), etag, ...date });
            if (inflate) {
                inflate.on('data', (c) => { if (!settled)
                    keep(c); });
                inflate.on('end', done);
                inflate.on('error', () => finish({ ok: false, error: 'offline' }));
            }
            res.on('data', (c) => {
                if (settled)
                    return;
                total += c.length;
                if (total > o.maxBytes) {
                    finish({ ok: false, error: 'too_large' });
                    return;
                }
                if (inflate)
                    inflate.write(c);
                else
                    keep(c);
            });
            res.on('end', () => { ended = true; if (settled)
                return; if (inflate)
                inflate.end();
            else
                done(); });
            const broken = () => { if (!settled && !ended)
                finish({ ok: false, error: ctl.timedOut ? 'timeout' : 'offline' }); };
            res.on('error', broken);
            res.on('close', broken);
        });
    }
    catch {
        killAll(ctl);
        return { ok: false, error: 'offline' };
    }
    finally {
        clearTimeout(timer);
        o.signal?.removeEventListener('abort', onAbort);
    }
}
const BUSY = new Set(['EBUSY', 'EPERM', 'EACCES']);
/** Runs a `.part` rename or removal, retried with a bounded back-off on Windows while a scanner holds the file (reviews m4, n4). */
async function busyRetry(op) {
    for (let i = 1;; i++) {
        try {
            return await op();
        }
        catch (e) {
            if (!exports.busyPolicy.win32 || i >= exports.busyPolicy.tries || !BUSY.has(String(e?.code)))
                throw e;
            await exports.busyPolicy.sleep(Math.min(50 * 2 ** (i - 1), exports.busyPolicy.maxWaitMs));
        }
    }
}
/**
 * Streams the URL to `dest + '.part'` (created with 'wx', written asynchronously and completely, fsynced), checks the size and the
 * SHA-256 of the bytes received and the size on disk, then renames it to `dest`. A failure removes the `.part`. `signal` aborts the
 * transfer (the updater stops): the sockets go at once and the call answers `offline` with the `.part` removed.
 */
async function downloadVerified(url, dest, o) {
    const part = dest + '.part';
    const ctl = { reqs: [], timedOut: false };
    let timer;
    const arm = () => { clearTimeout(timer); timer = setTimeout(() => { ctl.timedOut = true; killAll(ctl); }, o.idleTimeoutMs); };
    let fh = null;
    const onAbort = () => killAll(ctl);
    const fail = async (error) => {
        clearTimeout(timer);
        killAll(ctl);
        o.signal?.removeEventListener('abort', onAbort);
        if (fh) {
            try {
                await fh.close();
            }
            catch { /* closed */ }
            fh = null;
        }
        try {
            await busyRetry(() => fs.promises.rm(part, { force: true }));
        }
        catch { /* best effort: the next start removes a .part */ }
        return { ok: false, error };
    };
    try {
        if (o.signal?.aborted)
            return await fail('offline');
        o.signal?.addEventListener('abort', onAbort, { once: true });
        arm();
        const r = await open(url, { userAgent: o.userAgent, allowLoopbackHttp: o.allowLoopbackHttp, signal: o.signal }, ctl);
        if (!r.ok)
            return await fail(r.error);
        const res = r.res;
        if (res.statusCode !== 200)
            return await fail('http_status');
        const len = Number(res.headers['content-length']);
        if (Number.isFinite(len) && len !== o.size)
            return await fail('size_mismatch');
        try {
            await busyRetry(() => fs.promises.rm(part, { force: true }));
            fh = await fs.promises.open(part, 'wx', 0o600);
        }
        catch {
            return await fail('disk');
        }
        const hash = crypto.createHash('sha256');
        let received = 0;
        try {
            // for await pauses the response while a chunk is written: the main thread never blocks and memory stays bounded.
            for await (const c of res) {
                received += c.length;
                if (received > o.size)
                    return await fail('size_mismatch');
                arm();
                for (let off = 0; off < c.length;) {
                    let n = 0;
                    try {
                        n = (await fh.write(c, off, c.length - off)).bytesWritten;
                    }
                    catch {
                        return await fail('disk');
                    }
                    if (!(n > 0))
                        return await fail('disk');
                    off += n;
                }
                hash.update(c);
                try {
                    o.onProgress?.(received);
                }
                catch { /* a progress callback must not break the download */ }
                if (o.signal?.aborted)
                    return await fail('offline');
            }
        }
        catch {
            return await fail(ctl.timedOut ? 'timeout' : 'offline');
        }
        clearTimeout(timer);
        if (o.signal?.aborted)
            return await fail('offline');
        if (received !== o.size)
            return await fail('size_mismatch');
        if (hash.digest('hex') !== o.sha256.toLowerCase())
            return await fail('hash_mismatch');
        try {
            await fh.sync();
            if ((await fh.stat()).size !== o.size)
                return await fail('disk');
            await fh.close();
            fh = null;
            if (o.signal?.aborted)
                return await fail('offline');
            await busyRetry(() => fs.promises.rename(part, dest));
        }
        catch {
            return await fail('disk');
        }
        o.signal?.removeEventListener('abort', onAbort);
        return { ok: true };
    }
    catch {
        return await fail('offline');
    }
}
/** What a streamed body throws when it ends early; the code is the whole message, so no key or header value can leak through it. */
class StreamFailure extends Error {
    code;
    constructor(code) {
        super(code);
        this.code = code;
        this.name = 'StreamFailure';
    }
}
exports.StreamFailure = StreamFailure;
const ERROR_TEXT_BYTES = 4096;
/**
 * An HTTP(S) request for the AI providers (D11): GET or POST with caller headers and body, the response body streamed. `https:` goes to any
 * host; `http:` only to a local address (every DNS answer local) or when `trusted` is set, a product rule the user grants per endpoint. The
 * host is looked up once and the socket connects only to the checked addresses (no second lookup; a fallback between families is among them), while the TLS name stays the host name. No
 * redirects (any 3xx is `http_status`), no query, fragment or credentials in the URL. `firstByteMs` bounds lookup plus headers, `idleMs`
 * the wait for each body chunk, `totalMs` the whole call, `maxBytes` the body. `signal` ends the call (`aborted`). Nothing here throws, and
 * no error text carries a header value (a non-2xx failure hands on one header as data: `retry-after`, nothing else of the response): the body does throw, but only a StreamFailure.
 */
async function requestStream(r) {
    const ctl = { reqs: [], timedOut: false };
    const code = () => r.signal?.aborted ? 'aborted' : ctl.timedOut ? 'timeout' : 'offline'; // what a broken connection means now
    if (r.signal?.aborted)
        return { ok: false, error: 'aborted' };
    let u;
    try {
        u = new URL(r.url);
    }
    catch {
        return { ok: false, error: 'bad_url' };
    }
    if (u.search || u.hash || u.username || u.password || !u.hostname || (u.protocol !== 'https:' && u.protocol !== 'http:'))
        return { ok: false, error: 'bad_url' };
    if (r.query !== undefined && !/^\?[A-Za-z0-9=&._-]{1,64}$/.test(r.query))
        return { ok: false, error: 'bad_url' };
    let idle, first, total;
    const timedOut = new Promise(resolve => { ctl.onTimeout = () => resolve('timeout'); });
    const stop = () => { clearTimeout(idle); clearTimeout(first); clearTimeout(total); r.signal?.removeEventListener('abort', onAbort); };
    const kill = () => { stop(); killAll(ctl); };
    const onAbort = () => kill();
    const expire = () => { ctl.timedOut = true; ctl.onTimeout?.(); killAll(ctl); };
    r.signal?.addEventListener('abort', onAbort, { once: true });
    first = setTimeout(expire, r.firstByteMs);
    total = setTimeout(expire, r.totalMs);
    const fail = (error, extra) => { kill(); return { ok: false, error, ...extra }; };
    try {
        const host = await Promise.race([(0, localaddr_1.resolveHost)(u.hostname, r.lookup), timedOut]);
        if (host === 'timeout')
            return fail('timeout');
        if (r.signal?.aborted)
            return fail('aborted');
        if (!host.ok)
            return fail(host.error);
        if (u.protocol === 'http:' && !host.local && !r.trusted)
            return fail('not_local');
        // The host owns the framing and identity headers: a caller cannot change Host, the length, the transfer coding, the connection or the User-Agent.
        const own = new Set(['host', 'content-length', 'transfer-encoding', 'connection', 'user-agent']);
        const headers = { Accept: '*/*' };
        for (const [k, v] of Object.entries(r.headers ?? {}))
            if (!own.has(k.toLowerCase()))
                headers[k] = v;
        headers['User-Agent'] = r.userAgent;
        if (r.body !== undefined)
            headers['Content-Length'] = String(Buffer.byteLength(r.body));
        const { addresses } = host;
        const opts = {
            protocol: u.protocol, hostname: u.hostname.replace(/^\[|\]$/g, ''), port: u.port || undefined, path: u.pathname + (r.query ?? ''), method: r.method, agent: false, headers, rejectUnauthorized: true,
            // The checked addresses, not a second lookup. Node 20+ asks for `all` answers (and tries them in turn: ::1 refused, then 127.0.0.1), older versions for one.
            lookup: ((_h, o, cb) => { if (o?.all)
                cb(null, addresses.map(a => ({ ...a })));
            else
                cb(null, addresses[0].address, addresses[0].family); }),
        };
        if (u.protocol === 'https:' && buildinfo_1.TEST_BUILD && r.testCa)
            opts.ca = r.testCa;
        const res = await new Promise(resolve => {
            let req;
            try {
                req = (u.protocol === 'https:' ? https : http).request(opts);
            }
            catch {
                return resolve('bad_url');
            }
            ctl.reqs.push(req);
            req.on('error', () => resolve(code()));
            req.on('response', resolve);
            req.end(r.body);
        });
        if (typeof res === 'string')
            return fail(res);
        clearTimeout(first);
        const status = res.statusCode ?? 0;
        const hdrs = {};
        for (const [k, v] of Object.entries(res.headers))
            if (v !== undefined)
                hdrs[k] = Array.isArray(v) ? v.join(', ') : v;
        const seen = hdrs['retry-after'] !== undefined ? { 'retry-after': hdrs['retry-after'] } : {}; // all a failure hands on
        // The wait for the next chunk is the only thing the idle timer measures: a slow consumer pauses the response and is not a stalled server.
        const it = res[Symbol.asyncIterator]();
        const next = async () => {
            clearTimeout(idle);
            idle = setTimeout(expire, r.idleMs);
            try {
                return await it.next();
            }
            finally {
                clearTimeout(idle);
            }
        };
        if (status < 200 || status >= 300) {
            if (status >= 300 && status < 400)
                return fail('http_status', { status, headers: seen });
            const parts = [];
            let n = 0;
            try {
                while (n < ERROR_TEXT_BYTES) {
                    const c = await next();
                    if (c.done)
                        break;
                    parts.push(c.value);
                    n += c.value.length;
                }
            }
            catch { /* the status is what matters; the text is what arrived */ }
            return fail('http_status', { status, headers: seen, text: Buffer.concat(parts).subarray(0, ERROR_TEXT_BYTES).toString('utf8') });
        }
        async function* body() {
            let received = 0;
            try {
                for (;;) {
                    let c;
                    try {
                        c = await next();
                    }
                    catch {
                        throw new StreamFailure(code());
                    }
                    if (c.done)
                        break;
                    received += c.value.length;
                    if (received > r.maxBytes)
                        throw new StreamFailure('too_large');
                    yield c.value;
                }
                if (r.signal?.aborted)
                    throw new StreamFailure('aborted');
            }
            finally {
                kill();
            } // the consumer stopped early, the body ended or failed: sockets and timers go
        }
        return { ok: true, status, headers: hdrs, body: body() };
    }
    catch {
        return fail(code());
    }
}
