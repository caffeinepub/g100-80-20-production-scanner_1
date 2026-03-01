import { emitEvent } from "../journal/ledger";
import { BASE_URL } from "./config";
import { INIT_WARMUP_TIMEOUT_MS, WARMUP_CONCURRENCY } from "./constants";
import { fetchJson } from "./fetcher";
import type { UniverseSymbol } from "./universe";

export type Timeframe = "1m" | "5m" | "15m" | "1h";
export const TIMEFRAMES: Timeframe[] = ["1m", "5m", "15m", "1h"];

export type RsiBuffers = Map<string, Record<Timeframe, number[]>>;

export interface WarmupResult {
  buffers: RsiBuffers;
  loadedCount: number;
}

async function runWithConcurrency<T>(
  tasks: (() => Promise<T>)[],
  concurrency: number,
): Promise<T[]> {
  const results: T[] = new Array(tasks.length);
  let index = 0;

  async function worker() {
    while (index < tasks.length) {
      const i = index++;
      results[i] = await tasks[i]();
    }
  }

  const workers = Array.from(
    { length: Math.min(concurrency, tasks.length) },
    () => worker(),
  );
  await Promise.all(workers);
  return results;
}

export async function warmupUniverse(
  symbols: UniverseSymbol[],
  rsiPeriod: number,
  runId: number,
  getCurrentRunId: () => number,
): Promise<WarmupResult> {
  const limit = Math.max(200, rsiPeriod * 4);
  const buffers: RsiBuffers = new Map();
  const tfs = TIMEFRAMES;
  const totalTasks = symbols.length;
  let done = 0;
  let eligible = 0;

  const warmupStart = Date.now();

  emitEvent(
    "WARMUP_START",
    { runId, totalTasks, symbols: symbols.map((s) => s.symbol), tfs },
    "WARMUP",
  );

  // Progress reporter: emit every 1s and every 10 tasks
  let lastProgressEmit = Date.now();
  function maybeEmitProgress(force = false) {
    const now = Date.now();
    if (force || done % 10 === 0 || now - lastProgressEmit >= 1000) {
      lastProgressEmit = now;
      emitEvent(
        "WARMUP_PROGRESS",
        { runId, done, total: totalTasks, eligible, stage: "loading" },
        "WARMUP",
      );
    }
  }

  const tasks = symbols.map((sym) => async () => {
    // Check timeout
    if (Date.now() - warmupStart > INIT_WARMUP_TIMEOUT_MS) return;
    if (getCurrentRunId() !== runId) return;

    const tfData: Record<Timeframe, number[]> = {
      "1m": [],
      "5m": [],
      "15m": [],
      "1h": [],
    };

    for (const tf of tfs) {
      if (getCurrentRunId() !== runId) return;
      if (Date.now() - warmupStart > INIT_WARMUP_TIMEOUT_MS) return;

      const url = `${BASE_URL}/fapi/v1/klines?symbol=${sym.symbol}&interval=${tf}&limit=${limit}`;
      try {
        const raw = await fetchJson(
          url,
          8000,
          `warmup:${sym.symbol}:${tf}`,
          runId,
        );
        if (Array.isArray(raw)) {
          tfData[tf] = (raw as unknown[][]).map((k) =>
            Number.parseFloat(k[4] as string),
          );
        } else {
          emitEvent(
            "WARMUP_FETCH_ERR",
            { symbol: sym.symbol, tf, reason: "non-array response" },
            "WARMUP",
          );
        }
      } catch (err) {
        emitEvent(
          "WARMUP_FETCH_ERR",
          {
            symbol: sym.symbol,
            tf,
            reason: err instanceof Error ? err.message : String(err),
          },
          "WARMUP",
        );
        // Continue — don't abort whole warmup on single task failure
      }
    }

    if (getCurrentRunId() !== runId) return;

    buffers.set(sym.symbol, tfData);
    done++;
    // Count eligible: symbol with at least 1m data loaded
    if (tfData["1m"].length > 0) eligible++;

    maybeEmitProgress();
  });

  // Run with concurrency and overall timeout guard
  const timeoutPromise = new Promise<void>((resolve) =>
    setTimeout(resolve, INIT_WARMUP_TIMEOUT_MS),
  );

  const warmupPromise = runWithConcurrency(tasks, WARMUP_CONCURRENCY);

  const raceResult = await Promise.race([
    warmupPromise.then(() => "done" as const),
    timeoutPromise.then(() => "timeout" as const),
  ]);

  if (
    raceResult === "timeout" ||
    Date.now() - warmupStart > INIT_WARMUP_TIMEOUT_MS
  ) {
    emitEvent(
      "WARMUP_ABORTED",
      { runId, reason: "WARMUP_TIMEOUT", done, total: totalTasks, eligible },
      "WARMUP",
    );
    throw new Error("WARMUP_TIMEOUT");
  }

  if (getCurrentRunId() !== runId) {
    return { buffers, loadedCount: buffers.size };
  }

  const durationMs = Date.now() - warmupStart;
  maybeEmitProgress(true);

  emitEvent(
    "WARMUP_COMPLETE",
    { runId, done: buffers.size, total: totalTasks, eligible, durationMs },
    "WARMUP",
  );

  return { buffers, loadedCount: buffers.size };
}
