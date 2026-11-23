// The rules the scaffold checks before it writes anything. Each one mirrors a rule of the app's plugin host (manifest id, display text,
// reserved names, Windows device names); a test holds every one to the vendored host, so a drift shows up as a red test.
//
// The name check has one known gap: the host folds look-alike letters (Cyrillic, Greek and other confusables) with a table of
// about 700 entries. This copy does not carry that table, so a name or author that spells the host's mark with look-alike letters
// passes here and is refused by the host at install and by the index checks. Everything that folds to plain Latin letters and
// digits by NFKC or by dropping accents is caught here.

export const HOST_ID_PREFIX = 'eve-cyno.host.';
export const API_MINOR_RANGE = '^1.30';

const ID_RE = /^[a-z][a-z0-9-]*(\.[a-z][a-z0-9-]*){2,}$/;
const ID_MAX = 100;
const DEVICE_RE = /^(con|prn|aux|nul|conin\$|conout\$|com[0-9¹²³]|lpt[0-9¹²³])$/i;
const RESERVED_WORDS = ['EVE-Cyno', 'Settings', 'Characters', 'Marketplace', 'Home'];

// The comparison form of a text: compatibility forms to plain letters, lower case, accents dropped, the look-alikes the host's table
// gives for ASCII (0 reads o, 1 and | read l), then letters and digits only.
function fold(text) {
  return [...text.normalize('NFKC').toLowerCase().normalize('NFD')].filter(c => !/\p{M}/u.test(c)).join('')
    .replace(/0/g, 'o').replace(/[1|]/g, 'l').replace(/[^a-z0-9]/g, '');
}
// The host reads an l as an i, so "EVElCyno" and "EVE1Cyno" count as its mark.
const asI = f => f.replace(/l/g, 'i');
const MARK = /evei?cyno/;

// Four readings, as the host takes them: the fold, the fold without punctuation, symbols and spaces, and the fold of the upper-cased text.
function readings(text) {
  const n = text.normalize('NFKC');
  return [fold(n), fold(n.replace(/[\p{P}\p{S}\p{Z}]/gu, '')), fold(text.toUpperCase())].map(asI);
}

export const hasHostMark = text => readings(text).some(f => MARK.test(f));
const reservedWord = text => readings(text).some(f => RESERVED_WORDS.some(w => asI(fold(w)) === f));

const INVISIBLE = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\p{Co}\p{Cs}\p{Cn}⠀\p{Default_Ignorable_Code_Point}]/u;
const VISIBLE = /[\p{L}\p{N}\p{S}\p{P}]/u;
const PICT = /\p{Extended_Pictographic}/u;
const BASE = /[\p{L}\p{N}\p{S}\p{P}\p{Extended_Pictographic}]/u;
const MAX_MARKS = 2;
const NOT_ALLOWED = 'control, format, separator, private-use and invisible characters are not allowed';

/**
 * The display-text rule for names, authors and descriptions: 1 to `max` code points, one visible character at least, no control,
 * format, separator, private-use or invisible character. Emoji may use U+FE0E/U+FE0F after a base character and U+200D between two
 * pictographs, and at most two combining marks may follow each other. Returns the problem or null. The caller trims first.
 */
export function displayProblem(text, max) {
  const cps = [...text];
  if (cps.length < 1 || cps.length > max) return `must be 1-${max} characters`;
  const kept = [];
  let afterBase = false;
  let afterPict = false;
  let marks = 0;
  for (let i = 0; i < cps.length; i++) {
    const c = cps[i];
    if (c === '︎' || c === '️') {
      if (!afterBase) return NOT_ALLOWED;
      afterBase = false;
      continue;
    }
    if (c === '‍') {
      if (!afterPict || !PICT.test(cps[i + 1] ?? '')) return NOT_ALLOWED;
      afterBase = false;
      afterPict = false;
      continue;
    }
    if (/\p{M}/u.test(c)) {
      marks += 1;
      if (marks > MAX_MARKS) return 'too many combining marks in a row';
      afterBase = false;
    } else {
      marks = 0;
      afterBase = BASE.test(c);
      afterPict = PICT.test(c);
    }
    kept.push(c);
  }
  const rest = kept.join('');
  if (INVISIBLE.test(rest)) return NOT_ALLOWED;
  if (!VISIBLE.test(rest)) return 'must contain a letter, number, symbol or punctuation mark';
  return null;
}

/** Why the plugin id is refused, or null. */
export function idProblem(id) {
  if (typeof id !== 'string' || id === '') return 'is required';
  if (id.length > ID_MAX) return `is longer than ${ID_MAX} characters`;
  if (!ID_RE.test(id)) return 'must be lower-case dotted words of letters, digits and hyphens, three or more of them, the first starting with a letter (for example com.example.my-plugin)';
  if (id.startsWith(HOST_ID_PREFIX)) return `must not start with ${HOST_ID_PREFIX}: that prefix is reserved for the host`;
  if (DEVICE_RE.test(id.split('.')[0])) return 'must not start with a Windows device name (con, prn, aux, nul, com1-9, lpt1-9): its folder could not exist on Windows';
  if (hasHostMark(id)) return 'must not contain the host\'s name (eve-cyno): it would read as the host\'s own';
  return null;
}

/** Why the display name is refused, or null (display text, 60 characters, and not the host's name). */
export function nameProblem(name) {
  if (typeof name !== 'string') return 'is required';
  const t = name.trim();
  const d = displayProblem(t, 60);
  if (d) return d;
  if (hasHostMark(t) || reservedWord(t)) return 'reads as one of the host\'s own names (EVE-Cyno, Settings, Characters, Marketplace, Home)';
  return null;
}

/** Why the author is refused, or null (display text, 60 characters, and not the host's name). */
export function authorProblem(author) {
  if (typeof author !== 'string') return 'is required';
  const t = author.trim();
  const d = displayProblem(t, 60);
  if (d) return d;
  if (hasHostMark(t)) return 'reads as the host (it contains EVE-Cyno)';
  return null;
}

/** Why the description is refused, or null. The scaffold uses it as the index summary too, so the limit is the summary's 120. */
export function descriptionProblem(description) {
  if (typeof description !== 'string') return 'is required';
  return displayProblem(description.trim(), 120);
}
