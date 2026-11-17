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
exports.LOOKUP_MS = void 0;
exports.isLocalAddress = isLocalAddress;
exports.resolveHost = resolveHost;
exports.resolveWithin = resolveWithin;
// What counts as a local address for an AI endpoint over plain http (D11): loopback, the private ranges, Tailscale / CGNAT (100.64/10),
// IPv6 unique-local and link-local, and the IPv4-mapped forms of these. Not 169.254/16 (the cloud metadata address) and not 0.0.0.0.
// One lookup, every answer checked: a name is local only when all of its addresses are, and the caller connects to the address that
// was checked, so a second lookup cannot move it (no rebinding).
const dns = __importStar(require("node:dns"));
const net = __importStar(require("node:net"));
const LOCAL = new net.BlockList();
for (const [net4, bits] of [['127.0.0.0', 8], ['10.0.0.0', 8], ['172.16.0.0', 12], ['192.168.0.0', 16], ['100.64.0.0', 10]])
    LOCAL.addSubnet(net4, bits, 'ipv4');
for (const [net6, bits] of [['::1', 128], ['fc00::', 7], ['fe80::', 10]])
    LOCAL.addSubnet(net6, bits, 'ipv6');
/** The IPv4 text inside an IPv4-mapped IPv6 address (`::ffff:a.b.c.d` or `::ffff:xxxx:xxxx`), or null. */
function unmap(ip) {
    const m = /^(?:0{0,4}:){2,5}ffff:(.+)$/i.exec(ip);
    if (!m)
        return null;
    if (net.isIPv4(m[1]))
        return m[1];
    const h = /^([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i.exec(m[1]);
    if (!h)
        return null;
    const hi = parseInt(h[1], 16), lo = parseInt(h[2], 16);
    return `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;
}
function isLocalAddress(ip) {
    const a = ip.replace(/^\[|\]$/g, '').replace(/%.*$/, ''); // brackets and an IPv6 zone id are not part of the address
    if (net.isIPv4(a))
        return LOCAL.check(a, 'ipv4');
    if (!net.isIPv6(a))
        return false;
    const v4 = unmap(a);
    return v4 !== null ? net.isIPv4(v4) && LOCAL.check(v4, 'ipv4') : LOCAL.check(a, 'ipv6');
}
const systemLookup = async (hostname) => (await dns.promises.lookup(hostname, { all: true })).map(a => ({ address: a.address, family: a.family === 6 ? 6 : 4 }));
/**
 * Resolves the host once (every answer). `address` and `family` are the first answer; `addresses` are all of them, in order, for a
 * connection that falls back from one family to the next (`localhost` answers ::1 and 127.0.0.1); `local` is true only when every answer is
 * local. A failed or empty lookup is `offline`; an empty host name is `bad_url`.
 */
async function resolveHost(hostname, lookup = systemLookup) {
    const host = hostname.replace(/^\[|\]$/g, '');
    if (!host)
        return { ok: false, error: 'bad_url' };
    let answers;
    try {
        answers = await lookup(host);
    }
    catch {
        return { ok: false, error: 'offline' };
    }
    if (!Array.isArray(answers) || answers.length === 0)
        return { ok: false, error: 'offline' };
    return { ok: true, address: answers[0].address, family: answers[0].family, addresses: answers.map(a => ({ address: a.address, family: a.family })), local: answers.every(a => isLocalAddress(a.address)) };
}
/** How long a caller waits for the address lookup of an AI endpoint (the system resolver can hang much longer). */
exports.LOOKUP_MS = 1500;
/**
 * `resolve(hostname)` bounded by `ms` and by `signal`: null when the time ran out or the signal was aborted (the caller treats that as "not local"),
 * never a throw. The lookup itself is not cancelled (the resolver has no cancel); its late answer is dropped.
 */
async function resolveWithin(resolve, hostname, ms = exports.LOOKUP_MS, signal) {
    if (signal?.aborted)
        return null;
    let timer, onAbort;
    const stop = new Promise(done => {
        timer = setTimeout(() => done(null), ms);
        if (signal) {
            onAbort = () => done(null);
            signal.addEventListener('abort', onAbort, { once: true });
        }
    });
    try {
        return await Promise.race([resolve(hostname).catch(() => null), stop]);
    }
    finally {
        clearTimeout(timer);
        if (signal && onAbort)
            signal.removeEventListener('abort', onAbort);
    }
}
