"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.thousands = void 0;
// GENERATED from host/shared/numfmt.ts by scripts/sync-shared.mjs: do not edit.
// A whole number with thousands separators ("1,024"), the one form of every quota the host words: the Privacy page's `3 MB of 1,024 MB` and the permission lines
// (`Keep a database of up to 1,024 MB`). Pure, no imports. Copied into src/ and renderer-src/ by scripts/sync-shared.mjs; edit this file, never a copy.
const thousands = (n) => n.toLocaleString('en-US');
exports.thousands = thousands;
