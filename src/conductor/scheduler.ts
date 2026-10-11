/**
 * scheduler.ts — concurrency, rate limiting and retry primitives.
 *
 * These are the pieces that keep a swarm of millions of nodes from becoming a
 * thundering herd: a fair semaphore per agent, a token bucket per upstream host
 * (so we never get banned for a burst), and jittered exponential retry. All
 * primitives are dependency-free and deterministic under a injected clock,
 * which is what lets QAA assert their behaviour instead of hoping.
 */

export interface Clock { now(): number }

export class Semaphore {
  private free: number;
  private queue: Array<() => void> = [];
  constructor(permits: number) {
    if (permits < 1) throw new Error("semaphore needs >= 1 permit");
    this.free = permits;
  }
  get available() { return this.free; }
  get waiting() { return this.queue.length; }

  acquire(): Promise<() => void> {
    return new Promise((resolve) => {
      const grant = () => {
        let released = false;
        resolve(() => { if (released) return; released = true; this.release(); });
      };
      if (this.free > 0) { this.free--; grant(); } else this.queue.push(grant);
    });
  }
  private release() {
    const next = this.queue.shift();
    if (next) next(); else this.free++;
  }
  async run<T>(fn: () => Promise<T>): Promise<T> {
    const release = await this.acquire();
    try { return await fn(); } finally { release(); }
  }
}

/** Classic token bucket. ratePerMin tokens/minute, burst capacity. */
export class TokenBucket {
  private tokens: number;
  private last: number;
  constructor(public ratePerMin: number, public burst = Math.max(1, Math.ceil(ratePerMin / 4)), private clock: Clock = { now: () => Date.now() }) {
    this.tokens = burst;
    this.last = this.clock.now();
  }
  private refill() {
    const t = this.clock.now();
    const dt = t - this.last;
    if (dt <= 0) return;
    this.tokens = Math.min(this.burst, this.tokens + (dt / 60_000) * this.ratePerMin);
    this.last = t;
  }
  tryTake(n = 1): boolean {
    this.refill();
    if (this.tokens >= n) { this.tokens -= n; return true; }
    return false;
  }
  /** ms until n tokens are available */
  waitMs(n = 1): number {
    this.refill();
    if (this.tokens >= n) return 0;
    return Math.ceil(((n - this.tokens) / this.ratePerMin) * 60_000);
  }
  /** current token count (after refill) */
  available(): number { this.refill(); return Number(this.tokens.toFixed(2)); }
  async take(n = 1, sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))): Promise<void> {
    while (!this.tryTake(n)) await sleep(Math.min(1000, Math.max(1, this.waitMs(n))));
  }
}

export class RateLimiter {
  private buckets = new Map<string, TokenBucket>();
  constructor(private defaults: { ratePerMin: number; burst?: number } = { ratePerMin: 60 }, private clock: Clock = { now: () => Date.now() }) {}
  bucket(host: string): TokenBucket {
    let b = this.buckets.get(host);
    if (!b) { b = new TokenBucket(this.defaults.ratePerMin, this.defaults.burst, this.clock); this.buckets.set(host, b); }
    return b;
  }
  snapshot() { return [...this.buckets.entries()].map(([host, b]) => ({ host, tokens: b.available(), ratePerMin: b.ratePerMin })); }
}

export interface RetryOptions {
  attempts?: number;
  baseMs?: number;
  maxMs?: number;
  jitter?: number;
  isRetryable?: (e: unknown) => boolean;
  sleep?: (ms: number) => Promise<void>;
  rand?: () => number;
}

export async function retry<T>(fn: (attempt: number) => Promise<T>, opts: RetryOptions = {}): Promise<T> {
  const attempts = opts.attempts ?? 4;
  const baseMs = opts.baseMs ?? 200;
  const maxMs = opts.maxMs ?? 5_000;
  const jitter = opts.jitter ?? 0.3;
  const rand = opts.rand ?? Math.random;
  const sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  const retryable = opts.isRetryable ?? (() => true);
  let lastErr: unknown;
  for (let a = 1; a <= attempts; a++) {
    try { return await fn(a); }
    catch (e) {
      lastErr = e;
      if (a === attempts || !retryable(e)) break;
      const backoff = Math.min(maxMs, baseMs * 2 ** (a - 1));
      await sleep(backoff * (1 + (rand() - 0.5) * jitter));
    }
  }
  throw lastErr;
}

/** Bounded-concurrency map that preserves input order. */
export async function pMap<A, B>(items: A[], fn: (item: A, index: number) => Promise<B>, concurrency = 8): Promise<B[]> {
  const out = new Array<B>(items.length);
  let i = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(concurrency, items.length || 1)) }, async () => {
    while (true) {
      const idx = i++;
      if (idx >= items.length) return;
      out[idx] = await fn(items[idx], idx);
    }
  });
  await Promise.all(workers);
  return out;
}
