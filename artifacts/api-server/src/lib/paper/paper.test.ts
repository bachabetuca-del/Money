import assert from "node:assert/strict";
import { after, test } from "node:test";
import { performance } from "node:perf_hooks";
import { pool } from "@workspace/db";
import { PaperBook, asks } from "./book";
import { emptyFill, executePaper, resolvePaper } from "./execution";
import { bootstrap, pairedInterval, ratio } from "./statistics";
import { candidateEvidence } from "./evidence";
import { makeProtocol } from "./protocol";
import { comparableControl } from "./controls";
import { computePaperReport, summarizePaper, type ReportCandidate, type ReportExecution } from "./report";
import { auditedRow } from "./audit";
import { AUDITED_SIGNALS } from "./audit-sample";
import { csvCell } from "./export";
import { TelegramTradeNotifications } from "../telegram-trade-notifications";
import { at, input, run, job, roi, quote, evidence } from "./fixtures.test-helper";
import type { Candidate } from "./repository";
after(() => pool.end());
const fee = { feeType: "quadratic", multiplier: 1 };
const executionInput = () => ({ book: quote(), dueAt: at(34).getTime(), side: "yes" as const,
  observedPrice: .5, limitCents: 1, stakeUsd: 100, availableUsd: 10000, fee });

test("book snapshots, complementary asks, deltas and acknowledgement sequences", () => {
  const b = new PaperBook(), now = at(0).getTime(); b.connect("a", now);
  assert.equal(b.apply({ type: "orderbook_snapshot", sid: 2, seq: 1, sending_ts_ms: now,
    msg: { market_ticker: "A", yes_dollars_fp: [["0.4200", "10.25"]], no_dollars_fp: [["0.5500", "20.00"]] } }, now), true);
  assert.equal(asks(b.quote("A", now)!, "yes")[0].price, .45);
  assert.equal(asks(b.quote("A", now)!, "no")[0].price, .58);
  assert.equal(b.apply({ type: "ok", sid: 2, seq: 2, msg: { market_tickers: ["A"] } }, now), true);
  assert.equal(b.apply({ type: "orderbook_delta", sid: 2, seq: 3, msg: {
    market_ticker: "A", side: "yes", price_dollars: "0.4200", delta_fp: "-0.25" } }, now), true);
  assert.equal(b.quote("A", now)!.yesBids[0].contracts, 10);
  assert.equal(b.quote("A", now + 15001), null);
  assert.equal(b.apply({ type: "orderbook_delta", sid: 2, seq: 5, msg: {
    market_ticker: "A", side: "yes", price_dollars: "0.4200", delta_fp: "1.00" } }, now), false);
  assert.equal(b.quote("A", now), null);
  b.connect("b", now); assert.equal(b.quote("A", now), null);
});
test("invalid quantities, crossed books and stale exchange clocks never become executable quotes", () => {
  const b = new PaperBook(), now = at(0).getTime(); b.connect("a", now);
  assert.equal(b.apply({ type: "orderbook_snapshot", sid: 1, seq: 1, msg: { market_ticker: "A",
    yes_dollars_fp: [["0.5000", "-1.00"]], no_dollars_fp: [] } }, now), false);
  b.connect("b", now);
  b.apply({ type: "orderbook_snapshot", sid: 1, seq: 1, msg: { market_ticker: "A",
    yes_dollars_fp: [["0.6000", "10.00"]], no_dollars_fp: [["0.5000", "10.00"]] } }, now);
  assert.equal(b.quote("A", now), null);
  b.connect("c", now);
  assert.equal(b.apply({ type: "orderbook_snapshot", sid: 1, seq: 1, sending_ts_ms: now - 16000,
    msg: { market_ticker: "A", yes_dollars_fp: [], no_dollars_fp: [] } }, now), false);
});
test("fills use price levels, whole contracts, frozen fees and the chosen side", () => {
  const yes = executePaper(executionInput());
  assert.equal(yes.status, "full"); assert.equal(yes.contracts, 200);
  assert.equal(yes.costUsd, 100); assert.equal(yes.feeUsd, 3.5);
  const no = executePaper({ ...executionInput(), side: "no", observedPrice: .51 });
  assert.equal(no.contracts, 196); assert.equal(no.costUsd, 99.96);
  assert.equal(no.averagePrice, .51);
  assert.equal(resolvePaper(yes, "yes", "yes", at(100).toISOString()).netProfitUsd, 96.5);
  assert.equal(resolvePaper(no, "no", "yes", at(100).toISOString()).payoutUsd, 0);
  assert.equal(resolvePaper(yes, "yes", "void", at(100).toISOString()).netProfitUsd, null);
});
test("partial liquidity, zero fills, limit rejection and cash include no invented contracts", () => {
  const partial = executePaper({ ...executionInput(), book: quote(34, "PAPER-GAME-A", 10) });
  assert.equal(partial.status, "partial"); assert.equal(partial.contracts, 10);
  assert.equal(executePaper({ ...executionInput(), observedPrice: .1 }).reason, "price_limit");
  assert.equal(executePaper({ ...executionInput(), availableUsd: 0 }).status, "none");
  const capped = executePaper({ ...executionInput(), availableUsd: 50 });
  assert.equal(capped.status, "partial"); assert.ok(capped.costUsd + capped.feeUsd! <= 50);
  const used = executePaper({ ...executionInput(), consumed: { "5000": 1000 } });
  assert.equal(used.contracts, 0); assert.equal(used.status, "none");
});
test("missing books, unknown fees, late or future captures never fall back to a trade price", () => {
  assert.equal(executePaper({ ...executionInput(), book: null }).status, "unknown");
  assert.equal(executePaper({ ...executionInput(), fee: null }).status, "unknown");
  assert.equal(executePaper({ ...executionInput(), book: quote(36) }).reason, "capture_outside_window");
  assert.equal(executePaper({ ...executionInput(), book: quote(33) }).reason, "capture_outside_window");
});
test("protocol bounds, pre-activation, reference leakage and approximate game identity stay explicit", () => {
  assert.throws(() => makeProtocol(input({ holdoutDays: 28 }), "gross"));
  assert.throws(() => makeProtocol(input({ maxGameUsd: 99 }), "gross"));
  const r = run(), j = job(), ro = roi();
  assert.deepEqual(candidateEvidence(r, j, ro, true, "", at(3), null, {}).exclusions, []);
  j.createdTime = at(-1);
  assert.ok(candidateEvidence(r, j, ro, true, "", at(3), null, {}).exclusions.includes("before_activation"));
  ro.research!.includesCandidateGame = true; ro.evidence!.gameIdentity = "event";
  const excluded = candidateEvidence(r, j, ro, true, "", at(3), null, {}).exclusions;
  assert.ok(excluded.includes("candidate_game_in_reference")); assert.ok(excluded.includes("approximate_game_identity"));
  ro.evidence!.historyAsOf = at(20).toISOString();
  assert.ok(candidateEvidence(r, j, ro, true, "", at(3), null, {}).exclusions.includes("history_cutoff_unverified"));
});
test("controls match without outcomes, reject same-game, live/unknown phase and excessive latency", () => {
  const r = run();
  const make = (id: string, game: string, eligible: number): Candidate => ({
    id, runId: r.id, tradeId: id, ticker: "PAPER-GAME-A", gameId: game, decidedAt: at(3),
    confirmedAt: eligible ? at(4) : null, eligible, phase: "calibration", matchedId: null,
    evidence: evidence(r, id, game, !!eligible),
  });
  const a = make("a", "a", 1), c = make("b", "b", 0);
  assert.equal(comparableControl(a, c, quote(3), quote(3), 100), true);
  c.gameId = a.gameId; assert.equal(comparableControl(a, c, quote(), quote(), 100), false);
  c.gameId = "b"; c.evidence.phase = "live";
  assert.equal(comparableControl(a, c, quote(), quote(), 100), false);
  c.evidence.phase = "scheduled"; a.confirmedAt = at(100);
  assert.equal(comparableControl(a, c, quote(), quote(), 100), false);
});
test("connected control chains remain one block without recursive overflow", () => {
  const chain = Array.from({ length: 10000 }, (_, i) => ({
    game: `g${i}`, controlGame: `g${i + 1}`, date: "2026-11-17",
    cost: 100, profit: 10, controlCost: 100, controlProfit: 2,
  }));
  assert.equal(pairedInterval(chain), undefined);
});

