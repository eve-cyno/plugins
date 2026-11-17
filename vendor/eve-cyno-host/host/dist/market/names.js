"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.reservedAuthor = exports.reservedName = exports.RESERVED_WORDS = void 0;
exports.foldName = foldName;
exports.nameAllowed = nameAllowed;
// Reserved plugin names and the author marker (R27, D30; the B4a Fable review M6): a plugin named or authored like the host would
// read as the host's own prompt. Pure: no I/O, no logging (a caller logs a refusal by plugin id and code, never by the name).
//
// foldName: NFKC (fullwidth, double-struck and other compatibility forms become plain letters, capitals included); then each code
// point through the confusables table at its own case, else its lower-case form, decomposed so a mark falls away, through the
// table again; lower case; only [a-z0-9] kept. The look-up at the code point's own case comes first because confusables.txt keys
// on case: a capital and its small letter can read differently (Greek Nu reads N, nu reads v), so lower-casing first would lose
// the capital's reading. The table (confusables.gen.ts) never maps an ASCII letter, so an ASCII name folds to its own lower-cased
// letters and digits.
// reservedName and reservedAuthor compare folded forms on both sides, in four readings of the text: the fold; the fold with
// punctuation, symbols and spaces dropped first (a separator the table reads as a letter, "EVE|Cyno", cannot hide the host's
// name); the table on the raw code points before the fold (a form NFKC turns into another letter: the lunate sigma that looks like
// C becomes a sigma, which reads o); and the fold of the upper-cased text (the Home tile and the toast chip show names in capitals,
// so Cyrillic en, small capital shaped, shows as the H it reads there). In every reading and in the reserved forms an l counts as
// an i (lower-casing splits I's class: I folds to i, l and 1 to l), and the host's mark may carry one stroke where its hyphen was
// (/evei?cyno/: "EVElCyno", "EVE1Cyno").
const confusables_gen_1 = require("../confusables.gen");
/** The host's own names (R27): a plugin whose folded name equals one of these, or contains the fold of `evecyno`, is refused. */
exports.RESERVED_WORDS = Object.freeze(['EVE-Cyno', 'Settings', 'Characters', 'Marketplace', 'Home']);
// One code point: its own table entry, else its lower-case form, else its canonical decomposition, each code point of that folded
// again. Lower-casing and decomposing are idempotent, so the recursion ends.
function foldPoint(c) {
    const hit = confusables_gen_1.CONFUSABLES.get(c.codePointAt(0));
    if (hit !== undefined)
        return hit;
    const lower = c.toLowerCase();
    if (lower !== c)
        return [...lower].map(foldPoint).join('');
    const parts = c.normalize('NFD');
    return parts === c ? c : [...parts].map(foldPoint).join('');
}
/** The comparison form of a name (R27): NFKC, the confusables table, lower case, then only [a-z0-9]. */
function foldName(s) {
    return [...s.normalize('NFKC')].map(foldPoint).join('').toLowerCase().replace(/[^a-z0-9]/g, '');
}
// l as i: the comparison form of a fold (never of foldName itself, so an ASCII letter still folds to its own lower case).
const li = (f) => f.replace(/l/g, 'i');
const RESERVED = exports.RESERVED_WORDS.map(w => li(foldName(w)));
const HOST = new RegExp(`${li(foldName('eve'))}i?${li(foldName('cyno'))}`);
const SEPARATORS = /[\p{P}\p{S}\p{Z}]/gu;
const rawTable = (s) => [...s].map(c => confusables_gen_1.CONFUSABLES.get(c.codePointAt(0)) ?? c).join('');
// The four readings of a text; the separators are dropped after NFKC, so a compatibility form of a letter is a letter by then.
const readings = (s) => {
    const n = s.normalize('NFKC');
    return [foldName(n), foldName(n.replace(SEPARATORS, '')), foldName(rawTable(s)), foldName(s.toUpperCase())].map(li);
};
/** True when the name folds to one of RESERVED_WORDS or contains the host's mark (/evei?cyno/), in any reading. */
const reservedName = (name) => readings(name).some(f => RESERVED.includes(f) || HOST.test(f));
exports.reservedName = reservedName;
/** True when the author's fold contains the host's mark (/evei?cyno/), in any reading. No author is not reserved. */
const reservedAuthor = (author) => author !== undefined && readings(author).some(f => HOST.test(f));
exports.reservedAuthor = reservedAuthor;
/**
 * The names rule (R27). A bundled plugin and a first-party marketplace listing may use the host's names; anything else named like
 * the host is `reserved_name`, and authored like it `reserved_author`. `firstParty` counts only for a `market` source: a manual
 * copy is never first-party, whatever the caller passes.
 */
function nameAllowed(m, source, firstParty) {
    if (source === 'bundled' || (source === 'market' && firstParty === true))
        return true;
    if ((0, exports.reservedName)(m.name))
        return 'reserved_name';
    if ((0, exports.reservedAuthor)(m.author))
        return 'reserved_author';
    return true;
}
