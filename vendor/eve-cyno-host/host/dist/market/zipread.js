"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.entryNameProblem = exports.isDeviceNameId = exports.isDeviceName = exports.ZIP_LIMITS = void 0;
exports.readZip = readZip;
exports.extractTo = extractTo;
// The marketplace archive reader (R25, D27): a bounded, synchronous .zip reader with no dependency. The central directory is the
// source of truth and every local record is checked against it; the records it names fill every byte before it (no stub, no gap).
// Only stored (0) and deflate (8) entries pass; zip64, encryption, links, devices, bombs (by entry count, declared or actual size,
// ratio), overlapping records and every name a Windows or Linux folder could take another way are refused before one byte is written. Nested archives are files like any other (no recursion).
// readZip never throws on a hostile archive: every refusal is a typed result. extractTo writes a checked list into an empty folder.
const fs = __importStar(require("node:fs"));
const node_path_1 = __importDefault(require("node:path"));
const zlib = __importStar(require("node:zlib"));
exports.ZIP_LIMITS = Object.freeze({ maxEntries: 2000, maxUnpacked: 67_108_864, maxRatio: 100, maxPath: 200, maxDepth: 16 });
const SIG_LOCAL = 0x04034b50, SIG_CENTRAL = 0x02014b50, SIG_Z64_LOCATOR = 0x07064b50, SIG_DESCRIPTOR = 0x08074b50;
const SIG_END = Buffer.from([0x50, 0x4b, 0x05, 0x06]);
const END_SIZE = 22, CENTRAL_SIZE = 46, LOCAL_SIZE = 30, MAX_COMMENT = 0xffff;
const EXTRA_ZIP64 = 0x0001, EXTRA_UNICODE_PATH = 0x7075;
// General purpose flags: bits 0, 6 and 13 encrypt (traditional, strong, masked local headers); 1-2 are deflate options, 3 puts the
// sizes in a data descriptor, 11 marks UTF-8 names. Any other bit is a coding this reader does not know ('method').
const FLAGS_ENCRYPTED = 0x0001 | 0x0040 | 0x2000, FLAG_DESCRIPTOR = 0x0008, FLAG_UTF8 = 0x0800;
const FLAGS_KNOWN = 0x0002 | 0x0004 | FLAG_DESCRIPTOR | FLAG_UTF8;
const S_IFMT = 0o170000, S_IFREG = 0o100000, S_IFDIR = 0o040000, S_IFLNK = 0o120000, DOS_DIR = 0x10;
const UTF8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }); // a BOM stays in the name: never silently dropped
// An entry's own memory, never pooled: a view of the archive would keep all of it alive, and a pooled copy (or zlib's output, a
// slice of its 16 KiB chunk in Node or of the 64 KiB Buffer pool in Electron) keeps a whole slab alive for a few bytes.
const own = (b) => { const out = Buffer.allocUnsafeSlow(b.length); b.copy(out); return out; };
/**
 * True when Windows opens a device for this path segment: its stem (before the first dot, trailing spaces dropped) is CON, PRN, AUX,
 * NUL, CONIN$, CONOUT$, COM0-9 or LPT0-9 in any case, the superscript digits ¹ ² ³ included. Checked on every OS (archive names;
 * plugin ids, R26).
 */
