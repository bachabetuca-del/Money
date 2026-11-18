import assert from "node:assert/strict";
import { roiSourceFilters, roiFilteredRows } from "./roi-read-model";
import { after, test } from "node:test";
import { db, pool } from "@workspace/db";
import { sql, type SQLWrapper } from "drizzle-orm";
import { GetKalshiLeaderboardResponse, GetKalshiLeaderboardQueryParams, GetKalshiExplorerQueryParams, GetKalshiExplorerRoiQueryParams, GetKalshiExplorerRoiResponse, SaveKalshiSettingsBody } from "@workspace/api-zod";
import { getRoiLeaderboard, loadRoiRollups } from "./kalshi-roi-leaderboard";
import { buildRoiRanking } from "./roi-ranking";
import { selectRoiEntries } from "./roi-method";
import { HISTORY_AUDIT_VERSION } from "./kalshi-market-history";
import { loadRoiReferencePrices } from "./kalshi-roi-reference-prices";
import { tradeRange } from "./kalshi-trade-bands";
import { buildExplorerRoi, ROI_COLOR_POLICY } from "./explorer-roi";
import { createFeeSnapshot, estimateHypotheticalEntryFee, feeModel } from "./kalshi-fees";

after(() => pool.end());

test("SQL first-entry evidence survives aggregation and chooses the losing first line, not the later winner", async () => {
  assert.equal(process.env.BOT_WORKERS_ENABLED, "false");
  const at = new Date("2026-11-18T12:00:00Z");
  await db.transaction(async tx => {
    const executor: Pick<typeof db, "execute"> = {
      execute: <TRow extends Record<string, unknown> = Record<string, unknown>>(query: SQLWrapper | string) =>
        tx.execute<TRow>(sql`
          WITH kalshi_alerts AS (
            SELECT 'KXNFLSPREAD-G-' || selection AS ticker, trade_id, 'Football'::text AS sport,
              'A vs B'::text AS event_title, 'A spread'::text AS market_title,
              'https://example.test'::text AS market_url, .4::numeric AS price, 15000::numeric AS count,
              6000::numeric AS notional, 'yes'::text AS outcome_side, 'bid'::text AS book_side,
              created_time::timestamptz
            FROM (VALUES ('a','LOSE','2026-11-17T10:00:00Z'), ('b','LOSE','2026-11-17T10:00:00Z'),
              ('c','WIN','2026-11-17T11:00:00Z'), ('d','LIVE','2026-11-17T14:00:00Z'),
              ('e','UNKNOWN','2026-11-17T14:00:00Z'))
              v(trade_id, selection, created_time)
          ), kalshi_market_settlements AS (
            SELECT DISTINCT ticker, CASE WHEN ticker LIKE '%LOSE' THEN 'no' ELSE 'yes' END AS result,
              true AS terminal, ${at}::timestamptz AS checked_at, null::text AS error FROM kalshi_alerts
          ), kalshi_game_status AS (
            SELECT DISTINCT ticker, 'GAME'::text AS milestone_id, 'EVENT'::text AS event_ticker,
              '2026-11-17T13:00:00Z'::timestamptz AS starts_at,
              CASE WHEN ticker LIKE '%LIVE' THEN '2026-11-17T13:59:30Z'::timestamptz ELSE ${at}::timestamptz END AS checked_at,
              false AS delayed, null::text AS error,
              CASE WHEN ticker LIKE '%LIVE' THEN 'live' ELSE 'finished' END AS state,
              'live'::text AS source FROM kalshi_alerts
          ), kalshi_trade_history AS (
            SELECT DISTINCT ticker, 'complete'::text AS phase, true AS final_pass,
              ${at}::timestamptz AS audited_at, null::text AS error, ${HISTORY_AUDIT_VERSION} AS audit_version,
              1000::numeric AS capture_minimum, null::timestamptz AS since_at,
              ${at}::timestamptz AS snapshot_at FROM kalshi_alerts
          ) SELECT * FROM (${typeof query === "string" ? sql.raw(query) : query.getSQL()}) checked
        `),
    };
    const raw = await loadRoiRollups({ groupBy: "segment", window: "all", band: "all", direction: "all",
      minGames: 1, page: 1 }, 10000, at, executor);
    assert.equal(raw.rows.reduce((s, r) => s + r.trades, 0), 5);
    const first = selectRoiEntries(raw.rows);
    assert.equal(first.methodology.unknownPhaseExecutions, 1, "The later finished feed cannot prove historical live state");
    assert.equal(first.rows.length, 1);
    assert.equal(first.rows[0].firstTradeId, "a");
    assert.equal(first.rows[0].profit, -100);
    assert.equal(first.rows[0].wins, 0);
    assert.equal(first.rows[0].firstPrice, .4);
    assert.equal(selectRoiEntries(raw.rows, "game", "live").rows[0].firstTradeId, "d");
    const all = selectRoiEntries(raw.rows, "execution");
    assert.equal(all.rows.reduce((s, r) => s + r.profit, 0), -50);
  }, { accessMode: "read only" });
});

