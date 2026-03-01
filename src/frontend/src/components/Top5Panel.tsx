import { useState } from "react";
import { useEngine } from "../engine/engineContext";
import type { ScoredCandidate } from "../scanner/finalScore";
import { formatPrice, formatRsi, formatScore } from "../utils/format";
import { TradeModal } from "./TradeModal";

function RsiCell({ value, isLong }: { value: number; isLong: boolean }) {
  const v = Number(value);
  if (!Number.isFinite(v))
    return <span className="text-muted-foreground">--</span>;

  const color = isLong
    ? v < 35
      ? "text-long"
      : v > 60
        ? "text-short"
        : "text-foreground"
    : v > 65
      ? "text-short"
      : v < 40
        ? "text-long"
        : "text-foreground";

  return <span className={color}>{formatRsi(v)}</span>;
}

function fmtQty(v: number): string {
  if (!Number.isFinite(v) || v <= 0) return "--";
  if (v >= 1000) return v.toFixed(0);
  if (v >= 1) return v.toFixed(2);
  return v.toFixed(4);
}

function fmtLev(v: number): string {
  if (!Number.isFinite(v) || v <= 0) return "--";
  return `${v.toFixed(1)}x`;
}

function fmtRiskUsd(v: number): string {
  if (!Number.isFinite(v) || v <= 0) return "--";
  return `$${v.toFixed(2)}`;
}

function Top5Table({
  title,
  candidates,
  isLong,
  isWarmedUp,
  warmupDone,
  warmupTotal,
  onRowClick,
}: {
  title: string;
  candidates: ScoredCandidate[];
  isLong: boolean;
  isWarmedUp: boolean;
  warmupDone: number;
  warmupTotal: number;
  onRowClick: (c: ScoredCandidate) => void;
}) {
  const accentClass = isLong
    ? "text-long border-long"
    : "text-short border-short";
  const borderClass = isLong ? "border-long/30" : "border-short/30";

  return (
    <div className={`flex-1 border ${borderClass} rounded overflow-hidden`}>
      {/* Table header */}
      <div
        className={`flex items-center justify-between px-2 py-1.5 border-b ${borderClass} bg-surface-2`}
      >
        <span
          className={`font-mono text-[10px] font-bold tracking-widest ${accentClass}`}
        >
          {title}
        </span>
        <span className="font-mono text-[9px] text-muted-foreground">
          {candidates.length}/5
        </span>
      </div>

      {!isWarmedUp ? (
        <div className="px-2 py-3 font-mono text-[10px] text-muted-foreground text-center">
          {warmupTotal > 0
            ? `Warming up… ${warmupDone}/${warmupTotal}`
            : "Warming up…"}
        </div>
      ) : candidates.length === 0 ? (
        <div className="px-2 py-3 font-mono text-[10px] text-muted-foreground text-center">
          No {isLong ? "LONG" : "SHORT"} candidates
        </div>
      ) : (
        <div className="overflow-x-auto touch-scroll">
          <table className="w-full text-[10px] font-mono border-collapse min-w-[560px]">
            <thead>
              <tr className="border-b border-border">
                {[
                  "SYM",
                  "SCORE",
                  "C1",
                  "C2",
                  "C3",
                  "1H",
                  "ENTRY",
                  "SL",
                  "TP1",
                  "TP2",
                  "QTY",
                  "RISK$",
                  "LEV",
                ].map((h) => (
                  <th
                    key={h}
                    className="px-1.5 py-1 text-left text-[9px] text-muted-foreground font-medium"
                  >
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {candidates.map((c, i) => (
                <tr
                  key={c.symbol}
                  onClick={() => onRowClick(c)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") onRowClick(c);
                  }}
                  tabIndex={0}
                  className={`border-b border-border/50 cursor-pointer transition-colors hover:bg-surface-3 ${
                    i % 2 === 0 ? "bg-surface-1/50" : ""
                  } ${!c.riskCalcValid ? "opacity-60" : ""}`}
                >
                  <td className={`px-1.5 py-1.5 font-bold ${accentClass}`}>
                    {c.symbol.replace("USDT", "")}
                  </td>
                  <td className="px-1.5 py-1.5 text-foreground">
                    {formatScore(c.score)}
                  </td>
                  <td className="px-1.5 py-1.5">
                    <RsiCell value={c.rsi1m} isLong={isLong} />
                  </td>
                  <td className="px-1.5 py-1.5">
                    <RsiCell value={c.rsi5m} isLong={isLong} />
                  </td>
                  <td className="px-1.5 py-1.5">
                    <RsiCell value={c.rsi15m} isLong={isLong} />
                  </td>
                  <td className="px-1.5 py-1.5">
                    <RsiCell value={c.rsi1h} isLong={isLong} />
                  </td>
                  <td className="px-1.5 py-1.5 text-foreground">
                    {formatPrice(c.entry)}
                  </td>
                  <td className="px-1.5 py-1.5 text-short">
                    {formatPrice(c.sl)}
                  </td>
                  <td className="px-1.5 py-1.5 text-long">
                    {formatPrice(c.tp1)}
                  </td>
                  <td className="px-1.5 py-1.5 text-long">
                    {formatPrice(c.tp2)}
                  </td>
                  <td className="px-1.5 py-1.5 text-foreground">
                    {fmtQty(c.qty)}
                  </td>
                  <td className="px-1.5 py-1.5 text-warn">
                    {fmtRiskUsd(c.riskUSDT)}
                  </td>
                  <td
                    className={`px-1.5 py-1.5 ${c.effectiveLeverage > 10 ? "text-short" : "text-foreground"}`}
                  >
                    {fmtLev(c.effectiveLeverage)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

export function Top5Panel() {
  const {
    top5Long,
    top5Short,
    isWarmedUp,
    warmupDone,
    warmupTotal,
    engineState,
  } = useEngine();
  const [selectedCandidate, setSelectedCandidate] =
    useState<ScoredCandidate | null>(null);

  const showContent = engineState !== "IDLE" && engineState !== "INITIALIZING";

  if (!showContent) {
    return (
      <div className="flex-1 flex items-center justify-center p-8">
        <div className="text-center space-y-3">
          <div className="font-mono text-2xl text-muted-foreground/30">
            G100
          </div>
          <div className="font-mono text-sm text-muted-foreground">
            Press START to begin scanning
          </div>
          <div className="font-mono text-[10px] text-muted-foreground/50">
            Multi-TF RSI · Stage A/B · Top5 LONG/SHORT · Risk Engine
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-2 p-2 h-full overflow-y-auto touch-scroll">
      <Top5Table
        title="TOP 5 LONG"
        candidates={top5Long}
        isLong={true}
        isWarmedUp={isWarmedUp}
        warmupDone={warmupDone}
        warmupTotal={warmupTotal}
        onRowClick={setSelectedCandidate}
      />
      <Top5Table
        title="TOP 5 SHORT"
        candidates={top5Short}
        isLong={false}
        isWarmedUp={isWarmedUp}
        warmupDone={warmupDone}
        warmupTotal={warmupTotal}
        onRowClick={setSelectedCandidate}
      />

      <TradeModal
        candidate={selectedCandidate}
        onClose={() => setSelectedCandidate(null)}
      />
    </div>
  );
}
