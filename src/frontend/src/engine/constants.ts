// engine/constants.ts — reliability patch constants

export const INIT_UNIVERSE_TIMEOUT_MS = 8000;
export const INIT_TICKER_TIMEOUT_MS = 8000;
export const INIT_WARMUP_TIMEOUT_MS = 180_000;
export const FETCH_RETRY_MAX = 2;
export const FETCH_RETRY_BASE_DELAY_MS = 350;
export const UNIVERSE_MIN_REQUIRED = 25;
export const MAX_UNIVERSE_HARD_CAP = 300;
export const WARMUP_CONCURRENCY = 6;
export const HEARTBEAT_MS = 1000;

// RR Trade Engine constants — immutable, no runtime modification
export const TP1_RR = 2.2;
export const TP2_RR = 3.0;
export const TP1_CLOSE_PERCENT = 0.5;
export const TP2_CLOSE_PERCENT = 0.5;

// SL model v2.1 — structural + ATR, hard clamp
export const MIN_SL_DISTANCE_PCT = 0.2; // was 0.15 — replaced by patch v2.1
export const MAX_SL_DISTANCE_PCT = 1.2; // was 2.5 — replaced by patch v2.1

// Risk sizing minimum notional
export const MIN_NOTIONAL_USDT = 20;

// Number of candles used for structural SL (1m)
export const STRUCTURAL_SL_CANDLES = 12;

// ATR period for volatility SL component
export const ATR_PERIOD = 14;
// ATR multiplier for volatility SL
export const ATR_MULTIPLIER = 0.8;

// HTF context gate — EMA periods (5m timeframe)
export const HTF_EMA_FAST = 9;
export const HTF_EMA_SLOW = 20;
// HTF RSI threshold
export const HTF_RSI_THRESHOLD = 50;
