/**
 * riskCalc.ts — Stability Patch v2.1
 *
 * SL MODEL: STRUCTURAL_ATR (replaces fixed 0.15% clamp)
 *
 * For LONG:
 *   structuralSL = lowestLow(last 12 candles on 1m)
 *   volatilitySL = entry - (ATR_1m × 0.8)
 *   finalSL      = min(structuralSL, volatilitySL)
 *
 * For SHORT:
 *   structuralSL = highestHigh(last 12 candles on 1m)
 *   volatilitySL = entry + (ATR_1m × 0.8)
 *   finalSL      = max(structuralSL, volatilitySL)
 *
 * Hard clamp: [0.2%, 1.2%]
 *
 * Risk engine (unchanged):
 *   riskAmount = Equity × (RiskPerTrade / 100)
 *   qty        = riskAmount / abs(entry - SL)
 *   TP1        = entry ± risk × 2.2
 *   TP2        = entry ± risk × 3.0
 *
 * Deterministic. No randomness. No adaptive tuning.
 */

import {
  ATR_MULTIPLIER,
  ATR_PERIOD,
  MAX_SL_DISTANCE_PCT,
  MIN_NOTIONAL_USDT,
  MIN_SL_DISTANCE_PCT,
  STRUCTURAL_SL_CANDLES,
  TP1_RR,
  TP2_RR,
} from "../engine/constants";
import { emitEvent } from "../journal/ledger";

export interface RiskCalcInput {
  entry: number;
  side: "LONG" | "SHORT";
  /** klines for the 1m timeframe — raw Binance array format [[openTime, o, h, l, c, ...]] */
  klines: unknown[][];
  equityUSDT: number;
  riskPct: number; // percent, e.g. 0.65 means 0.65%
  maxLeverage: number;
  symbol: string;
}

export interface RiskCalcResult {
  sl: number;
  tp1: number;
  tp2: number;
  riskUSDT: number;
  riskPct: number;
  qty: number;
  notionalUSDT: number;
  effectiveLeverage: number;
  marginUsed: number;
  valid: boolean;
  rejectReason?: string;
}

// ─── ATR(14) calculation ────────────────────────────────────────────────────

/**
 * Compute ATR(period) using Wilder's RMA smoothing.
 * Klines format: [openTime, open, high, low, close, ...]
 * Returns NaN if insufficient data.
 */
export function computeATR(klines: unknown[][], period: number): number {
  if (klines.length < period + 1) return Number.NaN;

  const trueRanges: number[] = [];
  for (let i = 1; i < klines.length; i++) {
    const high = Number.parseFloat(klines[i][2] as string);
    const low = Number.parseFloat(klines[i][3] as string);
    const prevClose = Number.parseFloat(klines[i - 1][4] as string);
    if (
      !Number.isFinite(high) ||
      !Number.isFinite(low) ||
      !Number.isFinite(prevClose)
    ) {
      continue;
    }
    const tr = Math.max(
      high - low,
      Math.abs(high - prevClose),
      Math.abs(low - prevClose),
    );
    trueRanges.push(tr);
  }

  if (trueRanges.length < period) return Number.NaN;

  // Wilder RMA seed = SMA of first `period` TRs
  let atr = trueRanges.slice(0, period).reduce((a, b) => a + b, 0) / period;

  for (let i = period; i < trueRanges.length; i++) {
    atr = (atr * (period - 1) + trueRanges[i]) / period;
  }

  return atr;
}

// ─── SL Model: STRUCTURAL_ATR ───────────────────────────────────────────────

/**
 * Compute final SL using structural + ATR blend, then hard-clamp to [0.2%, 1.2%].
 *
 * LONG:
 *   structuralSL = min(low of last 12 candles)
 *   volatilitySL = entry - (ATR × 0.8)
 *   finalSL      = min(structuralSL, volatilitySL)   ← more conservative (further from entry)
 *
 * SHORT:
 *   structuralSL = max(high of last 12 candles)
 *   volatilitySL = entry + (ATR × 0.8)
 *   finalSL      = max(structuralSL, volatilitySL)   ← more conservative (further from entry)
 */
