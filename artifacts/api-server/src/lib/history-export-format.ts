import { publicDirection } from "./telegram-trade-direction";

export const HISTORY_EXPORT_ROWS_PER_PART = 100_000;

export function parseHistorySnapshotAt(value: string | undefined): Date | undefined {
  if (value === undefined) return undefined;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed;
}

export type HistoryExportRow = {
  tradeId: string; ticker: string; title: string; eventTitle: string | null;
  marketTitle: string | null; sport: string; outcomeSide: string; bookSide: string;
  price: number; count: number; notional: number; createdTime: Date;
  blockTrade: boolean; marketUrl: string; savedAt: Date;
};
export type HistoryEnrichment = {
  startsAt: Date | null; state: string | null; gameResult: string | null;
  historyPhase: string | null; historyMinimum: number | null;
  milestoneId?: string | null; statusSource?: string | null; statusCheckedAt?: Date | null;
  officialResult?: string | null; settlementTerminal?: boolean | null; settlementCheckedAt?: Date | null;
  settlementError?: string | null;
};

export function valueBand(usd: number) {
  return usd < 1000 ? "below_1000" : usd <= 5000 ? "1000_to_5000" :
    usd < 10000 ? "over_5000_under_10000" : "10000_and_above";
}

export function exportTrade(t: HistoryExportRow, extra: HistoryEnrichment) {
  return {
    trade_id: t.tradeId, market_ticker: t.ticker, sport: t.sport,
    event_title: t.eventTitle, market_title: t.marketTitle, title: t.title,
    executed_at_utc: t.createdTime.toISOString(), saved_at_utc: t.savedAt.toISOString(),
    public_direction: publicDirection(t.outcomeSide, undefined, t.bookSide),
    raw_outcome_side: t.outcomeSide, raw_book_side: t.bookSide,
    execution_price_usd: t.price, contracts: t.count, value_usd: t.notional,
    value_band: valueBand(t.notional), block_trade: t.blockTrade, market_url: t.marketUrl,
    game_starts_at_utc: extra.startsAt?.toISOString() ?? null,
    game_state: extra.state, final_score: extra.gameResult,
    history_import_phase: extra.historyPhase, history_capture_minimum_usd: extra.historyMinimum,
    game_milestone_id: extra.milestoneId ?? null,
    game_status_source: extra.statusSource ?? null,
    game_status_checked_at_utc: extra.statusCheckedAt?.toISOString() ?? null,
    official_market_result: extra.officialResult ?? null,
    official_settlement_terminal: extra.settlementTerminal ?? null,
    official_settlement_checked_at_utc: extra.settlementCheckedAt?.toISOString() ?? null,
    official_settlement_error: extra.settlementError ?? null,
  };
}

export const EXPORT_COLUMNS = [
  "trade_id", "market_ticker", "sport", "event_title", "market_title", "title",
  "executed_at_utc", "saved_at_utc", "public_direction", "raw_outcome_side", "raw_book_side",
  "execution_price_usd", "contracts", "value_usd", "value_band", "block_trade", "market_url",
  "game_starts_at_utc", "game_state", "final_score", "history_import_phase", "history_capture_minimum_usd",
  "game_milestone_id", "game_status_source", "game_status_checked_at_utc", "official_market_result",
  "official_settlement_terminal", "official_settlement_checked_at_utc", "official_settlement_error",
] as const;

/** Quote every cell and neutralize spreadsheet formulas, without changing JSON. */
export function csvCell(value: unknown) {
  let text = value == null ? "" : String(value);
  if (typeof value === "string" && /^\s*[=+\-@\t\r\n]/u.test(text)) text = `'${text}`;
  return `"${text.replaceAll('"', '""')}"`;
}
export function csvTrade(row: ReturnType<typeof exportTrade>) {
  return EXPORT_COLUMNS.map(key => csvCell(row[key])).join(",") + "\r\n";
}

export function serializeHistoryChunk(
  rows: Array<ReturnType<typeof exportTrade>>,
  format: "json" | "csv",
  hasEarlierRows: boolean,
) {
  return rows.map((row, index) => format === "json"
    ? `${hasEarlierRows || index > 0 ? "," : ""}${JSON.stringify(row)}`
    : csvTrade(row)).join("");
}

export function buildHistoryExportParts(totalTrades: number, snapshotAt: string) {
  const safeTotal = Math.max(0, Math.trunc(totalTrades));
  const totalParts = Math.ceil(safeTotal / HISTORY_EXPORT_ROWS_PER_PART);
  return {
    totalTrades: safeTotal,
    rowsPerPart: HISTORY_EXPORT_ROWS_PER_PART,
    snapshotAt,
    parts: Array.from({ length: totalParts }, (_, index) => ({
      part: index + 1,
      trades: Math.min(HISTORY_EXPORT_ROWS_PER_PART, safeTotal - index * HISTORY_EXPORT_ROWS_PER_PART),
    })),
  };
}

export function exportMetadata(total: number, markets: number, from: string | null, to: string | null, at: string) {
  return {
    schemaVersion: 2, source: "Fieldnote / Kalshi public sports trades",
    exportedAt: at, scope: "All executions stored in this application's database; all bands and game states",
    totalTrades: total, totalMarkets: markets, earliestExecutionAt: from, latestExecutionAt: to,
    currency: "USD", timezone: "UTC", order: "trade_id ascending, not execution time",
    fields: {
      public_direction: "yes = public direction in favor; no = against; unknown = insufficient public data. Not proof of opening or closing a position.",
      execution_price_usd: "Stored executed-side price per contract, not a current tradable quote or a calibrated winning probability.",
      value_usd: "Executed-side price multiplied by contracts; each record is an individual public execution.",
      saved_at_utc: "When this application imported the record, not when it executed.",
      final_score: "Saved sports score when available; null means unavailable, not a tied or unfinished game.",
      official_market_result: "Official market resolution from the stored Kalshi settlement, not inferred from score. ROI requires terminal true, no error and a supported yes/no result. Null is unknown, never a loss.",
      game_starts_at_utc: "Stored milestone schedule, not proof of actual kickoff. A past schedule alone does not prove an execution was live.",
      game_status_checked_at_utc: "Time of the last stored status observation, not necessarily the status at trade execution. A later observation must not be used to reconstruct a past live state.",
      history_import_phase: "Import progress per market. complete refers to the stored import's configured coverage, not every exchange execution.",
      history_capture_minimum_usd: "Historical import threshold; older imports can have a different minimum.",
    },
    limitations: [
      "This is the complete saved dataset, NOT all transactions ever made on Kalshi. Uncollected periods and trades below capture thresholds may be absent.",
      "There is no buyer identity, confirmed sale/position close, verified injury/lineup data, order-book depth or guaranteed predictive signal.",
      "Imported historical data is not new live activity. Historical outcomes must not be used as if known at prediction time.",
      "JSON preserves source strings; CSV prefixes potentially executable spreadsheet strings with an apostrophe.",
    ],
  };
}
