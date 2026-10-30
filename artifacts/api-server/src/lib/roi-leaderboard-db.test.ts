import assert from "node:assert/strict";
import { after, test } from "node:test";
import { db, pool } from "@workspace/db";
import { sql, type SQLWrapper } from "drizzle-orm";
import { GetKalshiLeaderboardResponse, GetKalshiLeaderboardQueryParams } from "@workspace/api-zod";
import { getRoiLeaderboard, loadRoiRollups } from "./kalshi-roi-leaderboard";
import { buildRoiRanking } from "./roi-ranking";
import { HISTORY_AUDIT_VERSION } from "./kalshi-market-history";

after(() => pool.end());

test("read-only development ranking separates directions without changing verified coverage or totals", async () => {
  assert.equal(process.env.BOT_WORKERS_ENABLED, "false", "This read-only check belongs in development.");
  const options = { groupBy: "segment" as const, window: "all" as const, band: "all" as const,
    direction: "all" as const, coverage: "verified" as const, minGames: 1, page: 1 };
  const now = new Date();
  {
    assert.equal(GetKalshiLeaderboardQueryParams.parse({}).groupBy, "segment");
    assert.equal(GetKalshiLeaderboardQueryParams.parse({}).sortBy, "roi");
    assert.equal(GetKalshiLeaderboardQueryParams.parse({ groupBy: "amount", sortBy: "winRate" }).groupBy, "amount");
    assert.equal(GetKalshiLeaderboardQueryParams.safeParse({ sortBy: "guaranteedProfit" }).success, false);
    assert.equal(GetKalshiLeaderboardQueryParams.safeParse({ minGames: 0 }).success, false);
    const all = await getRoiLeaderboard(options, now);
    const yes = await getRoiLeaderboard({ ...options, direction: "yes" }, now);
    const no = await getRoiLeaderboard({ ...options, direction: "no" }, now);
    const sports = await getRoiLeaderboard({ ...options, groupBy: "sport" }, now);
    const amounts = await getRoiLeaderboard({ ...options, groupBy: "amount", sortBy: "winRate" }, now);
    for (const data of [all, yes, no, sports, amounts]) {
      GetKalshiLeaderboardResponse.parse(data);
      assert.equal(data.coverage, "verified");
      for (const [index, row] of data.rows.entries()) {
        assert.equal(row.wins + row.losses, row.trades);
        assert.equal(row.invested, row.trades * 100);
        assert.ok(index === 0 || (data.sortBy === "winRate"
          ? data.rows[index - 1].winRatePct >= row.winRatePct
          : data.rows[index - 1].roiPct >= row.roiPct));
        assert.equal(row.weekly.reduce((sum, week) => sum + week.trades, 0), row.trades);
        assert.equal(row.moneyBands.reduce((sum, band) => sum + band.trades, 0), row.trades);
      }
    }
    assert.ok(all.rows.every(row => row.side === "yes" || row.side === "no"));
    assert.ok(yes.rows.every(row => row.side === "yes"));
    assert.ok(no.rows.every(row => row.side === "no"));
    assert.equal(all.summary.settledTrades, yes.summary.settledTrades + no.summary.settledTrades);
    assert.ok(Math.abs(all.summary.profit - yes.summary.profit - no.summary.profit) <= 0.011);
    assert.deepEqual(all.summary, sports.summary);
    assert.deepEqual(all.summary, amounts.summary);
    assert.ok(amounts.totalRows <= 3, "All three canonical money ranges fit on one ranking page");
    console.info(`Verified development data: ${all.summary.settledTrades} executions; ${all.totalRows} side-specific combinations. No writes or Telegram calls.`);
  }
});

