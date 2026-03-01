import { idbPut } from "../journal/idb";
import { emitEvent } from "../journal/ledger";
import {
  type ShadowTrade,
  openShadowTrade,
  updateShadowTrades,
} from "../journal/shadowTrades";
import { openTrade, updateTrades } from "../journal/trades";
import type { Trade } from "../journal/trades";
import {
  type ScoredCandidate,
  computeFinalScore,
  getMedianVolume,
} from "../scanner/finalScore";
import { checkHtfGate } from "../scanner/htfGate";
import { type Regime, detectRegime } from "../scanner/regime";
import { computeRiskCalc } from "../scanner/riskCalc";
import { type StageACandidate, runStageA } from "../scanner/stageA";
import { runStageB } from "../scanner/stageB";
import { FULL_SCAN_INTERVAL_CYCLES, type ScannerConfig } from "./config";
import { BASE_URL } from "./config";
import { HEARTBEAT_MS, STRUCTURAL_SL_CANDLES } from "./constants";
import { fetchWithQueue } from "./fetcher";
import { type UniverseSymbol, buildUniverse } from "./universe";
import { type RsiBuffers, warmupUniverse } from "./warmup";

export type EngineState =
  | "IDLE"
  | "INITIALIZING"
  | "WARMING"
  | "RUNNING"
  | "STOPPING"
  | "ERROR";

// Raw klines store: symbol → timeframe → last N candles (raw Binance array format)
export type RawKlineBuffers = Map<string, Record<string, unknown[][]>>;

export interface EngineInternals {
  runId: number;
  universe: UniverseSymbol[];
  rsiBuffers: RsiBuffers;
  rawKlineBuffers: RawKlineBuffers;
  cycleCount: number;
  lastStageALong: StageACandidate[];
  lastStageAShort: StageACandidate[];
  tickCounter: number;
  lastTickTs: string;
  lastHeartbeatMs: number;
  heartbeatTimer: ReturnType<typeof setInterval> | null;
  pollTimer: ReturnType<typeof setTimeout> | null;
  stageAZeroCounter: number;
  rescueMode: boolean;
  /** symbol → timestamp when cooldown expires */
  cooldownMap: Map<string, number>;
  /** set to true once warmup completes — used by auto-entry gate */
  warmupCompleted: boolean;
}

export interface EngineCallbacks {
  onStateChange: (state: EngineState) => void;
  getState: () => EngineState;
  onUniverseUpdate: (
    count: number,
    eligible: number,
    filterLevel: "20M" | "5M" | "1M" | null,
    retainedUsed?: boolean,
  ) => void;
  onWarmupProgress: (done: number, total: number) => void;
  onWarmupComplete: () => void;
  onTop5Update: (long: ScoredCandidate[], short: ScoredCandidate[]) => void;
  onRegimeUpdate: (regime: Regime) => void;
  onTickUpdate: (counter: number, ts: string, lastMs: number) => void;
  onTradesUpdate: (trades: Trade[]) => void;
  onShadowTradesUpdate: (trades: ShadowTrade[]) => void;
}

export function createEngineInternals(): EngineInternals {
  return {
    runId: 0,
    universe: [],
    rsiBuffers: new Map(),
    rawKlineBuffers: new Map(),
    cycleCount: 0,
    lastStageALong: [],
    lastStageAShort: [],
    tickCounter: 0,
    lastTickTs: "--",
    lastHeartbeatMs: 0,
    heartbeatTimer: null,
    pollTimer: null,
    stageAZeroCounter: 0,
    rescueMode: false,
    cooldownMap: new Map(),
    warmupCompleted: false,
  };
}

function stopTimers(internals: EngineInternals) {
  if (internals.heartbeatTimer !== null) {
    clearInterval(internals.heartbeatTimer);
    internals.heartbeatTimer = null;
  }
  if (internals.pollTimer !== null) {
    clearTimeout(internals.pollTimer);
    internals.pollTimer = null;
  }
}

