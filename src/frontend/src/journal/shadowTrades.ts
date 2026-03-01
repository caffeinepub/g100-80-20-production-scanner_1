/**
 * Shadow Trades — HTF_OFF Parallel Simulation
 *
 * Shadow trades simulate what would have happened if the HTF EMA filter
 * had NOT blocked a candidate. They are 100% analytical:
 * - DO NOT open real positions
 * - DO NOT affect equity
 * - DO NOT modify live engine behavior
 * - Use CLOSED CANDLE prices only (currentPrices from universe, same as live)
 * - Reuse SAME TP/SL hit logic as real trades
 * - Stored in separate IDB store: shadow_trades
 */

import { TP1_RR, TP2_RR } from "../engine/constants";
import type { ScoredCandidate } from "../scanner/finalScore";
import { idbPut } from "./idb";
import { emitEvent } from "./ledger";

export type ShadowTradeStatus = "OPEN" | "CLOSED";
export type ShadowCloseReason = "SL" | "TP1" | "TP2" | "TIME";

export interface ShadowTrade {
  /** Unique id, always prefixed with "SHADOW_" */
  id: string;
  symbol: string;
  side: "LONG" | "SHORT";
  entryPrice: number;
  slPrice: number;
  tp1Price: number;
  tp2Price: number;
  entryTimestamp: number;
  status: ShadowTradeStatus;
  /** Realized R at close; null while open */
  resultR: number | null;
  closeReason: ShadowCloseReason | null;
  // Internal tracking (mirrors real trade model)
  tp1Hit: boolean;
  remainingSize: number;
}

/**
 * Create and persist a new shadow trade from a blocked-HTF candidate.
 * Uses same SL/TP prices already computed in the candidate (from riskCalc).
 */
export async function openShadowTrade(
  candidate: ScoredCandidate,
): Promise<ShadowTrade | null> {
  const { symbol, side, entry, sl, tp1, tp2 } = candidate;

  if (
    !Number.isFinite(entry) ||
    entry <= 0 ||
    !Number.isFinite(sl) ||
    sl <= 0 ||
    !Number.isFinite(tp1) ||
    !Number.isFinite(tp2)
  ) {
    return null;
  }

  const now = Date.now();
  const trade: ShadowTrade = {
    id: `SHADOW_${symbol}-${side}-${now}`,
    symbol,
    side,
    entryPrice: entry,
    slPrice: sl,
    tp1Price: tp1,
    tp2Price: tp2,
    entryTimestamp: now,
    status: "OPEN",
    resultR: null,
    closeReason: null,
    tp1Hit: false,
    remainingSize: 1.0,
  };

  await idbPut("shadow_trades", trade);

  emitEvent(
    "SHADOW_ENTRY_CREATED",
    {
      id: trade.id,
      symbol,
      side,
      entry,
      sl,
      tp1,
      tp2,
    },
    "TRADES",
  );

  return trade;
}

/**
 * Per-cycle shadow trade monitoring.
 * Uses same closed-candle prices as live trade monitoring (currentPrices from universe).
 * Reuses the identical SL/TP hit logic — no additional Binance calls.
 *
 * @param trades   Current open shadow trades
 * @param currentPrices  symbol → last closed price (same map used by live trades)
 * @param timeStopMin  Time stop in minutes (same config as live)
 */