export function computeStructuralATRSL(
  klines: unknown[][],
  entry: number,
  side: "LONG" | "SHORT",
): number {
  const n = STRUCTURAL_SL_CANDLES;
  const last = klines.slice(-n);

  // ── Structural component ──────────────────────────────────────────────────
  let structuralSL: number;
  if (side === "LONG") {
    const lows = last
      .map((k) => Number.parseFloat(k[3] as string))
      .filter(Number.isFinite);
    structuralSL =
      lows.length > 0
        ? Math.min(...lows)
        : entry * (1 - MIN_SL_DISTANCE_PCT / 100);
  } else {
    const highs = last
      .map((k) => Number.parseFloat(k[2] as string))
      .filter(Number.isFinite);
    structuralSL =
      highs.length > 0
        ? Math.max(...highs)
        : entry * (1 + MIN_SL_DISTANCE_PCT / 100);
  }

  // ── Volatility component (ATR × 0.8) ─────────────────────────────────────
  const atr = computeATR(klines, ATR_PERIOD);
  let volatilitySL: number;
  if (Number.isFinite(atr) && atr > 0) {
    volatilitySL =
      side === "LONG"
        ? entry - atr * ATR_MULTIPLIER
        : entry + atr * ATR_MULTIPLIER;
  } else {
    // ATR unavailable — fall back to structural only
    volatilitySL = structuralSL;
  }

  // ── Combine: pick the more conservative SL ──────────────────────────────
  // LONG: min = further below entry
  // SHORT: max = further above entry
  const rawSL =
    side === "LONG"
      ? Math.min(structuralSL, volatilitySL)
      : Math.max(structuralSL, volatilitySL);

  // ── Hard clamp [MIN_SL_DISTANCE_PCT, MAX_SL_DISTANCE_PCT] ────────────────
  const slDistancePct = (Math.abs(entry - rawSL) / entry) * 100;

  if (slDistancePct < MIN_SL_DISTANCE_PCT) {
    return side === "LONG"
      ? entry * (1 - MIN_SL_DISTANCE_PCT / 100)
      : entry * (1 + MIN_SL_DISTANCE_PCT / 100);
  }

  if (slDistancePct > MAX_SL_DISTANCE_PCT) {
    return side === "LONG"
      ? entry * (1 - MAX_SL_DISTANCE_PCT / 100)
      : entry * (1 + MAX_SL_DISTANCE_PCT / 100);
  }

  return rawSL;
}

// Keep the old export name as an alias so existing call-sites (finalScore, etc.) compile.
// Both point to the new STRUCTURAL_ATR model.
export const computeStructuralSL = computeStructuralATRSL;

// ─── computeLevels — deterministic, purely mechanical ────────────────────────

export interface ComputeLevelsResult {
  slPrice: number;
  tp2Price: number;
  tp1Price?: number;
  rDist: number;
  valid: boolean;
  rejectReason?: string;
}

/**
 * Deterministic SL/TP computation from manual parameters (no klines, no ATR).
 *
 * LONG:  slPrice = entry × (1 − slPct/100)
 * SHORT: slPrice = entry × (1 + slPct/100)
 *
 * rDist = |entry − slPrice|
 *
 * LONG:  tp2Price = entry + rDist × rr
 * SHORT: tp2Price = entry − rDist × rr
 *
 * TP1 (if enableTP1):
 * LONG:  tp1Price = entry + rDist × tp1RR
 * SHORT: tp1Price = entry − rDist × tp1RR
 *
 * Same input → same output. No randomness. No adaptive logic.
 */
