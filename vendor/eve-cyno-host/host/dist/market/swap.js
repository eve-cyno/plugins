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
exports.busyIO = void 0;
exports.swapPluginDir = swapPluginDir;
exports.rollbackSwap = rollbackSwap;
exports.recoverSwap = recoverSwap;
exports.retryBusy = retryBusy;
exports.productSwapFs = productSwapFs;
// Crash-safe replacement of an installed plugin folder by a staged one (R26, R29; plan Task 6). Pure Node, no Electron: every disk
// effect goes through a SwapFs (productSwapFs is the real one; the self-test wraps it to inject a crash after any call).
//
// Layout (paths.ts, plan Persistence): the installed folder T = <plugins>/installed/<id>, the staged folder F = <plugins>/staging/<random>/<id>,
// the journal <plugins>/staging/swap.json. The old version is parked at O = F + '.old', next to the staged copy. The two roots are siblings
// under <plugins>, so the renames stay on one file system; one that does not (a mount or a link in between) fails with EXDEV and moves
// nothing, and is refused as `cross_device`. Nothing here ever copies a folder.
//
// swapPluginDir: the journal {id, from, to, old} (paths relative to <plugins>, '/'-separated) is written atomically before anything moves, then
//   step 1  rename T -> O    the old version parked next to the staged one;
//   step 2  rename F -> T    the new version in place;
//   step 3  the journal removed: the swap is done. O stays for rollback() and goes with the staging folder (the caller's cleanup).
// A step that fails is undone at once; the result names the step and its code.
//
// Recovery (recoverSwap at start, the undo of a failed step, rollback()) always puts the old version back. It reads which of F, T and O
// exist, which tells every point of the swap apart without a write between the renames; each folder only ever moves by rename, so each
// one is complete at every moment:
//   F, T, no O     nothing moved yet, or a rollback that finished: only the journal goes        -> 'cleaned'
//   F, O, no T     after step 1: O -> T                                                       -> 'rolled_back'
//   T, O, no F     after step 2: T -> F, then O -> T (a crash between them is the row above)    -> 'rolled_back'
//   anything else  never made here: nothing is moved, only the journal goes                     -> 'cleaned'
// T is absent only between two renames (no file system replaces a folder in one step), and only while the journal names where the old one is.
// The journal goes only after the folders are back, so a recovery that is interrupted runs again at the next start. A journal this module
// did not write (unreadable, cut short, naming folders outside this layout) is never acted on: recoverSwap throws `bad_journal` and leaves
// it, and a caller that sees recoverSwap throw leaves the staging folder alone.
//
// Windows: a rename or a removal held by a scanner or an indexer (EBUSY, EPERM, EACCES) is retried with B5a's busyPolicy (fetchbounded.ts):
// up to 10 tries, the waits doubling from 50 ms to at most 2 s (about 9 s in all). The wait is synchronous, because SwapFs is.
// Log lines carry the plugin id, the step and error codes only (never a path).
const fs = __importStar(require("node:fs"));
const path = __importStar(require("node:path"));
const atomicfile_1 = require("../atomicfile");
const fetchbounded_1 = require("../fetchbounded");
const manifest_1 = require("../manifest");
const MAX_JOURNAL_BYTES = 16_384;
const codeOf = (e) => {
    const c = e?.code;
    return typeof c === 'string' && /^[A-Za-z_]{1,32}$/.test(c) ? c : 'error';
};
const swapError = (code) => Object.assign(new Error(`plugin folder swap: ${code}`), { code });
const warn = (id, what) => { console.warn(`swap ${id}: ${what}`); };
/** Two spellings of one path (path.relative is case-insensitive on win32). */
const samePath = (a, b) => path.relative(a, b) === '';
/** The swap's folders when the three paths fit the layout above, else null. */
function pathsOf(staged, target, journal) {
    if (![staged, target, journal].every(p => typeof p === 'string' && path.isAbsolute(p)))
        return null;
    const F = path.resolve(staged), T = path.resolve(target), J = path.resolve(journal);
    const stagingRoot = path.dirname(J), plugins = path.dirname(stagingRoot), installedRoot = path.dirname(T);
    const id = path.basename(T), random = path.basename(path.dirname(F));
    if (!(0, manifest_1.isPluginId)(id) || path.basename(F) !== id)
        return null;
    if (!samePath(path.dirname(path.dirname(F)), stagingRoot))
        return null; // F = <staging>/<random>/<id>, the journal in <staging>
    if (!samePath(path.dirname(installedRoot), plugins) || samePath(installedRoot, stagingRoot))
        return null; // the two roots are siblings
    const s = path.basename(stagingRoot), i = path.basename(installedRoot);
    return { F, T, O: F + '.old', journal: J, j: { id, from: `${s}/${random}/${id}`, to: `${i}/${id}`, old: `${s}/${random}/${id}.old` } };
}
/** The journal's folders, or null when there is none. Throws `bad_journal` for one this module did not write, or the read's error code. */
function readJournal(journal, f) {
    if (!f.exists(journal))
        return null;
    let text;
    try {
        text = retryBusy(() => {
            const st = fs.lstatSync(journal);
            if (!st.isFile() || st.size > MAX_JOURNAL_BYTES)
                throw swapError('bad_journal');
            return fs.readFileSync(journal, 'utf8');
        });
    }
    catch (e) {
        throw swapError(codeOf(e));
    }
    let v;
    try {
        v = JSON.parse(text);
    }
    catch {
        throw swapError('bad_journal');
    }
    const o = (typeof v === 'object' && v !== null && !Array.isArray(v) ? v : {});
    const str = (x) => typeof x === 'string' && x.length > 0 && x.length <= 512;
    if (!str(o.id) || !str(o.from) || !str(o.to) || !str(o.old))
        throw swapError('bad_journal');
    const plugins = path.dirname(path.dirname(journal));
    const abs = (rel) => path.join(plugins, ...rel.split('/'));
    const p = pathsOf(abs(o.from), abs(o.to), journal);
    // Rebuilt from the layout, it must say exactly what the file says: no '..', no other root, no other id, the parking place next to F.
    if (!p || p.j.id !== o.id || p.j.from !== o.from || p.j.to !== o.to || p.j.old !== o.old)
        throw swapError('bad_journal');
    return p;
}
/** Puts the old version back at T, by which folders exist (the table above). Throws when a rename fails: the journal then stays. */
function putOldBack(p, f) {
    const hasF = f.exists(p.F), hasT = f.exists(p.T), hasO = f.exists(p.O);
    if (hasO && !hasT) {
        f.rename(p.O, p.T);
        return 'rolled_back';
    }
    if (hasO && hasT && !hasF) {
        f.rename(p.T, p.F);
        f.rename(p.O, p.T);
        return 'rolled_back';
    }
    return 'cleaned';
}
/** Best effort once the folders are where they belong: a journal left behind describes nothing to move (recoverSwap only removes it). */
function dropJournal(p, f) {
    try {
        f.writeJournal(p.journal, null);
    }
    catch (e) {
        warn(p.j.id, `journal not removed (${codeOf(e)})`);
    }
}
const failed = (step, code) => ({ ok: false, step, code });
/**
 * Replaces the installed folder `target` by the staged folder `staged` (the layout above), journaled in `journal`. Step 1 in a failure means
 * nothing moved: a path outside the layout (`bad_path`), an earlier journal not yet recovered (`journal`, never overwritten), a folder
 * missing (`missing`) or the parking place taken (`exists`), the journal write or the first rename. A later step that fails is undone
 * before this returns; `undo_failed` means the undo failed too and the journal stays for recoverSwap. `cross_device` is a rename that
 * would cross file systems. ok: the new folder is at `target`; rollback() puts the old one back (journaled the same way) and throws when it
 * cannot (`missing`: the old folder is no longer parked; nothing moved then).
 */
