/**
 * onchain.ts — location↔onchain correlation (pure, cache-friendly).
 *
 * Correlation is done in CELL space: onchain notional is bucketed into the same
 * geo cell used by the cache keys, so a place query and a notional query hit the
 * same buckets and no re-bucketing happens per agent. The notional fetch is
 * injectable, so this module is offline-testable and never hard-wires a RPC.
 */
import { LruCache } from "../cache/lru.ts";
import { register } from "../cache/stats.ts";
import { cacheKey, geoCell } from "../cache/keyhash.ts";

export interface OnchainCell {
  cell: string;
  notionalUsd: number;
  txCount: number;
  /** ISO-4217 / chain ticker of the dominant flow */
  unit?: string;
  /** asset symbol → notional */
  assets?: Record<string, number>;
}

export type NotionalLoader = (cell: string) => Promise<OnchainCell>;

const notionalCache = register("onchain", new LruCache<OnchainCell>({ max: 20000, ttlMs: 300_000, swrMs: 900_000 }), {
  kind: "network", note: "geo cell → onchain notional, 5m TTL + 15m SWR",
});

export interface CorrelateOptions { decimals?: number; fetchImpl?: NotionalLoader }

/** Get (cached) notional for a point's cell. */
export async function cellNotional(lat: number, lon: number, opts: CorrelateOptions = {}): Promise<OnchainCell> {
  const cell = geoCell(lat, lon, opts.decimals ?? 3);
  if (!opts.fetchImpl) {
    return notionalCache.peek(cacheKey("onchain", cell)) ?? { cell, notionalUsd: 0, txCount: 0 };
  }
  return notionalCache.fetch(cacheKey("onchain", cell), () => opts.fetchImpl!(cell), 300_000);
}

export interface PlaceOnchainSignal {
  place: string;
  cell: string;
  notionalUsd: number;
  txCount: number;
  /** notional per tx — a liquidity-quality proxy, not just volume */
  intensity: number;
  /** USD → local currency, when an FX table is supplied */
  local?: Record<string, number>;
}

export function correlate(place: string, lat: number, lon: number, cell: OnchainCell, fx?: Record<string, number>): PlaceOnchainSignal {
  const intensity = cell.txCount ? Number((cell.notionalUsd / cell.txCount).toFixed(2)) : 0;
  const local = fx ? Object.fromEntries(Object.entries(fx).map(([ccy, rate]) => [ccy, Number((cell.notionalUsd * rate).toFixed(2))])) : undefined;
  return { place, cell: cell.cell, notionalUsd: cell.notionalUsd, txCount: cell.txCount, intensity, local };
}

export function _onchainCache(): LruCache<OnchainCell> { return notionalCache; }
