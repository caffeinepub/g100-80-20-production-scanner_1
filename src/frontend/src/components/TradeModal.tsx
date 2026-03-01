import { useEffect, useRef } from "react";
import type React from "react";
import { useEngine } from "../engine/engineContext";
import type { ScoredCandidate } from "../scanner/finalScore";
import { formatPrice, formatRsi, formatScore } from "../utils/format";

interface TradeModalProps {
  candidate: ScoredCandidate | null;
  onClose: () => void;
}

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

export function TradeModal({ candidate, onClose }: TradeModalProps) {
  const { openTrades, engineState } = useEngine();
  const overlayRef = useRef<HTMLDivElement>(null);
  const modalRef = useRef<HTMLDialogElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);

  const existingTrade = candidate
    ? openTrades.find(
        (t) => t.symbol === candidate.symbol && t.side === candidate.side,
      )
    : null;

  // ESC to close
  useEffect(() => {
    if (!candidate) return;

    const handleKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
      // Focus trap
      if (e.key === "Tab" && modalRef.current) {
        const focusable = modalRef.current.querySelectorAll<HTMLElement>(
          'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
        );
        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first?.focus();
        }
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last?.focus();
        }
      }
    };

    document.addEventListener("keydown", handleKey);
    document.body.style.overflow = "hidden";
    closeButtonRef.current?.focus();

    return () => {
      document.removeEventListener("keydown", handleKey);
      document.body.style.overflow = "";
    };
  }, [candidate, onClose]);

  const handleOverlayClick = (e: React.MouseEvent) => {
    if (e.target === overlayRef.current) onClose();
  };

  if (!candidate) return null;

  const isLong = candidate.side === "LONG";

  return (
    <div
      ref={overlayRef}
      className="fixed inset-0 z-50 flex items-end sm:items-center justify-center"
      onClick={handleOverlayClick}
      onKeyDown={(e) => {
        if (e.target === overlayRef.current && e.key === "Escape") onClose();
      }}
      style={{
        backdropFilter: "blur(4px)",
        backgroundColor: "rgba(0,0,0,0.7)",
      }}
      aria-label={`Trade details for ${candidate.symbol}`}
    >
      <dialog
        ref={modalRef}
        open
        className="bg-card border border-border w-full rounded-t-xl sm:rounded-xl overflow-hidden m-0 p-0"
        style={{
          maxWidth: "600px",
          maxHeight: "85vh",
          overscrollBehavior: "contain",
        }}
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => e.stopPropagation()}
        aria-label={`Trade details for ${candidate.symbol}`}
      >
        {/* Header */}
        <div
          className={`flex items-center justify-between px-4 py-3 border-b border-border ${isLong ? "bg-long/5" : "bg-short/5"}`}
        >
          <div className="flex items-center gap-3">
            <span className="font-mono font-bold text-lg text-foreground">
              {candidate.symbol}
            </span>
            <span
              className={`font-mono text-xs border rounded px-2 py-0.5 font-bold ${isLong ? "text-long border-long" : "text-short border-short"}`}
            >
              {candidate.side}
            </span>
            <span className="font-mono text-xs text-muted-foreground">
              SCORE:{" "}
              <span className={isLong ? "text-long" : "text-short"}>
                {formatScore(candidate.score)}
              </span>
            </span>
          </div>
          <button
            type="button"
            ref={closeButtonRef}
            onClick={onClose}
            className="text-muted-foreground hover:text-foreground transition-colors w-8 h-8 flex items-center justify-center"
            aria-label="Close"
          >
            ✕
          </button>
        </div>

        {/* Content — scrollable */}
        <div
          className="overflow-y-auto p-4 space-y-4 touch-scroll"
          style={{
            maxHeight: "calc(85vh - 60px)",
            WebkitOverflowScrolling: "touch",
          }}
        >
          {/* RSI Grid */}
          <div>
            <div className="text-[9px] font-mono text-muted-foreground mb-2 tracking-widest">
              RSI VALUES
            </div>
            <div className="grid grid-cols-4 gap-1">
              {[
                { label: "1m", value: candidate.rsi1m },
                { label: "5m", value: candidate.rsi5m },
                { label: "15m", value: candidate.rsi15m },
                { label: "1H", value: candidate.rsi1h },
              ].map(({ label, value }) => (
                <div
                  key={label}
                  className="bg-surface-2 border border-border rounded p-2 text-center"
                >
                  <div className="font-mono text-[10px] text-muted-foreground">
                    {label}
                  </div>
                  <div
                    className={`font-mono text-sm font-bold ${
                      isLong
                        ? value < 35
                          ? "text-long"
                          : value > 60
                            ? "text-short"
                            : "text-foreground"
                        : value > 65
                          ? "text-short"
                          : value < 40
                            ? "text-long"
                            : "text-foreground"
                    }`}
                  >
                    {formatRsi(value)}
                  </div>
                </div>
              ))}
            </div>
          </div>

          {/* Trade Levels */}
          <div>
            <div className="text-[9px] font-mono text-muted-foreground mb-2 tracking-widest">
              TRADE LEVELS
            </div>
            <div className="grid grid-cols-2 gap-2">
              {[
                {
                  label: "ENTRY",
                  value: formatPrice(candidate.entry),
                  color: "text-foreground",
                },
                {
                  label: "SL",
                  value: formatPrice(candidate.sl),
                  color: "text-short",
                },
                {
                  label: "TP1",
                  value: formatPrice(candidate.tp1),
                  color: "text-long",
                },
                {
                  label: "TP2",
                  value: formatPrice(candidate.tp2),
                  color: "text-long",
                },
              ].map(({ label, value, color }) => (
                <div
                  key={label}
                  className="bg-surface-2 border border-border rounded p-2 flex justify-between items-center"
                >
                  <span className="font-mono text-[10px] text-muted-foreground">
                    {label}
                  </span>
                  <span className={`font-mono text-sm font-bold ${color}`}>
                    {value}
                  </span>
                </div>
              ))}
            </div>
          </div>

          {/* Risk Sizing */}
          <div>
            <div className="text-[9px] font-mono text-muted-foreground mb-2 tracking-widest">
              RISK SIZING
            </div>
            {!candidate.riskCalcValid ? (
              <div className="bg-surface-2 border border-short/40 rounded p-3 font-mono text-[10px] text-short text-center">
                RISK_CALC_REJECT — trade cannot be opened
              </div>
            ) : (
              <div className="grid grid-cols-2 gap-2">
                {[
                  {
                    label: "QTY",
                    value: fmtQty(candidate.qty),
                    color: "text-foreground",
                  },
                  {
                    label: "NOTIONAL",
                    value: fmtUsd(candidate.notionalUSDT),
                    color: "text-foreground",
                  },
                  {
                    label: "EFF LEV",
                    value: fmtLev(candidate.effectiveLeverage),
                    color:
                      candidate.effectiveLeverage > 10
                        ? "text-short"
                        : "text-foreground",
                  },
                  {
                    label: "RISK$",
                    value: fmtUsd(candidate.riskUSDT),
                    color: "text-warn",
                  },
                ].map(({ label, value, color }) => (
                  <div
                    key={label}
                    className="bg-surface-2 border border-border rounded p-2 flex justify-between items-center"
                  >
                    <span className="font-mono text-[10px] text-muted-foreground">
                      {label}
                    </span>
                    <span className={`font-mono text-sm font-bold ${color}`}>
                      {value}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Existing trade status OR auto mode notice */}
          {existingTrade ? (
            <div className="border border-warn rounded p-3">
              <div className="text-[9px] font-mono text-warn mb-2 tracking-widest">
                TRADE OPEN
              </div>
              <div className="grid grid-cols-2 gap-2 text-[11px]">
                <div className="flex justify-between">
                  <span className="text-muted-foreground font-mono">Entry</span>
                  <span className="text-foreground font-mono">
                    {formatPrice(existingTrade.entryPrice)}
                  </span>
                </div>
                <div className="flex justify-between">
                  <span className="text-muted-foreground font-mono">
                    Status
                  </span>
                  <span className="text-warn font-mono">
                    {existingTrade.status}
                  </span>
                </div>
                <div className="flex justify-between">
                  <span className="text-muted-foreground font-mono">SL</span>
                  <span className="text-short font-mono">
                    {formatPrice(existingTrade.sl)}
                  </span>
                </div>
                <div className="flex justify-between">
                  <span className="text-muted-foreground font-mono">TP2</span>
                  <span className="text-long font-mono">
                    {formatPrice(existingTrade.tp2)}
                  </span>
                </div>
                <div className="flex justify-between">
                  <span className="text-muted-foreground font-mono">Qty</span>
                  <span className="text-foreground font-mono">
                    {fmtQty(existingTrade.qty)}
                  </span>
                </div>
                <div className="flex justify-between">
                  <span className="text-muted-foreground font-mono">Risk$</span>
                  <span className="text-warn font-mono">
                    {fmtUsd(existingTrade.riskUSDT)}
                  </span>
                </div>
              </div>
            </div>
          ) : (
            <div
              className={`w-full font-mono text-xs py-3 px-4 rounded border text-center ${
                engineState === "RUNNING"
                  ? "border-long/40 text-muted-foreground bg-long/5"
                  : "border-border text-muted-foreground/50 bg-surface-2"
              }`}
            >
              <div className="font-bold text-[11px] mb-1 text-foreground/70">
                AUTO MODE
              </div>
              <div className="text-[10px]">
                {engineState === "RUNNING"
                  ? "Engine will open automatically when conditions are met"
                  : "Start engine to enable auto-entry"}
              </div>
            </div>
          )}
        </div>
      </dialog>
    </div>
  );
}
