# Architecture

## Design constraints (in priority order)

1. **No paid or proprietary GIS provider, anywhere.** Not in code, not in a dependency, not in a transitive dep. Enforced by a QAA gate, not by convention.
2. **One cache primitive, one agent contract.** Every network call goes through the same LRU + single-flight. Every node implements `Agent<Q, R>`.
3. **Dependency-free runtime.** WebCrypto for signatures, pure math for geo, no build step. The same module graph runs in Bun, a Worker and CI.
4. **Deterministic under test.** Agents serve deterministic fixtures offline, so QAA asserts behaviour instead of hoping.
5. **Cheap at 10^8 nodes.** The unit economics live in cache hit rate and single-flight coalescing, not in agent cleverness.

## Layers

```
┌─────────────────────────────────────────────────────────────────────────┐
│ L7  Alpha Capture        capture.ts · rwa.ts · onchain.ts               │
│     confidence from independent sources · RWA grading · cell↔onchain    │
├─────────────────────────────────────────────────────────────────────────┤
│ L5  Conductor            conductor.ts · scheduler.ts · registry.ts      │
│     registry · per-agent LRU+single-flight · semaphore per agent ·      │
│     token bucket per host · DAG levels · metrics · event stream         │
├─────────────────────────────────────────────────────────────────────────┤
│ L4  GIS OSINT agents     overpass.ts (6 h) · imagery.ts (24 h)          │
│     geosocial.ts (5 m, compute)                                         │
├─────────────────────────────────────────────────────────────────────────┤
│ L3  Auth Swarm           google.ts · microsoft.ts · huawei.ts           │
│     manager.ts (token pool, jittered refresh) · verify.ts (WebCrypto)   │
├─────────────────────────────────────────────────────────────────────────┤
│ L2  Metadata             metadata.ts — EXIF/sidecar geo (3 h, compute)  │
├─────────────────────────────────────────────────────────────────────────┤
│ L1  Edge / origin        cloudflare/gis-edge-worker.ts — open tile      │
│     origin CacheFirst · city spine · x402 premium gate                  │
└─────────────────────────────────────────────────────────────────────────┘
```

Layers are declared by each agent (`spec.layer`) and reported per layer by the conductor's metrics, so throughput per OSI layer is observable in the run report. See [`OSI-LAYERS.md`](OSI-LAYERS.md).

## The agent contract

```ts
interface AgentSpec<Q, R> {
  name: string;
  layer: number;                 // 1..7 — where the work really sits
  kind: "network" | "compute" | "onchain";
  ttlMs: number;                 // cache TTL
  keyOf: (input: Q) => string;   // pure, deterministic cache key
  concurrency?: number;          // per-agent parallelism cap
  network?: { host: string; budgetPerMin?: number };  // REQUIRED for kind=network
  note?: string;                 // dashboard annotation
}
interface Agent<Q, R> { spec: AgentSpec<Q, R>; run(input: Q, ctx: AgentCtx): Promise<R>; }
```

`defineAgent` validates at construction:

- `layer` must be 1..7;
- `kind: "network"` **must** declare `spec.network.host` — otherwise it throws.

That single rule is what makes the open-stack mandate mechanically enforceable: a network agent cannot exist without naming the one host it may touch, so a policy gate can prove no paid provider is reachable.

`AgentCtx` carries `{ offline, env, fetchImpl, now, log, bag }`. No globals, no ambient state — which is why the same agent is unit-testable, containerizable and edge-deployable without a shim.

## Execution path of one task

```
run(task)
  ├─ resolve agent by name            (unknown name → throws, never silently)
  ├─ key = `${name}:${spec.keyOf(input)}`
  ├─ wasHot = cache.peek(key) !== undefined
  ├─ semaphore(agent)                 ← per-agent fair concurrency
  └─ cache.fetch(key, loader, ttlMs)  ← single-flight: N callers → 1 loader
        └─ if kind === "network":
             tokenBucket(host).take() ← per-host rate limit, no bursts
             retry(…, networkAttempts, jittered backoff, 4xx = non-retryable)
           else: run(input, ctx)
```

Everything the conductor does is observable: `onEvent` emits `start | end | cache-hit | retry | error | dag-start | dag-end`, and `metrics` aggregates `perAgent` and `perLayer` run counts, timings and cache hits.

## DAG execution

`runDag(tasks)` computes in-degrees, executes one topological level at a time with bounded concurrency, decrements children, and throws on an unknown dependency or a cycle. Results are returned **in the caller's task order** regardless of completion order, so downstream code is deterministic.

## Auth Swarm

Three providers, one identity shape:

| Provider | Client-side auto-login | Server-side tenant gate |
|---|---|---|
| Google | GIS One Tap `auto_select` + FedCM silent | `hd` claim |
| Microsoft | MSAL `ssoSilent` with account hint | `tid` claim |
| Huawei | HMS Account Kit silent sign-in | `domain` claim |

`verify.ts` is a dependency-free OIDC/JWT verifier (RS256/384/512, PS256, ES256/384) built on WebCrypto, so the identical code path runs in Bun, in a Worker, and in the test suite. JWKS is fetched through a shared LRU (single-flight, 1 h TTL) — millions of verifications against roughly one key fetch per rotation. Signing keys are cached by `alg:kid`, and `AuthSwarm` dedupes concurrent verifications of the same token and refreshes access tokens **ahead of expiry with jitter**, so a swarm never forms a refresh thundering herd.

## Alpha Capture

`capture.ts` refuses to let a signal be born without sources: confidence is a function of the count of **independent hosts** (≤70 points) plus declared agreement (≤30 points), mapped to `VERIFIED ≥90 / LIKELY ≥70 / SPECULATIVE ≥40 / UNSUBSTANTIATED`. `report()` additionally reports `multiSourceRate` — the fraction of signals clearing the ≥2-source bar. RWA scoring (`rwa.ts`) and onchain correlation (`onchain.ts`) are pure functions of objective inputs, so the same place always scores the same and QAA can pin a fixture.

## Edge

`cloudflare/gis-edge-worker.ts` is a single Worker serving the open tile origin through the edge cache, the compact columnar city spine, edge ID-token verification, and an x402-gated premium alpha feed. Tiles are `tiles.openfreemap.org` only, cached with the origin's own `Cache-Control`.