test("ROI color references: latest valid trade per side and band, exact boundaries, read-only", async () => {
  assert.equal(process.env.BOT_WORKERS_ENABLED, "false");
  const now = new Date("2026-10-31T12:00:00Z");
  const values = sql.join([
    ["a", "T", "yes", "", ".50", "2000", "1000", "2026-10-31T10:00:00Z"],
    ["b", "T", "yes", "", ".40", "12500", "5000", "2026-10-31T11:00:00Z"],
    ["c", "T", "no", "", ".25", "8000", "2000", "2026-10-31T11:00:00Z"],
    ["d", "T", "yes", "", ".60", "10000", "6000", "2026-10-31T11:20:00Z"],
    ["e", "T", "no", "", ".50", "20000", "10000", "2026-10-31T11:30:00Z"],
    ["f", "T", "yes", "", ".50", "40000", "20000", "2026-10-31T11:40:00Z"],
    ["g", "T", "yes", "", ".90", "2000", "1800", "2026-11-01T11:50:00Z"], // future
    ["h", "T", "yes", "", "1.2", "1000", "1200", "2026-10-31T11:50:00Z"], // invalid price
    ["i", "T", "yes", "", ".9", "2000", "1900", "2026-10-31T11:50:00Z"], // bad notional
    ["j", "T", "unknown", "", ".9", "2000", "1800", "2026-10-31T11:50:00Z"],
    ["k", "IGNORED", "yes", "", ".9", "2000", "1800", "2026-10-31T11:50:00Z"],
    ["l", "U", "", "ask", ".3", "5000", "1500", "2026-10-31T11:00:00Z"], // legacy NO
  ].map(([id, ticker, side, book, price, count, notional, time]) =>
    sql`(${id}::text, ${ticker}::text, ${side}::text, ${book}::text, ${price}::numeric,
      ${count}::numeric, ${notional}::numeric, ${time}::timestamptz)`), sql`,`);
  await db.transaction(async tx => {
    const executor: Pick<typeof db, "execute"> = {
      execute: <TRow extends Record<string, unknown> = Record<string, unknown>>(query: SQLWrapper | string) =>
        tx.execute<TRow>(sql`
          WITH kalshi_alerts AS (
            SELECT * FROM (VALUES ${values}) v(trade_id, ticker, outcome_side, book_side, price, count, notional, created_time)
          ) ${query as SQLWrapper}`),
    };
    const small = await loadRoiReferencePrices(["T", "U"], tradeRange("small"), now, executor);
    assert.equal(small.length, 3);
    assert.equal(small.find(r => r.ticker === "T" && r.side === "yes")?.price, .4);
    assert.equal(small.find(r => r.ticker === "T" && r.side === "no")?.price, .25);
    assert.equal(small.find(r => r.ticker === "U")?.side, "no");
    const medium = await loadRoiReferencePrices(["T"], tradeRange("medium"), now, executor);
    assert.deepEqual(medium.map(r => [r.side, r.price]), [["yes", .6]]);
    const large = await loadRoiReferencePrices(["T"], tradeRange("large"), now, executor);
    assert.deepEqual(large.map(r => [r.side, r.price]), [["no", .5], ["yes", .5]]);
    const raised = await loadRoiReferencePrices(["T"], tradeRange("large", 15000), now, executor);
    assert.deepEqual(raised.map(r => r.side), ["yes"]);
    assert.deepEqual(await loadRoiReferencePrices([], tradeRange("small"), now, executor), []);
    const output = {
      band: "small", scope: "active", generatedAt: now.toISOString(), historyAsOf: now.toISOString(),
      ...ROI_COLOR_POLICY,
      feeModel: feeModel(null, now),
      markets: buildExplorerRoi([{ ticker: "T", sport: "Soccer", marketType: "winner" }], small, [], now),
    };
    GetKalshiExplorerRoiResponse.parse(output);
  }, { accessMode: "read only" });
  assert.equal(GetKalshiExplorerRoiQueryParams.parse({}).band, "large");
  assert.equal(GetKalshiExplorerRoiQueryParams.safeParse({ band: "all" }).success, false);
  assert.equal(GetKalshiExplorerRoiQueryParams.safeParse({ scope: "invalid" }).success, false);
});

