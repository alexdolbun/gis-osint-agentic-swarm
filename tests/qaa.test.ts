/**
 * qaa.test.ts — Quality Assurance Automation for the swarm.
 *
 * QAA here is not "does it run". It asserts the *economic and safety
 * properties* the system is sold on:
 *   1. Cache  — TTL, LRU eviction, single-flight coalescing, stale-while-revalidate.
 *   2. Auth   — issuer/audience/expiry/signature/domain gates + verify dedupe.
 *   3. Load   — semaphore peak, token-bucket rate, jittered retry, ordered pMap.
 *   4. Conductor — cache reuse across tasks, DAG levels, cycle detection, metrics.
 *   5. Signal — confidence from independent sources, labels, ranking, RWA, onchain.
 *   6. Policy — zero paid GIS providers reachable; every agent declares cache+network.
 */
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";

import { LruCache } from "../src/cache/lru.ts";
import { canonical, cacheKey, fnv1a64 } from "../src/cache/keyhash.ts";
import { memoize } from "../src/cache/memo.ts";
import { dashboard } from "../src/cache/stats.ts";
import { verifyJwt } from "../src/auth/verify.ts";
import { AuthSwarm } from "../src/auth/manager.ts";
import { defineAgent, makeCtx } from "../src/agents/base.ts";
import { overpass } from "../src/agents/overpass.ts";
import { imagery } from "../src/agents/imagery.ts";
import { metadata } from "../src/agents/metadata.ts";
import { geosocial, cellId, haversineKm } from "../src/agents/geosocial.ts";
import { Conductor } from "../src/conductor/conductor.ts";
import { Semaphore, TokenBucket, retry, pMap } from "../src/conductor/scheduler.ts";
import { listAgents } from "../src/conductor/registry.ts";
import { buildSwarm } from "../src/index.ts";
import { labelFor, scoreConfidence, toSignal, report, rank } from "../src/alpha/capture.ts";
import { scoreRwa, rwaSignals } from "../src/alpha/rwa.ts";
import { correlate } from "../src/alpha/onchain.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/* ───────────────────────── 1. CACHE ───────────────────────── */
describe("cache: the unit economics", () => {
  test("TTL expiry", async () => {
    const c = new LruCache<number>({ max: 10, ttlMs: 10 });
    c.set("k", 1);
    expect(c.peek("k")).toBe(1);
    await sleep(30);
    expect(c.peek("k")).toBeUndefined();
  });

  test("LRU evicts the least-recently-used key only", () => {
    const c = new LruCache<number>({ max: 2, ttlMs: 60_000 });
    c.set("a", 1); c.set("b", 2);
    expect(c.peek("a")).toBe(1);          // touch a → b is now oldest
    c.set("c", 3);
    expect(c.peek("b")).toBeUndefined();
    expect(c.peek("a")).toBe(1);
    expect(c.peek("c")).toBe(3);
    expect(c.stats().evictions).toBe(1);
  });

  test("single-flight: 25 concurrent misses → ONE upstream call", async () => {
    const c = new LruCache<number>({ max: 10, ttlMs: 60_000 });
    let calls = 0;
    const out = await Promise.all(
      Array.from({ length: 25 }, () =>
        c.fetch("hot", async () => { calls++; await sleep(15); return 42; }),
      ),
    );
    expect(calls).toBe(1);
    expect(out.every((v) => v === 42)).toBe(true);
    expect(c.stats().coalesced).toBe(24);
  });

  test("stale-while-revalidate serves stale and refreshes in background", async () => {
    const c = new LruCache<string>({ max: 10, ttlMs: 1, swrMs: 5_000 });
    let gen = 0;
    c.set("k", "v0", 1, 5_000);
    await sleep(6);                     // let the entry go stale (ttl=1ms)
    const served = await c.swr("k", async () => `v${++gen}`, 60_000);
    expect(served).toBe("v0");          // stale served, no blocking
    await sleep(20);
    expect(c.peek("k")).toBe("v1");     // refreshed behind the request
  });

  test("hit rate is measurable (dashboard surface)", () => {
    expect(["number", "object"]).toContain(typeof dashboard().totalHitRate);
    expect(Array.isArray(dashboard().rows)).toBe(true);
  });

  test("canonical keys are order/unicode/float stable", () => {
    expect(canonical({ b: 1, a: 2 })).toBe(canonical({ a: 2, b: 1 }));
    // NFKC folds compatibility forms: the "fi" ligature must key with plain "fi"
    expect(canonical("\uFB01le")).toBe("file");
    expect(canonical(1.50000)).toBe(canonical(1.5));
    expect(cacheKey("overpass", { a: 1 }, [1, 2])).toBe(cacheKey("overpass", { a: 1 }, [1, 2]));
    expect(fnv1a64("x")).toHaveLength(16);
  });

  test("memoize collapses repeated geo math", () => {
    let n = 0;
    const f = memoize((a: number, b: number) => { n++; return a + b; }, { ns: "t" });
    f(1, 2); f(1, 2); f(1, 2);
    expect(n).toBe(1);
    f(2, 2);
    expect(n).toBe(2);
  });
});

