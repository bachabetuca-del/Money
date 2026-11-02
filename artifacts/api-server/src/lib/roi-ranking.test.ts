import assert from "node:assert/strict";
import { test } from "node:test";
import { buildRoiRanking, hypotheticalProfit, oddsBucket, type RoiRollup } from "./roi-ranking";
import { checkedHistoryRows } from "./history-page-integrity";
import type { PublicTrade } from "./kalshi-monitor";
import { publicTradeExecution } from "./kalshi-trade-execution";
import {
  MarketSettlementWorker, officialSettlement, type SettlementStore, type SettlementWrite,
} from "./kalshi-settlement-source";

const now = new Date("2026-10-30T12:00:00Z");
function row(changes: Partial<RoiRollup> = {}): RoiRollup {
  return {
    ticker: "KXNFLGAME-26OCT29AB-A", sport: "Football", eventTitle: "A vs B",
    marketTitle: "A wins", gameId: "game1", marketUrl: "https://kalshi.com/markets/a",
    bucket: 5, side: "yes", category: "settled", trades: 1, wins: 1, profit: 100, recentTrades: 1, recentProfit: 100,
    moneyBand: "large", weekStart: "2026-10-26",
    firstAt: "2026-10-29T12:00:00.000Z", lastAt: "2026-10-29T12:00:00.000Z",
    checkedAt: now.toISOString(), error: false, ...changes,
  };
}

test("equal $100 stake, not contract count or original notional; correct YES and NO payouts", () => {
  assert.equal(hypotheticalProfit(0.5, "yes", "yes"), 100);
  assert.equal(hypotheticalProfit(0.25, "no", "no"), 300);
  assert.equal(hypotheticalProfit(0.8, "no", "yes"), -100);
  assert.equal(hypotheticalProfit(1, "yes", "yes"), 0);
  for (const price of [0, -1, NaN, Infinity, 1.01]) assert.equal(hypotheticalProfit(price, "yes", "yes"), null);
  assert.equal(hypotheticalProfit(0.2, "unknown", "yes"), null);
  assert.equal(hypotheticalProfit(0.2, "yes", "pending"), null);
});

test("10-cent odds bins have no overlap and include 100 cents", () => {
  assert.equal(oddsBucket(0.0001), 0);
  assert.equal(oddsBucket(0.0999), 0);
  assert.equal(oddsBucket(0.1), 1);
  assert.equal(oddsBucket(0.2), 2);
  assert.equal(oddsBucket(0.8999), 8);
  assert.equal(oddsBucket(0.9), 9);
  assert.equal(oddsBucket(1), 9);
});

test("ROI sums profit then divides invested; pending and unsupported never become losses", () => {
  const { rows, summary } = buildRoiRanking([
    row({ trades: 2, wins: 1, profit: 200, recentTrades: 1, recentProfit: -100 }),
    row({ ticker: "KXNFLSPREAD-26OCT29AB-A", trades: 1, wins: 0, profit: -100 }),
    row({ ticker: "PENDING", category: "pending", trades: 7, error: true }),
    row({ ticker: "EXCLUDED", category: "excluded", trades: 3 }),
  ], "sport", 1);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].trades, 3);
  assert.equal(rows[0].invested, 300);
  assert.equal(rows[0].profit, 100);
  assert.equal(rows[0].roiPct, 33.3333);
  assert.equal(rows[0].winRatePct, 33.33);
  assert.equal(rows[0].recentRoiPct, 0);
  assert.equal(rows[0].games, 1);
  assert.equal(rows[0].markets, 2);
  assert.equal(rows[0].sampleWarning, true);
  assert.equal(summary.savedTrades, 13);
  assert.equal(summary.pendingTrades, 7);
  assert.equal(summary.excludedTrades, 3);
  assert.equal(summary.settlementErrors, 1);
  assert.equal(summary.roiPct, 33.3333);
  assert.equal(buildRoiRanking([row()], "sport", 10).rows.length, 0);
});

