import { db, kalshiMonitorSettingsTable } from "@workspace/db";
import { sql } from "drizzle-orm";
import type { RoiLeaderboard } from "@workspace/api-zod";
import { AsyncTtlCache } from "./async-ttl-cache";
import { buildRoiRanking, ROI_STAKE, type RoiGroup, type RoiRollup, type RoiSort } from "./roi-ranking";
import { HISTORY_AUDIT_VERSION } from "./kalshi-market-history";
import { feeModel, feeSnapshotIsCurrent, FEE_MODEL_VERSION, type FeeSnapshot } from "./kalshi-fees";
import { readStoredFees } from "./kalshi-fee-store";
import { ROI_METHOD_VERSION, selectRoiEntries, type RoiUnit } from "./roi-method";
import type { RoiPhase } from "@workspace/api-zod";

type Options = {
  unit?: RoiUnit; phase?: RoiPhase;
  groupBy: RoiGroup; window: "all" | "30d" | "7d";
  band: "all" | "large" | "medium" | "small"; direction: "all" | "yes" | "no";
  minGames: number; page: number;
  sortBy?: RoiSort;
  coverage?: "verified" | "all";
};
const snapshots = new AsyncTtlCache<{ rows: RoiRollup[]; generatedAt: string; feeModel: RoiLeaderboard["feeModel"] }>(60_000, 4);
const iso = (date: string | Date | null) => date === null ? null : new Date(date).toISOString();
const windowStart = (window: Options["window"], now: Date) => window === "all" ? null :
  new Date(now.getTime() - (window === "7d" ? 7 : 30) * 86400_000);

