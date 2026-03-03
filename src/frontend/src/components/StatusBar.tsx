import type { HtfMode } from "../engine/config";
import { useEngine } from "../engine/engineContext";
import type { EngineState } from "../engine/scheduler";
import type { Regime } from "../scanner/regime";

function engineStateBadge(state: EngineState) {
  const colors: Record<EngineState, string> = {
    IDLE: "text-muted-foreground border-border",
    INITIALIZING: "text-warn border-warn",
    WARMING: "text-warn border-warn",
    RUNNING: "text-long border-long",
    STOPPING: "text-muted-foreground border-border",
    ERROR: "text-short border-short",
  };
  return colors[state] ?? "text-muted-foreground border-border";
}

function regimeBadge(regime: Regime) {
  if (regime === "EXTREME_UP") return "text-long border-long";
  if (regime === "EXTREME_DOWN") return "text-short border-short";
  return "text-muted-foreground border-border";
}

function htfModeBadgeClass(mode: HtfMode) {
  if (mode === "HARD") return "border-short text-short";
  if (mode === "SOFT") return "border-warn text-warn";
  return "border-border text-muted-foreground";
}

export function StatusBar() {
  const {
    engineState,
    universeCount,
    eligibleCount,
    lastTickTs,
    regime,
    filterLevelUsed,
    retainedUsed,
    lastHeartbeatMs,
    config,
    wakeLockActive,
    requestWakeLock,
    start,
  } = useEngine();

  const htfMode = config.htfMode ?? "SOFT";

  const now = Date.now();
  const sleepRisk =
    lastHeartbeatMs > 0 && now - lastHeartbeatMs > 2 * config.pollInterval;
  const wakeLockSupported = "wakeLock" in navigator;

  return (
    <div className="flex-shrink-0 border-b border-border bg-surface-1 px-2 py-1.5 space-y-1">
      {/* Row 1: Engine status + counters */}
      <div className="flex items-center gap-2 flex-wrap">
        <span
          className={`font-mono text-[10px] font-bold border rounded px-1.5 py-0.5 ${engineStateBadge(engineState)}`}
        >
          {engineState}
        </span>

        <span className="font-mono text-[10px] text-muted-foreground">
          <span className="text-foreground/50 mr-0.5">UNI</span>
          <span className="text-foreground">{universeCount}</span>
        </span>

        <span className="font-mono text-[10px] text-muted-foreground">
          <span className="text-foreground/50 mr-0.5">ELIG</span>
          <span className="text-foreground">{eligibleCount}</span>
        </span>

        <span className="font-mono text-[10px] text-muted-foreground">
          <span className="text-foreground/50 mr-0.5">TICK</span>
          <span
            className={
              engineState === "RUNNING" ? "text-long" : "text-muted-foreground"
            }
          >
            {engineState === "RUNNING" ? lastTickTs : "--"}
          </span>
        </span>

        <span
          className={`font-mono text-[10px] border rounded px-1 py-0.5 ${regimeBadge(regime)}`}
        >
          {regime}
        </span>

        {filterLevelUsed && filterLevelUsed !== "20M" && (
          <span className="font-mono text-[10px] border border-warn text-warn rounded px-1 py-0.5">
            FLOOR:{filterLevelUsed}
          </span>
        )}

        {retainedUsed && (
          <span className="font-mono text-[10px] border border-warn text-warn rounded px-1 py-0.5">
            UNIVERSE RETAINED
          </span>
        )}

        <span
          className={`font-mono text-[10px] border rounded px-1 py-0.5 ${htfModeBadgeClass(htfMode)}`}
        >
          HTF:{htfMode}
        </span>

        {sleepRisk && (
          <span className="font-mono text-[10px] text-short animate-pulse">
            ⚠ SLEEP RISK
          </span>
        )}

        {engineState === "ERROR" && (
          <button
            type="button"
            onClick={start}
            className="font-mono text-[10px] border border-short text-short rounded px-1.5 py-0.5 hover:bg-short/10 transition-colors"
          >
            RETRY INIT
          </button>
        )}
      </div>

      {/* Row 2: Warnings + Wake Lock */}
      <div className="flex items-center justify-between gap-2">
        <span className="text-[9px] text-muted-foreground font-mono">
          ⚠ Foreground Only — background may sleep
        </span>

        <button
          type="button"
          onClick={requestWakeLock}
          disabled={!wakeLockSupported}
          className={`font-mono text-[9px] border rounded px-1.5 py-0.5 transition-colors ${
            !wakeLockSupported
              ? "border-border text-muted-foreground cursor-not-allowed"
              : wakeLockActive
                ? "border-long text-long"
                : "border-border text-muted-foreground hover:border-foreground/30 hover:text-foreground"
          }`}
        >
          {!wakeLockSupported
            ? "NO WAKE LOCK"
            : wakeLockActive
              ? "● AWAKE"
              : "KEEP AWAKE"}
        </button>
      </div>
    </div>
  );
}
