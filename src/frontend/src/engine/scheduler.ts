import { idbPut } from "../journal/idb";
import { emitEvent } from "../journal/ledger";
import { type ShadowTrade, updateShadowTrades } from "../journal/shadowTrades";
import { openTrade, updateTrades } from "../journal/trades";
import type { Trade } from "../journal/trades";
import {
  type ScoredCandidate,
  computeFinalScore,
  getMedianVolume,
} from "../scanner/finalScore";
import { evaluateHtfGate } from "../scanner/htfGate";
import { type Regime, detectRegime } from "../scanner/regime";
import { computeLevels, computeRiskCalc } from "../scanner/riskCalc";
import { type StageACandidate, runStageA } from "../scanner/stageA";
import { runStageB } from "../scanner/stageB";
import { STAGE_A_K, type ScannerConfig } from "./config";
import { BASE_URL } from "./config";
import {
  HEARTBEAT_MS,
  STRUCTURAL_SL_CANDLES,
  UNIVERSE_REFRESH_MS,
} from "./constants";
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
  /** Independent 1s heartbeat timer */
  heartbeatTimer: ReturnType<typeof setInterval> | null;
  /** Poll cycle timer (scan only, no universe calls) */
  pollTimer: ReturnType<typeof setTimeout> | null;
  /** Universe refresh timer — separate from poll, runs every 90s */
  universeRefreshTimer: ReturnType<typeof setInterval> | null;
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
    universeRefreshTimer: null,
    stageAZeroCounter: 0,
    rescueMode: false,
    cooldownMap: new Map(),
    warmupCompleted: false,
  };
}

// ── Persistent scheduler state ────────────────────────────────────────────────
let intervalHandle: number | null = null;
let isTickRunning = false;

function stopTimers(internals: EngineInternals) {
  if (internals.heartbeatTimer !== null) {
    clearInterval(internals.heartbeatTimer);
    internals.heartbeatTimer = null;
  }
  if (internals.pollTimer !== null) {
    clearTimeout(internals.pollTimer);
    internals.pollTimer = null;
  }
  if (internals.universeRefreshTimer !== null) {
    clearInterval(internals.universeRefreshTimer);
    internals.universeRefreshTimer = null;
  }
}

function stopScheduler() {
  if (intervalHandle !== null) {
    clearInterval(intervalHandle);
    intervalHandle = null;
  }
  isTickRunning = false;
}

