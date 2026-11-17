import assert from "node:assert/strict";
import { test } from "node:test";
import { buildSignalEvidence, frozenNotification, signalGameIdentity, signalOutcome, SIGNAL_FEE_ASSUMPTIONS } from "./signal-evaluation";
import { feeModel } from "./kalshi-fees";
import type { NotificationJob } from "./telegram-trade-notifications";
import type { NotificationRoi } from "./telegram-notification-roi";

const now = new Date("2026-11-02T15:00:00Z");
const job: NotificationJob = {
  tradeId: "signal-fixture", ticker: "KXNFLGAME-FIXTURE-A", chatId: "fixture", attempts: 0, evaluationId: 1,
  createdTime: new Date(now.getTime() - 2000), queuedAt: new Date(now.getTime() - 1000),
  price: .5, count: 20000, notional: 10000, outcomeSide: "yes", sport: "Football",
  eventTitle: "Team A vs Team B", marketTitle: "Team A wins", marketUrl: "https://kalshi.com/markets/fixture",
};
const roi: NotificationRoi = {
  roiPct: 15, basis: "gross", grossRoiPct: 15, netRoiPct: null, games: 50, trades: 30,
  evidence: {
    historyAsOf: new Date(now.getTime() - 60000).toISOString(), ...signalGameIdentity(job.ticker),
    feeModel: feeModel(null, now), feeAssumptions: SIGNAL_FEE_ASSUMPTIONS,
    feeType: null, feeMultiplier: null, entryFeeUsd: null,
  },
};
const resolution = {
  sentAt: new Date(now.getTime() + 1000), skippedAt: null, attempts: 1,
  result: "yes", terminal: true, checkedAt: new Date(now.getTime() + 60000), error: null,
};

test("freezes the exact side, price, rule, unrounded ROI, sample, observation times and unavailable fee model", () => {
  const signal = buildSignalEvidence(job, roi, now);
  assert.equal(signal.rule.basis, "gross");
  assert.equal(signal.rule.minimumRoiPct, 15);
  assert.equal(signal.rule.minimumGames, 50);
  assert.equal(signal.rule.minimumTrades, 30);
  assert.equal(signal.rule.coverage, "verified");
  assert.equal(signal.rule.window, "all");
  assert.equal(signal.rule.stakeUsd, 100);
  assert.equal(signal.rule.side, "yes");
  assert.equal(signal.rule.marketType, "winner");
  assert.equal(signal.rule.oddsMin, .5);
  assert.equal(signal.rule.oddsMax, .6);
  assert.equal(signal.price, .5);
  assert.equal(signal.notional, 10000);
  assert.equal(signal.historicalRoiPct, 15);
  assert.equal(signal.historicalGames, 50);
  assert.equal(signal.historicalTrades, 30);
  assert.equal(signal.observedAt, job.createdTime.toISOString());
  assert.equal(signal.queuedAt, job.queuedAt!.toISOString());
  assert.equal(signal.capturedAt, now.toISOString());
  assert.equal(signal.feeModel.status, "unavailable");
  assert.equal(signal.entryFeeUsd, null);
  const retried = frozenNotification(signal, { ...job, price: .8, outcomeSide: "no", notional: 5000 });
  assert.equal(retried.trade.price, .5);
  assert.equal(retried.trade.outcomeSide, "yes");
  assert.equal(retried.trade.notional, 10000);
  assert.equal(retried.roi.roiPct, 15);
});

test("all amount boundaries are frozen without rounding or borrowing another band's evidence", () => {
  for (const [notional, band] of [[1000, "small"], [5000, "small"], [5000.0001, "medium"],
    [9999.9999, "medium"], [10000, "large"]] as const) {
    const signal = buildSignalEvidence({ ...job, notional, count: notional / job.price }, roi, now);
    assert.equal(signal.rule.moneyBand, band);
    assert.equal(signal.notional, notional);
    if (band === "medium") {
      assert.equal(signal.rule.amountMinInclusive, false);
      assert.equal(signal.rule.amountMaxInclusive, false);
    }
  }
});

