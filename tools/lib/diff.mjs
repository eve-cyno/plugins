// Checks C3 (names), C10 (permissions diff), C11 (new plugin), C14 (maintainer), C17 (engines reach) over plain parsed entries.
// Every rule that the app also applies comes from the vendored host (requested, delta, isEmpty, foldName, listingAdmit, HOST_API);
// nothing here reimplements them. Pure: no I/O. An escalation is a flag (`NEEDS REVIEW escalation`), never a refusal.
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import semver from 'semver';

const require = createRequire(import.meta.url);
const DIST = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'vendor', 'eve-cyno-host', 'host', 'dist');
const { requested, delta, isEmpty } = require(path.join(DIST, 'grants.js'));
const { foldName } = require(path.join(DIST, 'market', 'names.js'));
const { listingAdmit } = require(path.join(DIST, 'market', 'admit.js'));
const { HOST_API } = require(path.join(DIST, 'manifest.js'));

/** What C10 reads of one version: the permissions of the entry's copy, plus `background` when the caller read it from the archive. */
const asManifest = (v) => ({ permissions: v.permissions ?? {}, ...(v.optionalPermissions ? { optionalPermissions: v.optionalPermissions } : {}) });

/**
 * C10 for one pair. `escalation`: the new version asks for something the old one did not (host `delta` of `requested`, not empty).
 * `background`: the new version turns `background` on. Both lead to a review, never to a refusal.
 */
export function permissionsDiff(oldV, newV) {
  const d = delta(requested(asManifest(oldV)), requested(asManifest(newV)));
  return { escalation: !isEmpty(d), delta: d, background: newV.background === true && oldV.background !== true };
}

/** The version of `all` that C10 compares `v` against: the greatest strictly lower semver, or null. */
function previousOf(v, all) {
  let best = null;
  for (const o of all) if (semver.lt(o.version, v.version) && (best === null || semver.gt(o.version, best.version))) best = o;
  return best;
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

/**
 * All of C3, C10, C11, C14, C17 for one entry. `base` is the entry on the base branch or null, `others` every other entry of the head
 * tree, `prAuthor` the PR's login (null when the check runs without one). Returns { refusals: string[], flags: string[] } with flags
 * from: new, escalation, identity, first-party, engines.
 */
export function checkEntry(head, base, { others = [], prAuthor = null } = {}) {
  const refusals = checkNames(head, base, others);
  const flags = new Set();
  if (base === null) flags.add('new');
  if ((head.firstParty === true) !== (base?.firstParty === true)) flags.add('first-party');
  if (base !== null) {
    if (base.name !== head.name || base.author !== head.author) flags.add('identity');
    // C14 holds a pull request to the maintainers of each entry it changes; an entry it leaves as it was needs none of them.
    if (prAuthor !== null && !sameEntry(head, base) && !(base.maintainers ?? []).some((m) => m.toLowerCase() === prAuthor.toLowerCase())) flags.add('identity');
  }
  const known = new Set((base?.versions ?? []).map((v) => v.version));
  // The version before an added one is the greatest lower version that is listed, as the head lists them (unlisting is one-way, C8).
  const listedNow = (v) => (head.versions.find((x) => x.version === v.version) ?? v).unlisted !== true;
  const all = [...(base?.versions ?? []), ...head.versions.filter((v) => !known.has(v.version))].filter(listedNow);
  for (const v of head.versions) {
    // An unlisted version is never an added one (C8): against a live catalog, which leaves it out, it is not compared again.
    if (known.has(v.version) || v.unlisted === true) continue;
    if (head.type !== 'theme' && !enginesReach(v.engines)) flags.add('engines');
    const prev = previousOf(v, all);
    if (prev === null) continue;
    const d = permissionsDiff(prev, v);
    if (d.escalation || d.background) flags.add('escalation');
  }
  return { refusals, flags: [...flags] };
}
