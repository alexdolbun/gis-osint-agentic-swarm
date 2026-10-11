# GIS OSINT Agentic Swarm Orchestra Conductor

**By Aleksei Dolgikh ([@alexdolbun](https://x.com/alexdolbun))**
High-Load Engineer (all 7 layers & ~400 protocols of the OSI model, 10+ years enterprise), Investor Activist, GIS Bachelor 2012–2016, Scout VCs.

Open Source Software (OSS) for reuse and programmatic connection in exchange for small donations (money, credit, views, coverage, high alpha). Connect via API, contribute, or integrate your agents/nodes.

> **v2.0.0** — the whole swarm is dependency-free TypeScript that runs unmodified in **Bun**, in a **Cloudflare Worker**, and in **CI**. No paid GIS provider anywhere in the dependency tree; one cache primitive behind every network call.

---

## What this is

A super-tight network of algorithms and agentic swarms for **Geographical Information Systems (GIS) OSINT alpha generation**. It orchestrates many nodes and views — real users and super-intelligent agents — across multilingual, multicurrency environments for onchain upside capture.

Two halves that share one contract:

1. **Auth Swarm** — rolls up market-leading seamless/auto-login into a single identity contract: **Google Identity Services** (One Tap, `auto_select`, FedCM, silent Credential Management API) first, then **Microsoft Entra ID / MSAL** (`ssoSilent`), then **Huawei HMS Account Kit**. One `Identity` shape, one verifier, one token pool — so a swarm of N agents never re-authenticates N times.
2. **GIS OSINT Agents + Conductor** — specialised nodes (historical imagery, Overpass/OSM, metadata extraction, geo-social correlation) driven by one orchestration core that owns caching, concurrency, rate limiting, DAG fan-out and the alpha sink.

The thing that makes this economical at scale is not the agents — it is the **cache and the single-flight discipline** between them (measured below: **98.0 % hit rate** on a heavy-tailed workload, and **200 concurrent cold misses collapse to 1 upstream call**).

---

## Measured results (reproducible)

```bash
bun run bench     # scripts/cache-bench.ts
bun run ci        # scripts/ci-gate.sh — all gates
```

```
workload                   queries  keys  upstream   saved  hitRate    qps
repeated (zipf)              20000   400       400   19600    98.0% 715814
stampede (single-flight)       200     1         1     199     0.0%   7640

key stability:      equivalent queries share a key = true
unicode normalised: true
memoized geo math:  1,000,000 calls over 1 distinct input in 741ms

PASS: steady-state hit rate 98.0% ≥ 60% floor;
      stampede coalesced 200 concurrent cold misses → 1 upstream call
```

| Metric | Value | Why it matters |
|---|---|---|
| Steady-state cache hit rate | **98.0 %** | 19 600 of 20 000 hot geo queries never touch upstream |
| Single-flight coalescing | **200 → 1** | a stampede costs one upstream call, not two hundred |
| Memoised geo math | 1 M calls / 741 ms | O(1) grid math on OSI L5–L7 without recompute |
| QAA suite | **36 / 36 pass** | cache, auth, load, conductor, agents, alpha, policy |
| CI gate | **6 / 6 pass** | typecheck, QAA, open-stack, origin, cache floor, smoke |

Run `bun run ci` to reproduce every number above on a cold clone.

---

## Architecture

```
                     ┌──────────────────────────────────────────────┐
   OSI L7 monetize → │  Alpha Capture  (confidence from sources)     │
                     │  RWA scoring · onchain correlation · ranking  │
                     └───────────────▲──────────────────────────────┘
                                     │ ranked signals
                     ┌───────────────┴──────────────────────────────┐
   OSI L5 orchestr.→ │  CONDUCTOR                                    │
                     │  registry · per-agent LRU + single-flight     │
                     │  semaphore · token bucket per host · DAG      │
                     └───────────────▲──────────────────────────────┘
                                     │ tasks (bounded concurrency)
        ┌────────────────┬───────────┴────────┬──────────────────────┐
   L4 │ overpass      │ imagery            │ geosocial          │
      │ OSM/Overpass  │ STAC scene index   │ cell clustering +  │
      │ (6 h TTL)     │ (24 h TTL)         │ entity match (5 m) │
        └────────────────┴────────────────────┴──────────────────────┘
   L2 │ metadata — EXIF/sidecar geo extraction (3 h TTL, compute-only)
   L3 │ Auth Swarm — Google → Microsoft → Huawei, one identity contract
        └──────────────────────────────────────────────────────────┘
```

Full detail: [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) · caching: [`docs/CACHING.md`](docs/CACHING.md) · QAA: [`docs/QAA.md`](docs/QAA.md) · OSI mapping: [`docs/OSI-LAYERS.md`](docs/OSI-LAYERS.md).

### The one agent contract

Every node implements the same shape, so it runs anywhere:

```ts
export const overpass: Agent<OverpassQuery, OverpassResult> = defineAgent(
  {
    name: "overpass",
    layer: 4,                     // OSI layer this work really sits on
    kind: "network",              // network | compute | onchain
    ttlMs: 6 * 3600_000,          // cache TTL
    keyOf: (q) => cacheKey("overpass", q.ql ?? "", q.bbox ?? [], q.selectors ?? []),
    network: { host: "overpass-api.de", budgetPerMin: 90 },  // enforced egress
  },
  async (q, ctx) => { /* … */ },
);
```

`kind: "network"` **must** declare `spec.network.host` — `defineAgent` throws otherwise, and the QAA policy gate asserts no banned host can appear. That is how the open-stack mandate is enforced rather than documented.

---

## Quickstart

```bash
git clone https://github.com/alexdolbun/gis-osint-agentic-swarm
cd gis-osint-agentic-swarm

bun install          # dev-only: @types/bun + typescript
bun test             # QAA suite (36 assertions)
bun run ci           # the full gate
bun run bench        # cache economics

bun run swarm:demo   # full offline conductor run (deterministic, no sockets)
bun run swarm        # live: real Overpass + STAC search
```

The demo writes machine-readable artifacts to `./out/` (`swarm-report.json`, `alpha-report.json`, `cache-bench.json`) and prints their absolute paths.

---

## Auth Swarm — auto-login as a swarm primitive

```ts
import { AuthSwarm, google, microsoft, huawei } from "./src/index.ts";

const swarm = new AuthSwarm({
  verify: { issuer: google.endpoints().issuer, audience: process.env.GOOGLE_CLIENT_ID!, jwksUri: google.endpoints().jwksUri },
});

const { ok, identity } = await swarm.admit("google", idToken);   // verified once, reused forever
```

Client bootstrap (drop-in, no UI flash) is generated per provider:

```ts
google.clientBootstrap({ clientId, loginUri: "/auth/google", domain: "corp.com" })
```

emits the `<div id="g_id_onload">` attributes (`data-auto_select="true"`, `data-itp_support="true"`, `data-hd`) **and** the FedCM silent-retrieval snippet, plus the exact CSP that makes it work. Microsoft emits an MSAL `ssoSilent` config; Huawei emits HMS Account Kit silent sign-in. Same identity contract for all three.

Verification is dependency-free WebCrypto (RS256/PS256/ES256) with a **shared JWKS LRU** — millions of verifications against ~one key fetch per rotation — and the tenant gate is enforced on the provider's own claim (`hd` / `tid` / `domain`), not on the email string.

---

## Layout

```
src/
  cache/      lru.ts (LRU + single-flight + SWR) · keyhash.ts (canonical keys) · memo.ts · stats.ts
  auth/       google.ts · microsoft.ts · huawei.ts · manager.ts (token pool) · verify.ts (WebCrypto) · types.ts
  agents/     base.ts (the contract) · overpass.ts · imagery.ts · metadata.ts · geosocial.ts
  conductor/  conductor.ts · scheduler.ts (semaphore/token bucket/retry/pMap) · registry.ts
  alpha/      capture.ts (confidence) · rwa.ts · onchain.ts
cloudflare/   gis-edge-worker.ts · wrangler.toml · package.json
data/         cities.json (city spine) · known-entities.json (entity seed)
scripts/      run-swarm.ts · cache-bench.ts · ci-gate.sh · backup-sync.sh
tests/        qaa.test.ts
docs/         ARCHITECTURE · CACHING · QAA · OSI-LAYERS
donations/    README.md
```

---

## Map stack (mandatory)

**MapLibre GL JS + OpenFreeMap only.** Styles `liberty` / `bright` / `dark`, tiles `tiles.openfreemap.org`, data OpenStreetMap. Never Mapbox, Google Maps, MapTiler, Stadia, Carto (as primary), TomTom, HERE, Bing/VirtualEarth, Yandex or Esri. The edge worker in `cloudflare/` caches the open origin at the edge with the origin's own `Cache-Control`, and the QAA policy gate fails the build on any banned host.

---

## Cloudflare Worker (edge)

```bash
cd cloudflare
bun install
bunx wrangler dev        # local edge
bunx wrangler deploy     # production
```

`gis-edge-worker.ts` serves three things off the edge cache: `/health`, `/v1/cities` (the compact columnar city spine), and `/tiles/*` (the open origin, CacheFirst). It additionally exposes `POST /v1/auth/verify` (edge ID-token verification through the same WebCrypto verifier) and the x402 premium-gated `GET /v1/alpha/feed`, so a paying agent gets the latest ranked signals without a redeploy.

---

## Reuse, connect, donate

- **Reuse** — MIT. Fork it, embed the agents, ship it.
- **Connect** — implement `Agent<Q, R>` and register it with the conductor; or call the edge worker over HTTP.
- **Donate** — money, credit, views, coverage, or high alpha. See [`donations/README.md`](donations/README.md). Attribution appreciated.

## Backup & resilience

```bash
bun run backup           # snapshot → local mirror → GitHub push
bash scripts/backup-sync.sh --dry
```

Three targets, cheapest first, so a failure never loses the previous copy: a timestamped tarball under `./backups`, an extracted mirror under `~/backups/`, then a commit + push when an origin is reachable. Cloudflare KV mirroring is delegated to wrangler when `CLOUDFLARE_API_TOKEN` is set.

## License

MIT — free to reuse, modify, connect. Attribution to Aleksei Dolgikh appreciated. Donations welcome for sustainment.

---

*Committed as part of the Agentic Swarm Orchestra for GIS OSINT alpha generation. For questions or collaboration: [@alexdolbun](https://x.com/alexdolbun)*
