/**
 * lru.ts — one cache primitive for the whole swarm.
 *
 * Design goals (high-load, millions of nodes):
 *   - O(1) get/set via Map insertion-order LRU (no linked-list bookkeeping).
 *   - Single-flight: N concurrent misses for the same key trigger ONE upstream
 *     call. This is the difference between 1 request and 500 during a cache
 *     stampede — the single most important cache property for a swarm.
 *   - TTL + stale-while-revalidate so hot keys never block on a refresh.
 *   - Hard memory cap via max entries; never grows unbounded.
 *   - Deterministic stats (hits/misses/evictions/coalesced) for QAA gates.
 */
export interface LruOptions { max?: number; ttlMs?: number; swrMs?: number }

interface Entry<V> { v: V; exp: number; stale: number }

export interface CacheStats {
  hits: number; misses: number; evictions: number; coalesced: number; refreshes: number; size: number; name: string;
}

export class LruCache<V> {
  readonly name: string;
  private map = new Map<string, Entry<V>>();
  private inflight = new Map<string, Promise<V>>();
  private max: number;
  private ttlMs: number;
  private swrMs: number;
  private s = { hits: 0, misses: 0, evictions: 0, coalesced: 0, refreshes: 0 };

  constructor(opts: LruOptions = {}) {
    this.name = "lru";
    this.max = opts.max ?? 1000;
    this.ttlMs = opts.ttlMs === 0 ? Number.POSITIVE_INFINITY : opts.ttlMs ?? 60_000;
    this.swrMs = opts.swrMs ?? 0;
  }

  get size() { return this.map.size; }

  /** Alias of peek() — read without creating an entry. */
  get(key: string): V | undefined { return this.peek(key); }

  has(key: string): boolean { return this.peek(key) !== undefined; }

  /** Sync read; returns undefined when absent or fully expired. */
  peek(key: string): V | undefined {
    const e = this.map.get(key);
    if (!e) { this.s.misses++; return undefined; }
    const now = Date.now();
    if (e.exp > now || (this.swrMs > 0 && e.stale > now)) {
      // touch for LRU recency
      this.map.delete(key); this.map.set(key, e);
      this.s.hits++;
      return e.v;
    }
    this.map.delete(key);
    this.s.misses++;
    return undefined;
  }

  set(key: string, value: V, ttlMs = this.ttlMs, swrMs = this.swrMs): void {
    const now = Date.now();
    if (this.map.has(key)) this.map.delete(key);
    this.map.set(key, { v: value, exp: now + ttlMs, stale: now + ttlMs + swrMs });
    while (this.map.size > this.max) {
      const oldest = this.map.keys().next().value as string;
      this.map.delete(oldest);
      this.s.evictions++;
    }
  }

  /**
   * Single-flight loader. Concurrent callers for the same key await ONE
   * upstream invocation. `ttlMs` overrides the default for this entry.
   */
  async fetch(key: string, loader: () => Promise<V> | V, ttlMs = this.ttlMs): Promise<V> {
    const hit = this.peek(key);
    if (hit !== undefined) return hit;
    const pending = this.inflight.get(key);
    if (pending) { this.s.coalesced++; return pending; }
    const p = (async () => {
      try {
        const v = await loader();
        this.set(key, v, ttlMs);
        return v;
      } finally {
        this.inflight.delete(key);
      }
    })();
    this.inflight.set(key, p);
    return p;
  }

  /** Stale-while-revalidate fetch: serve stale immediately, refresh in background. */
  async swr(key: string, loader: () => Promise<V>, ttlMs = this.ttlMs, swrMs = this.swrMs): Promise<V> {
    const e = this.map.get(key);
    const now = Date.now();
    if (e && e.exp > now) { this.s.hits++; return e.v; }
    if (e && e.stale > now) {
      this.s.hits++;
      this.s.refreshes++;
      void Promise.resolve(loader()).then((v) => this.set(key, v, ttlMs, swrMs)).catch(() => {});
      return e.v;
    }
    return this.fetch(key, loader, ttlMs);
  }

  delete(key: string): boolean { return this.map.delete(key); }
  clear(): void { this.map.clear(); this.inflight.clear(); }

  stats(): CacheStats & { hitRate: number } {
    return {
      ...this.s,
      size: this.map.size,
      name: this.name,
      hitRate: this.hitRate(),
    };
  }

  hitRate(): number {
    const total = this.s.hits + this.s.misses;
    return total === 0 ? 0 : this.s.hits / total;
  }

  reset(): void { this.s = { hits: 0, misses: 0, evictions: 0, coalesced: 0, refreshes: 0 }; }
}