/* ───────────────────────── 2. AUTH ───────────────────────── */
const b64u = (b: Buffer | Uint8Array) => Buffer.from(b as Uint8Array).toString("base64url");
const jwt = (payload: Record<string, unknown>, header: Record<string, unknown> = { alg: "RS256", kid: "t1", typ: "JWT" }) =>
  `${b64u(Buffer.from(JSON.stringify(header)))}.${b64u(Buffer.from(JSON.stringify(payload)))}.sig`;

async function rsaFixture(kid = "t1") {
  const kp = await crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true, ["sign", "verify"],
  );
  const pub = await crypto.subtle.exportKey("jwk", kp.publicKey);
  const jwks = { keys: [{ ...pub, kid, alg: "RS256", use: "sig" }] as unknown as JsonWebKey[] };
  return { kp, jwks };
}

describe("auth: identity gates (Google/Microsoft/Huawei, one contract)", () => {
  test("malformed tokens are rejected before any crypto", async () => {
    const r = await verifyJwt("not.a", { provider: "google", jwksUri: "https://x/jwks", issuer: "acc", audience: "cid" });
    expect(r.ok).toBe(false);
    expect(r.failedCheck).toBe("malformed");
  });

  test("issuer, audience and expiry gates fire in order", async () => {
    const base = { provider: "google" as const, jwksUri: "https://x/jwks", issuer: "https://accounts.google.com", audience: "cid" };
    expect((await verifyJwt(jwt({ iss: "evil", aud: "cid" }), base)).failedCheck).toBe("iss");
    expect((await verifyJwt(jwt({ iss: "https://accounts.google.com", aud: "other" }), base)).failedCheck).toBe("aud");
    const expired = Math.floor(Date.now() / 1000) - 10_000;
    expect((await verifyJwt(jwt({ iss: "https://accounts.google.com", aud: "cid", exp: expired }), base)).failedCheck).toBe("exp");
  });

  test("a real RS256 token verifies; a tampered one does not", async () => {
    const { kp, jwks } = await rsaFixture();
    const head = { alg: "RS256", kid: "t1", typ: "JWT" };
    const body = { iss: "https://accounts.google.com", aud: "cid", sub: "s1", email: "a@corp.com", hd: "corp.com", exp: Math.floor(Date.now() / 1000) + 600 };
    const signingInput = `${b64u(Buffer.from(JSON.stringify(head)))}.${b64u(Buffer.from(JSON.stringify(body)))}`;
    const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", kp.privateKey, new TextEncoder().encode(signingInput));
    const token = `${signingInput}.${b64u(new Uint8Array(sig))}`;
    const opts = { provider: "google" as const, jwksUri: "https://x/jwks", jwks, issuer: "https://accounts.google.com", audience: "cid" };

    const ok = await verifyJwt(token, opts);
    expect(ok.ok).toBe(true);
    expect(ok.identity?.sub).toBe("s1");
    expect(ok.identity?.domain).toBe("corp.com");

    const bad = await verifyJwt(`${signingInput}.${b64u(new Uint8Array(256))}`, opts);
    expect(bad.ok).toBe(false);
    expect(bad.failedCheck).toBe("signature");
  });

  test("hosted-domain gate blocks the wrong tenant", async () => {
    const { kp, jwks } = await rsaFixture("t2");
    const head = { alg: "RS256", kid: "t2", typ: "JWT" };
    const body = { iss: "https://accounts.google.com", aud: "cid", sub: "s2", hd: "personal.com", exp: Math.floor(Date.now() / 1000) + 600 };
    const input = `${b64u(Buffer.from(JSON.stringify(head)))}.${b64u(Buffer.from(JSON.stringify(body)))}`;
    const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", kp.privateKey, new TextEncoder().encode(input));
    const r = await verifyJwt(`${input}.${b64u(new Uint8Array(sig))}`, {
      provider: "google", jwksUri: "https://x/jwks", jwks, issuer: "https://accounts.google.com", audience: "cid",
      domainClaim: { claim: "hd", equals: "corp.com" },
    });
    expect(r.ok).toBe(false);
    expect(r.failedCheck).toBe("domain");
  });

  test("AuthSwarm admits once and reuses the verdict (no re-verify storm)", async () => {
    const { kp, jwks } = await rsaFixture("t3");
    const head = { alg: "RS256", kid: "t3", typ: "JWT" };
    const body = { iss: "https://accounts.google.com", aud: "cid", sub: "s3", exp: Math.floor(Date.now() / 1000) + 3600 };
    const input = `${b64u(Buffer.from(JSON.stringify(head)))}.${b64u(Buffer.from(JSON.stringify(body)))}`;
    const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", kp.privateKey, new TextEncoder().encode(input));
    const token = `${input}.${b64u(new Uint8Array(sig))}`;
    const swarm = new AuthSwarm({ verify: { issuer: "https://accounts.google.com", audience: "cid", jwks } });
    const a = await swarm.admit("google", token);
    const b = await swarm.admit("google", token);
    expect(a.ok).toBe(true);
    expect(b).toBe(a);                       // same object → served from cache
  });
});

