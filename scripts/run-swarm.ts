/**
 * run-swarm.ts — the conductor's command line.
 *
 *   bun run scripts/run-swarm.ts --demo --offline     # deterministic, no network
 *   bun run scripts/run-swarm.ts --offline --cities 8
 *   bun run scripts/run-swarm.ts --live               # real Overpass + STAC
 *
 * Everything it prints is derived from actual run state: per-agent cache hit
 * rate, coalesced (saved) upstream calls, per-OSI-layer throughput, and the
 * ranked alpha report. It writes machine-readable artifacts to ./out/ and
 * prints their absolute paths.
 *
 * In --offline mode no socket is opened: the agents serve deterministic
 * fixtures, so the run is reproducible and safe in CI.
 */
import { writeFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { buildSwarm, type Task } from "../src/index.ts";
import { rwaSignals, toSignal, report, labelFor } from "../src/index.ts";
import type { AlphaSignal, GeoPoint, KnownEntity, RwaInput } from "../src/index.ts";

const argv = process.argv.slice(2);
const has = (f: string) => argv.includes(f);
const num = (f: string, d: number) => {
  const i = argv.indexOf(f);
  return i >= 0 && argv[i + 1] ? Number(argv[i + 1]) : d;
};

const OFFLINE = has("--offline") || has("--demo") || !has("--live");
const CITY_LIMIT = num("--cities", 6);
const CONC = num("--concurrency", Number(process.env.SWARM_CONCURRENCY ?? 8));
const RATE = num("--rate", Number(process.env.SWARM_RATE_PER_MIN ?? 240));
const OUT = resolve(process.cwd(), has("--out") ? String(argv[argv.indexOf("--out") + 1]) : "out");

interface City { name: string; lat: number; lon: number; ccy: string; bbox: [number, number, number, number] }

const CITY_SPINE: City[] = [
  { name: "Rotterdam", lat: 51.9244, lon: 4.4777, ccy: "EUR", bbox: [51.85, 4.25, 52.05, 4.65] },
  { name: "Singapore", lat: 1.3521, lon: 103.8198, ccy: "SGD", bbox: [1.2, 103.6, 1.5, 104.05] },
  { name: "Dubai", lat: 25.2048, lon: 55.2708, ccy: "AED", bbox: [24.9, 54.9, 25.5, 55.6] },
  { name: "New York", lat: 40.7128, lon: -74.006, ccy: "USD", bbox: [40.5, -74.3, 40.95, -73.7] },
  { name: "Shanghai", lat: 31.2304, lon: 121.4737, ccy: "CNY", bbox: [30.9, 121.2, 31.5, 121.8] },
  { name: "Hamburg", lat: 53.5511, lon: 9.9937, ccy: "EUR", bbox: [53.4, 9.8, 53.7, 10.2] },
  { name: "Amsterdam", lat: 52.3676, lon: 4.9041, ccy: "EUR", bbox: [52.25, 4.7, 52.45, 5.1] },
  { name: "Hong Kong", lat: 22.3193, lon: 114.1694, ccy: "HKD", bbox: [22.15, 113.9, 22.5, 114.4] },
  { name: "Tel Aviv", lat: 32.0853, lon: 34.7818, ccy: "ILS", bbox: [31.95, 34.6, 32.2, 34.95] },
  { name: "Riyadh", lat: 24.7136, lon: 46.6753, ccy: "SAR", bbox: [24.5, 46.4, 24.9, 46.95] },
];

const SELECTORS = [
  'node["harbour"]',
  'way["landuse"="industrial"]',
  'way["man_made"="pier"]',
  'node["amenity"="bank"]',
  'node["office"="financial"]',
  'way["building"="warehouse"]',
];

const KNOWN: KnownEntity[] = [
  { id: "port:rotterdam", name: "Port of Rotterdam", kind: "venue", lat: 51.9491, lon: 4.1437 },
  { id: "port:singapore", name: "Port of Singapore", kind: "venue", lat: 1.2644, lon: 103.82 },
  { id: "port:jebel-ali", name: "Jebel Ali Port", kind: "venue", lat: 25.0106, lon: 55.0614 },
  { id: "port:newark", name: "Port Newark-Elizabeth", kind: "venue", lat: 40.6846, lon: -74.1502 },
  { id: "fin:nyse", name: "New York Stock Exchange", kind: "venue", lat: 40.7069, lon: -74.0113 },
  { id: "fin:sgx", name: "Singapore Exchange", kind: "venue", lat: 1.2839, lon: 103.8514 },
  { id: "dc:ashburn", name: "Ashburn Data Center Alley", kind: "venue", lat: 39.0438, lon: -77.4874 },
];

async function main() {
  const t0 = Date.now();
  const cities = CITY_SPINE.slice(0, CITY_LIMIT);

  const conductor = buildSwarm({
    offline: OFFLINE,
    defaultConcurrency: CONC,
    ratePerMin: RATE,
    onEvent: (e) => {
      if (has("--verbose")) console.error(`[evt] ${e.type} ${e.agent ?? ""} ${e.taskId ?? ""} ${e.ms ?? ""}`);
    },
  });

  const from = "2026-08-01";
  const to = "2026-09-01";

  /* ── Level 0: fan out overpass + imagery per city (independent) ── */
  const tasks: Task<any>[] = [];
  for (const c of cities) {
    tasks.push({
      id: `overpass:${c.name}`,
      agent: "overpass",
      input: { bbox: c.bbox, selectors: SELECTORS, timeoutSec: 25 },
    });
    tasks.push({
      id: `imagery:${c.name}`,
      agent: "imagery",
      input: { bbox: c.bbox, from, to, collections: ["sentinel-2-l2a"], maxCloud: 30 },
    });
  }
  /* ── Level 1: metadata on a sidecar caption ── */
  tasks.push({
    id: "metadata:sidecar",
    agent: "metadata",
    input: {
      text: "RAISE Summit, Paris, France — ticket priced in EUR, organiser @alexdolbun, venue 48.8566, 2.3522",
    },
    after: [`overpass:${cities[0].name}`],
  });

  /* ── Level 2: geo-social correlation (needs the level-0 pins) ── */
  const points: GeoPoint[] = cities.flatMap((c, i) => [
    { id: `${c.name.toLowerCase()}-hq`, lat: c.lat, lon: c.lon, ts: Date.UTC(2026, 7, 10 + i), source: "x.com", text: `${c.name} deal flow`, handles: ["@alexdolbun"], currencies: [c.ccy] },
    { id: `${c.name.toLowerCase()}-port`, lat: c.lat + 0.035, lon: c.lon - 0.05, ts: Date.UTC(2026, 7, 12 + i), source: "osm", text: `${c.name} port activity`, currencies: [c.ccy] },
    { id: `${c.name.toLowerCase()}-fin`, lat: c.lat - 0.01, lon: c.lon + 0.012, ts: Date.UTC(2026, 7, 20 + i), source: "news", text: `${c.name} capital inflow`, handles: ["@alexdolbun"], currencies: [c.ccy] },
  ]);
  tasks.push({
    id: "geosocial:all",
    agent: "geosocial",
    input: { points, known: KNOWN, cellDeg: 0.25, radiusKm: 30, topN: 20 },
    after: cities.map((c) => `overpass:${c.name}`),
  });
  tasks.push({
    id: "geosocial:all-repeat",
    agent: "geosocial",
    input: { points, known: KNOWN, cellDeg: 0.25, radiusKm: 30, topN: 20 },
    after: ["geosocial:all"], // identical input → must be served from cache
  });

  const results = await conductor.runDag(tasks, CONC);

  /* ── Alpha capture: turn agent output into ranked, sourced signals ── */
  const rwaInputs: RwaInput[] = cities.map((c) => {
    const ov = results.find((r) => r.id === `overpass:${c.name}`);
    const poi = (ov?.result as any)?.classes ?? {};
    return {
      place: `${c.name}`, lat: c.lat, lon: c.lon, poi,
      capitalEntities: KNOWN.filter((k) => Math.abs(k.lat - c.lat) < 1.5 && Math.abs(k.lon - c.lon) < 1.5).map((k) => k.id),
      sources: [`https://overpass-api.de/api/interpreter?data=${encodeURIComponent(c.name)}`, `https://earth-search.aws.element84.com/v1#${c.name}`],
    };
  });

  const signals: AlphaSignal[] = [...rwaSignals(rwaInputs)];
  const gs = results.find((r) => r.id === "geosocial:all")?.result as any;
  for (const cl of gs?.hot ?? []) {
    signals.push(toSignal(
      {
        key: cl.cell,
        text: `Velocity spike in cell ${cl.cell}: ${cl.count} geo-events, ${cl.velocity.toFixed(2)}/day`,
        category: "GEOGRAPHIC",
        sources: Object.keys(cl.sources).map((s) => `https://example.org/${s}`),
        agreement: 0.6,
        geo: { lat: cl.centroid[0], lon: cl.centroid[1] },
      },
      "geo-economic",
      { entities: cl.topHandles.map((pair: [string, number]) => pair[0]), upside: cl.intensity * 100 },
    ));
  }
  const alpha = report(signals, 10);

  /* ── Report ── */
  const dash = conductor.cacheReport();
  const m = conductor.metrics;

  const lines: string[] = [];
  lines.push(`GIS OSINT Agentic Swarm — conductor run (${OFFLINE ? "offline/deterministic" : "LIVE network"})`);
  lines.push(`tasks=${tasks.length} ok=${m.ok} failed=${m.failed} cached=${m.cached} wall=${Date.now() - t0}ms`);
  lines.push("");
  lines.push("OSI layer throughput:");
  for (const [layer, v] of Object.entries(m.perLayer).sort((a, b) => Number(a[0]) - Number(b[0]))) {
    lines.push(`  L${layer}  runs=${(v as any).runs}  ms=${(v as any).ms}`);
  }
  lines.push("");
  lines.push(`cache: totalHitRate=${(dash.totalHitRate * 100).toFixed(1)}%  savedUpstreamCalls=${dash.totalSavedCalls}`);
  lines.push("  agent                        size    hits  misses  hitRate  coalesced");
  for (const r of dash.rows) {
    lines.push(`  ${r.name.padEnd(28)} ${String(r.size).padStart(5)} ${String(r.hits).padStart(7)} ${String(r.misses).padStart(7)} ${(r.hitRate * 100).toFixed(1).padStart(7)}% ${String(r.coalesced).padStart(10)}`);
  }
  lines.push("");
  lines.push(`alpha: signals=${alpha.signals.length} multiSourceRate=${alpha.multiSourceRate} ` +
    Object.entries(alpha.counts).map(([k, v]) => `${k}=${v}`).join(" "));
  for (const s of alpha.top.slice(0, 6)) {
    lines.push(`  [${labelFor(s.confidence)}] ${String(s.confidence).padStart(3)}  ${s.kind.padEnd(14)} ${s.title}`);
  }

  mkdirSync(OUT, { recursive: true });
  const swarmPath = resolve(OUT, "swarm-report.json");
  const alphaPath = resolve(OUT, "alpha-report.json");
  writeFileSync(swarmPath, JSON.stringify({
    generatedAt: new Date().toISOString(),
    mode: OFFLINE ? "offline" : "live",
    tasks: tasks.length,
    metrics: m,
    caches: dash,
    results: results.map((r) => ({ id: r.id, agent: r.agent, ok: r.ok, ms: r.ms, cached: r.cached, error: r.error })),
  }, null, 2));
  writeFileSync(alphaPath, JSON.stringify(alpha, null, 2));

  console.log(lines.join("\n"));
  console.log("");
  console.log(`wrote ${swarmPath}`);
  console.log(`wrote ${alphaPath}`);

  if (m.failed > 0) {
    console.error(`\n${m.failed} task(s) failed — see swarm-report.json`);
    process.exitCode = 1;
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
