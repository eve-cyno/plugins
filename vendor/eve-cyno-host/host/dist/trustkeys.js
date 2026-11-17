"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.PRODUCT_KEYS = void 0;
exports.trustedKeys = trustedKeys;
exports.trustConfigured = trustConfigured;
// The pinned public keys, per purpose (R2). `release` verifies the app's release manifest, `index` the marketplace index. Each purpose
// has a primary and a standby key (D18). Product keys are constants here: the base64 lines of host/src/keys/<name>.pub, made on
// 2026-10-22 (docs/release-checklist.md, "The signing keys"); selftest-minisign TK-product-keys holds them to those files. The test key
// reaches the code only through buildinfo.TEST_RELEASE_KEYS and TEST_INDEX_KEYS (one per purpose), which only a test build fills in, and
// a test build trusts only those. No key means "unconfigured", never "skip verification".
const buildinfo_1 = require("./buildinfo");
const minisign_1 = require("./minisign");
/** Minisign public key lines (base64), primary first: release.pub then release-standby.pub, index.pub then index-standby.pub. */
exports.PRODUCT_KEYS = {
    release: [
        'RWSQ7UgZl6v1rzgpc/VWHvZwixyZAEMnBjfdgzi7k0tbQUhNWrrU+ezX', // release.pub, key id AFF5AB971948ED90
        'RWTT/lGpiK7XhnHrI01aKfySyxCzjy54z0yZ+NmPhMxUGi8FfC8LmdIB', // release-standby.pub, key id 86D7AE88A951FED3
    ],
    index: [
        'RWTUCN+Z4vL39VF2qDdNEkV7kk6FKB0jdRXGOzmDb8V7rcOzwvy/8CM4', // index.pub, key id F5F7F2E299DF08D4
        'RWQOXLT2iorXgzcTpvvyNsgbbOOczyayWZoMeEw9a3hIw6VichCMbNz+', // index-standby.pub, key id 83D78A8AF6B45C0E
    ],
};
function trustedKeys(purpose, testBuild) {
    return (testBuild ? (purpose === 'release' ? buildinfo_1.TEST_RELEASE_KEYS : buildinfo_1.TEST_INDEX_KEYS) : exports.PRODUCT_KEYS[purpose]).map(minisign_1.parsePublicKey);
}
function trustConfigured(purpose, testBuild) { return trustedKeys(purpose, testBuild).length > 0; }
