import assert from "node:assert/strict";
import { after, test } from "node:test";
import { db, pool } from "@workspace/db";
import { sql, type SQLWrapper } from "drizzle-orm";
import { loadRoiRollups } from "./kalshi-roi-leaderboard";
import { createFeeSnapshot } from "./kalshi-fees";
import { HISTORY_AUDIT_VERSION } from "./kalshi-market-history";
import { legacyRoiFeeQuery } from "./roi-sql-baseline.fixture";

after(() => pool.end());

test("large fee catalog: optimized history SQL exactly matches the old query on generated executions", async () => {
  assert.equal(process.env.BOT_WORKERS_ENABLED, "false", "Development only; no workers, provider calls or writes");
  const now = new Date("2026-11-18T12:00:00Z");
  const fees = createFeeSnapshot(Array.from({ length: 6000 }, (_, i) => ({
    ticker: `S${i}`, fee_type: "quadratic", fee_multiplier: i % 9 === 0 ? 0 : 1,
  })), [
    { event_ticker: "E1", scheduled_ts: now.toISOString(), fee_type_override: null, fee_multiplier_override: 0 },
    { event_ticker: "E2", scheduled_ts: now.toISOString(), fee_type_override: "flat", fee_multiplier_override: null },
  ], [], now);
  await db.transaction(async tx => {
    const executor = (legacy: boolean): Pick<typeof db, "execute"> => ({
      execute: <TRow extends Record<string, unknown> = Record<string, unknown>>(query: SQLWrapper | string) =>
        tx.execute<TRow>(sql`
          WITH market_ids AS MATERIALIZED (
            SELECT i, 'S' || i || '-GAME' AS ticker FROM generate_series(0, 2999) i
          ), kalshi_alerts AS MATERIALIZED (
            SELECT n::text AS trade_id, m.ticker, 'Soccer'::text AS sport,
              'A vs B'::text AS event_title, 'A wins'::text AS market_title,
              'https://example.test'::text AS market_url,
              (.2 + ((n / 3000) % 6) * .1)::numeric AS price,
              (6000 / (.2 + ((n / 3000) % 6) * .1))::numeric AS count,
              6000::numeric AS notional,
              CASE WHEN n % 2 = 0 THEN 'yes' ELSE 'no' END AS outcome_side,
              'bid'::text AS book_side,
              ${now}::timestamptz - interval '2 days' - n * interval '1 second' AS created_time
            FROM generate_series(1, 120000) n JOIN market_ids m ON m.i = n % 3000
          ), kalshi_market_settlements AS (
            SELECT ticker, CASE WHEN i % 3 = 0 THEN 'yes' ELSE 'no' END AS result,
              i % 7 <> 0 AS terminal, ${now}::timestamptz AS checked_at,
              CASE WHEN i % 29 = 0 THEN 'fixture error' END::text AS error FROM market_ids
          ), kalshi_game_status AS (
            SELECT ticker, 'M' || i AS milestone_id, 'E' || i AS event_ticker,
              ${now}::timestamptz - interval '1 day' AS starts_at,
              ${now}::timestamptz AS checked_at, false AS delayed,
              null::text AS error, 'finished'::text AS state, 'live'::text AS source
            FROM market_ids WHERE i % 17 <> 0
          ), kalshi_trade_history AS (
            SELECT ticker, CASE WHEN i % 11 = 0 THEN 'pending' ELSE 'complete' END AS phase,
              true AS final_pass, ${now}::timestamptz AS audited_at, null::text AS error,
              ${HISTORY_AUDIT_VERSION} AS audit_version, 1000::numeric AS capture_minimum,
              null::timestamptz AS since_at, ${now}::timestamptz AS snapshot_at FROM market_ids
          ) SELECT * FROM (${legacy ? legacyRoiFeeQuery(query) :
            typeof query === "string" ? sql.raw(query) : query.getSQL()}) result
        `),
    });
    const options = { groupBy: "segment" as const, window: "all" as const, band: "all" as const,
      direction: "all" as const, minGames: 50, page: 1 };
    // Warm the connection independently; neither path uses the runtime snapshot cache.
    await tx.execute(sql`SELECT 1`);
    const began = performance.now();
    const old = await loadRoiRollups(options, 10000, now, executor(true), fees);
    const baselineMs = performance.now() - began;
    const optimizedBegan = performance.now();
    const optimized = await loadRoiRollups(options, 10000, now, executor(false), fees);
    const optimizedMs = performance.now() - optimizedBegan;
    const canonical = (rows: typeof old.rows) => rows.map(row => JSON.stringify(row)).sort();
    assert.deepEqual(canonical(optimized.rows), canonical(old.rows));
    assert.equal(optimized.rows.reduce((n, row) => n + row.trades, 0), 120000);
    console.info(JSON.stringify({ environment: "development", syntheticExecutions: 120000,
      feeCatalogBytes: Buffer.byteLength(JSON.stringify(fees)), rollups: optimized.rows.length,
      baselineMs: Math.round(baselineMs), optimizedMs: Math.round(optimizedMs),
      identicalResults: true, note: "Synthetic SELECT-only comparison, not production latency or a timing guarantee." }));
  }, { accessMode: "read only" });
});
