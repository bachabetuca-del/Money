import assert from "node:assert/strict";
import { test } from "node:test";
import { pool } from "@workspace/db";
import { GetKalshiLeaderboardResponse, GetKalshiLeaderboardQueryParams } from "@workspace/api-zod";
import { getRoiLeaderboard } from "./kalshi-roi-leaderboard";

test("read-only development ranking separates directions without changing verified coverage or totals", async () => {
  assert.equal(process.env.BOT_WORKERS_ENABLED, "false", "This read-only check belongs in development.");
  const options = { groupBy: "segment" as const, window: "all" as const, band: "all" as const,
    direction: "all" as const, coverage: "verified" as const, minGames: 1, page: 1 };
  const now = new Date();
  try {
    assert.equal(GetKalshiLeaderboardQueryParams.parse({}).groupBy, "segment");
    const all = await getRoiLeaderboard(options, now);
    const yes = await getRoiLeaderboard({ ...options, direction: "yes" }, now);
    const no = await getRoiLeaderboard({ ...options, direction: "no" }, now);
    const sports = await getRoiLeaderboard({ ...options, groupBy: "sport" }, now);
    for (const data of [all, yes, no, sports]) {
      GetKalshiLeaderboardResponse.parse(data);
      assert.equal(data.coverage, "verified");
      for (const [index, row] of data.rows.entries()) {
        assert.equal(row.wins + row.losses, row.trades);
        assert.equal(row.invested, row.trades * 100);
        assert.ok(index === 0 || data.rows[index - 1].roiPct >= row.roiPct);
      }
    }
    assert.ok(all.rows.every(row => row.side === "yes" || row.side === "no"));
    assert.ok(yes.rows.every(row => row.side === "yes"));
    assert.ok(no.rows.every(row => row.side === "no"));
    assert.equal(all.summary.settledTrades, yes.summary.settledTrades + no.summary.settledTrades);
    assert.ok(Math.abs(all.summary.profit - yes.summary.profit - no.summary.profit) <= 0.011);
    assert.deepEqual(all.summary, sports.summary);
    console.info(`Verified development data: ${all.summary.settledTrades} executions; ${all.totalRows} side-specific combinations. No writes or Telegram calls.`);
  } finally {
    await pool.end();
  }
});
