/**
 * htfGate.ts — Higher Timeframe Context Gate (Stability Patch v2.1)
 *
 * Timeframe hierarchy:
 *   5m = Trend Context  (this module)
 *   1m = Trigger Only   (stageB / riskCalc)
 *
 * LONG permitted ONLY IF:  EMA9_5m > EMA20_5m  AND  RSI_5m > 50
 * SHORT permitted ONLY IF: EMA9_5m < EMA20_5m  AND  RSI_5m < 50
 *
 * Deterministic. No randomness. No adaptive tuning.
 * Same input → identical output every time.
 */

import {
  HTF_EMA_FAST,
  HTF_EMA_SLOW,
  HTF_RSI_THRESHOLD,
} from "../engine/constants";
import { computeRSI } from "./rsi";

/**
 * Compute EMA for a series of closes.
 * Uses standard EMA formula: EMA = close * k + prev * (1 - k) where k = 2/(period+1).
 * Seed = SMA of first `period` closes.
 * Returns NaN if insufficient data.
 */
export function computeEMA(closes: number[], period: number): number {
  if (closes.length < period) return Number.NaN;

  const k = 2 / (period + 1);

  // Seed: SMA of first `period` candles
  let ema = closes.slice(0, period).reduce((a, b) => a + b, 0) / period;

  for (let i = period; i < closes.length; i++) {
    ema = closes[i] * k + ema * (1 - k);
  }

  return ema;
}

export interface HtfGateResult {
  permitted: boolean;
  ema9_5m: number;
  ema20_5m: number;
  rsi5m: number;
  reason: string;
}

/**
 * Check whether entry is permitted for the given side based on 5m trend context.
 *
 * @param closes5m  Array of 5m close prices (from RSI buffer)
 * @param side      "LONG" | "SHORT"
 * @param rsiPeriod RSI period from config (same period used throughout engine)
 */
export function checkHtfGate(
  closes5m: number[],
  side: "LONG" | "SHORT",
  rsiPeriod: number,
): HtfGateResult {
  const ema9 = computeEMA(closes5m, HTF_EMA_FAST);
  const ema20 = computeEMA(closes5m, HTF_EMA_SLOW);

  const rsiSeries = computeRSI(closes5m, rsiPeriod);
  const rsi5m =
    rsiSeries.length > 0 ? rsiSeries[rsiSeries.length - 1] : Number.NaN;

  // If we can't compute the indicators, block the entry (fail-safe)
  if (
    !Number.isFinite(ema9) ||
    !Number.isFinite(ema20) ||
    !Number.isFinite(rsi5m)
  ) {
    return {
      permitted: false,
      ema9_5m: ema9,
      ema20_5m: ema20,
      rsi5m,
      reason: "HTF_DATA_INSUFFICIENT",
    };
  }

  if (side === "LONG") {
    const trendOk = ema9 > ema20;
    const rsiOk = rsi5m > HTF_RSI_THRESHOLD;
    if (trendOk && rsiOk) {
      return {
        permitted: true,
        ema9_5m: ema9,
        ema20_5m: ema20,
        rsi5m,
        reason: "HTF_OK",
      };
    }
    const reason = !trendOk
      ? `EMA9(${ema9.toFixed(4)})<=EMA20(${ema20.toFixed(4)})`
      : `RSI_5m(${rsi5m.toFixed(1)})<=50`;
    return { permitted: false, ema9_5m: ema9, ema20_5m: ema20, rsi5m, reason };
  }
  // SHORT
  const trendOkShort = ema9 < ema20;
  const rsiOkShort = rsi5m < HTF_RSI_THRESHOLD;
  if (trendOkShort && rsiOkShort) {
    return {
      permitted: true,
      ema9_5m: ema9,
      ema20_5m: ema20,
      rsi5m,
      reason: "HTF_OK",
    };
  }
  const reasonShort = !trendOkShort
    ? `EMA9(${ema9.toFixed(4)})>=EMA20(${ema20.toFixed(4)})`
    : `RSI_5m(${rsi5m.toFixed(1)})>=50`;
  return {
    permitted: false,
    ema9_5m: ema9,
    ema20_5m: ema20,
    rsi5m,
    reason: reasonShort,
  };
}