test("ratios are sums of actual outlay, not averages of returns; games are blocks", () => {
  assert.equal(ratio([{ cost: 10, profit: 10 }, { cost: 100, profit: -10 }]), 0);
  assert.equal(ratio([]), null);
  const repeated = Array.from({ length: 300 }, (_, i) => ({ game: "same", date: "2026-11-17", cost: 100, profit: i % 2 ? 10 : -10 }));
  assert.equal(bootstrap(repeated), undefined);
  const games = Array.from({ length: 30 }, (_, i) => ({ game: String(i), date: `2026-11-${String(i + 1).padStart(2, "0")}`, cost: 100, profit: i - 10 }));
  assert.equal(bootstrap(games)!.clusters, 30);
  assert.deepEqual(bootstrap(games), bootstrap(games));
  assert.equal(pairedInterval(games.map(r => ({ ...r, controlGame: "same-control", controlCost: 100, controlProfit: 0 }))), undefined);
});
test("known/unknown/pending accounting, concentration and hidden final period", async () => {
  const r = run();
  const cs: ReportCandidate[] = Array.from({ length: 5 }, (_, i) => ({
    id: String(i), game: `game-${i}`, gameIdentity: "milestone", phase: i === 4 ? "holdout" : "calibration",
    eligible: 1, decidedAt: at(3), confirmedAt: at(4), matchedId: null, price: .5, feeType: "quadratic", feeMultiplier: 1,
  }));
  const xs: ReportExecution[] = [
    { candidateId: "0", delaySeconds: 30, policy: "first", status: "full", cost: 100, fee: 3.5, net: 96.5, payout: 200, result: "yes" },
    { candidateId: "1", delaySeconds: 30, policy: "first", status: "unknown", cost: 0, fee: null, net: null, payout: null, result: null },
    { candidateId: "2", delaySeconds: 30, policy: "first", status: "full", cost: 100, fee: 3.5, net: null, payout: null, result: null },
    { candidateId: "3", delaySeconds: 30, policy: "first", status: "none", cost: 0, fee: 0, net: null, payout: null, result: null },
    { candidateId: "4", delaySeconds: 30, policy: "first", status: "full", cost: 100, fee: 3.5, net: -103.5, payout: 0, result: "no" },
  ];
  const s = summarizePaper(r, cs, xs, "first", 30, "calibration", "alerts");
  assert.equal(s.unknown, 1); assert.equal(s.settled, 1); assert.equal(s.netProfitUsd, 96.5);
  assert.equal(s.committedUsd, 103.5); assert.equal(s.profitPerAlertUsd, null);
  assert.equal(s.unresolvedExecutions, 1); assert.equal(s.games, 1);
  const open = await computePaperReport(r, cs, xs, at(10));
  assert.ok(open.stats.every(s => s.phase !== "holdout"));
  const closed = await computePaperReport(r, cs, xs, at(86400 * 30));
  assert.ok(closed.stats.some(s => s.phase === "holdout"));
});
test("real audited alert reconciles exact timing and official loss without calling historical ROI profit", () => {
  const audit = auditedRow(AUDITED_SIGNALS[0]);
  assert.equal(audit.totalSeconds, 1747.395);
  assert.equal(audit.decisionToConfirmSeconds, .735);
  assert.equal(audit.hypotheticalGrossProfitUsd, -100);
  assert.equal(audit.entryFeeUsd, 5.95);
  assert.equal(audit.frozenRoiPct, 61.42075827822088);
});
test("CSV protects user text without changing numeric losses", () => {
  assert.equal(csvCell("=IMPORTXML(x)"), `"'=IMPORTXML(x)"`);
  assert.equal(csvCell(-100), '"-100"');
});
test("observer failure cannot alter eligibility, delay delivery with a promise or change the latest notice policy", async () => {
  let sent = 0, requested = 0;
  const j = job();
  const bot = new TelegramTradeNotifications({
    next: async () => j, capture: async () => null, sent: async () => { sent++; },
    skipped: async () => undefined, failed: async () => { throw Error("must not retry"); },
    latestMessageId: async () => undefined, cleanup: async () => [], removed: async () => undefined,
  }, {
    context: async () => ({ eventTitle: "Equipo A vs Equipo B", marketTitle: "Equipo A gana" }),
    roi: async () => roi(), request: async <T>() => { requested++; return { result: { message_id: 1 } as T }; },
    observe: () => { throw Error("Research store offline"); },
  }, () => at(4));
  const started = performance.now(); await bot.tick({ enabled: true, chatId: "fixture" });
  assert.equal(sent, 1); assert.equal(requested, 1); assert.ok(performance.now() - started < 1000);
});