function startHeartbeat(
  internals: EngineInternals,
  callbacks: EngineCallbacks,
  localRunId: number,
) {
  stopTimers(internals); // clear any old timers first

  internals.heartbeatTimer = setInterval(() => {
    if (internals.runId !== localRunId) {
      clearInterval(internals.heartbeatTimer!);
      internals.heartbeatTimer = null;
      return;
    }
    internals.lastTickTs = new Date().toLocaleTimeString("en-GB");
    internals.lastHeartbeatMs = Date.now();
    internals.tickCounter++;
    callbacks.onTickUpdate(
      internals.tickCounter,
      internals.lastTickTs,
      internals.lastHeartbeatMs,
    );
  }, HEARTBEAT_MS);
}

// Minimum candles to retain per symbol for risk calc (last 12 raw + headroom)
const RAW_KLINE_LIMIT = Math.max(STRUCTURAL_SL_CANDLES + 4, 20);

async function fetchIncrementalKlines(
  symbols: string[],
  rsiBuffers: RsiBuffers,
  rawKlineBuffers: RawKlineBuffers,
  rsiPeriod: number,
  runId: number,
  getCurrentRunId: () => number,
): Promise<void> {
  const limit = Math.max(50, rsiPeriod * 2);
  const tfs = ["1m", "5m", "15m", "1h"] as const;

  for (const symbol of symbols) {
    if (getCurrentRunId() !== runId) return;
    const existing = rsiBuffers.get(symbol);
    const newData: Record<string, number[]> = existing
      ? { ...existing }
      : { "1m": [], "5m": [], "15m": [], "1h": [] };

    const existingRaw = rawKlineBuffers.get(symbol) ?? {
      "1m": [],
      "5m": [],
      "15m": [],
      "1h": [],
    };
    const newRaw: Record<string, unknown[][]> = { ...existingRaw };

    for (const tf of tfs) {
      if (getCurrentRunId() !== runId) return;
      const url = `${BASE_URL}/fapi/v1/klines?symbol=${symbol}&interval=${tf}&limit=${limit}`;
      try {
        const raw = await fetchWithQueue(url);
        if (raw && Array.isArray(raw)) {
          const rawArr = raw as unknown[][];
          // Update close-price RSI buffer
          const closes = rawArr.map((k) => Number.parseFloat(k[4] as string));
          const old = (newData[tf] || []).slice(0, -limit);
          newData[tf] = [...old, ...closes].slice(
            -Math.max(200, rsiPeriod * 4),
          );
          // Update raw kline buffer (keep last RAW_KLINE_LIMIT candles)
          const oldRaw = (newRaw[tf] || []).slice(0, -limit);
          newRaw[tf] = [...oldRaw, ...rawArr].slice(-RAW_KLINE_LIMIT);
        }
      } catch {
        // silently continue
      }
    }

    rsiBuffers.set(
      symbol,
      newData as Record<"1m" | "5m" | "15m" | "1h", number[]>,
    );
    rawKlineBuffers.set(symbol, newRaw as Record<string, unknown[][]>);
  }
}

/**
 * Attach rawKlineBuffers onto a special property of the rsiBuffers map
 * so that finalScore.ts can access raw klines without signature changes.
 */
function attachRawKlines(
  rsiBuffers: RsiBuffers,
  rawKlineBuffers: RawKlineBuffers,
): void {
  // Build a consolidated raw klines lookup: symbol → "1m" raw klines
  const lookup: Record<string, unknown[][]> = {};
  for (const [symbol, tfMap] of rawKlineBuffers.entries()) {
    lookup[symbol] = tfMap["1m"] ?? [];
  }
  (
    rsiBuffers as unknown as { _rawKlines?: Record<string, unknown[][]> }
  )._rawKlines = lookup;
}