function swapPluginDir(staged, target, journal, f) {
    const p = pathsOf(staged, target, journal);
    if (!p)
        return failed(1, 'bad_path');
    try {
        if (f.exists(p.journal))
            return failed(1, 'journal');
        if (!f.exists(p.F) || !f.exists(p.T))
            return failed(1, 'missing');
        if (f.exists(p.O))
            return failed(1, 'exists');
    }
    catch (e) {
        return failed(1, codeOf(e));
    }
    try {
        f.writeJournal(p.journal, p.j);
    }
    catch (e) {
        dropJournal(p, f);
        return failed(1, codeOf(e));
    }
    let step = 1;
    try {
        f.rename(p.T, p.O);
        step = 2;
        f.rename(p.F, p.T);
        step = 3;
        f.writeJournal(p.journal, null);
    }
    catch (e) {
        const code = codeOf(e) === 'EXDEV' ? 'cross_device' : codeOf(e);
        try {
            putOldBack(p, f);
        }
        catch (u) {
            warn(p.j.id, `step ${step} failed (${code}); undo failed (${codeOf(u)})`);
            return failed(step, 'undo_failed');
        }
        dropJournal(p, f);
        return failed(step, code);
    }
    return { ok: true, rollback: () => rollback(p, f) };
}
function rollback(p, f) {
    if (f.exists(p.journal))
        throw swapError('journal');
    if (f.exists(p.F) || !f.exists(p.T) || !f.exists(p.O))
        throw swapError('missing');
    f.writeJournal(p.journal, p.j);
    putOldBack(p, f); // throws: the journal stays and recoverSwap finishes it at the next start
    dropJournal(p, f);
}
/**
 * The rollback() of a swap an earlier run finished (its journal gone, the old version still parked at `staged` + '.old', the staged folder
 * gone): the same layout check, the same checks and the same journal. Throws `bad_path`, or as rollback() does.
 */
