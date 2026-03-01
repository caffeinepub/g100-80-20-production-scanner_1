import { emitEvent } from "../journal/ledger";
import { BASE_URL, FALLBACK_URL, MAX_CONCURRENCY } from "./config";
import { FETCH_RETRY_BASE_DELAY_MS, FETCH_RETRY_MAX } from "./constants";

// ── sleep helper ──────────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ── Single attempt fetch with AbortController timeout ─────────────────────────

async function fetchAttempt(url: string, timeoutMs: number): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { signal: controller.signal });
    clearTimeout(timer);
    if (response.status === 429) {
      emitEvent("FETCH_THROTTLED", { url, status: 429 }, "UNIVERSE");
      throw new Error("HTTP 429: Too Many Requests");
    }
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }
    return await response.json();
  } catch (err) {
    clearTimeout(timer);
    throw err;
  }
}

// ── fetchJson: primary → fallback failover + retry + exponential backoff ──────
//
// Strategy per spec:
//   Primary:   BASE_URL   (https://fapi.binance.com)
//   Secondary: FALLBACK_URL (https://data-api.binance.vision)
//
// For each attempt (0..FETCH_RETRY_MAX):
//   1. Try primary URL
//   2. If primary fails → try fallback URL (same path)
//   3. If both fail → backoff, then retry
// After all retries exhausted → emit FETCH_FAIL + throw

export async function fetchJson(
  url: string,
  timeoutMs: number,
  where: string,
  _runId?: number,
): Promise<unknown> {
  // Derive fallback URL by replacing the base host
  const fallbackUrl = url.startsWith(BASE_URL)
    ? FALLBACK_URL + url.slice(BASE_URL.length)
    : url.startsWith(FALLBACK_URL)
      ? BASE_URL + url.slice(FALLBACK_URL.length)
      : null;

  let lastError: unknown;

  for (let attempt = 0; attempt <= FETCH_RETRY_MAX; attempt++) {
    // 1. Try primary
    try {
      const data = await fetchAttempt(url, timeoutMs);
      return data;
    } catch (primaryErr) {
      const isAbort =
        primaryErr instanceof Error && primaryErr.name === "AbortError";
      if (isAbort) {
        // Timeout on primary → emit timeout, try fallback
        emitEvent(
          "FETCH_TIMEOUT",
          { where: `${where}:primary`, timeoutMs, retainedCount: 0 },
          "UNIVERSE",
        );
      }
      lastError = primaryErr;
    }

    // 2. Try fallback (if available and different URL)
    if (fallbackUrl && fallbackUrl !== url) {
      try {
        const data = await fetchAttempt(fallbackUrl, timeoutMs);
        return data;
      } catch (fallbackErr) {
        lastError = fallbackErr;
        const isAbort =
          fallbackErr instanceof Error && fallbackErr.name === "AbortError";
        if (isAbort) {
          emitEvent(
            "FETCH_TIMEOUT",
            { where: `${where}:fallback`, timeoutMs, retainedCount: 0 },
            "UNIVERSE",
          );
        }
      }
    }

    // 3. Both failed — backoff if more retries remain
    if (attempt < FETCH_RETRY_MAX) {
      const delay = FETCH_RETRY_BASE_DELAY_MS * 2 ** attempt;
      await sleep(delay);
    }
  }

  // All retries exhausted
  const reason =
    lastError instanceof Error ? lastError.message : String(lastError);
  emitEvent(
    "FETCH_FAIL",
    { where, reason, retainedCount: 0, error: reason },
    "UNIVERSE",
  );
  throw new Error(`FETCH_FAIL: ${where} — ${reason}`);
}

// ── Legacy RequestQueue (used by scheduler incremental klines) ────────────────
// Also uses failover via fetchJson internally

interface QueueItem {
  url: string;
  resolve: (value: unknown | null) => void;
  reject: (reason?: unknown) => void;
}

class RequestQueue {
  private queue: QueueItem[] = [];
  private active = 0;
  private readonly maxConcurrency: number;

  constructor(maxConcurrency: number) {
    this.maxConcurrency = maxConcurrency;
  }

  enqueue(url: string): Promise<unknown | null> {
    return new Promise((resolve, reject) => {
      this.queue.push({ url, resolve, reject });
      this.drain();
    });
  }

  private drain() {
    while (this.active < this.maxConcurrency && this.queue.length > 0) {
      const item = this.queue.shift();
      if (!item) break;
      this.active++;
      this.execute(item).finally(() => {
        this.active--;
        this.drain();
      });
    }
  }

  private async execute(item: QueueItem): Promise<void> {
    try {
      // Use fetchJson with failover (8s timeout, 1 retry via FETCH_RETRY_MAX)
      const result = await fetchJson(item.url, 8000, "queue");
      item.resolve(result);
    } catch (_err) {
      item.resolve(null); // resolve null on error to not break callers
    }
  }
}

const globalQueue = new RequestQueue(MAX_CONCURRENCY);

export async function fetchWithQueue(url: string): Promise<unknown | null> {
  return globalQueue.enqueue(url);
}