const isDeviceName = (segment) => /^(con|prn|aux|nul|conin\$|conout\$|com[0-9¹²³]|lpt[0-9¹²³])$/i.test(segment.split('.')[0].replace(/ +$/, ''));
exports.isDeviceName = isDeviceName;
/** True when a plugin id's first segment is a Windows device name (`nul.evecyno.x`): its folder could not exist on Windows. */
const isDeviceNameId = (id) => (0, exports.isDeviceName)(id.split('.')[0]);
exports.isDeviceNameId = isDeviceNameId;
function nameProblem(name, maxPath, maxDepth) {
    const p = name.endsWith('/') ? name.slice(0, -1) : name; // one trailing '/' marks a folder
    if (p.length > maxPath)
        return 'too_long';
    if (/[\u0000-\u001f\u007f-\u009f]/.test(p))
        return 'control';
    if (p.includes('\\'))
        return 'backslash';
    if (p.startsWith('/'))
        return 'absolute';
    if (/^[A-Za-z]:/.test(p))
        return 'drive';
    if (/[<>:"|?*]/.test(p))
        return 'reserved_char';
    const segments = p.split('/');
    if (segments.length > maxDepth)
        return 'too_deep';
    for (const s of segments) {
        if (s === '')
            return 'empty_segment';
        if (s === '.' || s === '..')
            return 'dot_segment';
        if (/[. ]$/.test(s))
            return 'trailing_dot_space'; // Windows drops them, so `a.` and `a` would be one file there
        if ((0, exports.isDeviceName)(s))
            return 'device_name';
        if (Buffer.byteLength(s, 'utf8') > 255)
            return 'too_long'; // a Linux file name holds 255 bytes (NAME_MAX)
    }
    return null;
}
/** Why an archive entry name is unsafe on Windows or Linux (a short code), or null. A single trailing '/' (a folder) is allowed. */
const entryNameProblem = (name) => nameProblem(name, exports.ZIP_LIMITS.maxPath, exports.ZIP_LIMITS.maxDepth);
exports.entryNameProblem = entryNameProblem;
// The header ids of an extra field, or null when it does not parse into whole records (one running past the field, or 1-3 bytes
// left over): Python's zipfile raises on it, and a reader that stops early could miss a record another one honours.
const extraIds = (x) => {
    const ids = [];
    let q = 0;
    for (; q + 4 <= x.length; q += 4 + x.readUInt16LE(q + 2))
        ids.push(x.readUInt16LE(q));
    return q === x.length ? ids : null; // past the end: a record overran it; short of it: bytes left over
};
// Without bit 11 a name must be ASCII (anything else would be read as CP437 by one tool and UTF-8 by another); with it, strict UTF-8.
const decodeName = (b, utf8) => {
    if (!utf8)
        return b.every(x => x < 0x80) ? b.toString('latin1') : null;
    try {
        return UTF8.decode(b);
    }
    catch {
        return null;
    }
};
/**
 * The end record: the one signature in the last 64 KiB + 22 bytes whose comment ends exactly at the end of the file. A second
 * signature after it (a record faked in the comment, which a reader taking the last signature would use) or a second
 * self-consistent record (one faked in stored data) makes the archive ambiguous: refused, so no other tool can see other content.
 */
function findEnd(buf) {
    for (let p = buf.indexOf(SIG_END, Math.max(0, buf.length - END_SIZE - MAX_COMMENT)); p !== -1 && p <= buf.length - END_SIZE; p = buf.indexOf(SIG_END, p + 1)) {
        if (p + END_SIZE + buf.readUInt16LE(p + 20) !== buf.length)
            continue;
        return buf.indexOf(SIG_END, p + 1) === -1 ? p : 'ambiguous';
    }
    return 'none';
}
// One node per path, entries and the folders they imply: a second entry of a name, a file that is also a folder, or one folder spelt
// two ways (the fold puts them together; Linux keeps them apart, Windows does not) is a duplicate.
// The fold: NFC, then each code point through its single-unit upper case (as NTFS's upcase table does: ſ/s, ı/i, µ/μ, ς/σ meet; ß,
// whose upper case is two letters, stays apart), then lower case.
const foldKey = (s) => [...s.normalize('NFC')].map(c => { const u = c.toUpperCase(); return u.length === 1 ? u : c; }).join('').toLowerCase();
/**
 * Read and check a whole archive in memory. The result's entries are in central directory order and own their bytes (never a view
 * of `buf`). `limits` lowers or raises ZIP_LIMITS for tests and tools; the marketplace uses the defaults.
 */
function readZip(buf, limits) {
    const L = {
        maxEntries: limits?.maxEntries ?? exports.ZIP_LIMITS.maxEntries, maxUnpacked: limits?.maxUnpacked ?? exports.ZIP_LIMITS.maxUnpacked,
        maxRatio: limits?.maxRatio ?? exports.ZIP_LIMITS.maxRatio, maxPath: limits?.maxPath ?? exports.ZIP_LIMITS.maxPath, maxDepth: limits?.maxDepth ?? exports.ZIP_LIMITS.maxDepth,
    };
    const no = (reason, entry) => (entry === undefined ? { ok: false, reason } : { ok: false, reason, entry });
    // No CRC function in this runtime (zlib.crc32 is Node 20.15+/22.2+): fail closed rather than skip the check.
    if (typeof zlib.crc32 !== 'function')
        return no('crc');
    // ---- the end record
    const e = findEnd(buf);
    if (e === 'none')
        return no(buf.length >= 4 && buf.readUInt32LE(0) === SIG_LOCAL ? 'truncated' : 'not_zip');
    if (e === 'ambiguous')
        return no('not_zip');
    const disk = buf.readUInt16LE(e + 4), cdDisk = buf.readUInt16LE(e + 6), here = buf.readUInt16LE(e + 8), total = buf.readUInt16LE(e + 10);
    const cdSize = buf.readUInt32LE(e + 12), cdOffset = buf.readUInt32LE(e + 16);
    if ([disk, cdDisk, here, total].includes(0xffff) || cdSize === 0xffffffff || cdOffset === 0xffffffff)
        return no('zip64');
    if (e >= 20 && buf.readUInt32LE(e - 20) === SIG_Z64_LOCATOR)
        return no('zip64');
    if (disk !== 0 || cdDisk !== 0 || here !== total)
        return no('not_zip'); // a split archive
    if (total > L.maxEntries)
        return no('too_many');
    if (cdOffset + cdSize > e)
        return no('truncated');
    if (cdOffset + cdSize !== e)
        return no('not_zip'); // bytes between the central directory and the end record
    // ---- the central directory alone: kinds, names, types, declared sizes, duplicates
    const cds = [];
    const paths = new Map();
    const claim = (spelling, dir, named) => {
        const key = foldKey(spelling);
        const had = paths.get(key);
        if (!had) {
            paths.set(key, { spelling, dir, named });
            return true;
        }
        if (had.spelling !== spelling || !had.dir || !dir || (had.named && named))
            return false;
        had.named ||= named;
        return true;
    };
    let p = cdOffset, declared = 0;
    for (let i = 0; i < total; i++) {
        if (p + CENTRAL_SIZE > e)
            return no('truncated', i);
        if (buf.readUInt32LE(p) !== SIG_CENTRAL)
            return no('not_zip', i);
        const flags = buf.readUInt16LE(p + 8), method = buf.readUInt16LE(p + 10);
        const crc = buf.readUInt32LE(p + 16), csize = buf.readUInt32LE(p + 20), usize = buf.readUInt32LE(p + 24);
        const n = buf.readUInt16LE(p + 28), x = buf.readUInt16LE(p + 30), c = buf.readUInt16LE(p + 32);
        const diskStart = buf.readUInt16LE(p + 34), attr = buf.readUInt32LE(p + 38), offset = buf.readUInt32LE(p + 42);
        if (p + CENTRAL_SIZE + n + x + c > e)
            return no('truncated', i);
        const nameBytes = buf.subarray(p + CENTRAL_SIZE, p + CENTRAL_SIZE + n), extra = buf.subarray(p + CENTRAL_SIZE + n, p + CENTRAL_SIZE + n + x);
        p += CENTRAL_SIZE + n + x + c;
        const ids = extraIds(extra);
        if (ids === null)
            return no('not_zip', i);
        if (csize === 0xffffffff || usize === 0xffffffff || offset === 0xffffffff || diskStart === 0xffff || ids.includes(EXTRA_ZIP64))
            return no('zip64', i);
        if (diskStart !== 0)
            return no('not_zip', i);
        if (flags & FLAGS_ENCRYPTED)
            return no('encrypted', i);
        // A stored entry has no end marker, so with bit 3 only the Finder/ditto shape passes: sizes 0, a signed descriptor right after
        // the header (checked with the local records). Still refused: stored data with bit 3 (Go archive/zip Store, zip -0 to a pipe,
        // archiver store:true on streams), whose end a streaming reader cannot find.
        const storedDescriptor = method === 0 && (flags & FLAG_DESCRIPTOR) !== 0;
        if ((flags & ~FLAGS_KNOWN) !== 0 || (method !== 0 && method !== 8) || (storedDescriptor && (csize !== 0 || usize !== 0)))
            return no('method', i);
        // An Info-ZIP Unicode Path field would give other tools another name than the one this reader checks.
        const raw = decodeName(nameBytes, (flags & FLAG_UTF8) !== 0);
        if (raw === null || ids.includes(EXTRA_UNICODE_PATH) || nameProblem(raw, L.maxPath, L.maxDepth) !== null)
            return no('bad_name', i);
        const dir = raw.endsWith('/'), name = dir ? raw.slice(0, -1) : raw;
        // The Unix type in the high 16 bits counts whatever host made the entry: a link stays a link to the tools that honour it.
        const type = (attr >>> 16) & S_IFMT;
        if (type === S_IFLNK)
            return no('link', i);
        if (type !== 0 && type !== S_IFREG && type !== S_IFDIR)
            return no('not_regular', i);
        if ((type !== 0 && (type === S_IFDIR) !== dir) || (!dir && (attr & DOS_DIR) !== 0) || (dir && usize !== 0))
            return no('mismatch', i);
        if (method === 0 && csize !== usize)
            return no('mismatch', i);
        if (usize > csize * L.maxRatio)
            return no('ratio', i);
        declared += usize;
        if (declared > L.maxUnpacked)
            return no('too_large', i);
        const segments = name.split('/');
        for (let k = 1; k < segments.length; k++)
            if (!claim(segments.slice(0, k).join('/'), true, false))
                return no('duplicate', i);
        if (!claim(name, dir, true))
            return no('duplicate', i);
        cds.push({ name, nameBytes, dir, flags, method, crc, csize, usize, offset, dataStart: 0, dataEnd: 0 });
    }
    if (p !== e)
        return no('not_zip'); // the directory holds more than the end record counts
    // ---- where each local record lies: together they fill [0, cdOffset) exactly. A byte outside every record (a stub archive in
    // front, a gap, a record no entry names) is what a reader walking the local records from the start would see, and this one not.
    const spans = [];
    for (const [i, c] of cds.entries()) {
        const o = c.offset;
        if (o + LOCAL_SIZE > cdOffset)
            return no('overlap', i);
        if (buf.readUInt32LE(o) !== SIG_LOCAL)
            return no('mismatch', i);
        c.dataStart = o + LOCAL_SIZE + buf.readUInt16LE(o + 26) + buf.readUInt16LE(o + 28);
        c.dataEnd = c.dataStart + c.csize;
        let end = c.dataEnd;
        if (c.flags & FLAG_DESCRIPTOR) {
            const signed = end + 4 <= cdOffset && buf.readUInt32LE(end) === SIG_DESCRIPTOR;
            if (c.method === 0 && !signed)
                return no('method', i); // an empty stored entry: only with the signed descriptor
            end += signed ? 16 : 12;
        }
        spans.push({ start: o, end, i });
    }
    spans.sort((a, b) => a.start - b.start);
    if (spans.length === 0 ? cdOffset !== 0 : spans[0].start !== 0)
        return no('overlap', spans[0]?.i);
    for (let k = 1; k < spans.length; k++)
        if (spans[k].start !== spans[k - 1].end)
            return no('overlap', spans[k].i); // a shared byte or a gap
    if (spans.length !== 0 && spans[spans.length - 1].end !== cdOffset)
        return no('overlap', spans[spans.length - 1].i);
    // ---- each local header says what the central directory says
    for (const [i, c] of cds.entries()) {
        const o = c.offset;
        const lflags = buf.readUInt16LE(o + 6), lmethod = buf.readUInt16LE(o + 8);
        const lcrc = buf.readUInt32LE(o + 14), lcsize = buf.readUInt32LE(o + 18), lusize = buf.readUInt32LE(o + 22);
        const n = buf.readUInt16LE(o + 26), lname = buf.subarray(o + LOCAL_SIZE, o + LOCAL_SIZE + n), lextra = buf.subarray(o + LOCAL_SIZE + n, c.dataStart);
        const lids = extraIds(lextra);
        if (lids === null)
            return no('not_zip', i);
        if (lcsize === 0xffffffff || lusize === 0xffffffff || lids.includes(EXTRA_ZIP64))
            return no('zip64', i);
        if (lids.includes(EXTRA_UNICODE_PATH))
            return no('bad_name', i);
        if (lflags !== c.flags || lmethod !== c.method || !lname.equals(c.nameBytes))
            return no('mismatch', i);
        const same = lcrc === c.crc && lcsize === c.csize && lusize === c.usize;
        if (!(c.flags & FLAG_DESCRIPTOR)) {
            if (!same)
                return no('mismatch', i);
            continue;
        }
        // Bit 3: the local header holds zeros (a streaming writer) or the real values; the descriptor after the data must hold them.
        if (!same && (lcrc !== 0 || lcsize !== 0 || lusize !== 0))
            return no('mismatch', i);
        const d = c.dataEnd + (c.dataEnd + 4 <= cdOffset && buf.readUInt32LE(c.dataEnd) === SIG_DESCRIPTOR ? 4 : 0);
        if (buf.readUInt32LE(d) !== c.crc || buf.readUInt32LE(d + 4) !== c.csize || buf.readUInt32LE(d + 8) !== c.usize)
            return no('mismatch', i);
    }
    // ---- the data: inflated with the declared size as the cap, the size and the CRC-32 checked
    const entries = [];
    for (const [i, c] of cds.entries()) {
        const raw = buf.subarray(c.dataStart, c.dataEnd);
        let data;
        if (c.method === 0)
            data = own(raw);
        else {
            try {
                data = zlib.inflateRawSync(raw, { maxOutputLength: Math.max(1, c.usize) });
            } // the minimum Node accepts is 1
            catch (err) {
                return no(err.code === 'ERR_BUFFER_TOO_LARGE' ? 'too_large' : 'crc', i);
            }
            if (data.byteOffset !== 0 || data.buffer.byteLength !== data.length)
                data = own(data);
        }
        if (data.length !== c.usize)
            return no(data.length > c.usize ? 'too_large' : 'mismatch', i);
        if (zlib.crc32(data) >>> 0 !== c.crc)
            return no('crc', i);
        entries.push({ name: c.name, dir: c.dir, size: c.usize, data: c.dir ? null : data });
    }
    return { ok: true, entries };
}
const diskError = (what) => Object.assign(new Error(`extract: ${what}`), { code: 'disk' });
const errnoOf = (e) => (typeof e?.code === 'string' ? e.code : 'error');
/**
 * Write checked entries (readZip's) into `dir`: an empty real folder, or a new one (its parent must exist). Folders 0755, files
 * created exclusively (`wx`, which never follows a link) with 0644 (the process umask still applies); the archive's own modes are
 * never used. Any failure removes what this call made and throws coded `disk` naming the error code only, never a path.
 */
function extractTo(entries, dir) {
    const root = node_path_1.default.resolve(dir); // drops a trailing separator, through which lstat would follow a link
    for (const e of entries)
        if (nameProblem(e.name, exports.ZIP_LIMITS.maxPath, exports.ZIP_LIMITS.maxDepth) !== null)
            throw diskError('unsafe entry name');
    const made = [];
    let st = null;
    try {
        st = fs.lstatSync(root);
    }
    catch (e) {
        if (errnoOf(e) !== 'ENOENT')
            throw diskError(errnoOf(e));
    }
    if (st) {
        if (!st.isDirectory())
            throw diskError('target is not a folder'); // a link to a folder included
        if (fs.readdirSync(root).length !== 0)
            throw diskError('target is not empty');
    }
    try {
        if (!st) {
            fs.mkdirSync(root, { mode: 0o755 });
            made.push({ p: root, dir: true });
        }
        const folders = new Set();
        for (const e of entries) {
            const segments = e.name.split('/');
            for (let k = 1; k <= segments.length - (e.dir ? 0 : 1); k++) {
                const rel = segments.slice(0, k).join('/');
                if (folders.has(rel))
                    continue;
                const p = node_path_1.default.join(root, ...segments.slice(0, k));
                fs.mkdirSync(p, { mode: 0o755 }); // EEXIST for anything this call did not make, a link included
                made.push({ p, dir: true });
                folders.add(rel);
            }
            if (e.dir)
                continue;
            if (e.data === null)
                throw diskError('file entry without data');
            const p = node_path_1.default.join(root, ...segments);
            const fd = fs.openSync(p, 'wx', 0o644);
            made.push({ p, dir: false });
            try {
                fs.writeFileSync(fd, e.data);
            }
            finally {
                fs.closeSync(fd);
            }
        }
    }
    catch (err) {
        for (const m of made.reverse()) {
            try {
                if (m.dir)
                    fs.rmdirSync(m.p);
                else
                    fs.unlinkSync(m.p);
            }
            catch { /* best effort */ }
        }
        throw err.code === 'disk' ? err : diskError(errnoOf(err));
    }
}