export async function loadRoiRollups(
  options: Options, threshold: number, now: Date, executor: Pick<typeof db, "execute"> = db,
  feeSnapshot: FeeSnapshot | null = null,
) {
  const since = windowStart(options.window, now);
  const recent = new Date(now.getTime() - 7 * 86400_000);
  const amount = options.band === "small" ? sql`a.notional >= 1000 AND a.notional <= 5000` :
    options.band === "medium" ? sql`a.notional > 5000 AND a.notional < 10000` :
    options.band === "large" ? sql`a.notional >= ${threshold}` : sql`a.notional >= 1000`;
  // The full history is aggregated in PostgreSQL; no full execution download or graph cap.
  const result = await executor.execute(sql`
    WITH fee_catalog AS (
      SELECT ${JSON.stringify(feeSnapshotIsCurrent(feeSnapshot, now) ? feeSnapshot : null)}::jsonb AS rules
    ), base AS (
      SELECT a.*, s.result, s.terminal, s.checked_at, s.error,
        g.milestone_id IS NOT NULL AS identity_verified,
        CASE
          WHEN g.milestone_id IS NULL THEN 'unknown'
          WHEN g.checked_at <= a.created_time AND g.checked_at >= a.created_time - interval '120 seconds'
            AND NOT g.delayed AND g.error IS NULL AND g.state = 'finished' THEN 'unknown'
          WHEN g.checked_at <= a.created_time AND g.checked_at >= a.created_time - interval '120 seconds'
            AND NOT g.delayed AND g.error IS NULL AND g.state = 'live' AND g.source = 'live' THEN 'live'
          WHEN g.starts_at IS NOT NULL AND a.created_time <= g.starts_at - interval '10 minutes' THEN 'prematch'
          WHEN g.starts_at IS NOT NULL AND a.created_time < g.starts_at THEN 'nearStart'
          ELSE 'unknown' END AS phase,
        g.event_ticker IS NOT NULL AND (f.rules->'series'->split_part(a.ticker, '-', 1)) IS NOT NULL AS fee_known,
        coalesce(f.rules->'events'->g.event_ticker->>'feeType',
          f.rules->'series'->split_part(a.ticker, '-', 1)->>'feeType') AS fee_type,
        coalesce(f.rules->'events'->g.event_ticker->>'multiplier',
          f.rules->'series'->split_part(a.ticker, '-', 1)->>'multiplier')::numeric AS fee_multiplier,
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
          WHEN lower(trim(a.book_side)) = 'ask' THEN 'no' ELSE 'unknown' END AS side,
        CASE WHEN a.notional <= 5000 THEN 'small' WHEN a.notional < 10000 THEN 'medium' ELSE 'large' END AS money_band,
        to_char(date_trunc('week', a.created_time AT TIME ZONE 'America/New_York'), 'YYYY-MM-DD') AS week_start
      FROM kalshi_alerts a
      CROSS JOIN fee_catalog f
      LEFT JOIN kalshi_market_settlements s ON s.ticker = a.ticker
      LEFT JOIN kalshi_game_status g ON g.ticker = a.ticker
      LEFT JOIN kalshi_trade_history h ON h.ticker = a.ticker
      WHERE ${amount} AND a.created_time <= ${now}
        ${since ? sql`AND a.created_time >= ${since}` : sql``}
    ), classified AS (
      SELECT *,
        (price > 0 AND price <= 1 AND count > 0 AND count <> 'NaN'::numeric
          AND abs(notional - price * count) <= 0.010001 AND side IN ('yes','no')) AS input_valid,
        CASE WHEN NOT (price > 0 AND price <= 1 AND count > 0 AND count <> 'NaN'::numeric
            AND abs(notional - price * count) <= 0.010001) OR side = 'unknown'
          OR (terminal = true AND coalesce(result, '') NOT IN ('yes', 'no')) THEN 'excluded'
          WHEN error IS NOT NULL THEN 'pending'
          WHEN terminal = true AND result IN ('yes','no') AND history_verified = false
            AND ${options.coverage !== "all"} THEN 'incomplete'
          WHEN terminal = true AND result IN ('yes','no') THEN 'settled'
          ELSE 'pending' END AS category
      FROM base WHERE ${options.direction === "all" ? sql`true` : sql`side = ${options.direction}`}
    ), priced AS (
      SELECT *,
        CASE WHEN category = 'settled' AND fee_known AND fee_multiplier >= 0
          AND fee_type IN ('quadratic', 'quadratic_with_maker_fees', 'quadratic_with_combo_maker_fees')
          -- C = 100/P; current taker fee = 0.07 * M * C * P * (1-P).
          -- One $100 debit is already aligned, so direct-member rounding is
          -- equivalent to ceil(fee * 10000)/10000. Round PER execution, not sum.
          THEN ceil(7.0 * fee_multiplier * (1 - price) * 10000) / 10000
          ELSE NULL END AS entry_fee
      FROM classified
    ), ordered AS (
      SELECT *, row_number() OVER (
        PARTITION BY ticker, CASE WHEN price > 0 AND price <= 1 THEN least(9, floor(price * 10))::int ELSE -1 END,
          category, side, money_band, week_start, phase, input_valid
        ORDER BY created_time, trade_id
      ) AS entry_order FROM priced
    )
    SELECT ticker, max(sport) AS sport, max(event_title) AS "eventTitle",
      max(market_title) AS "marketTitle", max(game_id) AS "gameId", max(market_url) AS "marketUrl",
      CASE WHEN price > 0 AND price <= 1 THEN least(9, floor(price * 10))::int ELSE -1 END AS bucket, category, side,
      money_band AS "moneyBand", week_start AS "weekStart",
      phase, bool_and(identity_verified) AS "identityVerified", input_valid AS "inputValid",
      max(trade_id) FILTER (WHERE entry_order = 1) AS "firstTradeId",
      max(price) FILTER (WHERE entry_order = 1)::float8 AS "firstPrice",
      max(entry_fee) FILTER (WHERE entry_order = 1)::float8 AS "firstFee",
      bool_or(created_time >= ${recent}) FILTER (WHERE entry_order = 1) AS "firstIsRecent",
      max(result) AS "officialResult",
      count(*)::int AS trades,
      count(*) FILTER (WHERE category = 'settled' AND side = result)::int AS wins,
      coalesce(sum(CASE WHEN category = 'settled'
        THEN CASE WHEN side = result THEN 100.0 / nullif(price, 0) - 100.0 ELSE -100.0 END
        ELSE 0 END), 0)::float8 AS profit,
      count(*) FILTER (WHERE category = 'settled' AND created_time >= ${recent})::int AS "recentTrades",
      coalesce(sum(CASE WHEN category = 'settled' AND created_time >= ${recent}
        THEN CASE WHEN side = result THEN 100.0 / nullif(price, 0) - 100.0 ELSE -100.0 END
        ELSE 0 END), 0)::float8 AS "recentProfit",
      count(entry_fee)::int AS "feeTrades", coalesce(sum(entry_fee), 0)::float8 AS fees,
      count(entry_fee) FILTER (WHERE created_time >= ${recent})::int AS "recentFeeTrades",
      coalesce(sum(entry_fee) FILTER (WHERE created_time >= ${recent}), 0)::float8 AS "recentFees",
      min(created_time) AS "firstAt", max(created_time) AS "lastAt", max(checked_at) AS "checkedAt",
      bool_or(error IS NOT NULL) AS error
      , bool_and(history_verified) AS "historyVerified", bool_or(history_error) AS "historyError"
    FROM ordered GROUP BY ticker,
      CASE WHEN price > 0 AND price <= 1 THEN least(9, floor(price * 10))::int ELSE -1 END,
      category, side, money_band, week_start, phase, input_valid
  `);
  return {
    generatedAt: now.toISOString(),
    feeModel: feeModel(feeSnapshot, now),
    rows: result.rows.map(row => ({
      ...row, firstAt: iso(row.firstAt as Date)!, lastAt: iso(row.lastAt as Date)!,
      checkedAt: iso(row.checkedAt as Date | null),
    })) as RoiRollup[],
  };
}

