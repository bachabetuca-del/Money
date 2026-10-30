import assert from "node:assert/strict";
import { test } from "node:test";
import { buildRoiRanking, hypotheticalProfit, oddsBucket, type RoiRollup } from "./roi-ranking";
import {
  MarketSettlementWorker, officialSettlement, type SettlementStore, type SettlementWrite,
} from "./kalshi-settlement-source";

const now = new Date("2026-10-30T12:00:00Z");
function row(changes: Partial<RoiRollup> = {}): RoiRollup {
  return {
    ticker: "KXNFLGAME-26OCT29AB-A", sport: "Football", eventTitle: "A vs B",
    marketTitle: "A wins", gameId: "game1", marketUrl: "https://kalshi.com/markets/a",
    bucket: 5, category: "settled", trades: 1, wins: 1, profit: 100, recentTrades: 1, recentProfit: 100,
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
  for (const group of ["sport", "marketType", "odds", "segment", "market"] as const) {
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
