/**
 * stats.ts — global cache registry. Every cache registers itself so the
 * conductor can print ONE cache dashboard and QAA gates can assert hit rates.
 */
import type { LruCache } from "./lru.ts";

const registry = new Map<string, LruCache<any>>();
const meta = new Map<string, { kind?: string; note?: string }>();

export function register<T>(name: string, cache: LruCache<T>, m: { kind?: string; note?: string } = {}): LruCache<T> {
  (cache as any).name = name;
  registry.set(name, cache as any);
  meta.set(name, m);
  return cache;
}

export interface CacheDashboardRow {
  name: string; kind?: string; size: number; hits: number; misses: number; hitRate: number;
  coalesced: number; evictions: number; refreshes: number;
}

export function dashboard(): { rows: CacheDashboardRow[]; totalHitRate: number; totalSavedCalls: number } {
  const rows: CacheDashboardRow[] = [];
  let hits = 0, misses = 0, coalesced = 0;
  for (const [name, c] of registry) {
    const s = c.stats() as any;
    rows.push({ name, kind: meta.get(name)?.kind, size: s.size, hits: s.hits, misses: s.misses, hitRate: c.hitRate(), coalesced: s.coalesced, evictions: s.evictions, refreshes: s.refreshes });
    hits += s.hits; misses += s.misses; coalesced += s.coalesced;
  }
  rows.sort((a, b) => a.name.localeCompare(b.name));
  const total = hits + misses;
  return { rows, totalHitRate: total ? hits / total : 0, totalSavedCalls: hits + coalesced };
}

export function allCaches(): LruCache<any>[] { return [...registry.values()]; }
export function resetAll(): void { for (const c of registry.values()) c.reset(); }
export function clearAll(): void { for (const c of registry.values()) c.clear(); }
