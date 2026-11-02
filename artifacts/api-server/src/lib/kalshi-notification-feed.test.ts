import assert from "node:assert/strict";
import { after, test } from "node:test";
import { db, pool, kalshiAlertsTable as alerts, kalshiNotificationsTable as notices,
  kalshiSignalsTable as signals, kalshiGameStatusTable as games } from "@workspace/db";
import { eq, sql } from "drizzle-orm";
import { GetKalshiNotificationsQueryParams, GetKalshiNotificationsResponse } from "@workspace/api-zod";
import { loadTelegramNotifications, notificationFeedRow } from "./kalshi-notification-feed";
import { buildSignalEvidence, SIGNAL_FEE_ASSUMPTIONS } from "./signal-evaluation";
import { feeModel } from "./kalshi-fees";
import { notificationGameContext } from "./notification-game-context";

after(() => pool.end());
const zero = new Date("2026-11-02T12:00:00Z");
const at = (seconds: number) => new Date(zero.getTime() + seconds * 1000);
const frozenEvidence = () => buildSignalEvidence({
  chatId: "owner-fixture", tradeId: "frozen-1", ticker: "KXSOCCERGAME-LIVE-MAD",
  eventTitle: "Real Madrid vs Barcelona", marketTitle: "Real Madrid wins", sport: "Soccer",
  marketUrl: "https://kalshi.com/markets/example", outcomeSide: "no", bookSide: "ask",
  price: .25, notional: 1250, count: 5000, createdTime: at(0), queuedAt: at(1),
  attempts: 0, evaluationId: 1,
}, {
  roiPct: 8, grossRoiPct: 10, netRoiPct: 8, basis: "net", games: 12, trades: 40,
  evidence: {
    historyAsOf: at(-60).toISOString(), gameId: "match", gameIdentity: "event",
    feeModel: feeModel(null, zero), feeAssumptions: SIGNAL_FEE_ASSUMPTIONS,
    feeType: "quadratic", feeMultiplier: 1, entryFeeUsd: 1.5,
  },
}, at(2));

test("notification query contract rejects malformed filters and supplies defaults", () => {
  assert.deepEqual(GetKalshiNotificationsQueryParams.parse({}), { page: 1, q: "", sport: "all" });
  for (const bad of [{ page: 0 }, { page: "NaN" }, { page: 1.5 }, { q: "x".repeat(121) }, { sport: "x".repeat(81) }]) {
    assert.equal(GetKalshiNotificationsQueryParams.safeParse(bad).success, false);
  }
});

test("game context shows the real ET schedule and never guesses kickoff or a final", () => {
  const saved = { state: "scheduled", source: "milestone", checked_at: at(-30) };
  const upcoming = notificationGameContext("KXATPTOTAL-26NOV03MOLDRO-24", saved, "2026-11-03T01:30:00Z", zero);
  assert.equal(upcoming.status, "upcoming");
  assert.equal(upcoming.startsAt, "2026-11-03T01:30:00.000Z");
  assert.equal(upcoming.dateLabel, "02 nov 2026", "Prefer the real ET date over the ticker date");
  assert.equal(upcoming.timeLabel, "8:30 PM ET", "New York's November standard-time offset");
  const pastKickoff = notificationGameContext("TICKER", saved, at(-60), zero);
  assert.equal(pastKickoff.status, "unknown");
  assert.equal(pastKickoff.delayed, true);
  const live = { ...saved, state: "live", source: "live" };
  assert.equal(notificationGameContext("T", live, at(-60), zero).status, "live");
  for (const bad of [
    { ...live, checked_at: at(-301) }, { ...live, checked_at: at(61) },
    { ...live, checked_at: null }, { ...live, delayed: true }, { ...live, error: "Unavailable" },
  ]) {
    const context = notificationGameContext("T", bad, at(-60), zero);
    assert.equal(context.status, "unknown");
    assert.equal(context.delayed, true);
  }
  assert.equal(notificationGameContext("T", { ...live, checked_at: at(-300) }, at(-60), zero).status, "live");
  const final = notificationGameContext("T", { ...live, state: "finished", checked_at: at(-864000) }, at(-900000), zero);
  assert.equal(final.status, "finished", "A confirmed final does not need ongoing polling");
  assert.equal(final.delayed, false);
  assert.equal(notificationGameContext("T", { ...saved, source: "market", state: "finished" }, null, zero).status, "market_resolved");
  const dateOnly = notificationGameContext("KXATPTOTAL-26NOV02MOLDRO-24", null, null, zero);
  assert.equal(dateOnly.dateLabel, "02 nov 2026");
  assert.equal(dateOnly.timeLabel, "Hora por confirmar");
  assert.equal(dateOnly.startsAt, null);
  assert.equal(dateOnly.status, "unknown");
  assert.equal(notificationGameContext("KXUNKNOWN-26FEB31", null, "invalid", zero).dateLabel, "Sin fecha");
});

