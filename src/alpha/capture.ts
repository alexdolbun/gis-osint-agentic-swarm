/**
 * capture.ts — Alpha Capture layer.
 *
 * Converts raw agent output into ranked, source-counted alpha signals with an
 * explicit confidence score and a verification label. Every claim must carry
 * (a) ≥1 source URL and (b) a confidence derived from independent-source count
 * — never from model vibes. This is the anti-hallucination gate for the swarm.
 */
export type ConfidenceLabel = "VERIFIED" | "LIKELY" | "SPECULATIVE" | "UNSUBSTANTIATED";

export interface Claim {
  key: string;
  text: string;
  category?: "POLITICAL" | "BUSINESS" | "LEGAL" | "FAMILY" | "GEOGRAPHIC" | "FINANCIAL";
  sources: string[];
  /** [0,1] independent-source agreement, supplied by the producing agent */
  agreement?: number;
  geo?: { lat: number; lon: number };
}

export interface AlphaSignal {
  id: string;
  kind: "geo-economic" | "rwa" | "onchain" | "entity-link" | "imagery-delta";
  title: string;
  confidence: number;
  label: ConfidenceLabel;
  sources: string[];
  entities: string[];
  geo?: { lat: number; lon: number };
  upside?: number;
  meta?: Record<string, unknown>;
}

export function labelFor(confidence: number): ConfidenceLabel {
  if (confidence >= 90) return "VERIFIED";
  if (confidence >= 70) return "LIKELY";
  if (confidence >= 40) return "SPECULATIVE";
  return "UNSUBSTANTIATED";
}

/** Confidence from independent source count + agreement, capped and floored. */
export function scoreConfidence(sources: string[], agreement = 0.5): number {
  const distinct = new Set(sources.map((s) => {
    try { return new URL(s).host; } catch { return s; }
  })).size;
  const base = Math.min(1, distinct / 3) * 70;       // ≤70 from independent sources
  const agree = Math.max(0, Math.min(1, agreement)) * 30; // ≤30 from agreement
  return Math.round(Math.max(0, Math.min(100, base + agree)));
}

export function toSignal(c: Claim, kind: AlphaSignal["kind"], extra: Partial<AlphaSignal> = {}): AlphaSignal {
  const confidence = scoreConfidence(c.sources, c.agreement ?? 0.5);
  return {
    id: `${kind}:${c.key}`,
    kind,
    title: c.text,
    confidence,
    label: labelFor(confidence),
    sources: [...new Set(c.sources)],
    entities: (extra.meta?.entities as string[]) ?? [],
    geo: c.geo,
    ...extra,
  };
}

/** Rank signals: confidence first, then declared upside. Stable + deterministic. */
export function rank(signals: AlphaSignal[]): AlphaSignal[] {
  return [...signals].sort((a, b) => (b.confidence - a.confidence) || ((b.upside ?? 0) - (a.upside ?? 0)) || a.id.localeCompare(b.id));
}

export interface AlphaReport {
  generatedAt: string;
  signals: AlphaSignal[];
  counts: Record<ConfidenceLabel, number>;
  top: AlphaSignal[];
  /** fraction of signals that pass the ≥2-source bar */
  multiSourceRate: number;
}

export function report(signals: AlphaSignal[], topN = 10): AlphaReport {
  const ranked = rank(signals);
  const counts: Record<ConfidenceLabel, number> = { VERIFIED: 0, LIKELY: 0, SPECULATIVE: 0, UNSUBSTANTIATED: 0 };
  for (const s of ranked) counts[s.label]++;
  const multiSource = ranked.filter((s) => new Set(s.sources).size >= 2).length;
  return {
    generatedAt: new Date().toISOString(),
    signals: ranked,
    counts,
    top: ranked.slice(0, topN),
    multiSourceRate: ranked.length ? Number((multiSource / ranked.length).toFixed(3)) : 0,
  };
}
