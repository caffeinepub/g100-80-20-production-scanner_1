import { idbGet, idbGetAll } from "./idb";
import { emitEvent } from "./ledger";
import type { Trade } from "./trades";

export interface RehydrateResult {
  openTrades: Trade[];
  closedTrades: Trade[];
}

export async function rehydrate(): Promise<RehydrateResult> {
  emitEvent("REHYDRATE_START", {}, "SYSTEM");

  try {
    const [allTrades, snapshot] = await Promise.all([
      idbGetAll("trades"),
      idbGet("snapshots", "openPositions"),
    ]);

    const rawTrades = allTrades as (Trade & Record<string, unknown>)[];
    // Migrate legacy trades that lack RR / risk-calc fields
    const trades: Trade[] = rawTrades.map((t) => ({
      ...t,
      remainingSize:
        t.remainingSize ??
        (t.status === "TP1_HIT" ? 0.5 : t.status === "CLOSED" ? 0 : 1.0),
      tp1Hit: t.tp1Hit ?? (t.status === "TP1_HIT" || t.status === "CLOSED"),
      tp2Hit: t.tp2Hit ?? t.exitReason === "TP2",
      tp1HitCount: t.tp1HitCount ?? 0,
      tp2HitCount: t.tp2HitCount ?? 0,
      slHitCount: t.slHitCount ?? 0,
      // Risk-calc fields — default 0 for legacy trades (pre-risk-engine)
      riskUSDT: t.riskUSDT ?? 0,
      riskPct: t.riskPct ?? 0,
      qty: t.qty ?? 0,
      notionalUSDT: t.notionalUSDT ?? 0,
      effectiveLeverage: t.effectiveLeverage ?? 0,
      marginUsed: t.marginUsed ?? 0,
      // runId — default 0 for legacy trades
      runId: t.runId ?? 0,
    }));
    const snapshotData = snapshot as { openIds?: string[] } | undefined;
    const openIds = new Set(snapshotData?.openIds ?? []);

    // Reconcile: mark trades based on snapshot
    let repaired = 0;
    const openTrades: Trade[] = [];
    const closedTrades: Trade[] = [];

    for (const trade of trades) {
      if (trade.status === "CLOSED") {
        closedTrades.push(trade);
      } else if (
        openIds.has(trade.id) ||
        trade.status === "OPEN" ||
        trade.status === "TP1_HIT"
      ) {
        openTrades.push(trade);
      } else {
        // Trade was supposed to be open but not in snapshot, mark as closed
        closedTrades.push({ ...trade, status: "CLOSED", exitReason: "MANUAL" });
        repaired++;
      }
    }

    emitEvent(
      "REHYDRATE_END",
      {
        open: openTrades.length,
        closed: closedTrades.length,
        repaired,
      },
      "SYSTEM",
    );

    return { openTrades, closedTrades };
  } catch (err) {
    emitEvent(
      "REHYDRATE_END",
      {
        open: 0,
        closed: 0,
        repaired: 0,
        error: err instanceof Error ? err.message : String(err),
      },
      "SYSTEM",
    );
    return { openTrades: [], closedTrades: [] };
  }
}
