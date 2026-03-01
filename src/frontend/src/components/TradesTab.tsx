import { useEngine } from "../engine/engineContext";
import type { Trade } from "../journal/trades";
import { formatElapsed, formatPrice, formatTs } from "../utils/format";

function fmtQty(v: number): string {
  if (!Number.isFinite(v) || v <= 0) return "--";
  if (v >= 1000) return v.toFixed(0);
  if (v >= 1) return v.toFixed(4);
  return v.toFixed(6);
}

function fmtUsd(v: number, decimals = 2): string {
  if (!Number.isFinite(v) || v <= 0) return "--";
  return `$${v.toFixed(decimals)}`;
}

function fmtLev(v: number): string {
  if (!Number.isFinite(v) || v <= 0) return "--";
  return `${v.toFixed(2)}x`;
}

function TradeRow({ trade }: { trade: Trade }) {
  const now = Date.now();
  const elapsed = now - trade.entryTime;

  const rColor =
    trade.r !== undefined
      ? trade.r > 0
        ? "text-long"
        : trade.r < 0
          ? "text-short"
          : "text-muted-foreground"
      : "text-muted-foreground";

  const isOpen = trade.status !== "CLOSED";

  return (
    <div className="border border-border rounded p-2.5 space-y-2 bg-surface-1 hover:bg-surface-2 transition-colors">
      {/* Header */}
      <div className="flex items-center justify-between flex-wrap gap-1">
        <div className="flex items-center gap-2">
          <span className="font-mono font-bold text-sm text-foreground">
            {trade.symbol.replace("USDT", "")}
          </span>
          <span
            className={`font-mono text-[10px] border rounded px-1.5 py-0.5 font-bold ${
              trade.side === "LONG"
                ? "text-long border-long"
                : "text-short border-short"
            }`}
          >
            {trade.side}
          </span>
          {trade.status === "TP1_HIT" && (
            <span className="font-mono text-[10px] border border-long text-long rounded px-1.5 py-0.5">
              TP1 ✓
            </span>
          )}
          {isOpen && (
            <span className="font-mono text-[9px] text-muted-foreground">
              {formatElapsed(elapsed)}
            </span>
          )}
        </div>
        <div className="flex items-center gap-2">
          {!isOpen && trade.r !== undefined && (
            <span className={`font-mono text-sm font-bold ${rColor}`}>
              {trade.r >= 0 ? "+" : ""}
              {trade.r.toFixed(2)}R
            </span>
          )}
          {!isOpen && trade.exitReason && (
            <span className="font-mono text-[10px] text-muted-foreground border border-border rounded px-1 py-0.5">
              {trade.exitReason}
            </span>
          )}
        </div>
      </div>

      {/* Levels — Entry/SL/TP1/TP2 */}
      <div className="grid grid-cols-4 gap-1 text-[10px] font-mono">
        <div className="flex flex-col items-center bg-surface-2 rounded p-1">
          <span className="text-muted-foreground">ENTRY</span>
          <span className="text-foreground">
            {formatPrice(trade.entryPrice)}
          </span>
        </div>
        {!isOpen && trade.exitPrice ? (
          <div className="flex flex-col items-center bg-surface-2 rounded p-1">
            <span className="text-muted-foreground">EXIT</span>
            <span
              className={`${trade.r !== undefined && trade.r > 0 ? "text-long" : "text-short"}`}
            >
              {formatPrice(trade.exitPrice)}
            </span>
          </div>
        ) : (
          <div className="flex flex-col items-center bg-surface-2 rounded p-1">
            <span className="text-muted-foreground">SL</span>
            <span className="text-short">{formatPrice(trade.sl)}</span>
          </div>
        )}
        <div className="flex flex-col items-center bg-surface-2 rounded p-1">
          <span className="text-muted-foreground">TP1</span>
          <span className="text-long">{formatPrice(trade.tp1)}</span>
        </div>
        <div className="flex flex-col items-center bg-surface-2 rounded p-1">
          <span className="text-muted-foreground">TP2</span>
          <span className="text-long">{formatPrice(trade.tp2)}</span>
        </div>
      </div>

      {/* Risk fields — only show if populated */}
      {isOpen && trade.qty > 0 && (
        <div className="grid grid-cols-4 gap-1 text-[10px] font-mono">
          <div className="flex flex-col items-center bg-surface-2 rounded p-1">
            <span className="text-muted-foreground">QTY</span>
            <span className="text-foreground">{fmtQty(trade.qty)}</span>
          </div>
          <div className="flex flex-col items-center bg-surface-2 rounded p-1">
            <span className="text-muted-foreground">NOTIONAL</span>
            <span className="text-foreground">
              {fmtUsd(trade.notionalUSDT, 0)}
            </span>
          </div>
          <div className="flex flex-col items-center bg-surface-2 rounded p-1">
            <span className="text-muted-foreground">EFF LEV</span>
            <span
              className={
                trade.effectiveLeverage > 10 ? "text-short" : "text-foreground"
              }
            >
              {fmtLev(trade.effectiveLeverage)}
            </span>
          </div>
          <div className="flex flex-col items-center bg-surface-2 rounded p-1">
            <span className="text-muted-foreground">RISK$</span>
            <span className="text-warn">{fmtUsd(trade.riskUSDT)}</span>
          </div>
        </div>
      )}

      <div className="font-mono text-[9px] text-muted-foreground">
        {formatTs(trade.entryTime)}
        {!isOpen && trade.exitTime && ` → ${formatTs(trade.exitTime)}`}
      </div>
    </div>
  );
}

export function TradesTab() {
  const { openTrades, closedTrades } = useEngine();

  const sortedClosed = [...closedTrades].sort(
    (a, b) => (b.exitTime ?? 0) - (a.exitTime ?? 0),
  );

  return (
    <div className="h-full overflow-y-auto touch-scroll p-2 space-y-3">
      {/* Open Trades */}
      <section>
        <div className="font-mono text-[9px] text-muted-foreground tracking-widest mb-2 px-1">
          OPEN POSITIONS ({openTrades.length})
        </div>
        {openTrades.length === 0 ? (
          <div className="border border-border rounded p-4 text-center font-mono text-[10px] text-muted-foreground">
            No open positions
          </div>
        ) : (
          <div className="space-y-2">
            {openTrades.map((t) => (
              <TradeRow key={t.id} trade={t} />
            ))}
          </div>
        )}
      </section>

      {/* Closed Trades */}
      <section>
        <div className="font-mono text-[9px] text-muted-foreground tracking-widest mb-2 px-1">
          CLOSED TRADES ({closedTrades.length})
        </div>
        {sortedClosed.length === 0 ? (
          <div className="border border-border rounded p-4 text-center font-mono text-[10px] text-muted-foreground">
            No closed trades yet
          </div>
        ) : (
          <div className="space-y-2">
            {sortedClosed.slice(0, 50).map((t) => (
              <TradeRow key={t.id} trade={t} />
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
