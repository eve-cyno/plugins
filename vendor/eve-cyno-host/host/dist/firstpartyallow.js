"use strict";
// The first-party exemption (owner rulings 2026-11-20, intel-ext plan: Q1 = A1, Q2 = P1). One check, pure (no Electron, no I/O of its own):
// an id on a fixed list, installed from the official index as first-party. It counts in exactly two host rules, as its own input next to the
// built-in one (it never widens `builtIn`, main.ts isBuiltInPlugin or PluginHost.isBuiltIn):
//  - HT-M1 (owner decision 2026-11-06): such a plugin keeps `chatlogs` in its request and gets `chat` although it can send data out (grants.ts
//    `requested`, namespaces.ts, hostapi/chatmethods.ts);
//  - `data` (API 1.3.0): it is the second half of the data condition in place of `builtIn`; the pack allowlist stays dataallow.ts DATA_ALLOWLIST.
// Never `db`, windows.setBounds, Claude Code, the gesture credits or the pre-granted Background: those stay built-in only.
//
// Where the facts come from (the caller passes them as a thunk, read only for a listed id):
//  - at prompt time, the listing: the official index (no private source) and its `firstParty` mark (market/installer.ts firstPartyOf; market/updates.ts
//    the listing an update comes from; hostui/market.ts the card and the detail lines);
//  - at run time, the install record (loader.ts PluginRegistry.firstPartyExempt over market/wire.ts installedPluginRules.originOf), decided once per registry
//    entry when it is registered: `market` while the record names the folder the scan saw (its device and inode, loader.ts Found) at the recorded version,
//    a record without a private source, `firstParty` true. No later read lstats the folder (Phase 2A review finding 3).
// It fails closed: no record, an unreadable or busy one, a thunk that throws, or anything but exactly these facts answers no.
// LIMIT: the record check is the folder's device, inode and version only (the identity records.ts dirIdentity writes). It is not a verification of the
// installed folder at start: a file edited inside the recorded folder at the same version still reads as the official install, and a folder deleted and
// copied again at the same version can keep its identity on some file systems (a freed inode given again) (docs/platform-notes.md, HT-M1).
Object.defineProperty(exports, "__esModule", { value: true });
exports.FIRST_PARTY_ALLOWLIST = void 0;
exports.isFirstPartyExempt = isFirstPartyExempt;
/** The ids the exemption can apply to. Nothing else, ever, without an owner ruling. */
exports.FIRST_PARTY_ALLOWLIST = new Set(['dev.evecyno.intel']);
/** True only for an id on FIRST_PARTY_ALLOWLIST whose origin is `market`, the official index and first-party. `origin` is read only for a listed id. */
function isFirstPartyExempt(id, origin) {
    if (typeof id !== 'string' || !exports.FIRST_PARTY_ALLOWLIST.has(id))
        return false;
    let o;
    try {
        o = origin();
    }
    catch {
        return false;
    }
    return typeof o === 'object' && o !== null && o.source === 'market' && o.official === true && o.firstParty === true;
}
