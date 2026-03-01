/**
 * Shadow Metrics — HTF_OFF Parallel Simulation Statistics
 * Computed from closed shadow trades only. Separate from real trade metrics.
 */

import type { ShadowTrade } from "./shadowTrades";

export interface ShadowMetrics {
  totalTrades: number;
  winRate: number; // % of closed trades with resultR > 0
  avgR: number; // average realized R
  netR: number; // sum of all resultR
  maxDrawdownR: number; // maximum peak-to-trough drawdown in R units
  tp1HitRate: number; // % of trades that hit TP1 (or TP2 implying TP1)
  tp2HitRate: number; // % of trades that hit TP2
}

export function computeShadowMetrics(
  allShadowTrades: ShadowTrade[],
): ShadowMetrics {
  const closed = allShadowTrades.filter(
    (t) => t.status === "CLOSED" && t.resultR !== null,
  );

  const total = closed.length;

  if (total === 0) {
    return {
      totalTrades: 0,
      winRate: 0,
      avgR: 0,
      netR: 0,
      maxDrawdownR: 0,
      tp1HitRate: 0,
      tp2HitRate: 0,
    };
  }

  const rValues = closed.map((t) => t.resultR ?? 0);

  const wins = closed.filter((t) => (t.resultR ?? 0) > 0).length;
  const winRate = (wins / total) * 100;

  const netR = rValues.reduce((a, b) => a + b, 0);
  const avgR = netR / total;

  // Max drawdown: maximum peak-to-trough in cumulative R curve
  let peak = 0;
  let cumR = 0;
  let maxDrawdownR = 0;
  for (const r of rValues) {
    cumR += r;
    if (cumR > peak) peak = cumR;
    const dd = peak - cumR;
    if (dd > maxDrawdownR) maxDrawdownR = dd;
  }

  const tp1Count = closed.filter(
    (t) => t.tp1Hit || t.closeReason === "TP2",
  ).length;
  const tp2Count = closed.filter((t) => t.closeReason === "TP2").length;

  const tp1HitRate = (tp1Count / total) * 100;
  const tp2HitRate = (tp2Count / total) * 100;

  return {
    totalTrades: total,
    winRate,
    avgR,
    netR,
    maxDrawdownR,
    tp1HitRate,
    tp2HitRate,
  };
}
