/**
 * memo.ts — memoisation for expensive deterministic GEO computation.
 * Wraps pure-ish geo functions (haversine, bbox expansion, tile<->lonlat,
 * quadkey, H3-ish cell id, currency formatting) with an LRU keyed on canonical
 * inputs. These are called millions of times by geo-indexing; memoising them
 * cuts CPU on OSI L5–L7 without touching correctness.
 */
import { LruCache } from "./lru.ts";
import { canonical } from "./keyhash.ts";

export function memoize<A extends unknown[], R>(
  fn: (...args: A) => R,
  opts: { max?: number; ttlMs?: number; ns?: string } = {},
): ((...args: A) => R) & { cache: LruCache<R> } {
  const cache = new LruCache<R>({ max: opts.max ?? 5000, ttlMs: opts.ttlMs ?? 0 });
  const ns = opts.ns ?? (fn.name || "memo");
  const wrapped = (...args: A): R => {
    const k = `${ns}:${args.map(canonical).join("|")}`;
    const hit = cache.get(k);
    if (hit !== undefined) return hit;
    const out = fn(...args);
    cache.set(k, out);
    return out;
  };
  wrapped.cache = cache;
  return wrapped;
}

/* ── Hot geo primitives, memoised by default ───────────────────────────── */

const R_EARTH_KM = 6371.0088;

export const haversineKm = memoize((aLat: number, aLon: number, bLat: number, bLon: number): number => {
  const dLat = ((bLat - aLat) * Math.PI) / 180;
  const dLon = ((bLon - aLon) * Math.PI) / 180;
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((aLat * Math.PI) / 180) * Math.cos((bLat * Math.PI) / 180) * Math.sin(dLon / 2) ** 2;
  return 2 * R_EARTH_KM * Math.asin(Math.min(1, Math.sqrt(s)));
}, { ns: "haversine", max: 20000 });

/** Expand a (lat,lon) point into an Overpass bbox string (lat,lon order per Overpass API). */
export const bboxAround = memoize((lat: number, lon: number, km: number): string => {
  const dLat = km / 111.32;
  const dLon = km / (111.32 * Math.cos((lat * Math.PI) / 180) || 1e-6);
  const s = (lat - dLat).toFixed(4), w = (lon - dLon).toFixed(4);
  const n = (lat + dLat).toFixed(4), e = (lon + dLon).toFixed(4);
  return `${s},${w},${n},${e}`;
}, { ns: "bbox", max: 20000 });

/** Web-Mercator tile <-> lon/lat. */
export const lonLatToTile = memoize((lon: number, lat: number, z: number): { x: number; y: number } => {
  const n = 2 ** z;
  const x = Math.floor(((lon + 180) / 360) * n);
  const latRad = (lat * Math.PI) / 180;
  const y = Math.floor(((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2) * n);
  return { x: Math.max(0, Math.min(n - 1, x)), y: Math.max(0, Math.min(n - 1, y)) };
}, { ns: "tile", max: 20000 });

/** Quadkey for tile cache sharding / zoom-tiered IndexedDB keys. */
export const quadkey = memoize((x: number, y: number, z: number): string => {
  let q = "";
  for (let i = z; i > 0; i--) {
    let d = 0;
    const mask = 1 << (i - 1);
    if (x & mask) d |= 1;
    if (y & mask) d |= 2;
    q += d;
  }
  return q;
}, { ns: "quadkey", max: 20000 });

/** Zoom tier for the IndexedDB permanent/temporary/network-only policy. */
export function zoomTier(z: number): "permanent" | "temporary" | "network" {
  if (z <= 12) return "permanent";
  if (z <= 18) return "temporary";
  return "network";
}
