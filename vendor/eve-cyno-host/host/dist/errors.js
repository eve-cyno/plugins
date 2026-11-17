"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.coded = exports.isHostError = void 0;
// Errors thrown by host code: the marker tells the dispatcher that code and message are safe to show a plugin as they are.
// (Errors that come from the sidecar or from a bug carry no marker and get fixed messages.)
const hostErrors = new WeakSet();
const isHostError = (e) => typeof e === 'object' && e !== null && hostErrors.has(e);
exports.isHostError = isHostError;
const coded = (code, message) => {
    const e = Object.assign(new Error(message), { code });
    hostErrors.add(e);
    return e;
};
exports.coded = coded;