function rollbackSwap(staged, target, journal, f) {
    const p = pathsOf(staged, target, journal);
    if (!p)
        throw swapError('bad_path');
    rollback(p, f);
}
/**
 * At start, before any plugin is registered: finishes what a journal left (the old version back at its place) and removes the journal.
 * 'none': no journal. Throws (the journal then stays, and the staging folder must be left alone): `bad_journal`, a path that is not
 * absolute (`bad_path`), or the code of a rename or read that failed.
 */
function recoverSwap(journal, f) {
    if (typeof journal !== 'string' || !path.isAbsolute(journal))
        throw swapError('bad_path');
    const p = readJournal(path.resolve(journal), f);
    if (!p)
        return 'none';
    const r = putOldBack(p, f);
    f.writeJournal(p.journal, null);
    return r;
}
const sleepSync = (ms) => { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); };
/** The product rule: busyPolicy's switch, tries and cap as they are now (tests may change busyPolicy). */
const busyIO = () => ({ win32: fetchbounded_1.busyPolicy.win32, tries: fetchbounded_1.busyPolicy.tries, maxWaitMs: fetchbounded_1.busyPolicy.maxWaitMs, sleep: sleepSync });
exports.busyIO = busyIO;
const BUSY = new Set(['EBUSY', 'EPERM', 'EACCES']);
/** Runs `op`, retried while Windows reports the file held, with busyPolicy's back-off (as fetchbounded.ts's busyRetry, synchronously). */
function retryBusy(op, io = (0, exports.busyIO)()) {
    for (let i = 1;; i++) {
        try {
            return op();
        }
        catch (e) {
            if (!io.win32 || i >= io.tries || !BUSY.has(codeOf(e)))
                throw e;
            io.sleep(Math.min(50 * 2 ** (i - 1), io.maxWaitMs));
        }
    }
}
/** The parent directory's entry made durable after a rename or a removal (Linux; Windows cannot open a directory). Best effort. */
function syncDir(dir) {
    if (process.platform === 'win32')
        return;
    try {
        const fd = fs.openSync(dir, 'r');
        try {
            fs.fsyncSync(fd);
        }
        finally {
            fs.closeSync(fd);
        }
    }
    catch { /* the rename happened; the durability of the entry is best effort */ }
}
/**
 * The real SwapFs: renames and removals retried while busy (Windows), each rename made durable before the next step (both parent folders
 * fsynced), `exists` by lstat (a link counts; an error other than "not there" throws rather than answer wrongly), the journal written with
 * writeFileAtomic (mode 0600, fsynced). `rm` is the same busy-retried recursive removal, for the caller's staging cleanup.
 */
function productSwapFs(o = {}) {
    const busy = () => o.busy ?? (0, exports.busyIO)();
    const rename = o.renameSync ?? ((a, b) => fs.renameSync(a, b));
    return {
        rename(from, to) {
            retryBusy(() => rename(from, to), busy());
            syncDir(path.dirname(from));
            syncDir(path.dirname(to));
        },
        rm(dir) { retryBusy(() => fs.rmSync(dir, { recursive: true, force: true }), busy()); },
        exists(p) {
            try {
                fs.lstatSync(p);
                return true;
            }
            catch (e) {
                const c = codeOf(e);
                if (c === 'ENOENT' || c === 'ENOTDIR')
                    return false;
                throw e;
            }
        },
        writeJournal(file, j) {
            if (j === null) {
                retryBusy(() => fs.rmSync(file, { force: true }), busy());
                syncDir(path.dirname(file));
            }
            else
                retryBusy(() => (0, atomicfile_1.writeFileAtomic)(file, JSON.stringify(j) + '\n'), busy());
        },
    };
}