export async function updateShadowTrades(
  trades: ShadowTrade[],
  currentPrices: Record<string, number>,
  timeStopMin: number,
): Promise<ShadowTrade[]> {
  const now = Date.now();
  const timeStopMs = timeStopMin * 60_000;
  const updated: ShadowTrade[] = [];

  for (const trade of trades) {
    if (trade.status === "CLOSED") {
      updated.push(trade);
      continue;
    }

    const price = currentPrices[trade.symbol];
    if (price === undefined) {
      updated.push(trade);
      continue;
    }

    let t = { ...trade };

    // ── TIME STOP ────────────────────────────────────────────────────────
    if (now - t.entryTimestamp >= timeStopMs) {
      const resultR = computeShadowR(t, price);
      t = {
        ...t,
        status: "CLOSED",
        resultR,
        closeReason: "TIME",
        remainingSize: 0,
      };
      await idbPut("shadow_trades", t);
      emitEvent(
        "SHADOW_TRADE_CLOSED",
        { id: t.id, symbol: t.symbol, result: "TIME", resultR },
        "TRADES",
      );
      updated.push(t);
      continue;
    }

    if (t.side === "LONG") {
      // SL — priority
      if (price <= t.slPrice) {
        const resultR = -1;
        t = {
          ...t,
          status: "CLOSED",
          resultR,
          closeReason: "SL",
          remainingSize: 0,
        };
        await idbPut("shadow_trades", t);
        emitEvent(
          "SHADOW_TRADE_CLOSED",
          { id: t.id, symbol: t.symbol, result: "SL", resultR },
          "TRADES",
        );
        updated.push(t);
        continue;
      }

      // TP2 (gap-through)
      if (price >= t.tp2Price && !t.tp1Hit) {
        t = { ...t, tp1Hit: true, remainingSize: 0.5 };
      }
      if (price >= t.tp2Price) {
        const resultR = t.tp1Hit ? TP1_RR * 0.5 + TP2_RR * 0.5 : TP2_RR;
        t = {
          ...t,
          status: "CLOSED",
          resultR,
          closeReason: "TP2",
          remainingSize: 0,
        };
        await idbPut("shadow_trades", t);
        emitEvent(
          "SHADOW_TRADE_CLOSED",
          { id: t.id, symbol: t.symbol, result: "TP2", resultR },
          "TRADES",
        );
        updated.push(t);
        continue;
      }

      // TP1
      if (price >= t.tp1Price && !t.tp1Hit) {
        t = { ...t, tp1Hit: true, remainingSize: 0.5 };
        await idbPut("shadow_trades", t);
      }
    } else {
      // SHORT — inverse logic

      // SL
      if (price >= t.slPrice) {
        const resultR = -1;
        t = {
          ...t,
          status: "CLOSED",
          resultR,
          closeReason: "SL",
          remainingSize: 0,
        };
        await idbPut("shadow_trades", t);
        emitEvent(
          "SHADOW_TRADE_CLOSED",
          { id: t.id, symbol: t.symbol, result: "SL", resultR },
          "TRADES",
        );
        updated.push(t);
        continue;
      }

      // TP2 (gap-through)
      if (price <= t.tp2Price && !t.tp1Hit) {
        t = { ...t, tp1Hit: true, remainingSize: 0.5 };
      }
      if (price <= t.tp2Price) {
        const resultR = t.tp1Hit ? TP1_RR * 0.5 + TP2_RR * 0.5 : TP2_RR;
        t = {
          ...t,
          status: "CLOSED",
          resultR,
          closeReason: "TP2",
          remainingSize: 0,
        };
        await idbPut("shadow_trades", t);
        emitEvent(
          "SHADOW_TRADE_CLOSED",
          { id: t.id, symbol: t.symbol, result: "TP2", resultR },
          "TRADES",
        );
        updated.push(t);
        continue;
      }

      // TP1
      if (price <= t.tp1Price && !t.tp1Hit) {
        t = { ...t, tp1Hit: true, remainingSize: 0.5 };
        await idbPut("shadow_trades", t);
      }
    }

    updated.push(t);
  }

  return updated;
}

/** Compute partial R for an open trade that hit time stop. */
function computeShadowR(trade: ShadowTrade, exitPrice: number): number {
  if (trade.tp1Hit) {
    // 50% closed at TP1; remaining 50% closes at current price
    const riskPerUnit = Math.abs(trade.entryPrice - trade.slPrice);
    if (riskPerUnit === 0) return TP1_RR * 0.5;
    const remainingR =
      trade.side === "LONG"
        ? (exitPrice - trade.entryPrice) / riskPerUnit
        : (trade.entryPrice - exitPrice) / riskPerUnit;
    return TP1_RR * 0.5 + remainingR * 0.5;
  }
  // No TP1 hit — full position closes at current price
  const riskPerUnit = Math.abs(trade.entryPrice - trade.slPrice);
  if (riskPerUnit === 0) return 0;
  if (trade.side === "LONG") {
    return (exitPrice - trade.entryPrice) / riskPerUnit;
  }
  return (trade.entryPrice - exitPrice) / riskPerUnit;
}

/** Load all shadow trades from IDB on startup. */
export async function loadShadowTrades(): Promise<ShadowTrade[]> {
  try {
    const { idbGetAll } = await import("./idb");
    const raw = await idbGetAll("shadow_trades");
    return raw as ShadowTrade[];
  } catch {
    return [];
  }
}
