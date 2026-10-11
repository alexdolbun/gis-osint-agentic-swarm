/**
 * cache-bench.ts — proves the unit economics of the swarm's caching.
 *
 *   bun run scripts/cache-bench.ts
 *   bun run scripts/cache-bench.ts --queries 20000 --keys 500
 *
 * Two workloads, because they stress different properties:
 *
 *   A. REPEATED — a Zipf-ish distribution over K distinct geo queries (real
 *      swarms are heavy-tailed: a handful of cities dominate). Measures raw hit
 *      rate and how many upstream calls the cache removes.
 *
 *   B. STAMPEDE — N identical queries fired concurrently at a cold key.
 *      Measures single-flight coalescing: how many upstream calls survive.
 *
 * No network is used — the loader is a deterministic async function whose call
 * count is the thing being measured. The numbers are therefore about the cache
 * layer itself, which is exactly what the swarm's cost model depends on.
 */
import { writeFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { LruCache, dashboard, memoize, canonical, cacheKey } from "../src/index.ts";

const argv = process.argv.slice(2);
const num = (f: string, d: number) => {
  const i = argv.indexOf(f);
  return i >= 0 && argv[i + 1] ? Number(argv[i + 1]) : d;
};

const QUERIES = num("--queries", 20_000);
const KEYS = num("--keys", 400);
const CONCURRENCY = num("--concurrency", 200);

/** Deterministic PRNG so the bench is reproducible across machines and CI. */
function mulberry32(seed: number) {
  return () => {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Heavy-tailed draw: 80% of traffic to 20% of keys. */
function zipf(rnd: () => number, n: number): number {
  const u = rnd();
  return Math.min(n - 1, Math.floor(n * Math.pow(u, 2.6)));
}

async function repeated(rnd: () => number) {
  const cache = new LruCache<number>({ max: KEYS, ttlMs: 6 * 3600_000, swrMs: 3600_000 });
  let upstream = 0;
  const t0 = performance.now();
  for (let i = 0; i < QUERIES; i++) {
    const k = `overpass:${zipf(rnd, KEYS)}`;
    await cache.fetch(k, async () => { upstream++; return i; }, 6 * 3600_000);
  }
  const ms = performance.now() - t0;
  const s = cache.stats() as any;
  return {
    workload: "repeated (zipf)",
    queries: QUERIES,
    distinctKeys: KEYS,
    upstreamCalls: upstream,
    savedCalls: QUERIES - upstream,
    hitRate: cache.hitRate(),
    coalesced: s.coalesced,
    ms: Math.round(ms),
    qps: Math.round((QUERIES / ms) * 1000),
  };
}

async function stampede() {
  const cache = new LruCache<number>({ max: 10, ttlMs: 60_000 });
  let upstream = 0;
  const t0 = performance.now();
  await Promise.all(
    Array.from({ length: CONCURRENCY }, () =>
      cache.fetch("cold", async () => { upstream++; await new Promise((r) => setTimeout(r, 25)); return 1; }, 60_000),
    ),
  );
  const ms = performance.now() - t0;
  return {
    workload: "stampede (single-flight)",
    queries: CONCURRENCY,
    distinctKeys: 1,
    upstreamCalls: upstream,
    savedCalls: CONCURRENCY - upstream,
    hitRate: cache.hitRate(),
    coalesced: (cache.stats() as any).coalesced,
    ms: Math.round(ms),
    qps: Math.round((CONCURRENCY / ms) * 1000),
  };
}

function keyStability() {
  // Same logical query, different argument order / unicode form / float repr.
  const a = cacheKey("overpass", { selectors: ["bank", "port"], bbox: [1, 2, 3, 4] }, 51.9000001);
  const b = cacheKey("overpass", { bbox: [1, 2, 3, 4], selectors: ["bank", "port"] }, 51.9);
  const unicode = canonical("İstanbul") === canonical("İstanbul".normalize("NFKC"));
  return { identicalKeyForEquivalentQuery: a === b, unicodeNormalised: unicode, sampleKey: a };
}

function memoWarmup() {
  const f = memoize((lat: number, lon: number) => Math.round(lat * 1000 + lon), { ns: "bench" });
  const t0 = performance.now();
  let acc = 0;
  for (let i = 0; i < 1_000_000; i++) acc += f(51.92, 4.47) + (i & 0);
  const ms = performance.now() - t0;
  return { calls: 1_000_000, distinctInputs: 1, ms: Math.round(ms), checksum: acc };
}

async function main() {
  const rnd = mulberry32(0xC0FFEE);
  const rows = [await repeated(rnd), await stampede()];
  const stability = keyStability();
  const memo = memoWarmup();

  console.log("GIS OSINT Agentic Swarm — cache bench\n");
  console.log("workload                   queries  keys  upstream   saved  hitRate    qps");
  for (const r of rows) {
    console.log(
      `${r.workload.padEnd(26)} ${String(r.queries).padStart(7)} ${String(r.distinctKeys).padStart(5)} ` +
      `${String(r.upstreamCalls).padStart(9)} ${String(r.savedCalls).padStart(7)} ` +
      `${(r.hitRate * 100).toFixed(1).padStart(7)}% ${String(r.qps).padStart(6)}`,
    );
  }
  console.log("");
  console.log(`key stability:      equivalent queries share a key = ${stability.identicalKeyForEquivalentQuery}`);
  console.log(`unicode normalised: ${stability.unicodeNormalised}`);
  console.log(`memoized geo math:  ${memo.calls.toLocaleString()} calls over ${memo.distinctInputs} distinct input in ${memo.ms}ms`);

  const dash = dashboard();
  console.log(`\nregistered caches:  ${dash.rows.length}  aggregate hitRate=${(dash.totalHitRate * 100).toFixed(1)}%`);

  const out = resolve(process.cwd(), "out");
  mkdirSync(out, { recursive: true });
  const path = resolve(out, "cache-bench.json");
  writeFileSync(path, JSON.stringify({ generatedAt: new Date().toISOString(), rows, stability, memo, registeredCaches: dash.rows }, null, 2));
  console.log(`\nwrote ${path}`);

  // Bench asserts its own economics: a swarm that misses >60% of hot queries
  // would be paying full upstream cost at 10^8 nodes, which is the failure we
  // are engineering against.
  // The steady-state workload carries the hit-rate floor. The stampede
  // workload is a different (stricter) property: N concurrent cold misses must
  // collapse to ONE upstream call, so it is gated on upstreamCalls, not hitRate.
  const steady = rows.filter((r) => r.workload.startsWith("repeated"));
  const worst = Math.min(...steady.map((r) => r.hitRate));
  const stampedeRow = rows.find((r) => r.workload.startsWith("stampede"));
  const coalescedOk = !stampedeRow || stampedeRow.upstreamCalls <= 1;
  if (worst < 0.6 || !coalescedOk) {
    console.error(
      `\nFAIL: steady-state hit rate ${(worst * 100).toFixed(1)}% (floor 60%)` +
        (coalescedOk ? "" : `; stampede upstreamCalls=${stampedeRow!.upstreamCalls} (must be 1)`),
    );
    process.exitCode = 1;
  } else {
    console.log(
      `\nPASS: steady-state hit rate ${(worst * 100).toFixed(1)}% ≥ 60% floor; ` +
        `stampede coalesced ${stampedeRow?.queries ?? 0} concurrent cold misses → ${stampedeRow?.upstreamCalls ?? 1} upstream call`,
    );
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
