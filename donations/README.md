# Donations & access layer

This is OSS: free to reuse, modify, fork and connect. Attribution to **Aleksei Dolgikh ([@alexdolbun](https://x.com/alexdolbun))** is appreciated.

Donations buy **sustainment and priority**, never correctness. Nothing in this repository is gated behind a payment — the QAA suite, the cache core, the auth swarm and every agent run for free, forever.

## What donations fund

| Tier | What it funds |
|---|---|
| **Any amount** | upkeep of the mirror ring, JWKS rotation monitoring, QAA runs, and the open tile-origin budget |
| **Credit / compute** | larger offline QAA sweeps and higher-fidelity fixtures |
| **Views / coverage** | distribution, so the open-stack mandate reaches more GIS builders |
| **High alpha** | prioritised ingestion of a region, venue or event you care about |

## Programmatic access

Two paths, deliberately distinct:

1. **Free — clone and connect.** Use the library directly. `bun test` is the contract; if it passes on your machine, you have the whole system. No key, no signup, no telemetry.
2. **Premium — the alpha feed (x402).** A metered, machine-payable feed for autonomous agents that want pre-computed, source-counted alpha signals rather than raw geometry. Payment is settled per request via **x402** against the edge worker; there is no account to create and no invoice to reconcile.

```
GET  /v1/x402/alpha/feed          # 402 → pay → 200 with the ranked signal set
POST /v1/x402/upload              # 402 → pay → 200 after ingest
```

Every premium signal carries the same provenance discipline as the free path: ≥1 source URL, a confidence score derived from **independent** sources, and a `VERIFIED / LIKELY / SPECULATIVE / UNSUBSTANTIATED` label. Paying does not buy a higher confidence number — it buys lower latency and higher volume.

## How to donate

- **Crypto:** send to the address published by the operator, or pay any x402-gated endpoint (that *is* a donation with a receipt).
- **Credit / compute:** open an issue offering resources.
- **Coverage:** write about it, link it, or send it to someone building GIS.
- **High alpha:** open an issue with the target; the swarm is designed to ingest a new region by adding a config entry, not a fork.

## What we will not do

- We will not add a paid or proprietary GIS provider to make a donation easier.
- We will not gate the open-stack policy, the QAA suite, or the cache core behind payment.
- We will not accept "sponsorship" that requires hiding a paid provider in the dependency tree.

If you need a commercial SLA, a private region deployment, or white-labeling, open an issue — the answer is a licence discussion, not a fork of the policy gates.
