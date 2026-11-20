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
exports.READ_TRIES = void 0;
exports.renameWithRetry = renameWithRetry;
exports.writeFileAtomic = writeFileAtomic;
exports.renameWithRetryAsync = renameWithRetryAsync;
exports.writeFileAtomicAsync = writeFileAtomicAsync;
exports.quarantine = quarantine;
exports.readJsonDetailed = readJsonDetailed;
// Crash-safe small JSON files (grants, plugin storage). Pure Node, no Electron.
const crypto = __importStar(require("node:crypto"));
const fs = __importStar(require("node:fs"));
const path = __importStar(require("node:path"));
const codeOf = (e) => e?.code ?? 'error';
// Only the error code is ever logged: never file content, never an fs message (those carry paths).
const warn = (what, e) => console.warn(`atomicfile: ${what} failed (${codeOf(e)})`);
const sleepSync = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
/** readJsonDetailed tries a held file this many times before it answers `busy`. */
exports.READ_TRIES = 10;
const WIN_BUSY = new Set(['EPERM', 'EACCES', 'EBUSY']);
// Windows refuses a rename over a file that an antivirus scanner or indexer has open for a moment: retry briefly.
function renameWithRetry(from, to) {
    const tries = process.platform === 'win32' ? 10 : 1;
    for (let i = 1;; i++) {
        try {
            fs.renameSync(from, to);
            return;
        }
        catch (e) {
            if (i >= tries || !WIN_BUSY.has(codeOf(e)))
                throw e;
            sleepSync(25);
        }
    }
}
// Writes <file>.<pid>.<random>.tmp (mode 0600), fsyncs it, renames it over the target, then fsyncs the directory so the rename itself is
// durable. Windows cannot open a directory for fsync: skipped there; a directory-fsync error is ignored everywhere.
function writeFileAtomic(file, data) {
    // A unique name opened with O_EXCL (never a planted symlink or a file another instance is writing).
    const tmp = `${file}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
    const fd = fs.openSync(tmp, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | (fs.constants.O_NOFOLLOW ?? 0), 0o600);
    try {
        try {
            fs.writeFileSync(fd, data);
            fs.fsyncSync(fd);
        }
        finally {
            fs.closeSync(fd);
        }
        renameWithRetry(tmp, file);
    }
    catch (e) {
        try {
            fs.unlinkSync(tmp);
        }
        catch { /* already gone */ }
        throw e;
    }
    if (process.platform === 'win32')
        return;
    try {
        const dfd = fs.openSync(path.dirname(file), 'r');
        try {
            fs.fsyncSync(dfd);
        }
        finally {
            fs.closeSync(dfd);
        }
    }
    catch { /* the rename happened; durability of the directory entry is best effort */ }
}
async function renameWithRetryAsync(from, to) {
    const tries = process.platform === 'win32' ? 10 : 1;
    for (let i = 1;; i++) {
        try {
            await fs.promises.rename(from, to);
            return;
        }
        catch (e) {
            if (i >= tries || !WIN_BUSY.has(codeOf(e)))
                throw e;
            await new Promise(r => setTimeout(r, 25));
        }
    }
}
// writeFileAtomic without blocking the main process: the same unique temp file (O_EXCL | O_NOFOLLOW, mode 0600), fsync, rename over the
// target (retried on Windows), directory fsync (not on Windows). For a target the user picked, which may sit on a slow or remote volume
// (a USB stick, an SMB share): a synchronous write there would freeze every window. The temp file is removed when a step fails.
async function writeFileAtomicAsync(file, data) {
    const tmp = `${file}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
    const fh = await fs.promises.open(tmp, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | (fs.constants.O_NOFOLLOW ?? 0), 0o600);
    try {
        try {
            await fh.writeFile(data);
            await fh.sync();
        }
        finally {
            await fh.close();
        }
        await renameWithRetryAsync(tmp, file);
    }
    catch (e) {
        await fs.promises.unlink(tmp).catch(() => undefined);
        throw e;
    }
    if (process.platform === 'win32')
        return;
    try {
        const dh = await fs.promises.open(path.dirname(file), 'r');
        try {
            await dh.sync();
        }
        finally {
            await dh.close();
        }
    }
    catch { /* the rename happened; durability of the directory entry is best effort */ }
}
// Renames file to <file>.corrupt-<epochMs>, adding -1, -2... when that name exists (an earlier copy is never overwritten).
// false when it could not be moved; the file is then left alone.
function quarantine(file) {
    const stamp = `${file}.corrupt-${Date.now()}`;
    for (let i = 0; i < 1000; i++) {
        const target = i === 0 ? stamp : `${stamp}-${i}`;
        if (fs.existsSync(target))
            continue;
        try {
            fs.renameSync(file, target);
            return true;
        }
        catch (e) {
            warn('quarantine', e);
            return false;
        }
    }
    return false;
}
// Never throws. Missing: no file. Quarantined: unparseable, wrong shape (`accept` said no) or unreadable and moved aside;
// a copy stays for inspection. Busy (Windows only: EACCES/EBUSY/EPERM still after 10 tries, 25 ms apart): the file is left
// exactly where it is, because a good file that is only locked for a moment must not be moved or overwritten.
function readJsonDetailed(file, accept, io) {
    const read = io?.readFileSync ?? ((f, enc) => fs.readFileSync(f, enc));
    const win = io?.win32 ?? process.platform === 'win32';
    const sleep = io?.sleep ?? sleepSync;
    let text;
    for (let i = 1;; i++) {
        try {
            text = read(file, 'utf8');
            break;
        }
        catch (e) {
            const c = codeOf(e);
            if (c === 'ENOENT')
                return { status: 'missing' };
            if (win && WIN_BUSY.has(c)) {
                if (i < exports.READ_TRIES) {
                    sleep(25);
                    continue;
                }
                warn('read', e);
                return { status: 'busy' };
            }
            warn('read', e);
            quarantine(file);
            return { status: 'quarantined' };
        }
    }
    let v;
    try {
        v = JSON.parse(text);
    }
    catch {
        quarantine(file);
        return { status: 'quarantined' };
    }
    if (accept && !accept(v)) {
        quarantine(file);
        return { status: 'quarantined' };
    }
    return { status: 'ok', value: v };
}
