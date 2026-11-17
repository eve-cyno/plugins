"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.Cynod = exports.CYNOD_EXIT_LOCKED = exports.restartDelay = exports.timeoutFor = exports.STOP_GRACE_MS = exports.ESI_GET_HOST_LIMIT_MS = exports.DEFAULT_CALL_TIMEOUT_MS = exports.callTimeout = void 0;
// Spawns and supervises the Go sidecar; one JSON object per line on its stdio.
const node_child_process_1 = require("node:child_process");
const node_readline_1 = __importDefault(require("node:readline"));
const node_events_1 = require("node:events");
const sidecarenv_1 = require("./sidecarenv");
/** The rejection of a call the sidecar did not answer within the host's limit for it. */
const callTimeout = (method) => ({ code: 'timeout', message: `${method} timed out`, unanswered: true });
exports.callTimeout = callTimeout;
// A call that gets no answer fails after this long. A call that legitimately waits (vault.wait: the user signs in in a
// browser) has its own entry in CALL_LIMITS below (0: none).
exports.DEFAULT_CALL_TIMEOUT_MS = 30_000;
// Methods the sidecar legitimately answers late, with the limit the host gives them (0: none, the sidecar has its own).
// hotkeys.portalBind: the user may have to confirm a system dialog; the sidecar waits up to 2 min for it.
// vault.refresh waits on a keychain call, which cynod bounds at 60 s (a late answer would otherwise read as a timeout for a call that
// then succeeds). vault.remove first waits for a token refresh of that character to end, its rotation included (the SSO's token request
// and JWKS fetch at 20 s each, the keychain write at 60 s: about 100 s), then deletes the keychain entry (60 s): 170 s.
// The vault secret get/set/delete calls (AI provider and data API keys) wait on a keychain call too: 65 s, above the 60 s keychain bound.
// vault.wait is bounded by the caller (VaultService passes its own limit).
// esi.get and esi.lookup: cynod ends every call by its own deadline (broker.CallDeadline, 25 s) and answers timeout; the host waits longer, and a Go
// test (TestCallDeadlineBelowHostLimit) reads this constant to check the gap is at least 2 s.
exports.ESI_GET_HOST_LIMIT_MS = 30_000;
// esi.forget and esi.keepPartitions: best effort (R6); a forget that does not answer within 5 s counts as failed and is sent again after a
// short delay and at the next cynod start (esiforget.ts EsiForgets), so a stuck disk does not hold a revoke or the start for 30 s.
// esi.saveFitting and esi.deleteFitting (Fit L8): cynod ends them by the same CallDeadline as esi.get, so they get the same host limit. A write the
// host stops waiting for is `unanswered` (RpcError) and is never sent again.
const CALL_LIMITS = { 'hotkeys.portalBind': 150_000, 'vault.wait': 0, 'vault.remove': 170_000, 'vault.refresh': 150_000, 'esi.get': exports.ESI_GET_HOST_LIMIT_MS, 'esi.lookup': exports.ESI_GET_HOST_LIMIT_MS,
    'esi.setWaypoint': exports.ESI_GET_HOST_LIMIT_MS, 'esi.saveFitting': exports.ESI_GET_HOST_LIMIT_MS, 'esi.deleteFitting': exports.ESI_GET_HOST_LIMIT_MS,
    'esi.forget': 5_000, 'esi.keepPartitions': 5_000, 'vault.secretGet': 65_000, 'vault.secretSet': 65_000, 'vault.secretDelete': 65_000 };
