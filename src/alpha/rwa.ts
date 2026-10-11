/**
 * rwa.ts — Real-World-Asset / geo-economic alpha.
 *
 * Scores a place for RWA-relevance from objective inputs: infrastructure
 * density (from the overpass/metadata agents), capital proximity (cluster
 * entities), and onchain liquidity (from the onchain agent). All pure math,
 * all deterministic, so the same place always scores the same and QAA can pin
 * a fixture.
 */
import { rank } from "./capture.ts";
import type { AlphaSignal } from "./capture.ts";

export interface RwaInput {
  place: string;
  lat: number;
  lon: number;
  /** POI counts by class (from overpass agent) */
  poi?: Record<string, number>;
  /** capital/finance entities co-located (from geosocial agent) */
  capitalEntities?: string[];
  /** onchain notional, USD, near this cell (from onchain agent) */
  onchainUsd?: number;
  sources?: string[];
}

const WEIGHT: Record<string, number> = {
  port: 0.30, airport: 0.15, industrial: 0.20, financial: 0.20, data_center: 0.15,
};

export interface RwaScore {
  place: string;
  lat: number;
  lon: number;
  score: number;
  components: Record<string, number>;
  grade: "A" | "B" | "C" | "D";
}

export function scoreRwa(input: RwaInput): RwaScore {
  const poi = input.poi ?? {};
  const totalPoi = Object.values(poi).reduce((a, b) => a + b, 0);
  const components: Record<string, number> = {};
  for (const [cls, w] of Object.entries(WEIGHT)) {
    components[cls] = Number((Math.min(1, (poi[cls] ?? 0) / 10) * w).toFixed(4));
  }
  // log-scaled capital proximity and onchain liquidity, both capped
  components.capital = Number((Math.min(1, Math.log10(1 + (input.capitalEntities?.length ?? 0)) / 2) * 0.15).toFixed(4));
  components.onchain = Number((Math.min(1, Math.log10(1 + (input.onchainUsd ?? 0)) / 8) * 0.15).toFixed(4));
  const raw = Object.values(components).reduce((a, b) => a + b, 0) / (totalPoi ? 1 : 1);
  const score = Number((Math.min(1, raw) * 100).toFixed(2));
  const grade: RwaScore["grade"] = score >= 70 ? "A" : score >= 50 ? "B" : score >= 30 ? "C" : "D";
  return { place: input.place, lat: input.lat, lon: input.lon, score, components, grade };
}

export function rwaSignals(inputs: RwaInput[]): AlphaSignal[] {
  return rank(inputs.map((i) => {
    const s = scoreRwa(i);
    const confidence = Math.round(Math.min(100, s.score * 0.6 + Math.min(40, new Set(i.sources ?? []).size * 20)));
    return {
      id: `rwa:${i.place}`,
      kind: "rwa" as const,
      title: `${i.place} — RWA grade ${s.grade} (${s.score})`,
      confidence,
      label: (confidence >= 90 ? "VERIFIED" : confidence >= 70 ? "LIKELY" : confidence >= 40 ? "SPECULATIVE" : "UNSUBSTANTIATED") as AlphaSignal["label"],
      sources: [...new Set(i.sources ?? [])],
      entities: i.capitalEntities ?? [],
      geo: { lat: i.lat, lon: i.lon },
      upside: s.score,
      meta: { components: s.components, grade: s.grade },
    };
  }));
}
