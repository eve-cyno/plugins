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
Object.defineProperty(exports, "__esModule", { value: true });
exports.InstallRecords = void 0;
exports.recordOf = recordOf;
exports.dirIdentity = dirIdentity;
// The install records (R26, D30): <userData>/market/installed.json keeps, for each plugin installed from the marketplace, its version, the
// archive's SHA-256, the listing's firstParty flag, the installed folder's device and inode (decimal strings of the bigint lstat) and when.
// A folder in the installed root is `market` only while its device, inode and version match its record (sourceOf); a folder replaced by a
// copy (a new inode) or edited to another version is `manual` (the prompt says "not signed"; the names rule treats it as a manual install).
// `bundled` is the caller's answer (isBuiltIn): sourceOf answers from the records and the folder only.
// Read once, lazily, with every known field checked: a missing or unreadable file is empty, a malformed one is moved aside as
// installed.json.corrupt-<ms> (readJsonDetailed) and read as empty, never thrown; a malformed record is dropped alone; unknown fields
// are dropped. A write replaces the whole file atomically (writeFileAtomic: a temporary file, fsync, rename, mode 0600), and the records in
// memory change only once it succeeded. Windows: a file held by another process (a scanner) reads as empty for now and is never written
// over (set and delete throw `busy`); it is read again at the next call.
const fs = __importStar(require("node:fs"));
const path = __importStar(require("node:path"));
const atomicfile_1 = require("../atomicfile");
const manifest_1 = require("../manifest");
const SHA = /^[0-9a-f]{64}$/;
const DEV = /^(0|[1-9]\d{0,19})$/; // lstat reports device 0 on Windows (manifest.ts sameRegularFile): kept as it is, on both sides
const INO = /^[1-9]\d{0,19}$/; // inode 0 is a volume without file ids: never an identity
const AT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/;
const isObj = (v) => typeof v === 'object' && v !== null && !Array.isArray(v);
const recordsError = (code) => Object.assign(new Error(`install records: ${code}`), { code });
/** The record with its known fields only, or null when one of them is missing or malformed (also market/state.json's staged `prev`). */
function recordOf(v) {
    if (!isObj(v))
        return null;
    const { version, sha256, firstParty, dev, ino, at } = v;
    if (typeof version !== 'string' || version.length > 256 || !manifest_1.SEMVER.test(version))
        return null;
    if (typeof sha256 !== 'string' || !SHA.test(sha256) || typeof firstParty !== 'boolean')
        return null;
    if (typeof dev !== 'string' || !DEV.test(dev) || typeof ino !== 'string' || !INO.test(ino))
        return null;
    if (typeof at !== 'string' || !AT.test(at) || !Number.isFinite(Date.parse(at)))
        return null;
    return { version, sha256, firstParty, dev, ino, at };
}
/**
 * A folder's identity as a record keeps it (lstat, bigint, so large Windows file ids compare exactly): null for anything but a real folder
 * (a link is not followed), or on a volume without file ids (inode 0). The installer takes the record's identity with this same function.
 */
function dirIdentity(dir, lstat = fs.lstatSync) {
    try {
        const st = lstat(dir, { bigint: true });
        if (!st.isDirectory() || st.ino === 0n)
            return null;
        return { dev: String(st.dev), ino: String(st.ino) };
    }
    catch {
        return null;
    }
}
const empty = () => Object.create(null); // no inherited member answers a lookup by plugin id
class InstallRecords {
    file;
    io;
    held = null; // null: not read yet, or the file was held by another process at the last try
    constructor(file, io = {}) {
        this.file = file;
        this.io = io;
    }
    load() {
        if (this.held)
            return this.held;
        const r = (0, atomicfile_1.readJsonDetailed)(this.file, isObj, this.io.read);
        if (r.status === 'busy')
            return null;
        const m = empty();
        if (r.status === 'ok' && isObj(r.value)) {
            for (const [id, v] of Object.entries(r.value)) {
                const rec = (0, manifest_1.isPluginId)(id) ? recordOf(v) : null;
                if (rec)
                    m[id] = rec;
            }
        }
        return (this.held = m);
    }
    /** The records to change: never a view of a file that could not be read (it would replace the good one). */
    writable() {
        const m = this.load();
        if (!m)
            throw recordsError('busy');
        return m;
    }
    save(next) {
        const out = {};
        for (const id of Object.keys(next).sort())
            out[id] = next[id]; // plugin ids only (never __proto__)
        const data = JSON.stringify(out, null, 2) + '\n';
        if (this.io.write)
            this.io.write(this.file, data);
        else {
            fs.mkdirSync(path.dirname(this.file), { recursive: true });
            (0, atomicfile_1.writeFileAtomic)(this.file, data);
        }
        this.held = next;
    }
    /** A copy of the record (the held one cannot be changed through it). */
    get(id) {
        const m = this.load();
        return m && Object.hasOwn(m, id) ? { ...m[id] } : undefined;
    }
    /** Writes the record (known fields only). Throws `bad_record` for a malformed one or id, `busy`, or the write's error code. */
    set(id, r) {
        const rec = recordOf(r);
        if (typeof id !== 'string' || !(0, manifest_1.isPluginId)(id) || !rec)
            throw recordsError('bad_record');
        const next = Object.assign(empty(), this.writable());
        next[id] = rec;
        this.save(next);
    }
    /** Removes the record (uninstall). No record: nothing is written. Throws `busy` or the write's error code. */
    delete(id) {
        const m = this.writable();
        if (!Object.hasOwn(m, id))
            return;
        const next = Object.assign(empty(), m);
        delete next[id];
        this.save(next);
    }
    /** `market` while the folder `dir` is the recorded one (device, inode) at the recorded version; otherwise `manual`. */
    sourceOf(id, version, dir) {
        const r = this.get(id);
        if (!r || r.version !== version)
            return 'manual';
        const now = dirIdentity(dir, this.io.lstat);
        return now !== null && now.dev === r.dev && now.ino === r.ino ? 'market' : 'manual';
    }
}
exports.InstallRecords = InstallRecords;
