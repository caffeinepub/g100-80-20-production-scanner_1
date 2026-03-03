/**
 * htfBacktest.ts — Deterministic 28-day HTF replay backtest engine.
 *
 * ADDITIVE ONLY:
 *   - No imports from engine/scheduler
 *   - No live state mutations
 *   - No writes to real trades / shadow_trades stores
 *   - Completely standalone replay engine
 *
 * Groups:
 *   HTF_ON      → signals where 5m EMA9 > EMA20 (LONG) or EMA9 < EMA20 (SHORT)
 *   HTF_BLOCKED → signals blocked by HTF gate
 *   BASELINE    → all valid signals regardless of HTF
 */

import { BASE_URL, FALLBACK_URL } from "../engine/config";
import { computeEMA } from "../scanner/htfGate";
import { computeStructuralATRSL } from "../scanner/riskCalc";
import { computeRSI } from "../scanner/rsi";
import type { HtfBacktestResult, HtfGroupMetrics } from "./htfBacktestStore";

// ── Backtest-specific constants (separate from live engine) ───────────────────
const BT_UNIVERSE_CAP = 200;
const BT_VOL_FLOOR = 20_000_000;
const BT_DAYS = 28;
const BT_SL_MAX_DIST_PCT = 1.2; // skip if SL distance > 1.20%
const BT_TP_RR = 2.6; // TP = +2.6R
const BT_SL_RR = -1.0; // SL = -1R
const BT_TIMESTOP_MIN = 45; // 1m candles = minutes
const BT_FETCH_TIMEOUT_MS = 10_000;
const BT_KLINE_LIMIT = 1500; // max per Binance request

// ── Fetch helper with primary→fallback, no retry (backtest tolerates misses) ──

async function btFetch(path: string): Promise<unknown> {
  // Try primary
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), BT_FETCH_TIMEOUT_MS);
    const res = await fetch(`${BASE_URL}${path}`, {
      signal: controller.signal,
    });
    clearTimeout(timer);
    if (res.ok) return res.json();
    throw new Error(`HTTP ${res.status}`);
  } catch {
    // fall through to fallback
  }
  // Try fallback
  const controller2 = new AbortController();
  const timer2 = setTimeout(() => controller2.abort(), BT_FETCH_TIMEOUT_MS);
  const res2 = await fetch(`${FALLBACK_URL}${path}`, {
    signal: controller2.signal,
  });
  clearTimeout(timer2);
  if (!res2.ok) throw new Error(`Fallback HTTP ${res2.status}`);
  return res2.json();
}

// ── Universe builder ──────────────────────────────────────────────────────────

interface BtSymbol {
  symbol: string;
  quoteVolume: number;
}

async function buildBtUniverse(): Promise<BtSymbol[]> {
  const [infoRaw, tickerRaw] = await Promise.all([
    btFetch("/fapi/v1/exchangeInfo"),
    btFetch("/fapi/v1/ticker/24hr"),
  ]);

  const info = infoRaw as {
    symbols: {
      symbol: string;
      contractType: string;
      quoteAsset: string;
      status: string;
    }[];
  };
  const tickers = tickerRaw as {
    symbol: string;
    quoteVolume: string;
    lastPrice: string;
  }[];

  const EXCLUDE = ["DOWN", "UP", "BULL", "BEAR", "DOM", "HALF", "1000"];
  const base = info.symbols
    .filter(
      (s) =>
        s.contractType === "PERPETUAL" &&
        s.quoteAsset === "USDT" &&
        s.status === "TRADING" &&
        !EXCLUDE.some((e) => s.symbol.includes(e)),
    )
    .map((s) => s.symbol);

  const baseSet = new Set(base);
  const tickerMap = new Map<string, number>();
  for (const t of tickers) {
    const vol = Number(t.quoteVolume);
    const price = Number(t.lastPrice);
    if (
      Number.isFinite(vol) &&
      Number.isFinite(price) &&
      price > 0 &&
      baseSet.has(t.symbol)
    ) {
      tickerMap.set(t.symbol, vol);
    }
  }

  const filtered = base
    .filter((sym) => (tickerMap.get(sym) ?? 0) >= BT_VOL_FLOOR)
    .map((sym) => ({ symbol: sym, quoteVolume: tickerMap.get(sym)! }))
    .sort((a, b) =>
      b.quoteVolume !== a.quoteVolume
        ? b.quoteVolume - a.quoteVolume
        : a.symbol.localeCompare(b.symbol),
    )
    .slice(0, BT_UNIVERSE_CAP);

  return filtered;
}

