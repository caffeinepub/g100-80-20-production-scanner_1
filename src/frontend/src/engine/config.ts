export type HtfMode = "OFF" | "SOFT" | "HARD";

export interface ScannerConfig {
  rsiPeriod: number;
  pollInterval: number; // ms between scan cycles (default 15000)
  volFloor: number;
  timeStopMin: number;
  cooldownMin: number;
  maxOpenTrades: number;
  // Risk-based sizing (replaces stopLossFromEntry percent model)
  equityUSDT: number; // default 1000, min 10, max 1000000
  riskPct: number; // default 0.65, min 0.05, max 2.0  (percent, e.g. 0.65 = 0.65%)
  maxLeverage: number; // default 10, min 1, max 50
  // Shadow Stats — HTF_OFF parallel simulation (additive only, no live trade impact)
  enableShadowStats: boolean; // default true
  // HTF filter mode: OFF = ignored, SOFT = score bias only, HARD = strict gate
  htfMode: HtfMode; // default "SOFT"
  // ── Risk & Leverage Controls (v1.0) ──────────────────────────────────────
  /** Manual leverage multiplier (1–10, integer, default 3) */
  leverageX: number;
  /** Stop-loss distance as % of entry price (0.20–5.00, step 0.05, default 0.65) */
  slPct: number;
  /** Risk-reward ratio: TP2 distance = SL distance × rr (1.0–5.0, step 0.1, default 3.0) */
  rr: number;
  /** Enable optional TP1 partial level (default false) */
  enableTP1: boolean;
  /** TP1 RR multiplier (0.5–3.0, step 0.1, default 1.0) — only used if enableTP1=true */
  tp1RR: number;
}

export const DEFAULT_CONFIG: ScannerConfig = {
  rsiPeriod: 27,
  pollInterval: 15000,
  volFloor: 20_000_000,
  timeStopMin: 45,
  cooldownMin: 30,
  maxOpenTrades: 1,
  equityUSDT: 1000,
  riskPct: 0.65,
  maxLeverage: 10,
  enableShadowStats: true,
  htfMode: "SOFT",
  // Risk & Leverage Controls defaults
  leverageX: 3,
  slPct: 0.65,
  rr: 3.0,
  enableTP1: false,
  tp1RR: 1.0,
};

// Primary endpoint per spec: fapi.binance.com → fallback: data-api.binance.vision
export const BASE_URL = "https://fapi.binance.com";
export const FALLBACK_URL = "https://data-api.binance.vision";
export const MAX_CONCURRENCY = 4;
export const FETCH_TIMEOUT_MS = 12000;
export const FETCH_RETRY = 1;
export const FETCH_RETRY_BACKOFF_MS = 800;
export const STAGE_A_K = 60;
