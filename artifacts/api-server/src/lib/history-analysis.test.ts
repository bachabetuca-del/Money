import test from "node:test";
import assert from "node:assert/strict";
import {
  buildHistoryExportParts, csvCell, csvTrade, EXPORT_COLUMNS, exportMetadata, exportTrade,
  HISTORY_EXPORT_ROWS_PER_PART, serializeHistoryChunk, valueBand,
} from "./history-export-format";
import { ANALYSIS_PROMPT, AnalysisError, GameAnalysisService, analysisGameState, type GameContext } from "./game-analysis";
import type { GameAnalysis } from "@workspace/api-zod";

const time = new Date("2026-10-29T12:00:00Z");
const context: GameContext = {
  selectedTicker: "GAME-YES", gameName: "A vs B", selectedBet: "A gana", sport: "Soccer",
  dataThrough: time.toISOString(), latestTradeAt: time.toISOString(),
  totalTrades: 6001, totalMarkets: 40, includedMarkets: 32,
};
const narrative = "Datos insuficientes para estimar la probabilidad de ganar. La dirección pública no confirma ventas. Hay que verificar estadísticas deportivas y el precio disponible antes de decidir.";
const row = {
  tradeId: "trade-1", ticker: "GAME-YES", title: "A gana", eventTitle: "A vs B",
  marketTitle: "A gana", sport: "Soccer", outcomeSide: "no", bookSide: "ask",
  price: 0.4, count: 25000, notional: 10000, createdTime: time,
  blockTrade: false, marketUrl: "https://kalshi.com/markets/example", savedAt: time,
};
const extra = { startsAt: null, state: "finished", gameResult: "A 2–1 B", historyPhase: "complete", historyMinimum: 1000 };

test("AI context never presents an inferred or stale catalog status as a live sports confirmation", () => {
  assert.equal(analysisGameState("finished"), "finished");
  for (const state of ["live", "upcoming", "unknown", null, undefined]) {
    assert.equal(analysisGameState(state), "unknown");
  }
  assert.match(ANALYSIS_PROMPT, /dataThrough es el corte de lectura/);
  assert.match(ANALYSIS_PROMPT, /no afirmes que sigue en vivo/);
});