export async function runEngineStart(
  internals: EngineInternals,
  config: ScannerConfig,
  callbacks: EngineCallbacks,
  openTrades: Trade[],
  initialShadowTrades: ShadowTrade[] = [],
): Promise<void> {
  internals.runId++;
  internals.warmupCompleted = false;
  const localRunId = internals.runId;
  const getCurrentRunId = () => internals.runId;

  emitEvent("INIT_START", { runId: localRunId }, "ENGINE");
  emitEvent("ENGINE_START", { runId: localRunId }, "ENGINE");
  callbacks.onStateChange("INITIALIZING");

  try {
    // ── UNIVERSE LOAD ────────────────────────────────────────────────────────
    const t0Universe = Date.now();
    const universeResult = await buildUniverse(
      config,
      internals.universe,
      localRunId,
      getCurrentRunId,
    );
    if (getCurrentRunId() !== localRunId) return;

    const universeMs = Date.now() - t0Universe;
    emitEvent(
      "INIT_STEP",
      {
        step: "UNIVERSE",
        ok: true,
        ms: universeMs,
        details: { count: universeResult.symbols.length },
      },
      "ENGINE",
    );

    internals.universe = universeResult.symbols;
    callbacks.onUniverseUpdate(
      universeResult.symbols.length,
      universeResult.eligibleCount,
      universeResult.filterLevelUsed,
      universeResult.retainedUsed,
    );

    // ── WARMUP ───────────────────────────────────────────────────────────────
    callbacks.onStateChange("WARMING");

    const t0Warmup = Date.now();
    const warmupResult = await warmupUniverse(
      internals.universe,
      config.rsiPeriod,
      localRunId,
      getCurrentRunId,
    );

    if (getCurrentRunId() !== localRunId) return;

    if (warmupResult.loadedCount === 0 && internals.universe.length > 0) {
      emitEvent(
        "WARMUP_INPUT_ZERO",
        { universeCount: internals.universe.length },
        "WARMUP",
      );
      emitEvent("ENGINE_ERROR", { reason: "WARMUP_INPUT_ZERO" }, "ERROR");
      stopTimers(internals);
      callbacks.onStateChange("ERROR");
      return;
    }

    const warmupMs = Date.now() - t0Warmup;
    emitEvent(
      "INIT_STEP",
      {
        step: "WARMUP",
        ok: true,
        ms: warmupMs,
        details: { loaded: warmupResult.loadedCount },
      },
      "ENGINE",
    );

    internals.rsiBuffers = warmupResult.buffers;
    internals.warmupCompleted = true;
    callbacks.onWarmupComplete();

    if (getCurrentRunId() !== localRunId) return;

    // ── ENGINE READY ─────────────────────────────────────────────────────────
    emitEvent(
      "ENGINE_READY",
      { runId: localRunId, bufferedSymbols: warmupResult.loadedCount },
      "ENGINE",
    );
    callbacks.onStateChange("RUNNING");

    // Start independent heartbeat timer (separate from poll cycle)
    startHeartbeat(internals, callbacks, localRunId);

    // Start polling loop
    await runPollingLoop(
      internals,
      config,
      callbacks,
      openTrades,
      initialShadowTrades,
      localRunId,
    );
  } catch (err) {
    if (getCurrentRunId() !== localRunId) return; // stale — ignore

    const reason = err instanceof Error ? err.message : String(err);
    emitEvent("ENGINE_ERROR", { reason }, "ERROR");
    stopTimers(internals);
    callbacks.onStateChange("ERROR");
  }
}

/**
 * Auto-entry gate: attempt to open a paper trade for a scored candidate.
 * All preconditions must pass; emits AUTO_ENTRY_ATTEMPT, AUTO_ENTRY_SUCCESS or AUTO_ENTRY_BLOCKED.
 * If blocked by HTF filter and enableShadowStats is true, creates a shadow trade instead.
 */