test("missing owner chat returns an explicit empty view without reading another chat", async () => {
  const result = await loadTelegramNotifications({}, null, at(1000), {
    execute: () => { throw new Error("Must not query any chat"); },
  }, true);
  assert.equal(result.chatConfigured, false);
  assert.equal(result.workersPaused, true);
  assert.equal(result.totalDelivered, 0);
  GetKalshiNotificationsResponse.parse(result);
});

test("mapper preserves NO price and gross/net evidence, and never fills old ROI with a new estimate", () => {
  const row = {
    trade_id: "frozen-1", ticker: "old", sent_at: at(120), removed_at: at(121),
    evidence: frozenEvidence(), sport: "Tennis", event_title: "Changed game", market_title: "Changed bet",
    price: .99, contracts: 9000, notional: 8910, outcome_side: "yes", market_url: "javascript:alert(1)",
    created_time: at(5),
  };
  const notice = notificationFeedRow(row);
  assert.equal(notice.price, .25);
  assert.equal(notice.side, "no");
  assert.equal(notice.sport, "Soccer");
  assert.equal(notice.notional, 1250);
  assert.equal(notice.marketTitle, "Real Madrid wins");
  assert.equal(notice.roi?.basis, "net");
  assert.equal(notice.roi?.roiPct, 8);
  assert.equal(notice.roi?.grossRoiPct, 10);
  assert.equal(notice.executedAt, at(0).toISOString());
  assert.equal(notice.removedFromTelegram, true);
  const gross = notificationFeedRow({ ...row, evidence: { ...frozenEvidence(),
    rule: { ...frozenEvidence().rule, basis: "gross" }, historicalRoiPct: 10, historicalNetRoiPct: null } });
  assert.equal(gross.roi?.roiPct, 10);
  assert.equal(gross.roi?.netRoiPct, null);
  const legacy = notificationFeedRow({ ...row, evidence: null, price: "NaN", contracts: null, notional: -1 });
  assert.equal(legacy.roi, null);
  assert.equal(legacy.detailsSource, "legacy");
  assert.equal(legacy.price, null);
  assert.equal(legacy.notional, null);
  assert.equal(legacy.marketUrl, null, "Unsafe destinations cannot become market links");
  assert.throws(() => notificationFeedRow({ ...row, evidence: { broken: true } }));
  assert.throws(() => notificationFeedRow({ ...row, sent_at: at(1) }), /after delivery/);
});

