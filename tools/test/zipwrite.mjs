// Test-only zip writer for the archive checks (tools/test/archives.test.mjs and the fixture PR suite): good archives and the hostile
// shapes of the plan's threat table (ratio, total size, entry count, zip64, encryption, traversal, links), built in the run so no binary
// fixture is committed. Stored (0) and deflate (8) entries, deflate through zlib.deflateRawSync, CRC-32 through zlib.crc32. Each hostile
// shape overrides one field; everything else is what a common zip tool writes, so the reader refuses exactly the field under test.
import zlib from 'node:zlib';

export const S_IFREG = 0o100000, S_IFDIR = 0o040000, S_IFLNK = 0o120000;
/** General purpose flag bits: 0 traditional encryption, 11 UTF-8 names. */
export const FLAG_ENCRYPTED = 0x0001, FLAG_UTF8 = 0x0800;
/** The extra field header id of zip64 sizes and offsets. */
export const EXTRA_ZIP64 = 0x0001;

const SIG_LOCAL = 0x04034b50, SIG_CENTRAL = 0x02014b50, SIG_END = 0x06054b50, SIG_Z64_LOCATOR = 0x07064b50;
const MADE_BY_UNIX = 0x031e, NEEDED = 20, DOS_DATE_1980 = 0x0021, DOS_DIR = 0x10;
/** A non-final, empty stored deflate block (what a sync flush writes): it inflates to nothing and costs 5 bytes. */
const EMPTY_STORED_BLOCK = Buffer.from([0x00, 0x00, 0x00, 0xff, 0xff]);

const u16 = (n) => { const b = Buffer.alloc(2); b.writeUInt16LE(n & 0xffff); return b; };
const u32 = (n) => { const b = Buffer.alloc(4); b.writeUInt32LE(n >>> 0); return b; };
const asBytes = (v) => (v === undefined ? Buffer.alloc(0) : Buffer.isBuffer(v) ? v : Buffer.from(v, 'utf8'));

/**
 * Deflate `data` into exactly `csize` bytes: empty stored blocks in front of the compressed stream, so the entry inflates to `data`
 * and its compressed size (and with it the ratio the reader computes) is the one asked for. Null when `csize` cannot be reached
 * (smaller than the stream, or not a multiple of 5 bytes away from it).
 */
export function deflateTo(data, csize) {
  const z = zlib.deflateRawSync(data, { level: 9 });
  const pad = csize - z.length;
  if (pad < 0 || pad % EMPTY_STORED_BLOCK.length !== 0) return null;
  return Buffer.concat([...Array.from({ length: pad / EMPTY_STORED_BLOCK.length }, () => EMPTY_STORED_BLOCK), z]);
}

/**
 * Zero bytes compressed at exactly `ratio` (usize === ratio * csize): the smallest csize of at least `minCsize` that 5-byte padding
 * reaches. Returns {data, raw}.
 */
export function zerosAtExactRatio(ratio, minCsize) {
  for (let csize = minCsize; ; csize++) {
    const data = Buffer.alloc(ratio * csize);
    const raw = deflateTo(data, csize);
    if (raw !== null) return { data, raw };
  }
}

/** `usize` zero bytes compressed at a ratio of at most `ratio` (usize <= ratio * csize), as small as 5-byte padding allows. */
export function zerosAtMostRatio(usize, ratio) {
  const data = Buffer.alloc(usize);
  const streamLength = zlib.deflateRawSync(data, { level: 9 }).length;
  let csize = Math.max(Math.ceil(usize / ratio), streamLength);
  while ((csize - streamLength) % EMPTY_STORED_BLOCK.length !== 0) csize++;
  return { data, raw: deflateTo(data, csize) };
}

/**
 * Build an archive. `entries`: {
 *   name: string (a folder ends with '/'), data?: Buffer | string, method?: 0 | 8 (default 8; a folder is always stored),
 *   raw?: Buffer (the compressed bytes as written, e.g. from deflateTo), mode?: number (Unix st_mode; default a 0644 file or a
 *   0755 folder), flags?: number (both records; bit 11 is added for a non-ASCII name), crc?, csize?, usize? (declared, both records),
 *   extra?: Buffer (both records' extra field) }
 * `opts`: { zip64Locator?: true (a zip64 end locator before the end record), total?: number (the end record's entry counts) }
 */
export function zip(entries, opts = {}) {
  const locals = [], centrals = [];
  let offset = 0;
  for (const e of entries) {
    const name = Buffer.from(e.name, 'utf8');
    const dir = e.name.endsWith('/');
    const data = asBytes(e.data);
    const method = dir ? 0 : (e.method ?? 8);
    const raw = e.raw ?? (method === 8 ? zlib.deflateRawSync(data) : data);
    const flags = (e.flags ?? 0) | (name.some(b => b >= 0x80) ? FLAG_UTF8 : 0);
    const crc = e.crc ?? (zlib.crc32(data) >>> 0);
    const csize = e.csize ?? raw.length, usize = e.usize ?? data.length;
    const extra = e.extra ?? Buffer.alloc(0);
    const mode = e.mode ?? (dir ? S_IFDIR | 0o755 : S_IFREG | 0o644);
    const sizes = [u16(flags), u16(method), u16(0), u16(DOS_DATE_1980), u32(crc), u32(csize), u32(usize), u16(name.length), u16(extra.length)];
    const local = Buffer.concat([u32(SIG_LOCAL), u16(NEEDED), ...sizes, name, extra, raw]);
    const attr = ((mode & 0xffff) * 0x10000 + (dir ? DOS_DIR : 0)) >>> 0;
    centrals.push(Buffer.concat([u32(SIG_CENTRAL), u16(MADE_BY_UNIX), u16(NEEDED), ...sizes, u16(0), u16(0), u16(0), u32(attr), u32(offset), name, extra]));
    locals.push(local);
    offset += local.length;
  }
  const cd = Buffer.concat(centrals);
  const total = opts.total ?? entries.length;
  const locator = opts.zip64Locator ? Buffer.concat([u32(SIG_Z64_LOCATOR), u32(0), u32(offset + cd.length), u32(0), u32(1)]) : Buffer.alloc(0);
  const end = Buffer.concat([u32(SIG_END), u16(0), u16(0), u16(total), u16(total), u32(cd.length), u32(offset), u16(0)]);
  return Buffer.concat([...locals, cd, locator, end]);
}

/** A zip64 extra field (header id 1) carrying an uncompressed and a compressed size of 8 bytes each. */
export function zip64Extra(usize, csize) {
  const b = Buffer.alloc(20);
  b.writeUInt16LE(EXTRA_ZIP64, 0);
  b.writeUInt16LE(16, 2);
  b.writeBigUInt64LE(BigInt(usize), 4);
  b.writeBigUInt64LE(BigInt(csize), 12);
  return b;
}