// The notification that tells cynod the host stopped waiting for a request (cynod/internal/rpc CancelMethod): cynod cancels that
// request's handler and answers neither it nor the notification.
const CANCEL_METHOD = '$/cancel';
// Windows: how long stop() lets cynod end on its own after its stdin is closed before it kills it. cynod's serve returns on the EOF
// within rpc.HandlerGrace (1.5 s) and drains a token rotation for at most 3 s (cmd/cynod rotationDrain).
exports.STOP_GRACE_MS = 5_000;
const timeoutFor = (method) => Object.hasOwn(CALL_LIMITS, method) ? CALL_LIMITS[method] : exports.DEFAULT_CALL_TIMEOUT_MS;
exports.timeoutFor = timeoutFor;
// Restart n (1-based) waits 500 ms * 2^(n-1), at most 30 s. After MAX_RESTARTS restarts without a reset the supervisor
// stops; calls then fail with sidecar_down. A run of RESET_UPTIME_MS or more resets the counter.
const restartDelay = (n) => Math.min(500 * 2 ** (n - 1), 30_000);
exports.restartDelay = restartDelay;
const MAX_RESTARTS = 5;
const RESET_UPTIME_MS = 60_000;
/** `cynod serve` exits with this when another cynod holds the data directory (cmd/cynod exitLocked): a restart would find the same lock, so none is tried. */
exports.CYNOD_EXIT_LOCKED = 75;
class Cynod extends node_events_1.EventEmitter {
    bin;
    env;
    opts;
    proc;
    nextId = 1;
    pending = new Map();
    restarts = 0;
    stopping = false;
    alive = false;
    restartTimer;
    ending; // Windows: the process whose stdin stop() closed
    startedAt = 0;
    clock = () => (this.opts.now ?? (() => performance.now()))();
    /** The data directory this sidecar was started with: the host's resolved profile path (paths.ts profileFor, handed in by main.ts). */
    get dataDir() { return this.env.CYNOD_DATA_DIR; }
    constructor(bin, env, opts = {}) {
        super();
        this.bin = bin;
        this.env = env;
        this.opts = opts;
    }
    start() {
        return new Promise((resolve, reject) => {
            const p = (0, node_child_process_1.spawn)(this.bin, ['serve'], { env: (0, sidecarenv_1.sidecarEnv)(process.platform, process.env, this.env, this.opts.testBuild === true), stdio: ['pipe', 'pipe', 'pipe'] });
            this.proc = p;
            this.alive = true;
            this.startedAt = this.clock();
            // An EPIPE on a dead child must never become an uncaught exception in main.
            p.stdin.on('error', e => console.error('[cynod] stdin:', e.message));
            node_readline_1.default.createInterface({ input: p.stdout }).on('line', l => this.onLine(l));
            node_readline_1.default.createInterface({ input: p.stderr }).on('line', l => (this.opts.onStderr ?? (x => console.error('[cynod]', x)))(l));
            p.once('spawn', () => { resolve(); this.emit('cynod.started'); });
            p.once('error', reject);
            p.once('exit', code => {
                this.alive = false;
                // A call still open was sent: cynod may have done it before it went away (unanswered).
                for (const w of this.pending.values()) {
                    clearTimeout(w.timer);
                    w.reject({ code: 'sidecar_down', message: `cynod exited (${code})`, unanswered: true });
                }
                this.pending.clear();
                this.emit('cynod.exited'); // the quit path waits for it before an update replaces the sidecar's files (updater/wire.ts)
                if (!this.stopping && code === exports.CYNOD_EXIT_LOCKED) {
                    console.error('CYNOD_LOCKED');
                    this.emit('cynod.gave_up', 'locked');
                    return;
                }
                if (!this.stopping && this.clock() - this.startedAt >= RESET_UPTIME_MS)
                    this.restarts = 0;
                if (!this.stopping && this.restarts >= MAX_RESTARTS) {
                    console.error('CYNOD_GAVE_UP');
                    this.emit('cynod.gave_up');
                }
                if (!this.stopping && this.restarts < MAX_RESTARTS) {
                    this.restarts++;
                    console.error(`CYNOD_RESTART ${this.restarts}`);
                    this.restartTimer = (this.opts.setTimer ?? setTimeout)(() => {
                        this.restartTimer = undefined;
                        if (this.stopping)
                            return;
                        this.start().catch(e => console.error('[cynod] start failed:', e?.code ?? 'unknown')); // the code only: the error carries the binary's path
                    }, (0, exports.restartDelay)(this.restarts));
                }
            });
        });
    }
    call(method, params = {}, timeoutMs = (0, exports.timeoutFor)(method)) {
        const id = this.nextId++;
        return new Promise((resolve, reject) => {
            const stdin = this.proc?.stdin;
            if (!this.alive || !stdin || !stdin.writable) {
                reject({ code: 'sidecar_down', message: 'cynod is not running' });
                return;
            }
            const w = { resolve: v => resolve(v), reject };
            if (timeoutMs > 0) {
                w.timer = setTimeout(() => {
                    this.pending.delete(id); // a late reply finds no entry and is ignored
                    this.sendCancel(id);
                    reject((0, exports.callTimeout)(method));
                }, timeoutMs);
                w.timer.unref();
            }
            this.pending.set(id, w);
            stdin.write(JSON.stringify({ id, method, params }) + '\n', err => {
                if (!err)
                    return;
                clearTimeout(w.timer);
                this.pending.delete(id);
                reject({ code: 'sidecar_down', message: `cynod write failed: ${err.message}` });
            });
        });
    }
    // R7: once the host stops waiting for request id, cynod ends its handler. Best effort: a pipe that is gone needs no cancel (cynod
    // with it), and a write error is already logged by the stdin error listener.
    sendCancel(id) {
        const stdin = this.proc?.stdin;
        if (!this.alive || !stdin || !stdin.writable)
            return;
        stdin.write(JSON.stringify({ id: 0, method: CANCEL_METHOD, params: { id } }) + '\n', () => { });
    }
    onLine(line) {
        let m;
        try {
            m = JSON.parse(line);
        }
        catch {
            console.error(`[cynod] non-JSON stdout (${line.length} chars)`);
            return;
        }
        if (m.event) {
            this.emit(m.event, m.data);
            return;
        }
        const w = m.id !== undefined ? this.pending.get(m.id) : undefined;
        if (!w)
            return;
        this.pending.delete(m.id);
        clearTimeout(w.timer);
        if (m.error)
            w.reject(m.error);
        else
            w.resolve(m.result);
    }
    /** The sidecar process runs (spawned and not exited). */
    get running() { return this.alive; }
    /**
     * Stops the sidecar for good (no restart) and resolves once its process has exited (at once when none runs). cynod's own stop drains a
     * token rotation whose caller left (vault.Drain), so the stop must reach cynod as a request, never as a kill:
     * - Linux: SIGTERM (`kill()`), which cynod's signal handler turns into that stop. The process may outlive the app; nothing waits.
     * - Windows: `kill()` is TerminateProcess, so cynod's stdin is closed instead (serve returns on the EOF); it is killed only if it still
     *   runs STOP_GRACE_MS later. A second call changes nothing. The app's quit waits for the exit (quitInstall), since a child of a Windows
     *   app ends with it.
     */
    stop() {
        this.stopping = true;
        if (this.restartTimer) {
            clearTimeout(this.restartTimer);
            this.restartTimer = undefined;
        }
        const p = this.proc;
        if (!p || !this.alive)
            return Promise.resolve();
        const exited = new Promise(r => p.once('exit', () => r()));
        if ((this.opts.platform ?? process.platform) !== 'win32') {
            p.kill();
            return exited;
        }
        if (this.ending === p)
            return exited;
        this.ending = p;
        p.stdin?.end();
        const t = (this.opts.setTimer ?? setTimeout)(() => { if (this.alive && this.proc === p)
            p.kill(); }, exports.STOP_GRACE_MS);
        void exited.then(() => clearTimeout(t));
        return exited;
    }
}
exports.Cynod = Cynod;