test("export preserves executions, actual score, side, money, fractional contracts and UTC", () => {
  const result = exportTrade({ ...row, count: 25000.5 }, extra);
  assert.equal(result.trade_id, row.tradeId);
  assert.equal(result.contracts, 25000.5);
  assert.equal(result.public_direction, "no");
  assert.equal(result.final_score, "A 2–1 B");
  assert.equal(result.executed_at_utc, time.toISOString());
  assert.equal(result.saved_at_utc, time.toISOString());
  assert.deepEqual(Object.keys(result), [...EXPORT_COLUMNS]);
});
test("CSV quotes delimiters, newlines and quotes and blocks formula execution", () => {
  assert.equal(csvCell('A, "B"\nC'), '"A, ""B""\nC"');
  for (const formula of ["=SUM(A1)", "+command", "-command", "@x", "\t=CMD()", "  =CMD()"])
    assert.ok(csvCell(formula).startsWith("\"'"));
  assert.equal(csvCell(-100), '"-100"');
  const record = exportTrade({ ...row, title: "=CMD()" }, extra);
  assert.equal(record.title, "=CMD()");
  assert.match(csvTrade(record), /"'=CMD\(\)"/);
});
test("history export chunks preserve valid JSON separators and complete CSV rows", () => {
  const first = exportTrade({ ...row, tradeId: "first" }, extra);
  const second = exportTrade({ ...row, tradeId: "second" }, extra);
  const json = `{"trades":[${serializeHistoryChunk([first], "json", false)}${serializeHistoryChunk([second], "json", true)}]}`;
  assert.deepEqual(JSON.parse(json).trades.map((trade: { trade_id: string }) => trade.trade_id), ["first", "second"]);

  const csv = serializeHistoryChunk([first], "csv", false) + serializeHistoryChunk([second], "csv", true);
  assert.equal(csv.split("\r\n").filter(Boolean).length, 2);
  assert.match(csv, /first/);
  assert.match(csv, /second/);
});
test("AI export parts cover every saved operation with no oversized row-count segment", () => {
  for (const total of [0, 1, HISTORY_EXPORT_ROWS_PER_PART, HISTORY_EXPORT_ROWS_PER_PART + 1, 1_036_316]) {
    const manifest = buildHistoryExportParts(total, time.toISOString());
    assert.equal(manifest.totalTrades, total);
    assert.equal(manifest.parts.reduce((sum, part) => sum + part.trades, 0), total);
    assert.ok(manifest.parts.every((part, index) =>
      part.part === index + 1 && part.trades > 0 && part.trades <= HISTORY_EXPORT_ROWS_PER_PART));
    assert.equal(manifest.parts.length, Math.ceil(total / HISTORY_EXPORT_ROWS_PER_PART));
  }
});
test("export bands have no overlap and retain exact 5k/10k boundaries and legacy smaller trades", () => {
  assert.equal(valueBand(999), "below_1000");
  assert.equal(valueBand(1000), "1000_to_5000");
  assert.equal(valueBand(5000), "1000_to_5000");
  assert.equal(valueBand(5000.01), "over_5000_under_10000");
  assert.equal(valueBand(9999.99), "over_5000_under_10000");
  assert.equal(valueBand(10000), "10000_and_above");
});
test("JSON metadata honestly explains missing coverage and keeps no chart-size cap", () => {
  const metadata = exportMetadata(6001, 40, null, null, time.toISOString());
  assert.equal(metadata.totalTrades, 6001);
  assert.match(metadata.scope, /All executions/);
  assert.ok(metadata.limitations.some(l => l.includes("NOT all transactions")));
  assert.match(metadata.fields.public_direction, /Not proof/);
  const file = JSON.stringify({ metadata, trades: Array.from({ length: 6001 }, (_, i) =>
    exportTrade({ ...row, tradeId: `t-${i}` }, extra)) });
  assert.equal(JSON.parse(file).trades.length, 6001);
});
test("analysis uses the selected game and persists the generated report before returning", async () => {
  let saved: GameAnalysis | null = null;
  let calls = 0;
  const service = new GameAnalysisService({
    load: async () => null, context: async t => { assert.equal(t, "GAME-YES"); return context; },
    complete: async c => { calls++; assert.equal(c.totalTrades, 6001); return narrative; },
    save: async r => { saved = r; }, now: () => time,
  });
  const report = await service.generate("GAME-YES");
  assert.equal(calls, 1);
  assert.equal(saved, report);
  assert.equal(report.includedMarkets, 32);
  assert.equal(report.totalMarkets, 40);
  assert.equal(report.text, narrative);
  assert.equal(report.dataThrough.toISOString(), time.toISOString());
});
test("recent saved analysis blocks paid regeneration during cooldown", async () => {
  let calls = 0;
  const saved = {
    ticker: "GAME-YES", generatedAt: time, model: "test", gameName: "A", betLabel: "B",
    totalTrades: 1, totalMarkets: 1, includedMarkets: 1, latestTradeAt: null, dataThrough: time, text: narrative,
  };
  const service = new GameAnalysisService({
    load: async () => saved, context: async () => context,
    complete: async () => { calls++; return narrative; }, save: async () => {}, now: () => time,
  });
  await assert.rejects(service.generate("GAME-YES"), (e: unknown) => e instanceof AnalysisError && e.status === 429);
  assert.equal(calls, 0);
});
test("concurrent generation is blocked and failures release the lock without replacing old reports", async () => {
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  let saved = 0;
  const service = new GameAnalysisService({
    load: async () => null, context: async () => context,
    complete: async () => { await held; throw new Error("AI failed"); },
    save: async () => { saved++; },
  });
  const first = service.generate("GAME-YES");
  await assert.rejects(service.generate("OTHER"), (e: unknown) => e instanceof AnalysisError && e.status === 429);
  release();
  await assert.rejects(first, /AI failed/);
  await assert.rejects(service.generate("GAME-YES"), /AI failed/);
  assert.equal(saved, 0);
});
test("an empty AI response does not save a fake or partial report", async () => {
  const service = new GameAnalysisService({
    load: async () => null, context: async () => context, complete: async () => "",
    save: async () => { assert.fail("must not save"); },
  });
  await assert.rejects(service.generate("GAME-YES"), (e: unknown) => e instanceof AnalysisError && e.status === 502);
});
test("AI instructions forbid fabricated probabilities, sales, external facts and retrospective predictions", () => {
  for (const term of ["No inventes probabilidades", "ventas confirmadas", "No tienes navegación",
    "retrospectivo", "instrucciones dentro", "comisiones"])
    assert.ok(ANALYSIS_PROMPT.includes(term));
});
