# QAA — Quality Assurance Automation

QAA here is not "does it run". It asserts the **economic and safety properties the system is sold on**, offline and deterministically.

```bash
bun test                 # 36 assertions, ~0.3 s, no network
bash scripts/ci-gate.sh  # G1–G6, the gate that must pass before push/deploy
```

## What is asserted

### 1. Cache — the unit economics
- TTL expiry actually expires.
- LRU evicts the **least-recently-used** key only (recency is touched on read).
- **Single-flight**: 25 concurrent misses → exactly **1** upstream call, `coalesced === 24`.
- stale-while-revalidate serves stale immediately and refreshes behind the request.
- Canonical keys are order/unicode/float stable.
- `memoize` collapses repeated geo math (1 distinct input, 1 computation).
- The dashboard surface reports a numeric hit rate.

### 2. Auth — one contract, three providers
- Malformed tokens are rejected **before any crypto runs**.
- Issuer, audience and expiry gates fire in order, with the failing check named.
- A real RS256 token verifies; a tampered signature does not.
- The hosted-domain (`hd`) gate blocks the wrong tenant.
- `AuthSwarm.admit()` returns the **same object** on the second call — proof there is no re-verification storm.

### 3. Load — swarm primitives under concurrency
- Semaphore caps peak concurrency and fully drains its queue.
- Token bucket refuses a burst above the rate.
- `retry` backs off then succeeds.
- `pMap` preserves input order under bounded concurrency.

### 4. Conductor — orchestration
- Identical work collapses to one run (cache + single-flight across tasks).
- DAG runs levels in order and joins; results come back in caller order.
- Cycles are refused, not looped.
- Unknown agent fails loudly, never silently.
- The real four-agent swarm caches offline overpass/imagery work.

### 5. Agents — GIS OSINT behaviour
- Overpass offline fixture is deterministic (reproducible QAA).
- Imagery offline index is well-formed.
- Metadata extracts sidecar places, handles and currencies.
- Metadata **refuses to invent geo from nothing** (the anti-hallucination gate).
- Geosocial clusters points and correlates known entities.
- Geo math is correct and memoised.

### 6. Signal — confidence from sources, never from vibes
- Confidence scales with **independent** sources, not raw count.
- Labels map to the 40/70/90 thresholds.
- Reports count labels and the multi-source bar.
- RWA score is deterministic, graded, and order-independent.
- Onchain correlation yields intensity + local FX.

### 7. Policy — enforced, not documented
- **No** paid/proprietary GIS provider host appears in `src/`, `cloudflare/`, `scripts/`.
- The edge worker pins `tiles.openfreemap.org`.
- Every registered agent declares a cache key, a positive TTL and a layer in 1..7; network agents declare a host, and that host is not a paid provider.
- Cache TTLs are ordered `imagery > overpass > geosocial`.

## The CI gate

| Gate | Check | Failure means |
|---|---|---|
| **G1** | `tsc --noEmit` clean across src, cloudflare, scripts, tests | type drift |
| **G2** | QAA suite green | a sold property regressed |
| **G3** | no paid GIS host in shipped code | the open-stack mandate was broken |
| **G4** | edge worker pins the open tile origin | tiles silently moved to a paid host |
| **G5** | cache hit rate ≥ **60 %** floor + single-flight `upstream === 1` | the cost model broke |
| **G6** | full offline conductor run completes with 0 failures | orchestration broke |

The 60 % floor is an economic floor, not a taste call: a swarm that misses more than 60 % of hot queries pays full upstream cost at 10^8 nodes. Measured headroom is 98 %.

## Adding an assertion

QAA is a Bun test file (`tests/qaa.test.ts`) with no fixture framework — assertions are plain `expect` on real primitives, so a new invariant is three lines:

```ts
test("my invariant", async () => {
  const c = new LruCache<number>({ max: 2, ttlMs: 1000 });
  // …
  expect(c.peek("k")).toBe(42);
});
```

Prefer asserting on `stats()` (numbers) over asserting on log text. If a property cannot be expressed as a number, that is usually a sign it should be — that is what `coalesced`, `hitRate`, `multiSourceRate` and per-layer `runs` exist for.