test("all grouping modes retain the same settled totals and independent group identity", () => {
  const input = [
    row(), row({ ticker: "KXNFLTOTAL-26OCT29AB", marketTitle: "Total points", bucket: 3, profit: -100, wins: 0 }),
    row({ ticker: "KXATPMATCH-26OCT29CD", sport: "Tennis", gameId: "game2", bucket: 5 }),
  ];
  for (const group of ["sport", "marketType", "odds", "segment", "market", "amount"] as const) {
    const { rows, summary } = buildRoiRanking(input, group, 1);
    assert.equal(rows.reduce((n, r) => n + r.trades, 0), 3);
    assert.equal(rows.reduce((n, r) => n + r.profit, 0), 100);
    assert.equal(summary.games, 2);
    assert.equal(new Set(rows.map(r => r.id)).size, rows.length);
    assert.deepEqual(rows.map(r => r.rank), rows.map((_, i) => i + 1));
    assert(rows.every((r, i) => i === 0 || rows[i - 1].roiPct >= r.roiPct));
  }
  const types = buildRoiRanking(input, "marketType", 1).rows.map(r => r.marketType);
  assert.deepEqual(new Set(types), new Set(["winner", "total"]));
  assert.equal(buildRoiRanking(input, "segment", 1).rows.length, 3);
});

test("no settled data has null ROI, including recent; errors and pending are visible", () => {
  const { rows, summary } = buildRoiRanking([row({ category: "pending" })], "sport", 1);
  assert.deepEqual(rows, []);
  assert.equal(summary.roiPct, null);
  assert.equal(summary.recentRoiPct, null);
  const settled = buildRoiRanking([row({ recentTrades: 0, recentProfit: 0 })], "sport", 1);
  assert.equal(settled.rows[0].recentRoiPct, null);
});

test("fees preserve gross samples in every view, weekly/amount cohorts and recent returns", () => {
  const input = [
    row({ fees: 3.5, feeTrades: 1, recentFees: 3.5, recentFeeTrades: 1, moneyBand: "small" }),
    row({ ticker: "KXNFLGAME-B-A", gameId: "other", profit: -100, wins: 0, fees: 1.75, feeTrades: 1,
      recentTrades: 0, recentProfit: 0, recentFees: 0, recentFeeTrades: 0, moneyBand: "large", weekStart: "2026-10-19" }),
    row({ category: "pending", fees: 7, feeTrades: 1 }),
  ];
  for (const group of ["sport", "marketType", "odds", "segment", "market", "amount"] as const) {
    const ranked = buildRoiRanking(input, group, 1, { now });
    const grossOnly = buildRoiRanking(input.map(r => ({ ...r, fees: undefined, feeTrades: undefined })), group, 1, { now });
    assert.equal(ranked.summary.roiPct, grossOnly.summary.roiPct);
    assert.equal(ranked.summary.settledTrades, 2);
    assert.equal(ranked.summary.profit, 0);
    assert.equal(ranked.summary.net.fees, 5.25);
    assert.equal(ranked.summary.net.roiPct, -2.5579);
    assert.equal(ranked.summary.recentNet.roiPct, 93.2367);
    for (const r of ranked.rows) {
      assert.equal(r.net.coveredTrades, r.trades);
      assert.equal(r.weekly.reduce((n, w) => n + (w.net.fees ?? 0), 0), r.net.fees);
      assert.equal(r.moneyBands.reduce((n, b) => n + (b.net.fees ?? 0), 0), r.net.fees);
    }
  }
});

test("net sorting is optional, unknown fees sort last but do not hide gross observations", () => {
  const input = [
    row({ sport: "Highest gross", profit: 10, fees: 7, feeTrades: 1 }),
    row({ sport: "Best net", profit: 9, fees: 0, feeTrades: 1 }),
    row({ sport: "Unknown net", profit: 80 }),
  ];
  const normal = buildRoiRanking(input, "sport", 1);
  assert.equal(normal.rows[0].sport, "Unknown net");
  const net = buildRoiRanking(input, "sport", 1, { sortBy: "netRoi" });
  assert.deepEqual(net.rows.map(r => r.sport), ["Best net", "Highest gross", "Unknown net"]);
  assert.equal(net.rows[2].net.roiPct, null);
  assert.equal(net.summary.settledTrades, 3);
  assert.equal(net.summary.net.missingTrades, 1);
  assert.equal(net.summary.net.roiPct, null, "Cannot compare gross all-trades against a fee-covered subset");
});

