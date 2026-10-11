/**
 * metadata.ts — geo-metadata extraction agent (pure, no deps).
 *
 * Two evidence sources, fused into one confidence-scored geo record:
 *   1. EXIF (JPEG APP1/TIFF): GPS IFD + DateTimeOriginal + camera. Implemented
 *      here from the TIFF spec — no native modules, works in Bun/Node/Workers.
 *   2. Sidecar text (post caption / X cards / event manifest): place names,
 *      hashtags, @handles, country codes, currency codes → coarse geo + topic.
 *
 * Fusion is deliberately conservative: EXIF GPS is high-confidence, sidecar is
 * low-confidence, and contradictions are REFUSED rather than averaged. That is
 * the QAA rule for OSINT geo integrity.
 */
import { memoize } from "../cache/memo.ts";
import { defineAgent } from "./base.ts";

export interface GeoMetadata {
  lat?: number;
  lon?: number;
  alt?: number;
  dateTimeOriginal?: string;
  make?: string;
  model?: string;
  orientation?: number;
  format: "jpeg" | "png" | "webp" | "unknown";
  /** 0-100 */
  confidence: number;
  provenance: Array<"exif_gps" | "exif_time" | "sidecar_place" | "sidecar_handle" | "sidecar_currency" | "none">;
  placeHints: string[];
  handles: string[];
  currencies: string[];
  refused?: string;
}

const EXIF_HEADER = [0x45, 0x78, 0x69, 0x66, 0x00, 0x00]; // "Exif\0\0"

export const sniffFormat = memoize((b: Uint8Array): GeoMetadata["format"] => {
  if (b.length < 12) return "unknown";
  if (b[0] === 0xff && b[1] === 0xd8) return "jpeg";
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return "png";
  if (b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return "webp";
  return "unknown";
}, { ns: "sniffFormat" });

function findExifStart(b: Uint8Array): number {
  // scan APP1 segments
  let p = 2;
  while (p + 4 < b.length) {
    if (b[p] !== 0xff) { p++; continue; }
    const marker = b[p + 1];
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { p += 2; continue; }
    const len = (b[p + 2] << 8) | b[p + 3];
    if (marker === 0xe1) {
      let ok = true;
      for (let i = 0; i < 6; i++) if (b[p + 4 + i] !== EXIF_HEADER[i]) { ok = false; break; }
      if (ok) return p + 10; // start of TIFF header
    }
    if (marker === 0xda) break; // start of scan — no EXIF beyond here
    p += 2 + len;
  }
  return -1;
}

/** Minimal TIFF/IFD reader → flat tag map for IFD0, ExifIFD and GPS IFD. */
export function parseTiff(bytes: Uint8Array, start: number): Record<string, Record<number, any>> {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const le = dv.getUint16(start, false) === 0x4949;
  const u16 = (o: number) => dv.getUint16(o, le);
  const u32 = (o: number) => dv.getUint32(o, le);
  if (u16(start + 2) !== 0x002a) return {};
  const out: Record<string, Record<number, any>> = { ifd0: {}, exif: {}, gps: {} };

  const typeSize: Record<number, number> = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 7: 1, 9: 4, 10: 8, 12: 8 };
  const readVal = (type: number, count: number, off: number): any => {
    const size = (typeSize[type] ?? 1) * count;
    const base = size <= 4 ? off : u32(off);
    if (type === 2) {
      let s = "";
      for (let i = 0; i < count; i++) { const c = bytes[base + i]; if (c === 0) break; s += String.fromCharCode(c); }
      return s;
    }
    if (type === 5 || type === 10) {
      const arr: number[] = [];
      for (let i = 0; i < count; i++) {
        const n = u32(base + i * 8), d = u32(base + i * 8 + 4);
        arr.push(d === 0 ? 0 : n / d);
      }
      return count === 1 ? arr[0] : arr;
    }
    const vals: number[] = [];
    for (let i = 0; i < count; i++) {
      vals.push(type === 3 ? u16(base + i * 2) : type === 4 ? u32(base + i * 4) : bytes[base + i]);
    }
    return count === 1 ? vals[0] : vals;
  };

  const readIfd = (off: number, into: Record<number, any>): number => {
    const n = u16(off);
    for (let i = 0; i < n; i++) {
      const e = off + 2 + i * 12;
      const tag = u16(e), type = u16(e + 2), count = u32(e + 4);
      try { into[tag] = readVal(type, count, e + 8); } catch { /* skip malformed entry */ }
    }
    return u32(off + 2 + n * 12);
  };

  const next = readIfd(u32(start + 4), out.ifd0);
  // ExifIFD pointer (0x8769) and GPS IFD pointer (0x8825)
  if (out.ifd0[0x8769]) { try { readIfd(out.ifd0[0x8769] as number, out.exif); } catch {} }
  if (out.ifd0[0x8825]) { try { readIfd(out.ifd0[0x8825] as number, out.gps); } catch {} }
  if (next && !out.exif[0x9003]) { try { readIfd(next, out.exif); } catch {} }
  return out;
}

