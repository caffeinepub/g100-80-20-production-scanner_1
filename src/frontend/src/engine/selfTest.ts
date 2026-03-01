import { toast } from "sonner";
import { emitEvent } from "../journal/ledger";
import { getLastRSI } from "../scanner/rsi";
import { BASE_URL } from "./config";
import { fetchWithQueue } from "./fetcher";

const TEST_SYMBOLS = ["BTCUSDT", "ETHUSDT", "SOLUSDT"] as const;
const TEST_TFS = ["1m", "5m", "15m", "1h"] as const;

export async function runSelfTest(): Promise<void> {
  emitEvent("SELFTEST_START", { symbols: [...TEST_SYMBOLS] }, "ENGINE");

  try {
    for (const sym of TEST_SYMBOLS) {
      for (const tf of TEST_TFS) {
        const url = `${BASE_URL}/fapi/v1/klines?symbol=${sym}&interval=${tf}&limit=200`;
        const data = await fetchWithQueue(url);
        if (!data) throw new Error(`No data for ${sym} ${tf}`);
        const klines = data as unknown[][];
        const closes = klines.map((k) => Number.parseFloat(k[4] as string));
        const rsi = getLastRSI(closes, 27);
        if (!Number.isFinite(rsi)) throw new Error(`RSI NaN for ${sym} ${tf}`);
      }
    }
    emitEvent(
      "SELFTEST_OK",
      { symbols: [...TEST_SYMBOLS], tfs: [...TEST_TFS] },
      "ENGINE",
    );
    toast.success("Self-test passed ✓ BTC/ETH/SOL all TFs OK");
  } catch (e) {
    const errMsg = e instanceof Error ? e.message : String(e);
    emitEvent("SELFTEST_FAIL", { error: errMsg }, "ERROR");
    toast.error(`Self-test failed: ${errMsg}`);
  }
}
