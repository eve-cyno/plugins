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
exports.parsePublicKey = parsePublicKey;
exports.verifyMinisign = verifyMinisign;
// Minisign signature verification (https://jedisct1.github.io/minisign/) in TypeScript. Only prehashed `ED` signatures (Ed25519 over
// BLAKE2b-512 of the data) are accepted; legacy `Ed` (Ed25519 over the raw data) is refused. The trusted comment is verified with the
// global signature (Ed25519 over signature || trusted comment). Nothing here throws on untrusted input: a refusal is a typed result.
const crypto = __importStar(require("node:crypto"));
const blake2b_1 = require("./blake2b");
const errors_1 = require("./errors");
/** minisign's own bound for a trusted comment (TRUSTED_COMMENTMAXBYTES). */
const MAX_TRUSTED = 8192;
const B64 = /^[A-Za-z0-9+/]+={0,2}$/;
const strictB64 = (s, len) => {
    if (!B64.test(s))
        return null;
    const b = Buffer.from(s, 'base64');
    return b.length === len && b.toString('base64') === s ? b : null;
};
const keyIdOf = (id) => Buffer.from(id).reverse().toString('hex').toUpperCase(); // minisign shows the little-endian 64-bit id
/** A `.pub` file (comment line + base64 line) or just its base64 line. Throws coded `bad_params`. */
function parsePublicKey(text) {
    const lines = String(text).split(/\r?\n/).map(l => l.trim()).filter(l => l && !l.startsWith('untrusted comment:'));
    const raw = lines.length === 1 ? strictB64(lines[0], 42) : null;
    if (!raw || raw.toString('latin1', 0, 2) !== 'Ed')
        throw (0, errors_1.coded)('bad_params', 'not a minisign public key');
    return { keyId: keyIdOf(raw.subarray(2, 10)), publicKey: Buffer.from(raw.subarray(10, 42)) };
}
const edVerify = (msg, sig, pub) => {
    try {
        const key = crypto.createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: pub.toString('base64url') }, format: 'jwk' });
        return crypto.verify(null, msg, key, sig);
    }
    catch {
        return false;
    }
};
function verifyMinisign(data, sigText, keys) {
    try {
        if (typeof sigText !== 'string' || !Buffer.isBuffer(data))
            return { ok: false, reason: 'malformed' };
        const lines = sigText.split(/\r?\n/);
        if (lines.length < 4 || lines.slice(4).some(l => l.trim() !== ''))
            return { ok: false, reason: 'malformed' };
        if (!lines[0].startsWith('untrusted comment:') || !lines[2].startsWith('trusted comment: '))
            return { ok: false, reason: 'malformed' };
        const sigBlob = strictB64(lines[1].trim(), 74), global = strictB64(lines[3].trim(), 64);
        if (!sigBlob || !global)
            return { ok: false, reason: 'malformed' };
        const alg = sigBlob.toString('latin1', 0, 2);
        if (alg === 'Ed')
            return { ok: false, reason: 'legacy_algorithm' };
        if (alg !== 'ED')
            return { ok: false, reason: 'malformed' };
        const keyId = keyIdOf(sigBlob.subarray(2, 10)), sig = sigBlob.subarray(10, 74);
        const candidates = keys.filter(k => k.keyId === keyId && Buffer.isBuffer(k.publicKey) && k.publicKey.length === 32);
        if (candidates.length === 0)
            return { ok: false, reason: 'unknown_key' };
        const trusted = lines[2].slice('trusted comment: '.length);
        if (Buffer.byteLength(trusted, 'utf8') > MAX_TRUSTED)
            return { ok: false, reason: 'malformed' };
        const digest = (0, blake2b_1.blake2b512)(data), globalMsg = Buffer.concat([sig, Buffer.from(trusted, 'utf8')]);
        let sigOk = false;
        for (const k of candidates) {
            if (!edVerify(digest, sig, k.publicKey))
                continue;
            sigOk = true;
            if (edVerify(globalMsg, global, k.publicKey))
                return { ok: true, keyId, trusted };
        }
        return { ok: false, reason: sigOk ? 'bad_trusted_comment' : 'bad_signature' };
    }
    catch {
        return { ok: false, reason: 'malformed' };
    }
}
