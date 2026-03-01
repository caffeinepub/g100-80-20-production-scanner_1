import type React from "react";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from "react";
import { idbGet, idbPut } from "../journal/idb";
import {
  type LedgerEvent,
  emitEvent,
  subscribeEvents,
} from "../journal/ledger";
import { type RRMetrics, computeRRMetrics } from "../journal/metrics30d";
import { rehydrate } from "../journal/rehydrate";
import {
  type ShadowMetrics,
  computeShadowMetrics,
} from "../journal/shadowMetrics";
import { type ShadowTrade, loadShadowTrades } from "../journal/shadowTrades";
import type { Trade } from "../journal/trades";
import type { ScoredCandidate } from "../scanner/finalScore";
import type { Regime } from "../scanner/regime";
import { DEFAULT_CONFIG, type ScannerConfig } from "./config";
import {
  type EngineInternals,
  type EngineState,
  createEngineInternals,
  runEngineStart,
  runEngineStop,
} from "./scheduler";
import { runSelfTest } from "./selfTest";

export interface EngineContextValue {
  config: ScannerConfig;
  setConfig: (c: ScannerConfig) => void;
  engineState: EngineState;
  universeCount: number;
  eligibleCount: number;
  filterLevelUsed: "20M" | "5M" | "1M" | null;
  retainedUsed: boolean;
  regime: Regime;
  tickCounter: number;
  lastTickTs: string;
  lastHeartbeatMs: number;
  top5Long: ScoredCandidate[];
  top5Short: ScoredCandidate[];
  warmupDone: number;
  warmupTotal: number;
  isWarmedUp: boolean;
  openTrades: Trade[];
  closedTrades: Trade[];
  events: LedgerEvent[];
  metrics: RRMetrics | null;
  wakeLockActive: boolean;
  // Shadow Stats — HTF_OFF simulation
  shadowTrades: ShadowTrade[];
  shadowMetrics: ShadowMetrics | null;
  start: () => void;
  stop: () => void;
  runSelfTest: () => Promise<void>;
  exportData: () => void;
  requestWakeLock: () => void;
}

const EngineContext = createContext<EngineContextValue | null>(null);

export function useEngine(): EngineContextValue {
  const ctx = useContext(EngineContext);
  if (!ctx) throw new Error("useEngine must be used within EngineProvider");
  return ctx;
}

