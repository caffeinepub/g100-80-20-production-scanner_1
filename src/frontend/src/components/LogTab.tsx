import { useMemo, useState } from "react";
import { useEngine } from "../engine/engineContext";
import type { EventCategory, LedgerEvent } from "../journal/ledger";

const FILTER_CATEGORIES: Array<{
  label: string;
  value: "ALL" | EventCategory;
}> = [
  { label: "ALL", value: "ALL" },
  { label: "ENGINE", value: "ENGINE" },
  { label: "UNIVERSE", value: "UNIVERSE" },
  { label: "WARMUP", value: "WARMUP" },
  { label: "STAGE", value: "STAGE" },
  { label: "TRADES", value: "TRADES" },
  { label: "ERROR", value: "ERROR" },
];

const CATEGORY_COLORS: Record<EventCategory, string> = {
  ENGINE: "text-info",
  UNIVERSE: "text-blue-400",
  WARMUP: "text-warn",
  STAGE: "text-stage",
  TRADES: "text-long",
  ERROR: "text-short",
  SYSTEM: "text-muted-foreground",
};

function formatEventData(data?: Record<string, unknown>): string {
  if (!data || Object.keys(data).length === 0) return "";
  return Object.entries(data)
    .map(([k, v]) => `${k}=${JSON.stringify(v)}`)
    .join(" ")
    .slice(0, 120);
}

function EventRow({ event }: { event: LedgerEvent }) {
  const color = CATEGORY_COLORS[event.category] ?? "text-muted-foreground";
  const ts = new Date(event.ts).toLocaleTimeString("en-GB", { hour12: false });

  return (
    <div className="flex gap-2 py-1 border-b border-border/30 hover:bg-surface-2/50 px-2 text-[10px] font-mono">
      <span className="text-muted-foreground/60 shrink-0 w-16">{ts}</span>
      <span className={`shrink-0 w-32 font-medium ${color}`}>{event.type}</span>
      <span className="text-muted-foreground/80 truncate min-w-0">
        {formatEventData(event.data)}
      </span>
    </div>
  );
}

export function LogTab() {
  const { events } = useEngine();
  const [activeFilter, setActiveFilter] = useState<"ALL" | EventCategory>(
    "ALL",
  );

  const filtered = useMemo(() => {
    if (activeFilter === "ALL") return events;
    return events.filter((e) => e.category === activeFilter);
  }, [events, activeFilter]);

  return (
    <div className="h-full flex flex-col overflow-hidden">
      {/* Filter bar */}
      <div className="flex-shrink-0 px-2 py-1.5 border-b border-border overflow-x-auto touch-scroll">
        <div className="flex gap-1 min-w-max">
          {FILTER_CATEGORIES.map(({ label, value }) => (
            <button
              type="button"
              key={value}
              onClick={() => setActiveFilter(value)}
              className={`font-mono text-[9px] border rounded px-2 py-1 transition-colors whitespace-nowrap ${
                activeFilter === value
                  ? value === "ERROR"
                    ? "bg-short/20 border-short text-short"
                    : value === "TRADES"
                      ? "bg-long/20 border-long text-long"
                      : value === "ENGINE"
                        ? "bg-info/20 border-info text-info"
                        : "bg-foreground/10 border-foreground/30 text-foreground"
                  : "border-border text-muted-foreground hover:border-foreground/20 hover:text-foreground"
              }`}
            >
              {label}
              {value !== "ALL" && (
                <span className="ml-1 opacity-60">
                  ({events.filter((e) => e.category === value).length})
                </span>
              )}
            </button>
          ))}
        </div>
      </div>

      {/* Count */}
      <div className="flex-shrink-0 px-3 py-1 text-[9px] font-mono text-muted-foreground border-b border-border/30">
        {filtered.length} events
      </div>

      {/* Log list */}
      <div className="flex-1 overflow-y-auto touch-scroll">
        {filtered.length === 0 ? (
          <div className="flex items-center justify-center h-full font-mono text-[10px] text-muted-foreground">
            No events
          </div>
        ) : (
          filtered.map((event, i) => (
            <EventRow key={event.eventId ?? i} event={event} />
          ))
        )}
      </div>
    </div>
  );
}
