import { idbPut } from "./idb";

export type EventCategory =
  | "ENGINE"
  | "UNIVERSE"
  | "WARMUP"
  | "STAGE"
  | "TRADES"
  | "ERROR"
  | "SYSTEM";

export interface LedgerEvent {
  eventId?: number;
  ts: number;
  type: string;
  data?: Record<string, unknown>;
  category: EventCategory;
}

const EVENT_CATEGORIES: Record<string, EventCategory> = {
  REHYDRATE_START: "SYSTEM",
  REHYDRATE_END: "SYSTEM",
  ENGINE_START: "ENGINE",
  ENGINE_READY: "ENGINE",
  ENGINE_STOPPED: "ENGINE",
  ENGINE_STOP_REQUEST: "ENGINE",
  START_BLOCKED: "ENGINE",
  INIT_START: "ENGINE",
  INIT_STEP: "ENGINE",
  UNIVERSE_LOAD: "UNIVERSE",
  UNIVERSE_SNAPSHOT: "UNIVERSE",
  UNIVERSE_INVALID: "UNIVERSE",
  FETCH_FAIL: "UNIVERSE",
  FETCH_TIMEOUT: "UNIVERSE",
  FETCH_THROTTLED: "UNIVERSE",
  FETCH_OK: "UNIVERSE",
  WARMUP_START: "WARMUP",
  WARMUP_PROGRESS: "WARMUP",
  WARMUP_COMPLETE: "WARMUP",
  WARMUP_ABORTED: "WARMUP",
  WARMUP_FETCH_ERR: "WARMUP",
  WARMUP_INPUT_ZERO: "WARMUP",
  ENGINE_ERROR: "ERROR",
  STAGE_A: "STAGE",
  STAGE_B: "STAGE",
  TOP5: "STAGE",
  TRADE_OPEN: "TRADES",
  TRADE_CLOSE: "TRADES",
  TP1_HIT: "TRADES",
  TRADE_OPENED: "TRADES",
  TRADE_REJECTED: "TRADES",
  TRADE_SL_HIT: "TRADES",
  TRADE_TP1_HIT: "TRADES",
  TRADE_TP2_HIT: "TRADES",
  TRADE_CLOSED: "TRADES",
  ENTRY_BLOCKED_MAX_OPEN: "TRADES",
  RISK_CALC_OK: "TRADES",
  RISK_CALC_REJECT: "TRADES",
  STAGEA_ZERO_DETECTED: "STAGE",
  STAGEA_RESCUE_APPLIED: "STAGE",
  STAGEA_RESCUE_END: "STAGE",
  TOP5_EMPTY: "STAGE",
  SELFTEST_OK: "ENGINE",
  SELFTEST_FAIL: "ERROR",
  AUTO_ENTRY_ATTEMPT: "TRADES",
  AUTO_ENTRY_SUCCESS: "TRADES",
  AUTO_ENTRY_BLOCKED: "TRADES",
  TRADE_TIME_STOP: "TRADES",
  // Stability Patch v2.1 — HTF gate
  ENTRY_BLOCKED_HTF: "TRADES",
  HTF_GATE_PASS: "TRADES",
  // Stability Patch v2.1 — SL model
  SL_MODEL: "TRADES",
  // Shadow Stats module — HTF_OFF parallel simulation
  SHADOW_ENTRY_CREATED: "TRADES",
  SHADOW_TRADE_CLOSED: "TRADES",
};

// In-memory event store
let events: LedgerEvent[] = [];
let subscribers: Array<(events: LedgerEvent[]) => void> = [];

export function emitEvent(
  type: string,
  data?: Record<string, unknown>,
  category?: EventCategory,
): void {
  const resolvedCategory = category ?? EVENT_CATEGORIES[type] ?? "SYSTEM";
  const event: LedgerEvent = {
    ts: Date.now(),
    type,
    data,
    category: resolvedCategory,
  };

  events = [event, ...events].slice(0, 2000); // keep last 2000 events

  // Persist to IDB (fire-and-forget)
  idbPut("ledgerEvents", event).catch(() => {
    // silently ignore IDB errors
  });

  // Notify subscribers
  for (const cb of subscribers) {
    cb(events);
  }
}

export function subscribeEvents(
  cb: (events: LedgerEvent[]) => void,
): () => void {
  subscribers.push(cb);
  return () => {
    subscribers = subscribers.filter((s) => s !== cb);
  };
}

export function getEvents(): LedgerEvent[] {
  return events;
}

export function setEvents(loaded: LedgerEvent[]): void {
  events = loaded;
}
