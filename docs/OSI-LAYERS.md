# OSI layers — where the work actually sits

The swarm is built by an engineer who thinks in OSI layers, so every node declares which layer it really occupies. `spec.layer` is not decoration: the conductor aggregates `perLayer` run counts and timings, and QAA rejects any agent outside 1..7. The run report prints throughput per layer.

| Layer | Name | In this system | Node |
|---|---|---|---|
| **L1** | Physical | satellite/sensor origin, edge PoP, tile origin | `cloudflare/gis-edge-worker.ts` |
| **L2** | Data link | frame/metadata decoding: EXIF, TIFF IFD, sidecar text, format sniffing | `agents/metadata.ts` |
| **L3** | Network/session | identity, token pools, jittered refresh, silent auto-login | `auth/manager.ts`, `auth/verify.ts` |
| **L4** | Transport | the two real upstream transports: OSM/Overpass and STAC imagery | `agents/overpass.ts`, `agents/imagery.ts` |
| **L5** | Session/orchestration | registry, scheduling, DAG, semaphores, rate limiting, geo clustering | `conductor/*`, `agents/geosocial.ts` |
| **L6** | Presentation | alpha reports, cache dashboard, run artifacts | `alpha/*`, `scripts/run-swarm.ts` |
| **L7** | Application | monetisation: x402 premium feed, donation/access layer | edge worker premium gate, [`../donations/README.md`](../donations/README.md) |

## Why the layer matters operationally

**Rate limiting is per layer, not global.** A token bucket is keyed by the *upstream host* an L4 agent declares, so Overpass and STAC each get their own budget. The auth swarm's refresh jitter is an L3 concern; the tile cache is an L1 concern. Conflating them is how a swarm DDoSes its own dependencies.

**Caching TTLs follow the layer.** L1 tiles are immutable for a year; L2 metadata is stable for hours; L4 POIs for 6 h and scenes for 24 h; L5 derivations for minutes; L6 reports are regenerated per run. A single global TTL would either hammer upstream or serve stale alpha.

**Failure isolation follows the layer.** An L4 upstream outage degrades one agent; the L5 conductor retries with jittered backoff, marks 4xx non-retryable, and the L6 report still renders with the agents that did respond. L3 never blocks L4: verification is cached by token hash, so a slow IdP does not stall a geo sweep.

**Concurrency is capped per agent, not per process.** The semaphore is per agent (`spec.concurrency`), so a slow imagery fan-out cannot starve fast Overpass queries, and neither can exhaust the event loop.

## Byte and protocol discipline

- **Byte management.** Cache keys are canonicalised strings (NFKC + sorted + float-stable); payloads in the edge worker are compact **columnar** arrays rather than GeoJSON objects-per-feature, so 300+ cities × N locales stay inside one small response. EXIF/TIFF parsing walks the IFD once with an explicit offset and bounds check.
- **Avoiding round trips.** Single-flight coalescing is the L3/L4 equivalent of TCP slow-start avoidance: one loader per key, no duplicate handshakes.
- **Protocol choice.** The tile origin is plain HTTPS with the origin's own `Cache-Control` respected at the edge; the client uses a Service Worker CacheFirst policy with zoom tiering. No paid, proprietary or metered GIS endpoint is reachable from any layer — that is a QAA gate, not a guideline.
- **Transport efficiency.** Imagery uses a **POST** STAC search with a bbox + weekly datetime window (one request per bbox/week, reused across every locale and currency). Overpass uses a mirror ring with per-host token buckets and a hard `timeoutSec`.

## Extending to a new layer

To add a node, implement `Agent<Q, R>` with the right `layer`, `kind`, `ttlMs` and a pure `keyOf`. If it is a network agent you **must** declare `network.host` — and if that host is a paid GIS provider, G3 fails the build. That is the whole extension contract.
