import assert from "node:assert/strict";
import { test } from "node:test";
import { accumulatePerformance, moneyPerformance, newYorkWeekKey, weeklyPerformance, type PerformanceTotals } from "./roi-performance";

test("calendar weeks use Monday New York time across both DST changes and year boundaries", () => {
  for (const [instant, expected] of [
    ["2026-10-26T03:59:59Z", "2026-10-19"],
    ["2026-10-26T04:00:00Z", "2026-10-26"],
    ["2026-11-02T04:59:59Z", "2026-10-26"],
    ["2026-11-02T05:00:00Z", "2026-11-02"],
    ["2026-03-09T03:59:59Z", "2026-03-02"],
    ["2026-03-09T04:00:00Z", "2026-03-09"],
    ["2027-01-01T12:00:00Z", "2026-12-28"],
  ]) assert.equal(newYorkWeekKey(new Date(instant)), expected, instant);
});

test("open weeks and clipped windows are partial, but exact Monday-midnight cutoffs are not", () => {
  const groups = new Map<string, PerformanceTotals>();
  for (const week of ["2026-10-19", "2026-10-26", "2026-11-02"]) {
    accumulatePerformance(groups, week, { trades: 5, wins: 3, profit: 100, gameId: "same-game" });
  }
  const now = new Date("2026-11-05T12:00:00Z");
  assert.deepEqual(weeklyPerformance(groups, now, null).map(w => w.partial), [false, false, true]);
  assert.deepEqual(weeklyPerformance(groups, now, new Date("2026-10-20T12:00:00Z")).map(w => w.partial),
    [true, false, true]);
  assert.equal(weeklyPerformance(groups, now, new Date("2026-10-19T04:00:00Z"))[0].partial, false);
  assert.equal(weeklyPerformance(groups, now, new Date("2026-10-19T04:00:00.001Z"))[0].partial, true);
  assert.ok(weeklyPerformance(groups, now, null).every(w => w.sampleWarning));
  assert.throws(() => weeklyPerformance(new Map([["not-a-date", groups.get("2026-10-19")!]]), now, null),
    /calendar-week/);
});

test("money comparisons expose the minimum game count and never convert absent data to a 0% rate", () => {
  const groups = new Map<string, PerformanceTotals>();
  accumulatePerformance(groups, "small", { trades: 1000, wins: 800, profit: 100, gameId: "ONE-GAME" });
  accumulatePerformance(groups, "small", { trades: 1000, wins: 800, profit: 100, gameId: "ONE-GAME" });
  const result = moneyPerformance(groups, 10);
  assert.equal(result[0].trades, 2000);
  assert.equal(result[0].games, 1);
  assert.equal(result[0].winRatePct, 80);
  assert.equal(result[0].meetsMinimum, false);
  assert.equal(result[0].sampleWarning, true);
  assert.equal(result[1].roiPct, null);
  assert.equal(result[1].winRatePct, null);
  assert.equal(result[1].meetsMinimum, false);
});

