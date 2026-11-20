// The plugin archive's zip format, with no dependency. The writer makes stored entries only (method 0), files only (folders are implied
// by the names), no extra fields, no comment, no data descriptors and no zip64. Every record carries the same fixed time (1980-01-01
// 00:00, the earliest DOS time) and a regular 0644 file mode, so the same files always give the same bytes. Names must be plain (see
// nameProblem): the app's archive reader refuses far more than this writer can make, and any unzip tool on Windows, macOS or Linux reads
// a plain name the same way. Also here: listFiles (what a folder puts in an archive) and readStored (the files of an archive this writer
// made, for scripts/entry.mjs).
import { lstatSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import zlib from 'node:zlib';

/** At most this many files in an archive: the app reader's cap. */
export const MAX_ENTRIES = 2000;
/** At most this many bytes in an archive (32 MiB): the index's cap. A stored archive is a little larger than its files. */
export const MAX_ARCHIVE_BYTES = 33_554_432;
/** The fixed DOS time and date of every record: 00:00:00 on 1980-01-01. */
export const DOS_TIME = 0x0000;
export const DOS_DATE = 0x0021;
const MAX_PATH = 200, MAX_DEPTH = 16;
const MADE_BY_UNIX = 0x031e, NEEDED = 10; // version made by: Unix, 3.0; version needed: 1.0 (stored)
const MODE = 0o100644;
const MAX_U32 = 0xffffffff;
const SIG_LOCAL = 0x04034b50, SIG_CENTRAL = 0x02014b50, SIG_END = 0x06054b50;
const LOCAL_SIZE = 30, END_SIZE = 22;

// A plain segment: ASCII letters, digits, '_', '-' and '.', starting with a letter, digit or '_', not ending with '.'.
const SEGMENT = /^[A-Za-z0-9_][A-Za-z0-9._-]*$/;
const DEVICE = /^(con|prn|aux|nul|conin\$|conout\$|com[0-9]|lpt[0-9])$/i;

/** A name for a message: JSON-quoted, so a control character in it is shown escaped and never reaches the terminal. */
export const quote = name => JSON.stringify(String(name).slice(0, 200));

/** Why `name` is not a plain archive file name (a short code), or null. */
export function nameProblem(name) {
  if (typeof name !== 'string' || name === '') return 'empty';
  if (name.length > MAX_PATH) return 'too_long';
  const segments = name.split('/');
  if (segments.length > MAX_DEPTH) return 'too_deep';
  for (const s of segments) {
    if (s === '') return 'empty_segment'; // also a leading '/', a trailing '/' (a folder) and '//'
    if (s === '.' || s === '..') return 'dot_segment';
    if (!SEGMENT.test(s)) return 'not_plain';
    if (s.endsWith('.')) return 'trailing_dot';
    if (DEVICE.test(s.split('.')[0])) return 'device_name';
  }
  return null;
}

/**
 * Every regular file under `dir` by its archive name ('/'-separated), sorted in code unit order (ASCII: the same on every machine).
 * lstat only, so a link is refused and never followed. Throws, naming the file relative to `dir`, on a link, anything but files and
 * folders, an empty folder below `dir`, a name that is not plain, or more than MAX_ENTRIES files.
 */
export function listFiles(dir) {
  const names = [];
  const walk = (abs, pre) => {
    const list = readdirSync(abs);
    if (list.length === 0 && pre !== '') throw new Error(`${quote(pre.slice(0, -1))} is an empty folder, which an archive cannot keep (remove it)`);
    for (const e of list) {
      const name = pre + e, p = join(abs, e), st = lstatSync(p);
      if (st.isSymbolicLink()) throw new Error(`${quote(name)} is a link (put the file itself there)`);
      if (st.isDirectory()) { walk(p, `${name}/`); continue; }
      if (!st.isFile()) throw new Error(`${quote(name)} is neither a file nor a folder`);
      const problem = nameProblem(name);
      if (problem !== null) throw new Error(`${quote(name)} is not a plain name (${problem}): use ASCII letters, digits, '_', '-' and '.', at most ${MAX_PATH} characters`);
      names.push(name);
      if (names.length > MAX_ENTRIES) throw new Error(`more than ${MAX_ENTRIES} files`);
    }
  };
  walk(dir, '');
  return names.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

const u16 = n => { const b = Buffer.alloc(2); b.writeUInt16LE(n); return b; };
const u32 = n => { const b = Buffer.alloc(4); b.writeUInt32LE(n >>> 0); return b; };
const crc32 = data => {
  // zlib.crc32 is Node 22.2 and newer: without it no archive is written (and none is read back).
  if (typeof zlib.crc32 !== 'function') throw new Error('zip: this Node has no zlib.crc32; use Node 22.2 or newer');
  return zlib.crc32(data) >>> 0;
};

/**
 * The zip archive of `files` ({ name, data: Buffer }), in the order given. Throws (a message without the name) on an unsafe name, a name
 * given twice or spelt twice (case aside, as Windows sees it), a name that is both a file and a folder, more than MAX_ENTRIES files, or
 * sizes beyond what a zip without zip64 can hold.
 */
export function zipStored(files) {
  if (!Array.isArray(files)) throw new Error('zip: no file list');
  if (files.length > MAX_ENTRIES) throw new Error(`zip: ${files.length} files, at most ${MAX_ENTRIES}`);
  // One node per path, folded to lower case as Windows sees it: a file named twice, a file that is also a folder, or one folder spelt
  // two ways (a/x and A/y) is refused.
  const seen = new Map(); // folded path -> { dir, spelling }
  const parts = [], central = [];
  let pos = 0;
  for (const [i, f] of files.entries()) {
    const problem = nameProblem(f?.name);
    if (problem !== null) throw new Error(`zip: file ${i}: unsafe name (${problem})`);
    if (!Buffer.isBuffer(f.data)) throw new Error(`zip: file ${i}: no data`);
    const segments = f.name.split('/');
    for (let k = 1; k <= segments.length; k++) {
      const spelling = segments.slice(0, k).join('/'), dir = k < segments.length, had = seen.get(spelling.toLowerCase());
      if (had !== undefined && (!had.dir || !dir || had.spelling !== spelling)) throw new Error(`zip: file ${i}: a name given twice, spelt twice, or both a file and a folder`);
      seen.set(spelling.toLowerCase(), { dir, spelling });
    }
    const name = Buffer.from(f.name, 'ascii'), data = f.data, crc = crc32(data);
    if (data.length >= MAX_U32 || pos >= MAX_U32) throw new Error(`zip: file ${i}: too large for a zip without zip64`);
    const head = [u16(NEEDED), u16(0), u16(0), u16(DOS_TIME), u16(DOS_DATE), u32(crc), u32(data.length), u32(data.length), u16(name.length), u16(0)];
    const local = Buffer.concat([u32(SIG_LOCAL), ...head, name]);
    central.push(Buffer.concat([u32(SIG_CENTRAL), u16(MADE_BY_UNIX), ...head, u16(0), u16(0), u16(0), u32((MODE << 16) >>> 0), u32(pos), name]));
    parts.push(local, data);
    pos += local.length + data.length;
  }
  const cd = Buffer.concat(central);
  if (pos + cd.length >= MAX_U32) throw new Error('zip: too large for a zip without zip64');
  const end = Buffer.concat([u32(SIG_END), u16(0), u16(0), u16(files.length), u16(files.length), u32(cd.length), u32(pos), u16(0)]);
  return Buffer.concat([...parts, cd, end]);
}

/**
 * The files of an archive that zipStored wrote, as a Map of name to data, or null for anything else (another tool's zip, or an archive
 * changed or cut short). The local records are read in order, each checked for zipStored's shape and its CRC-32, and the archive must be
 * byte for byte what zipStored makes of them, so a change anywhere (central directory and end record included) returns null.
 * scripts/entry.mjs uses it to read plugin.json back; the index reads every archive with the app's own reader, never this one.
 */
export function readStored(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length < END_SIZE) return null;
  const end = bytes.length - END_SIZE; // zipStored writes no comment: the end record is the last 22 bytes
  if (bytes.readUInt32LE(end) !== SIG_END) return null;
  const count = bytes.readUInt16LE(end + 10), cdSize = bytes.readUInt32LE(end + 12), cdOffset = bytes.readUInt32LE(end + 16);
  if (cdOffset + cdSize !== end || cdOffset + 4 > end || bytes.readUInt32LE(cdOffset) !== SIG_CENTRAL) return null;
  const files = new Map();
  let p = 0;
  for (let i = 0; i < count; i++) {
    if (p + LOCAL_SIZE > cdOffset || bytes.readUInt32LE(p) !== SIG_LOCAL) return null;
    const flags = bytes.readUInt16LE(p + 6), method = bytes.readUInt16LE(p + 8), crc = bytes.readUInt32LE(p + 14);
    const csize = bytes.readUInt32LE(p + 18), usize = bytes.readUInt32LE(p + 22), n = bytes.readUInt16LE(p + 26), x = bytes.readUInt16LE(p + 28);
    if (flags !== 0 || method !== 0 || x !== 0 || csize !== usize) return null;
    const start = p + LOCAL_SIZE + n;
    if (start + csize > cdOffset) return null;
    const name = bytes.subarray(p + LOCAL_SIZE, start).toString('latin1');
    const data = Buffer.from(bytes.subarray(start, start + csize));
    if (nameProblem(name) !== null || files.has(name) || crc32(data) !== crc) return null;
    files.set(name, data);
    p = start + csize;
  }
  if (p !== cdOffset) return null;
  let again;
  try { again = zipStored([...files].map(([name, data]) => ({ name, data }))); } catch { return null; }
  return again.equals(bytes) ? files : null;
}
