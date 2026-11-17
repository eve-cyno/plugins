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
exports.isAppImageRun = exports.desktopEntry = exports.iconPath = exports.desktopEntryPath = exports.launchCommand = exports.MARKER = exports.ICON_SIZES = exports.appId = void 0;
exports.execLine = execLine;
exports.pngText = pngText;
exports.withPngText = withPngText;
exports.ensureDesktopEntry = ensureDesktopEntry;
exports.removeDesktopIntegration = removeDesktopIntegration;
// The AppImage's desktop integration (R15, D16): the XDG portal (global shortcuts) identifies the app by its app id and wants
// <appId>.desktop in the user's applications directory, the app menu lists the product entry, and the icon theme finds the
// packaged icon set under the app id. --remove-desktop-integration undoes it. Pure Node, no Electron.
const fs = __importStar(require("node:fs"));
const path = __importStar(require("node:path"));
const atomicfile_1 = require("./atomicfile");
const appId = (testBuild) => testBuild ? 'dev.evecyno.desktop.test' : 'dev.evecyno.desktop';
exports.appId = appId;
// The packaged icon set (host/build/icons/<n>x<n>.png, written by scripts/build-icons.cjs): 16-32 px from the favicon, 48-512 px from the app tile.
exports.ICON_SIZES = [16, 24, 32, 48, 64, 128, 256, 512];
// Every file the integration writes carries this marker, and only marked files are ever removed: the entry as its own key line, each
// icon as a PNG tEXt chunk (build-icons.cjs writes it into the PNGs).
exports.MARKER = { key: 'X-EVE-Cyno-Generated', value: 'true' };
const MARKER_LINE = `${exports.MARKER.key}=${exports.MARKER.value}`;
// $APPIMAGE is the AppImage file itself; process.execPath inside it is the extracted launcher, which dies once the mount goes away.
const launchCommand = (env, execPath) => env.APPIMAGE || execPath;
exports.launchCommand = launchCommand;
// Desktop Entry spec: an argument with a reserved character is double-quoted and " ` $ \ are backslash-escaped inside;
// the value is then a string, so every backslash doubles again; % is a field code, so a literal one is %%.
const RESERVED = /[ \t\n"'\\><~|&;$*?#()`]/;
function execLine(cmd) {
    const quoted = RESERVED.test(cmd) ? `"${cmd.replace(/["`$\\]/g, '\\$&')}"` : cmd;
    return `${quoted.replace(/\\/g, '\\\\').replace(/%/g, '%%')} %u`;
}
const dataHome = (env, home) => {
    const x = env.XDG_DATA_HOME;
    return x && path.isAbsolute(x) ? x : path.join(home, '.local', 'share');
};
const desktopEntryPath = (env, home, id) => path.join(dataHome(env, home), 'applications', `${id}.desktop`);
exports.desktopEntryPath = desktopEntryPath;
// The icon theme lookup for Icon=<appId>: the user's hicolor theme, one directory per size.
const iconPath = (env, home, id, size) => path.join(dataHome(env, home), 'icons', 'hicolor', `${size}x${size}`, 'apps', `${id}.png`);
exports.iconPath = iconPath;
// StartupWMClass: measured from a running AppImage window (xprop): Electron derives WM_CLASS from package.json desktopName, which is the app id
// plus .desktop (the test build sets its own via extraMetadata), so the product and test classes differ.
// No MimeType line: production sign-in uses the loopback callback, so no URL scheme is registered.
// NoDisplay: the product entry is in the app menu (Categories places it under Games); the test entry stays hidden (D16).
const desktopEntry = (o) => ['[Desktop Entry]', 'Type=Application', `Name=${o.name}`, `Exec=${o.exec}`, `Icon=${o.id}`, 'Terminal=false', `NoDisplay=${o.noDisplay}`, 'Categories=Game;',
    `StartupWMClass=${o.id}`, MARKER_LINE, ''].join('\n');