async function tryAutoEntry(
  candidate: ScoredCandidate,
  internals: EngineInternals,
  config: ScannerConfig,
  callbacks: EngineCallbacks,
  openTrades: Trade[],
  openShadowTrades: ShadowTrade[],
  localRunId: number,
): Promise<{ trade: Trade | null; shadowTrade: ShadowTrade | null }> {
  const sym = candidate.symbol;

  emitEvent(
    "AUTO_ENTRY_ATTEMPT",
    { symbol: sym, side: candidate.side, score: candidate.score },
    "TRADES",
  );

  // 1) runId guard
  if (internals.runId !== localRunId) {
    emitEvent(
      "AUTO_ENTRY_BLOCKED",
      { symbol: sym, reason: "STALE_RUN_ID" },
      "TRADES",
    );
    return { trade: null, shadowTrade: null };
  }

  // 2) engineState must be RUNNING
  if (callbacks.getState() !== "RUNNING") {
    emitEvent(
      "AUTO_ENTRY_BLOCKED",
      { symbol: sym, reason: "ENGINE_NOT_RUNNING" },
      "TRADES",
    );
    return { trade: null, shadowTrade: null };
  }

  // 3) warmup must be completed
  if (!internals.warmupCompleted) {
    emitEvent(
      "AUTO_ENTRY_BLOCKED",
      { symbol: sym, reason: "WARMUP_NOT_COMPLETE" },
      "TRADES",
    );
    return { trade: null, shadowTrade: null };
  }

  // 4) global trade cap
  if (openTrades.length >= config.maxOpenTrades) {
    emitEvent(
      "AUTO_ENTRY_BLOCKED",
      {
        symbol: sym,
        reason: "MAX_OPEN_TRADES",
        openCount: openTrades.length,
        max: config.maxOpenTrades,
      },
      "TRADES",
    );
    return { trade: null, shadowTrade: null };
  }

  // 5) duplicate symbol protection
  const alreadyOpen = openTrades.some(
    (t) => t.symbol === sym && t.status !== "CLOSED",
  );
  if (alreadyOpen) {
    emitEvent(
      "AUTO_ENTRY_BLOCKED",
      { symbol: sym, reason: "DUPLICATE_SYMBOL" },
      "TRADES",
    );
    return { trade: null, shadowTrade: null };
  }

  // 6) cooldown check
  const cooldownExpiry = internals.cooldownMap.get(sym) ?? 0;
  if (Date.now() < cooldownExpiry) {
    const remainsMin = Math.ceil((cooldownExpiry - Date.now()) / 60_000);
    emitEvent(
      "AUTO_ENTRY_BLOCKED",
      { symbol: sym, reason: "COOLDOWN_ACTIVE", remainsMin },
      "TRADES",
    );
    return { trade: null, shadowTrade: null };
  }

  // 7) Re-compute risk calc with current price to ensure freshness
  const rawKlines: unknown[][] =
    (
      internals.rsiBuffers.get(sym) as unknown as {
        _rawKlines?: Record<string, unknown[][]>;
      }
    )?._rawKlines?.[sym] ?? [];

  const riskResult = computeRiskCalc({
    entry: candidate.entry,
    side: candidate.side,
    klines: rawKlines,
    equityUSDT: config.equityUSDT,
    riskPct: config.riskPct,
    maxLeverage: config.maxLeverage,
    symbol: sym,
  });

  if (!riskResult.valid) {
    emitEvent(
      "AUTO_ENTRY_BLOCKED",
      {
        symbol: sym,
        reason: "RISK_CALC_REJECT",
        detail: riskResult.rejectReason,
      },
      "TRADES",
    );
    return { trade: null, shadowTrade: null };
  }

  // 8) Build enriched candidate with fresh risk calc
  const enriched: ScoredCandidate = {
    ...candidate,
    sl: riskResult.sl,
    tp1: riskResult.tp1,
    tp2: riskResult.tp2,
    qty: riskResult.qty,
    riskUSDT: riskResult.riskUSDT,
    notionalUSDT: riskResult.notionalUSDT,
    effectiveLeverage: riskResult.effectiveLeverage,
    marginUsed: riskResult.marginUsed,
    riskCalcValid: true,
  };

  // 9) HTF Context Gate — 5m trend must align with trade side (mandatory, cannot bypass)
  // NOTE: risk calc happens BEFORE HTF so that shadow trades can reuse the enriched candidate
  const tfBufs5m = internals.rsiBuffers.get(sym);
  const closes5m: number[] = tfBufs5m?.["5m"] ?? [];
  const htfResult = checkHtfGate(closes5m, candidate.side, config.rsiPeriod);

  if (!htfResult.permitted) {
    emitEvent(
      "ENTRY_BLOCKED_HTF",
      {
        symbol: sym,
        side: candidate.side,
        ema9_5m: htfResult.ema9_5m,
        ema20_5m: htfResult.ema20_5m,
        rsi5m: htfResult.rsi5m,
        reason: htfResult.reason,
      },
      "TRADES",
    );
    emitEvent(
      "AUTO_ENTRY_BLOCKED",
      { symbol: sym, reason: "ENTRY_BLOCKED_HTF", detail: htfResult.reason },
      "TRADES",
    );

    // ── SHADOW STATS: StageA+StageB+RiskCalc passed, but HTF blocked live entry ──
    // Create a shadow trade to simulate what would have happened without the HTF filter.
    // Real trade remains blocked. Shadow mode is 100% analytical only.
    let shadowTrade: ShadowTrade | null = null;
    if (config.enableShadowStats) {
      const alreadyShadowOpen = openShadowTrades.some(
        (st) => st.symbol === sym && st.status === "OPEN",
      );
      if (!alreadyShadowOpen) {
        shadowTrade = await openShadowTrade(enriched);
      }
    }

    return { trade: null, shadowTrade };
  }

  emitEvent(
    "HTF_GATE_PASS",
    {
      symbol: sym,
      side: candidate.side,
      ema9_5m: htfResult.ema9_5m,
      ema20_5m: htfResult.ema20_5m,
      rsi5m: htfResult.rsi5m,
    },
    "TRADES",
  );

  // 10) Open real trade
  const trade = await openTrade(enriched, config, openTrades, localRunId);

  if (internals.runId !== localRunId) {
    // Engine was stopped while we awaited — ghost trade guard
    emitEvent(
      "AUTO_ENTRY_BLOCKED",
      { symbol: sym, reason: "STALE_RUN_ID_POST_OPEN" },
      "TRADES",
    );
    return { trade: null, shadowTrade: null };
  }

  if (trade) {
    emitEvent(
      "AUTO_ENTRY_SUCCESS",
      {
        symbol: sym,
        side: candidate.side,
        entry: trade.entryPrice,
        sl: trade.sl,
        tp1: trade.tp1,
        tp2: trade.tp2,
        riskUSDT: trade.riskUSDT,
        qty: trade.qty,
        effectiveLeverage: trade.effectiveLeverage,
        runId: localRunId,
      },
      "TRADES",
    );
    callbacks.onTradesUpdate([...openTrades, trade]);
  }

  return { trade, shadowTrade: null };
}

