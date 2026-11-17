import assert from "node:assert/strict";
import { after, test } from "node:test";
import { db, pool, kalshiAlertsTable as alerts, kalshiNotificationsTable as notices,
  kalshiSignalEvaluationTable as evaluations, kalshiSignalsTable as signals,
  kalshiSettlementsTable as settlements } from "@workspace/db";
import { and, eq, sql } from "drizzle-orm";
import { GetKalshiSignalsQueryParams, GetKalshiSignalsResponse } from "@workspace/api-zod";
import { activateSignalEvaluation, getSignalEvaluation, loadSignalEvaluation } from "./kalshi-signal-store";
import { enqueueLiveNotifications, createTradeNotificationStore } from "./telegram-trade-notification-store";
import { SIGNAL_FEE_ASSUMPTIONS, signalOutcome } from "./signal-evaluation";
import { feeModel } from "./kalshi-fees";
import type { NotificationRoi } from "./telegram-notification-roi";

after(() => pool.end());

test("owner evaluation reads never activate workers, create a cutoff or import saved history", async () => {
  assert.equal(process.env.BOT_WORKERS_ENABLED, "false", "Never run fixtures alongside bot workers.");
  assert.equal(GetKalshiSignalsQueryParams.parse({}).page, 1);
  assert.equal(GetKalshiSignalsQueryParams.safeParse({ page: "0" }).success, false);
  assert.equal(GetKalshiSignalsQueryParams.safeParse({ page: "NaN" }).success, false);
  const before = await db.select().from(evaluations);
  const data = GetKalshiSignalsResponse.parse(await getSignalEvaluation());
  assert.deepEqual(await db.select().from(evaluations), before);
  if (!before.length) {
    assert.equal(data.activatedAt, null);
    assert.equal(data.recording, "not_started");
    assert.equal(data.summary.registered, 0);
    assert.equal(data.summary.grossRoiPct, null);
    assert.deepEqual(data.rows, []);
  } else assert.equal(data.recording, "paused");
});

