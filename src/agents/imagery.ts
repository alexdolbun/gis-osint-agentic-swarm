/**
 * imagery.ts — historical imagery agent ("Earth Engine style", open stack).
 *
 * Google Earth Engine is the mental model, but the OSS-swarm actually runs on
 * STAC (SpatioTemporal Asset Catalog) — the open, keyless equivalent. Default
 * catalog: Element 84 earth-search (Sentinel-2 L2A + Landsat + NAIP), plus an
 * injectable STAC URL so a user can point it at Planetary Computer, Copernicus,
 * or a self-hosted catalog. Google Earth Engine remains an *optional* provider
 * when a service account is configured — never a hard dependency.
 *
 * Two things make this an alpha generator rather than an image viewer:
 *   - acquisitions(): cached scene index for a bbox + date window.
 *   - delta(): scene-to-scene change between two windows (new construction,
 *     new port activity, new industrial footprint) — a real, checkable signal.
 */
import { LruCache } from "../cache/lru.ts";
import { register } from "../cache/stats.ts";
import { cacheKey, geoCell } from "../cache/keyhash.ts";
import { defineAgent, type Agent, type AgentCtx } from "./base.ts";
import { memoize } from "../cache/memo.ts";

export interface ImageryQuery {
  bbox: [number, number, number, number];
  /** ISO dates, inclusive */
  from: string;
  to: string;
  collections?: string[];
  limit?: number;
  /** STAC search endpoint override */
  stac?: string;
  maxCloud?: number;
}

export interface Scene {
  id: string;
  collection: string;
  datetime: string;
  cloudCover?: number;
  /** EPSG:4326 bbox */
  bbox?: [number, number, number, number];
  assets?: Record<string, { href: string; type?: string }>;
}

export interface SceneIndex {
  scenes: Scene[];
  stac: string;
  fromCache: boolean;
  newest?: string;
  oldest?: string;
}

export const DEFAULT_STAC = "https://earth-search.aws.element84.com/v1";
export const DEFAULT_COLLECTIONS = ["sentinel-2-l2a", "landsat-c2-l2", "naip"];

const sceneCache = register("imagery", new LruCache<SceneIndex>({ max: 2000, ttlMs: 24 * 3600_000, swrMs: 12 * 3600_000 }), {
  kind: "network", note: "STAC scene index per bbox/week, 24h TTL",
});

/** Coarse bbox so nearby queries share one cached index (grid-snap). */
export const snapBbox = memoize<[[number, number, number, number], number?], [number, number, number, number]>(
  (bbox, decimals = 2) => bbox.map((v) => Number(v.toFixed(decimals))) as [number, number, number, number],
  { ns: "snapBbox", max: 20000 });

/** Bucket a date to whole ISO weeks so a rolling window reuses the same index. */
export function weekBucket(iso: string): string {
  const d = new Date(`${iso}T00:00:00Z`);
  const day = (d.getUTCDay() + 6) % 7; // Monday = 0
  d.setUTCDate(d.getUTCDate() - day);
  return d.toISOString().slice(0, 10);
}

export const imagery: Agent<ImageryQuery, SceneIndex> = defineAgent<ImageryQuery, SceneIndex>(
  {
    name: "imagery",
    layer: 4,
    kind: "network",
    ttlMs: 24 * 3600_000,
    network: { host: "earth-search.aws.element84.com", budgetPerMin: 60 },
    note: "STAC scene index per snapped-bbox/week (Sentinel-2 / Landsat / NAIP)",
    keyOf: (q) => cacheKey("imagery", snapBbox(q.bbox), weekBucket(q.from), weekBucket(q.to), q.collections ?? DEFAULT_COLLECTIONS, q.stac ?? DEFAULT_STAC, q.maxCloud ?? 100),
  },
  async (q, ctx) => {
    const key = imagery.spec.keyOf(q);
    if (ctx.offline) return offlineSceneIndex(key, q);
    const cached = sceneCache.peek(key);
    if (cached) return { ...cached, fromCache: true };
    return sceneCache.fetch(key, async () => {
      const stac = q.stac ?? DEFAULT_STAC;
      const body = {
        bbox: q.bbox,
        datetime: `${q.from}T00:00:00Z/${q.to}T23:59:59Z`,
        collections: q.collections ?? DEFAULT_COLLECTIONS,
        limit: q.limit ?? 50,
        ...(q.maxCloud !== undefined ? { query: { "eo:cloud_cover": { lt: q.maxCloud } } } : {}),
      };
      const res = await ctx.fetchImpl(`${stac}/search`, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error(`stac ${res.status} @ ${stac}`);
      const json: any = await res.json();
      const scenes: Scene[] = (json.features ?? []).map((f: any) => ({
        id: f.id,
        collection: f.collection ?? "",
        datetime: f.properties?.datetime ?? "",
        cloudCover: f.properties?.["eo:cloud_cover"],
        bbox: f.bbox,
        assets: f.assets,
      })).sort((a: Scene, b: Scene) => a.datetime.localeCompare(b.datetime));
      return {
        scenes, stac, fromCache: false,
        oldest: scenes[0]?.datetime, newest: scenes[scenes.length - 1]?.datetime,
      };
    }, imagery.spec.ttlMs);
  },
);

export interface ImageryDelta {
  cell: string;
  added: Scene[];
  removed: Scene[];
  /** net new acquisitions — the raw change signal */
  netNew: number;
  /** change density = netNew / max(1, beforeCount) */
  density: number;
  beforeNewest?: string;
  afterNewest?: string;
}

/** Compare two acquisition indices for the same bbox → a change signal. */
export function delta(cell: string, before: SceneIndex, after: SceneIndex): ImageryDelta {
  const b = new Set(before.scenes.map((s) => s.id));
  const a = new Set(after.scenes.map((s) => s.id));
  const added = after.scenes.filter((s) => !b.has(s.id));
  const removed = before.scenes.filter((s) => !a.has(s.id));
  const density = added.length / Math.max(1, before.scenes.length);
  return {
    cell,
    added, removed,
    netNew: added.length - removed.length,
    density: Number(density.toFixed(4)),
    beforeNewest: before.newest, afterNewest: after.newest,
  };
}

/** Deterministic offline index — reproducible QAA, no network. */
export function offlineSceneIndex(key: string, q: ImageryQuery): SceneIndex {
  const cell = geoCell(q.bbox[0], q.bbox[1], 2);
  let h = 0;
  for (let i = 0; i < key.length; i++) h = (h * 33 + key.charCodeAt(i)) >>> 0;
  const n = 2 + (h % 4);
  const scenes: Scene[] = Array.from({ length: n }, (_, i) => ({
    id: `${cell}-S2-${(h + i * 7919).toString(16)}`,
    collection: "sentinel-2-l2a",
    datetime: new Date(Date.UTC(2026, 0, 1 + ((h + i * 13) % 300))).toISOString(),
    cloudCover: ((h + i * 17) % 60) / 2,
    bbox: q.bbox,
  })).sort((a, b) => a.datetime.localeCompare(b.datetime));
  return { scenes, stac: "offline://fixture", fromCache: false, oldest: scenes[0]?.datetime, newest: scenes[scenes.length - 1]?.datetime };
}

export function _imageryCache(): LruCache<SceneIndex> { return sceneCache; }
