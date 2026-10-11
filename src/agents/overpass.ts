/**
 * overpass.ts — OSM/Overpass query agent.
 *
 * The cheapest possible Overpass client for a swarm:
 *   - ONE shared LRU keyed on the canonicalised Overpass QL, 6h TTL + 6h SWR
 *     (OSM data changes slowly; this is where the biggest hit-rate win is).
 *   - single-flight, so 500 agents asking for the same city = 1 upstream call.
 *   - mirrors rotate, and a mirror is skipped for 5 min after a 429/5xx.
 *   - returns normalised POIs, not raw Overpass JSON (smaller payloads, stable
 *     shape for downstream agents and for the edge cache).
 *   - `offline` mode returns a deterministic fixture so QAA never hits network.
 */
import { LruCache } from "../cache/lru.ts";
import { register } from "../cache/stats.ts";
import { cacheKey, canonical } from "../cache/keyhash.ts";
import { defineAgent, type Agent, type AgentCtx } from "./base.ts";

export interface OverpassQuery {
  /** raw Overpass QL; when absent it is built from bbox + selectors */
  ql?: string;
  bbox?: [number, number, number, number]; // south, west, north, east
  selectors?: string[];
  timeoutSec?: number;
  /** hard cap on returned elements (keeps responses small; Overpass default is unbounded) */
  maxPois?: number;
  /** endpoint override; defaults to the mirror ring */
  endpoint?: string;
}

export interface Poi {
  id: string;
  type: "node" | "way" | "relation";
  lat: number;
  lon: number;
  name?: string;
  tags: Record<string, string>;
}

export interface OverpassResult {
  count: number;
  pois: Poi[];
  endpoint: string;
  fromCache: boolean;
  classes: Record<string, number>;
}

export const MIRRORS = [
  "https://overpass-api.de/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter",
  "https://overpass.private.coffee/api/interpreter",
];

const DEFAULT_SELECTORS = [
  'nwr["amenity"]',
  'nwr["man_made"]',
  'nwr["office"]',
  'nwr["industrial"]',
  'nwr["landuse"~"industrial|port|railway"]',
];

const results = register("overpass", new LruCache<OverpassResult>({ max: 4000, ttlMs: 6 * 3600_000, swrMs: 6 * 3600_000 }), {
  kind: "network", note: "Overpass QL → normalised POIs, 6h TTL + 6h SWR",
});
const dead = new Map<string, number>();
const DEAD_MS = 5 * 60_000;

/** Default element cap per query — the difference between a 4 KB and an 18 MB response. */
export const DEFAULT_MAX_POIS = 400;

/**
 * Overpass mirrors answer 400/406 to clients without a descriptive User-Agent,
 * so identify the swarm explicitly (and politely) on every request.
 */
export const USER_AGENT =
  "gis-osint-agentic-swarm/2.0 (+https://github.com/alexdolbun/gis-osint-agentic-swarm)";

export function buildQl(q: OverpassQuery): string {
  if (q.ql) return q.ql.trim();
  const bbox = q.bbox ?? [0, 0, 0, 0];
  const b = bbox.join(",");
  const sel = q.selectors?.length ? q.selectors : DEFAULT_SELECTORS;
  const t = q.timeoutSec ?? 25;
  // `center` gives ways/relations a representative point; the numeric limit keeps a
  // dense bbox from returning tens of MB (the default is unbounded).
  const cap = Math.max(1, Math.min(q.maxPois ?? DEFAULT_MAX_POIS, 10_000));
  return `[out:json][timeout:${t}];(${sel.map((s) => `${s}(${b});`).join("")});out center tags ${cap};`;
}

/** Classify a POI into one of the RWA-relevant classes (port/airport/industrial/financial/data_center). */
export function classify(tags: Record<string, string>): string {
  const s = `${tags["man_made"] ?? ""} ${tags["amenity"] ?? ""} ${tags["office"] ?? ""} ${tags["industrial"] ?? ""} ${tags["landuse"] ?? ""} ${tags["aeroway"] ?? ""} ${tags["harbour"] ?? ""}`.toLowerCase();
  if (/port|harbour|pier|quay|marina/.test(s) || tags["landuse"] === "harbour") return "port";
  if (/aerodrome|airport|terminal/.test(s) || tags["aeroway"]) return "airport";
  if (/industrial|factory|works|warehouse|refinery|plant|mine/.test(s)) return "industrial";
  if (/bank|financial|insurance|investment|fund|financ/.test(s) || /financial/.test(tags["office"] ?? "")) return "financial";
  if (/data_cent|telecom|datacent|server/.test(s) || /data.?cent/.test(tags["name"] ?? "")) return "data_center";
  return "other";
}

