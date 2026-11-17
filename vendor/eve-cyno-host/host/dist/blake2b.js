"use strict";
// BLAKE2b (RFC 7693), unkeyed, sequential, in pure TypeScript. Electron's BoringSSL has no BLAKE2b ("Digest method not supported"),
// and minisign hashes with it. 64-bit words are (lo, hi) pairs of uint32 in a Uint32Array: no BigInt, no allocation in the loop.
Object.defineProperty(exports, "__esModule", { value: true });
exports.blake2b = blake2b;
exports.blake2b512 = blake2b512;
const IV = [
    0xf3bcc908, 0x6a09e667, 0x84caa73b, 0xbb67ae85, 0xfe94f82b, 0x3c6ef372, 0x5f1d36f1, 0xa54ff53a,
    0xade682d1, 0x510e527f, 0x2b3e6c1f, 0x9b05688c, 0xfb41bd6b, 0x1f83d9ab, 0x137e2179, 0x5be0cd19,
]; // lo, hi of 6a09e667f3bcc908 ... 5be0cd19137e2179
const SIGMA = [
    [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15],
    [14, 10, 4, 8, 9, 15, 13, 6, 1, 12, 0, 2, 11, 7, 5, 3],
    [11, 8, 12, 0, 5, 2, 15, 13, 10, 14, 3, 6, 7, 1, 9, 4],
    [7, 9, 3, 1, 13, 12, 11, 14, 2, 6, 5, 10, 4, 0, 15, 8],
    [9, 0, 5, 7, 2, 4, 10, 15, 14, 1, 11, 12, 6, 8, 3, 13],
    [2, 12, 6, 10, 0, 11, 8, 3, 4, 13, 7, 5, 15, 14, 1, 9],
    [12, 5, 1, 15, 14, 13, 4, 10, 0, 7, 6, 3, 9, 2, 8, 11],
    [13, 11, 7, 14, 12, 1, 3, 9, 5, 0, 15, 4, 8, 6, 2, 10],
    [6, 15, 14, 9, 11, 3, 0, 8, 12, 2, 13, 7, 1, 4, 10, 5],
    [10, 2, 8, 4, 7, 6, 1, 5, 15, 11, 9, 14, 3, 12, 13, 0],
];
const v = new Uint32Array(32);
const m = new Uint32Array(32);
/** v[a] += v[b] + (x), as 64-bit pairs; xlo/xhi is the message word. */
function add3(a, b, xlo, xhi) {
    const lo1 = (v[a] + v[b]) >>> 0;
    const c1 = lo1 < v[a] ? 1 : 0;
    const hi1 = (v[a + 1] + v[b + 1] + c1) >>> 0;
    const lo2 = (lo1 + xlo) >>> 0;
    const c2 = lo2 < lo1 ? 1 : 0;
    v[a] = lo2;
    v[a + 1] = (hi1 + xhi + c2) >>> 0;
}
function add2(a, b) {
    const lo = (v[a] + v[b]) >>> 0;
    const c = lo < v[a] ? 1 : 0;
    v[a + 1] = (v[a + 1] + v[b + 1] + c) >>> 0;
    v[a] = lo;
}
/** v[d] = rotr64(v[d] ^ v[a], n) for n in {32, 24, 16, 63}. */
function xorRot(d, a, n) {
    const lo = v[d] ^ v[a], hi = v[d + 1] ^ v[a + 1];
    switch (n) {
        case 32:
            v[d] = hi;
            v[d + 1] = lo;
            break;
        case 24:
            v[d] = ((lo >>> 24) | (hi << 8)) >>> 0;
            v[d + 1] = ((hi >>> 24) | (lo << 8)) >>> 0;
            break;
        case 16:
            v[d] = ((lo >>> 16) | (hi << 16)) >>> 0;
            v[d + 1] = ((hi >>> 16) | (lo << 16)) >>> 0;
            break;
        default:
            v[d] = ((lo << 1) | (hi >>> 31)) >>> 0;
            v[d + 1] = ((hi << 1) | (lo >>> 31)) >>> 0;
            break; // rotr 63 = rotl 1
    }
}
function G(a, b, c, d, x, y) {
    add3(a, b, m[x], m[x + 1]);
    xorRot(d, a, 32);
    add2(c, d);
    xorRot(b, c, 24);
    add3(a, b, m[y], m[y + 1]);
    xorRot(d, a, 16);
    add2(c, d);
    xorRot(b, c, 63);
}
function compress(h, block, off, t, last) {
    for (let i = 0; i < 32; i++) {
        const p = off + i * 4;
        m[i] = (block[p] | (block[p + 1] << 8) | (block[p + 2] << 16) | (block[p + 3] << 24)) >>> 0;
    }
    for (let i = 0; i < 16; i++) {
        v[i] = h[i];
        v[16 + i] = IV[i];
    }
    v[24] = (v[24] ^ (t >>> 0)) >>> 0; // v12 lo: counter low word
    v[25] = (v[25] ^ Math.floor(t / 0x100000000)) >>> 0; // v12 hi
    if (last) {
        v[28] = ~v[28] >>> 0;
        v[29] = ~v[29] >>> 0;
    }
    for (let r = 0; r < 12; r++) {
        const s = SIGMA[r % 10];
        G(0, 8, 16, 24, s[0] * 2, s[1] * 2);
        G(2, 10, 18, 26, s[2] * 2, s[3] * 2);
        G(4, 12, 20, 28, s[4] * 2, s[5] * 2);
        G(6, 14, 22, 30, s[6] * 2, s[7] * 2);
        G(0, 10, 20, 30, s[8] * 2, s[9] * 2);
        G(2, 12, 22, 24, s[10] * 2, s[11] * 2);
        G(4, 14, 16, 26, s[12] * 2, s[13] * 2);
        G(6, 8, 18, 28, s[14] * 2, s[15] * 2);
    }
    for (let i = 0; i < 16; i++)
        h[i] = (h[i] ^ v[i] ^ v[16 + i]) >>> 0;
}
/** BLAKE2b with a digest of `outLen` bytes (1..64), unkeyed. Inputs stay below 2^53 bytes. */
function blake2b(data, outLen) {
    if (!Number.isInteger(outLen) || outLen < 1 || outLen > 64)
        throw new RangeError('blake2b: outLen must be 1..64');
    const h = new Uint32Array(IV);
    h[0] = (h[0] ^ (0x01010000 | outLen)) >>> 0; // parameter block: digest length, no key, fanout 1, depth 1
    const n = data.length;
    let off = 0;
    while (n - off > 128) {
        compress(h, data, off, off + 128, false);
        off += 128;
    }
    const tail = new Uint8Array(128);
    tail.set(data.subarray(off));
    compress(h, tail, 0, n, true);
    const out = Buffer.alloc(64);
    for (let i = 0; i < 16; i++)
        out.writeUInt32LE(h[i], i * 4);
    return Buffer.from(out.subarray(0, outLen));
}
function blake2b512(data) { return blake2b(data, 64); }
