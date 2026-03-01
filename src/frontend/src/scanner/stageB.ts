import { computeRSI } from "./rsi";
import type { StageACandidate } from "./stageA";

export interface StageBResult {
  symbol: string;
  candidate: StageACandidate;
  passedC1: boolean;
  passedC2: boolean;
  passedC3: boolean;
  passed1H: boolean;
  passes: boolean;
}

/**
 * C1 (1m): RSI crossed below 35 (LONG) or above 65 (SHORT) in last 3 bars
 * C2 (5m): RSI < 45 (LONG) or > 55 (SHORT)
 * C3 (15m): RSI < 40 (LONG) or > 60 (SHORT)
 * 1H: RSI < 55 (LONG) or > 45 (SHORT)
 */
export function runStageB(
  candidates: StageACandidate[],
  side: "LONG" | "SHORT",
  rsiBuffers: Map<string, Record<string, number[]>>,
  period: number,
): StageBResult[] {
  return candidates.map((candidate) => {
    const tfBufs = rsiBuffers.get(candidate.symbol);
    if (!tfBufs) {
      return {
        symbol: candidate.symbol,
        candidate,
        passedC1: false,
        passedC2: false,
        passedC3: false,
        passed1H: false,
        passes: false,
      };
    }

    const closes1m = tfBufs["1m"] || [];
    const closes5m = tfBufs["5m"] || [];
    const closes15m = tfBufs["15m"] || [];
    const closes1h = tfBufs["1h"] || [];

    // Compute RSI series for C1 crossover check (need last few bars)
    const rsi1mSeries = computeRSI(closes1m, period);
    const rsi5mSeries = computeRSI(closes5m, period);
    const rsi15mSeries = computeRSI(closes15m, period);
    const rsi1hSeries = computeRSI(closes1h, period);

    const last1m = rsi1mSeries[rsi1mSeries.length - 1] ?? Number.NaN;
    const last5m = rsi5mSeries[rsi5mSeries.length - 1] ?? Number.NaN;
    const last15m = rsi15mSeries[rsi15mSeries.length - 1] ?? Number.NaN;
    const last1h = rsi1hSeries[rsi1hSeries.length - 1] ?? Number.NaN;

    // C1: crossed below 35 (LONG) or above 65 (SHORT) in last 3 bars
    let passedC1 = false;
    const recentBars = Math.min(3, rsi1mSeries.length);
    if (recentBars >= 2) {
      if (side === "LONG") {
        // Check if any transition from >=35 to <35 in last 3 bars
        for (
          let i = rsi1mSeries.length - recentBars;
          i < rsi1mSeries.length - 1;
          i++
        ) {
          if (rsi1mSeries[i] >= 35 && rsi1mSeries[i + 1] < 35) {
            passedC1 = true;
            break;
          }
        }
        // Also pass if currently below 35
        if (Number.isFinite(last1m) && last1m < 35) passedC1 = true;
      } else {
        // SHORT: crossed above 65
        for (
          let i = rsi1mSeries.length - recentBars;
          i < rsi1mSeries.length - 1;
          i++
        ) {
          if (rsi1mSeries[i] <= 65 && rsi1mSeries[i + 1] > 65) {
            passedC1 = true;
            break;
          }
        }
        if (Number.isFinite(last1m) && last1m > 65) passedC1 = true;
      }
    }

    // C2 (5m)
    const passedC2 =
      side === "LONG"
        ? Number.isFinite(last5m) && last5m < 45
        : Number.isFinite(last5m) && last5m > 55;

    // C3 (15m)
    const passedC3 =
      side === "LONG"
        ? Number.isFinite(last15m) && last15m < 40
        : Number.isFinite(last15m) && last15m > 60;

    // 1H
    const passed1H =
      side === "LONG"
        ? Number.isFinite(last1h) && last1h < 55
        : Number.isFinite(last1h) && last1h > 45;

    return {
      symbol: candidate.symbol,
      candidate,
      passedC1,
      passedC2,
      passedC3,
      passed1H,
      passes: passedC1 && passedC2 && passedC3 && passed1H,
    };
  });
}
