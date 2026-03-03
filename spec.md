# G100 80/20 Production Scanner

## Current State
Frontend-only React+TS crypto scanner. Engine: universe builder, warmup, scheduler with runId guards, heartbeat. Scanner: RSI (Wilder), Stage A/B, HTF soft/hard/off mode, FinalScore. Journal: IndexedDB (5 stores), paper trades (open/TP1/TP2/SL/timeStop), RR metrics, shadow stats. Config has: equityUSDT, riskPct, maxLeverage — risk-based sizing via `computeRiskCalc` using structural+ATR SL. Trade record has: qty, notionalUSDT, effectiveLeverage, marginUsed. SL is computed from klines (last 12 candles + ATR). TP1/TP2 fixed at 2.2R/3.0R.

## Requested Changes (Diff)

### Add
- Config keys: `leverageX` (int, 1–10, default 3), `slPct` (float, 0.20–5.00, default 0.65), `rr` (float, 1.0–5.0, default 3.0), `enableTP1` (bool, default false), `tp1RR` (float, 0.5–3.0, default 1.0)
- `computeLevels(entry, side, slPct, rr, enableTP1?, tp1RR?)` in riskCalc.ts — purely mechanical, no klines/ATR/structure
- `realRiskPct = slPct * leverageX` — display-only field, never gates
- Settings UI: sliders/inputs for all 5 new params under new "LEVERAGE & SL/TP" section
- Trade record fields: `leverageX`, `slPct`, `rr`, `slPrice`, `tp2Price`, `tp1Price?`, `realRiskPct`
- Log event: `TRADE_OPEN { symbol, side, entry, slPct, rr, leverageX, slPrice, tp2Price, realRiskPct }`
- Top5 table columns: SL%, RR, LevX, RealRisk% (replacing Qty/Risk$/Lev columns with new set)
- TradesTab open trade rows: show leverageX, slPct, rr, slPrice/tp2Price, realRiskPct

### Modify
- `ScannerConfig` interface — add 5 new keys
- `DEFAULT_CONFIG` — add defaults for 5 new keys
- `computeFinalScore` — use `computeLevels` instead of `computeRiskCalc` for sl/tp1/tp2; retain risk sizing fields from existing `computeRiskCalc` call
- `tryAutoEntry` in scheduler — use `computeLevels` for SL/TP on enriched candidate
- `openTrade` in trades.ts — write new fields to Trade record, emit updated TRADE_OPEN log
- `Trade` interface — add new fields
- Settings UI — add new section above RISK ENGINE
- Top5Panel — replace/add columns for new fields
- TradesTab — show new fields on open trade rows

### Remove
- Nothing removed. All existing logic untouched (StageA/B, score, HTF, universe, warmup, existing risk sizing retained for qty/notional/leverage display).

## Implementation Plan
1. `engine/config.ts` — add 5 keys to `ScannerConfig` + `DEFAULT_CONFIG`
2. `scanner/riskCalc.ts` — add `computeLevels()` function (pure, no imports needed beyond constants)
3. `journal/trades.ts` — add new fields to `Trade` interface; update `openTrade` to call `computeLevels` for SL/TP and save new fields; update `TRADE_OPENED` event payload
4. `scanner/finalScore.ts` — call `computeLevels` for sl/tp1/tp2 on `ScoredCandidate`; add `slPct`, `rr`, `leverageX`, `realRiskPct` fields
5. `engine/scheduler.ts` — pass leverageX/slPct/rr/enableTP1/tp1RR from config into enriched candidate; use computeLevels in tryAutoEntry
6. `components/SettingsTab.tsx` — add "LEVERAGE & SL/TP" section with sliders for 5 new params
7. `components/Top5Panel.tsx` — add SL%, RR, LevX, RealRisk% columns
8. `components/TradesTab.tsx` — show leverageX, slPct, rr, realRiskPct on open trades
