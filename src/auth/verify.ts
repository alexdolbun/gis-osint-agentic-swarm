/**
 * verify.ts — dependency-free OIDC/JWT ID-token verifier (RS256/ES256/PS256).
 * Uses WebCrypto only, so the SAME code runs in Bun, Node, and Cloudflare
 * Workers. JWKS is fetched through a shared LRU with single-flight + long TTL,
 * which is the single cheapest way to keep auth latency low in a swarm
 * (millions of verifications against ~1 key fetch per rotation).
 */
import { LruCache } from "../cache/lru.ts";
import { fnv1a64 } from "../cache/keyhash.ts";
import { register } from "../cache/stats.ts";
import type { JwkSet, VerifyOptions, VerifyResult, Identity } from "./types.ts";
import type { ProviderId } from "./types.ts";

const jwksCache = register("jwks", new LruCache<JwkSet>({ max: 32, ttlMs: 3600_000 }));
const algCache = new Map<string, CryptoKey>();

function b64urlToBytes(s: string): Uint8Array {
  s = s.replace(/-/g, "+").replace(/_/g, "/");
  while (s.length % 4) s += "=";
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
function dec(s: string): unknown {
  return JSON.parse(new TextDecoder().decode(b64urlToBytes(s)));
}

const ALG_MAP: Record<string, { name: string; hash: string }> = {
  RS256: { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
  RS384: { name: "RSASSA-PKCS1-v1_5", hash: "SHA-384" },
  RS512: { name: "RSASSA-PKCS1-v1_5", hash: "SHA-512" },
  PS256: { name: "RSA-PSS", hash: "SHA-256" },
  ES256: { name: "ECDSA", hash: "SHA-256" },
  ES384: { name: "ECDSA", hash: "SHA-384" },
};

async function importKey(jwk: JsonWebKey & { kid?: string; n?: string; x?: string }, alg: string): Promise<CryptoKey> {
  const m = ALG_MAP[alg];
  if (!m) throw new Error(`unsupported alg ${alg}`);
  // Key on key MATERIAL, not just kid: two tenants can share a kid across JWKS
  const material = jwk.n ?? jwk.x ?? "";
  const cacheKey = `${alg}:${jwk.kid ?? ""}:${fnv1a64(material)}`;
  const hit = algCache.get(cacheKey);
  if (hit) return hit;
  const key = await crypto.subtle.importKey(
    "jwk",
    jwk,
    { name: m.name, hash: m.hash } as RsaHashedImportParams & EcKeyImportParams,
    false,
    ["verify"],
  );
  algCache.set(cacheKey, key);
  return key;
}

export async function verifyJwt(
  token: string,
  opts: VerifyOptions & { provider: ProviderId; jwksUri: string; fetchImpl?: typeof fetch },
): Promise<VerifyResult> {
  const now = opts.now ? opts.now() : Date.now();
  const skew = (opts.skewSec ?? 120) * 1000;
  const parts = token.split(".");
  if (parts.length !== 3) return { ok: false, reason: "malformed JWT", failedCheck: "malformed" };
  let header: any, payload: any;
  try { header = dec(parts[0]); payload = dec(parts[1]); }
  catch { return { ok: false, reason: "undecodable JWT", failedCheck: "malformed" }; }

  // 1) issuer
  const issuers = Array.isArray(opts.issuer) ? opts.issuer : [opts.issuer];
  if (!issuers.includes(payload.iss)) return { ok: false, reason: `bad iss ${payload.iss}`, failedCheck: "iss" };

  // 2) audience
  const aud = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
  if (!aud.includes(opts.audience)) return { ok: false, reason: `bad aud`, failedCheck: "aud" };

  // 3) time
  if (typeof payload.exp === "number" && payload.exp * 1000 + skew < now) return { ok: false, reason: "expired", failedCheck: "exp" };
  if (typeof payload.nbf === "number" && payload.nbf * 1000 - skew > now) return { ok: false, reason: "not yet valid", failedCheck: "nbf" };

  // 4) signature via JWKS (with single-flight caching)
  const fetcher = opts.fetchImpl ?? fetch;
  let jwks = opts.jwks ?? jwksCache.peek(opts.jwksUri);
  if (!jwks) {
    try {
      jwks = await jwksCache.fetch(opts.jwksUri, async () => {
        const r = await fetcher(opts.jwksUri);
        if (!r.ok) throw new Error(`jwks ${r.status}`);
        return (await r.json()) as JwkSet;
      }, 3600_000);
    } catch (e) {
      return { ok: false, reason: `jwks fetch failed: ${(e as Error).message}`, failedCheck: "signature" };
    }
  }
  const jwk = (jwks.keys as any[]).find((k) => k.kid === header.kid && (!k.alg || k.alg === header.alg)) ?? (jwks.keys as any[])[0];
  if (!jwk) return { ok: false, reason: "no matching JWK", failedCheck: "signature" };
  try {
    const key = await importKey(jwk, header.alg);
    const data = new TextEncoder().encode(`${parts[0]}.${parts[1]}`);
    const sig = b64urlToBytes(parts[2]);
    const m = ALG_MAP[header.alg];
    const verifyAlg = header.alg.startsWith("ES")
      ? { name: m.name, hash: m.hash }
      : header.alg.startsWith("PS")
        ? { name: m.name, saltLength: 32 }
        : { name: m.name };
    const ok = await crypto.subtle.verify(verifyAlg as AlgorithmIdentifier, key, sig as unknown as BufferSource, data);
    if (!ok) return { ok: false, reason: "signature mismatch", failedCheck: "signature" };
  } catch (e) {
    return { ok: false, reason: `verify error: ${(e as Error).message}`, failedCheck: "signature" };
  }

  // 5) domain restriction (the reliable tenant gate)
  if (opts.domainClaim) {
    const v = String(payload[opts.domainClaim.claim] ?? "");
    if (opts.domainClaim.equals !== undefined) {
      if (v.toLowerCase() !== opts.domainClaim.equals.toLowerCase()) {
        return { ok: false, reason: `domain ${v} != ${opts.domainClaim.equals}`, failedCheck: "domain" };
      }
    } else if (opts.domainClaim.allowWorkspaceAny && v === "") {
      return { ok: false, reason: "missing hosted-domain claim", failedCheck: "domain" };
    }
  }

  const identity: Identity = {
    provider: opts.provider,
    sub: payload.sub,
    email: payload.email,
    emailVerified: payload.email_verified,
    name: payload.name,
    picture: payload.picture,
    domain: String(payload.hd ?? payload.tid ?? payload.domain ?? payload.tenant ?? "") || undefined,
    locale: payload.locale,
    issuedAt: payload.iat,
    expiresAt: payload.exp,
    claims: payload,
  };
  return { ok: true, identity };
}

export function _jwksCache(): LruCache<JwkSet> { return jwksCache; }
export function _clearKeyCache(): void { algCache.clear(); }
