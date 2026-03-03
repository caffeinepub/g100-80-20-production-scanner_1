/**
 * htfBacktestStore.ts — IndexedDB storage for HTF 4W backtest results.
 *
 * Completely separate from live trades, shadow_trades, and any live engine state.
 * Stores only the single "latest" result (id="latest").
 *
 * ADDITIVE ONLY — never reads or writes live engine data.
 */

import { openDB } from "../journal/idb";

export interface HtfGroupMetrics {
  totalTrades: number;
  winrate: number; // 0–100
  avgR: number;
  netR: number;
  expectancy: number;
  maxDrawdownR: number;
  tradesPerDay: number;
  symbolDistribution: Record<string, number>; // symbol → count
  hourDistribution: Record<number, number>; // hour (0-23) → count
}

export interface HtfBacktestResult {
  id: "latest";
  runAt: number; // Date.now()
  durationMs: number;
  symbolsProcessed: number;
  totalSignals: number;
  htfOn: HtfGroupMetrics;
  htfBlocked: HtfGroupMetrics;
  baseline: HtfGroupMetrics;
}

export async function saveHtfBacktestResult(
  result: HtfBacktestResult,
): Promise<void> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction("htf_backtest_results", "readwrite");
    const os = tx.objectStore("htf_backtest_results");
    const req = os.put(result);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}

export async function loadHtfBacktestResult(): Promise<HtfBacktestResult | null> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction("htf_backtest_results", "readonly");
    const os = tx.objectStore("htf_backtest_results");
    const req = os.get("latest");
    req.onsuccess = () => resolve((req.result as HtfBacktestResult) ?? null);
    req.onerror = () => reject(req.error);
  });
}