test("soccer market reclassification preserves execution returns, sides and game counts", () => {
  const input = [
    row({ ticker: "KXEPLBTTS-26OCT30AB-YES", marketTitle: "Both Teams To Score", sport: "Soccer", profit: 100 }),
    row({ ticker: "KXEPLBTTS-26OCT30AB-NO", marketTitle: "Both Teams To Score", sport: "Soccer", side: "no", wins: 0, profit: -100 }),
    row({ ticker: "KXLALIGASCORE-26OCT30AB-00", marketTitle: "Final score Draw 0-0?", sport: "Soccer", profit: 400 }),
    row({ ticker: "KXEFLCUPADVANCE-26OCT30AB-A", marketTitle: "A To Advance", sport: "Soccer", profit: 100 }),
    row({ ticker: "KXSERIEA1H-26OCT30AB-A", marketTitle: "A wins 1st Half", sport: "Soccer", profit: 100 }),
    row({ ticker: "KXEPLCORNERS-26OCT30AB-10", marketTitle: "10+ total corners", sport: "Soccer", profit: 100 }),
  ];
  const { rows, summary } = buildRoiRanking(input, "segment", 1, { now });
  assert.deepEqual(new Set(rows.map(r => r.marketType)), new Set(["btts", "correctScore", "qualification", "periodWinner", "corners"]));
  assert.equal(rows.length, 6, "YES and NO remain separate within the new market categories");
  assert.equal(rows.reduce((sum, r) => sum + r.trades, 0), 6);
  assert.equal(rows.reduce((sum, r) => sum + r.profit, 0), 700);
  assert.equal(summary.games, 1);
  assert.equal(summary.roiPct, 116.6667);
  assert.deepEqual(summary, buildRoiRanking(input, "sport", 1, { now }).summary);
});

test("accuracy and ROI rank different money bands without changing the underlying results", () => {
  const input = [
    row({ ticker: "SMALL-WIN", gameId: "S1", moneyBand: "small", trades: 8, wins: 8, profit: 200 }),
    row({ ticker: "SMALL-LOSS", gameId: "S2", moneyBand: "small", trades: 2, wins: 0, profit: -200 }),
    row({ ticker: "LARGE-WIN", gameId: "L1", moneyBand: "large", trades: 4, wins: 4, profit: 800 }),
    row({ ticker: "LARGE-LOSS", gameId: "L2", moneyBand: "large", trades: 6, wins: 0, profit: -600 }),
  ];
  const roi = buildRoiRanking(input, "amount", 2, { now });
  const accuracy = buildRoiRanking(input, "amount", 2, { sortBy: "winRate", now });
  assert.equal(roi.rows[0].moneyBand, "large");
  assert.equal(roi.rows[0].roiPct, 20);
  assert.equal(roi.rows[0].winRatePct, 40);
  assert.equal(accuracy.rows[0].moneyBand, "small");
  assert.equal(accuracy.rows[0].winRatePct, 80);
  assert.equal(accuracy.rows[0].roiPct, 0);
  assert.deepEqual(roi.summary, accuracy.summary);
  assert.equal(accuracy.rows[0].games, 2);
  assert.equal(accuracy.rows[0].trades, 10);
  assert.equal(buildRoiRanking(input, "amount", 3, { now }).rows.length, 0);
});

test("weekly and size breakdowns preserve weighted ROI, empty weeks and distinct game identities", () => {
  const input = [
    row({ weekStart: "2026-10-05", moneyBand: "small", trades: 20, wins: 20, profit: 2000 }),
    row({ ticker: "SECOND", weekStart: "2026-10-19", moneyBand: "medium", trades: 1, wins: 0, profit: -100 }),
    row({ ticker: "PENDING", category: "pending", weekStart: "2026-10-26", moneyBand: "large" }),
  ];
  const { rows: [result] } = buildRoiRanking(input, "sport", 1, { now });
  assert.equal(result.games, 1, "Multiple markets, weeks and sizes from one game are not independent games");
  assert.equal(result.trades, 21);
  assert.equal(result.roiPct, 90.4762, "Total ROI is not the mean of the weekly percentages");
  assert.deepEqual(result.weekly.map(w => w.weekStart), ["2026-10-05", "2026-10-12", "2026-10-19"]);
  assert.deepEqual(result.weekly.map(w => w.roiPct), [100, null, -100]);
  assert.deepEqual(result.weekly.map(w => w.games), [1, 0, 1]);
  assert.equal(result.weekly.reduce((sum, w) => sum + w.trades, 0), result.trades);
  assert.equal(result.moneyBand, null);
  assert.deepEqual(result.moneyBands.map(b => b.trades), [20, 1, 0]);
  assert.deepEqual(result.moneyBands.map(b => b.meetsMinimum), [true, true, false]);
  assert.equal(result.moneyBands[2].roiPct, null, "Pending trades never become size-band returns");
});