exports.desktopEntry = desktopEntry;
// An AppImage run: the runtime sets APPIMAGE (the file) and APPDIR (the mount) and starts us from inside APPDIR. A value
// inherited by a dev or test run fails the last test, so it never writes the real entry.
const isAppImageRun = (env, execPath) => {
    if (!env.APPIMAGE || !path.isAbsolute(env.APPIMAGE) || !env.APPDIR)
        return false;
    try {
        return !path.relative(fs.realpathSync(env.APPDIR), execPath).startsWith('..');
    } // the mount may be reached through a link
    catch {
        return false;
    }
};
exports.isAppImageRun = isAppImageRun;
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
/** The tEXt chunks of a PNG (keyword -> text, Latin-1), read up to IDAT or the end of the buffer; empty for anything that is not a PNG. */
function pngText(b) {
    const out = new Map();
    if (b.length < 8 || !b.subarray(0, 8).equals(PNG_SIGNATURE))
        return out;
    for (let i = 8; i + 8 <= b.length;) {
        const len = b.readUInt32BE(i), type = b.toString('latin1', i + 4, i + 8);
        if (type === 'IDAT' || type === 'IEND' || i + 12 + len > b.length)
            break;
        if (type === 'tEXt') {
            const data = b.subarray(i + 8, i + 8 + len), nul = data.indexOf(0);
            if (nul > 0)
                out.set(data.toString('latin1', 0, nul), data.toString('latin1', nul + 1));
        }
        i += 12 + len;
    }
    return out;
}
/** `png` with one tEXt chunk (keyword, text) inserted right after IHDR; the CRC is computed. The same layout as build-icons.cjs writes. */
function withPngText(png, keyword, text) {
    if (png.length < 16 || !png.subarray(0, 8).equals(PNG_SIGNATURE) || png.toString('latin1', 12, 16) !== 'IHDR')
        throw new Error('not a PNG');
    const at = 8 + 12 + png.readUInt32BE(8);
    const data = Buffer.from(`${keyword}\0${text}`, 'latin1'), head = Buffer.alloc(8), crc = Buffer.alloc(4);
    head.writeUInt32BE(data.length, 0);
    head.write('tEXt', 4, 'latin1');
    crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0);
    return Buffer.concat([png.subarray(0, at), head, data, crc, png.subarray(at)]);
}
let crcTable;
function crc32(b) {
    if (!crcTable) {
        crcTable = new Uint32Array(256);
        for (let n = 0; n < 256; n++) {
            let c = n;
            for (let k = 0; k < 8; k++)
                c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
            crcTable[n] = c >>> 0;
        }
    }
    let c = 0xffffffff;
    for (const x of b)
        c = crcTable[(c ^ x) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
}
function ensureDesktopEntry(o) {
    if (!(0, exports.isAppImageRun)(o.env, o.execPath)) { // only an AppImage run owns a desktop entry
        if (o.env.APPIMAGE)
            console.error('DESKTOP_ENTRY_SKIPPED', 'not-appimage'); // an inherited or odd value: said once, by code only
        return 'skipped';
    }
    const cmd = (0, exports.launchCommand)(o.env, o.execPath);
    // A control character would end the Exec line and inject keys or groups into the entry.
    if (/[\x00-\x1f\x7f]/.test(cmd)) {
        console.error('DESKTOP_ENTRY_REFUSED', 'control');
        return 'skipped';
    }
    // GLib refuses an entry whose Exec path has a literal %% (it looks up the raw string), so the portal cannot find this app.
    if (cmd.includes('%'))
        console.error('DESKTOP_ENTRY_WARN', 'percent');
    const id = (0, exports.appId)(o.testBuild);
    const file = (0, exports.desktopEntryPath)(o.env, o.home, id);
    const content = (0, exports.desktopEntry)({ id, name: o.testBuild ? 'EVE-Cyno Test' : 'EVE-Cyno', exec: execLine(cmd), noDisplay: o.testBuild });
    let changed = false;
    // The icons go first, so a fresh entry never names an icon that is not there yet. Each size is best effort (written only when its
    // bytes differ): a missing source or an unwritable theme directory never blocks the entry, and is said once.
    if (o.iconDir) {
        let warned = false;
        for (const n of exports.ICON_SIZES) {
            try {
                const bytes = fs.readFileSync(path.join(o.iconDir, `${n}x${n}.png`));
                const dest = (0, exports.iconPath)(o.env, o.home, id, n);
                let have = null;
                try {
                    have = fs.readFileSync(dest);
                }
                catch { /* missing */ }
                if (!have || !have.equals(bytes)) {
                    fs.mkdirSync(path.dirname(dest), { recursive: true });
                    (0, atomicfile_1.writeFileAtomic)(dest, bytes);
                    changed = true;
                }
            }
            catch {
                if (!warned) {
                    warned = true;
                    console.error('DESKTOP_ENTRY_WARN', 'icon');
                }
            }
        }
    }
    let current = null;
    try {
        current = fs.readFileSync(file, 'utf8');
    }
    catch { /* missing: write it */ }
    if (current !== content) {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        (0, atomicfile_1.writeFileAtomic)(file, content);
        changed = true;
    }
    return changed ? 'written' : 'unchanged';
}
/**
 * --remove-desktop-integration: removes this build's desktop entry and icons, but only the files that carry the marker (the entry's
 * `X-EVE-Cyno-Generated=true` line, the icon's tEXt chunk); a file of the same name without it stays. A symbolic link is never
 * followed or removed. Returns how many files went.
 */
function removeDesktopIntegration(o) {
    const id = (0, exports.appId)(o.testBuild);
    const isEntry = (b) => b.toString('utf8').split(/\r?\n/).includes(MARKER_LINE);
    const isIcon = (b) => pngText(b).get(exports.MARKER.key) === exports.MARKER.value;
    const candidates = [
        [(0, exports.desktopEntryPath)(o.env, o.home, id), isEntry],
        ...exports.ICON_SIZES.map(n => [(0, exports.iconPath)(o.env, o.home, id, n), isIcon]),
    ];
    let removed = 0;
    for (const [file, ours] of candidates) {
        const head = readRegularFile(file, 64 * 1024); // the entry is small; an icon's chunk sits right after IHDR
        if (head === null || !ours(head))
            continue;
        try {
            fs.unlinkSync(file);
            removed++;
        }
        catch { /* gone already, or not ours to delete: left alone */ }
    }
    return removed;
}
// The first `max` bytes of a regular file, or null: a missing file, a directory, a symbolic link (never followed: lstat, and O_NOFOLLOW
// where the platform has it) or a read error.
function readRegularFile(file, max) {
    try {
        if (!fs.lstatSync(file).isFile())
            return null;
    }
    catch {
        return null;
    }
    let fd;
    try {
        fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
    }
    catch {
        return null;
    }
    try {
        if (!fs.fstatSync(fd).isFile())
            return null;
        const buf = Buffer.alloc(max);
        return buf.subarray(0, fs.readSync(fd, buf, 0, max, 0));
    }
    catch {
        return null;
    }
    finally {
        fs.closeSync(fd);
    }
}
