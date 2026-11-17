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
exports.readCache = readCache;
// Reads one of the presence caches (presence.json, esi-names.json). Unlike the house reader a corrupt file is deleted, not moved aside:
// both are caches that ESI rebuilds, and presence.json holds the user's wallet and location, which must not linger in a copy.
// A Windows lock (EACCES/EBUSY/EPERM after 10 tries, 25 ms apart) leaves the file exactly where it is. Never throws. Pure Node.
const fs = __importStar(require("node:fs"));
const BUSY = new Set(['EPERM', 'EACCES', 'EBUSY']);
const codeOf = (e) => e?.code ?? 'error';
const sleepSync = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
function readCache(file, accept, io) {
    const read = io?.readFileSync ?? ((f, enc) => fs.readFileSync(f, enc));
    const win = io?.win32 ?? process.platform === 'win32';
    const sleep = io?.sleep ?? sleepSync;
    const discard = () => { try {
        fs.unlinkSync(file);
    }
    catch { /* it stays; the next write replaces it */ } return { status: 'discarded' }; };
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
            if (win && BUSY.has(c)) {
                if (i < 10) {
                    sleep(25);
                    continue;
                }
                return { status: 'busy' };
            }
            return discard();
        }
    }
    let v;
    try {
        v = JSON.parse(text);
    }
    catch {
        return discard();
    }
    return accept(v) ? { status: 'ok', value: v } : discard();
}
