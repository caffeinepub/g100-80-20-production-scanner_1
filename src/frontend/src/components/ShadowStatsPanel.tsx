/**
 * SHADOW STATS (HTF OFF) Panel
 * Shows parallel simulation metrics for trades that were blocked by the HTF EMA filter.
 * Purely analytical — no real trading impact.
 */

import { useEngine } from "../engine/engineContext";

function ShadowMetricRow({
  label,
  value,
  color,
}: { label: string; value: string; color?: string }) {
  return (
    <div className="flex justify-between items-center py-1.5 border-b border-border/30 last:border-b-0">
      <span className="font-mono text-[10px] text-muted-foreground">
        {label}
      </span>
      <span
        className={`font-mono text-[11px] font-bold tabular-nums ${color ?? "text-foreground"}`}
      >
        {value}
      </span>
    </div>
  );
}

export function ShadowStatsPanel() {
  const { shadowMetrics, shadowTrades, metrics, config } = useEngine();

  if (!config.enableShadowStats) return null;

  const openCount = shadowTrades.filter((t) => t.status === "OPEN").length;
  const closedCount = shadowTrades.filter((t) => t.status === "CLOSED").length;

  const hasData = shadowMetrics && shadowMetrics.totalTrades > 0;

  // Comparison row: strict net R (real trades) vs shadow net R
  const strictNetR = metrics
    ? metrics.avgRRRealized * metrics.totalTrades
    : null;
  const shadowNetR = shadowMetrics ? shadowMetrics.netR : null;

  return (
    <div className="bg-surface-1 border border-border/60 rounded space-y-0 overflow-hidden">
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-2 bg-surface-2 border-b border-border/50">
        <div className="flex items-center gap-2">
          <span className="font-mono text-[9px] text-muted-foreground tracking-widest">
            SHADOW STATS
          </span>
          <span className="font-mono text-[8px] bg-warn/20 text-warn px-1.5 py-0.5 rounded border border-warn/30">
            HTF OFF
          </span>
        </div>
        <div className="font-mono text-[9px] text-muted-foreground">
          {openCount > 0 && (
            <span className="text-long mr-2">{openCount} open</span>
          )}
          {closedCount > 0 && (
            <span className="text-muted-foreground">{closedCount} closed</span>
          )}
          {openCount === 0 && closedCount === 0 && (
            <span className="opacity-50">no data</span>
          )}
        </div>
      </div>

      {!hasData ? (
        <div className="px-3 py-4 font-mono text-[10px] text-muted-foreground/50 text-center">
          Shadow trades appear when HTF filter blocks an entry
        </div>
      ) : (
        <div className="px-3 py-1">
          <ShadowMetricRow
            label="Total Shadow Trades"
            value={shadowMetrics.totalTrades.toString()}
          />
          <ShadowMetricRow
            label="Winrate %"
            value={`${shadowMetrics.winRate.toFixed(1)}%`}
            color={
              shadowMetrics.winRate >= 50
                ? "text-long"
                : "text-muted-foreground"
            }
          />
          <ShadowMetricRow
            label="Avg R"
            value={`${shadowMetrics.avgR >= 0 ? "+" : ""}${shadowMetrics.avgR.toFixed(2)}R`}
            color={shadowMetrics.avgR > 0 ? "text-long" : "text-short"}
          />
          <ShadowMetricRow
            label="Net R"
            value={`${shadowMetrics.netR >= 0 ? "+" : ""}${shadowMetrics.netR.toFixed(2)}R`}
            color={shadowMetrics.netR > 0 ? "text-long" : "text-short"}
          />
          <ShadowMetricRow
            label="Max DD"
            value={`-${shadowMetrics.maxDrawdownR.toFixed(2)}R`}
            color={
              shadowMetrics.maxDrawdownR > 2
                ? "text-short"
                : "text-muted-foreground"
            }
          />
          <ShadowMetricRow
            label="TP1 %"
            value={`${shadowMetrics.tp1HitRate.toFixed(1)}%`}
            color={
              shadowMetrics.tp1HitRate >= 50
                ? "text-long"
                : "text-muted-foreground"
            }
          />
          <ShadowMetricRow
            label="TP2 %"
            value={`${shadowMetrics.tp2HitRate.toFixed(1)}%`}
            color={
              shadowMetrics.tp2HitRate >= 40
                ? "text-long"
                : "text-muted-foreground"
            }
          />
        </div>
      )}

      {/* Comparison row: STRICT vs SHADOW Net R */}
      {(strictNetR !== null || shadowNetR !== null) && (
        <div className="border-t border-border/50 px-3 py-2 bg-surface-2/50">
          <div className="font-mono text-[9px] text-muted-foreground tracking-widest mb-1.5">
            NET R COMPARISON
          </div>
          <div className="flex gap-2">
            <div className="flex-1 text-center">
              <div className="font-mono text-[8px] text-muted-foreground mb-0.5">
                STRICT (HTF ON)
              </div>
              <div
                className={`font-mono text-[11px] font-bold tabular-nums ${
                  strictNetR !== null && strictNetR >= 0
                    ? "text-long"
                    : "text-short"
                }`}
              >
                {strictNetR !== null
                  ? `${strictNetR >= 0 ? "+" : ""}${strictNetR.toFixed(2)}R`
                  : "--"}
              </div>
            </div>
            <div className="w-px bg-border/50" />
            <div className="flex-1 text-center">
              <div className="font-mono text-[8px] text-muted-foreground mb-0.5">
                SHADOW (HTF OFF)
              </div>
              <div
                className={`font-mono text-[11px] font-bold tabular-nums ${
                  shadowNetR !== null && shadowNetR >= 0
                    ? "text-long"
                    : "text-short"
                }`}
              >
                {shadowNetR !== null
                  ? `${shadowNetR >= 0 ? "+" : ""}${shadowNetR.toFixed(2)}R`
                  : "--"}
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
