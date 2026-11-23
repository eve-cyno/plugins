// Checks C3 (names), C10 (permissions diff, and the `wasm` class of R1), C11 (new plugin), C14 (maintainer), C17 (engines reach) and the
// review class of a new version of a revoked id (C15) over plain parsed entries.
// Every rule that the app also applies comes from the vendored host (requested, delta, isEmpty, isFirstPartyExempt, foldName, listingAdmit,
// HOST_API, wasmReach, canSendOut, withItems, optionalOf); nothing here reimplements them. Pure: no I/O. An escalation is a flag (`NEEDS REVIEW escalation`), never a refusal.
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import semver from 'semver';

const require = createRequire(import.meta.url);
const DIST = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'vendor', 'eve-cyno-host', 'host', 'dist');
const { requested, delta, isEmpty, withItems, wasmReach } = require(path.join(DIST, 'grants.js'));
const { optionalOf } = require(path.join(DIST, 'optional.js'));
const { canSendOut } = require(path.join(DIST, 'windowsview.js'));
const { foldName } = require(path.join(DIST, 'market', 'names.js'));
const { listingAdmit } = require(path.join(DIST, 'market', 'admit.js'));
const { HOST_API } = require(path.join(DIST, 'manifest.js'));
const { isFirstPartyExempt } = require(path.join(DIST, 'firstpartyallow.js'));

/**
 * The app's first-party verdict for one entry of this index (vendored firstpartyallow.js isFirstPartyExempt, owner rulings Q1 = A1, Q2 = P1),
 * read from the entry alone: this repository is the official index, so the origin is `market` and official, first-party when the entry's
 * `firstParty` is true, as the app reads a listing of the official index (desktop market/installer.ts firstPartyOf, market/updates.ts).
 * False for an id not on FIRST_PARTY_ALLOWLIST and for no entry.
 */
const exemptOf = (e) => e != null && isFirstPartyExempt(e.id, () => ({ source: 'market', official: true, firstParty: e.firstParty === true }));

/**
 * The first-party input of host `requested` for C10 on `head` (`base`: the entry on the base, or null). `after`, for an added version: the
 * head's verdict, which the app's update prompt reads. `before`, for the version before it: exempt only when the head and the base both
 * are, since a grant made while the entry was not first-party holds no `chatlogs` and the app asks for them again (fail closed: never
 * fewer escalations than the app asks of a user whose grant was made at the base version; C10 sees only the base and the head, not each
 * user's grant history).
 */
export function firstPartyExempt(head, base) {
  const after = exemptOf(head);
  return { before: after && exemptOf(base ?? head), after };
}

/**
 * What C10 reads of one version: its permissions (check.mjs puts the archive's plugin.json permissions and `background` in place of
 * the entry's copy). Only the required permissions are compared: host `requested()` leaves out permissions.optional (it reads them
 * only to decide whether `chatlogs` counts), and the app asks for an optional one again when the plugin requests it (plan C10, R29).
 */
const asManifest = (v) => ({ permissions: v.permissions ?? {} });

/**
 * C10 for one pair. `escalation`: the new version asks for something the old one did not (host `delta` of `requested`, not empty).
 * `background`: the new version turns `background` on. Both lead to a review, never to a refusal. `exempt`: the first-party input of
 * `requested` for each side (firstPartyExempt); none is the rule for every plugin that is not built-in or first-party exempt.
 */
export function permissionsDiff(oldV, newV, exempt = { before: false, after: false }) {
  const d = delta(requested(asManifest(oldV), false, exempt.before === true), requested(asManifest(newV), false, exempt.after === true));
  return { escalation: !isEmpty(d), delta: d, background: newV.background === true && oldV.background !== true };
}

/**
 * The manifest the host's wasm rules read of one version (check.mjs puts the archive's plugin.json `permissions`, the optional items
 * in `permissions.optional` included, and its `contributes.services` as `provides` in place of the entry's copy).
 */
const asWasmManifest = (v) => ({ permissions: v.permissions ?? {}, contributes: { services: Array.isArray(v.provides) ? v.provides : [] } });