// ── Kline fetch (multiple requests to cover 28 days) ─────────────────────────

// Binance kline format: [openTime, open, high, low, close, volume, closeTime, ...]
type RawKline = [
  number, // 0: openTime
  string, // 1: open
  string, // 2: high
  string, // 3: low
  string, // 4: close
  ...unknown[],
];

async function fetchAllKlines(
  symbol: string,
  interval: "1m" | "5m",
  days: number,
): Promise<RawKline[]> {
  const intervalMs = interval === "1m" ? 60_000 : 5 * 60_000;
  const endTime = Date.now();
  const startTime = endTime - days * 24 * 60 * 60 * 1000;

  const all: RawKline[] = [];
  let fetchStart = startTime;

  while (fetchStart < endTime) {
    const path = `/fapi/v1/klines?symbol=${symbol}&interval=${interval}&startTime=${fetchStart}&endTime=${endTime}&limit=${BT_KLINE_LIMIT}`;
    const raw = (await btFetch(path)) as RawKline[];
    if (!Array.isArray(raw) || raw.length === 0) break;
    all.push(...raw);
    const lastOpenTime = raw[raw.length - 1][0];
    fetchStart = lastOpenTime + intervalMs;
    if (raw.length < BT_KLINE_LIMIT) break;
  }

  // Keep only CLOSED candles (openTime + intervalMs <= now at fetch time)
  const now = Date.now();
  return all.filter((k) => k[0] + intervalMs <= now);
}

// ── Signal detection at a given 1m candle index ───────────────────────────────

interface BtSignal {
  side: "LONG" | "SHORT";
  entryPrice: number;
  slPrice: number;
  tpPrice: number;
  htfAllowed: boolean; // true = HTF_ON, false = HTF_BLOCKED
  entryTs: number;
  hourUtc: number;
}

function computeSignalAt(
  klines1m: RawKline[],
  klines5m: RawKline[],
  idx: number,
  rsiPeriod: number,
): BtSignal | null {
  // Need enough history for RSI + ATR
  if (idx < rsiPeriod * 2 + 20) return null;

  const window1m = klines1m.slice(Math.max(0, idx - 200), idx + 1);
  const closes1m = window1m.map((k) => Number.parseFloat(k[4]));

  // RSI on 1m
  const rsi1mSeries = computeRSI(closes1m, rsiPeriod);
  if (rsi1mSeries.length === 0) return null;
  const rsi1m = rsi1mSeries[rsi1mSeries.length - 1];
  if (!Number.isFinite(rsi1m)) return null;

  // Determine side via RSI extremes (Stage B C1 approximation)
  let side: "LONG" | "SHORT";
  if (rsi1m < 35) {
    side = "LONG";
  } else if (rsi1m > 65) {
    side = "SHORT";
  } else {
    return null;
  }

  const entryCandle = klines1m[idx];
  const entryPrice = Number.parseFloat(entryCandle[4]); // close of signal candle
  if (!Number.isFinite(entryPrice) || entryPrice <= 0) return null;

  // SL from structural ATR (last 12 candles) — reuses existing riskCalc function
  const slWindow = klines1m.slice(Math.max(0, idx - 12), idx + 1);
  // computeStructuralATRSL expects unknown[][]
  const sl = computeStructuralATRSL(slWindow as unknown[][], entryPrice, side);
  if (!Number.isFinite(sl) || sl <= 0) return null;

  // SL distance check — spec: skip if > 1.20%
  const slDistPct = (Math.abs(entryPrice - sl) / entryPrice) * 100;
  if (slDistPct > BT_SL_MAX_DIST_PCT) return null;

  const risk = Math.abs(entryPrice - sl);
  if (risk <= 0) return null;

  const tpPrice =
    side === "LONG"
      ? entryPrice + risk * BT_TP_RR
      : entryPrice - risk * BT_TP_RR;

  // HTF EMA gate: find the 5m candle aligned with this 1m candle
  const entryTs = entryCandle[0];
  let htfIdx = -1;
  for (let i = klines5m.length - 1; i >= 0; i--) {
    if (klines5m[i][0] <= entryTs) {
      htfIdx = i;
      break;
    }
  }

  let htfAllowed = false;
  if (htfIdx >= 20) {
    // need enough 5m candles for EMA20
    const window5m = klines5m.slice(Math.max(0, htfIdx - 60), htfIdx + 1);
    const closes5m = window5m.map((k) => Number.parseFloat(k[4]));
    const ema9 = computeEMA(closes5m, 9);
    const ema20 = computeEMA(closes5m, 20);
    if (Number.isFinite(ema9) && Number.isFinite(ema20)) {
      htfAllowed = side === "LONG" ? ema9 > ema20 : ema9 < ema20;
    }
  }

  const hourUtc = new Date(entryTs).getUTCHours();

  return {
    side,
    entryPrice,
    slPrice: sl,
    tpPrice,
    htfAllowed,
    entryTs,
    hourUtc,
  };
}