export function EngineProvider({ children }: { children: React.ReactNode }) {
  const [config, setConfigState] = useState<ScannerConfig>(DEFAULT_CONFIG);
  const [engineState, setEngineState] = useState<EngineState>("IDLE");
  const [universeCount, setUniverseCount] = useState(0);
  const [eligibleCount, setEligibleCount] = useState(0);
  const [filterLevelUsed, setFilterLevelUsed] = useState<
    "20M" | "5M" | "1M" | null
  >(null);
  const [retainedUsed, setRetainedUsed] = useState(false);
  const [regime, setRegime] = useState<Regime>("NORMAL");
  const [tickCounter, setTickCounter] = useState(0);
  const [lastTickTs, setLastTickTs] = useState("--");
  const [lastHeartbeatMs, setLastHeartbeatMs] = useState(0);
  const [top5Long, setTop5Long] = useState<ScoredCandidate[]>([]);
  const [top5Short, setTop5Short] = useState<ScoredCandidate[]>([]);
  const [warmupDone, setWarmupDone] = useState(0);
  const [warmupTotal, setWarmupTotal] = useState(0);
  const [isWarmedUp, setIsWarmedUp] = useState(false);
  const [openTrades, setOpenTrades] = useState<Trade[]>([]);
  const [closedTrades, setClosedTrades] = useState<Trade[]>([]);
  const [events, setEvents] = useState<LedgerEvent[]>([]);
  const [metrics, setMetrics] = useState<RRMetrics | null>(null);
  const [wakeLockActive, setWakeLockActive] = useState(false);
  // Shadow Stats state
  const [shadowTrades, setShadowTrades] = useState<ShadowTrade[]>([]);
  const [shadowMetrics, setShadowMetrics] = useState<ShadowMetrics | null>(
    null,
  );

  const internals = useRef<EngineInternals>(createEngineInternals());
  const wakeLockRef = useRef<WakeLockSentinel | null>(null);
  const allTradesRef = useRef<Trade[]>([]);
  const shadowTradesRef = useRef<ShadowTrade[]>([]);
  const engineStateRef = useRef<EngineState>("IDLE");

  // Subscribe to ledger events
  useEffect(() => {
    const unsub = subscribeEvents(setEvents);
    return unsub;
  }, []);

  // Rehydrate on mount
  useEffect(() => {
    const init = async () => {
      // Load settings from IDB
      try {
        const savedSettings = await idbGet("settings", "settings");
        if (savedSettings && typeof savedSettings === "object") {
          setConfigState({
            ...DEFAULT_CONFIG,
            ...(savedSettings as Partial<ScannerConfig>),
          });
        }
      } catch {
        // use defaults
      }

      // Rehydrate trades
      const { openTrades: open, closedTrades: closed } = await rehydrate();
      setOpenTrades(open);
      setClosedTrades(closed);
      allTradesRef.current = [...open, ...closed];
      setMetrics(computeRRMetrics(closed));

      // Load shadow trades from IDB
      try {
        const loaded = await loadShadowTrades();
        setShadowTrades(loaded);
        shadowTradesRef.current = loaded;
        setShadowMetrics(computeShadowMetrics(loaded));
      } catch {
        // silently ignore — shadow stats are non-critical
      }
    };
    init();
  }, []);

  const setConfig = useCallback(async (c: ScannerConfig) => {
    setConfigState(c);
    await idbPut("settings", { key: "settings", ...c });
  }, []);

  const start = useCallback(() => {
    if (
      engineState === "INITIALIZING" ||
      engineState === "WARMING" ||
      engineState === "RUNNING"
    ) {
      emitEvent(
        "INIT_STEP",
        { step: "START_IGNORED", ok: false, ms: 0, details: { engineState } },
        "ENGINE",
      );
      return;
    }
    if (engineState !== "IDLE" && engineState !== "ERROR") return;

    const currentOpenTrades = openTrades;
    setIsWarmedUp(false);
    setWarmupDone(0);
    setWarmupTotal(0);

    const currentShadowTrades = shadowTradesRef.current;

    const callbacks = {
      onStateChange: (state: EngineState) => {
        engineStateRef.current = state;
        setEngineState(state);
      },
      getState: () => engineStateRef.current,
      onUniverseUpdate: (
        count: number,
        eligible: number,
        filterLevel: "20M" | "5M" | "1M" | null,
        retained?: boolean,
      ) => {
        setUniverseCount(count);
        setEligibleCount(eligible);
        setFilterLevelUsed(filterLevel);
        setRetainedUsed(retained ?? false);
      },
      onWarmupProgress: (done: number, total: number) => {
        setWarmupDone(done);
        setWarmupTotal(total);
      },
      onWarmupComplete: () => {
        setIsWarmedUp(true);
        setWarmupDone(internals.current.rsiBuffers.size);
        setWarmupTotal(internals.current.universe.length);
      },
      onTop5Update: (long: ScoredCandidate[], short: ScoredCandidate[]) => {
        setTop5Long(long);
        setTop5Short(short);
      },
      onRegimeUpdate: (r: Regime) => setRegime(r),
      onTickUpdate: (counter: number, ts: string, ms: number) => {
        setTickCounter(counter);
        setLastTickTs(ts);
        setLastHeartbeatMs(ms);
      },
      onTradesUpdate: (trades: Trade[]) => {
        const open = trades.filter((t) => t.status !== "CLOSED");
        const closed = [
          ...closedTrades,
          ...trades.filter((t) => t.status === "CLOSED"),
        ];
        const uniqueClosed = [
          ...new Map(closed.map((t) => [t.id, t])).values(),
        ];
        setOpenTrades(open);
        setClosedTrades(uniqueClosed);
        allTradesRef.current = [...open, ...uniqueClosed];
        setMetrics(computeRRMetrics(uniqueClosed));
      },
      onShadowTradesUpdate: (trades: ShadowTrade[]) => {
        shadowTradesRef.current = trades;
        setShadowTrades(trades);
        setShadowMetrics(computeShadowMetrics(trades));
      },
    };

    runEngineStart(
      internals.current,
      config,
      callbacks,
      currentOpenTrades,
      currentShadowTrades,
    ).catch((err) => {
      console.error("Engine start error:", err);
      setEngineState("ERROR");
    });
  }, [engineState, config, openTrades, closedTrades]);

  const stop = useCallback(() => {
    runEngineStop(internals.current, {
      onStateChange: (state: EngineState) => {
        engineStateRef.current = state;
        setEngineState(state);
      },
      getState: () => engineStateRef.current,
      onUniverseUpdate: () => {},
      onWarmupProgress: () => {},
      onWarmupComplete: () => {},
      onTop5Update: () => {},
      onRegimeUpdate: () => {},
      onTickUpdate: () => {},
      onTradesUpdate: () => {},
      onShadowTradesUpdate: () => {},
    });
  }, []);

  const handleSelfTest = useCallback(async () => {
    await runSelfTest();
  }, []);

  const exportData = useCallback(() => {
    const ts = new Date().toISOString().replace(/[:.]/g, "-");
    const payload = {
      exportTime: new Date().toISOString(),
      snapshot: {
        engineState,
        universeCount,
        regime,
      },
      trades: allTradesRef.current,
      shadowTrades: shadowTradesRef.current,
      events,
      metrics,
      shadowMetrics,
      settings: config,
    };

    const jsonBlob = new Blob([JSON.stringify(payload, null, 2)], {
      type: "application/json",
    });
    const jsonUrl = URL.createObjectURL(jsonBlob);
    const a = document.createElement("a");
    a.href = jsonUrl;
    a.download = `g100-export-${ts}.json`;
    a.click();
    URL.revokeObjectURL(jsonUrl);

    // CSV export
    const tradesCsv = [
      "id,symbol,side,entryPrice,exitPrice,sl,tp1,tp2,entryTime,exitTime,exitReason,status,r",
      ...allTradesRef.current.map(
        (t) =>
          `${t.id},${t.symbol},${t.side},${t.entryPrice},${t.exitPrice ?? ""},${t.sl},${t.tp1},${t.tp2},${t.entryTime},${t.exitTime ?? ""},${t.exitReason ?? ""},${t.status},${t.r ?? ""}`,
      ),
    ].join("\n");

    const csvBlob = new Blob([tradesCsv], { type: "text/csv" });
    const csvUrl = URL.createObjectURL(csvBlob);
    const b = document.createElement("a");
    b.href = csvUrl;
    b.download = `g100-trades-${ts}.csv`;
    b.click();
    URL.revokeObjectURL(csvUrl);
  }, [
    engineState,
    universeCount,
    regime,
    events,
    metrics,
    shadowMetrics,
    config,
  ]);

  const requestWakeLock = useCallback(async () => {
    if (!("wakeLock" in navigator)) {
      return;
    }
    try {
      if (wakeLockRef.current) {
        await wakeLockRef.current.release();
        wakeLockRef.current = null;
        setWakeLockActive(false);
      } else {
        wakeLockRef.current = await (
          navigator as Navigator & {
            wakeLock: { request: (type: string) => Promise<WakeLockSentinel> };
          }
        ).wakeLock.request("screen");
        setWakeLockActive(true);
        wakeLockRef.current.addEventListener("release", () => {
          setWakeLockActive(false);
          wakeLockRef.current = null;
        });
      }
    } catch {
      setWakeLockActive(false);
    }
  }, []);

  const value: EngineContextValue = {
    config,
    setConfig,
    engineState,
    universeCount,
    eligibleCount,
    filterLevelUsed,
    retainedUsed,
    regime,
    tickCounter,
    lastTickTs,
    lastHeartbeatMs,
    top5Long,
    top5Short,
    warmupDone,
    warmupTotal,
    isWarmedUp,
    openTrades,
    closedTrades,
    events,
    metrics,
    wakeLockActive,
    shadowTrades,
    shadowMetrics,
    start,
    stop,
    runSelfTest: handleSelfTest,
    exportData,
    requestWakeLock,
  };

  return (
    <EngineContext.Provider value={value}>{children}</EngineContext.Provider>
  );
}