/**
 * R1: the ways out of a version that sets `wasm` (plan dp4 W1 3.2), each named, in a fixed order: required network, optional network,
 * consumed services, a provided service, `ai`, `account`. The verdict is the vendored host's wasmReach (canSendOut over the required part
 * with every optional item on, and whether the plugin provides a service); each way is named only when canSendOut counts it alone, so a
 * way the host stops counting is no longer named. When the host counts a way that none of these names, the list says so. Empty: no way out.
 */
export function wasmWays(v) {
  const m = asWasmManifest(v);
  const req = requested(m), opt = optionalOf(m), none = requested({ permissions: {} });
  const ways = [];
  const out = (g, provides = false) => canSendOut(g, provides);
  if (out({ ...none, network: req.network })) ways.push(`required network ${req.network.join(', ')}`);
  const optNet = opt.network ?? []; // optionalOf leaves out an item the required part holds
  if (out(withItems(none, { network: optNet }))) ways.push(`optional network ${optNet.join(', ')}`);
  if (out({ ...none, services: req.services })) ways.push(`consumed service ${Object.keys(req.services).join(', ')}`);
  if (out(none, m.contributes.services.length > 0)) ways.push('a provided service');
  if (out({ ...none, flags: { ...none.flags, ai: req.flags.ai } })) ways.push('ai');
  if (out({ ...none, flags: { ...none.flags, account: req.flags.account } })) ways.push('account');
  if (ways.length === 0 && wasmReach(m)) ways.push('a way out the host counts (canSendOut)');
  return ways;
}

/** The reason text of a `wasm` flag for a version with these ways out (wasmWays). */
export const wasmReason = (ways) => `its plugin.json sets wasm: true (it may compile and run WebAssembly); ${ways.length === 0 ? 'no way out' : `ways out: ${ways.join('; ')}`}`;

/** The version of `all` with the greatest semver strictly lower than `v`'s, or null. */
function previousOf(v, all) {
  let best = null;
  for (const o of all) if (semver.lt(o.version, v.version) && (best === null || semver.gt(o.version, best.version))) best = o;
  return best;
}

/**
 * The version C10 compares an added version `v` of `head` against (`base`: the entry on the base, or null): the greatest lower version
 * that is listed, as the head lists them (unlisting is one-way, C8); when none is listed, the greatest lower version on the base in any
 * listing state, so unlisting every older version (in the same pull request or an earlier one) never skips the comparison. A version
 * on the base is its base copy; an unlisted version the base does not name is never one (against a tree C8 refuses it, a catalog leaves
 * it out). Null when there is no such version. Throws on a version that is not semver.
 */
export function versionBefore(v, head, base) {
  const onBase = base?.versions ?? [];
  const known = new Set(onBase.map((x) => x.version));
  const listedNow = (x) => (head.versions.find((y) => y.version === x.version) ?? x).unlisted !== true;
  const listed = [...onBase, ...head.versions.filter((x) => !known.has(x.version))].filter(listedNow);
  return previousOf(v, listed) ?? previousOf(v, onBase);
}

/** C17: the range admits a host API major that a released host supports. A range that does not parse admits none. */
export function enginesReach(range, hostApiVersion = HOST_API.version) {
  if (typeof range !== 'string' || semver.validRange(range) === null) return false;
  return semver.intersects(range, `^${semver.major(hostApiVersion)}`);
}

/**
 * C3: `listingAdmit` (reserved names and authors, device-name ids) and the lookalike rule, which applies when the entry is new or its
 * name changed: `foldName(name)` equal to another entry's. `firstParty` with maintainers is refused. Returns refusal strings.
 */
export function checkNames(head, base, others) {
  const out = [];
  if (!listingAdmit({ id: head.id, name: head.name, author: head.author, firstParty: head.firstParty })) out.push(`C3 name or author of ${head.id} is reserved or not allowed`);
  if (head.firstParty === true && (head.maintainers?.length ?? 0) > 0) out.push(`C3 first-party entry ${head.id} lists maintainers`);
  if (base === null || base.name !== head.name) {
    const fold = foldName(head.name);
    for (const o of others) {
      if (o.id !== head.id && foldName(o.name) === fold) out.push(`C3 name of ${head.id} folds to the same text as the name of ${o.id}`);
    }
  }
  return out;
}

