# G100 80/20 Production Scanner

## Current State

Full-stack scanner with:
- Engine: universe builder, warmup, scheduler with runId guards, heartbeat, 80/20 cycle
- Scanner: Wilder RSI, HTF gate (EMA9/EMA20 + RSI on 5m), Stage A/B, FinalScore, structural+ATR SL model
- Journal: IndexedDB `g100-ledger` (5 stores: ledgerEvents, trades, snapshots, metricsDaily, settings), paper trade lifecycle (open/TP1/TP2/SL/timeStop), RR metrics
- Auto-entry: fully automatic, blocked by HTF EMA filter (ENTRY_BLOCKED_HTF)
- UI: StatusBar, Top5, Trades, Log, Stats (RR metrics), Settings, Export

The HTF gate in `tryAutoEntry` (scheduler.ts) blocks trades where EMA9_5m < EMA20_5m or RSI_5m < 50 (LONG), or inverse (SHORT). These blocked candidates have already passed StageA + StageB + risk calc.

## Requested Changes (Diff)

### Add

- `ScannerConfig.enableShadowStats: boolean` (default true)
- `ShadowTrade` interface in new file `journal/shadowTrades.ts`
- IndexedDB store `shadow_trades` in `journal/idb.ts` (DB version bump to 2)
- `openShadowTrade()` and `updateShadowTrades()` functions in `journal/shadowTrades.ts` — reuse same TP/SL evaluation logic as real trades, closed-candle only
- `computeShadowMetrics()` in `journal/shadowMetrics.ts`
- Shadow engine hook in `scheduler.ts`: after ENTRY_BLOCKED_HTF, if enableShadowStats, create ShadowTrade
- Events: `SHADOW_ENTRY_CREATED`, `SHADOW_TRADE_CLOSED` (with result)
- `ShadowStatsPanel` component in `components/ShadowStatsPanel.tsx` — displayed below existing stats in StatsTab
- Checkbox "Shadow Stats (HTF_OFF Simulation)" in SettingsTab
- Shadow trades included in export
- Engine context wired: `shadowTrades`, `shadowMetrics` state

### Modify

- `engine/config.ts` — add `enableShadowStats: boolean` to `ScannerConfig` and `DEFAULT_CONFIG`
- `journal/idb.ts` — bump DB_VERSION to 2, add `shadow_trades` object store in onupgradeneeded
- `journal/ledger.ts` — add `SHADOW_ENTRY_CREATED` and `SHADOW_TRADE_CLOSED` to EVENT_CATEGORIES map
- `engine/scheduler.ts` — in `tryAutoEntry`, after ENTRY_BLOCKED_HTF block: if enableShadowStats, call `tryOpenShadowTrade`; in `runCycle`, call `updateShadowTrades` per tick
- `engine/engineContext.tsx` — add shadowTrades/shadowMetrics state, wire into context value and export
- `components/StatsTab.tsx` — render `<ShadowStatsPanel>` below existing RR stats
- `components/SettingsTab.tsx` — add Shadow Stats checkbox
- `engine/engineContext.tsx` — include shadowTrades in exportData payload

### Remove

Nothing removed. This is purely additive.

## Implementation Plan

1. Add `enableShadowStats` to `ScannerConfig` + DEFAULT_CONFIG
2. Bump IDB to version 2, add `shadow_trades` store
3. Add `SHADOW_ENTRY_CREATED` + `SHADOW_TRADE_CLOSED` to ledger event categories
4. Create `journal/shadowTrades.ts`: ShadowTrade interface, `openShadowTrade()`, `updateShadowTrades()` — reuse same SL/TP price hit logic, closed-candle only, no new Binance calls
5. Create `journal/shadowMetrics.ts`: `ShadowMetrics` interface + `computeShadowMetrics()`
6. Wire shadow engine into `scheduler.ts`: after ENTRY_BLOCKED_HTF, call tryOpenShadowTrade; in runCycle, call updateShadowTrades with current prices
7. Add shadow state + callbacks to EngineCallbacks and EngineContext
8. Create `components/ShadowStatsPanel.tsx`: panel with 7 metrics + STRICT vs SHADOW Net R comparison row
9. Add shadow panel to StatsTab below existing stats
10. Add checkbox to SettingsTab
11. Include shadow trades in exportData
