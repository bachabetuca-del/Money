import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createFeeSnapshot, estimateHypotheticalEntryFee as fee, feeModel, feeSnapshotIsCurrent,
  marketFeeRule, parseFeeSnapshot, type FeeRule,
} from "./kalshi-fees";
import { fetchFeeSnapshot } from "./kalshi-fee-source";
import { netEstimate, rawNetRoiPct } from "./roi-performance";

const now = new Date("2026-11-02T12:00:00Z");
const standard: FeeRule = { feeType: "quadratic", multiplier: 1 };
const series = [{ ticker: "SPORT", fee_type: "quadratic", fee_multiplier: 1 }];
const change = (patch = {}) => ({ event_ticker: "SPORT-EVENT", scheduled_ts: "2026-11-01T00:00:00Z",
  fee_type_override: null, fee_multiplier_override: .5, ...patch });

test("current taker formula uses $100/P theoretical contracts, not public trade notional", () => {
  for (const [price, expected] of [[.5, 3.5], [.25, 5.25], [.75, 1.75], [.01, 6.93],
    [.99, .07], [.0001, 6.9993], [.9999, .0007], [1, 0]]) {
    assert.equal(fee(price, standard), expected, String(price));
  }
  assert.equal(fee(.5, standard, 50), 1.75, "100 actual contracts at 50 cents");
  assert.equal(fee(.5, standard, .5), .0175, "Current direct-member rounding, not the older cent table");
});

test("centicent rounding is per entry, exact on boundaries, and honors fractional multipliers", () => {
  assert.equal(fee(.9999, { ...standard, multiplier: .1 }), .0001);
  assert.equal(fee(.9999, { ...standard, multiplier: .5 }), .0004);
  assert.equal(fee(.5, { ...standard, multiplier: 2 }), 7);
  assert.equal(fee(.5, { ...standard, multiplier: 0 }), 0, "Explicit zero fees, never absent metadata");
  assert.equal(fee(.5, { ...standard, multiplier: 1e-7 }), .0001);
  assert.equal(fee(.9999, { ...standard, multiplier: .5 })! * 2, .0008);
  assert.equal(fee(.9999, { ...standard, multiplier: .5 }, 200), .0007,
    "Rounding a pooled notional is NOT two independently executed $100 entries");
});

test("maker exceptions are not assumed free; production estimator defaults to taker", () => {
  assert.equal(fee(.5, standard, 100, "maker"), 0);
  assert.equal(fee(.5, { ...standard, feeType: "quadratic_with_maker_fees" }, 100, "maker"), .875);
  assert.equal(fee(.5, { ...standard, feeType: "quadratic_with_combo_maker_fees" }, 100, "maker"), 1.75);
  assert.equal(fee(.5, { ...standard, feeType: "quadratic_with_maker_fees" }), 3.5);
});

test("unknown, flat, invalid and missing fee rules never become zero fees", () => {
  for (const rule of [null, { ...standard, feeType: "flat" }, { ...standard, feeType: "future-model" },
    { ...standard, multiplier: -1 }, { ...standard, multiplier: Infinity }, { ...standard, multiplier: NaN }]) {
    assert.equal(fee(.5, rule), null);
  }
  for (const price of [0, -.1, 1.001, NaN, Infinity]) assert.equal(fee(price, standard), null);
  for (const stake of [0, -100, NaN, Infinity]) assert.equal(fee(.5, standard, stake), null);
});

test("event overrides and null clearing use the parent series, including explicit zero", () => {
  const snapshot = createFeeSnapshot(series, [change()], [], now);
  assert.equal(marketFeeRule(snapshot, "SPORT-EVENT-A", "SPORT-EVENT", now)?.multiplier, .5);
  assert.equal(marketFeeRule(snapshot, "SPORT-OTHER-A", "SPORT-OTHER", now)?.multiplier, 1);
  assert.equal(marketFeeRule(snapshot, "MISSING-EVENT-A", "MISSING-EVENT", now), null);
  assert.equal(marketFeeRule(snapshot, "SPORT-EVENT-A", null, now), null, "Event identity is required to check exceptions");
  const cleared = createFeeSnapshot(series, [change({ scheduled_ts: "2026-11-02T00:00:00Z",
    fee_multiplier_override: null }), change()], [], now);
  assert.equal(marketFeeRule(cleared, "SPORT-EVENT-A", "SPORT-EVENT", now)?.multiplier, 1);
  const free = createFeeSnapshot(series, [change({ fee_multiplier_override: 0 })], [], now);
  assert.equal(fee(.5, marketFeeRule(free, "SPORT-EVENT-A", "SPORT-EVENT", now)), 0);
  const flat = createFeeSnapshot(series, [change({ fee_type_override: "flat" })], [], now);
  assert.equal(fee(.5, marketFeeRule(flat, "SPORT-EVENT-A", "SPORT-EVENT", now)), null);
});