test("read-only development ranking separates directions without changing verified coverage or totals", async () => {
  assert.equal(process.env.BOT_WORKERS_ENABLED, "false", "This read-only check belongs in development.");
  const options = { groupBy: "segment" as const, window: "all" as const, band: "all" as const,
    direction: "all" as const, coverage: "verified" as const, minGames: 1, page: 1 };
  const now = new Date();
  {
    assert.equal(GetKalshiLeaderboardQueryParams.parse({}).groupBy, "segment");
    for (const marketType of ["btts", "correctScore", "qualification", "periodWinner", "corners"]) {
      assert.equal(GetKalshiExplorerQueryParams.parse({ marketType }).marketType, marketType);
    }
    assert.equal(GetKalshiExplorerQueryParams.safeParse({ marketType: "fabricated-category" }).success, false);
    assert.equal(GetKalshiLeaderboardQueryParams.parse({}).sortBy, "roi");
    assert.equal(GetKalshiLeaderboardQueryParams.parse({ sortBy: "netRoi" }).sortBy, "netRoi");
    const settings = { enabled: false, minimumNotional: 10000, chatId: "unit-test-only" };
    assert.equal(SaveKalshiSettingsBody.parse(settings).notificationRoiBasis, undefined,
      "An old client must leave an existing net choice unchanged, not default it to gross");
    assert.equal(SaveKalshiSettingsBody.parse({ ...settings, notificationRoiBasis: "net" }).notificationRoiBasis, "net");
    assert.equal(SaveKalshiSettingsBody.safeParse({ ...settings, notificationRoiBasis: "best" }).success, false);
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
            SELECT v.*, ticker AS trade_id, 'Football'::text AS sport, 'Fixture game'::text AS event_title,
              'Team A wins'::text AS market_title, 'https://example.test/game'::text AS market_url
            FROM (VALUES ${values}) v(ticker, notional, price, count, created_time, outcome_side, book_side)
          ), kalshi_market_settlements AS (
            SELECT ticker, CASE WHEN ticker = 'UNSUPPORTED' THEN '' ELSE 'yes' END AS result,
              ticker <> 'PENDING' AS terminal, ${at}::timestamptz AS checked_at, null::text AS error
            FROM kalshi_alerts
          ), kalshi_game_status AS (
            SELECT ticker, CASE WHEN ticker LIKE 'LARGE%' THEN 'GAME-B' ELSE 'GAME-A' END AS milestone_id,
              'EVENT'::text AS event_ticker, ${at}::timestamptz AS checked_at,
              null::timestamptz AS starts_at, false AS delayed, null::text AS error,
              'unknown'::text AS state, 'unknown'::text AS source FROM kalshi_alerts
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
    assert.equal(row.net.roiPct, null, "Without a fee snapshot gross stays available, net is unknown");
    const fees = createFeeSnapshot([...new Set(inputs.map(r => r[0].split("-")[0]))].map(ticker =>
      ({ ticker, fee_type: ticker === "MEDIUM" ? "quadratic_with_maker_fees" : "quadratic", fee_multiplier: 1 })), [], [], at);
    const withFees = await loadRoiRollups(options, 10000, at, executor, fees);
    const priced = buildRoiRanking(withFees.rows, "sport", 1, { now: at });
    assert.equal(priced.summary.net.coveredTrades, 6);
    assert.equal(priced.summary.net.missingTrades, 0);
    assert.equal(priced.summary.net.fees, 27.9986);
    for (const rollup of withFees.rows) {
      assert.equal(rollup.feeTrades, rollup.category === "settled" ? rollup.trades : 0);
      if (rollup.category === "settled") {
        const price = Number(inputs.find(r => r[0] === rollup.ticker)![2]);
        assert.equal(rollup.fees, estimateHypotheticalEntryFee(price, { feeType: "quadratic", multiplier: 1 }));
      }
    }
    const override = createFeeSnapshot(Object.keys(fees.series).map(ticker =>
      ({ ticker, fee_type: "quadratic", fee_multiplier: 1 })), [
      { event_ticker: "EVENT", scheduled_ts: at.toISOString(), fee_type_override: null, fee_multiplier_override: 0 },
    ], [], at);
    const free = buildRoiRanking((await loadRoiRollups(options, 10000, at, executor, override)).rows, "sport", 1, { now: at });
    assert.equal(free.summary.net.fees, 0, "An explicit zero event override must not fall through to series multiplier 1");
    assert.equal(free.summary.net.roiPct, free.summary.roiPct);
    override.events.EVENT.feeType = "flat";
    assert.equal(buildRoiRanking((await loadRoiRollups(options, 10000, at, executor, override)).rows, "sport", 1, { now: at }).summary.net.roiPct, null);
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
    for (const threshold of [10000, 15000]) {
      const sources = new Map<string, Awaited<ReturnType<typeof loadRoiRollups>>>();
      for (const band of ["all", "small", "medium", "large"] as const) {
        for (const direction of ["all", "yes", "no"] as const) {
          const filters = { band, direction };
          const sourceFilters = roiSourceFilters(filters, threshold);
          const key = JSON.stringify(sourceFilters);
          let source = sources.get(key);
          if (!source) {
            source = await loadRoiRollups({ ...options, ...sourceFilters }, threshold, at, executor);
            sources.set(key, source);
          }
          const direct = await loadRoiRollups({ ...options, ...filters }, threshold, at, executor);
          const normalize = (rows: typeof direct.rows) => rows.map(r => JSON.stringify(r)).sort();
          assert.deepEqual(normalize(roiFilteredRows(source.rows, filters)), normalize(direct.rows),
            `shared rollups must match filtered SQL for ${band}/${direction}/${threshold}`);
        }
      }
    }
  }, { accessMode: "read only" });
});
