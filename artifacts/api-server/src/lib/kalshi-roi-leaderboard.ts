import { db, kalshiMonitorSettingsTable } from "@workspace/db";
import { sql } from "drizzle-orm";
import type { RoiLeaderboard } from "@workspace/api-zod";
import { AsyncTtlCache } from "./async-ttl-cache";
import { buildRoiRanking, ROI_STAKE, type RoiGroup, type RoiRollup } from "./roi-ranking";
import { HISTORY_AUDIT_VERSION } from "./kalshi-market-history";

type Options = {
  groupBy: RoiGroup; window: "all" | "30d" | "7d";
  band: "all" | "large" | "medium" | "small"; direction: "all" | "yes" | "no";
  minGames: number; page: number;
  coverage?: "verified" | "all";
};
const snapshots = new AsyncTtlCache<{ rows: RoiRollup[]; generatedAt: string }>(60_000, 4);
const iso = (date: string | Date | null) => date === null ? null : new Date(date).toISOString();

export async function loadRoiRollups(options: Options, threshold: number, now: Date, executor: Pick<typeof db, "execute"> = db) {
  const since = options.window === "all" ? null :
    new Date(now.getTime() - (options.window === "7d" ? 7 : 30) * 86400_000);
  const recent = new Date(now.getTime() - 7 * 86400_000);
  const amount = options.band === "small" ? sql`a.notional >= 1000 AND a.notional <= 5000` :
    options.band === "medium" ? sql`a.notional > 5000 AND a.notional < 10000` :
    options.band === "large" ? sql`a.notional >= ${threshold}` : sql`a.notional >= 1000`;
  // The full history is aggregated in PostgreSQL; no full execution download or graph cap.
  const result = await executor.execute(sql`
    WITH base AS (
      SELECT a.*, s.result, s.terminal, s.checked_at, s.error,
        coalesce(h.phase = 'complete' AND h.final_pass = true AND h.audited_at IS NOT NULL
          AND h.error IS NULL AND h.audit_version >= ${HISTORY_AUDIT_VERSION} AND h.capture_minimum <= 1000
          AND h.since_at IS NULL AND h.snapshot_at >= s.checked_at, false) AS history_verified,
        h.error IS NOT NULL AS history_error,
        coalesce(g.milestone_id, g.event_ticker,
          CASE WHEN split_part(a.ticker, '-', 2) <> ''
            THEN split_part(a.ticker, '-', 1) || '-' || split_part(a.ticker, '-', 2)
            ELSE a.ticker END) AS game_id,
        CASE WHEN lower(trim(a.outcome_side)) IN ('yes','no') THEN lower(trim(a.outcome_side))
          WHEN lower(trim(a.book_side)) = 'bid' THEN 'yes'
          WHEN lower(trim(a.book_side)) = 'ask' THEN 'no' ELSE 'unknown' END AS side
      FROM kalshi_alerts a
      LEFT JOIN kalshi_market_settlements s ON s.ticker = a.ticker
      LEFT JOIN kalshi_game_status g ON g.ticker = a.ticker
      LEFT JOIN kalshi_trade_history h ON h.ticker = a.ticker
      WHERE ${amount} AND a.created_time <= ${now}
        ${since ? sql`AND a.created_time >= ${since}` : sql``}
    ), classified AS (
      SELECT *,
        CASE WHEN NOT (price > 0 AND price <= 1 AND count > 0 AND count <> 'NaN'::numeric
            AND abs(notional - price * count) <= 0.010001) OR side = 'unknown'
          OR (terminal = true AND coalesce(result, '') NOT IN ('yes', 'no')) THEN 'excluded'
          WHEN terminal = true AND result IN ('yes','no') AND history_verified = false
            AND ${options.coverage !== "all"} THEN 'incomplete'
          WHEN terminal = true AND result IN ('yes','no') THEN 'settled'
          ELSE 'pending' END AS category
      FROM base WHERE ${options.direction === "all" ? sql`true` : sql`side = ${options.direction}`}
    )
    SELECT ticker, max(sport) AS sport, max(event_title) AS "eventTitle",
      max(market_title) AS "marketTitle", max(game_id) AS "gameId", max(market_url) AS "marketUrl",
      CASE WHEN price > 0 AND price <= 1 THEN least(9, floor(price * 10))::int ELSE -1 END AS bucket, category,
      count(*)::int AS trades,
      count(*) FILTER (WHERE category = 'settled' AND side = result)::int AS wins,
      coalesce(sum(CASE WHEN category = 'settled'
        THEN CASE WHEN side = result THEN 100.0 / nullif(price, 0) - 100.0 ELSE -100.0 END
        ELSE 0 END), 0)::float8 AS profit,
      count(*) FILTER (WHERE category = 'settled' AND created_time >= ${recent})::int AS "recentTrades",
      coalesce(sum(CASE WHEN category = 'settled' AND created_time >= ${recent}
        THEN CASE WHEN side = result THEN 100.0 / nullif(price, 0) - 100.0 ELSE -100.0 END
        ELSE 0 END), 0)::float8 AS "recentProfit",
      min(created_time) AS "firstAt", max(created_time) AS "lastAt", max(checked_at) AS "checkedAt",
      bool_or(error IS NOT NULL) AS error
      , bool_and(history_verified) AS "historyVerified", bool_or(history_error) AS "historyError"
    FROM classified GROUP BY ticker,
      CASE WHEN price > 0 AND price <= 1 THEN least(9, floor(price * 10))::int ELSE -1 END, category
  `);
  return {
    generatedAt: now.toISOString(),
    rows: result.rows.map(row => ({
      ...row, firstAt: iso(row.firstAt as Date)!, lastAt: iso(row.lastAt as Date)!,
      checkedAt: iso(row.checkedAt as Date | null),
    })) as RoiRollup[],
  };
}

export async function getRoiLeaderboard(options: Options, now = new Date()): Promise<RoiLeaderboard> {
  const [settings] = await db.select({ minimum: kalshiMonitorSettingsTable.minimumNotional })
    .from(kalshiMonitorSettingsTable).limit(1);
  const threshold = Math.max(10_000, settings?.minimum ?? 10_000);
  // Presentation grouping/pagination reuse the same short-lived, filter-isolated data.
  const key = JSON.stringify([options.window, options.band, options.direction, threshold, options.coverage ?? "verified"]);
  const snapshot = await snapshots.get(key, () => loadRoiRollups(options, threshold, now));
  const { rows, summary } = buildRoiRanking(snapshot.rows, options.groupBy, options.minGames);
  const pageSize = 25, totalPages = Math.ceil(rows.length / pageSize);
  const page = Math.max(1, Math.min(options.page, totalPages || 1));
  return {
    ...options, coverage: options.coverage ?? "verified", page, totalPages, totalRows: rows.length, pageSize, stakePerTrade: ROI_STAKE,
    generatedAt: new Date(snapshot.generatedAt), summary, rows: rows.slice((page - 1) * pageSize, page * pageSize),
  };
}
