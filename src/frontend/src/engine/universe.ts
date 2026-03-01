import { emitEvent } from "../journal/ledger";
import { BASE_URL, type ScannerConfig } from "./config";
import {
  INIT_TICKER_TIMEOUT_MS,
  INIT_UNIVERSE_TIMEOUT_MS,
  MAX_UNIVERSE_HARD_CAP,
  UNIVERSE_MIN_REQUIRED,
} from "./constants";
import { fetchJson } from "./fetcher";

export interface UniverseSymbol {
  symbol: string;
  quoteVolume: number;
  lastPrice: number;
}

export interface UniverseResult {
  symbols: UniverseSymbol[];
  filterLevelUsed: "20M" | "5M" | "1M";
  eligibleCount: number;
  retainedUsed: boolean;
}

const EXCLUDE_PATTERNS = ["DOWN", "UP", "BULL", "BEAR", "DOM", "HALF", "1000"];

interface ExchangeInfoSymbol {
  symbol: string;
  contractType: string;
  quoteAsset: string;
  status: string;
}

interface Ticker24hr {
  symbol: string;
  quoteVolume: string;
  lastPrice: string;
}

export async function buildUniverse(
  config: ScannerConfig,
  prevUniverse: UniverseSymbol[],
  runId: number,
  getCurrentRunId: () => number,
): Promise<UniverseResult> {
  const t0 = Date.now();

  try {
    if (getCurrentRunId() !== runId) throw new Error("stale runId");

    // Fetch exchangeInfo
    const exchangeRaw = await fetchJson(
      `${BASE_URL}/fapi/v1/exchangeInfo`,
      INIT_UNIVERSE_TIMEOUT_MS,
      "exchangeInfo",
      runId,
    );

    if (getCurrentRunId() !== runId) throw new Error("stale runId");

    // Fetch ticker24h
    const tickerRaw = await fetchJson(
      `${BASE_URL}/fapi/v1/ticker/24hr`,
      INIT_TICKER_TIMEOUT_MS,
      "ticker24h",
      runId,
    );

    if (getCurrentRunId() !== runId) throw new Error("stale runId");

    const exchangeInfo = exchangeRaw as { symbols: ExchangeInfoSymbol[] };
    const tickers = tickerRaw as Ticker24hr[];

    const totalFromExchange = exchangeInfo.symbols?.length ?? 0;

    // Step 1: Base filter
    const baseFiltered = (exchangeInfo.symbols ?? []).filter((s) => {
      if (s.contractType !== "PERPETUAL") return false;
      if (s.quoteAsset !== "USDT") return false;
      if (s.status !== "TRADING") return false;
      for (const pat of EXCLUDE_PATTERNS) {
        if (s.symbol.includes(pat)) return false;
      }
      return true;
    });

    const afterBaseFilter = baseFiltered.length;

    // Step 2: Build tickerMap
    const tickerMap: Record<
      string,
      { quoteVolume: number; lastPrice: number }
    > = {};
    for (const t of tickers ?? []) {
      const qv = Number(t.quoteVolume);
      const lp = Number(t.lastPrice);
      if (Number.isFinite(qv) && Number.isFinite(lp) && lp > 0) {
        tickerMap[t.symbol] = { quoteVolume: qv, lastPrice: lp };
      }
    }

    // Join base-filtered with ticker
    const withTicker: UniverseSymbol[] = [];
    for (const s of baseFiltered) {
      const t = tickerMap[s.symbol];
      if (t) {
        withTicker.push({
          symbol: s.symbol,
          quoteVolume: t.quoteVolume,
          lastPrice: t.lastPrice,
        });
      }
    }

    // Step 3: Liquidity floor tiers
    const primaryFloor = Math.max(config.volFloor, 20_000_000);
    let filterLevelUsed: "20M" | "5M" | "1M" = "20M";
    let afterFloor = withTicker.filter((s) => s.quoteVolume >= primaryFloor);

    if (afterFloor.length < 15) {
      filterLevelUsed = "5M";
      afterFloor = withTicker.filter((s) => s.quoteVolume >= 5_000_000);
    }
    if (afterFloor.length < 10) {
      filterLevelUsed = "1M";
      afterFloor = withTicker.filter((s) => s.quoteVolume >= 1_000_000);
    }

    const afterLiquidityFilter = afterFloor.length;

    // Step 4: Sort + cap
    afterFloor.sort((a, b) => {
      if (b.quoteVolume !== a.quoteVolume) return b.quoteVolume - a.quoteVolume;
      return a.symbol.localeCompare(b.symbol);
    });
    const finalSymbols = afterFloor.slice(0, MAX_UNIVERSE_HARD_CAP);
    const finalCount = finalSymbols.length;
    const durationMs = Date.now() - t0;

    // Always emit snapshot
    emitEvent(
      "UNIVERSE_SNAPSHOT",
      {
        runId,
        totalFromExchange,
        afterBaseFilter,
        afterLiquidityFilter,
        finalCount,
        filterLevelUsed,
        retainedUsed: false,
        durationMs,
      },
      "UNIVERSE",
    );

    // Minimum validation
    if (finalCount < UNIVERSE_MIN_REQUIRED) {
      emitEvent(
        "UNIVERSE_INVALID",
        { finalCount, minRequired: UNIVERSE_MIN_REQUIRED },
        "UNIVERSE",
      );
      throw new Error(
        `UNIVERSE_INVALID: finalCount=${finalCount} < ${UNIVERSE_MIN_REQUIRED}`,
      );
    }

    return {
      symbols: finalSymbols,
      filterLevelUsed,
      eligibleCount: finalCount,
      retainedUsed: false,
    };
  } catch (err) {
    // Check if this is a stale-runId abort — just propagate
    const msg = err instanceof Error ? err.message : String(err);
    if (msg === "stale runId") throw err;

    const retainedCount = prevUniverse.length;

    if (retainedCount > 0) {
      emitEvent(
        "FETCH_FAIL",
        { where: "buildUniverse", reason: msg, retainedCount },
        "UNIVERSE",
      );
      emitEvent(
        "UNIVERSE_SNAPSHOT",
        {
          runId,
          totalFromExchange: 0,
          afterBaseFilter: 0,
          afterLiquidityFilter: retainedCount,
          finalCount: retainedCount,
          filterLevelUsed: "20M",
          retainedUsed: true,
          durationMs: Date.now() - t0,
        },
        "UNIVERSE",
      );
      return {
        symbols: prevUniverse,
        filterLevelUsed: "20M",
        eligibleCount: retainedCount,
        retainedUsed: true,
      };
    }

    // No retained universe — fatal
    emitEvent("ENGINE_ERROR", { reason: "UNIVERSE_FETCH_FAILED" }, "ERROR");
    throw err;
  }
}