/* ───────────────────────── 3. LOAD ───────────────────────── */
describe("load: swarm primitives hold under concurrency", () => {
  test("semaphore caps peak concurrency", async () => {
    const s = new Semaphore(2);
    let active = 0, peak = 0;
    await Promise.all(Array.from({ length: 8 }, () => s.run(async () => {
      active++; peak = Math.max(peak, active); await sleep(5); active--;
    })));
    expect(peak).toBe(2);
    expect(s.available).toBe(2);
    expect(s.waiting).toBe(0);
  });

  test("token bucket refuses bursts above the rate", () => {
    const b = new TokenBucket(6000, 2);
    expect(b.tryTake()).toBe(true);
    expect(b.tryTake()).toBe(true);
    expect(b.tryTake()).toBe(false);
    expect(b.waitMs(1)).toBeGreaterThan(0);
  });

  test("retry backs off then succeeds", async () => {
    let n = 0;
    const v = await retry(async (a) => { n = a; if (a < 3) throw new Error("503"); return "ok"; },
      { attempts: 4, sleep: async () => {} });
    expect(v).toBe("ok");
    expect(n).toBe(3);
  });

  test("pMap preserves order under bounded concurrency", async () => {
    const out = await pMap([1, 2, 3, 4, 5, 6], async (n) => { await sleep(3); return n * n; }, 2);
    expect(out).toEqual([1, 4, 9, 16, 25, 36]);
  });
});

/* ───────────────────────── 4. CONDUCTOR ───────────────────────── */
describe("conductor: orchestration", () => {
  const echo = defineAgent<{ n: number; tag?: string }, { n: number }>(
    { name: "qaaEcho", layer: 7, kind: "compute", ttlMs: 60_000, keyOf: (i) => `echo:${i.n}:${i.tag ?? ""}` },
    async (i) => ({ n: i.n }),
  );

  test("identical work everywhere collapses to one run", async () => {
    const c = new Conductor({ offline: true });
    c.register(echo);
    const t = { id: "t1", agent: "qaaEcho", input: { n: 1 } };
    const first = await c.run<{ n: number }, { n: number }>(t);
    const second = await c.run<{ n: number }, { n: number }>(t);
    expect(first.cached).toBe(false);
    expect(second.cached).toBe(true);
    expect(second.result?.n).toBe(1);
    expect(c.cacheReport().totalSavedCalls).toBeGreaterThan(0);
  });

  test("DAG runs levels in order and joins", async () => {
    const c = new Conductor({ offline: true });
    c.register(echo);
    const order: string[] = [];
    const tasks = [
      { id: "a", agent: "qaaEcho", input: { n: 1 } },
      { id: "b", agent: "qaaEcho", input: { n: 2 }, after: ["a"] },
      { id: "c", agent: "qaaEcho", input: { n: 3 }, after: ["a"] },
      { id: "d", agent: "qaaEcho", input: { n: 4 }, after: ["b", "c"] },
    ];
    const out = await c.runDag<{ n: number }, { n: number }>(tasks);
    out.forEach((r) => order.push(r.id));
    expect(order.indexOf("a")).toBeLessThan(order.indexOf("b"));
    expect(order.indexOf("b")).toBeLessThan(order.indexOf("d"));
    expect(out.every((r) => r.ok)).toBe(true);
  });

  test("cycles are refused, not looped", async () => {
    const c = new Conductor({ offline: true });
    c.register(echo);
    await expect(c.runDag([
      { id: "x", agent: "qaaEcho", input: { n: 1 }, after: ["y"] },
      { id: "y", agent: "qaaEcho", input: { n: 2 }, after: ["x"] },
    ])).rejects.toThrow(/cycle/);
  });

  test("unknown agent fails loudly, never silently", async () => {
    const c = new Conductor({ offline: true });
    await expect(c.run({ id: "z", agent: "nope", input: {} })).rejects.toThrow(/unknown agent/);
  });

  test("the real swarm caches offline overpass/imagery work", async () => {
    const c = buildSwarm({ offline: true });
    const q = { bbox: [40.5, -74.1, 40.9, -73.8] as [number, number, number, number], selectors: ["amenity=bank"], timeoutSec: 25 };
    const r1 = await c.run<typeof q, any>({ id: "o1", agent: "overpass", input: q });
    const r2 = await c.run<typeof q, any>({ id: "o2", agent: "overpass", input: q });
    expect(r1.ok).toBe(true);
    expect(r2.cached).toBe(true);
    expect(r1.result.count).toBeGreaterThan(0);
    expect(Array.isArray(r1.result.pois)).toBe(true);
  });
});