test("read-only PostgreSQL fixtures verify exact money boundaries, New York weeks and unchanged eligibility", async () => {
  assert.equal(process.env.BOT_WORKERS_ENABLED, "false");
  const at = new Date("2026-11-05T12:00:00Z");
  // CTEs shadow table names for THIS SELECT only. No seed records, temporary
  // tables, migrations, or writes to application data are involved.
  const inputs = [
    ["LOW", "999.9999", ".0001", "9999999", "2026-10-26T03:59:59Z", "yes"],
    ["SMALL", "1000", ".5", "2000", "2026-10-26T03:59:59Z", "yes"],
    ["SMALL-BOUNDARY", "5000", ".5", "10000", "2026-10-26T04:00:00Z", "yes"],
    ["MEDIUM", "5000.0001", ".0001", "50000001", "2026-10-26T04:00:00Z", "no"],
    ["MEDIUM-UPPER", "9999.9999", ".0001", "99999999", "2026-11-02T04:59:59Z", "no"],
    ["LARGE", "10000", ".5", "20000", "2026-11-02T05:00:00Z", "yes"],
    ["LARGE-HIGH", "20000", ".5", "40000", "2026-11-03T00:00:00Z", "no"],
    ["PARTIAL", "2000", ".5", "4000", "2026-10-27T12:00:00Z", "yes"],
    ["PENDING", "1500", ".5", "3000", "2026-10-27T12:00:00Z", "yes"],
    ["UNKNOWN", "1100", ".5", "2200", "2026-10-27T12:00:00Z", "unknown"],
    ["UNSUPPORTED", "1800", ".5", "3600", "2026-10-27T12:00:00Z", "yes"],
    ["FUTURE", "1800", ".5", "3600", "2026-11-06T12:00:00Z", "yes"],
  ];
  const values = sql.join(inputs.map(([ticker, notional, price, count, time, side]) =>
    sql`(${ticker}::text, ${notional}::numeric, ${price}::numeric, ${count}::numeric,
      ${time}::timestamptz, ${side}::text, 'unknown'::text)`), sql`,`);
  const options = { groupBy: "sport" as const, window: "all" as const, band: "all" as const,
    direction: "all" as const, coverage: "verified" as const, minGames: 1, page: 1 };
  await db.transaction(async tx => {
    const executor: Pick<typeof db, "execute"> = {
      execute: <TRow extends Record<string, unknown> = Record<string, unknown>>(query: SQLWrapper | string) =>
        tx.execute<TRow>(sql`
          WITH kalshi_alerts AS (
            SELECT v.*, 'Football'::text AS sport, 'Fixture game'::text AS event_title,
              'Team A wins'::text AS market_title, 'https://example.test/game'::text AS market_url
            FROM (VALUES ${values}) v(ticker, notional, price, count, created_time, outcome_side, book_side)
          ), kalshi_market_settlements AS (
            SELECT ticker, CASE WHEN ticker = 'UNSUPPORTED' THEN '' ELSE 'yes' END AS result,
              ticker <> 'PENDING' AS terminal, ${at}::timestamptz AS checked_at, null::text AS error
            FROM kalshi_alerts
          ), kalshi_game_status AS (
            SELECT ticker, CASE WHEN ticker LIKE 'LARGE%' THEN 'GAME-B' ELSE 'GAME-A' END AS milestone_id,
              'EVENT'::text AS event_ticker FROM kalshi_alerts
          ), kalshi_trade_history AS (
            SELECT ticker, CASE WHEN ticker IN ('PARTIAL', 'PENDING') THEN 'pending' ELSE 'complete' END AS phase,
              true AS final_pass, ${at}::timestamptz AS audited_at, null::text AS error,
              ${HISTORY_AUDIT_VERSION}::int AS audit_version, 1000::numeric AS capture_minimum,
              null::timestamptz AS since_at, ${at}::timestamptz AS snapshot_at
            FROM kalshi_alerts
          )
          SELECT * FROM (${typeof query === "string" ? sql.raw(query) : query.getSQL()}) AS checked_fixture
        `),
    };
    const all = await loadRoiRollups(options, 10000, at, executor);
    const { rows: [row], summary } = buildRoiRanking(all.rows, "sport", 1, { now: at });
    assert.equal(summary.savedTrades, 10, "Sub-$1k and future executions are omitted");
    assert.equal(summary.settledTrades, 6);
    assert.equal(summary.pendingTrades, 1);
    assert.equal(summary.excludedTrades, 3);
    assert.equal(summary.historyExcludedTrades, 1);
    assert.equal(row.games, 2);
    assert.equal(row.wins, 3);
    assert.equal(row.profit, 0);
    assert.equal(row.roiPct, 0);
    assert.equal(row.winRatePct, 50);
    assert.deepEqual(row.moneyBands.map(b => [b.band, b.trades, b.games]), [
      ["small", 2, 1], ["medium", 2, 1], ["large", 2, 1],
    ]);
    assert.deepEqual(row.weekly.map(w => [w.weekStart, w.trades, w.partial]), [
      ["2026-10-19", 1, false], ["2026-10-26", 3, false], ["2026-11-02", 2, true],
    ]);
    assert.equal(all.rows.find(r => r.ticker === "SMALL-BOUNDARY")?.moneyBand, "small");
    assert.equal(all.rows.find(r => r.ticker === "MEDIUM")?.moneyBand, "medium");
    assert.equal(all.rows.find(r => r.ticker === "LARGE")?.moneyBand, "large");
    for (const band of ["small", "medium", "large"] as const) {
      const filtered = await loadRoiRollups({ ...options, band }, 10000, at, executor);
      assert.ok(filtered.rows.every(r => r.moneyBand === band));
      assert.equal(buildRoiRanking(filtered.rows, "sport", 1, { now: at }).summary.settledTrades, 2);
    }
    const high = await loadRoiRollups({ ...options, band: "large" }, 15000, at, executor);
    assert.deepEqual(high.rows.map(r => r.ticker), ["LARGE-HIGH"], "Keep the configured large-filter threshold");
    const yes = await loadRoiRollups({ ...options, direction: "yes" }, 10000, at, executor);
    assert.ok(yes.rows.every(r => r.side === "yes"));
    const partial = await loadRoiRollups({ ...options, coverage: "all" }, 10000, at, executor);
    assert.equal(buildRoiRanking(partial.rows, "sport", 1, { now: at }).summary.settledTrades, 7);
    const recent = await loadRoiRollups({ ...options, window: "7d" }, 10000, at, executor);
    assert.equal(buildRoiRanking(recent.rows, "sport", 1, { now: at }).summary.settledTrades, 3);
  }, { accessMode: "read only" });
});
