/**
 * gis-edge-worker.ts — the always-on edge of the swarm.
 *
 * One Worker deployment that does four things and nothing else:
 *
 *   1. TILE/STYLE EDGE CACHE — OpenFreeMap only. `tiles.openfreemap.org` is the
 *      single upstream map origin; styles are 1 day, planet tiles immutable for
 *      a year. Anything else is not proxied here, by policy and by design.
 *   2. IDENTITY — verifies provider ID tokens (Google / Microsoft / Huawei) at
 *      the edge using the same dependency-free verifier as the conductor, so a
 *      token is checked where the request lands, not on a round trip home.
 *   3. x402 GATE — premium data (the alpha feed, bulk GeoJSON) is paid, not
 *      free. Unpaid requests get a real HTTP 402 with machine-readable payment
 *      requirements; settlement is verified against a facilitator before any
 *      payload is released. If no facilitator is configured the gate stays
 *      CLOSED — it never hands out premium data on an unverified promise.
 *   4. REPORT MIRROR — serves the latest conductor report from KV, so the swarm
 *      keeps answering while the origin is asleep, rate-limited, or being
 *      redeployed.
 *
 * Bindings (cloudflare/wrangler.toml):
 *   GIS_KV         — KV: alpha feed, swarm report, city spine, token verdicts
 *   OFM_ORIGIN     — optional upstream override, defaults to the public origin
 *   X402_PAY_TO    — receiving address for x402 payments (absent ⇒ premium closed)
 *   X402_FACILITATOR — optional settlement verifier endpoint
 *   X402_PRICE_USD — price per premium call, default "5"
 */
import { verifyJwt } from "../src/auth/verify.ts";
import type { ProviderId, VerifyResult } from "../src/auth/types.ts";
import { LruCache } from "../src/cache/lru.ts";

/* ── minimal binding shapes (kept local so this file typechecks without
      pulling in the Workers type package) ─────────────────────────────── */
interface KvLike {
  get(key: string, type?: "text" | "json"): Promise<string | null>;
  put(key: string, value: string, opts?: { expirationTtl?: number }): Promise<void>;
}
interface Env {
  GIS_KV?: KvLike;
  OFM_ORIGIN?: string;
  X402_PAY_TO?: string;
  X402_FACILITATOR?: string;
  X402_PRICE_USD?: string;
  GOOGLE_CLIENT_ID?: string;
  MICROSOFT_CLIENT_ID?: string;
  HUAWEI_CLIENT_ID?: string;
}
interface Ctx { waitUntil(p: Promise<unknown>): void }

const OFM = "https://tiles.openfreemap.org";
const TTL = {
  tiles: 31_536_000,   // immutable planet tiles
  styles: 86_400,      // styles + sprite + glyphs, revalidated daily
  spine: 86_400,       // city spine
  feed: 300,           // alpha feed: 5 min at the edge, KV is the origin
  status: 30,
} as const;

const CORS: Record<string, string> = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, POST, OPTIONS",
  "access-control-allow-headers": "content-type, authorization, x-payment, x-402-version",
};

const json = (body: unknown, init: { status?: number; ttl?: number; immutable?: boolean } = {}) =>
  new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: {
      "content-type": "application/json; charset=utf-8",
      ...(init.ttl ? { "cache-control": `public, max-age=${init.ttl}${init.immutable ? ", immutable" : ""}` } : { "cache-control": "no-store" }),
      ...CORS,
    },
  });

/** Edge CacheFirst: the Cache API in front of any origin fetch. */
async function edgeFirst(req: Request, ctx: Ctx, key: string, ttl: number, immutable: boolean, produce: () => Promise<Response>): Promise<Response> {
  const cache = (caches as unknown as { default: { match(r: Request): Promise<Response | undefined>; put(r: Request, res: Response): Promise<void> } }).default;
  const ck = new Request(key, { method: "GET" });
  const hit = await cache.match(ck);
  if (hit) return hit;
  const res = await produce();
  const out = new Response(res.body, {
    status: res.status,
    headers: { "content-type": res.headers.get("content-type") ?? "application/octet-stream", "cache-control": `public, max-age=${ttl}${immutable ? ", immutable" : ""}`, "x-swarm-cache": "miss", ...CORS },
  });
  if (out.ok) ctx.waitUntil(cache.put(ck, out.clone()));
  return out;
}

/* ── 2. identity ─────────────────────────────────────────────────────── */

const verdictCache = new LruCache<VerifyResult>({ max: 4096, ttlMs: 5 * 60_000 });

async function admit(env: Env, provider: ProviderId, idToken: string): Promise<VerifyResult> {
  const aud = provider === "google" ? env.GOOGLE_CLIENT_ID : provider === "microsoft" ? env.MICROSOFT_CLIENT_ID : env.HUAWEI_CLIENT_ID;
  if (!aud) return { ok: false, reason: `no client id configured for ${provider}`, failedCheck: "aud" };
  const key = `${provider}:${idToken.length}:${idToken.slice(-32)}`;
  const hot = verdictCache.peek(key);
  if (hot) return hot;
  const v = await verifyJwt(idToken, {
    provider,
    audience: aud,
    issuer: provider === "google" ? ["accounts.google.com", "https://accounts.google.com"]
      : provider === "microsoft" ? "https://login.microsoftonline.com/common/v2.0"
      : "https://accounts.huawei.com",
    jwksUri: provider === "google" ? "https://www.googleapis.com/oauth2/v3/certs"
      : provider === "microsoft" ? "https://login.microsoftonline.com/common/discovery/v2.0/keys"
      : "https://oauth-login.cloud.huawei.com/oauth2/v3/certs",
  });
  verdictCache.set(key, v, 5 * 60_000);
  return v;
}