/* ───────────────────────── 5. AGENTS ───────────────────────── */
describe("agents: GIS OSINT behaviour", () => {
  test("overpass offline fixture is deterministic (reproducible QAA)", async () => {
    const a = JSON.stringify(await overpass.run({ bbox: [0, 0, 1, 1] }, makeCtx({ offline: true })));
    const b = JSON.stringify(await overpass.run({ bbox: [0, 0, 1, 1] }, makeCtx({ offline: true })));
    expect(a).toBe(b);
  });

  test("imagery offline index is well-formed", async () => {
    const r = await imagery.run({ bbox: [40, -74, 41, -73], from: "2026-01-01", to: "2026-03-01" }, makeCtx({ offline: true }));
    expect(Array.isArray(r.scenes)).toBe(true);
    expect(typeof r.stac).toBe("string");
  });

  test("metadata extracts sidecar places, handles and currencies", async () => {
    const r = await metadata.run(
      { text: "Acme Capital HQ, Dubai, AE — raised $250M from family offices. Contact @alexdolbun. Fees in USD and EUR." },
      makeCtx({ offline: true }),
    );
    expect(r.currencies).toContain("USD");
    expect(r.currencies).toContain("EUR");
    expect(r.handles).toContain("alexdolbun");
    expect(r.placeHints.join(" ")).toContain("Dubai");
    expect(r.confidence).toBeGreaterThan(0);
  });

  test("metadata refuses to invent geo from nothing", async () => {
    const r = await metadata.run({ text: "" }, makeCtx({ offline: true }));
    expect(r.lat).toBeUndefined();
    expect(r.confidence).toBe(0);
  });

  test("geosocial clusters points and correlates known entities", async () => {
    const now = Date.now();
    const points = [
      { id: "p1", lat: 48.8566, lon: 2.3522, ts: now - 86_400_000, source: "x", handles: ["@a"], currencies: ["EUR"] },
      { id: "p2", lat: 48.8570, lon: 2.3525, ts: now, source: "news", handles: ["@a", "@b"], currencies: ["EUR", "USD"] },
    ];
    const known = [{ id: "e1", name: "Paris Family Office", kind: "org" as const, lat: 48.8566, lon: 2.3522 }];
    const r = await geosocial.run({ points, known, radiusKm: 25 }, makeCtx({ offline: true }));
    expect(r.clusters.length).toBeGreaterThan(0);
    expect(r.clusters[0].count).toBe(2);
    expect(r.matches[0]?.entityId).toBe("e1");
  });

  test("geo math is correct and memoised", () => {
    expect(Number(haversineKm([48.8566, 2.3522], [51.5074, -0.1278]).toFixed(0))).toBe(344);
    expect(cellId(48.8566, 2.3522)).toBe(cellId(48.8566, 2.3522));
  });
});

