import assert from "node:assert/strict";
import { test } from "node:test";
import { roiSourceFilters, roiFilteredRows, preparedRoiRanking } from "./roi-read-model";
import { buildRoiRanking, type RoiRollup } from "./roi-ranking";
import { selectRoiEntries } from "./roi-method";

const now = new Date("2026-11-18T12:00:00Z");
function row(id: number, patch: Partial<RoiRollup> = {}): RoiRollup {
  return {
    ticker: `KXNFLGAME-G${id}-A`, sport: "Football", eventTitle: "A vs B", marketTitle: "A wins",
    marketUrl: "https://example.test", gameId: `G${id}`, bucket: 4, side: "yes",
    moneyBand: "medium", weekStart: "2026-11-16", category: "settled", historyVerified: true,
    historyError: false, phase: "prematch", identityVerified: true, inputValid: true,
    firstTradeId: `trade-${id}`, firstPrice: .4, firstFee: 4.2, officialResult: id % 3 ? "yes" : "no",
    firstIsRecent: true, trades: 2, wins: id % 3 ? 2 : 0, profit: id % 3 ? 300 : -200,
    recentTrades: 2, recentProfit: id % 3 ? 300 : -200, fees: 8.4, feeTrades: 2,
    recentFees: 8.4, recentFeeTrades: 2, firstAt: `2026-11-17T10:${String(id % 60).padStart(2, "0")}:00Z`,
    lastAt: "2026-11-17T11:00:00Z", checkedAt: "2026-11-18T11:00:00Z", error: false,
    ...patch,
  };
}

test("all normal bands and sides share one source; custom large floor stays inside SQL", () => {
  for (const band of ["all", "small", "medium", "large"] as const) {
    for (const direction of ["all", "yes", "no"] as const) {
      assert.deepEqual(roiSourceFilters({ band, direction }, 10_000), { band: "all", direction: "all" });
    }
  }
  assert.deepEqual(roiSourceFilters({ band: "large", direction: "no" }, 12_000), { band: "large", direction: "all" });
  assert.deepEqual(roiSourceFilters({ band: "all", direction: "no" }, 12_000), { band: "all", direction: "all" });
});

test("filtered views stay isolated, retain unknown observations and preserve stable identity", () => {
  const history = [row(1, { moneyBand: "small" }), row(2), row(3, { moneyBand: "large", side: "no" }),
    row(4, { category: "pending", side: "unknown" })];
  const all = { band: "all" as const, direction: "all" as const };
  assert.equal(roiFilteredRows(history, all), history);
  const yes = { band: "medium" as const, direction: "yes" as const };
  const first = roiFilteredRows(history, yes);
  assert.deepEqual(first, [history[1]]);
  assert.equal(roiFilteredRows(history, yes), first);
  assert.deepEqual(roiFilteredRows(history, { band: "all", direction: "no" }), [history[2]]);
  assert.equal(roiFilteredRows(history, { band: "medium", direction: "all" }).length, 2);
  const newSnapshot = history.slice();
  assert.notEqual(roiFilteredRows(newSnapshot, yes), first);
});

test("cached rankings equal uncached calculations for unit, phase, group, sample and sort filters", () => {
  const history = Array.from({ length: 65 }, (_, i) => row(i));
  history.push(row(100, { phase: "live", officialResult: "no" }));
  history.push(row(101, { phase: "unknown", side: "no" }));
  history.push(row(102, { category: "incomplete", historyVerified: false }));
  for (const unit of ["game", "execution"] as const) for (const phase of ["prematch", "live", "unknown"] as const) {
    for (const groupBy of ["segment", "sport"] as const) for (const minGames of [1, 50]) {
      const options = { unit, phase, groupBy, minGames, sortBy: "roi" as const, now, since: null };
      const expectedSelected = selectRoiEntries(history, unit, phase);
      const expectedRanking = buildRoiRanking(expectedSelected.rows, groupBy, minGames,
        { now, sortBy: "roi", since: null, separatePatterns: unit !== "execution" });
      const cached = preparedRoiRanking(history, options);
      assert.deepEqual(cached, { selected: expectedSelected, ranking: expectedRanking });
      assert.equal(preparedRoiRanking(history, options), cached);
    }
  }
});

test("new snapshots and as-of times cannot reuse an older ranking", () => {
  const history = [row(1)];
  const options = { unit: "game" as const, phase: "prematch" as const, groupBy: "segment" as const,
    minGames: 1, sortBy: "roi" as const, now, since: null };
  const first = preparedRoiRanking(history, options);
  assert.notEqual(preparedRoiRanking(history.slice(), options), first);
  assert.notEqual(preparedRoiRanking(history, { ...options, now: new Date(now.getTime() + 60_000) }), first);
  assert.equal(history[0].trades, 2, "selection must not mutate cached source history");
});
