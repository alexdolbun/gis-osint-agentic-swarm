/**
 * keyhash.ts — deterministic, collision-resistant cache keys.
 * NFKC-normalised + lowercased + sorted-param canonicalisation so the SAME
 * geo query always maps to the SAME key regardless of argument order,
 * unicode form, or float formatting. This is the difference between a 0.4 and
 * a 0.95 hit rate on multilingual / multicurrency swarms.
 */

export function nfkc(s: string): string {
  try { return s.normalize("NFKC"); } catch { return s; }
}

/** Round coordinates to a grid so neighbouring queries share a cell. */
export function geoCell(lat: number, lon: number, decimals = 4): string {
  return `${lat.toFixed(decimals)},${lon.toFixed(decimals)}`;
}

/** Canonical string for any scalar/array/object. */
export function canonical(v: unknown): string {
  if (v === null || v === undefined) return "~";
  if (typeof v === "number") return Number.isInteger(v) ? String(v) : v.toFixed(6).replace(/0+$/, "").replace(/\.$/, "");
  if (typeof v === "string") return nfkc(v).trim().toLowerCase();
  if (typeof v === "boolean") return v ? "1" : "0";
  if (Array.isArray(v)) return "[" + v.map(canonical).join(",") + "]";
  if (typeof v === "object") {
    const keys = Object.keys(v as Record<string, unknown>).sort();
    return "{" + keys.map((k) => `${k}:${canonical((v as Record<string, unknown>)[k])}`).join(",") + "}";
  }
  return String(v);
}

/** Build a namespaced cache key: ns + canonical(args...). */
export function cacheKey(ns: string, ...args: unknown[]): string {
  return `${ns}:${args.map(canonical).join("|")}`;
}

/** Fast non-crypto 64-bit FNV-1a hash (hex) — cheap sharding / log keys. */
export function fnv1a64(s: string): string {
  let h = 0xcbf29ce484222325n;
  const p = 0x100000001b3n;
  const m = (1n << 64n) - 1n;
  for (let i = 0; i < s.length; i++) {
    h ^= BigInt(s.charCodeAt(i));
    h = (h * p) & m;
  }
  return h.toString(16).padStart(16, "0");
}
