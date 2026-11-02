import assert from "node:assert/strict";
import { test } from "node:test";
import { buildNotificationRoiLookup, qualifiesForNotificationRoi } from "./telegram-notification-roi";
import { buildRoiRanking, type RoiRollup } from "./roi-ranking";
import { buildExplorerRoi } from "./explorer-roi";

const now = new Date("2026-10-31T12:00:00Z");
const trade = {
  ticker: "KXEPLGAME-LIVE-A", sport: "Soccer", eventTitle: "A vs B", marketTitle: "A wins",
  outcomeSide: "yes", bookSide: "bid", price: .5,
};
const history = (roi = 7, patch: Partial<RoiRollup> = {}): RoiRollup[] =>
  Array.from({ length: 10 }, (_, i) => ({
    ticker: `KXEPLGAME-HIST${i}-A`, sport: "Soccer", eventTitle: "A vs B", marketTitle: "A wins",
    gameId: `game-${i}`, marketUrl: "", bucket: 5, side: "yes", moneyBand: "large",
    weekStart: "2026-10-26", category: "settled", historyVerified: true,
    trades: 3, wins: 2, profit: roi * 3, recentTrades: 3, recentProfit: roi * 3,
    firstAt: "2026-10-30T10:00:00Z", lastAt: "2026-10-30T10:00:00Z",
    checkedAt: "2026-10-30T20:00:00Z", error: false, ...patch,
  }));

test("notification ROI agrees with the ranking and website comparison, not a color category", () => {
  const rows = history(), result = buildNotificationRoiLookup(rows)(trade);
  assert.deepEqual(result, { roiPct: 7, trades: 30, games: 10 });
  assert.equal(result?.roiPct, buildRoiRanking(rows, "segment", 1, { now }).rows[0].roiPct);
  const [market] = buildExplorerRoi([{ ticker: trade.ticker, sport: trade.sport, marketType: "winner" }],
    [{ ticker: trade.ticker, side: "yes", price: trade.price, observedAt: now.toISOString() }], rows, now);
  assert.equal(market.signals[0].level, "medium", "A +7% notice must not require the website's +10% green threshold");
  assert.equal(qualifiesForNotificationRoi(result), true);
});

test("raw ROI below +7% cannot qualify even when presentation rounds it up to +7%", () => {
  const rows = history(6.999999);
  assert.equal(buildRoiRanking(rows, "segment", 1, { now }).rows[0].roiPct, 7);
  assert.equal(qualifiesForNotificationRoi(buildNotificationRoiLookup(rows)(trade)), false);
});

test("sport, market type, actual side, odds bucket and $10k+ cohort must all match", () => {
  for (const patch of [
    { sport: "Football" }, { ticker: "KXEPLTOTAL-HIST-A" }, { side: "no" }, { bucket: 6 },
    { moneyBand: "small" }, { moneyBand: "medium" },
  ] satisfies Partial<RoiRollup>[]) {
    assert.equal(buildNotificationRoiLookup(history(90, patch))(trade), null, JSON.stringify(patch));
  }
  const lookup = buildNotificationRoiLookup([...history(7), ...history(90, { moneyBand: "small" })]);
  assert.deepEqual(lookup(trade), { roiPct: 7, games: 10, trades: 30 });
});

test("NO uses its own execution price, with canonical direction fallback only when needed", () => {
  const lookup = buildNotificationRoiLookup(history(8, { side: "no", bucket: 2 }));
  assert.equal(qualifiesForNotificationRoi(lookup({ ...trade, outcomeSide: "no", price: .25 })), true);
  assert.equal(lookup({ ...trade, outcomeSide: "no", price: .75 }), null);
  assert.equal(qualifiesForNotificationRoi(lookup({
    ...trade, outcomeSide: "unknown", bookSide: "ask", price: .25,
  })), true);
  assert.equal(lookup({ ...trade, outcomeSide: "yes", bookSide: "ask", price: .25 }), null,
    "Explicit YES cannot be inverted by the book side");
});

test("unverified, unfinished, unsupported and invalid history never supports a notification", () => {
  for (const patch of [
    { category: "pending" }, { category: "excluded" }, { category: "incomplete" },
    { historyVerified: false }, { historyVerified: undefined }, { historyError: true },
    { side: "unknown" }, { profit: NaN }, { profit: Infinity }, { trades: 0 },
  ] satisfies Partial<RoiRollup>[]) {
    assert.equal(buildNotificationRoiLookup(history(100, patch))(trade), null, JSON.stringify(patch));
  }
});

test("distinct game and execution sample minimums cannot be bypassed with a high ROI", () => {
  for (const rows of [
    history(100).slice(0, 9), history(100, { trades: 2 }),
    history(100, { gameId: "one-game", trades: 1000 }),
  ]) assert.equal(qualifiesForNotificationRoi(buildNotificationRoiLookup(rows)(trade)), false);
});

test("unknown market, side or sport and invalid prices fail closed; last odds bucket includes 100 cents", () => {
  const lookup = buildNotificationRoiLookup(history(7));
  for (const patch of [
    { price: 0 }, { price: 1.1 }, { price: NaN }, { price: Infinity },
    { sport: "" }, { outcomeSide: "unknown", bookSide: "unknown" },
    { ticker: "UNKNOWN", eventTitle: null, marketTitle: null },
  ]) assert.equal(lookup({ ...trade, ...patch }), null);
  assert.equal(qualifiesForNotificationRoi(buildNotificationRoiLookup(history(7, { bucket: 9 }))({
    ...trade, price: 1,
  })), true);
});
