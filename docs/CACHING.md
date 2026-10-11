# Caching — the unit economics

At 10^8 nodes the only number that matters is **how many upstream calls the cache removes**. Everything else is rounding.

Measured on a cold clone (`bun run bench`):

```
workload                   queries  keys  upstream   saved  hitRate    qps
repeated (zipf)              20000   400       400   19600    98.0% 715814
stampede (single-flight)       200     1         1     199     0.0%   7640
```

- **98.0 %** steady-state hit rate on a heavy-tailed (Zipf-ish) workload — 19 600 of 20 000 hot geo queries never touch upstream.
- **200 → 1**: two hundred concurrent misses on a cold key collapse to **one** upstream call. That is the single-flight property, and it is the difference between a swarm and a stampede.

## The primitive

One class, `LruCache<V>`, backs every cache in the system.

| Property | Implementation | Why |
|---|---|---|
| O(1) get/set | `Map` insertion-order LRU | no linked-list bookkeeping under load |
| **Single-flight** | `inflight: Map<key, Promise>` | N concurrent misses → 1 upstream call |
| TTL | `exp` per entry | freshness per agent |
| **stale-while-revalidate** | `swrMs` + background refresh | hot keys never block on a refresh |
| Hard memory cap | evict oldest beyond `max` | never grows unbounded |
| Deterministic stats | hits/misses/evictions/**coalesced**/refreshes | QAA gates on numbers, not vibes |

`coalesced` is tracked separately from `hits` because it is a different economic event: a hit saves a call that would have been made *later*; a coalesced call saves a call that would have been made **right now**, concurrently. Both are counted in the dashboard's `totalSavedCalls`.

## Key canonicalisation — the difference between 0.4 and 0.95

A cache is only as good as its keys. `keyhash.ts` canonicalises so the **same** query always maps to the **same** key:

- **NFKC normalisation** — `ﬁle` and `file` are one key; CJK/Arabic/Devanagari variants collapse.
- **case folding** — `İstanbul` / `ISTANBUL` resolve consistently.
- **sorted object keys** — `{a,b}` and `{b,a}` are one key.
- **float formatting** — `1.50000` and `1.5` are one key.
- **grid snapping** — `geoCell(lat, lon, decimals)` snaps coordinates to a grid so *neighbouring* queries share a cell and therefore an entry. `snapBbox` does the same for bounding boxes.
- **week bucketing** — a rolling date window (`from`/`to`) buckets to whole ISO weeks, so a moving 30-day window reuses yesterday's scene index.

This is exactly what makes multilingual / multicurrency traffic cheap: the swarm does not re-fetch a city's POIs because a user asked in a different script or a different currency.

## TTL hierarchy (deliberate, asserted by QAA)

| Agent | TTL | Rationale |
|---|---|---|
| `imagery` (STAC scene index) | **24 h** | satellite scenes for a bbox/week do not change intraday |
| `overpass` (OSM POIs) | **6 h** | OSM edits are human-paced; 6 h is far below change rate |
| `metadata` (EXIF/sidecar) | **3 h** | pure compute, keyed on bytes + text |
| `geosocial` (clustering) | **5 m** | derived from live point sets; cheap to recompute |
| `onchain` (notional per cell) | **5 m** + 15 m SWR | liquidity moves fast; stale-serve then refresh |
| JWKS | **1 h** | rotate rarely; the hottest key in the system |

QAA asserts `imagery > overpass > geosocial`, so a future change cannot silently invert the hierarchy.

## Memoisation

Pure geo math is called millions of times by indexing and formatting. `memoize()` wraps it in an LRU keyed on canonical inputs:

```
memoized geo math: 1,000,000 calls over 1 distinct input in 741ms
```

Memoised by default: `geoCell`, `cellId`, `snapBbox`, `haversineKm`-adjacent helpers, `sniffFormat`. An unbounded TTL (no expiry) is intentional — the inputs are pure, so the value can never go stale.

## Eviction and memory

Every cache has a hard `max`. The conductor registers a per-agent cache at **20 000 entries**; the imagery index at 2 000; JWKS at 32. Bounded by construction — a long-running node cannot leak.

## Per-agent vs conductor caching

There are two layers, and they are not redundant:

1. **Agent-local caches** (`sceneCache`, `results`, `notionalCache`) — survive across conductor instances, hold provider-shaped data, have provider-appropriate TTLs.
2. **Conductor per-agent cache** — keyed on `agent:keyOf(input)`, gives the conductor a single dashboard and lets it mark a task `cached: true` before dispatch, so a warm task never even acquires a semaphore permit.

## Reproduce

```bash
bun run bench                                     # full bench
bun run bench --queries 200000 --keys 5000        # scale it up
bun run scripts/run-swarm.ts --offline --demo     # see per-agent dashboard live
```
