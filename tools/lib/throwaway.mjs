// A throwaway minisign key for check C16 and the tests (plan 3.2, 3.3): an Ed25519 pair made in the run with node:crypto. The secret
// half stays a KeyObject in this process's memory: it is never written to a file, never in minisign's secret-key layout, never logged.
// The public half is minisign's .pub layout. Signatures are minisign's prehashed form (algorithm ED: Ed25519 over BLAKE2b-512 of the
// data, here OpenSSL's BLAKE2b, not the vendored one, so the vendored verifier is checked against another implementation) with the
// trusted comment covered by the global signature, as the app verifies them (vendor/eve-cyno-host/host/dist/minisign.js).
import crypto from 'node:crypto';

/** {keyId, pubText, sign(data, trusted) -> signature file text}. */
export function throwawaySigner() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const id = crypto.randomBytes(8);
  const pub = Buffer.from(publicKey.export({ format: 'jwk' }).x, 'base64url');
  const keyId = Buffer.from(id).reverse().toString('hex').toUpperCase(); // minisign shows the little-endian 64-bit id
  return {
    keyId,
    pubText: `untrusted comment: minisign public key ${keyId} (throwaway, made in this run)\n${Buffer.concat([Buffer.from('Ed'), id, pub]).toString('base64')}\n`,
    sign(data, trusted) {
      const sig = crypto.sign(null, crypto.createHash('blake2b512').update(data).digest(), privateKey);
      const global = crypto.sign(null, Buffer.concat([sig, Buffer.from(trusted, 'utf8')]), privateKey);
      return ['untrusted comment: signature from a throwaway key made in this run', Buffer.concat([Buffer.from('ED'), id, sig]).toString('base64'),
        `trusted comment: ${trusted}`, global.toString('base64'), ''].join('\n');
    },
  };
}
