import { Toaster } from "@/components/ui/sonner";
import { useState } from "react";
import { LogTab } from "./components/LogTab";
import { SettingsTab } from "./components/SettingsTab";
import { StatsTab } from "./components/StatsTab";
import { StatusBar } from "./components/StatusBar";
import { Top5Panel } from "./components/Top5Panel";
import { TradesTab } from "./components/TradesTab";
import { EngineProvider, useEngine } from "./engine/engineContext";

type Tab = "scanner" | "trades" | "log" | "stats" | "settings";

const TAB_LABELS: { id: Tab; label: string; shortLabel: string }[] = [
  { id: "scanner", label: "Scanner", shortLabel: "SCAN" },
  { id: "trades", label: "Trades", shortLabel: "TRADE" },
  { id: "log", label: "Log", shortLabel: "LOG" },
  { id: "stats", label: "Stats", shortLabel: "STATS" },
  { id: "settings", label: "Settings", shortLabel: "SET" },
];

function EngineControls() {
  const { engineState, start, stop } = useEngine();

  const isIdle = engineState === "IDLE" || engineState === "ERROR";
  const isRunning = engineState === "RUNNING";
  const isBusy =
    engineState === "INITIALIZING" ||
    engineState === "WARMING" ||
    engineState === "STOPPING";

  return (
    <div className="flex items-center gap-2">
      {isIdle ? (
        <button
          type="button"
          onClick={start}
          className="font-mono text-[10px] font-bold px-3 py-1.5 rounded border border-long text-long hover:bg-long/10 transition-all"
        >
          ▶ START
        </button>
      ) : isRunning ? (
        <button
          type="button"
          onClick={stop}
          className="font-mono text-[10px] font-bold px-3 py-1.5 rounded border border-short text-short hover:bg-short/10 transition-all"
        >
          ■ STOP
        </button>
      ) : isBusy ? (
        <button
          type="button"
          onClick={stop}
          disabled={engineState === "STOPPING"}
          className="font-mono text-[10px] font-bold px-3 py-1.5 rounded border border-warn text-warn hover:bg-warn/10 transition-all disabled:opacity-50"
        >
          ■ ABORT
        </button>
      ) : null}
    </div>
  );
}

function AppInner() {
  const [activeTab, setActiveTab] = useState<Tab>("scanner");
  const { openTrades } = useEngine();

  return (
    <div className="flex flex-col h-screen h-dvh bg-background overflow-hidden">
      {/* Header */}
      <header className="flex-shrink-0 flex items-center justify-between px-3 py-2 border-b border-border bg-surface-1">
        <div className="flex items-center gap-2">
          <span className="font-mono font-bold text-sm text-foreground tracking-wider">
            G100
          </span>
          <span className="font-mono text-[9px] text-muted-foreground">
            80/20 SCANNER
          </span>
          <span className="font-mono text-[8px] font-bold px-1.5 py-0.5 rounded border border-long/60 text-long bg-long/10 tracking-widest">
            AUTO MODE
          </span>
        </div>
        <EngineControls />
      </header>

      {/* Status Bar */}
      <StatusBar />

      {/* Tab Content */}
      <main className="flex-1 overflow-hidden">
        {activeTab === "scanner" && <Top5Panel />}
        {activeTab === "trades" && <TradesTab />}
        {activeTab === "log" && <LogTab />}
        {activeTab === "stats" && <StatsTab />}
        {activeTab === "settings" && <SettingsTab />}
      </main>

      {/* Bottom Tab Bar */}
      <nav className="flex-shrink-0 border-t border-border bg-surface-1">
        <div className="flex">
          {TAB_LABELS.map(({ id, shortLabel }) => {
            const isActive = activeTab === id;
            const badge =
              id === "trades" && openTrades.length > 0
                ? openTrades.length
                : null;

            return (
              <button
                type="button"
                key={id}
                onClick={() => setActiveTab(id)}
                className={`flex-1 flex flex-col items-center justify-center py-2 gap-0.5 transition-colors relative ${
                  isActive
                    ? "text-foreground"
                    : "text-muted-foreground hover:text-foreground/60"
                }`}
              >
                {isActive && (
                  <span className="absolute top-0 left-1/2 -translate-x-1/2 w-6 h-0.5 bg-long rounded-full" />
                )}
                <span className="font-mono text-[9px] font-bold tracking-wider">
                  {shortLabel}
                </span>
                {badge !== null && (
                  <span className="absolute top-1 right-1/4 w-3.5 h-3.5 rounded-full bg-long text-background font-mono text-[7px] font-bold flex items-center justify-center">
                    {badge}
                  </span>
                )}
              </button>
            );
          })}
        </div>
      </nav>
    </div>
  );
}

export default function App() {
  return (
    <EngineProvider>
      <AppInner />
      <Toaster
        position="top-center"
        toastOptions={{
          style: {
            background: "oklch(0.13 0.01 260)",
            border: "1px solid oklch(0.22 0.01 260)",
            color: "oklch(0.92 0.01 95)",
            fontFamily: "JetBrains Mono, monospace",
            fontSize: "11px",
          },
        }}
      />
    </EngineProvider>
  );
}
