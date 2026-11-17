"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ServeBudget = exports.ServeBusy = exports.SERVE_BUDGET_BYTES = exports.MAX_SERVED_FILE_BYTES = void 0;
// Bounds on what the eve-plugin:// scheme holds in memory for one plugin. A served file is read whole (from its checked
// descriptor) and then streamed to the page, so the bytes of every response that has not finished yet are in memory at once:
// a page that requests many large files in a row must not be able to hold them all. Pure (no Electron).
exports.MAX_SERVED_FILE_BYTES = 16 * 1024 * 1024; // one file
exports.SERVE_BUDGET_BYTES = 64 * 1024 * 1024; // all responses of one plugin that are still in flight
/** Raised by readPluginFile when the plugin's in-flight budget is used up; the scheme answers 503. */
class ServeBusy extends Error {
    constructor() { super('serve budget exhausted'); }
}
exports.ServeBusy = ServeBusy;
class ServeBudget {
    limit;
    used = 0;
    gen = 0;
    constructor(limit = exports.SERVE_BUDGET_BYTES) {
        this.limit = limit;
    }
    /** Bytes of responses that have not completed (or been aborted) yet. */
    get inFlight() { return this.used; }
    /** Reserves `bytes`; returns the lease's release function (safe to call more than once), or null when over the budget. */
    take(bytes) {
        if (bytes > this.limit - this.used)
            return null;
        this.used += bytes;
        let done = false;
        const gen = this.gen;
        return () => { if (!done) {
            done = true;
            if (gen === this.gen)
                this.used -= bytes;
        } };
    }
    /** Forgets every lease (the page they served is gone): leases taken before this call become no-ops. */
    reset() { this.used = 0; this.gen++; }
}
exports.ServeBudget = ServeBudget;
