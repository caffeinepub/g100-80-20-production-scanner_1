import type { ScannerConfig } from "../engine/config";
import { TP1_RR, TP2_RR } from "../engine/constants";
import type { ScoredCandidate } from "../scanner/finalScore";
import { idbPut } from "./idb";
import { emitEvent } from "./ledger";

export type TradeSide = "LONG" | "SHORT";
export type TradeStatus = "OPEN" | "TP1_HIT" | "CLOSED";
export type TradeExitReason = "SL" | "TP1" | "TP2" | "TIME_STOP" | "MANUAL";

export interface Trade {
  id: string;
  symbol: string;
  side: TradeSide;
  entryPrice: number;
  sl: number;
  tp1: number;
  tp2: number;
  entryTime: number;
  exitPrice?: number;
  exitTime?: number;
  exitReason?: TradeExitReason;
  runId: number; // engine runId at time of open — ghost-trade guard
  status: TradeStatus;
  r?: number;
  lastSeen?: number;
  // RR model position tracking
  remainingSize: number; // 1.0 on open; 0.5 after TP1; 0 after TP2/SL
  tp1Hit: boolean;
  tp2Hit: boolean;
  // Hit counts for stats
  tp1HitCount: number;
  tp2HitCount: number;
  slHitCount: number;
  // Risk-based sizing fields
  riskUSDT: number;
  riskPct: number;
  qty: number;
  notionalUSDT: number;
  effectiveLeverage: number;
  marginUsed: number;
}

/**
 * Compute realized R for a trade.
 * For partial closes (TP1 only) we use TP1_RR as the realized R for that 50%.
 * For full close at TP2, we use TP2_RR for the remaining 50%.
 * For SL, realized R = -1 (full 1R loss).
 */
export function computeR(trade: Trade): number {
  if (trade.exitReason === "SL") return -1;
  if (trade.exitReason === "TP2") {
    // TP1 hit (50% at TP1_RR=2.2) + TP2 hit (50% at TP2_RR=3.0)
    if (trade.tp1Hit) {
      return TP1_RR * 0.5 + TP2_RR * 0.5;
    }
    // TP2 only (edge case)
    return TP2_RR;
  }
  if (trade.exitReason === "TP1") {
    // Closed at TP1 only (e.g. SL after TP1 in manual scenario)
    return TP1_RR * 0.5 + -1 * 0.5;
  }
  // Fallback: use price-based R
  if (trade.exitPrice === undefined) return 0;
  const riskPerUnit = Math.abs(trade.entryPrice - trade.sl);
  if (riskPerUnit === 0) return 0;
  if (trade.side === "LONG") {
    return (trade.exitPrice - trade.entryPrice) / riskPerUnit;
  }
  return (trade.entryPrice - trade.exitPrice) / riskPerUnit;
}

/**
 * Validate and open a new paper trade (auto-entry only).
 * Rejects if riskCalc failed or max open trades reached.
 */