async function runPollingLoop(
  internals: EngineInternals,
  config: ScannerConfig,
  callbacks: EngineCallbacks,
  initialOpenTrades: Trade[],
  initialShadowTrades: ShadowTrade[],
  localRunId: number,
): Promise<void> {
  const getCurrentRunId = () => internals.runId;
  let openTrades = initialOpenTrades;
  let shadowTrades = initialShadowTrades;

  // Run first cycle immediately
  const first = await runCycle(
    internals,
    config,
    callbacks,
    openTrades,
    shadowTrades,
    localRunId,
    getCurrentRunId,
  );
  openTrades = first.openTrades;
  shadowTrades = first.shadowTrades;
  if (getCurrentRunId() !== localRunId) return;

  // Schedule subsequent cycles
  const schedule = () => {
    internals.pollTimer = setTimeout(async () => {
      if (getCurrentRunId() !== localRunId) return;

      const result = await runCycle(
        internals,
        config,
        callbacks,
        openTrades,
        shadowTrades,
        localRunId,
        getCurrentRunId,
      );
      openTrades = result.openTrades;
      shadowTrades = result.shadowTrades;

      if (getCurrentRunId() === localRunId) {
        schedule();
      }
    }, config.pollInterval);
  };

  schedule();
}

const STAGEA_RESCUE_DELTA = 3;
const STAGEA_ZERO_THRESHOLD_CYCLES = 2;

