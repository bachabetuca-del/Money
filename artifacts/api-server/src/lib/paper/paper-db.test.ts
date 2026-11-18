import assert from "node:assert/strict";
import { after, test } from "node:test";
import { and, eq, sql } from "drizzle-orm";
import { db, pool, kalshiPaperRunsTable as runs, kalshiPaperCandidatesTable as candidates,
  kalshiPaperExecutionsTable as executions, kalshiPaperReportsTable as reports,
  kalshiMonitorSettingsTable as settings, kalshiSettlementsTable as settlements } from "@workspace/db";
import { GetPaperDashboardResponse, CreatePaperRunBody } from "@workspace/api-zod";
import { createPaperProtocol, changePaperState, recordCandidate, scheduleCandidate,
  paperDashboard, readRun, type Execution, type Candidate } from "./repository";
import { processPaperExecution, settlePaperBatch } from "./processor";
import { writePaperExport } from "./export";
import { at, input, quote, evidence } from "./fixtures.test-helper";

after(() => pool.end());
test("isolated development PostgreSQL paper lifecycle and evidence", async t => {
  assert.equal(process.env.BOT_WORKERS_ENABLED, "false", "Never test against the running bot environment.");
  assert.notEqual(process.env.NODE_ENV, "production");
  await db.transaction(async tx => {
    for (const table of ["kalshi_paper_runs", "kalshi_paper_candidates", "kalshi_paper_executions",
      "kalshi_paper_reports", "kalshi_monitor_settings", "kalshi_market_settlements"]) {
      await tx.execute(sql.raw(`CREATE TEMP TABLE ${table} (LIKE public.${table} INCLUDING ALL) ON COMMIT DROP`));
    }
    await tx.insert(settings).values({ id: 1, enabled: true, notificationRoiBasis: "gross" });
    const protocol = input({ name: " Prueba aislada " });
    let r = await createPaperProtocol(protocol, tx);
    await t.test("read has no activation; validation/defaults; draft idempotency and production-only start", async () => {
      assert.equal(CreatePaperRunBody.safeParse({ ...protocol, delaySeconds: -1 }).success, false);
      assert.equal(r.status, "draft"); assert.equal(r.activatedAt, null);
      assert.equal((await createPaperProtocol(protocol, tx)).id, r.id);
      await assert.rejects(() => createPaperProtocol({ ...protocol, stakeUsd: 200 }, tx), /otro protocolo/);
      const view = await paperDashboard(r.id, 1, false, at(0), tx);
      GetPaperDashboardResponse.parse(view);
      assert.equal(view.activationAllowed, false); assert.equal(view.recorded, 0);
      assert.equal((await readRun(r.id, tx)).activatedAt, null);
      await assert.rejects(() => changePaperState(r.id, "start", false, at(0), tx), /Solo el bot publicado/);
      r = await changePaperState(r.id, "start", true, at(0), tx);
      assert.equal(r.status, "active"); assert.equal(r.activatedAt, at(0).toISOString());
      assert.equal((await changePaperState(r.id, "start", true, at(30), tx)).activatedAt, at(0).toISOString());
      const second = await createPaperProtocol(input(), tx);
      await assert.rejects(() => changePaperState(second.id, "start", true, at(1), tx), /Detén la prueba activa/);
    });
    let c!: Candidate, again!: Candidate;
    const x = async (id: string, policy: string, delay = 30) => {
      const [row] = await tx.select().from(executions).where(and(eq(executions.candidateId, id),
        eq(executions.policy, policy), eq(executions.delaySeconds, delay)));
      return row as Execution;
    };
    await t.test("decisions and schedules are first-write wins; later prices/history do not mutate them", async () => {
      const original = evidence(r);
      c = (await recordCandidate(r, original, tx))!;
      assert.ok(c);
      const same = await recordCandidate(r, { ...original, price: .9, notional: 9000 }, tx);
      assert.equal(same!.evidence.price, .5);
      await scheduleCandidate(r, c.id, at(4), { confirmed: at(4).toISOString() }, quote(4), tx);
      await scheduleCandidate(r, c.id, at(20), { changed: true }, quote(20), tx);
      assert.equal((await x(c.id, "first")).dueAt.toISOString(), at(34).toISOString());
      const [{ value }] = await tx.select({ value: sql<number>`count(*)::int` }).from(executions);
      assert.equal(value, 6);
    });
    await t.test("atomic fills preserve costs, handle duplicates and never reuse consumed liquidity", async () => {
      const one = await x(c.id, "first"), all = await x(c.id, "all");
      await processPaperExecution(one.id, quote(34, c.ticker, 210), at(34), tx);
      await processPaperExecution(all.id, quote(34, c.ticker, 210), at(34), tx);
      const before = await x(c.id, "first");
      assert.equal(before.status, "full"); assert.equal(before.evidence.fill!.contracts, 200);
      await processPaperExecution(one.id, quote(35, c.ticker, 10000), at(35), tx);
      assert.deepEqual((await x(c.id, "first")).evidence, before.evidence);
      again = (await recordCandidate(r, { ...evidence(r, "repeat"), decidedAt: at(7).toISOString() }, tx))!;
      await scheduleCandidate(r, again.id, at(8), {}, quote(8), tx);
      await processPaperExecution((await x(again.id, "first")).id, quote(38, c.ticker, 210), at(38), tx);
      await processPaperExecution((await x(again.id, "all")).id, quote(38, c.ticker, 210), at(38), tx);
      assert.equal((await x(again.id, "first")).evidence.fill!.reason, "repeated_game");
      const repeated = (await x(again.id, "all")).evidence.fill!;
      assert.equal(repeated.contracts, 10); assert.equal(repeated.status, "partial");
      assert.ok(repeated.costUsd + repeated.feeUsd! + 103.5 <= r.protocol.maxGameUsd);
    });
    await t.test("a restart/missed capture is unknown, not a fill at the public price", async () => {
      await processPaperExecution((await x(c.id, "first", 60)).id, null, at(1000), tx);
      const missing = await x(c.id, "first", 60);
      assert.equal(missing.status, "unknown");
      assert.equal(missing.evidence.fill!.costUsd, 0);
      assert.equal(missing.evidence.fill!.bestAsk, null);
    });
    await t.test("official binary payouts, unsupported settlements and audited corrections retain original fees", async () => {
      await tx.insert(settlements).values({ ticker: c.ticker, terminal: true, result: "no", checkedAt: at(100) });
      assert.ok(await settlePaperBatch(r.id, tx) > 0);
      const lost = await x(c.id, "first");
      assert.equal(lost.resolution!.netProfitUsd, -103.5);
      await tx.update(settlements).set({ result: "void", checkedAt: at(110) }).where(eq(settlements.ticker, c.ticker));
      await settlePaperBatch(r.id, tx);
      assert.equal((await x(c.id, "first")).resolution!.netProfitUsd, null);
      await tx.update(settlements).set({ result: "yes", checkedAt: at(120) }).where(eq(settlements.ticker, c.ticker));
      await settlePaperBatch(r.id, tx);
      const corrected = await x(c.id, "first");
      assert.equal(corrected.resolution!.netProfitUsd, 96.5);
      assert.equal(corrected.resolution!.history.length, 2);
      assert.equal(corrected.evidence.fill!.feeUsd, 3.5);
      assert.equal(await settlePaperBatch(r.id, tx), 0);
      await tx.update(settlements).set({ terminal: false, result: null, checkedAt: at(130) }).where(eq(settlements.ticker, c.ticker));
      await settlePaperBatch(r.id, tx);
      const withdrawn = await x(c.id, "first");
      assert.equal(withdrawn.resolution!.result, "not_terminal");
      assert.equal(withdrawn.resolution!.netProfitUsd, null);
      assert.equal(withdrawn.resolution!.history.length, 3);
      assert.equal(await settlePaperBatch(r.id, tx), 0);
      await tx.update(settlements).set({ terminal: true, result: "yes", checkedAt: at(140) }).where(eq(settlements.ticker, c.ticker));
      await settlePaperBatch(r.id, tx);
      assert.equal((await x(c.id, "first")).resolution!.netProfitUsd, 96.5);
    });
    await t.test("one game's markets cannot cross holdout; outcomes and balance evidence stay hidden", async () => {
      const later = at(22 * 86400);
      const same = await recordCandidate(r, { ...evidence(r, "late-same", c.gameId), decidedAt: later.toISOString() }, tx);
      assert.equal(same!.phase, "calibration");
      const final = await recordCandidate(r, { ...evidence(r, "new-final", "new-game"), decidedAt: later.toISOString() }, tx);
      assert.equal(final!.phase, "holdout");
      await scheduleCandidate(r, final!.id, later, {}, null, tx);
      const finalX = await x(final!.id, "first");
      await tx.update(executions).set({ status: "full", evidence: {
        fill: { ...(await x(c.id, "first")).evidence.fill!, reason: "filled" }, cashBeforeUsd: 12345,
      }, resolution: { result: "yes", checkedAt: at(23 * 86400).toISOString(), netProfitUsd: 96.5, payoutUsd: 200, history: [] } })
        .where(eq(executions.id, finalX.id));
      const view = GetPaperDashboardResponse.parse(await paperDashboard(r.id, 1, false, at(24 * 86400), tx));
      assert.equal(view.holdoutHidden, true);
      const shown = view.rows.find(row => row.tradeId === "new-final")!.executions.find(x => x.policy === "first" && x.delaySeconds === 30)!;
      assert.equal(shown.netProfitUsd, null);
      assert.equal(shown.evidence.resolution, undefined);
      assert.equal(shown.evidence.cashBeforeUsd, undefined);
    });
    await t.test("JSON/CSV export protocol and complete scoped evidence, not private IDs or hidden outcomes", async () => {
      let json = "";
      await writePaperExport(r.id, "json", async chunk => { json += chunk; }, at(24 * 86400), tx);
      const downloaded = JSON.parse(json);
      assert.equal(downloaded.run.id, r.id);
      assert.equal(downloaded.opportunities.length, 4);
      assert.ok(!json.includes('"chatId"'));
      const holdout = downloaded.opportunities.find((c: { tradeId: string }) => c.tradeId === "new-final");
      assert.ok(holdout.executions.every((e: { netProfitUsd: number | null }) => e.netProfitUsd === null));
      let csv = "";
      await writePaperExport(r.id, "csv", async chunk => { csv += chunk; }, at(24 * 86400), tx);
      assert.ok(csv.startsWith("\uFEFF")); assert.ok(csv.includes('"protocol"'));
      assert.ok(csv.includes("evidence_json")); assert.ok(!csv.includes('"chatId"'));
    });
    await t.test("pause is durable, blocks new capture, and doesn't reopen early holdout or reset protocol", async () => {
      const paused = await changePaperState(r.id, "pause", false, at(25 * 86400), tx);
      assert.equal(paused.status, "paused");
      assert.equal((await changePaperState(r.id, "pause", false, at(27 * 86400), tx)).pausedAt, paused.pausedAt);
      assert.equal((await readRun(r.id, tx)).protocol.stakeUsd, 100);
      await assert.rejects(() => changePaperState(r.id, "start", true, at(27 * 86400), tx), /no se reanuda/);
      const notAdded = await recordCandidate(r, { ...evidence(r, "after-pause"), decidedAt: at(26 * 86400).toISOString() }, tx);
      assert.equal(notAdded, null);
      assert.equal((await paperDashboard(r.id, 1, false, at(26 * 86400), tx)).holdoutHidden, true);
      assert.equal((await paperDashboard(r.id, 1, false, at(30 * 86400), tx)).holdoutHidden, false);
    });
  });
});
