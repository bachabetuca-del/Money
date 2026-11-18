import test from "node:test";
import assert from "node:assert/strict";
import { roiPhaseAt, selectRoiEntries, ROI_METHOD_VERSION } from "./roi-method";
import { auditRoiRows } from "./roi-audit";
import { buildRoiRanking, type RoiRollup } from "./roi-ranking";
import { rawNetRoiPct } from "./roi-performance";
import { buildNotificationRoiLookup, qualifiesForNotificationRoi } from "./telegram-notification-roi";
import { buildExplorerRoi } from "./explorer-roi";
import { officialSettlement } from "./kalshi-settlement-source";

const now = new Date("2026-11-18T12:00:00Z");
function row(game: string, patch: Partial<RoiRollup> = {}): RoiRollup {
  return { ticker: `KXNFLSPREAD-${game}-A3`, sport: "Football", eventTitle: "A vs B",
    marketTitle: "A wins by over 3 points", marketUrl: "https://example.test",
    gameId: game, phase: "prematch", identityVerified: true, inputValid: true,
    bucket: 4, side: "yes", moneyBand: "medium", category: "settled",
    historyVerified: true, historyError: false, officialResult: "yes",
    trades: 200, wins: 200, profit: 30000, recentTrades: 200, recentProfit: 30000,
    fees: 840, feeTrades: 200, recentFees: 840, recentFeeTrades: 200,
    firstTradeId: `id-${game}`, firstPrice: .4, firstFee: 4.2, firstIsRecent: true,
    firstAt: "2026-11-10T10:00:00.000Z", lastAt: "2026-11-10T10:30:00.000Z",
    weekStart: "2026-11-09", checkedAt: "2026-11-11T00:00:00.000Z", error: false, ...patch };
}
test("phase boundaries use milestone schedule but never infer live from a past time", () => {
  const g = { milestoneId: "G", startsAt: "2026-11-18T12:00:00Z" };
  assert.equal(roiPhaseAt("2026-11-18T11:50:00Z", g), "prematch");
  assert.equal(roiPhaseAt("2026-11-18T11:50:00.001Z", g), "nearStart");
  assert.equal(roiPhaseAt("2026-11-18T12:00:00Z", g), "unknown");
  assert.equal(roiPhaseAt("2026-11-18T13:00:00Z", { ...g, state: "live" }), "unknown");
  const live = { ...g, source: "live", state: "live", checkedAt: "2026-11-18T13:00:00Z" };
  assert.equal(roiPhaseAt("2026-11-18T13:02:00Z", live), "live");
  assert.equal(roiPhaseAt("2026-11-18T13:02:00.001Z", live), "unknown");
  assert.equal(roiPhaseAt("2026-11-18T12:59:59Z", live), "unknown", "Future feed cannot prove the past phase");
  for (const patch of [{ delayed: true }, { error: "timeout" }, { source: "market" }, { milestoneId: null }])
    assert.equal(roiPhaseAt("2026-11-18T13:00:30Z", { ...live, ...patch }), "unknown");
});
test("first entry wins by time then ID across tickers/weeks, not by known profitability", () => {
  const earlier = row("G", { firstTradeId: "a", officialResult: "no", profit: -20000, wins: 0 });
  const later = row("G", { firstTradeId: "b", firstAt: "2026-11-10T11:00:00.000Z", firstPrice: .49 });
  const tied = row("G", { firstTradeId: "z", ticker: "KXNFLSPREAD-G-B5" });
  for (const inputs of [[later, tied, earlier], [earlier, later, tied]]) {
    const s = selectRoiEntries(inputs);
    assert.equal(s.rows.length, 1);
    assert.equal(s.rows[0].firstTradeId, "a");
    assert.equal(s.rows[0].profit, -100);
    assert.equal(s.methodology.repeatedExecutions, 599);
    assert.equal(s.methodology.rawExecutions, 600);
  }
  for (const category of ["pending", "incomplete", "excluded"] as const) {
    const selected = selectRoiEntries([{ ...earlier, category }, later]).rows;
    assert.equal(selected[0].category, category);
    assert.equal(buildRoiRanking(selected, "segment", 1).summary.settledTrades, 0);
  }
});
test("separate patterns retain side, money, price and phase; ambiguous/invalid entries cannot enter", () => {
  const inputs = [row("G"), row("G", { side: "no" }), row("G", { moneyBand: "large" }),
    row("G", { bucket: 5 }), row("G", { phase: "live" }), row("H", { identityVerified: false }),
    row("I", { inputValid: false }), row("J", { ticker: "KXCHAMP-J-A", marketTitle: "Champion" })];
  assert.equal(selectRoiEntries(inputs).rows.length, 4);
  assert.equal(selectRoiEntries(inputs, "game", "live").rows.length, 1);
  assert.equal(selectRoiEntries(inputs, "execution").rows.reduce((s, r) => s + r.trades, 0), 1400);
  const primary = buildRoiRanking(selectRoiEntries(inputs).rows, "segment", 1, { separatePatterns: true });
  assert.equal(primary.rows.length, 4);
});
test("one busy winner cannot dominate ten losing games; no records are deleted", () => {
  const inputs = [row("WIN"), ...Array.from({ length: 10 }, (_, i) =>
    row(`LOSS${i}`, { officialResult: "no", trades: 1, wins: 0, profit: -100 }))];
  const selected = selectRoiEntries(inputs);
  const main = buildRoiRanking(selected.rows, "sport", 1).rows[0];
  assert.equal(main.trades, 11);
  assert.equal(main.wins, 1);
  assert.equal(main.profit, -850);
  assert.equal(inputs[0].trades, 200);
  assert.equal(selectRoiEntries(inputs, "execution").methodology.selectedEntries, 210);
  assert.ok(Math.abs(main.audit!.largestGameSharePct - 100 / 11) < 1e-9);
  assert.equal(main.audit!.withoutBestGameRoiPct, -100);
});
test("manual payout and fee examples match; unknown costs stay unknown", () => {
  assert.equal(selectRoiEntries([row("G")]).rows[0].profit, 150);
  assert.equal(rawNetRoiPct(2000, 100, { fees: 350, feeTrades: 100 }), 100 * 1650 / 10350);
  const selected = selectRoiEntries([row("G", { firstFee: null })]).rows;
  assert.equal(buildRoiRanking(selected, "sport", 1).rows[0].net.roiPct, null);
  assert.deepEqual(officialSettlement({ ticker: "T", status: "settled", result: "no" }), { terminal: true, result: "no" });
  assert.equal(officialSettlement({ ticker: "T", status: "settled", result: "yes", is_provisional: true }).terminal, false);
  assert.equal(officialSettlement({ ticker: "T", status: "settled", result: "scalar" }).result, "unsupported");
});
test("cluster audit separates whole games, keeps unknown intervals and does not certify an edge", () => {
  assert.equal(auditRoiRows([row("G")]).grossLower95Pct, null);
  const many = Array.from({ length: 10 }, (_, i) => row(`G${i}`, {
    firstAt: `2026-11-${String(i + 1).padStart(2, "0")}T10:00:00.000Z`,
  }));
  const a = auditRoiRows([...many, row("G0", { firstAt: "2026-11-17T10:00:00.000Z" })]);
  assert.equal(a.earlierGames, 7);
  assert.equal(a.laterGames, 3);
  assert.equal(a.chronologicalCutoff, "2026-11-08T10:00:00.000Z");
  assert.notEqual(a.grossLower95Pct, null);
});
test("production-style alerts and explorer agree on the same first-entry sample and phase", () => {
  const history = Array.from({ length: 50 }, (_, i) => row(`G${i}`));
  const trade = { ticker: "KXNFLSPREAD-NEW-A3", eventTitle: "A vs B", marketTitle: "A wins by over 3",
    sport: "Football", outcomeSide: "yes", price: .4, notional: 6000 };
  const lookup = buildNotificationRoiLookup(history, "gross", "prematch");
  const roi = lookup(trade, "NEW")!;
  assert.equal(roi.methodVersion, ROI_METHOD_VERSION);
  assert.equal(roi.games, 50);
  assert.equal(roi.trades, 50);
  assert.equal(roi.roiPct, 150);
  assert.equal(qualifiesForNotificationRoi(roi), true);
  assert.equal(lookup(trade, "G1"), null);
  assert.equal(buildNotificationRoiLookup(history, "gross", "live")(trade), null);
  assert.equal(buildNotificationRoiLookup(history, "gross", "unknown")(trade), null);
  const [market] = buildExplorerRoi([{ ticker: trade.ticker, sport: "Football", marketType: "spread" }],
    [{ ticker: trade.ticker, side: "yes", price: .4, observedAt: now.toISOString(), phase: "prematch" }], history, now, true);
  assert.equal(market.signals[0].roiPct, roi.roiPct);
  assert.equal(market.signals[0].trades, 50);
  assert.equal(market.signals[0].level, "good");
});
