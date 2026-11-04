import assert from "node:assert/strict";
import { test } from "node:test";
import { buildExplorerRoi, type RoiReferencePrice } from "./explorer-roi";
import type { RoiRollup } from "./roi-ranking";

const now = new Date("2026-10-31T12:00:00Z");
const market = { ticker: "KXEPLGAME-LIVE-A", sport: "Soccer", marketType: "winner" };
const price: RoiReferencePrice = { ticker: market.ticker, side: "yes", price: .5, observedAt: "2026-10-31T11:00:00Z" };
function history(roi = 10, patch: Partial<RoiRollup> = {}): RoiRollup[] {
  return Array.from({ length: 50 }, (_, i) => ({
    ticker: `KXEPLGAME-HIST${i}-A`, sport: "Soccer", eventTitle: "A vs B",
    marketTitle: "A wins", gameId: `game${i}`, marketUrl: "", bucket: 5, side: "yes",
    moneyBand: "small", weekStart: "2026-10-26",
    category: "settled", historyVerified: true,
    trades: 3, wins: 2, profit: roi * 3, recentTrades: 3, recentProfit: roi * 3,
    firstAt: "2026-10-30T10:00:00Z", lastAt: "2026-10-30T10:00:00Z",
    checkedAt: "2026-10-30T20:00:00Z", error: false, ...patch,
  }));
}
const signals = (rows = history(), prices = [price]) => buildExplorerRoi([market], prices, rows, now)[0].signals;

test("ROI color boundaries: +10 inclusive green, 0 inclusive yellow, negative red", () => {
  for (const [roi, level] of [[10, "good"], [9.99, "medium"], [0, "medium"], [-.01, "bad"], [-100, "bad"]] as const) {
    const [yes, no] = signals(history(roi));
    assert.equal(yes.level, level);
    assert.equal(yes.roiPct, roi);
    assert.equal(yes.games, 50);
    assert.equal(yes.trades, 150);
    assert.equal(yes.reason, null);
    assert.equal(no.level, "insufficient");
    assert.equal(no.reason, "no_price");
  }
});

test("YES and NO match their own odds group without complementing NO prices", () => {
  const [yes, no] = signals([...history(15), ...history(-20, { side: "no", bucket: 2 })],
    [price, { ...price, side: "no", price: .25 }]);
  assert.equal(yes.level, "good");
  assert.equal(no.level, "bad");
  assert.equal(no.oddsMin, .2);
  assert.equal(no.oddsMax, .3);
  assert.equal(no.roiPct, -20);
});

test("side, sport, type and odds never fall back to a broader profitable group", () => {
  for (const rows of [history(20, { side: "no" }), history(20, { sport: "Football" }),
    history(20, { ticker: "KXEPLTOTAL-HIST-A" }), history(20, { bucket: 6 })]) {
    const [yes] = signals(rows);
    assert.equal(yes.reason, "no_history");
    assert.equal(yes.roiPct, null);
  }
});

test("pending, excluded, partial and unverified history cannot receive ROI colors", () => {
  for (const rows of [history(100, { category: "pending" }), history(100, { category: "excluded" }),
    history(100, { category: "incomplete" }), history(100, { historyVerified: false }),
    history(100, { historyVerified: undefined })]) {
    assert.equal(signals(rows)[0].reason, "no_history");
  }
});

test("small samples stay gray with their number visible, not misleadingly green or red", () => {
  for (const rows of [history(300).slice(0, 49), history(-100, { trades: 1 }).slice(0, 29),
    history(300, { gameId: "same-game", trades: 1000 })]) {
    const [s] = signals(rows);
    assert.equal(s.level, "insufficient");
    assert.equal(s.reason, "small_sample");
    assert.notEqual(s.roiPct, null);
  }
});

test("unclassified markets remain neutral even if mixed history has high returns", () => {
  const [row] = buildExplorerRoi([{ ...market, marketType: "other" }], [price], history(200), now);
  assert.ok(row.signals.every(s => s.level === "insufficient" && s.reason === "unclassified"));
});

test("latest valid observation wins; future, invalid and missing prices are not invented", () => {
  const refs = [price, { ...price, price: .65, observedAt: "2026-10-31T11:05:00Z" },
    { ...price, price: .4, observedAt: "2026-11-01T11:05:00Z" },
    { ...price, price: NaN, observedAt: "2026-10-31T11:06:00Z" }];
  assert.equal(signals(history(15, { bucket: 6 }), refs)[0].price, .65);
  for (const badPrice of [0, 1.1, NaN, Infinity]) {
    assert.equal(signals(history(), [{ ...price, price: badPrice }])[0].reason, "no_price");
  }
  assert.equal(signals(history(), [{ ...price, observedAt: "not-a-date" }])[0].reason, "no_price");
});

test("negative groups are available even below the first 25 ranking rows", () => {
  const winners = Array.from({ length: 30 }, (_, i) => history(50, { sport: `OtherSport${i}` })).flat();
  assert.equal(signals([...winners, ...history(-15)])[0].level, "bad");
});

test("100-cent upper bound belongs to last bucket; no silent optimistic fallback", () => {
  const [s] = signals(history(0, { bucket: 9 }), [{ ...price, price: 1 }]);
  assert.equal(s.oddsMin, .9);
  assert.equal(s.oddsMax, 1);
  assert.equal(s.level, "medium");
});