/* ── 3. x402 ─────────────────────────────────────────────────────────── */

/**
 * Real x402 semantics: unpaid → 402 with `accepts`; paid → verify with the
 * facilitator, then serve. There is no "assume paid" branch, deliberately.
 */
async function gate(req: Request, env: Env, resource: string, produce: () => Promise<Response>): Promise<Response> {
  const payTo = env.X402_PAY_TO;
  const price = env.X402_PRICE_USD ?? "5";
  if (!payTo) {
    return json({ error: "premium_closed", detail: "X402_PAY_TO is not configured; premium data is unavailable", resource }, { status: 503 });
  }

  const proof = req.headers.get("x-payment");
  if (!proof) {
    return json({
      x402Version: 1,
      error: "payment_required",
      accepts: [{
        scheme: "exact",
        network: "base",
        maxAmountRequired: price,
        asset: "USDC",
        payTo,
        resource,
        description: `GIS OSINT alpha feed — ${price} USDC per call`,
        mimeType: "application/json",
      }],
      docs: "https://github.com/alexdolbun/gis-osint-agentic-swarm#x402",
    }, { status: 402 });
  }

  const facilitator = env.X402_FACILITATOR;
  if (!facilitator) {
    return json({ error: "settlement_unverifiable", detail: "X402_FACILITATOR is not configured; refusing to release premium data on an unverified payment" }, { status: 402 });
  }
  const vr = await fetch(facilitator, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ proof, resource, payTo, price, asset: "USDC", network: "base" }),
  });
  if (!vr.ok) return json({ error: "payment_invalid", detail: `facilitator rejected (${vr.status})` }, { status: 402 });
  const verdict = (await vr.json().catch(() => ({}))) as { valid?: boolean };
  if (!verdict.valid) return json({ error: "payment_invalid", detail: "facilitator did not confirm settlement" }, { status: 402 });

  const res = await produce();
  const out = new Response(res.body, res);
  out.headers.set("x-402-settled", "true");
  out.headers.set("x-402-resource", resource);
  return out;
}

/* ── router ──────────────────────────────────────────────────────────── */

export default {
  async fetch(request: Request, env: Env, ctx: Ctx): Promise<Response> {
    const url = new URL(request.url);
    const p = url.pathname;

    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });

    /* 1. map origin — the ONLY upstream this worker proxies */
    if (p.startsWith("/tiles/")) {
      const upstream = `${env.OFM_ORIGIN ?? OFM}${p.slice("/tiles".length)}${url.search}`;
      return edgeFirst(request, ctx, upstream, TTL.tiles, true, async () => {
        const r = await fetch(upstream, { headers: { accept: request.headers.get("accept") ?? "*/*" }, cf: { cacheEverything: true, cacheTtl: TTL.tiles } } as RequestInit);
        return new Response(r.body, { status: r.status, headers: { "content-type": r.headers.get("content-type") ?? "application/x-protobuf" } });
      });
    }
    if (p.startsWith("/styles/") || p.startsWith("/sprites/") || p.startsWith("/fonts/")) {
      const upstream = `${env.OFM_ORIGIN ?? OFM}${p}${url.search}`;
      return edgeFirst(request, ctx, upstream, TTL.styles, false, async () => {
        const r = await fetch(upstream, { cf: { cacheEverything: true, cacheTtl: TTL.styles } } as RequestInit);
        return new Response(r.body, { status: r.status, headers: { "content-type": r.headers.get("content-type") ?? "application/octet-stream" } });
      });
    }

    /* 2. identity */
    if (p.startsWith("/auth/") && request.method === "POST") {
      const provider = p.slice("/auth/".length) as ProviderId;
      if (provider !== "google" && provider !== "microsoft" && provider !== "huawei") {
        return json({ error: "unknown_provider" }, { status: 404 });
      }
      const body = (await request.json().catch(() => ({}))) as { credential?: string; idToken?: string };
      const token = body.credential ?? body.idToken;
      if (!token) return json({ error: "no_token" }, { status: 400 });
      const v = await admit(env, provider, token);
      if (!v.ok) return json({ error: "unauthorized", reason: v.reason, failedCheck: v.failedCheck }, { status: 401 });
      return json({ ok: true, identity: v.identity }, { ttl: 0 });
    }

    /* 4. mirrored reports (public) */
    if (p === "/v1/swarm/status") {
      const raw = (await env.GIS_KV?.get("swarm:report")) ?? null;
      return json(raw ? JSON.parse(raw) : { status: "no report mirrored yet" }, { ttl: TTL.status });
    }
    if (p === "/v1/cities") {
      const raw = (await env.GIS_KV?.get("spine:cities")) ?? null;
      return json(raw ? JSON.parse(raw) : { cities: [] }, { ttl: TTL.spine });
    }

    /* 3. premium — the x402 gate */
    if (p === "/v1/alpha/feed" || p === "/v1/gis/bulk") {
      return gate(request, env, p, async () => {
        const key = p === "/v1/alpha/feed" ? "alpha:feed" : `gis:bulk:${url.searchParams.get("cell") ?? "all"}`;
        const cached = await env.GIS_KV?.get(key);
        if (cached) return new Response(cached, { headers: { "content-type": "application/json; charset=utf-8" } });
        const stale = await env.GIS_KV?.get(`${key}:last`);
        return json({ error: "no_data", detail: "no snapshot mirrored for this key yet", key, last: stale ? JSON.parse(stale) : null }, { status: 404 });
      });
    }

    return json({ ok: true, service: "gis-osint-agentic-swarm-edge", routes: ["/tiles/*", "/styles/*", "/auth/:provider", "/v1/swarm/status", "/v1/cities", "/v1/alpha/feed", "/v1/gis/bulk"] }, { ttl: TTL.status });
  },
};
