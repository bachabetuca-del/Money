import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { db, pool, kalshiAlertsTable as alerts, kalshiGameStatusTable as games,
  kalshiMetadataJobsTable as jobs, kalshiSettlementsTable as settlements, kalshiRecoveryTable as recovery } from "@workspace/db";
import { eq, inArray } from "drizzle-orm";
import { persistTrades, metadataStore } from "./kalshi-ingestion-store";
import { gameStatusRepository, readGameStatus } from "./kalshi-game-status-store";
import { applyLifecycle } from "./kalshi-lifecycle-store";
import { settlementStore } from "./kalshi-settlement-store";
import { recoveryStore } from "./kalshi-recovery-store";
import type { GameStatus } from "./kalshi-game-status";
import type { PublicTrade } from "./kalshi-monitor";

test("development database acquisition stores preserve identities, games and final results", async t => {
  assert.equal(process.env.BOT_WORKERS_ENABLED, "false", "Never run integration fixtures alongside bot workers.");
  const prefix = `TEST-ACQ-${randomUUID()}`;
  const tickers = [`${prefix}-A`, `${prefix}-B`];
  const id = `${prefix}-TRADE`;
  const now = new Date();
  const raw: PublicTrade = {
    tradeId: id, ticker: tickers[0], title: "Test sports", eventTitle: "Test sports",
    marketTitle: tickers[0], sport: "Tennis", outcomeSide: "yes", bookSide: "bid",
    price: 0.6, count: 25000, notional: 15000, createdTime: now.toISOString(), blockTrade: false,
    marketUrl: "https://kalshi.com/markets/test",
  };
  const base: GameStatus = { ticker: tickers[0], eventTicker: `${prefix}-EVENT`, milestoneId: `${prefix}-GAME`,
    state: "live", source: "live", marketStatus: "active", marketTerminal: false,
    startsAt: new Date(now.getTime() - 60000), delayed: false, checkedAt: now,
    nextCheckAt: new Date(now.getTime() + 60000), error: null };
  try {
    await t.test("raw executions, pending descriptions and tracked markets are committed without REST", async () => {
      await persistTrades([raw, { ...raw, tradeId: `${id}-B`, ticker: tickers[1], marketTitle: tickers[1] }]);
      await persistTrades([raw]);
      const rows = await db.select().from(alerts).where(inArray(alerts.ticker, tickers));
      assert.equal(rows.length, 2);
      assert.equal(rows[0].notional, 15000);
      assert.equal(rows[0].alertedAt, null);
      assert.equal((await db.select().from(jobs).where(inArray(jobs.ticker, tickers))).length, 2);
      assert.equal((await db.select().from(games).where(inArray(games.ticker, tickers))).length, 2);
      await assert.rejects(persistTrades([{ ...raw, ticker: tickers[1] }]), /identity conflict/);
      assert.equal((await db.select().from(alerts).where(eq(alerts.tradeId, id)))[0].ticker, tickers[0]);
    });
    await t.test("description completion populates history eligibility and future trades reuse saved names", async () => {
      for (const ticker of tickers) await metadataStore.complete(ticker, {
        eventTitle: "Test Player One vs Player Two", marketTitle: "Player One wins",
        eventTicker: base.eventTicker!, marketStatus: "active",
      });
      assert.equal((await db.select().from(jobs).where(inArray(jobs.ticker, tickers))).length, 0);
      const result = await persistTrades([{ ...raw, tradeId: `${id}-SECOND` }]);
      assert.equal(result[0].marketTitle, "Player One wins");
      assert.equal((await db.select().from(jobs).where(inArray(jobs.ticker, tickers))).length, 0);
      assert.equal((await readGameStatus(tickers[1]))?.marketStatus, "active");
    });
    await t.test("one game refresh updates siblings and the candidate batch has one representative", async () => {
      await gameStatusRepository.save(base);
      const peer = (await readGameStatus(tickers[1]))!;
      assert.equal(peer.milestoneId, base.milestoneId);
      assert.equal(peer.state, "live");
      assert.equal(peer.nextCheckAt.getTime(), base.nextCheckAt.getTime());
      const selected = await gameStatusRepository.batch!(new Date(now.getTime() + 60001), tickers[0]);
      assert.equal(selected.filter(row => tickers.includes(row.ticker)).length, 1);
      assert.equal(selected[0].ticker, tickers[0]);
    });
    await t.test("a settled prop does not end its game; a real final propagates to all its markets", async () => {
      await gameStatusRepository.save({ ...base, state: "finished", source: "market" });
      assert.equal((await readGameStatus(tickers[1]))?.state, "live");
      await gameStatusRepository.save({ ...base, ticker: tickers[1], state: "finished", source: "live" });
      assert.equal((await readGameStatus(tickers[0]))?.source, "live");
      assert.equal((await readGameStatus(tickers[1]))?.state, "finished");
    });
    await t.test("lifecycle hints queue official checks without inventing final results or touching unknown markets", async () => {
      await applyLifecycle([
        { ticker: tickers[0], metadata: true, settlement: true },
        { ticker: `${prefix}-UNTRACKED`, metadata: true, settlement: true },
      ]);
      const rows = await db.select().from(settlements).where(eq(settlements.ticker, tickers[0]));
      assert.equal(rows[0].terminal, false);
      assert.equal(rows[0].result, null);
      assert.equal(rows[0].priority, 1);
      assert.equal((await db.select().from(jobs).where(eq(jobs.ticker, `${prefix}-UNTRACKED`))).length, 0);
      assert.equal((await settlementStore.candidates(false, 50, new Date()))[0], tickers[0]);
    });
    await t.test("batch resolutions update market metadata and cannot regress already verified final results", async () => {
      const value = { ticker: tickers[0], result: "yes", terminal: true, historical: false,
        checkedAt: now, nextCheckAt: now, error: null, marketStatus: "finalized" };
      await settlementStore.saveMany!([value, { ...value, ticker: tickers[1], result: "no" }]);
      await settlementStore.save({ ...value, result: null, terminal: false, marketStatus: "active" });
      await metadataStore.complete(tickers[0], { eventTitle: "Test game", marketTitle: "Test prediction", marketStatus: "active" });
      const [saved] = await db.select().from(settlements).where(eq(settlements.ticker, tickers[0]));
      assert.equal(saved.result, "yes");
      assert.equal(saved.terminal, true);
      assert.equal(saved.priority, 0);
      assert.equal((await readGameStatus(tickers[0]))?.marketStatus, "finalized");
      assert.equal((await readGameStatus(tickers[0]))?.marketTerminal, true);
      await applyLifecycle([{ ticker: tickers[0], metadata: false, settlement: true }]);
      assert.equal((await db.select().from(settlements).where(eq(settlements.ticker, tickers[0])))[0].priority, 0);
    });
    await t.test("the durable recovery schema is readable without creating a bot checkpoint", async () => {
      await recoveryStore.load();
      const seed = await recoveryStore.seed();
      assert.ok(seed instanceof Date);
      // Do not create or overwrite the singleton production/development watermark.
      assert.ok(Array.isArray(await db.select().from(recovery).limit(1)));
    });
  } finally {
    await db.delete(jobs).where(inArray(jobs.ticker, tickers));
    await db.delete(settlements).where(inArray(settlements.ticker, tickers));
    await db.delete(games).where(inArray(games.ticker, tickers));
    await db.delete(alerts).where(inArray(alerts.ticker, tickers));
    await pool.end();
  }
});