test("isolated PostgreSQL fixtures: activation, live-only enrollment, immutable retry evidence, official outcomes and pagination", async t => {
  assert.equal(process.env.BOT_WORKERS_ENABLED, "false");
  await db.transaction(async tx => {
    // Shadow ALL written/read tables on this connection. No real trade, outbox,
    // activation or official settlement is modified, even if the test fails.
    for (const table of ["kalshi_alerts", "kalshi_notifications", "kalshi_signal_evaluation",
      "kalshi_signals", "kalshi_market_settlements", "kalshi_monitor_settings"]) {
      await tx.execute(sql.raw(`CREATE TEMP TABLE ${table} (LIKE public.${table} INCLUDING ALL) ON COMMIT DROP`));
    }
    const zero = new Date("2026-11-02T10:00:00Z");
    const at = (seconds: number) => new Date(zero.getTime() + seconds * 1000);
    const store = createTradeNotificationStore(tx);
    const insert = async (id: string, seconds: number, price = .5, side = "yes") => {
      await tx.insert(alerts).values({
        tradeId: id, ticker: `KXNFLGAME-${id}-A`, title: "Game", eventTitle: "Team A vs Team B",
        marketTitle: "Team A wins", marketUrl: "https://kalshi.com/markets/fixture",
        sport: "Football", outcomeSide: side, bookSide: side === "yes" ? "bid" : "ask",
        price, notional: 10000, count: 10000 / price, createdTime: at(seconds),
      });
    };
    const roi = (fee: number | null = 3.5, net = false): NotificationRoi => ({
      roiPct: net ? 15 : 20, grossRoiPct: 20, netRoiPct: 15, basis: net ? "net" : "gross",
      games: 50, trades: 30,
      evidence: {
        historyAsOf: at(-60).toISOString(), gameId: "same-game", gameIdentity: "milestone",
        feeModel: { ...feeModel(null, zero), version: net ? "frozen-model-two" : "frozen-model-one" },
        feeAssumptions: SIGNAL_FEE_ASSUMPTIONS, feeType: fee === null ? null : "quadratic",
        feeMultiplier: fee === null ? null : 1, entryFeeUsd: fee,
      },
    });
    await t.test("migration and reads stay inactive; singleton activation is idempotent and never backfills the old outbox", async () => {
      await insert("legacy", -10);
      await enqueueLiveNotifications("test", ["legacy"], tx, at(-5));
      const empty = await loadSignalEvaluation(1, at(-1), tx, false);
      assert.equal(empty.recording, "not_started");
      assert.equal(empty.activatedAt, null);
      await activateSignalEvaluation(tx);
      // Fixed fixture boundary, not the transaction clock.
      await tx.update(evaluations).set({ activatedAt: zero }).where(eq(evaluations.id, 1));
      await activateSignalEvaluation(tx);
      assert.equal((await tx.select().from(evaluations))[0].activatedAt.toISOString(), zero.toISOString());
      await tx.update(alerts).set({ createdTime: at(1) }).where(eq(alerts.tradeId, "legacy"));
      await enqueueLiveNotifications("test", ["legacy"], tx, at(2));
      assert.equal((await tx.select().from(notices).where(eq(notices.tradeId, "legacy")))[0].evaluationId, null);
      // A late old execution and an invalid future timestamp are not prospective.
      await insert("late-history", -1); await insert("future", 100);
      await enqueueLiveNotifications("test", ["late-history", "future"], tx, at(2));
      const legacy = await tx.select().from(notices);
      assert.ok(legacy.every(n => n.evaluationId === null));
      assert.equal((await tx.select().from(signals)).length, 0);
      await tx.update(notices).set({ skippedAt: at(2) });
    });
    await t.test("fresh enrollments deduplicate; failed delivery and later source corrections cannot change evidence", async () => {
      await insert("frozen", 1);
      await enqueueLiveNotifications("test", ["frozen", "frozen"], tx, at(2));
      await enqueueLiveNotifications("test", ["frozen"], tx, at(3));
      await tx.update(notices).set({ retryAt: at(2) }).where(eq(notices.tradeId, "frozen"));
      const job = (await store.next("test", at(3)))!;
      assert.equal(job.evaluationId, 1);
      assert.equal(job.queuedAt!.toISOString(), at(2).toISOString());
      const captured = await store.capture(job, roi(), at(3));
      assert.ok(captured);
      await store.failed("test", "frozen", "Test failed delivery", at(4));
      await tx.update(alerts).set({ price: .25, notional: 100, count: 400, outcomeSide: "no",
        eventTitle: "Repaired later" }).where(eq(alerts.tradeId, "frozen"));
      const retry = (await createTradeNotificationStore(tx).next("test", at(4)))!;
      assert.deepEqual(retry.evidence, captured, "Snapshot survives source corrections and a new store instance");
      assert.equal(retry.attempts, 1);
      assert.deepEqual(await store.capture(retry, roi(9, true), at(4)), captured);
      await store.sent(retry, 901, at(5));
      await store.sent(retry, 999, at(6));
      await store.removed("test", "frozen", at(6));
      const [notice] = await tx.select().from(notices).where(eq(notices.tradeId, "frozen"));
      assert.equal(notice.sentAt!.toISOString(), at(5).toISOString(), "Repeated confirmations cannot move delivery time");
      assert.equal(notice.messageId, 901);
      assert.equal((await tx.select().from(signals)).length, 1);
      await tx.insert(settlements).values({
        ticker: captured.ticker, terminal: true, result: "yes", checkedAt: at(10), nextCheckAt: at(10),
      });
      const result = GetKalshiSignalsResponse.parse(await loadSignalEvaluation(1, at(20), tx, false));
      assert.equal(result.rows[0].evidence.price, .5);
      assert.equal(result.rows[0].grossProfit, 100);
      assert.equal(result.rows[0].netProfit, 96.5);
      assert.equal(result.rows[0].evidence.feeModel.version, "frozen-model-one");
      assert.equal(result.summary.games, 1);
      assert.equal(result.recording, "paused");
    });
    await t.test("already official outcomes cannot become new prospective signals", async () => {
      await insert("already-final", 1);
      await enqueueLiveNotifications("test", ["already-final"], tx, at(2));
      await tx.update(notices).set({ retryAt: at(2) }).where(eq(notices.tradeId, "already-final"));
      const job = (await store.next("test", at(3)))!;
      await tx.insert(settlements).values({
        ticker: job.ticker, terminal: true, result: "no", checkedAt: at(2), nextCheckAt: at(2),
      });
      assert.equal(await store.capture(job, roi(), at(3)), null);
      await store.skipped(job, at(3));
    });
    await t.test("pending, excluded, not delivered, NO wins, correlated games and unknown fees remain distinct on every page", async () => {
      for (let i = 0; i < 30; i++) {
        const id = `case-${String(i).padStart(2, "0")}`;
        await insert(id, 1, i === 0 ? .25 : .5, i % 2 === 0 ? "no" : "yes");
        await enqueueLiveNotifications("test", [id], tx, at(2));
        await tx.update(notices).set({ retryAt: at(2) }).where(eq(notices.tradeId, id));
        const job = (await store.next("test", at(3)))!;
        assert.equal(job.tradeId, id);
        const evidence = await store.capture(job, roi(i === 3 ? null : 3.5, i % 2 === 0), at(3));
        assert.ok(evidence);
        if (i === 4 || i === 5) {
          if (i === 5) await store.skipped(job, at(4));
          else await store.failed("test", id, "Test delivery pending", at(100));
        } else await store.sent(job, 1000 + i, at(5));
        if (i !== 6) await tx.insert(settlements).values({
          ticker: job.ticker, terminal: i !== 7, result: i === 1 ? "unsupported" : i % 3 === 0 ? "no" : "yes",
          checkedAt: at(i === 2 ? 4 : 10), nextCheckAt: at(10), error: i === 8 ? "Verification unavailable" : null,
        });
      }
      const first = GetKalshiSignalsResponse.parse(await loadSignalEvaluation(1, at(20), tx, false));
      const second = GetKalshiSignalsResponse.parse(await loadSignalEvaluation(2, at(20), tx, false));
      assert.equal(first.summary.registered, 31);
      assert.equal(first.rows.length, 25);
      assert.equal(second.rows.length, 6);
      assert.equal(second.page, 2);
      assert.equal(second.totalPages, 2);
      assert.deepEqual(first.summary, second.summary, "Totals are not truncated to the displayed page");
      const all = [...first.rows, ...second.rows];
      assert.equal(new Set(all.map(row => row.evidence.tradeId)).size, 31);
      assert.equal(first.summary.delivered, 29);
      assert.equal(first.summary.awaitingDelivery, 1);
      assert.equal(first.summary.skipped, 1);
      assert.equal(first.summary.pending, 3);
      assert.equal(first.summary.excluded, 2);
      assert.equal(first.summary.settled, 24);
      assert.equal(first.summary.games, 1);
      assert.equal(first.summary.settledGames, 1);
      assert.equal(first.summary.feeCovered, 23);
      assert.equal(first.summary.feeMissing, 1);
      assert.equal(first.summary.netProfit, null);
      assert.equal(first.summary.netRoiPct, null, "Do not present a net from a selectively covered subset");
      assert.equal(first.cohorts.length, 2);
      assert.ok(first.cohorts.some(c => c.basis === "net" && c.performance.netRoiPct !== null));
      assert.equal(first.summary.invested, 2400);
      const settledRows = all.filter(row => row.status === "settled");
      assert.equal(first.summary.grossProfit, settledRows.reduce((sum, row) => sum + row.grossProfit!, 0));
      assert.equal(first.summary.wins + first.summary.losses, 24);
      assert.equal(all.find(row => row.evidence.tradeId === "case-00")!.grossProfit, 300);
      assert.equal(all.find(row => row.evidence.tradeId === "case-01")!.exclusionReason, "unsupported_settlement");
      assert.equal(all.find(row => row.evidence.tradeId === "case-02")!.exclusionReason, "settled_before_alert");
      assert.equal(all.find(row => row.evidence.tradeId === "case-04")!.status, "not_sent");
      assert.equal(all.find(row => row.evidence.tradeId === "case-07")!.status, "pending", "Provisional result is not a win");
      assert.equal(all.find(row => row.evidence.tradeId === "case-08")!.settlementError, "Verification unavailable");
      assert.ok(all.filter(row => row.status !== "settled").every(row => row.grossProfit === null));
      assert.equal((await loadSignalEvaluation(999, at(20), tx, false)).page, 2);
      assert.ok(first.limitations.some(text => text.includes("deslizamiento")));
      // SQL classification and pure row classification must agree for every fixture.
      for (const row of all) {
        const [delivery] = await tx.select().from(notices).where(and(eq(notices.chatId, "test"),
          eq(notices.tradeId, row.evidence.tradeId)));
        const [settled] = await tx.select().from(settlements).where(eq(settlements.ticker, row.evidence.ticker));
        const recalculated = signalOutcome(row.evidence, { sentAt: delivery.sentAt, skippedAt: delivery.skippedAt,
          attempts: delivery.attempts, result: settled?.result ?? null, terminal: settled?.terminal ?? null,
          checkedAt: settled?.checkedAt ?? null, error: settled?.error ?? null });
        assert.equal(row.status, recalculated.status);
      }
    });
  });
});
