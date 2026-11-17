"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.sidecarEnv = void 0;
// The environment the Go sidecar starts with: an explicit allowlist, never the host's whole environment.
// Plugin- or user-set variables (tokens, debug switches) stay out; proxy and certificate variables pass on purpose (a proxied network must keep working); CYNOD_ESI_CACHE_MB (the persistent ESI cache cap in MiB) passes so the owner can set it when starting the app; the host adds what cynod needs through `extra`.
const COMMON = ['EVE_LOGS_DIR', 'CYNOD_ESI_CACHE_MB', 'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'no_proxy', 'SSL_CERT_FILE', 'SSL_CERT_DIR'];
const TEST_ONLY = ['EVECYNO_CLIENT_ID', 'EVECYNO_CALLBACK_PORT', 'EVECYNO_TEST_SSO_METADATA_URL', 'EVECYNO_TEST_ESI_BASE_URL', 'EVECYNO_TEST_SECRETS_FILE'];
const LINUX = ['PATH', 'HOME', 'USER', 'LANG', 'DISPLAY', 'WAYLAND_DISPLAY', 'DBUS_SESSION_BUS_ADDRESS', 'XAUTHORITY'];
const LINUX_PREFIXES = ['LC_', 'XDG_'];
const WINDOWS = ['PATH', 'SystemRoot', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'TEMP', 'TMP', 'OneDrive', 'OneDriveConsumer'];
// EVECYNO_CLIENT_ID, EVECYNO_CALLBACK_PORT and the three testhooks variables (fake SSO metadata, fake ESI base, secrets file) are
// test-build overrides: they pass only when testBuild is true (main.ts also removes the first two from the host environment in
// product builds). The product sidecar binary does not read the testhooks ones at all (build tag); this is the second wall.
const sidecarEnv = (platform, env, extra, testBuild) => {
    const win = platform === 'win32';
    const names = new Set((win ? WINDOWS : LINUX).concat(COMMON, testBuild ? TEST_ONLY : []).map(n => (win ? n.toUpperCase() : n)));
    const out = {};
    for (const [k, v] of Object.entries(env)) {
        if (v === undefined)
            continue;
        const key = win ? k.toUpperCase() : k;
        const ok = names.has(key) || (!win && LINUX_PREFIXES.some(p => k.startsWith(p)));
        if (ok)
            out[k] = v;
    }
    return { ...out, ...extra };
};
exports.sidecarEnv = sidecarEnv;