// ── Trade simulation (closed candles only) ────────────────────────────────────

function simulateTrade(
  signal: BtSignal,
  klines1m: RawKline[],
  entryIdx: number,
): number /* resultR */ {
  const { side, entryPrice, slPrice, tpPrice } = signal;
  const risk = Math.abs(entryPrice - slPrice);
  if (risk <= 0) return 0;

  const maxCandles = BT_TIMESTOP_MIN; // 1m candles = minutes

  for (
    let i = entryIdx + 1;
    i < klines1m.length && i <= entryIdx + maxCandles;
    i++
  ) {
    const k = klines1m[i];
    const high = Number.parseFloat(k[2]);
    const low = Number.parseFloat(k[3]);
    const close = Number.parseFloat(k[4]);

    if (!Number.isFinite(high) || !Number.isFinite(low)) continue;

    if (side === "LONG") {
      if (low <= slPrice) return BT_SL_RR;
      if (high >= tpPrice) return BT_TP_RR;
    } else {
      if (high >= slPrice) return BT_SL_RR;
      if (low <= tpPrice) return BT_TP_RR;
    }

    // Time stop: last candle in window
    if (i === entryIdx + maxCandles) {
      if (!Number.isFinite(close)) return 0;
      const r =
        side === "LONG"
          ? (close - entryPrice) / risk
          : (entryPrice - close) / risk;
      return r;
    }
  }
  return 0;
}

// ── Group metrics computation ─────────────────────────────────────────────────

interface RawTrade {
  resultR: number;
  symbol: string;
  hourUtc: number;
}

function computeGroupMetrics(
  trades: RawTrade[],
  totalDays: number,
): HtfGroupMetrics {
  if (trades.length === 0) {
    return {
      totalTrades: 0,
      winrate: 0,
      avgR: 0,
      netR: 0,
      expectancy: 0,
      maxDrawdownR: 0,
      tradesPerDay: 0,
      symbolDistribution: {},
      hourDistribution: {},
    };
  }

  const wins = trades.filter((t) => t.resultR > 0);
  const losses = trades.filter((t) => t.resultR <= 0);
  const winrate = (wins.length / trades.length) * 100;
  const avgR = trades.reduce((s, t) => s + t.resultR, 0) / trades.length;
  const netR = trades.reduce((s, t) => s + t.resultR, 0);
  const avgWin =
    wins.length > 0 ? wins.reduce((s, t) => s + t.resultR, 0) / wins.length : 0;
  const avgLoss =
    losses.length > 0
      ? Math.abs(losses.reduce((s, t) => s + t.resultR, 0) / losses.length)
      : 0;
  const expectancy =
    (winrate / 100) * avgWin - ((100 - winrate) / 100) * avgLoss;

  // Max drawdown R (running peak-to-trough)
  let peak = 0;
  let equity = 0;
  let maxDd = 0;
  for (const t of trades) {
    equity += t.resultR;
    if (equity > peak) peak = equity;
    const dd = peak - equity;
    if (dd > maxDd) maxDd = dd;
  }

  const tradesPerDay = trades.length / totalDays;

  const symbolDistribution: Record<string, number> = {};
  const hourDistribution: Record<number, number> = {};
  for (const t of trades) {
    symbolDistribution[t.symbol] = (symbolDistribution[t.symbol] ?? 0) + 1;
    hourDistribution[t.hourUtc] = (hourDistribution[t.hourUtc] ?? 0) + 1;
  }

  return {
    totalTrades: trades.length,
    winrate,
    avgR,
    netR,
    expectancy,
    maxDrawdownR: maxDd,
    tradesPerDay,
    symbolDistribution,
    hourDistribution,
  };
}