/** JSON with the keys of every object sorted, so two parsed entries compare by value, not by the order their files list keys in. */
const canon = (v) => (Array.isArray(v) ? `[${v.map(canon).join(',')}]`
  : typeof v === 'object' && v !== null ? `{${Object.keys(v).sort().map(k => `${JSON.stringify(k)}:${canon(v[k])}`).join(',')}}`
    : JSON.stringify(v));
/** True when `a` and `b` hold the same JSON value: a pull request that leaves an entry so has not touched it. */
export const sameEntry = (a, b) => canon(a) === canon(b);

/** The maintainers as lower-case logins (GitHub logins are case-insensitive), sorted; none is an empty list. */
const maintainerSet = (e) => JSON.stringify((Array.isArray(e.maintainers) ? e.maintainers : []).map((m) => String(m).toLowerCase()).sort());
/** The repository the archives' provenance is bound to (C12), lower case, or null when none is declared. */
const provenanceRepo = (e) => (typeof e.provenance?.repo === 'string' ? e.provenance.repo.toLowerCase() : null);

/**
 * C10 identity: who the entry is and who may change it. A changed name, author or type under the same id; a provenance repository
 * that changes (C12 binds it to `source`, so the source moves with it) or is dropped; any change to the maintainers (C14 trusts them).
 */
function identityChanged(head, base) {
  if (base.name !== head.name || base.author !== head.author || base.type !== head.type) return true;
  const was = provenanceRepo(base);
  if (was !== null && provenanceRepo(head) !== was) return true;
  return maintainerSet(base) !== maintainerSet(head);
}

/**
 * All of C3, C10, C11, C14, C17 for one entry. `base` is the entry on the base branch or null, `others` every other entry of the head
 * tree, `prAuthor` the PR's login (null when the check runs without one), `revoked` the revocations of the base and the head (C15).
 * Returns { refusals: string[], flags: string[], wasm: {version, ways}[] } with flags from: new, escalation, identity, first-party, engines,
 * revoked, wasm. `wasm` lists every added version that sets `wasm: true` (R1) with its ways out (wasmWays).
 */
export function checkEntry(head, base, { others = [], prAuthor = null, revoked = [] } = {}) {
  const refusals = checkNames(head, base, others);
  const flags = new Set();
  if (base === null) flags.add('new');
  // C3: an entry that is first-party on the base or the head and that the pull request changes at all (firstParty set or dropped
  // included) is read by the owner, whoever opens the pull request; one it leaves as it was is not.
  if ((head.firstParty === true || base?.firstParty === true) && !sameEntry(head, base)) flags.add('first-party');
  if (base !== null) {
    if (identityChanged(head, base)) flags.add('identity');
    // C14 holds a pull request to the maintainers of each entry it changes; an entry it leaves as it was needs none of them.
    if (prAuthor !== null && !sameEntry(head, base) && !(base.maintainers ?? []).some((m) => m.toLowerCase() === prAuthor.toLowerCase())) flags.add('identity');
  }
  const known = new Set((base?.versions ?? []).map((v) => v.version));
  // A revocation names the id: a new version of it is read by a maintainer, whatever it asks for (C15).
  const revokedId = revoked.some((r) => typeof r === 'object' && r !== null && r.id === head.id);
  const exempt = firstPartyExempt(head, base);
  const wasm = [];
  for (const v of head.versions) {
    // An unlisted version is never an added one (C8): against a live catalog, which leaves it out, it is not compared again.
    if (known.has(v.version) || v.unlisted === true) continue;
    if (revokedId) flags.add('revoked');
    if (head.type !== 'theme' && !enginesReach(v.engines)) flags.add('engines');
    // R1 (owner answer OQ-3 (a)): every added version whose archive sets `wasm: true` is read by a maintainer, with or without a way out.
    if (v.wasm === true) { flags.add('wasm'); wasm.push({ version: v.version, ways: wasmWays(v) }); }
    const prev = versionBefore(v, head, base);
    // Fail closed: a known id with no lower version at all leaves nothing to compare with (C8 refuses such a version anyway).
    if (prev === null) { if (base !== null) flags.add('escalation'); continue; }
    const d = permissionsDiff(prev, v, exempt);
    if (d.escalation || d.background) flags.add('escalation');
  }
  return { refusals, flags: [...flags], wasm };
}
