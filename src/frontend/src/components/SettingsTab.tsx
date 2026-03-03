import { Loader2 } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import type { HtfMode, ScannerConfig } from "../engine/config";
import { useEngine } from "../engine/engineContext";

function FieldRow({
  label,
  description,
  children,
}: {
  label: string;
  description?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex items-center justify-between py-2 border-b border-border/50">
      <div className="flex-1 min-w-0 mr-4">
        <div className="font-mono text-[11px] text-foreground">{label}</div>
        {description && (
          <div className="font-mono text-[9px] text-muted-foreground mt-0.5">
            {description}
          </div>
        )}
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  );
}

function NumericInput({
  value,
  onChange,
  min,
  max,
  step,
}: {
  value: number;
  onChange: (v: number) => void;
  min?: number;
  max?: number;
  step?: number;
}) {
  return (
    <input
      type="number"
      value={value}
      min={min}
      max={max}
      step={step ?? 1}
      onChange={(e) => onChange(Number(e.target.value))}
      className="w-24 bg-surface-2 border border-border rounded px-2 py-1 font-mono text-[11px] text-foreground text-right focus:outline-none focus:border-foreground/40"
    />
  );
}

export function SettingsTab() {
  const { config, setConfig, runSelfTest, exportData, engineState } =
    useEngine();
  const [local, setLocal] = useState<ScannerConfig>({ ...config });
  const [selfTestLoading, setSelfTestLoading] = useState(false);

  const update = <K extends keyof ScannerConfig>(
    key: K,
    value: ScannerConfig[K],
  ) => {
    setLocal((prev) => ({ ...prev, [key]: value }));
  };

  const handleSave = async () => {
    await setConfig(local);
    toast.success("Settings saved");
  };

  const handleSelfTest = async () => {
    setSelfTestLoading(true);
    try {
      await runSelfTest();
    } finally {
      setSelfTestLoading(false);
    }
  };

  const engineRunning =
    engineState === "RUNNING" ||
    engineState === "WARMING" ||
    engineState === "INITIALIZING";

  return (
    <div className="h-full overflow-y-auto touch-scroll p-3 space-y-4">
      <div className="font-mono text-[9px] text-muted-foreground tracking-widest">
        SCANNER CONFIG
      </div>

      <div className="bg-surface-1 border border-border rounded p-3 space-y-0">
        <FieldRow
          label="RSI Period"
          description="Wilder's RMA period (default 27)"
        >
          <NumericInput
            value={local.rsiPeriod}
            onChange={(v) => update("rsiPeriod", v)}
            min={5}
            max={100}
          />
        </FieldRow>

        <FieldRow
          label="Poll Interval (ms)"
          description="Scan cycle frequency (min 5000; universe refreshes every 90s separately)"
        >
          <NumericInput
            value={local.pollInterval}
            onChange={(v) => update("pollInterval", Math.max(5000, v))}
            min={5000}
            step={1000}
          />
        </FieldRow>

        <FieldRow
          label="Vol Floor (USDT)"
          description="Min 24h volume (min 20M enforced)"
        >
          <NumericInput
            value={local.volFloor}
            onChange={(v) => update("volFloor", v)}
            min={1_000_000}
            step={1_000_000}
          />
        </FieldRow>
      </div>

      <div className="font-mono text-[9px] text-muted-foreground tracking-widest">
        LEVERAGE &amp; SL/TP
      </div>

      <div className="bg-surface-1 border border-border rounded p-3 space-y-0">
        <div className="py-2 border-b border-border/50">
          <div className="font-mono text-[9px] text-muted-foreground/70 space-y-0.5">
            <div>SL = entry × (1 ± slPct/100) — mechanical, no klines</div>
            <div>TP2 = entry ± (SL dist × RR)</div>
            <div>RealRisk% = slPct × leverageX — display only, never gates</div>
          </div>
        </div>

        <FieldRow
          label="Leverage (X)"
          description="Manual leverage (1–10, integer)"
        >
          <div className="flex items-center gap-2">
            <input
              type="range"
              min={1}
              max={10}
              step={1}
              value={local.leverageX ?? 3}
              onChange={(e) => update("leverageX", Number(e.target.value))}
              className="w-20 accent-warn"
              data-ocid="settings.leveragex.toggle"
            />
            <span className="font-mono text-[11px] text-foreground w-8 text-right">
              {local.leverageX ?? 3}x
            </span>
          </div>
        </FieldRow>

        <FieldRow
          label="SL % (price dist)"
          description="Stop-loss distance from entry (0.20–5.00)"
        >
          <div className="flex items-center gap-2">
            <input
              type="range"
              min={0.2}
              max={5.0}
              step={0.05}
              value={local.slPct ?? 0.65}
              onChange={(e) => update("slPct", Number(e.target.value))}
              className="w-20 accent-warn"
              data-ocid="settings.slpct.toggle"
            />
            <span className="font-mono text-[11px] text-foreground w-10 text-right">
              {(local.slPct ?? 0.65).toFixed(2)}%
            </span>
          </div>
        </FieldRow>

        <FieldRow
          label="RR (Risk-Reward)"
          description="TP2 distance = SL dist × RR (1.0–5.0)"
        >
          <div className="flex items-center gap-2">
            <input
              type="range"
              min={1.0}
              max={5.0}
              step={0.1}
              value={local.rr ?? 3.0}
              onChange={(e) => update("rr", Number(e.target.value))}
              className="w-20 accent-warn"
              data-ocid="settings.rr.toggle"
            />
            <span className="font-mono text-[11px] text-foreground w-8 text-right">
              {(local.rr ?? 3.0).toFixed(1)}R
            </span>
          </div>
        </FieldRow>

        {/* RealRisk display */}
        <div className="py-2 border-b border-border/50">
          <div className="flex items-center justify-between">
            <div className="font-mono text-[11px] text-foreground">
              RealRisk%
            </div>
            <div className="font-mono text-[11px] text-warn">
              {((local.slPct ?? 0.65) * (local.leverageX ?? 3)).toFixed(2)}%
              account
            </div>
          </div>
          <div className="font-mono text-[9px] text-muted-foreground mt-0.5">
            slPct × leverageX — informational only
          </div>
        </div>

        {/* Optional TP1 */}
        <div className="py-2 border-b border-border/50">
          <label className="flex items-start gap-3 cursor-pointer">
            <input
              type="checkbox"
              checked={local.enableTP1 ?? false}
              onChange={(e) => update("enableTP1", e.target.checked)}
              className="mt-0.5 w-4 h-4 accent-warn cursor-pointer"
              data-ocid="settings.enabletp1.checkbox"
            />
            <div>
              <div className="font-mono text-[11px] text-foreground">
                Enable TP1
              </div>
              <div className="font-mono text-[9px] text-muted-foreground mt-0.5">
                Partial close at TP1 level (optional)
              </div>
            </div>
          </label>
        </div>

        {(local.enableTP1 ?? false) && (
          <FieldRow
            label="TP1 RR"
            description="TP1 distance = SL dist × tp1RR (0.5–3.0)"
          >
            <div className="flex items-center gap-2">
              <input
                type="range"
                min={0.5}
                max={3.0}
                step={0.1}
                value={local.tp1RR ?? 1.0}
                onChange={(e) => update("tp1RR", Number(e.target.value))}
                className="w-20 accent-warn"
                data-ocid="settings.tp1rr.toggle"
              />
              <span className="font-mono text-[11px] text-foreground w-8 text-right">
                {(local.tp1RR ?? 1.0).toFixed(1)}R
              </span>
            </div>
          </FieldRow>
        )}
      </div>

      <div className="font-mono text-[9px] text-muted-foreground tracking-widest">
        RISK ENGINE
      </div>

      <div className="bg-surface-1 border border-border rounded p-3 space-y-0">
        <div className="py-2 border-b border-border/50">
          <div className="font-mono text-[9px] text-muted-foreground/70 space-y-0.5">
            <div>Qty = (Equity × Risk%) / |entry − SL|</div>
            <div>Effective leverage = Notional / Equity</div>
          </div>
        </div>

        <FieldRow
          label="Equity (USDT)"
          description="Account equity (10–1,000,000)"
        >
          <NumericInput
            value={local.equityUSDT}
            onChange={(v) =>
              update("equityUSDT", Math.min(1_000_000, Math.max(10, v)))
            }
            min={10}
            max={1_000_000}
            step={100}
          />
        </FieldRow>

        <FieldRow
          label="Risk Per Trade %"
          description="% of equity risked per trade (0.05–2.0)"
        >
          <NumericInput
            value={local.riskPct}
            onChange={(v) =>
              update("riskPct", Math.min(2.0, Math.max(0.05, v)))
            }
            min={0.05}
            max={2.0}
            step={0.05}
          />
        </FieldRow>

        <FieldRow
          label="Max Leverage"
          description="Leverage cap for sizing (1–50)"
        >
          <NumericInput
            value={local.maxLeverage}
            onChange={(v) =>
              update("maxLeverage", Math.min(50, Math.max(1, v)))
            }
            min={1}
            max={50}
            step={1}
          />
        </FieldRow>

        <FieldRow
          label="Time Stop (min)"
          description="Close trade after N minutes"
        >
          <NumericInput
            value={local.timeStopMin}
            onChange={(v) => update("timeStopMin", v)}
            min={5}
            max={1440}
          />
        </FieldRow>
        <FieldRow
          label="Cooldown (min)"
          description="Pause after close before next entry"
        >
          <NumericInput
            value={local.cooldownMin}
            onChange={(v) => update("cooldownMin", v)}
            min={0}
            max={480}
          />
        </FieldRow>
        <FieldRow
          label="Max Open Trades"
          description="Concurrent positions (1–3)"
        >
          <select
            value={local.maxOpenTrades}
            onChange={(e) => update("maxOpenTrades", Number(e.target.value))}
            className="bg-surface-2 border border-border rounded px-2 py-1 font-mono text-[11px] text-foreground focus:outline-none focus:border-foreground/40"
          >
            <option value={1}>1</option>
            <option value={2}>2</option>
            <option value={3}>3</option>
          </select>
        </FieldRow>
      </div>

      <div className="font-mono text-[9px] text-muted-foreground tracking-widest">
        FILTER
      </div>

      <div className="bg-surface-1 border border-border rounded p-3 space-y-0">
        <FieldRow
          label="HTF Mode"
          description="OFF = ignored · SOFT = score bias (−10%) · HARD = strict gate"
        >
          <select
            value={local.htfMode ?? "SOFT"}
            onChange={(e) => update("htfMode", e.target.value as HtfMode)}
            className="bg-surface-2 border border-border rounded px-2 py-1 font-mono text-[11px] text-foreground focus:outline-none focus:border-foreground/40"
            data-ocid="settings.htfmode.select"
          >
            <option value="OFF">OFF</option>
            <option value="SOFT">SOFT</option>
            <option value="HARD">HARD</option>
          </select>
        </FieldRow>
      </div>

      <div className="font-mono text-[9px] text-muted-foreground tracking-widest">
        SHADOW STATS
      </div>

      <div className="bg-surface-1 border border-border rounded p-3">
        <label className="flex items-start gap-3 cursor-pointer">
          <input
            type="checkbox"
            checked={local.enableShadowStats}
            onChange={(e) => update("enableShadowStats", e.target.checked)}
            className="mt-0.5 w-4 h-4 accent-warn cursor-pointer"
          />
          <div>
            <div className="font-mono text-[11px] text-foreground">
              Shadow Stats (HTF_OFF Simulation)
            </div>
            <div className="font-mono text-[9px] text-muted-foreground mt-0.5">
              Simulate trades blocked by HTF EMA filter — analytical only, no
              real positions opened
            </div>
          </div>
        </label>
      </div>

      {engineRunning && (
        <div className="font-mono text-[10px] text-warn border border-warn/40 rounded p-2">
          ⚠ Stop engine before changing settings
        </div>
      )}

      <button
        type="button"
        onClick={handleSave}
        disabled={engineRunning}
        className={`w-full font-mono text-[11px] font-bold py-2.5 rounded border transition-all ${
          engineRunning
            ? "border-border text-muted-foreground cursor-not-allowed opacity-50"
            : "border-foreground/40 text-foreground hover:bg-surface-3"
        }`}
      >
        SAVE SETTINGS
      </button>

      <div className="border-t border-border pt-4 space-y-2">
        <div className="font-mono text-[9px] text-muted-foreground tracking-widest">
          DIAGNOSTICS
        </div>

        <button
          type="button"
          onClick={handleSelfTest}
          disabled={selfTestLoading}
          className="w-full font-mono text-[11px] font-bold py-2.5 rounded border border-info/40 text-info hover:bg-info/10 transition-all disabled:opacity-50 flex items-center justify-center gap-2"
        >
          {selfTestLoading ? (
            <>
              <Loader2 className="w-3 h-3 animate-spin" />
              TESTING…
            </>
          ) : (
            "SELF-TEST (BTC/ETH/SOL)"
          )}
        </button>

        <button
          type="button"
          onClick={exportData}
          className="w-full font-mono text-[11px] font-bold py-2.5 rounded border border-stage/40 text-stage hover:bg-stage/10 transition-all"
        >
          EXPORT JSON + CSV
        </button>
      </div>
    </div>
  );
}