// ── Heartbeat — independent of fetch/scan cycle ───────────────────────────────
function startHeartbeat(
  internals: EngineInternals,
  callbacks: EngineCallbacks,
  localRunId: number,
) {
  if (internals.heartbeatTimer !== null) {
    clearInterval(internals.heartbeatTimer);
    internals.heartbeatTimer = null;
  }

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

// ── Universe refresh timer — 90s, independent of poll cycle ──────────────────
function startUniverseRefresh(
  internals: EngineInternals,
  config: ScannerConfig,
  callbacks: EngineCallbacks,
  localRunId: number,
) {
  if (internals.universeRefreshTimer !== null) {
    clearInterval(internals.universeRefreshTimer);
    internals.universeRefreshTimer = null;
  }

  internals.universeRefreshTimer = setInterval(async () => {
    if (internals.runId !== localRunId) {
      clearInterval(internals.universeRefreshTimer!);
      internals.universeRefreshTimer = null;
      return;
    }

    try {
      const result = await buildUniverse(
        config,
        internals.universe,
        localRunId,
        () => internals.runId,
      );
      if (internals.runId !== localRunId) return;
      internals.universe = result.symbols;
      callbacks.onUniverseUpdate(
        result.symbols.length,
        result.eligibleCount,
        result.filterLevelUsed,
        result.retainedUsed,
      );
    } catch {
      // fetch fail already handled and logged inside buildUniverse
    }
  }, UNIVERSE_REFRESH_MS);
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

    // 1) Independent heartbeat timer (1s, never depends on fetch)
    startHeartbeat(internals, callbacks, localRunId);

    // 2) Universe refresh timer (90s, ticker only, no exchangeInfo)
    startUniverseRefresh(internals, config, callbacks, localRunId);

    // 3) Poll cycle (scan only — StageA/B/score/trades, no universe calls)
    startScheduler(
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
 * HTF mode (OFF/SOFT/HARD) is applied upstream in runCycle before this.
 */
async function tryAutoEntry(
  candidate: ScoredCandidate,
  internals: EngineInternals,
  config: ScannerConfig,
  callbacks: EngineCallbacks,
  openTrades: Trade[],
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

  // 7) Re-compute risk calc with current price to ensure freshness (for qty/notional)
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

  // 7b) Compute SL/TP from manual leverage & SL% params (v1.0 — no klines needed)
  const leverageX = config.leverageX ?? 3;
  const slPct = config.slPct ?? 0.65;
  const rr = config.rr ?? 3.0;
  const enableTP1 = config.enableTP1 ?? false;
  const tp1RR = config.tp1RR ?? 1.0;
  const levels = computeLevels(
    candidate.entry,
    candidate.side,
    slPct,
    rr,
    enableTP1,
    tp1RR,
  );
  const realRiskPct = slPct * leverageX;

  if (!levels.valid) {
    emitEvent(
      "AUTO_ENTRY_BLOCKED",
      {
        symbol: sym,
        reason: "LEVELS_INVALID",
        detail: levels.rejectReason,
      },
      "TRADES",
    );
    return { trade: null, shadowTrade: null };
  }

  // 8) Build enriched candidate with fresh levels + risk sizing
  const enriched: ScoredCandidate = {
    ...candidate,
    // SL/TP from computeLevels (manual params — deterministic)
    sl: levels.slPrice,
    tp1: levels.tp1Price ?? levels.tp2Price,
    tp2: levels.tp2Price,
    tp1Price: levels.tp1Price,
    // Risk sizing for qty/notional display
    qty: riskResult.qty,
    riskUSDT: riskResult.riskUSDT,
    notionalUSDT: riskResult.notionalUSDT,
    effectiveLeverage: riskResult.effectiveLeverage,
    marginUsed: riskResult.marginUsed,
    riskCalcValid: levels.valid,
    // Risk & Leverage Controls
    leverageX,
    slPct,
    rr,
    realRiskPct,
  };

  // 9) Open real trade
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

function startScheduler(
  internals: EngineInternals,
  config: ScannerConfig,
  callbacks: EngineCallbacks,
  initialOpenTrades: Trade[],
  initialShadowTrades: ShadowTrade[],
  localRunId: number,
): void {
  const getCurrentRunId = () => internals.runId;

  // Mutable state captured in closure — updated after each cycle
  let openTrades = initialOpenTrades;
  let shadowTrades = initialShadowTrades;

  const safeTick = async () => {
    // Prevent overlapping cycles
    if (isTickRunning) return;
    isTickRunning = true;
    try {
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
    } catch (err) {
      const error = err as { message?: string; stack?: string } | null;
      emitEvent(
        "CYCLE_ERROR",
        {
          message: String(error?.message ?? err),
          stack: String(error?.stack ?? ""),
        },
        "ERROR",
      );
    } finally {
      isTickRunning = false;
    }
  };

  // Clear any pre-existing interval before starting
  stopScheduler();

  // Fire immediately, then on every pollInterval
  safeTick();
  intervalHandle = window.setInterval(safeTick, config.pollInterval);
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
  // NOTE: heartbeat tick is handled by independent setInterval — do NOT update it here.
  // NOTE: universe refresh is handled by its own 90s setInterval — do NOT call buildUniverse here.
  internals.cycleCount++;

  if (getCurrentRunId() !== localRunId) return { openTrades, shadowTrades };

  // Scan cycle: fetch incremental klines for shortlist + open trades only.
  // Full universe kline refresh uses the stage-A shortlist from the previous cycle.
  const shortlistSymbols = [
    ...new Set([
      ...internals.lastStageALong.slice(0, STAGE_A_K).map((c) => c.symbol),
      ...internals.lastStageAShort.slice(0, STAGE_A_K).map((c) => c.symbol),
      ...openTrades.map((t) => t.symbol),
    ]),
  ];

  // On first cycle shortlist is empty — fetch the full universe to seed buffers
  const fetchSymbols =
    shortlistSymbols.length > 0
      ? shortlistSymbols
      : internals.universe.map((s) => s.symbol);

  await fetchIncrementalKlines(
    fetchSymbols,
    internals.rsiBuffers,
    internals.rawKlineBuffers,
    config.rsiPeriod,
    localRunId,
    getCurrentRunId,
  );

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

  // ── HTF mode: OFF / SOFT / HARD ──────────────────────────────────────────
  // OFF  → skip entirely
  // SOFT → reduce score 10% on counter-trend bias (never blocks)
  // HARD → remove candidate from Top5 if opposing bias
  const htfMode = config.htfMode ?? "SOFT";

  if (htfMode !== "OFF") {
    const allCandidatesForHtf = [...top5Long, ...top5Short];
    const toRemove = new Set<string>();

    for (const candidate of allCandidatesForHtf) {
      const closes5m: number[] =
        internals.rsiBuffers.get(candidate.symbol)?.["5m"] ?? [];
      const htf = evaluateHtfGate(closes5m);

      const isOpposite =
        (candidate.side === "LONG" && htf.bias === "SHORT") ||
        (candidate.side === "SHORT" && htf.bias === "LONG");

      if (!isOpposite) continue;

      if (htfMode === "SOFT") {
        // Reduce score by 10% — entry is never blocked
        candidate.score = candidate.score * 0.9;
        emitEvent(
          "HTF_SOFT_BIAS",
          {
            symbol: candidate.side,
            side: candidate.side,
            bias: htf.bias,
            scoreMult: 0.9,
          },
          "STAGE",
        );
      } else if (htfMode === "HARD") {
        // Mark for removal — strict gate
        toRemove.add(`${candidate.symbol}:${candidate.side}`);
        emitEvent(
          "ENTRY_BLOCKED_HTF",
          {
            symbol: candidate.symbol,
            side: candidate.side,
            bias: htf.bias,
            emaFast: htf.emaFast,
            emaSlow: htf.emaSlow,
            rsi: htf.rsi,
          },
          "STAGE",
        );
      }
    }

    if (htfMode === "HARD" && toRemove.size > 0) {
      const filterFn = (c: ScoredCandidate) =>
        !toRemove.has(`${c.symbol}:${c.side}`);
      top5Long.splice(0, top5Long.length, ...top5Long.filter(filterFn));
      top5Short.splice(0, top5Short.length, ...top5Short.filter(filterFn));
    }
  }

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
  stopScheduler();

  // Bump runId to cancel all ongoing async ops
  internals.runId++;

  await new Promise((resolve) => setTimeout(resolve, 100));

  emitEvent("ENGINE_STOPPED", { runId: internals.runId }, "ENGINE");
  callbacks.onStateChange("IDLE");
}