export async function openTrade(
  candidate: ScoredCandidate,
  config: ScannerConfig,
  openTrades: Trade[],
  runId = 0,
): Promise<Trade | null> {
  if (openTrades.length >= config.maxOpenTrades) {
    emitEvent(
      "ENTRY_BLOCKED_MAX_OPEN",
      {
        symbol: candidate.symbol,
        side: candidate.side,
        openCount: openTrades.length,
        maxOpenTrades: config.maxOpenTrades,
      },
      "TRADES",
    );
    return null;
  }

  // Risk calc must be valid
  if (!candidate.riskCalcValid) {
    emitEvent(
      "TRADE_REJECTED",
      {
        symbol: candidate.symbol,
        side: candidate.side,
        reason: "RISK_CALC_INVALID",
      },
      "TRADES",
    );
    return null;
  }

  const entry = candidate.entry;
  const side = candidate.side;

  // Validate entry
  if (!Number.isFinite(entry) || entry <= 0) {
    emitEvent(
      "TRADE_REJECTED",
      { symbol: candidate.symbol, side, reason: "INVALID_ENTRY_PRICE" },
      "TRADES",
    );
    return null;
  }

  const { sl, tp1, tp2 } = candidate;

  // Validate SL
  if (!Number.isFinite(sl) || sl <= 0) {
    emitEvent(
      "TRADE_REJECTED",
      { symbol: candidate.symbol, side, reason: "INVALID_STOP_LOSS" },
      "TRADES",
    );
    return null;
  }

  // Validate risk
  const risk = side === "LONG" ? entry - sl : sl - entry;
  if (!Number.isFinite(risk) || risk <= 0) {
    emitEvent(
      "TRADE_REJECTED",
      { symbol: candidate.symbol, side, reason: "RISK_ZERO" },
      "TRADES",
    );
    return null;
  }

  // Validate TP prices
  if (!Number.isFinite(tp1) || !Number.isFinite(tp2)) {
    emitEvent(
      "TRADE_REJECTED",
      { symbol: candidate.symbol, side, reason: "INVALID_TP_PRICES" },
      "TRADES",
    );
    return null;
  }

  const now = Date.now();
  const trade: Trade = {
    id: `${candidate.symbol}-${side}-${now}`,
    symbol: candidate.symbol,
    side: side as TradeSide,
    entryPrice: entry,
    sl,
    tp1,
    tp2,
    entryTime: now,
    status: "OPEN",
    lastSeen: now,
    remainingSize: 1.0,
    tp1Hit: false,
    tp2Hit: false,
    tp1HitCount: 0,
    tp2HitCount: 0,
    slHitCount: 0,
    runId,
    // Risk-based sizing
    riskUSDT: candidate.riskUSDT,
    riskPct: config.riskPct,
    qty: candidate.qty,
    notionalUSDT: candidate.notionalUSDT,
    effectiveLeverage: candidate.effectiveLeverage,
    marginUsed: candidate.marginUsed,
  };

  await idbPut("trades", trade);

  emitEvent(
    "TRADE_OPENED",
    {
      id: trade.id,
      symbol: trade.symbol,
      side: trade.side,
      source: "AUTO",
      entry: trade.entryPrice,
      sl: trade.sl,
      tp1: trade.tp1,
      tp2: trade.tp2,
      rr_tp2: TP2_RR,
      riskUSDT: trade.riskUSDT,
      qty: trade.qty,
      notionalUSDT: trade.notionalUSDT,
      effectiveLeverage: trade.effectiveLeverage,
      marginUsed: trade.marginUsed,
      runId,
    },
    "TRADES",
  );

  // Log active SL model per patch v2.1
  emitEvent(
    "SL_MODEL",
    {
      model: "STRUCTURAL_ATR",
      symbol: trade.symbol,
      sl: trade.sl,
      entry: trade.entryPrice,
    },
    "TRADES",
  );

  return trade;
}

/**
 * Per-tick position monitoring using the RR model.
 * LONG: SL if price <= sl; TP1 if price >= tp1; TP2 if price >= tp2
 * SHORT: inverse
 * Time-stop: if elapsed >= timeStopMin, close remaining.
 * No trailing, no break-even, no SL movement.
 */
