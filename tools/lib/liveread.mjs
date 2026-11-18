// tools/lib/liveread.mjs: the index served under a prefix, downloaded as the app reads it into a new folder, every request paced for
// the zone's rate limit (plan 6.2: the rule api_flood blocks an address above 100 requests per 10 s on /v1/ paths; CI stays at 50).
// The vendored index-verify.mjs --live reads every archive without a pause, so tools/publish/verify-live.mjs downloads with this and
// runs the vendored verifier on the folder. Each file is read within its cap (the head's 16 KiB, the size the head or catalog names),
// with no redirect; the Cache-Control and Date headers it was served with are kept for the checks only --live would make.
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { ROOT, pacer } from './indexbuild.mjs';
import { fetchCapped } from '../../vendor/eve-cyno-host/scripts/release-lib.mjs';

const require = createRequire(import.meta.url);
const I = require(path.join(ROOT, 'vendor', 'eve-cyno-host', 'host', 'dist', 'market', 'indexformat.js'));
const UA = 'EVE-Cyno-plugins-verify';

/**
 * Downloads the head, its signature, the catalog the head names and every archive the catalog names from `prefix` into the new
 * folder `dir`, one request at a time through `pace`. Resolves {ok: true, served, head, catalogName, archives} (served: name to
 * {cacheControl, date}) or {ok: false, why, served}. Nothing is verified here: the head is parsed only to find the catalog's name.
 */
export async function downloadServed({ prefix, dir, pace = pacer() }) {
  const served = {};
  const get = async (name, max, timeoutMs = I.INDEX_TIMEOUT_MS) => {
    await pace();
    const chunks = [];
    const r = await fetchCapped(prefix + name, max, c => chunks.push(c), timeoutMs, UA);
    if (!r.ok) return { why: `${name}: ${r.why}` };
    served[name] = { cacheControl: r.cacheControl, date: r.date };
    const f = path.join(dir, ...name.split('/'));
    fs.mkdirSync(path.dirname(f), { recursive: true });
    const bytes = Buffer.concat(chunks);
    fs.writeFileSync(f, bytes, { flag: 'wx' });
    return { bytes };
  };
  const failed = (why) => ({ ok: false, why, served });
  fs.mkdirSync(dir, { mode: 0o700 });
  const h = await get('index.json', I.MAX_HEAD_BYTES);
  if (h.why) return failed(h.why);
  const s = await get('index.json.minisig', I.MAX_INDEX_SIG_BYTES);
  if (s.why) return failed(s.why);
  let head;
  try { head = I.parseIndexHead(h.bytes, prefix); } catch (e) { return failed(`index.json: the app refuses it (${e?.message ?? 'bad_index'})`); }
  const catalogName = head.catalog.url.slice(prefix.length);
  const c = await get(catalogName, head.catalog.size);
  if (c.why) return failed(c.why);
  if (!I.catalogMatches(c.bytes, head)) return failed(`${catalogName}: its size or SHA-256 is not the one the head names`);
  let cat;
  try { cat = I.parseCatalog(c.bytes, head, { prefix }); } catch (e) { return failed(`${catalogName}: the app refuses it (${e?.message ?? 'bad_index'})`); }
  const archives = new Map();
  for (const l of cat.plugins) for (const v of l.versions) archives.set(v.archive.url.slice(prefix.length), v.archive.size);
  for (const [name, size] of archives) {
    const x = await get(name, size, 600_000);
    if (x.why) return failed(x.why);
  }
  return { ok: true, served, head, catalogName, archives: [...archives.keys()] };
}
