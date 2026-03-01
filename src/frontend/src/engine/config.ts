export interface ScannerConfig {
  rsiPeriod: number;
  pollInterval: number;
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
}

export const DEFAULT_CONFIG: ScannerConfig = {
  rsiPeriod: 27,
  pollInterval: 60000,
  volFloor: 20_000_000,
  timeStopMin: 45,
  cooldownMin: 30,
  maxOpenTrades: 1,
  equityUSDT: 1000,
  riskPct: 0.65,
  maxLeverage: 10,
  enableShadowStats: true,
};

// Primary endpoint per spec: fapi.binance.com → fallback: data-api.binance.vision
export const BASE_URL = "https://fapi.binance.com";
export const FALLBACK_URL = "https://data-api.binance.vision";
export const MAX_CONCURRENCY = 4;
export const FETCH_TIMEOUT_MS = 12000;
export const FETCH_RETRY = 1;
export const FETCH_RETRY_BACKOFF_MS = 800;
export const MAX_UNIVERSE_HARD_CAP = 300;
export const STAGE_A_K = 60;
export const FULL_SCAN_INTERVAL_CYCLES = 5;
