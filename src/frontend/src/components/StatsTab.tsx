import { useEngine } from "../engine/engineContext";
import { ShadowStatsPanel } from "./ShadowStatsPanel";

function MetricCard({
  label,
  value,
  sub,
  color,
}: { label: string; value: string; sub?: string; color?: string }) {
  return (
    <div className="bg-surface-2 border border-border rounded p-3">
      <div className="font-mono text-[9px] text-muted-foreground tracking-widest mb-1">
        {label}
      </div>
      <div
        className={`font-mono text-lg font-bold ${color ?? "text-foreground"}`}
      >
        {value}
      </div>
      {sub && (
        <div className="font-mono text-[9px] text-muted-foreground mt-0.5">
          {sub}
        </div>
      )}
    </div>
  );
}

export function StatsTab() {
  const { metrics, closedTrades } = useEngine();

  if (!metrics || metrics.totalTrades === 0) {
    return (
      <div className="h-full overflow-y-auto touch-scroll p-3 space-y-4">
        <div className="flex items-center justify-center py-8">
          <div className="text-center space-y-2">
            <div className="font-mono text-sm text-muted-foreground">
              No closed trades yet
            </div>
            <div className="font-mono text-[10px] text-muted-foreground/50">
              RR metrics appear after first trade closes
            </div>
          </div>
        </div>
        <ShadowStatsPanel />
      </div>
    );
  }

  const tp2Color =
    metrics.tp2HitRate >= 50 ? "text-long" : "text-muted-foreground";
  const tp1Color =
    metrics.tp1HitRate >= 50 ? "text-long" : "text-muted-foreground";
  const slColor =
    metrics.slHitRate > 60 ? "text-short" : "text-muted-foreground";
  const rrColor = metrics.avgRRRealized > 0 ? "text-long" : "text-short";
  const expColor = metrics.expectancy > 0 ? "text-long" : "text-short";

  return (
    <div className="h-full overflow-y-auto touch-scroll p-3 space-y-4">
      <div className="font-mono text-[9px] text-muted-foreground tracking-widest">
        RR ENGINE STATS — 30D ({metrics.totalTrades} trades ·{" "}
        {closedTrades.length} total)
      </div>

      <div className="grid grid-cols-2 gap-2">
        <MetricCard
          label="TOTAL TRADES"
          value={metrics.totalTrades.toString()}
        />
        <MetricCard
          label="EXPECTANCY"
          value={`${metrics.expectancy >= 0 ? "+" : ""}${metrics.expectancy.toFixed(3)}R`}
          sub="E = (WR×AvgW) − (LR×AvgL)"
          color={expColor}
        />
        <MetricCard
          label="TP1 HIT RATE"
          value={`${metrics.tp1HitRate.toFixed(1)}%`}
          sub="% trades reaching TP1"
          color={tp1Color}
        />
        <MetricCard
          label="TP2 HIT RATE"
          value={`${metrics.tp2HitRate.toFixed(1)}%`}
          sub="% trades reaching TP2"
          color={tp2Color}
        />
        <MetricCard
          label="SL HIT RATE"
          value={`${metrics.slHitRate.toFixed(1)}%`}
          sub="% trades stopped out"
          color={slColor}
        />
        <MetricCard
          label="AVG RR REALIZED"
          value={`${metrics.avgRRRealized >= 0 ? "+" : ""}${metrics.avgRRRealized.toFixed(2)}R`}
          sub="TP1=2.2R · TP2=3.0R · SL=−1R"
          color={rrColor}
        />
      </div>

      {/* RR reference bar */}
      <div className="bg-surface-2 border border-border rounded p-3 space-y-2">
        <div className="font-mono text-[9px] text-muted-foreground tracking-widest">
          RR MODEL REFERENCE
        </div>
        <div className="space-y-1 font-mono text-[10px]">
          <div className="flex justify-between">
            <span className="text-muted-foreground">TP1</span>
            <span className="text-long">2.2R · close 50%</span>
          </div>
          <div className="flex justify-between">
            <span className="text-muted-foreground">TP2</span>
            <span className="text-long">3.0R · close 50%</span>
          </div>
          <div className="flex justify-between">
            <span className="text-muted-foreground">SL</span>
            <span className="text-short">−1R · close 100%</span>
          </div>
          <div className="flex justify-between border-t border-border/50 pt-1 mt-1">
            <span className="text-muted-foreground">Full TP path</span>
            <span className="text-foreground">
              {(2.2 * 0.5 + 3.0 * 0.5).toFixed(2)}R avg
            </span>
          </div>
        </div>
      </div>

      {/* Shadow Stats Panel — HTF OFF simulation */}
      <ShadowStatsPanel />
    </div>
  );
}
