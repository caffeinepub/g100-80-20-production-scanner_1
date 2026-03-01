import type { ScannerConfig } from "../engine/config";
import type { RsiBuffers } from "../engine/warmup";
import { computeRiskCalc } from "./riskCalc";
import type { StageBResult } from "./stageB";

export interface ScoredCandidate {
  symbol: string;
  side: "LONG" | "SHORT";
  score: number;
  rsi1m: number;
  rsi5m: number;
  rsi15m: number;
  rsi1h: number;
  entry: number;
  sl: number;
  tp1: number;
  tp2: number;
  pressure: number;
  lastPrice: number;
  // Risk-based sizing fields
  qty: number;
  riskUSDT: number;
  effectiveLeverage: number;
  notionalUSDT: number;
  marginUsed: number;
  riskCalcValid: boolean;
}

export function computeFinalScore(
  stageBPasses: StageBResult[],
  side: "LONG" | "SHORT",
  config: ScannerConfig,
  universeMedianVolume: number,
  rsiBuffers: RsiBuffers,
): ScoredCandidate[] {
  const passing = stageBPasses.filter((r) => r.passes);

  const scored = passing.map((r) => {
    const { candidate } = r;
    const entry = candidate.lastPrice;

    // Get last 12 klines for this symbol (1m timeframe as primary)
    const bufData = rsiBuffers.get(candidate.symbol);
    // rsiBuffers stores close prices only — we need raw klines for structural SL.
    // The warmup stores close prices, not raw klines.
    // The scheduler stores raw klines in a separate klineBuffers map passed here.
    // For now, pass empty array — scheduler will inject rawKlines via augmented buffers.
    // The RsiBuffers type is extended in scheduler to carry rawKlines.
    const rawKlines: unknown[][] =
      (bufData as unknown as { _rawKlines?: Record<string, unknown[][]> })
        ?._rawKlines?.[candidate.symbol] ?? [];

    // Compute risk sizing
    const riskResult = computeRiskCalc({
      entry,
      side,
      klines: rawKlines,
      equityUSDT: config.equityUSDT,
      riskPct: config.riskPct,
      maxLeverage: config.maxLeverage,
      symbol: candidate.symbol,
    });

    // Base score from stageA
    const base =
      side === "LONG" ? candidate.stageAScoreLong : candidate.stageAScoreShort;

    // absorptionSigned: relative volume vs universe median, signed by side
    const volRatio =
      universeMedianVolume > 0
        ? (candidate.quoteVolume - universeMedianVolume) / universeMedianVolume
        : 0;
    const absorptionSigned = Math.max(-0.2, Math.min(0.2, volRatio * 0.1));

    // pressurePenalty: RSI > 50 for LONG or < 50 for SHORT → subtract 0.1
    const rsiMid = candidate.rsi15m;
    const pressurePenalty =
      (side === "LONG" && rsiMid > 50) || (side === "SHORT" && rsiMid < 50)
        ? 0.1
        : 0;

    const score = base + absorptionSigned - pressurePenalty;

    return {
      symbol: candidate.symbol,
      side,
      score,
      rsi1m: candidate.rsi1m,
      rsi5m: candidate.rsi5m,
      rsi15m: candidate.rsi15m,
      rsi1h: candidate.rsi1h,
      entry,
      sl: riskResult.sl,
      tp1: riskResult.tp1,
      tp2: riskResult.tp2,
      pressure: absorptionSigned,
      lastPrice: candidate.lastPrice,
      qty: riskResult.qty,
      riskUSDT: riskResult.riskUSDT,
      effectiveLeverage: riskResult.effectiveLeverage,
      notionalUSDT: riskResult.notionalUSDT,
      marginUsed: riskResult.marginUsed,
      riskCalcValid: riskResult.valid,
    };
  });

  // Sort DESC by score, tie-break symbol ASC, take top 5
  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return a.symbol.localeCompare(b.symbol);
  });

  return scored.slice(0, 5);
}

export function getMedianVolume(volumes: number[]): number {
  if (volumes.length === 0) return 0;
  const sorted = [...volumes].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[mid - 1] + sorted[mid]) / 2
    : sorted[mid];
}
