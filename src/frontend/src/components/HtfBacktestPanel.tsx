/**
 * HtfBacktestPanel.tsx — HTF 4W Backtest UI
 *
 * Standalone component with its own state — does NOT use EngineContext.
 * Stores results in htf_backtest_results IDB store (separate from live data).
 *
 * ADDITIVE ONLY — no live engine interaction.
 */

import { useEffect, useRef, useState } from "react";
import { type BacktestProgress, runHtfBacktest } from "../backtest/htfBacktest";
import {
  type HtfBacktestResult,
  type HtfGroupMetrics,
  loadHtfBacktestResult,
  saveHtfBacktestResult,
} from "../backtest/htfBacktestStore";

// ── Helpers ───────────────────────────────────────────────────────────────────

function fmt(n: number, decimals = 2): string {
  return Number.isFinite(n) ? n.toFixed(decimals) : "—";
}

function fmtR(n: number): string {
  if (!Number.isFinite(n)) return "—";
  return `${n >= 0 ? "+" : ""}${n.toFixed(2)}R`;
}

function colorR(n: number): string {
  if (!Number.isFinite(n)) return "text-muted-foreground";
  return n > 0 ? "text-long" : n < 0 ? "text-short" : "text-muted-foreground";
}

function colorWr(n: number): string {
  return n >= 50 ? "text-long" : n > 40 ? "text-warn" : "text-short";
}

function fmtDuration(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rem = s % 60;
  return `${m}m ${rem}s`;
}

function fmtDate(ts: number): string {
  return new Date(ts).toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

// ── Top symbols subcomponent ──────────────────────────────────────────────────

function TopSymbols({
  dist,
  limit = 5,
}: {
  dist: Record<string, number>;
  limit?: number;
}) {
  const sorted = Object.entries(dist)
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit);

  if (sorted.length === 0) {
    return (
      <div className="font-mono text-[9px] text-muted-foreground/50 text-center py-1">
        no data
      </div>
    );
  }

  const max = sorted[0][1];

  return (
    <div className="space-y-0.5">
      {sorted.map(([sym, count]) => (
        <div key={sym} className="flex items-center gap-1.5">
          <div className="w-16 shrink-0 font-mono text-[9px] text-foreground truncate">
            {sym.replace("USDT", "")}
          </div>
          <div className="flex-1 h-1 bg-surface-1 rounded-full overflow-hidden">
            <div
              className="h-full bg-info/60 rounded-full"
              style={{ width: `${(count / max) * 100}%` }}
            />
          </div>
          <div className="w-6 font-mono text-[9px] text-muted-foreground text-right tabular-nums">
            {count}
          </div>
        </div>
      ))}
    </div>
  );
}

// ── Top hours subcomponent ────────────────────────────────────────────────────

function TopHours({ dist }: { dist: Record<number, number> }) {
  const sorted = Object.entries(dist)
    .map(([h, c]) => [Number(h), c] as [number, number])
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3);

  if (sorted.length === 0) {
    return <span className="text-muted-foreground/50">—</span>;
  }

  return (
    <span className="font-mono text-[9px] text-muted-foreground tabular-nums">
      {sorted.map(([h]) => `${String(h).padStart(2, "0")}:00`).join(" · ")}
    </span>
  );
}

// ── Metric row ────────────────────────────────────────────────────────────────

function MRow({
  label,
  value,
  color,
}: {
  label: string;
  value: string;
  color?: string;
}) {
  return (
    <div className="flex justify-between items-center py-1 border-b border-border/20 last:border-b-0">
      <span className="font-mono text-[9px] text-muted-foreground">
        {label}
      </span>
      <span
        className={`font-mono text-[10px] font-bold tabular-nums ${color ?? "text-foreground"}`}
      >
        {value}
      </span>
    </div>
  );
}

// ── Group column ──────────────────────────────────────────────────────────────

type GroupKey = "htfOn" | "htfBlocked" | "baseline";

interface GroupColumnProps {
  title: string;
  badge: string;
  badgeColor: string;
  metrics: HtfGroupMetrics;
  accent: string;
}