async function runCycle(
  internals: EngineInternals,
  config: ScannerConfig,
  callbacks: EngineCallbacks,
  openTrades: Trade[],
  shadowTrades: ShadowTrade[],
  localRunId: number,
  getCurrentRunId: () => number,
): Promise<{ openTrades: Trade[]; shadowTrades: ShadowTrade[] }> {
  // NOTE: heartbeat tick is now in the separate setInterval — do NOT update tick here
  internals.cycleCount++;

  if (getCurrentRunId() !== localRunId) return { openTrades, shadowTrades };

  const isFullScan = internals.cycleCount % FULL_SCAN_INTERVAL_CYCLES === 1;

  if (isFullScan) {
    const universeResult = await buildUniverse(
      config,
      internals.universe,
      localRunId,
      getCurrentRunId,
    );
    if (getCurrentRunId() !== localRunId) return { openTrades, shadowTrades };
    internals.universe = universeResult.symbols;
    callbacks.onUniverseUpdate(
      universeResult.symbols.length,
      universeResult.eligibleCount,
      universeResult.filterLevelUsed,
      universeResult.retainedUsed,
    );

    await fetchIncrementalKlines(
      internals.universe.map((s) => s.symbol),
      internals.rsiBuffers,
      internals.rawKlineBuffers,
      config.rsiPeriod,
      localRunId,
      getCurrentRunId,
    );
  } else {
    const shortlistSymbols = [
      ...new Set([
        ...internals.lastStageALong.slice(0, 60).map((c) => c.symbol),
        ...internals.lastStageAShort.slice(0, 60).map((c) => c.symbol),
        ...openTrades.map((t) => t.symbol),
      ]),
    ];
    await fetchIncrementalKlines(
      shortlistSymbols,
      internals.rsiBuffers,
      internals.rawKlineBuffers,
      config.rsiPeriod,
      localRunId,
      getCurrentRunId,
    );
  }

  if (getCurrentRunId() !== localRunId) return { openTrades, shadowTrades };

  // Attach raw klines to rsiBuffers so finalScore can access them
  attachRawKlines(internals.rsiBuffers, internals.rawKlineBuffers);

  const regime = detectRegime(internals.rsiBuffers, config.rsiPeriod);
  callbacks.onRegimeUpdate(regime);

  const rescueMode = internals.rescueMode;
  const { long: stageALong, short: stageAShort } = runStageA(
    internals.universe,
    internals.rsiBuffers,
    config.rsiPeriod,
    rescueMode ? STAGEA_RESCUE_DELTA : 0,
  );
  internals.lastStageALong = stageALong;
  internals.lastStageAShort = stageAShort;

  emitEvent(
    "STAGE_A",
    {
      longCandidates: stageALong.length,
      shortCandidates: stageAShort.length,
    },
    "STAGE",
  );

  // Stage A zero rescue logic
  if (stageALong.length === 0 && stageAShort.length === 0) {
    internals.stageAZeroCounter++;
    emitEvent(
      "STAGEA_ZERO_DETECTED",
      { counter: internals.stageAZeroCounter },
      "STAGE",
    );
    if (internals.stageAZeroCounter >= STAGEA_ZERO_THRESHOLD_CYCLES) {
      internals.rescueMode = true;
      internals.stageAZeroCounter = 0;
      emitEvent(
        "STAGEA_RESCUE_APPLIED",
        { delta: STAGEA_RESCUE_DELTA },
        "STAGE",
      );
    }
  } else {
    internals.stageAZeroCounter = 0;
    if (rescueMode) {
      internals.rescueMode = false;
      emitEvent("STAGEA_RESCUE_END", {}, "STAGE");
    }
  }

  if (getCurrentRunId() !== localRunId) return { openTrades, shadowTrades };

  const stageBLong = runStageB(
    stageALong,
    "LONG",
    internals.rsiBuffers,
    config.rsiPeriod,
  );
  const stageBShort = runStageB(
    stageAShort,
    "SHORT",
    internals.rsiBuffers,
    config.rsiPeriod,
  );
  const passLong = stageBLong.filter((r) => r.passes).length;
  const passShort = stageBShort.filter((r) => r.passes).length;

  emitEvent(
    "STAGE_B",
    {
      passes: passLong + passShort,
      longPasses: passLong,
      shortPasses: passShort,
    },
    "STAGE",
  );

  if (getCurrentRunId() !== localRunId) return { openTrades, shadowTrades };

  const volumes = internals.universe.map((s) => s.quoteVolume);
  const medianVol = getMedianVolume(volumes);
  const top5Long = computeFinalScore(
    stageBLong,
    "LONG",
    config,
    medianVol,
    internals.rsiBuffers,
  );
  const top5Short = computeFinalScore(
    stageBShort,
    "SHORT",
    config,
    medianVol,
    internals.rsiBuffers,
  );

  emitEvent(
    "TOP5",
    {
      long: top5Long.length,
      short: top5Short.length,
      bestLong: top5Long[0]?.symbol ?? "-",
      bestShort: top5Short[0]?.symbol ?? "-",
    },
    "STAGE",
  );

  if (top5Long.length === 0 && top5Short.length === 0) {
    emitEvent("TOP5_EMPTY", { reason: "STAGEB_ZERO" }, "STAGE");
  }

  callbacks.onTop5Update(top5Long, top5Short);

  if (getCurrentRunId() !== localRunId) return { openTrades, shadowTrades };

  const currentPrices: Record<string, number> = {};
  for (const sym of internals.universe) {
    currentPrices[sym.symbol] = sym.lastPrice;
  }

  // ── POSITION MONITORING ─────────────────────────────────────────────────
  const updatedTrades = await updateTrades(
    openTrades,
    currentPrices,
    config,
    internals.cooldownMap,
  );
  const activeOpenTrades = updatedTrades.filter((t) => t.status !== "CLOSED");
  callbacks.onTradesUpdate(updatedTrades);

  // ── SHADOW POSITION MONITORING ──────────────────────────────────────────
  // Reuses same closed-candle prices — no additional Binance calls
  let runningShadowTrades = shadowTrades;
  if (config.enableShadowStats) {
    const updatedShadow = await updateShadowTrades(
      runningShadowTrades,
      currentPrices,
      config.timeStopMin,
    );
    runningShadowTrades = updatedShadow;
    callbacks.onShadowTradesUpdate(updatedShadow);
  }

  if (getCurrentRunId() !== localRunId)
    return { openTrades: activeOpenTrades, shadowTrades: runningShadowTrades };

  // ── AUTO-ENTRY GATE ──────────────────────────────────────────────────────
  // Collect all StageB-passing candidates from both sides
  const allCandidates: ScoredCandidate[] = [...top5Long, ...top5Short];
  let runningOpenTrades = [...activeOpenTrades];
  const openShadowList = runningShadowTrades.filter(
    (st) => st.status === "OPEN",
  );

  for (const candidate of allCandidates) {
    if (getCurrentRunId() !== localRunId) break;

    const result = await tryAutoEntry(
      candidate,
      internals,
      config,
      callbacks,
      runningOpenTrades,
      openShadowList,
      localRunId,
    );

    if (result.trade) {
      runningOpenTrades = [...runningOpenTrades, result.trade];
    }
    if (result.shadowTrade) {
      runningShadowTrades = [...runningShadowTrades, result.shadowTrade];
      openShadowList.push(result.shadowTrade);
      callbacks.onShadowTradesUpdate(runningShadowTrades);
    }
  }

  if (getCurrentRunId() !== localRunId)
    return {
      openTrades: runningOpenTrades,
      shadowTrades: runningShadowTrades,
    };

  const openIds = runningOpenTrades.map((t) => t.id);
  await idbPut("snapshots", { key: "openPositions", openIds });

  return { openTrades: runningOpenTrades, shadowTrades: runningShadowTrades };
}

// Minimal no-op callback for stop (only needs state change)
export type MinimalStopCallbacks = Pick<
  EngineCallbacks,
  "onStateChange" | "getState"
>;

export async function runEngineStop(
  internals: EngineInternals,
  callbacks: EngineCallbacks,
): Promise<void> {
  emitEvent("ENGINE_STOP_REQUEST", { runId: internals.runId }, "ENGINE");
  callbacks.onStateChange("STOPPING");

  stopTimers(internals);

  // Bump runId to cancel all ongoing async ops
  internals.runId++;

  await new Promise((resolve) => setTimeout(resolve, 100));

  emitEvent("ENGINE_STOPPED", { runId: internals.runId }, "ENGINE");
  callbacks.onStateChange("IDLE");
}
