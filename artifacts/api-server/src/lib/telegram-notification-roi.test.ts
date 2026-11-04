import assert from "node:assert/strict";
import { test } from "node:test";
import { buildNotificationRoiLookup, notificationRoiBasis, qualifiesForNotificationRoi, type NotificationRoi } from "./telegram-notification-roi";
import { buildRoiRanking, type RoiRollup } from "./roi-ranking";
import { buildExplorerRoi } from "./explorer-roi";

const now = new Date("2026-10-31T12:00:00Z");
const expectedGross = (roiPct: number): NotificationRoi =>
  ({ roiPct, trades: 150, games: 50, basis: "gross", grossRoiPct: roiPct, netRoiPct: null });
const trade = {
  ticker: "KXEPLGAME-LIVE-A", sport: "Soccer", eventTitle: "A vs B", marketTitle: "A wins",
  outcomeSide: "yes", bookSide: "bid", price: .5, notional: 15000,
};
const history = (roi = 7, patch: Partial<RoiRollup> = {}): RoiRollup[] =>
  Array.from({ length: 50 }, (_, i) => ({
    ticker: `KXEPLGAME-HIST${i}-A`, sport: "Soccer", eventTitle: "A vs B", marketTitle: "A wins",
    gameId: `game-${i}`, marketUrl: "", bucket: 5, side: "yes", moneyBand: "large",
    weekStart: "2026-10-26", category: "settled", historyVerified: true,
    trades: 3, wins: 2, profit: roi * 3, recentTrades: 3, recentProfit: roi * 3,
    firstAt: "2026-10-30T10:00:00Z", lastAt: "2026-10-30T10:00:00Z",
    checkedAt: "2026-10-30T20:00:00Z", error: false, ...patch,
  }));