test("stale, future and newly scheduled fees cannot silently support a net estimate", () => {
  const future = "2026-11-02T13:00:00Z";
  for (const snapshot of [
    createFeeSnapshot(series, [change({ scheduled_ts: future })], [], now),
    createFeeSnapshot(series, [], [{ scheduled_ts: future }], now),
  ]) {
    assert.equal(snapshot.validUntil, future.replace("Z", ".000Z"));
    assert.equal(feeSnapshotIsCurrent(snapshot, now), true);
    assert.equal(feeSnapshotIsCurrent(snapshot, new Date(future)), false);
    assert.equal(marketFeeRule(snapshot, "SPORT-EVENT-A", "SPORT-EVENT", new Date(future)), null);
    assert.equal(feeModel(snapshot, new Date(future)).status, "stale");
  }
  const normal = createFeeSnapshot(series, [], [], now);
  assert.equal(feeSnapshotIsCurrent(normal, new Date("2026-11-03T12:00:00Z")), false);
  assert.equal(feeSnapshotIsCurrent(normal, new Date("2026-11-02T11:59:59Z")), false);
  assert.equal(feeModel(null, now).status, "unavailable");
  assert.deepEqual(parseFeeSnapshot(JSON.parse(JSON.stringify(normal))), JSON.parse(JSON.stringify(normal)));
  assert.equal(parseFeeSnapshot({ ...normal, version: "unrecognized" }), null);
  assert.equal(parseFeeSnapshot({ ...normal, events: { E: { feeType: null, multiplier: -1 } } }), null);
});

test("bad overrides or conflicting effective rules reject a snapshot instead of masking a surcharge", () => {
  assert.throws(() => createFeeSnapshot(series, [change({ fee_multiplier_override: -1 })], [], now), /override/);
  assert.throws(() => createFeeSnapshot(series, [change(), change({ fee_multiplier_override: 2 })], [], now), /Conflicting/);
  assert.throws(() => createFeeSnapshot(series, [], [{ scheduled_ts: "not-a-date" }], now), /scheduled/);
});

test("fee source exhausts event pagination, supports known empty lists, and fails closed on errors", async () => {
  const paths: string[] = [];
  const snapshot = await fetchFeeSnapshot(series, async <T>(path: string) => {
    paths.push(path);
    return (path === "/series/fee_changes" ? { series_fee_change_arr: [] } :
      path.includes("cursor=page2") ? { event_fee_changes: [change()], cursor: "" } :
      { event_fee_changes: [], cursor: "page2" }) as T;
  }, now);
  assert.equal(paths.length, 3);
  assert.equal(snapshot.events["SPORT-EVENT"].multiplier, .5);
  for (const response of [
    { event_fee_changes: null, cursor: "" }, { event_fee_changes: [], cursor: "stuck" },
    { event_fee_changes: [] },
  ]) await assert.rejects(fetchFeeSnapshot(series, async <T>(path: string) =>
    (path === "/series/fee_changes" ? { series_fee_change_arr: [] } : response) as T, now));
  await assert.rejects(fetchFeeSnapshot(series, async () => { throw new Error("HTTP 429"); }, now), /429/);
  const empty = await fetchFeeSnapshot(series, async <T>(path: string) =>
    (path === "/series/fee_changes" ? { series_fee_change_arr: [] } : { event_fee_changes: [], cursor: "" }) as T, now);
  assert.equal(marketFeeRule(empty, "SPORT-EVENT-A", "SPORT-EVENT", now)?.multiplier, 1);
});

test("net denominator includes entry fees on both winners and losers; missing coverage remains null", () => {
  const cost = { fees: 3.5, feeTrades: 1 };
  const win = netEstimate(100, 1, cost);
  assert.equal(win.roiPct, 93.2367);
  assert.equal(win.profit, 96.5);
  assert.equal(win.cashOutlay, 103.5);
  const loss = netEstimate(-100, 1, cost);
  assert.equal(loss.profit, -103.5);
  assert.equal(loss.roiPct, -100);
  assert.equal(rawNetRoiPct(7, 1, cost), 100 * 3.5 / 103.5);
  const partial = netEstimate(200, 2, cost);
  assert.deepEqual(partial, { roiPct: null, profit: null, fees: null, cashOutlay: null, coveredTrades: 1, missingTrades: 1 });
  assert.equal(netEstimate(0, 0, {}).roiPct, null);
  assert.equal(netEstimate(100, 1, { fees: 0, feeTrades: 1 }).roiPct, 100);
  for (const invalid of [{ fees: -1, feeTrades: 1 }, { fees: NaN, feeTrades: 1 }, { fees: 0, feeTrades: 2 }]) {
    assert.equal(netEstimate(100, 1, invalid).roiPct, null);
  }
});