test("combined rankings separate YES and NO at identical own-side odds, preserving aggregate totals", () => {
  const input = [
    row({ side: "yes", trades: 3, wins: 2, profit: 100 }),
    row({ side: "no", trades: 2, wins: 0, profit: -200 }),
    row({ side: "yes", ticker: "KXNFLGAME-26OCT30CD-A", gameId: "game2", profit: 100 }),
  ];
  const combined = buildRoiRanking(input, "segment", 1);
  assert.equal(combined.rows.length, 2);
  const [yes, no] = combined.rows;
  assert.equal(yes.side, "yes");
  assert.equal(yes.roiPct, 50);
  assert.equal(yes.trades, 4);
  assert.equal(yes.wins, 3);
  assert.equal(yes.games, 2);
  assert.equal(no.side, "no");
  assert.equal(no.roiPct, -100);
  assert.equal(no.trades, 2);
  assert.equal(no.wins, 0);
  assert.deepEqual([no.oddsMin, no.oddsMax], [0.5, 0.6]);
  assert.notEqual(yes.id, no.id);
  assert.match(yes.label, /YES/);
  assert.match(no.label, /NO/);
  const sport = buildRoiRanking(input, "sport", 1);
  assert.equal(sport.rows[0].side, null);
  assert.equal(sport.rows[0].trades, 6);
  assert.equal(sport.rows[0].roiPct, 0);
  assert.deepEqual(combined.summary, sport.summary);
});

test("minimum games applies separately to each combined side, not their pooled sample", () => {
  const input = [row(), row({ side: "no", gameId: "game2", ticker: "KXNFLGAME-26OCT30CD-A" })];
  assert.equal(buildRoiRanking(input, "segment", 2).rows.length, 0);
  assert.equal(buildRoiRanking(input, "sport", 2).rows.length, 1);
  assert.equal(buildRoiRanking([row({ side: "no" })], "sport", 1).rows[0].side, "no");
});

test("history quality distinguishes excluded resolved trades from pending settlements without inventing ROI", () => {
  const { summary, rows } = buildRoiRanking([
    row({ category: "incomplete", historyVerified: false, historyError: true, trades: 12 }),
    row({ ticker: "PENDING", category: "pending", historyVerified: false, trades: 5 }),
    row({ ticker: "VERIFIED", historyVerified: true }),
  ], "sport", 1);
  assert.equal(summary.savedTrades, 18);
  assert.equal(summary.historyExcludedTrades, 12);
  assert.equal(summary.excludedTrades, 12);
  assert.equal(summary.pendingTrades, 5);
  assert.equal(summary.settledTrades, 1);
  assert.equal(summary.verifiedHistoryMarkets, 1);
  assert.equal(summary.incompleteHistoryMarkets, 2);
  assert.equal(summary.historyErrorMarkets, 1);
  assert.equal(rows[0].roiPct, 100);
});

test("history pages validate own-side money, identity and timestamps, deduplicate identical records and reject conflicts", () => {
  const trade: PublicTrade = {
    tradeId: "ID", ticker: "T", title: "Game", eventTitle: "A vs B", marketTitle: "A wins", sport: "Tennis",
    price: 0.4, count: 10000, notional: 4000, outcomeSide: "no", bookSide: "ask",
    createdTime: "2026-10-29T12:00:00Z", blockTrade: false, marketUrl: "https://kalshi.com",
  };
  const job = { ticker: "T", snapshotAt: now };
  assert.equal(checkedHistoryRows([trade, { ...trade }], job).length, 1);
  assert.equal(checkedHistoryRows([trade, { ...trade, createdTime: "2026-10-29T12:00:00+00:00" }], job).length, 1);
  for (const patch of [
    { ticker: "OTHER" }, { notional: 4500 }, { price: 0 }, { count: NaN },
    { createdTime: "2026-11-01T12:00:00Z" }, { outcomeSide: "unknown" }, { tradeId: "" },
  ]) assert.throws(() => checkedHistoryRows([{ ...trade, ...patch }], job), /integrity/);
  assert.throws(() => checkedHistoryRows([trade, { ...trade, price: 0.5, notional: 5000 }], job), /conflicting/);
});