test("notification ROI agrees with the ranking and website comparison, not a color category", () => {
  const rows = history(), result = buildNotificationRoiLookup(rows)(trade);
  assert.deepEqual(result, expectedGross(7));
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

test("sport, market type, actual side, odds bucket and the execution's amount band must all match", () => {
  for (const patch of [
    { sport: "Football" }, { ticker: "KXEPLTOTAL-HIST-A" }, { side: "no" }, { bucket: 6 },
    { moneyBand: "small" }, { moneyBand: "medium" },
  ] satisfies Partial<RoiRollup>[]) {
    assert.equal(buildNotificationRoiLookup(history(90, patch))(trade), null, JSON.stringify(patch));
  }
  const lookup = buildNotificationRoiLookup([...history(7), ...history(90, { moneyBand: "small" })]);
  assert.deepEqual(lookup(trade), expectedGross(7));
});

test("small, medium and large executions use their own histories with nonoverlapping amount boundaries", () => {
  const lookup = buildNotificationRoiLookup([
    ...history(8, { moneyBand: "small" }), ...history(9, { moneyBand: "medium" }), ...history(-4),
  ]);
  for (const [notional, roiPct] of [
    [1000, 8], [4999.99, 8], [5000, 8], [5000.01, 9], [7500, 9],
    [9999.999, 9], [10000, -4], [10000.01, -4], [100000, -4],
  ]) {
    const result = lookup({ ...trade, notional });
    assert.deepEqual(result, expectedGross(roiPct), String(notional));
    assert.equal(qualifiesForNotificationRoi(result), roiPct >= 7);
  }
  for (const notional of [0, 999.99, NaN, Infinity, -Infinity]) {
    assert.equal(lookup({ ...trade, notional }), null);
  }
});

test("legacy settings stay gross; a net choice is explicit and unknown settings fail closed", () => {
  assert.equal(notificationRoiBasis(undefined), "gross");
  assert.equal(notificationRoiBasis(null), "gross");
  assert.equal(notificationRoiBasis("gross"), "gross");
  assert.equal(notificationRoiBasis("net"), "net");
  assert.throws(() => notificationRoiBasis("best"), /Unknown/);
});

test("the same +7% gross history passes gross but not net after commissions", () => {
  const rows = history(7, { fees: 10.5, feeTrades: 3 });
  const gross = buildNotificationRoiLookup(rows)(trade);
  const net = buildNotificationRoiLookup(rows, "net")(trade);
  assert.equal(gross?.grossRoiPct, 7);
  assert.equal(qualifiesForNotificationRoi(gross), true);
  assert.equal(qualifiesForNotificationRoi(net), false);
  assert.equal(net?.basis, "net");
  assert.equal(net?.roiPct, gross?.netRoiPct);
  assert.equal(buildRoiRanking(rows, "segment", 1, { now }).rows[0].net.roiPct,
    Number(net!.roiPct.toFixed(4)));
});

test("net +7% is inclusive before presentation rounding; a rounded-up result cannot qualify", () => {
  for (const [roiPct, allowed] of [[6.999999, false], [7, true], [7.000001, true]] as const) {
    assert.equal(qualifiesForNotificationRoi({
      ...expectedGross(20), basis: "net", netRoiPct: roiPct, roiPct,
    }), allowed);
  }
  const below = history(0, { fees: 12, feeTrades: 3, profit: 33.83999999 });
  assert.equal(buildRoiRanking(below, "segment", 1, { now }).rows[0].net.roiPct, 7);
  assert.equal(qualifiesForNotificationRoi(buildNotificationRoiLookup(below, "net")(trade)), false);
});

test("net never borrows gross, a different money band or incomplete fee coverage", () => {
  for (const patch of [{}, { fees: 0, feeTrades: 2 }, { fees: -1, feeTrades: 3 }, { fees: NaN, feeTrades: 3 }]) {
    const rows = [...history(80, patch), ...history(100, { moneyBand: "small", fees: 0, feeTrades: 3 })];
    assert.equal(buildNotificationRoiLookup(rows, "net")(trade), null);
    assert.equal(qualifiesForNotificationRoi(buildNotificationRoiLookup(rows, "gross")(trade)), true);
  }
  const rows = [...history(9, { fees: 0, feeTrades: 3 }), ...history(80, { fees: 0, feeTrades: 3, side: "no", bucket: 2 })];
  assert.equal(buildNotificationRoiLookup(rows, "net")(trade)?.roiPct, 9);
  assert.equal(buildNotificationRoiLookup(rows, "net")({ ...trade, outcomeSide: "no", price: .25 })?.roiPct, 80);
  const partial = history(80, { fees: 0, feeTrades: 3 });
  partial[0].feeTrades = 2;
  assert.equal(buildNotificationRoiLookup(partial, "net")(trade), null, "No cheaper covered-subset backtest");
});

test("both bases honor sample minima and exact amount boundaries", () => {
  const rows = [...history(7, { moneyBand: "small", fees: 0, feeTrades: 3 }),
    ...history(6.999999, { moneyBand: "medium", fees: 0, feeTrades: 3 }),
    ...history(8, { moneyBand: "large", fees: 0, feeTrades: 3 })];
  for (const basis of ["gross", "net"] as const) {
    const lookup = buildNotificationRoiLookup(rows, basis);
    for (const [notional, allowed] of [[999.99, false], [1000, true], [5000, true], [5000.0001, false],
      [9999.9999, false], [10000, true], [100000, true]] as const) {
      assert.equal(qualifiesForNotificationRoi(lookup({ ...trade, notional })), allowed);
    }
    for (const patch of [{ gameId: "one-game" }, { trades: 0, feeTrades: 0 }]) {
      assert.equal(qualifiesForNotificationRoi(buildNotificationRoiLookup(history(80, { fees: 0, feeTrades: 3, ...patch }), basis)(trade)), false);
    }
  }
});

test("a profitable different amount band cannot substitute for missing evidence or increase its sample", () => {
  const lookup = buildNotificationRoiLookup([
    ...history(50, { moneyBand: "large", trades: 1000 }),
    ...history(8, { moneyBand: "small", trades: 2 }).slice(0, 49),
  ]);
  assert.equal(lookup({ ...trade, notional: 7500 }), null);
  const small = lookup({ ...trade, notional: 1000 });
  assert.equal(small?.trades, 98);
  assert.equal(qualifiesForNotificationRoi(small), false);
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
    history(100).slice(0, 49), history(100, { trades: 0 }),
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
