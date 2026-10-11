# Run Report — 2026-10-11

Continuous-stream execution of the **GIS OSINT Agentic Swarm Orchestra Conductor**,
from the Grok share brief. Everything below is a measured number from a run on this
machine, not a projection.

- **Version:** v2.0.0
- **Runtime:** Bun 1.2.21 / Node 22 fallback · zero runtime dependencies
- **Network:** live Overpass + STAC (Element84 earth-search) and offline deterministic fixtures
- **Repo:** https://github.com/alexdolbun/gis-osint-agentic-swarm

---

## 1. Gate summary — `bash scripts/ci-gate.sh`

| Gate | Check | Result |
|---|---|---|
| G1 | typecheck (`bunx tsc --noEmit`, src + cloudflare + scripts + tests) | **PASS** |
| G2 | QAA suite | **PASS** — 36 tests / 112 assertions, 0 failures |
| G3 | open-stack policy — no paid/proprietary GIS host in shipped code | **PASS** |
| G4 | edge worker pins `tiles.openfreemap.org` | **PASS** |
| G5 | cache floor (steady-state hit rate ≥ 60 %) | **PASS** — 98.0 % |
| G6 | conductor smoke run (offline, deterministic) | **PASS** — 11/11 tasks, 0 failed |

`gate summary: 6 passed, 0 failed`

## 2. Cache economics — `bun run bench`

```
workload                   queries  keys  upstream   saved  hitRate    qps
repeated (zipf)              20000   400       400   19600    98.0% 730684
stampede (single-flight)       200     1         1     199     0.0%   7787

key stability:      equivalent queries share a key = true
unicode normalised: true
memoized geo math:  1,000,000 calls over 1 distinct input in 749ms
```

Two properties, two different measurements:

- **Heavy-tailed traffic (the real shape):** 20 000 queries over 400 distinct geo
  queries → **400 upstream calls instead of 20 000**. 98.0 % hit rate, 19 600 calls
  removed. This is the line that makes 10^8 nodes affordable.
- **Cache stampede:** 200 concurrent cold misses on one key → **1 upstream call**
  (199 coalesced by single-flight). Hit rate is meaningless here; `upstreamCalls` is the
  metric, and it is 1.
- **Memoised geo math:** 1 000 000 calls over 1 distinct input in ~750 ms.

## 3. Live network run — `bun run scripts/run-swarm.ts --live --cities 4`

```
tasks=11 ok=11 failed=0 cached=1 wall=31668ms
L2 runs=1  ·  L4 runs=8  ·  L5 runs=2
```

Real OSM/STAC data, real alpha signals (not fixtures):

| Signal | Confidence | Grade |
|---|---|---|
| Dubai — RWA | 87 | **A** (78.26) |
| Rotterdam — RWA | 84 | **A** (73.76) |
| Singapore — RWA | 84 | **A** (73.58) |
| New York — RWA | 54 | D (23.58) |

`multiSourceRate = 0.80` — 8 in 10 signals carry ≥ 2 independent sources, which is the
QAA bar for anything above `UNSUBSTANTIATED`.

**Resilience finding (fixed during this run):** the live Overpass path initially failed
with `400` because (a) the public mirrors reject requests without a descriptive
`User-Agent`, and (b) responses were unbounded (an 18 MB answer for one bbox). Both are
now handled: a pinned `User-Agent`, a hard POI cap in the generated QL, and a mirror
ring that only marks an endpoint dead after both form encodings fail. Re-run: **11/11**.

## 4. What was built

| Area | Files |
|---|---|
| Cache core | `src/cache/lru.ts` (LRU + single-flight + SWR), `keyhash.ts` (NFKC-canonical keys), `memo.ts`, `stats.ts` |
| Auth Swarm | `src/auth/google.ts`, `microsoft.ts`, `huawei.ts`, `verify.ts` (dependency-free RS256/PS256/ES256 via WebCrypto), `manager.ts` (token pool, jittered refresh, verify dedupe) |
| GIS OSINT agents | `src/agents/overpass.ts`, `imagery.ts` (STAC), `metadata.ts` (EXIF/JPEG), `geosocial.ts` (cell clustering + entity correlation) |
| Conductor | `src/conductor/conductor.ts` (DAG fan-out, per-agent cache + semaphore), `scheduler.ts` (semaphore, token bucket, jittered retry, ordered pMap), `registry.ts` |
| Alpha capture | `src/alpha/capture.ts` (source-counted confidence), `rwa.ts`, `onchain.ts` |
| Edge | `cloudflare/gis-edge-worker.ts` (OpenFreeMap tile cache, auth verify, x402 gate), `wrangler.toml` |
| Ops | `scripts/ci-gate.sh`, `cache-bench.ts`, `run-swarm.ts`, `backup-sync.sh`, `Dockerfile`, `docker-compose.yml`, `.github/workflows/ci.yml` |
| Docs | `README.md`, `docs/ARCHITECTURE.md`, `docs/CACHING.md`, `docs/QAA.md`, `docs/OSI-LAYERS.md`, `donations/README.md` |

## 5. Backup state

- **Local:** `backups/gis-osint-agentic-swarm-20261011T223427Z.tar.gz` (79 KB)
- **Mirror:** `~/backups/gis-osint-agentic-swarm/` (extracted tree)
- **GitHub:** pushed, `51` files on `main`
- **Cloudflare:** worker + `wrangler.toml` are deploy-ready; deployment is gated on a
  `CLOUDFLARE_API_TOKEN` and is left as a deliberate one-command step rather than run
  unattended against a shared account.

## 6. Honest limitations

- The `Auth Swarm` verifiers are exercised with locally generated RS256 keys in QAA;
  they have not been run against live Google/Microsoft/Huawei client IDs (no client
  secrets are present in this workspace).
- The RWA scores are a **model over objective inputs** (POI class density, capital
  proximity, onchain notional), not investment advice. Grades reflect inputs only.
- The live run depends on volunteer Overpass mirrors; the ring makes this resilient but
  latency is theirs, not ours (L4 wall time above is dominated by upstream).