export function computeLevels(
  entry: number,
  side: "LONG" | "SHORT",
  slPct: number,
  rr: number,
  enableTP1 = false,
  tp1RR = 1.0,
): ComputeLevelsResult {
  const invalid = (reason: string): ComputeLevelsResult => ({
    slPrice: 0,
    tp2Price: 0,
    tp1Price: undefined,
    rDist: 0,
    valid: false,
    rejectReason: reason,
  });

  if (!Number.isFinite(entry) || entry <= 0) return invalid("INVALID_ENTRY");
  if (!Number.isFinite(slPct) || slPct <= 0) return invalid("INVALID_SL_PCT");
  if (!Number.isFinite(rr) || rr <= 0) return invalid("INVALID_RR");

  const slPrice =
    side === "LONG" ? entry * (1 - slPct / 100) : entry * (1 + slPct / 100);

  const rDist = Math.abs(entry - slPrice);

  if (!Number.isFinite(rDist) || rDist <= 0) return invalid("LEVELS_INVALID");

  const tp2Price = side === "LONG" ? entry + rDist * rr : entry - rDist * rr;

  let tp1Price: number | undefined;
  if (enableTP1 && Number.isFinite(tp1RR) && tp1RR > 0) {
    tp1Price = side === "LONG" ? entry + rDist * tp1RR : entry - rDist * tp1RR;
  }

  return { slPrice, tp2Price, tp1Price, rDist, valid: true };
}

// ─── Full risk-based sizing pipeline ────────────────────────────────────────

/**
 * Full risk-based sizing pipeline (unchanged from previous spec).
 * Returns a RiskCalcResult with all fields populated.
 * If validation fails, valid=false and rejectReason is set.
 */
export function computeRiskCalc(input: RiskCalcInput): RiskCalcResult {
  const { entry, side, klines, equityUSDT, riskPct, maxLeverage, symbol } =
    input;

  const invalid = (reason: string): RiskCalcResult => {
    emitEvent("RISK_CALC_REJECT", { symbol, reason }, "TRADES");
    return {
      sl: 0,
      tp1: 0,
      tp2: 0,
      riskUSDT: 0,
      riskPct,
      qty: 0,
      notionalUSDT: 0,
      effectiveLeverage: 0,
      marginUsed: 0,
      valid: false,
      rejectReason: reason,
    };
  };

  // Validate entry
  if (!Number.isFinite(entry) || entry <= 0) return invalid("INVALID_ENTRY");

  // SL: STRUCTURAL_ATR model
  const sl = computeStructuralATRSL(klines, entry, side);

  if (!Number.isFinite(sl) || sl <= 0) return invalid("INVALID_SL");

  // Risk per unit
  const riskPerUnit = Math.abs(entry - sl);
  if (riskPerUnit <= 0) return invalid("RISK_PER_UNIT_ZERO");

  // TP calculation (unchanged RR model)
  let tp1: number;
  let tp2: number;
  if (side === "LONG") {
    tp1 = entry + riskPerUnit * TP1_RR;
    tp2 = entry + riskPerUnit * TP2_RR;
  } else {
    tp1 = entry - riskPerUnit * TP1_RR;
    tp2 = entry - riskPerUnit * TP2_RR;
  }

  if (!Number.isFinite(tp1) || !Number.isFinite(tp2))
    return invalid("INVALID_TP");

  // Risk sizing (unchanged)
  const riskUSDT = equityUSDT * (riskPct / 100);
  const qty = riskUSDT / riskPerUnit;
  if (!Number.isFinite(qty) || qty <= 0) return invalid("QTY_ZERO");

  const notionalUSDT = qty * entry;
  if (!Number.isFinite(notionalUSDT) || notionalUSDT < MIN_NOTIONAL_USDT) {
    return invalid("NOTIONAL_BELOW_MIN");
  }

  const effectiveLeverage = notionalUSDT / equityUSDT;
  if (effectiveLeverage > maxLeverage) return invalid("LEVERAGE_EXCEEDED");

  const marginUsed = notionalUSDT / maxLeverage;

  emitEvent(
    "RISK_CALC_OK",
    {
      symbol,
      side,
      entry,
      sl,
      tp1,
      tp2,
      riskUSDT,
      qty,
      notionalUSDT,
      effectiveLeverage,
      marginUsed,
      slModel: "STRUCTURAL_ATR",
    },
    "TRADES",
  );

  return {
    sl,
    tp1,
    tp2,
    riskUSDT,
    riskPct,
    qty,
    notionalUSDT,
    effectiveLeverage,
    marginUsed,
    valid: true,
  };
}