/** Shared by the ranking and explorer colors; one read-only historical snapshot. */
export async function getRoiSnapshot(options: Options, now = new Date()) {
  const [[settings], fees] = await Promise.all([
    db.select({ minimum: kalshiMonitorSettingsTable.minimumNotional }).from(kalshiMonitorSettingsTable).limit(1),
    readStoredFees(),
  ]);
  const threshold = Math.max(10_000, settings?.minimum ?? 10_000);
  // Presentation grouping/pagination reuse the same short-lived, filter-isolated data.
  const key = JSON.stringify([options.window, options.band, options.direction, threshold, options.coverage ?? "verified",
    ROI_METHOD_VERSION, FEE_MODEL_VERSION, fees?.asOf, fees?.validUntil, feeSnapshotIsCurrent(fees, now)]);
  const snapshot = await snapshots.get(key, () => loadRoiRollups(options, threshold, now, db, fees));
  return { snapshot, threshold, fees };
}

export async function getRoiLeaderboard(options: Options, now = new Date()): Promise<RoiLeaderboard> {
  const { snapshot, threshold } = await getRoiSnapshot(options, now);
  const asOf = new Date(snapshot.generatedAt), sortBy = options.sortBy ?? "roi";
  const selected = selectRoiEntries(snapshot.rows, options.unit ?? "game", options.phase ?? "prematch");
  const { rows, summary } = buildRoiRanking(selected.rows, options.groupBy, options.minGames, {
    sortBy, now: asOf, since: windowStart(options.window, asOf), separatePatterns: options.unit !== "execution",
  });
  const pageSize = 25, totalPages = Math.ceil(rows.length / pageSize);
  const page = Math.max(1, Math.min(options.page, totalPages || 1));
  return {
    ...options, sortBy, largeTradeThreshold: threshold, coverage: options.coverage ?? "verified",
    page, totalPages, totalRows: rows.length, pageSize, stakePerTrade: ROI_STAKE,
    feeModel: snapshot.feeModel,
    methodology: selected.methodology,
    generatedAt: new Date(snapshot.generatedAt), summary, rows: rows.slice((page - 1) * pageSize, page * pageSize),
  };
}
