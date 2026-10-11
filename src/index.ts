/**
 * index.ts — the public surface of the GIS OSINT Agentic Swarm.
 *
 * Everything below the surface is dependency-free: WebCrypto for token
 * verification, one LRU primitive for every cache, pure math for alpha. That is
 * deliberate — the same module graph runs in Bun (conductor/worker), in a
 * Cloudflare Worker (edge), and in CI (QAA), with no build step and no paid
 * provider anywhere in the dependency tree.
 */
export const VERSION = "2.0.0";

/* ---- cache core (the reason this swarm is cheap) ---- */
export { LruCache } from "./cache/lru.ts";
export type { LruOptions, CacheStats } from "./cache/lru.ts";
export { register, dashboard, allCaches, resetAll, clearAll } from "./cache/stats.ts";
export type { CacheDashboardRow } from "./cache/stats.ts";
export { canonical, cacheKey, geoCell, nfkc, fnv1a64 } from "./cache/keyhash.ts";
export { memoize } from "./cache/memo.ts";

/* ---- auth swarm (Google → Microsoft → Huawei) ---- */
export type { ProviderId, Identity, JwkSet, VerifyOptions, VerifyResult, Provider, TokenRecord } from "./auth/types.ts";
export { verifyJwt } from "./auth/verify.ts";
export { google, GOOGLE_ISSUERS } from "./auth/google.ts";
export { microsoft } from "./auth/microsoft.ts";
export { huawei } from "./auth/huawei.ts";
export { AuthSwarm, PROVIDERS } from "./auth/manager.ts";

/* ---- GIS OSINT agents ---- */
export { defineAgent, makeCtx } from "./agents/base.ts";
export type { Agent, AgentSpec, AgentCtx, AgentKind, MakeCtxOptions } from "./agents/base.ts";
export { overpass, buildQl, classify as classifyPoi, MIRRORS, offlineFixture, _overpassCache, _resetDead } from "./agents/overpass.ts";
export type { OverpassQuery, OverpassResult, Poi } from "./agents/overpass.ts";
export { imagery, snapBbox, weekBucket, delta as imageryDelta, offlineSceneIndex, DEFAULT_STAC, DEFAULT_COLLECTIONS, _imageryCache } from "./agents/imagery.ts";
export type { ImageryQuery, SceneIndex, Scene, ImageryDelta } from "./agents/imagery.ts";
export { metadata, sniffFormat, dmsToDeg } from "./agents/metadata.ts";
export type { GeoMetadata, MetadataInput } from "./agents/metadata.ts";
export { geosocial, cellId, haversineKm } from "./agents/geosocial.ts";
export type { CorrelationInput, CorrelationResult, Cluster, KnownEntity, GeoPoint, EntityMatch } from "./agents/geosocial.ts";

/* ---- conductor ---- */
export { Conductor } from "./conductor/conductor.ts";
export type { Task, TaskResult, ConductorEvent, ConductorOptions } from "./conductor/conductor.ts";
export { Semaphore, TokenBucket, RateLimiter, retry, pMap } from "./conductor/scheduler.ts";
export { registerAgent, getAgent, listAgents, agentsByLayer } from "./conductor/registry.ts";

/* ---- alpha capture ---- */
export * from "./alpha/capture.ts";
export * from "./alpha/rwa.ts";
export * from "./alpha/onchain.ts";

import { Conductor } from "./conductor/conductor.ts";
import type { ConductorOptions } from "./conductor/conductor.ts";
import { overpass } from "./agents/overpass.ts";
import { imagery } from "./agents/imagery.ts";
import { metadata } from "./agents/metadata.ts";
import { geosocial } from "./agents/geosocial.ts";
import { registerAgent } from "./conductor/registry.ts";

/** The canonical four-agent OSINT swarm, wired and registered. */
export function buildSwarm(opts: ConductorOptions = {}): Conductor {
  const c = new Conductor(opts);
  for (const a of [overpass, imagery, metadata, geosocial]) {
    c.register(a as never);
    registerAgent(a as never);
  }
  return c;
}