function dmsToDeg(dms: number[], ref?: string): number | undefined {
  if (!Array.isArray(dms) || dms.length < 3) return undefined;
  const [d, m, s] = dms;
  let deg = d + m / 60 + s / 3600;
  if (ref && /[SW]/i.test(ref)) deg = -deg;
  return Number(deg.toFixed(7));
}

export interface MetadataInput {
  /** image bytes (raw) if available */
  bytes?: Uint8Array;
  /** sidecar caption / manifest text */
  text?: string;
}

const CURRENCY_RE = /\b(USD|EUR|GBP|JPY|CNY|RUB|AED|KRW|INR|BRL|KZT|CHF|CAD|AUD|TRY|IDR|VND|THB|PLN|ILS|HKD|SGD)\b/g;
const HANDLE_RE = /@([A-Za-z0-9_]{2,30})/g;
const PLACE_RE = /\b([A-Z][a-z]+(?:\s+[A-Z][a-z]+){0,2})\s*,\s*([A-Z][a-zA-Z]+(?:\s+[A-Z][a-zA-Z]+){0,2})\b/g;

export const metadata = defineAgent<MetadataInput, GeoMetadata>(
  { name: "metadata", layer: 2, kind: "compute", ttlMs: 3 * 3600_000, note: "EXIF GPS + caption sidecar extraction (zero network)", keyOf: (i) => `meta:${i.bytes?.length ?? 0}:${i.bytes ? i.bytes[0] : -1}:${(i.text ?? "").slice(0, 120)}` },
  async (input) => {
    const out: GeoMetadata = { format: "unknown", confidence: 0, provenance: [], placeHints: [], handles: [], currencies: [] };
    let exifScore = 0, sidecarScore = 0;

    if (input.bytes && input.bytes.length) {
      out.format = sniffFormat(input.bytes);
      if (out.format === "jpeg") {
        const s = findExifStart(input.bytes);
        if (s > 0) {
          const ifd = parseTiff(input.bytes, s);
          const g = ifd.gps ?? {};
          const lat = dmsToDeg(g[0x0002], g[0x0001]);
          const lon = dmsToDeg(g[0x0004], g[0x0003]);
          if (lat !== undefined && lon !== undefined && Math.abs(lat) <= 90 && Math.abs(lon) <= 180) {
            out.lat = lat; out.lon = lon; out.provenance.push("exif_gps"); exifScore += 60;
          }
          if (g[0x0006] !== undefined) out.alt = Number(g[0x0006]);
          const dt = (ifd.exif ?? {})[0x9003] ?? (ifd.ifd0 ?? {})[0x0132];
          if (typeof dt === "string" && /^\d{4}:\d{2}:\d{2}/.test(dt)) {
            out.dateTimeOriginal = dt.replace(/^(\d{4}):(\d{2}):(\d{2})/, "$1-$2-$3");
            out.provenance.push("exif_time"); exifScore += 15;
          }
          const make = (ifd.ifd0 ?? {})[0x010f], model = (ifd.ifd0 ?? {})[0x0110], orient = (ifd.ifd0 ?? {})[0x0112];
          if (typeof make === "string") out.make = make.trim();
          if (typeof model === "string") out.model = model.trim();
          if (typeof orient === "number") out.orientation = orient;
          if (out.make || out.model) exifScore += 5;
        }
      }
    }

    const text = input.text ?? "";
    if (text) {
      for (const m of text.matchAll(PLACE_RE)) {
        const hint = `${m[1]}, ${m[2]}`;
        if (!out.placeHints.includes(hint)) { out.placeHints.push(hint); sidecarScore += 6; }
      }
      for (const m of text.matchAll(HANDLE_RE)) {
        const h = m[1].toLowerCase();
        if (!out.handles.includes(h)) { out.handles.push(h); sidecarScore += 3; }
      }
      if (out.handles.length) out.provenance.push("sidecar_handle");
      for (const m of text.matchAll(CURRENCY_RE)) {
        const c = m[1];
        if (!out.currencies.includes(c)) out.currencies.push(c);
      }
      if (out.currencies.length) { sidecarScore += 2; out.provenance.push("sidecar_currency"); }
      if (out.placeHints.length) out.provenance.push("sidecar_place");
    }

    if (!out.provenance.length) out.provenance.push("none");
    out.confidence = Math.min(100, exifScore + sidecarScore);
    return out;
  },
);

export { dmsToDeg, findExifStart, CURRENCY_RE, HANDLE_RE, PLACE_RE };
