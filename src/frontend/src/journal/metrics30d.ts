import type { Trade } from "./trades";

export interface RRMetrics {
  totalTrades: number;
  tp1HitRate: number; // % of trades that hit TP1
  tp2HitRate: number; // % of trades that hit TP2
  slHitRate: number; // % of trades that hit SL
  avgRRRealized: number;
  expectancy: number; // E = (winRate * avgWin) - (lossRate * avgLoss)
}

export function computeRRMetrics(closedTrades: Trade[]): RRMetrics {
  const now = Date.now();
  const cutoff = now - 30 * 24 * 60 * 60 * 1000;

  const recent = closedTrades.filter(
    (t) => t.entryTime >= cutoff && t.status === "CLOSED",
  );

  const total = recent.length;

  if (total === 0) {
    return {
      totalTrades: 0,
      tp1HitRate: 0,
      tp2HitRate: 0,
      slHitRate: 0,
      avgRRRealized: 0,
      expectancy: 0,
    };
  }

  const tp1Count = recent.filter(
    (t) => t.tp1Hit || t.exitReason === "TP1" || t.exitReason === "TP2",
  ).length;
  const tp2Count = recent.filter((t) => t.exitReason === "TP2").length;
  const slCount = recent.filter((t) => t.exitReason === "SL").length;

  const tp1HitRate = (tp1Count / total) * 100;
  const tp2HitRate = (tp2Count / total) * 100;
  const slHitRate = (slCount / total) * 100;

  const rValues = recent.map((t) => t.r ?? 0);
  const avgRRRealized =
    rValues.length > 0
      ? rValues.reduce((a, b) => a + b, 0) / rValues.length
      : 0;

  // Expectancy: E = (winRate * avgWin) - (lossRate * avgLoss)
  const wins = recent.filter((t) => (t.r ?? 0) > 0);
  const losses = recent.filter((t) => (t.r ?? 0) <= 0);

  const winRate = wins.length / total;
  const lossRate = losses.length / total;

  const avgWin =
    wins.length > 0
      ? wins.reduce((a, b) => a + (b.r ?? 0), 0) / wins.length
      : 0;
  const avgLoss =
    losses.length > 0
      ? Math.abs(losses.reduce((a, b) => a + (b.r ?? 0), 0) / losses.length)
      : 0;

  const expectancy = winRate * avgWin - lossRate * avgLoss;

  return {
    totalTrades: total,
    tp1HitRate,
    tp2HitRate,
    slHitRate,
    avgRRRealized,
    expectancy,
  };
}
