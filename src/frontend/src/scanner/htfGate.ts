export interface HtfGateResult {
  bias: "LONG" | "SHORT" | "NEUTRAL";
  emaFast: number;
  emaSlow: number;
  rsi: number;
}

import { HTF_EMA_FAST, HTF_EMA_SLOW } from "../engine/constants";
import { computeRSI } from "./rsi";

/**
 * Deterministic HTF Bias Module
 * 5m context only
 * NEVER blocks entry
 * Same input → same output
 */
export function computeEMA(closes: number[], period: number): number {
  if (!closes || closes.length < period) return Number.NaN;

  const k = 2 / (period + 1);
  let ema = closes.slice(0, period).reduce((a, b) => a + b, 0) / period;

  for (let i = period; i < closes.length; i++) {
    ema = closes[i] * k + ema * (1 - k);
  }

  return ema;
}

export function evaluateHtfGate(closes5m: number[]): HtfGateResult {
  if (!closes5m || closes5m.length < HTF_EMA_SLOW) {
    return {
      bias: "NEUTRAL",
      emaFast: Number.NaN,
      emaSlow: Number.NaN,
      rsi: Number.NaN,
    };
  }

  const emaFast = computeEMA(closes5m, HTF_EMA_FAST);
  const emaSlow = computeEMA(closes5m, HTF_EMA_SLOW);
  const rsiSeries = computeRSI(closes5m, 27);
  const rsi =
    rsiSeries.length > 0 ? rsiSeries[rsiSeries.length - 1] : Number.NaN;

  let bias: "LONG" | "SHORT" | "NEUTRAL" = "NEUTRAL";

  if (emaFast > emaSlow && rsi > 50) {
    bias = "LONG";
  } else if (emaFast < emaSlow && rsi < 50) {
    bias = "SHORT";
  }

  return {
    bias,
    emaFast,
    emaSlow,
    rsi,
  };
}