test("canonical ingestion preserves sub-cent value so 5k/10k boundaries do not move when stored", () => {
  const below = publicTradeExecution({ taker_outcome_side: "yes", yes_price_dollars: "0.9999", count_fp: "10001.00" });
  const above = publicTradeExecution({ taker_outcome_side: "no", no_price_dollars: "0.0001", count_fp: "100000001.00" });
  assert.equal(below?.notional, 9999.9999);
  assert.equal(above?.notional, 10000.0001);
});

test("official market settlement is distinct from final score, closure and provisional results", () => {
  for (const market of [
    { status: "closed", result: "yes" }, { status: "determined", result: "no" },
    { status: "settled", result: "yes", is_provisional: true },
  ]) assert.deepEqual(officialSettlement({ ticker: "T", ...market }), { result: null, terminal: false });
  assert.deepEqual(officialSettlement({ ticker: "T", status: "settled", result: "yes", settlement_value_dollars: "1.0000" }), { result: "yes", terminal: true });
  assert.deepEqual(officialSettlement({ ticker: "T", status: "finalized", result: "no", settlement_value_dollars: "0.0000" }), { result: "no", terminal: true });
  for (const market of [
    { result: "scalar" }, { result: "yes", settlement_value_dollars: "0.5" },
    { result: "no", settlement_value_dollars: "" }, { result: "yes", notional_value_dollars: "100" },
    { result: "yes", market_type: "scalar" },
  ]) assert.deepEqual(officialSettlement({ ticker: "T", status: "settled", ...market }), { result: "unsupported", terminal: true });
});

function store(current = ["YES", "NO", "OPEN", "ARCHIVE"], historical: string[] = []) {
  const writes: SettlementWrite[] = [];
  const db: SettlementStore = {
    candidates: async (h, limit) => (h ? historical : current).slice(0, limit),
    save: async value => { writes.push(value); },
  };
  return { db, writes };
}

test("worker batches current markets, schedules archive lookup and never invents outcomes", async () => {
  const { db, writes } = store();
  const paths: string[] = [];
  const worker = new MarketSettlementWorker(db, async <T>(path: string) => {
    paths.push(path);
    return { markets: [
      { ticker: "YES", status: "settled", result: "yes" },
      { ticker: "NO", status: "settled", result: "no" },
      { ticker: "OPEN", status: "active", result: "" },
      { ticker: "OTHER", status: "settled", result: "yes" },
    ] } as T;
  }, () => false);
  await worker.tick(now);
  assert.equal(paths.length, 1);
  assert.equal(new URLSearchParams(paths[0].split("?")[1]).get("tickers"), "YES,NO,OPEN,ARCHIVE");
  assert.equal(writes.length, 4);
  assert.equal(writes.find(w => w.ticker === "YES")?.result, "yes");
  assert.equal(writes.find(w => w.ticker === "NO")?.result, "no");
  assert.equal(writes.find(w => w.ticker === "OPEN")?.terminal, false);
  assert.equal(writes.find(w => w.ticker === "ARCHIVE")?.historical, true);
  assert.equal(writes.find(w => w.ticker === "ARCHIVE")?.result, null);
});

test("historical batch is bounded, paused worker does nothing, duplicate ticks share busy guard", async () => {
  const s = store([], Array.from({ length: 20 }, (_, i) => `OLD${i}`));
  let paused = true, requests = 0;
  const worker = new MarketSettlementWorker(s.db, async <T>(path: string) => {
    requests++;
    await Promise.resolve();
    return { market: { ticker: decodeURIComponent(path.split("/").pop()!), status: "settled", result: "no" } } as T;
  }, () => paused);
  await worker.tick(now);
  assert.equal(requests, 0);
  paused = false;
  await Promise.all([worker.tick(now), worker.tick(now)]);
  assert.equal(requests, 5);
  assert.equal(s.writes.length, 5);
  assert(s.writes.every(w => w.terminal && w.result === "no"));
});

test("provider failure leaves outcomes pending with delayed retry instead of fabricated ROI", async () => {
  const s = store(["X"]);
  const worker = new MarketSettlementWorker(s.db, async () => { throw new Error("HTTP 429"); }, () => false);
  await assert.rejects(worker.tick(now), /HTTP 429/);
  assert.equal(s.writes[0].terminal, false);
  assert.equal(s.writes[0].result, null);
  assert(s.writes[0].error);
  assert(s.writes[0].nextCheckAt.getTime() > now.getTime() + 60_000);
});
