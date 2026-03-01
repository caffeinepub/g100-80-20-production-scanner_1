import { STAGE_A_K } from "../engine/config";
import type { UniverseSymbol } from "../engine/universe";
import { getLastRSI } from "./rsi";

export interface StageACandidate {
  symbol: string;
  lastPrice: number;
  quoteVolume: number;
  rsi1m: number;
  rsi5m: number;
  rsi15m: number;
  rsi1h: number;
  stageAScoreLong: number;
  stageAScoreShort: number;
}

export function runStageA(
  symbols: UniverseSymbol[],
  rsiBuffers: Map<string, Record<string, number[]>>,
  period: number,
  _rescueDelta = 0,
  K = STAGE_A_K,
): { long: StageACandidate[]; short: StageACandidate[] } {
  const candidates: StageACandidate[] = [];

  for (const sym of symbols) {
    const tfBufs = rsiBuffers.get(sym.symbol);
    if (!tfBufs) continue;

    const rsi1m = getLastRSI(tfBufs["1m"] || [], period);
    const rsi5m = getLastRSI(tfBufs["5m"] || [], period);
    const rsi15m = getLastRSI(tfBufs["15m"] || [], period);
    const rsi1h = getLastRSI(tfBufs["1h"] || [], period);

    // Skip if any RSI is NaN
    if (
      !Number.isFinite(rsi1m) ||
      !Number.isFinite(rsi5m) ||
      !Number.isFinite(rsi15m) ||
      !Number.isFinite(rsi1h)
    ) {
      continue;
    }

    // LONG score: distance of rsi15m from 30 (lower RSI = better, i.e. closer to oversold)
    // Weight: 70% distance score + 30% 1H trend bonus
    const longDistScore = Math.max(0, 1 - Math.abs(rsi15m - 30) / 70); // normalized 0..1
    const long1hBonus = rsi1h < 60 ? 0.3 : 0;
    const stageAScoreLong = longDistScore * 0.7 + long1hBonus;

    // SHORT score: distance of rsi15m from 70 (higher RSI = better, i.e. closer to overbought)
    const shortDistScore = Math.max(0, 1 - Math.abs(rsi15m - 70) / 70); // normalized 0..1
    const short1hBonus = rsi1h > 40 ? 0.3 : 0;
    const stageAScoreShort = shortDistScore * 0.7 + short1hBonus;

    candidates.push({
      symbol: sym.symbol,
      lastPrice: sym.lastPrice,
      quoteVolume: sym.quoteVolume,
      rsi1m,
      rsi5m,
      rsi15m,
      rsi1h,
      stageAScoreLong,
      stageAScoreShort,
    });
  }

  const effectiveK = Math.min(K, candidates.length);

  // Top K LONG (highest stageAScoreLong)
  const longSorted = [...candidates].sort((a, b) => {
    if (b.stageAScoreLong !== a.stageAScoreLong)
      return b.stageAScoreLong - a.stageAScoreLong;
    return a.symbol.localeCompare(b.symbol);
  });

  // Top K SHORT (highest stageAScoreShort)
  const shortSorted = [...candidates].sort((a, b) => {
    if (b.stageAScoreShort !== a.stageAScoreShort)
      return b.stageAScoreShort - a.stageAScoreShort;
    return a.symbol.localeCompare(b.symbol);
  });

  return {
    long: longSorted.slice(0, effectiveK),
    short: shortSorted.slice(0, effectiveK),
  };
}