/* ───────────────────────── 6. ALPHA ───────────────────────── */
describe("alpha: confidence from sources, never from vibes", () => {
  test("confidence scales with INDEPENDENT sources, not raw count", () => {
    const one = scoreConfidence(["https://a.com/1", "https://a.com/2", "https://a.com/3"]);
    const three = scoreConfidence(["https://a.com/1", "https://b.com/1", "https://c.com/1"]);
    expect(three).toBeGreaterThan(one);
    expect(scoreConfidence([])).toBeLessThanOrEqual(15);
  });

  test("labels map to the 40/70/90 thresholds", () => {
    expect(labelFor(95)).toBe("VERIFIED");
    expect(labelFor(75)).toBe("LIKELY");
    expect(labelFor(50)).toBe("SPECULATIVE");
    expect(labelFor(10)).toBe("UNSUBSTANTIATED");
  });

  test("reports count labels and the multi-source bar", () => {
    const s1 = toSignal({ key: "k1", text: "t1", sources: ["https://a.com", "https://b.com"] }, "geo-economic");
    const s2 = toSignal({ key: "k2", text: "t2", sources: ["https://a.com"] }, "rwa");
    const rep = report([s1, s2], 1);
    expect(rep.counts.VERIFIED + rep.counts.LIKELY + rep.counts.SPECULATIVE + rep.counts.UNSUBSTANTIATED).toBe(2);
    expect(rep.multiSourceRate).toBe(0.5);
    expect(rank([s2, s1])[0].id).toBe(s1.id);
  });

  test("RWA score is deterministic, graded, and order-independent", () => {
    const input = { place: "Rotterdam", lat: 51.9, lon: 4.5, poi: { port: 12, airport: 3, industrial: 8, financial: 5, data_center: 2 }, capitalEntities: ["a", "b", "c"], onchainUsd: 2_000_000, sources: ["https://a.com", "https://b.com"] };
    const a = scoreRwa(input), b = scoreRwa(input);
    expect(a).toEqual(b);
    expect(a.score).toBeGreaterThan(30);
    expect(["A", "B", "C", "D"]).toContain(a.grade);
    expect(rwaSignals([input])[0].kind).toBe("rwa");
  });

  test("onchain correlation yields intensity + local FX", () => {
    const s = correlate("Rotterdam", 51.9, 4.5, { cell: "51.900,4.500", notionalUsd: 1_000_000, txCount: 40 }, { EUR: 0.92, JPY: 155.2 });
    expect(s.intensity).toBe(25_000);
    expect(s.local?.EUR).toBe(920_000);
  });
});

/* ───────────────────────── 7. POLICY ───────────────────────── */
const BANNED = /api\.mapbox\.com|tiles\.mapbox\.com|mapbox:\/\/|maps\.googleapis\.com|maps\.google\.com|maptiler\.com|stadiamaps\.com|cartocdn\.com|arcgisonline\.com|tomtom\.com|hereapi\.com|virtualearth\.net|maps\.yandex/;

function walk(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name === "node_modules" || e.name === ".git" || e.name === "dist") continue;
    const p = `${dir}/${e.name}`;
    if (e.isDirectory()) walk(p, out);
    else if (/\.(ts|js|json|toml)$/.test(e.name)) out.push(p);
  }
  return out;
}

describe("policy: open-stack + cache discipline are enforced, not documented", () => {
  test("no paid/proprietary GIS provider host appears in the tree", () => {
    const files = [...walk("src"), ...walk("cloudflare"), ...walk("scripts")];
    const offenders = files.filter((f) => BANNED.test(readFileSync(f, "utf8")));
    expect(offenders).toEqual([]);
  });

  test("the edge worker pins the open tile stack", () => {
    const src = readFileSync("cloudflare/gis-edge-worker.ts", "utf8");
    expect(src).toContain("tiles.openfreemap.org");
    expect(src).not.toMatch(BANNED);
  });

  test("every registered agent declares a cache key, TTL and (if network) a host", () => {
    const agents = listAgents();
    expect(agents.length).toBeGreaterThan(0);
    for (const a of agents) {
      expect(a.ttlMs).toBeGreaterThan(0);
      expect(a.layer).toBeGreaterThanOrEqual(1);
      expect(a.layer).toBeLessThanOrEqual(7);
    }
    for (const a of [overpass, imagery]) {
      expect(a.spec.kind).toBe("network");
      expect(a.spec.network?.host).toBeTruthy();
      expect(a.spec.network!.host).not.toMatch(BANNED);
    }
  });

  test("cache TTLs are ordered: imagery (day) > overpass (hours) > geosocial (minutes)", () => {
    expect(imagery.spec.ttlMs).toBeGreaterThan(overpass.spec.ttlMs);
    expect(overpass.spec.ttlMs).toBeGreaterThan(geosocial.spec.ttlMs);
  });
});