export async function updateTrades(
  trades: Trade[],
  currentPrices: Record<string, number>,
  config: ScannerConfig,
  cooldownMap?: Map<string, number>,
): Promise<Trade[]> {
  const now = Date.now();
  const updated: Trade[] = [];
  const timeStopMs = config.timeStopMin * 60_000;

  for (const trade of trades) {
    if (trade.status === "CLOSED") {
      updated.push(trade);
      continue;
    }

    const price = currentPrices[trade.symbol];
    if (price === undefined) {
      updated.push({ ...trade, lastSeen: now });
      continue;
    }

    let t = { ...trade, lastSeen: now };

    // ── TIME STOP ─────────────────────────────────────────────────────────
    if (now - t.entryTime >= timeStopMs) {
      t = {
        ...t,
        status: "CLOSED",
        exitPrice: price,
        exitTime: now,
        exitReason: "TIME_STOP",
        remainingSize: 0,
      };
      t.r = computeR(t);
      await idbPut("trades", t);
      emitEvent(
        "TRADE_TIME_STOP",
        {
          id: t.id,
          symbol: t.symbol,
          price,
          elapsedMin: Math.floor((now - t.entryTime) / 60_000),
          timeStopMin: config.timeStopMin,
        },
        "TRADES",
      );
      emitEvent(
        "TRADE_CLOSED",
        { id: t.id, symbol: t.symbol, exitReason: "TIME_STOP", r: t.r },
        "TRADES",
      );
      if (cooldownMap) {
        cooldownMap.set(t.symbol, now + config.cooldownMin * 60_000);
      }
      updated.push(t);
      continue;
    }

    if (t.side === "LONG") {
      // SL check — takes priority
      if (price <= t.sl) {
        t = {
          ...t,
          status: "CLOSED",
          exitPrice: price,
          exitTime: now,
          exitReason: "SL",
          remainingSize: 0,
          slHitCount: t.slHitCount + 1,
        };
        t.r = computeR(t);
        await idbPut("trades", t);
        emitEvent(
          "TRADE_SL_HIT",
          { id: t.id, symbol: t.symbol, price },
          "TRADES",
        );
        emitEvent(
          "TRADE_CLOSED",
          { id: t.id, symbol: t.symbol, exitReason: "SL", r: t.r },
          "TRADES",
        );
        if (cooldownMap)
          cooldownMap.set(t.symbol, now + config.cooldownMin * 60_000);
        updated.push(t);
        continue;
      }

      // TP2 check (must be before TP1 check to handle instant gap-through)
      if (price >= t.tp2 && !t.tp2Hit) {
        // If TP1 wasn't hit yet, mark it now
        if (!t.tp1Hit) {
          t = {
            ...t,
            tp1Hit: true,
            tp1HitCount: t.tp1HitCount + 1,
            remainingSize: 0.5,
          };
          emitEvent(
            "TRADE_TP1_HIT",
            { id: t.id, symbol: t.symbol, price },
            "TRADES",
          );
        }
        t = {
          ...t,
          status: "CLOSED",
          exitPrice: price,
          exitTime: now,
          exitReason: "TP2",
          remainingSize: 0,
          tp2Hit: true,
          tp2HitCount: t.tp2HitCount + 1,
        };
        t.r = computeR(t);
        await idbPut("trades", t);
        emitEvent(
          "TRADE_TP2_HIT",
          { id: t.id, symbol: t.symbol, price },
          "TRADES",
        );
        emitEvent(
          "TRADE_CLOSED",
          { id: t.id, symbol: t.symbol, exitReason: "TP2", r: t.r },
          "TRADES",
        );
        if (cooldownMap)
          cooldownMap.set(t.symbol, now + config.cooldownMin * 60_000);
        updated.push(t);
        continue;
      }

      // TP1 check
      if (price >= t.tp1 && !t.tp1Hit) {
        t = {
          ...t,
          status: "TP1_HIT",
          tp1Hit: true,
          tp1HitCount: t.tp1HitCount + 1,
          remainingSize: 0.5,
        };
        await idbPut("trades", t);
        emitEvent(
          "TRADE_TP1_HIT",
          { id: t.id, symbol: t.symbol, price },
          "TRADES",
        );
      }
    } else {
      // SHORT — inverse logic

      // SL check
      if (price >= t.sl) {
        t = {
          ...t,
          status: "CLOSED",
          exitPrice: price,
          exitTime: now,
          exitReason: "SL",
          remainingSize: 0,
          slHitCount: t.slHitCount + 1,
        };
        t.r = computeR(t);
        await idbPut("trades", t);
        emitEvent(
          "TRADE_SL_HIT",
          { id: t.id, symbol: t.symbol, price },
          "TRADES",
        );
        emitEvent(
          "TRADE_CLOSED",
          { id: t.id, symbol: t.symbol, exitReason: "SL", r: t.r },
          "TRADES",
        );
        if (cooldownMap)
          cooldownMap.set(t.symbol, now + config.cooldownMin * 60_000);
        updated.push(t);
        continue;
      }

      // TP2 check
      if (price <= t.tp2 && !t.tp2Hit) {
        if (!t.tp1Hit) {
          t = {
            ...t,
            tp1Hit: true,
            tp1HitCount: t.tp1HitCount + 1,
            remainingSize: 0.5,
          };
          emitEvent(
            "TRADE_TP1_HIT",
            { id: t.id, symbol: t.symbol, price },
            "TRADES",
          );
        }
        t = {
          ...t,
          status: "CLOSED",
          exitPrice: price,
          exitTime: now,
          exitReason: "TP2",
          remainingSize: 0,
          tp2Hit: true,
          tp2HitCount: t.tp2HitCount + 1,
        };
        t.r = computeR(t);
        await idbPut("trades", t);
        emitEvent(
          "TRADE_TP2_HIT",
          { id: t.id, symbol: t.symbol, price },
          "TRADES",
        );
        emitEvent(
          "TRADE_CLOSED",
          { id: t.id, symbol: t.symbol, exitReason: "TP2", r: t.r },
          "TRADES",
        );
        if (cooldownMap)
          cooldownMap.set(t.symbol, now + config.cooldownMin * 60_000);
        updated.push(t);
        continue;
      }

      // TP1 check
      if (price <= t.tp1 && !t.tp1Hit) {
        t = {
          ...t,
          status: "TP1_HIT",
          tp1Hit: true,
          tp1HitCount: t.tp1HitCount + 1,
          remainingSize: 0.5,
        };
        await idbPut("trades", t);
        emitEvent(
          "TRADE_TP1_HIT",
          { id: t.id, symbol: t.symbol, price },
          "TRADES",
        );
      }
    }

    updated.push(t);
  }

  return updated;
}
