/**
 * geosocial.ts — geo-social correlation agent (pure compute, OSI L5).
 *
 * Turns a stream of geo-tagged social/OSINT points into grid clusters with a
 * velocity score, and correlates those clusters against the known-entity DB
 * (people / orgs / venues) to produce candidate alpha inputs. This is the node
 * that connects "something is being posted here, fast" to "who/whose money is
 * there" — the actual OSINT step.
 *
 * Everything is pure and deterministic: same points in → same clusters out, so
 * QAA can assert exact outputs, and results are safe to cache by input hash.
 */
import { memoize } from "../cache/memo.ts";
import { defineAgent } from "./base.ts";
import { geoCell } from "../cache/keyhash.ts";

export interface GeoPoint {
  id: string;
  lat: number;
  lon: number;
  /** epoch ms */
  ts: number;
  source: string;
  text?: string;
  handles?: string[];
  currencies?: string[];
}

export interface KnownEntity {
  id: string;
  name: string;
  kind: "person" | "org" | "venue";
  lat: number;
  lon: number;
  x?: string;
  tags?: string[];
}

export interface Cluster {
  cell: string;
  centroid: [number, number];
  count: number;
  firstTs: number;
  lastTs: number;
  /** points per day over the observed span */
  velocity: number;
  sources: Record<string, number>;
  topHandles: Array<[string, number]>;
  currencies: string[];
  /** 0..1 — density vs. the busiest cell in this batch */
  intensity: number;
}

export interface EntityMatch {
  entityId: string;
  entityName: string;
  kind: KnownEntity["kind"];
  cell: string;
  distanceKm: number;
  clusterCount: number;
  velocity: number;
}

export interface CorrelationResult {
  clusters: Cluster[];
  hot: Cluster[];
  matches: EntityMatch[];
  cells: number;
  points: number;
  spanDays: number;
}

export const cellId = memoize<[lat: number, lon: number, deg?: number], string>((lat, lon, deg = 0.25) =>
  geoCell(Math.floor(lat / deg) * deg, Math.floor(lon / deg) * deg, 3), { ns: "cellId", max: 50_000 });

export function haversineKm(a: [number, number], b: [number, number]): number {
  const R = 6371, rad = Math.PI / 180;
  const dLat = (b[0] - a[0]) * rad, dLon = (b[1] - a[1]) * rad;
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(a[0] * rad) * Math.cos(b[0] * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(s)));
}

export interface CorrelationInput {
  points: GeoPoint[];
  known?: KnownEntity[];
  cellDeg?: number;
  /** match radius for entity correlation, km */
  radiusKm?: number;
  topN?: number;
}

export const geosocial = defineAgent<CorrelationInput, CorrelationResult>(
  { name: "geosocial", layer: 5, kind: "compute", ttlMs: 5 * 60_000, note: "grid clustering + entity correlation (zero network)", keyOf: (i) => `gsoc:${i.points.length}:${i.cellDeg ?? 0.25}:${i.radiusKm ?? 25}:${i.points[0]?.id ?? "-"}:${i.points[i.points.length - 1]?.id ?? "-"}` },
  async (input) => {
    const cellDeg = input.cellDeg ?? 0.25;
    const radiusKm = input.radiusKm ?? 25;
    const groups = new Map<string, GeoPoint[]>();
    for (const p of input.points) {
      const k = cellId(p.lat, p.lon, cellDeg);
      const arr = groups.get(k);
      if (arr) arr.push(p); else groups.set(k, [p]);
    }

    const clusters: Cluster[] = [];
    for (const [cell, pts] of groups) {
      let sLat = 0, sLon = 0, first = Infinity, last = -Infinity;
      const sources: Record<string, number> = {};
      const handleCounts = new Map<string, number>();
      const ccy = new Set<string>();
      for (const p of pts) {
        sLat += p.lat; sLon += p.lon;
        first = Math.min(first, p.ts); last = Math.max(last, p.ts);
        sources[p.source] = (sources[p.source] ?? 0) + 1;
        for (const h of p.handles ?? []) handleCounts.set(h, (handleCounts.get(h) ?? 0) + 1);
        for (const c of p.currencies ?? []) ccy.add(c);
      }
      const spanDays = Math.max(1 / 24, (last - first) / 86_400_000);
      clusters.push({
        cell,
        centroid: [Number((sLat / pts.length).toFixed(5)), Number((sLon / pts.length).toFixed(5))],
        count: pts.length,
        firstTs: first, lastTs: last,
        velocity: Number((pts.length / spanDays).toFixed(3)),
        sources,
        topHandles: [...handleCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5),
        currencies: [...ccy].sort(),
        intensity: 0,
      });
    }

    const maxCount = clusters.reduce((m, c) => Math.max(m, c.count), 0) || 1;
    for (const c of clusters) c.intensity = Number((c.count / maxCount).toFixed(4));
    clusters.sort((a, b) => (b.count * b.velocity) - (a.count * a.velocity));

    const matches: EntityMatch[] = [];
    for (const e of input.known ?? []) {
      let best: { c: Cluster; d: number } | null = null;
      for (const c of clusters) {
        const d = haversineKm([e.lat, e.lon], c.centroid);
        if (d <= radiusKm && (!best || d < best.d)) best = { c, d };
      }
      if (best) {
        matches.push({
          entityId: e.id, entityName: e.name, kind: e.kind, cell: best.c.cell,
          distanceKm: Number(best.d.toFixed(2)), clusterCount: best.c.count, velocity: best.c.velocity,
        });
      }
    }
    matches.sort((a, b) => b.clusterCount - a.clusterCount);

    const spanDays = input.points.length
      ? Math.max(1 / 24, (Math.max(...input.points.map((p) => p.ts)) - Math.min(...input.points.map((p) => p.ts))) / 86_400_000)
      : 0;

    return {
      clusters,
      hot: clusters.slice(0, input.topN ?? 10),
      matches,
      cells: clusters.length,
      points: input.points.length,
      spanDays: Number(spanDays.toFixed(3)),
    };
  },
);
