import { getLastRSI } from "./rsi";

export type Regime = "NORMAL" | "EXTREME_UP" | "EXTREME_DOWN";

export function detectRegime(
  rsiBuffers: Map<string, Record<string, number[]>>,
  period: number,
): Regime {
  const rsi1hValues: number[] = [];

  for (const [, tfBuffers] of rsiBuffers) {
    const closes1h = tfBuffers["1h"];
    if (!closes1h || closes1h.length < period + 1) continue;
    const rsi = getLastRSI(closes1h, period);
    if (Number.isFinite(rsi)) {
      rsi1hValues.push(rsi);
    }
  }

  if (rsi1hValues.length === 0) return "NORMAL";

  const total = rsi1hValues.length;
  const aboveOverbought = rsi1hValues.filter((r) => r > 70).length;
  const belowOversold = rsi1hValues.filter((r) => r < 30).length;

  if (aboveOverbought / total > 0.6) return "EXTREME_UP";
  if (belowOversold / total > 0.6) return "EXTREME_DOWN";

  return "NORMAL";
}