test("PostgreSQL history uses confirmed owner deliveries, frozen filters and all-page search without altering real tables", async t => {
  assert.equal(process.env.BOT_WORKERS_ENABLED, "false", "Development bot workers must remain paused.");
  await db.transaction(async tx => {
    // Temporary tables shadow this connection only and vanish on commit/rollback.
    // No real executions, messages, activation boundary or signal is written.
    for (const name of ["kalshi_alerts", "kalshi_notifications", "kalshi_signals", "kalshi_game_status"]) {
      await tx.execute(sql.raw(`CREATE TEMP TABLE ${name} (LIKE public.${name} INCLUDING ALL) ON COMMIT DROP`));
    }
    const insert = async (
      id: string, sentAt: Date | null, options: { chat?: string; sport?: string; title?: string;
        removed?: boolean; skipped?: boolean; confirmed?: boolean } = {},
    ) => {
      await tx.insert(alerts).values({
        tradeId: id, ticker: `KXNFLGAME-${id}-A`, title: "Saved sports trade",
        eventTitle: options.title ?? `Teams ${id}`, marketTitle: "Team A wins",
        marketUrl: "https://kalshi.com/markets/fixture", sport: options.sport ?? "Football",
        outcomeSide: "yes", bookSide: "bid", price: .8, notional: 1600, count: 2000, createdTime: at(-10),
      });
      await tx.insert(notices).values({
        chatId: options.chat ?? "owner-fixture", tradeId: id, sentAt, queuedAt: at(-5),
        messageId: sentAt && options.confirmed !== false ? 100 : null,
        removedAt: options.removed ? at(100) : null, skippedAt: options.skipped ? at(100) : null,
      });
    };
    for (let i = 0; i < 30; i++) {
      await insert(`legacy-${String(i).padStart(2, "0")}`, at(i + 1), {
        sport: i % 2 ? "Tennis" : "Football", removed: i === 0,
        title: i === 0 ? "Team 50% vs B" : i === 1 ? "Team_A vs B" : undefined,
      });
    }
    await insert("frozen-1", at(120), { title: "Wrong mutable game" });
    const evidence = frozenEvidence();
    await tx.insert(signals).values({
      chatId: "owner-fixture", tradeId: "frozen-1", ticker: evidence.ticker,
      evaluationId: 1, gameId: evidence.gameId, capturedAt: at(2), evidence,
    });
    await tx.insert(games).values([
      { ticker: evidence.ticker, milestoneId: "game-fixture", state: "finished", source: "market",
        checkedAt: at(995), marketTerminal: true },
      { ticker: "SAME-GAME-WINNER", milestoneId: "game-fixture", eventTicker: "another-market-family",
        state: "live", source: "live", startsAt: at(900), checkedAt: at(990) },
      { ticker: "UNRELATED-GAME", milestoneId: "different-game", state: "finished", source: "live",
        startsAt: at(-86400), checkedAt: at(999) },
    ]);
    await insert("other-owner", at(130), { chat: "foreign-fixture", sport: "Private sport" });
    await insert("pending", null);
    await insert("skipped", null, { skipped: true });
    await insert("unconfirmed", at(135), { confirmed: false });
    await insert("future", at(2000));
    const load = (filters = {}) => loadTelegramNotifications(filters, "owner-fixture", at(1000), tx, true);
    await t.test("only confirmed deliveries appear; removed chat notices are retained", async () => {
      const first = GetKalshiNotificationsResponse.parse(await load());
      assert.equal(first.totalDelivered, 31);
      assert.equal(first.total, 31);
      assert.equal(first.rows.length, 25);
      assert.equal(first.totalPages, 2);
      assert.equal(first.rows[0].tradeId, "frozen-1");
      assert.deepEqual(first.availableSports, ["Football", "Soccer", "Tennis"]);
      assert.equal(first.rows[0].roi?.roiPct, 8);
      const second = await load({ page: 2 });
      assert.equal(second.rows.length, 6);
      assert.equal(new Set([...first.rows, ...second.rows].map(n => n.tradeId)).size, 31);
      const old = second.rows.find(n => n.tradeId === "legacy-00")!;
      assert.equal(old.removedFromTelegram, true);
      assert.equal(old.roi, null);
      assert.equal(JSON.stringify(first).includes("owner-fixture"), false);
      assert.equal(JSON.stringify(first).includes("other-owner"), false);
    });
    await t.test("filters use original sent evidence; search includes every page", async () => {
      const found = await load({ q: "Real Madrid", sport: "Soccer" });
      assert.equal(found.total, 1);
      assert.equal(found.rows[0].sport, "Soccer");
      assert.equal(found.rows[0].price, .25);
      assert.equal((await load({ q: "Wrong mutable game" })).total, 0);
      const old = await load({ q: "legacy-00" });
      assert.equal(old.total, 1);
      assert.equal(old.rows[0].removedFromTelegram, true);
      assert.equal(old.totalDelivered, 31);
      assert.equal((await load({ page: 99999 })).page, 2);
      assert.equal((await load({ sport: "Missing" })).total, 0);
    });
    await t.test("search wildcards and SQL text are literal parameters", async () => {
      assert.equal((await load({ q: "%" })).total, 1);
      assert.equal((await load({ q: "_" })).total, 1);
      assert.equal((await load({ q: "' OR true --" })).total, 0);
      assert.equal((await load({ q: "\\", sport: "Soccer" })).total, 0);
    });
    await t.test("game lifecycle updates independently, shares exact game IDs and preserves original ROI", async () => {
      const first = (await load({ q: "frozen-1" })).rows[0];
      assert.equal(first.game.status, "live", "A resolved prop is not a finished game");
      assert.equal(first.game.startsAt, at(900).toISOString(), "Use the shared game's schedule");
      assert.equal(first.game.checkedAt, at(990).toISOString());
      await tx.update(games).set({ state: "finished", checkedAt: at(999) })
        .where(eq(games.ticker, "SAME-GAME-WINNER"));
      const updated = (await load({ q: "frozen-1" })).rows[0];
      assert.equal(updated.game.status, "finished");
      assert.deepEqual(updated.roi, first.roi, "Current lifecycle must not rewrite the original signal");
      assert.equal(updated.price, first.price);
      assert.equal(updated.sentAt, first.sentAt);
      await tx.update(games).set({ state: "live", checkedAt: at(600) })
        .where(eq(games.ticker, "SAME-GAME-WINNER"));
      const stale = (await load({ q: "frozen-1" })).rows[0];
      assert.equal(stale.game.status, "unknown");
      assert.equal(stale.game.delayed, true);
      assert.equal((await load({ q: "legacy-00" })).rows[0].game.status, "unknown",
        "Unrelated games or the delivery time do not supply missing game state");
    });
  });
});