function GroupColumn({
  title,
  badge,
  badgeColor,
  metrics,
  accent,
}: GroupColumnProps) {
  const [showSymbols, setShowSymbols] = useState(false);

  return (
    <div className="bg-surface-2 border border-border/60 rounded overflow-hidden flex flex-col">
      {/* Column header */}
      <div
        className="px-2 py-1.5 border-b border-border/40 flex items-center gap-1.5"
        style={{ borderTopWidth: "2px", borderTopColor: `var(${accent})` }}
      >
        <span className="font-mono text-[9px] font-bold text-foreground tracking-wider">
          {title}
        </span>
        <span
          className={`font-mono text-[7px] px-1.5 py-0.5 rounded border ${badgeColor}`}
        >
          {badge}
        </span>
      </div>

      {/* Metrics */}
      <div className="px-2 py-1 flex-1">
        <MRow label="TRADES" value={metrics.totalTrades.toString()} />
        <MRow
          label="WINRATE"
          value={`${fmt(metrics.winrate, 1)}%`}
          color={colorWr(metrics.winrate)}
        />
        <MRow
          label="AVG R"
          value={fmtR(metrics.avgR)}
          color={colorR(metrics.avgR)}
        />
        <MRow
          label="NET R"
          value={fmtR(metrics.netR)}
          color={colorR(metrics.netR)}
        />
        <MRow
          label="EXPECT"
          value={fmtR(metrics.expectancy)}
          color={colorR(metrics.expectancy)}
        />
        <MRow
          label="MAX DD"
          value={`-${fmt(metrics.maxDrawdownR)}R`}
          color={
            metrics.maxDrawdownR > 5
              ? "text-short"
              : metrics.maxDrawdownR > 2
                ? "text-warn"
                : "text-muted-foreground"
          }
        />
        <MRow label="TRADES/DAY" value={fmt(metrics.tradesPerDay, 1)} />
      </div>

      {/* Top symbols toggle */}
      <div className="border-t border-border/30 px-2 py-1">
        <button
          type="button"
          onClick={() => setShowSymbols((v) => !v)}
          className="font-mono text-[8px] text-muted-foreground hover:text-foreground transition-colors w-full text-left flex items-center justify-between"
        >
          <span>TOP SYMBOLS</span>
          <span>{showSymbols ? "▲" : "▼"}</span>
        </button>
        {showSymbols && (
          <div className="mt-1.5">
            <TopSymbols dist={metrics.symbolDistribution} />
          </div>
        )}
      </div>

      {/* Top hours */}
      <div className="border-t border-border/30 px-2 py-1.5">
        <div className="font-mono text-[8px] text-muted-foreground mb-0.5">
          TOP HOURS (UTC)
        </div>
        <TopHours dist={metrics.hourDistribution} />
      </div>
    </div>
  );
}

// ── Progress bar ──────────────────────────────────────────────────────────────

function ProgressBar({
  progress,
  onCancel,
}: {
  progress: BacktestProgress;
  onCancel: () => void;
}) {
  const phaseLabel: Record<BacktestProgress["phase"], string> = {
    universe: "UNIVERSE",
    fetching: "FETCHING",
    replaying: "REPLAY",
    done: "DONE",
    error: "ERROR",
  };

  return (
    <div className="bg-surface-2 border border-border/60 rounded p-3 space-y-2">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className="font-mono text-[8px] font-bold text-warn tracking-widest animate-pulse">
            ● {phaseLabel[progress.phase]}
          </span>
          <span className="font-mono text-[9px] text-muted-foreground">
            {progress.pct}%
          </span>
        </div>
        <button
          type="button"
          onClick={onCancel}
          className="font-mono text-[8px] text-short border border-short/40 px-2 py-0.5 rounded hover:bg-short/10 transition-colors"
        >
          CANCEL
        </button>
      </div>

      {/* Progress track */}
      <div className="h-1.5 bg-surface-1 rounded-full overflow-hidden">
        <div
          className="h-full bg-warn rounded-full transition-all duration-300"
          style={{ width: `${progress.pct}%` }}
        />
      </div>

      <div className="font-mono text-[9px] text-muted-foreground truncate">
        {progress.message}
      </div>

      {progress.symbolsTotal > 0 && (
        <div className="font-mono text-[8px] text-muted-foreground/60">
          {progress.symbolsDone} / {progress.symbolsTotal} symbols
        </div>
      )}
    </div>
  );
}