test("rejects missing provenance, below-rule ROI, invalid execution and future evidence rather than fabricating a record", () => {
  assert.throws(() => buildSignalEvidence(job, { ...roi, evidence: undefined }, now));
  assert.throws(() => buildSignalEvidence(job, { ...roi, roiPct: 14.99999, grossRoiPct: 14.99999 }, now));
  assert.throws(() => buildSignalEvidence(job, { ...roi, games: 9 }, now));
  assert.throws(() => buildSignalEvidence({ ...job, price: 0 }, roi, now));
  assert.throws(() => buildSignalEvidence({ ...job, count: 5 }, roi, now));
  assert.throws(() => buildSignalEvidence({ ...job, createdTime: new Date(now.getTime() + 1000) }, roi, now));
  assert.throws(() => buildSignalEvidence(job, { ...roi, evidence: {
    ...roi.evidence!, historyAsOf: new Date(now.getTime() + 1000).toISOString(),
  } }, now));
});

test("only confirmed deliveries with later official binary results generate returns; unknown net never becomes zero fees", () => {
  const evidence = buildSignalEvidence(job, roi, now);
  const won = signalOutcome(evidence, resolution);
  assert.equal(won.status, "settled");
  assert.equal(won.grossProfit, 100);
  assert.equal(won.grossRoiPct, 100);
  assert.equal(won.netProfit, null);
  const lost = signalOutcome(evidence, { ...resolution, result: "no" });
  assert.equal(lost.grossProfit, -100);
  for (const overrides of [
    { terminal: false }, { result: null, terminal: false }, { error: "Resolution unavailable" }, { checkedAt: null },
  ]) {
    const pending = signalOutcome(evidence, { ...resolution, ...overrides });
    assert.equal(pending.status, "pending");
    assert.equal(pending.grossProfit, null);
  }
  for (const skippedAt of [null, now]) {
    const unsent = signalOutcome(evidence, { ...resolution, sentAt: null, skippedAt });
    assert.equal(unsent.status, "not_sent");
    assert.equal(unsent.grossProfit, null);
    assert.equal(unsent.delivery, skippedAt ? "skipped" : "pending");
  }
  for (const result of ["unsupported", null, "void", "0.5"]) {
    const excluded = signalOutcome(evidence, { ...resolution, result });
    assert.equal(excluded.status, "excluded");
    assert.equal(excluded.exclusionReason, "unsupported_settlement");
    assert.equal(excluded.grossProfit, null);
  }
  for (const checkedAt of [now, resolution.sentAt]) {
    const excluded = signalOutcome(evidence, { ...resolution, checkedAt });
    assert.equal(excluded.exclusionReason, "settled_before_alert");
    assert.equal(excluded.grossProfit, null);
  }
});

test("NO returns and estimated net preserve equal entry notional and the frozen fee even with a later model version", () => {
  const evidence = buildSignalEvidence({ ...job, outcomeSide: "no", price: .25, count: 40000 }, roi, now);
  evidence.entryFeeUsd = 5.25;
  evidence.feeModel.version = "frozen-older-model";
  const won = signalOutcome(evidence, { ...resolution, result: "no" });
  assert.equal(won.grossProfit, 300);
  assert.equal(won.netProfit, 294.75);
  assert.equal(won.netRoiPct, 100 * 294.75 / 105.25);
  const lost = signalOutcome(evidence, resolution);
  assert.equal(lost.netProfit, -105.25);
  assert.equal(lost.netRoiPct, -100);
  assert.equal(won.evidence.feeModel.version, "frozen-older-model");
});

test("distinct-game identity prefers the available shared milestone and labels fallbacks instead of inventing independence", () => {
  assert.deepEqual(signalGameIdentity("KX-A-B", { milestoneId: "same-game", eventTicker: "different-event" }),
    { gameId: "same-game", gameIdentity: "milestone" });
  assert.deepEqual(signalGameIdentity("KX-A-B", { milestoneId: null, eventTicker: "event" }),
    { gameId: "event", gameIdentity: "event" });
  assert.deepEqual(signalGameIdentity("KX-A-B"), { gameId: "KX-A", gameIdentity: "ticker" });
});
