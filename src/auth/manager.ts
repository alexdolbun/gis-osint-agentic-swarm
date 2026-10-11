/**
 * manager.ts — Auth Swarm conductor side.
 *
 * Holds a pool of per-identity token records, verifies ID tokens through the
 * provider, dedupes concurrent verifications (single-flight), and refreshes
 * tokens AHEAD of expiry via a jittered scheduler so a swarm of N agents never
 * all refresh at the same instant (thundering herd is what kills auth at high
 * load). This is where the "80%+ auth-overhead reduction" claim is realised.
 */
import { LruCache } from "../cache/lru.ts";
import { register } from "../cache/stats.ts";
import { google } from "./google.ts";
import { microsoft } from "./microsoft.ts";
import { huawei } from "./huawei.ts";
import type { Identity, Provider, ProviderId, TokenRecord, VerifyOptions, VerifyResult } from "./types.ts";

export const PROVIDERS: Record<ProviderId, Provider> = { google, microsoft, huawei };

export interface ManagerOptions {
  verify: VerifyOptions;
  /** Refresh when this many ms remain before expiry (default 5 min). */
  refreshWindowMs?: number;
  /** Max jitter applied to refresh timers (default 90 s). */
  jitterMs?: number;
  onRefresh?: (rec: TokenRecord) => Promise<Partial<TokenRecord> | void>;
}

export class AuthSwarm {
  private tokens = new Map<string, TokenRecord>();
  private verifyCache = register("token", new LruCache<VerifyResult>({ max: 5000, ttlMs: 5 * 60_000 }));
  private timers = new Map<string, ReturnType<typeof setTimeout>>();
  private opts: ManagerOptions;

  constructor(opts: ManagerOptions) { this.opts = opts; }

  /** Verify an ID token, deduped + cached by token hash. */
  async admit(providerId: ProviderId, idToken: string): Promise<VerifyResult> {
    const key = `${providerId}:${shortHash(idToken)}`;
    const cached = this.verifyCache.peek(key);
    if (cached) return cached;
    const result = await this.verifyCache.fetch(key, () => PROVIDERS[providerId].verify(idToken, this.opts.verify), 5 * 60_000);
    if (result.ok && result.identity) this.remember(result.identity, { expiresAt: (result.identity.expiresAt ?? 0) * 1000 });
    return result;
  }

  remember(identity: Identity, extra: Partial<TokenRecord> = {}): TokenRecord {
    const key = `${identity.provider}:${identity.sub}`;
    const rec: TokenRecord = {
      identity,
      expiresAt: extra.expiresAt ?? Date.now() + 3600_000,
      ...this.tokens.get(key),
      ...extra,
    };
    this.tokens.set(key, rec);
    this.scheduleRefresh(key);
    return rec;
  }

  get(providerId: ProviderId, sub: string): TokenRecord | undefined {
    const rec = this.tokens.get(`${providerId}:${sub}`);
    if (!rec) return undefined;
    if (rec.expiresAt < Date.now()) return undefined; // caller must re-admit
    return rec;
  }

  /** Pool snapshot for the conductor's cache dashboard. */
  pool(): { identities: number; providers: Record<string, number>; nextExpiryMs: number | null } {
    const now = Date.now();
    const byProvider: Record<string, number> = {};
    let next: number | null = null;
    for (const r of this.tokens.values()) {
      byProvider[r.identity.provider] = (byProvider[r.identity.provider] ?? 0) + 1;
      if (r.expiresAt > now && (next === null || r.expiresAt < next)) next = r.expiresAt;
    }
    return { identities: this.tokens.size, providers: byProvider, nextExpiryMs: next };
  }

  private scheduleRefresh(key: string) {
    const rec = this.tokens.get(key);
    if (!rec || !this.opts.onRefresh) return;
    const old = this.timers.get(key);
    if (old) clearTimeout(old);
    const window = this.opts.refreshWindowMs ?? 5 * 60_000;
    const jitter = Math.random() * (this.opts.jitterMs ?? 90_000);
    const delay = Math.max(0, rec.expiresAt - Date.now() - window + jitter);
    const t = setTimeout(async () => {
      try {
        const patch = await this.opts.onRefresh!(rec);
        if (patch) this.remember(rec.identity, patch);
      } catch { /* keep the old record; next admit() will re-verify */ }
    }, delay);
    if (typeof (t as any).unref === "function") (t as any).unref();
    this.timers.set(key, t);
  }

  dispose() { for (const t of this.timers.values()) clearTimeout(t); this.timers.clear(); }
}

function shortHash(s: string): string {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return (h >>> 0).toString(16);
}