// ── Main panel ────────────────────────────────────────────────────────────────

const GROUP_CONFIG: Record<
  GroupKey,
  { title: string; badge: string; badgeColor: string; accent: string }
> = {
  htfOn: {
    title: "STRICT",
    badge: "HTF ON",
    badgeColor: "bg-long/10 text-long border-long/40",
    accent: "--color-long",
  },
  htfBlocked: {
    title: "BLOCKED",
    badge: "HTF OFF",
    badgeColor: "bg-short/10 text-short border-short/40",
    accent: "--color-short",
  },
  baseline: {
    title: "BASELINE",
    badge: "ALL",
    badgeColor: "bg-info/10 text-info border-info/40",
    accent: "--color-info",
  },
};

export function HtfBacktestPanel() {
  const [result, setResult] = useState<HtfBacktestResult | null>(null);
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState<BacktestProgress | null>(null);
  const [error, setError] = useState<string | null>(null);

  // cancelRef: plain object (NOT React ref) for synchronous mutation inside async
  const cancelRef = useRef<{ cancelled: boolean }>({ cancelled: false });

  // Load saved result on mount
  useEffect(() => {
    loadHtfBacktestResult()
      .then((r) => {
        if (r) setResult(r);
      })
      .catch(() => {
        // silently ignore — IDB unavailable
      });
  }, []);

  const handleRun = async () => {
    if (running) return;
    setRunning(true);
    setError(null);
    cancelRef.current = { cancelled: false };

    try {
      const r = await runHtfBacktest(
        setProgress,
        cancelRef.current,
        27, // rsiPeriod — matches live engine default
      );
      await saveHtfBacktestResult(r);
      setResult(r);
      setProgress(null);
    } catch (err) {
      const msg = (err as Error).message;
      if (msg === "CANCELLED") {
        setProgress(null);
      } else {
        setError(msg);
        setProgress({
          phase: "error",
          symbolsDone: 0,
          symbolsTotal: 0,
          pct: 0,
          message: msg,
        });
      }
    } finally {
      setRunning(false);
    }
  };

  const handleCancel = () => {
    cancelRef.current.cancelled = true;
  };

  // ── Render ──────────────────────────────────────────────────────────────────

  return (
    <div className="bg-surface-1 border border-border/60 rounded overflow-hidden">
      {/* Panel header */}
      <div className="flex items-center justify-between px-3 py-2 bg-surface-2 border-b border-border/50">
        <div className="flex items-center gap-2">
          <span className="font-mono text-[9px] text-muted-foreground tracking-widest">
            HTF BACKTEST RESULTS
          </span>
          <span className="font-mono text-[7px] bg-warn/10 text-warn px-1.5 py-0.5 rounded border border-warn/30">
            28D REPLAY
          </span>
        </div>
        {result && (
          <span className="font-mono text-[8px] text-muted-foreground/60">
            {fmtDate(result.runAt)}
          </span>
        )}
      </div>

      {/* Body */}
      <div className="p-3 space-y-3">
        {/* Run button */}
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={handleRun}
            disabled={running}
            className="font-mono text-[9px] font-bold px-4 py-2 rounded border border-warn/60 text-warn hover:bg-warn/10 transition-all disabled:opacity-40 disabled:cursor-not-allowed tracking-widest"
          >
            {running ? "● RUNNING..." : "▶ RUN HTF 4W BACKTEST"}
          </button>
          {result && !running && (
            <span className="font-mono text-[8px] text-muted-foreground/60">
              {result.symbolsProcessed} syms · {result.totalSignals} signals ·{" "}
              {fmtDuration(result.durationMs)}
            </span>
          )}
        </div>

        {/* Progress */}
        {running && progress && (
          <ProgressBar progress={progress} onCancel={handleCancel} />
        )}

        {/* Error state */}
        {error && !running && (
          <div className="bg-surface-2 border border-short/40 rounded p-3 flex items-center justify-between gap-3">
            <div className="font-mono text-[9px] text-short truncate">
              ✗ {error}
            </div>
            <button
              type="button"
              onClick={handleRun}
              className="font-mono text-[8px] text-warn border border-warn/40 px-2 py-0.5 rounded hover:bg-warn/10 transition-colors shrink-0"
            >
              RETRY
            </button>
          </div>
        )}

        {/* Results grid */}
        {result && !running && (
          <>
            {/* Summary bar */}
            <div className="flex items-center gap-4 px-1">
              {(["htfOn", "htfBlocked", "baseline"] as GroupKey[]).map((k) => {
                const m = result[k];
                const cfg = GROUP_CONFIG[k];
                return (
                  <div key={k} className="flex items-center gap-1.5">
                    <span
                      className={`font-mono text-[7px] px-1 py-0.5 rounded border ${cfg.badgeColor}`}
                    >
                      {cfg.badge}
                    </span>
                    <span
                      className={`font-mono text-[10px] font-bold tabular-nums ${colorR(m.netR)}`}
                    >
                      {fmtR(m.netR)}
                    </span>
                    <span className="font-mono text-[8px] text-muted-foreground/60">
                      net · {m.totalTrades}T
                    </span>
                  </div>
                );
              })}
            </div>

            {/* 3-column grid */}
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
              {(["htfOn", "htfBlocked", "baseline"] as GroupKey[]).map((k) => {
                const cfg = GROUP_CONFIG[k];
                return (
                  <GroupColumn
                    key={k}
                    title={cfg.title}
                    badge={cfg.badge}
                    badgeColor={cfg.badgeColor}
                    metrics={result[k]}
                    accent={cfg.accent}
                  />
                );
              })}
            </div>

            {/* Comparison footer */}
            <div className="bg-surface-2 border border-border/40 rounded p-2.5 space-y-1.5">
              <div className="font-mono text-[8px] text-muted-foreground tracking-widest mb-1">
                NET R COMPARISON (28D)
              </div>
              <div className="grid grid-cols-3 gap-2">
                {(["htfOn", "htfBlocked", "baseline"] as GroupKey[]).map(
                  (k) => {
                    const m = result[k];
                    const cfg = GROUP_CONFIG[k];
                    return (
                      <div key={k} className="text-center">
                        <div
                          className={`font-mono text-[7px] px-1 py-0.5 rounded border inline-block mb-1 ${cfg.badgeColor}`}
                        >
                          {cfg.badge}
                        </div>
                        <div
                          className={`font-mono text-sm font-bold tabular-nums ${colorR(m.netR)}`}
                        >
                          {fmtR(m.netR)}
                        </div>
                        <div className="font-mono text-[8px] text-muted-foreground/60">
                          {fmt(m.winrate, 1)}% WR
                        </div>
                      </div>
                    );
                  },
                )}
              </div>

              {/* HTF filter delta */}
              {result.baseline.totalTrades > 0 && (
                <div className="border-t border-border/30 pt-1.5 font-mono text-[8px] text-muted-foreground/70">
                  HTF filter retains{" "}
                  <span className="text-foreground font-bold">
                    {fmt(
                      (result.htfOn.totalTrades / result.baseline.totalTrades) *
                        100,
                      1,
                    )}
                    %
                  </span>{" "}
                  of signals · Net R delta:{" "}
                  <span
                    className={`font-bold ${colorR(result.htfOn.netR - result.htfBlocked.netR)}`}
                  >
                    {fmtR(result.htfOn.netR - result.htfBlocked.netR)}
                  </span>
                </div>
              )}
            </div>
          </>
        )}

        {/* Empty state — no result yet */}
        {!result && !running && !error && (
          <div className="py-6 text-center">
            <div className="font-mono text-[10px] text-muted-foreground/50">
              No backtest data
            </div>
            <div className="font-mono text-[9px] text-muted-foreground/30 mt-1">
              Run to measure HTF filter effectiveness over 28 days
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