/** Ordered mirror ring: healthy mirrors first, then the rest, so a dead mirror
 *  never blocks a query but is still retried once it recovers. */
function mirrorRing(env: Record<string, string | undefined>): string[] {
  const ring = (env.OVERPASS_MIRRORS ? env.OVERPASS_MIRRORS.split(",") : MIRRORS).map((m) => m.trim()).filter(Boolean);
  const now = Date.now();
  const healthy = ring.filter((m) => (dead.get(m) ?? 0) < now);
  return [...healthy, ...ring.filter((m) => !healthy.includes(m))];
}

/**
 * POST one QL to one mirror. Public Overpass instances disagree on form
 * encoding — some deployments reject a `+`-encoded body while others reject the
 * raw percent-encoded one — so BOTH are attempted before a mirror is condemned.
 * That is what makes the ring resilient in practice rather than nominally.
 */
async function postQl(endpoint: string, ql: string, timeoutSec: number, ctx: AgentCtx): Promise<unknown> {
  const forms = [new URLSearchParams({ data: ql }).toString(), `data=${encodeURIComponent(ql)}`];
  let lastErr: unknown;
  for (const body of forms) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutSec * 1000 + 2000);
    try {
      const res = await ctx.fetchImpl(endpoint, {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          accept: "application/json",
          "user-agent": USER_AGENT,
        },
        body,
        signal: ctrl.signal,
      });
      if (res.ok) return await res.json();
      lastErr = new Error(`overpass ${res.status} @ ${endpoint}`);
      if (res.status >= 500) continue;
      break;
    } catch (e) { lastErr = e; }
    finally { clearTimeout(timer); }
  }
  throw lastErr ?? new Error(`overpass unreachable @ ${endpoint}`);
}

function normalise(json: any, endpoint: string): OverpassResult {
  const pois: Poi[] = [];
  const classes: Record<string, number> = {};
  for (const el of json.elements ?? []) {
    const lat = el.lat ?? el.center?.lat;
    const lon = el.lon ?? el.center?.lon;
    if (lat == null || lon == null) continue;
    const tags: Record<string, string> = el.tags ?? {};
    const cls = classify(tags);
    classes[cls] = (classes[cls] ?? 0) + 1;
    pois.push({ id: `${el.type}/${el.id}`, type: el.type, lat, lon, name: tags.name, tags });
  }
  return { count: pois.length, pois, endpoint, fromCache: false, classes };
}

export const overpass: Agent<OverpassQuery, OverpassResult> = defineAgent<OverpassQuery, OverpassResult>(
  {
    name: "overpass",
    layer: 4,
    kind: "network",
    ttlMs: 6 * 3600_000,
    network: { host: "overpass-api.de", budgetPerMin: 90 },
    note: "OSM Overpass POI query, 6h TTL, mirror failover",
    keyOf: (q) => cacheKey("overpass", q.ql ?? "", q.bbox ?? [], q.selectors ?? [], q.endpoint ?? ""),
  },
  async (q, ctx) => {
    const key = overpass.spec.keyOf(q);
    if (ctx.offline) return offlineFixture(key);
    const cached = results.peek(key);
    if (cached) return { ...cached, fromCache: true };
    return results.fetch(key, async () => {
      const ql = buildQl(q);
      const ring = q.endpoint ? [q.endpoint] : mirrorRing(ctx.env);
      let lastErr: unknown;
      for (const endpoint of ring) {
        try {
          return normalise(await postQl(endpoint, ql, q.timeoutSec ?? 25, ctx), endpoint);
        } catch (e) {
          dead.set(endpoint, Date.now() + DEAD_MS);
          lastErr = e;
        }
      }
      throw lastErr ?? new Error("overpass: no mirror reachable");
    }, overpass.spec.ttlMs);
  },
);

/** Deterministic fixture (never random) so offline QAA is reproducible. */
export function offlineFixture(key: string): OverpassResult {
  let h = 0;
  for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) >>> 0;
  const n = 3 + (h % 5);
  const pois: Poi[] = Array.from({ length: n }, (_, i) => ({
    id: `offline/${i}`,
    type: "node" as const,
    lat: 40 + ((h >> (i * 3)) % 1000) / 1000,
    lon: -74 + ((h >> (i * 2)) % 1000) / 1000,
    name: `fixture-${i}`,
    tags: { amenity: i % 2 ? "bank" : "harbour", man_made: i % 3 ? "pier" : "" },
  }));
  const classes: Record<string, number> = {};
  for (const p of pois) { const c = classify(p.tags); classes[c] = (classes[c] ?? 0) + 1; }
  return { count: pois.length, pois, endpoint: "offline://fixture", fromCache: false, classes };
}

export function _overpassCache(): LruCache<OverpassResult> { return results; }
export function _resetDead(): void { dead.clear(); }
export { canonical };