// ── Public progress type ──────────────────────────────────────────────────────

export type BacktestProgress = {
  phase: "universe" | "fetching" | "replaying" | "done" | "error";
  symbolsDone: number;
  symbolsTotal: number;
  pct: number;
  message: string;
};

// ── Main entry point ──────────────────────────────────────────────────────────

export async function runHtfBacktest(
  onProgress: (p: BacktestProgress) => void,
  cancelRef: { cancelled: boolean },
  rsiPeriod = 27,
): Promise<HtfBacktestResult> {
  const startMs = Date.now();

  onProgress({
    phase: "universe",
    symbolsDone: 0,
    symbolsTotal: 0,
    pct: 0,
    message: "Building universe...",
  });

  const universe = await buildBtUniverse();
  if (cancelRef.cancelled) throw new Error("CANCELLED");

  const total = universe.length;
  onProgress({
    phase: "fetching",
    symbolsDone: 0,
    symbolsTotal: total,
    pct: 0,
    message: `Universe: ${total} symbols. Fetching data...`,
  });

  const htfOnTrades: RawTrade[] = [];
  const htfBlockedTrades: RawTrade[] = [];
  const baselineTrades: RawTrade[] = [];

  for (let si = 0; si < universe.length; si++) {
    if (cancelRef.cancelled) throw new Error("CANCELLED");

    const sym = universe[si];
    const pct = Math.round((si / total) * 100);
    onProgress({
      phase: "replaying",
      symbolsDone: si,
      symbolsTotal: total,
      pct,
      message: `${sym.symbol} (${si + 1}/${total})`,
    });

    // Yield to keep UI responsive — prevents tab freezing
    await new Promise<void>((r) => setTimeout(r, 0));

    try {
      const [klines1m, klines5m] = await Promise.all([
        fetchAllKlines(sym.symbol, "1m", BT_DAYS),
        fetchAllKlines(sym.symbol, "5m", BT_DAYS),
      ]);

      if (cancelRef.cancelled) throw new Error("CANCELLED");
      if (!klines1m.length || !klines5m.length) continue;

      // Iterate each 1m candle and detect signals
      for (let idx = 0; idx < klines1m.length; idx++) {
        if (cancelRef.cancelled) throw new Error("CANCELLED");

        const signal = computeSignalAt(klines1m, klines5m, idx, rsiPeriod);
        if (!signal) continue;

        const resultR = simulateTrade(signal, klines1m, idx);
        const trade: RawTrade = {
          resultR,
          symbol: sym.symbol,
          hourUtc: signal.hourUtc,
        };

        // Baseline = all valid signals regardless of HTF
        baselineTrades.push(trade);

        if (signal.htfAllowed) {
          htfOnTrades.push(trade);
        } else {
          htfBlockedTrades.push(trade);
        }
      }
    } catch (err) {
      if ((err as Error).message === "CANCELLED") throw err;
      // silently skip symbol on fetch error — continue with next
    }
  }

  const durationMs = Date.now() - startMs;
  onProgress({
    phase: "done",
    symbolsDone: total,
    symbolsTotal: total,
    pct: 100,
    message: "Complete",
  });

  return {
    id: "latest",
    runAt: Date.now(),
    durationMs,
    symbolsProcessed: total,
    totalSignals: baselineTrades.length,
    htfOn: computeGroupMetrics(htfOnTrades, BT_DAYS),
    htfBlocked: computeGroupMetrics(htfBlockedTrades, BT_DAYS),
    baseline: computeGroupMetrics(baselineTrades, BT_DAYS),
  };
}
