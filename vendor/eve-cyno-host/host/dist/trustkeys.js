"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.PRODUCT_KEYS = void 0;
exports.trustedKeys = trustedKeys;
exports.trustConfigured = trustConfigured;
// The pinned public keys, per purpose (R2). `release` verifies the app's release manifest, `index` the marketplace index. Each purpose
// has a primary and a standby key (D18). Product keys are constants here: the base64 lines of host/src/keys/<name>.pub, the release
// keys made on 2026-10-22, the index keys on 2026-11-20 (docs/release-checklist.md, "The signing keys"); selftest-minisign
// TK-product-keys holds them to those files. The test key
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
        'RWQrb+HUNKnNODz+Q2GdjS+DYzPocXBsN+r+Li78wZcTZ9p0WnUxYlcA', // index.pub, key id 38CDA934D4E16F2B
        'RWRFHd/+tpjlfY2FZprhjLiAeuhQ0dQI5xWralhfoo5bVqfWVjimudLr', // index-standby.pub, key id 7DE598B6FEDF1D45
    ],
};
function trustedKeys(purpose, testBuild) {
    return (testBuild ? (purpose === 'release' ? buildinfo_1.TEST_RELEASE_KEYS : buildinfo_1.TEST_INDEX_KEYS) : exports.PRODUCT_KEYS[purpose]).map(minisign_1.parsePublicKey);
}
function trustConfigured(purpose, testBuild) { return trustedKeys(purpose, testBuild).length > 0; }
