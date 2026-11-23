"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.DATA_ALLOWLIST = exports.PACK_IDS = void 0;
exports.allowedPacks = allowedPacks;
// Which plugin may read which host data pack (API 1.3.0, `eveCyno.data`). The manifest key `permissions.data` exists for every plugin id
// (uniform model), but parseManifest refuses it unless the id is listed here; the namespace exists only for a listed id that declares the pack.
// Pure (no Electron).
exports.PACK_IDS = ['sde.universe', 'sde.types', 'market.hubs']; // market.hubs (API 1.27.0): downloaded by the host (datapacks.ts DYNAMIC_PACKS)
/** The plugin ids that may read a pack, and which; the namespace also needs the plugin built-in or the first-party exempt install (namespaces.ts, firstpartyallow.ts). Public read-only data: no consent (the hub price table too: spec A2.6, no `network` for Assets). */
exports.DATA_ALLOWLIST = new Map([['dev.evecyno.map', ['sde.universe']], ['dev.evecyno.intel', ['sde.universe']], ['dev.evecyno.assets', ['sde.universe', 'sde.types', 'market.hubs']]]);
/** The packs a manifest declares that its id is allowed (declared ∩ allowlisted), in PACK_IDS order. */
function allowedPacks(m) {
    const allowed = exports.DATA_ALLOWLIST.get(m.id) ?? [];
    const declared = m.permissions.data ?? [];
    return exports.PACK_IDS.filter(p => allowed.includes(p) && declared.includes(p));
}
