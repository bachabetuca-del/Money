import { and, asc, eq, isNull, lte, sql } from "drizzle-orm";
import { db, kalshiPaperRunsTable as runs, kalshiPaperCandidatesTable as candidates,
  kalshiPaperExecutionsTable as executions, kalshiSettlementsTable as settlements } from "@workspace/db";
import { toRun, type Candidate, type Execution, type PaperDb, type SettlementRecord } from "./repository";
import { emptyFill, executePaper, resolvePaper, type PaperFill, type Resolution } from "./execution";
import type { BookQuote, Side } from "./book";
import type { PaperEvidence } from "./evidence";

function atResolution(res: SettlementRecord | null, at: number): Resolution | null {
  if (!res) return null;
  return [...res.history, res].filter(r => Date.parse(r.checkedAt) <= at)
    .sort((a, b) => Date.parse(b.checkedAt) - Date.parse(a.checkedAt))[0] ?? null;
}

/** Transaction protects the portfolio and idempotency against competing ticks.
 * A quote is frozen at its scheduled time BEFORE this DB operation; expensive
 * queries cannot substitute a newer/future price. */
export async function processPaperExecution(id: string, book: BookQuote | null, attemptedAt: Date,
  executor: PaperDb = db): Promise<void> {
  await executor.transaction(async tx => {
    const [initial] = await tx.select({ runId: executions.runId }).from(executions).where(eq(executions.id, id)).limit(1);
    if (!initial) return;
    const [rawRun] = await tx.select().from(runs).where(eq(runs.id, initial.runId)).for("update");
    const [raw] = await tx.select().from(executions).where(eq(executions.id, id)).for("update");
    if (!rawRun || !raw || raw.status !== "pending") return;
    const x = raw as Execution;
    const [rawC] = await tx.select().from(candidates).where(eq(candidates.id, x.candidateId));
    if (!rawC) return;
    const c = rawC as Candidate, e = c.evidence, run = toRun(rawRun);
    const at = book ? Date.parse(book.capturedAt) : attemptedAt.getTime();
    let fill: PaperFill | null = null;
    if (x.dueAt.getTime() >= Date.parse(run.endsAt!) || run.pausedAt && x.dueAt >= new Date(run.pausedAt))
      fill = { ...emptyFill("outside_recording_period", "none"), feeUsd: 0 };
    else if (e.exclusions.length) fill = { ...emptyFill(e.exclusions.join(", "), "none"), feeUsd: 0 };
    else if (!c.eligible && (e.reason !== "roi_or_sample" || !e.roi || e.roi.roiPct >= run.protocol.minimumRoiPct))
      fill = { ...emptyFill("not_a_roi_control", "none"), feeUsd: 0 };
    if (!fill && x.policy === "first") {
      const [earlier] = await tx.select({ id: candidates.id }).from(candidates).where(and(
        eq(candidates.runId, c.runId), eq(candidates.gameId, c.gameId), eq(candidates.eligible, c.eligible),
        c.eligible ? sql`${candidates.confirmedAt} IS NOT NULL` : sql`true`,
        sql`(${c.eligible ? candidates.confirmedAt : candidates.decidedAt}, ${candidates.id}) <
            (${c.eligible ? c.confirmedAt : c.decidedAt}, ${c.id}::uuid)`)).limit(1);
      if (earlier) fill = { ...emptyFill("repeated_game", "none"), feeUsd: 0 };
    }
    const fee = e.roi?.evidence;
    if (!fill && (!fee?.feeModel.validUntil || Date.parse(fee.feeModel.validUntil) <= at))
      fill = emptyFill("fee_snapshot_expired");
    const [settled] = await tx.select().from(settlements).where(eq(settlements.ticker, c.ticker)).limit(1);
    if (!fill && settled?.terminal && settled.checkedAt.getTime() <= at)
      fill = { ...emptyFill("officially_terminal_before_entry", "none"), feeUsd: 0 };
    if (!fill && book && !book.yesBids.length && !book.noBids.length)
      fill = emptyFill("empty_book_market_state_unknown");
    let cash = run.protocol.capitalUsd, exposure = 0;
    if (!fill) {
      const previous = await tx.select({
        game: candidates.gameId, ticker: candidates.ticker,
        side: sql<string>`${candidates.evidence}->>'side'`,
        fill: sql<PaperFill>`(${executions.evidence}->'fill') - 'book'`,
        resolution: executions.resolution,
      }).from(executions).innerJoin(candidates, eq(candidates.id, executions.candidateId))
        .where(and(eq(executions.runId, c.runId), eq(executions.policy, x.policy),
          eq(executions.delaySeconds, x.delaySeconds), eq(candidates.eligible, c.eligible), eq(candidates.phase, c.phase),
          lte(executions.dueAt, x.dueAt), sql`${executions.status} IN ('full','partial')`))
        .orderBy(asc(executions.dueAt), asc(executions.id)).limit(10_000);
      const consumed: Record<string, number> = {};
      for (const p of previous) {
        const spent = p.fill.costUsd + (p.fill.feeUsd ?? 0);
        const resolution = atResolution(p.resolution as SettlementRecord | null, at);
        cash -= spent; cash += resolution?.payoutUsd ?? 0;
        if (p.game === c.gameId && resolution?.payoutUsd == null) exposure += spent;
        if (p.ticker === c.ticker && p.side === e.side) for (const f of p.fill.fills) {
          const price = String(Math.round(f.price * 10000));
          consumed[price] = (consumed[price] ?? 0) + f.contracts;
        }
      }
      fill = executePaper({ book, dueAt: x.dueAt.getTime(), side: e.side as Side, observedPrice: e.price,
        limitCents: run.protocol.limitCents, stakeUsd: run.protocol.stakeUsd,
        availableUsd: Math.max(0, Math.min(cash, run.protocol.maxGameUsd - exposure)), consumed,
        fee: fee?.feeType && fee.feeMultiplier !== null ? { feeType: fee.feeType, multiplier: fee.feeMultiplier } : null });
    }
    await tx.update(executions).set({ status: fill.status, capturedAt: attemptedAt,
      evidence: { ...x.evidence, fill, cashBeforeUsd: cash, exposureBeforeUsd: exposure,
        timing: { ...x.evidence.timing, attemptedAt: attemptedAt.toISOString() } } })
      .where(and(eq(executions.id, id), eq(executions.status, "pending")));
  });
}

/** Small indexed batch; even corrected official settlements are append-audited.
 * A new inspection timestamp for an unchanged result doesn't grow the audit. */
export async function settlePaperBatch(runId: string, executor: PaperDb = db): Promise<number> {
  const rows = await executor.select({ id: executions.id, candidateId: executions.candidateId,
    evidence: executions.evidence, resolution: executions.resolution, result: settlements.result,
    checkedAt: settlements.checkedAt, dueAt: executions.dueAt, error: settlements.error, terminal: settlements.terminal,
    side: sql<string>`${candidates.evidence}->>'side'` })
    .from(executions).innerJoin(candidates, eq(candidates.id, executions.candidateId))
    .innerJoin(settlements, eq(settlements.ticker, candidates.ticker))
    .where(and(eq(executions.runId, runId), sql`${executions.status} IN ('full','partial')`,
      sql`(${settlements.terminal} = TRUE OR ${executions.resolution} IS NOT NULL)`,
      sql`${settlements.checkedAt} > ${executions.dueAt}`,
      sql`(${executions.resolution} IS NULL OR
        (${executions.resolution}->>'result') IS DISTINCT FROM
          (CASE WHEN ${settlements.terminal} = FALSE THEN 'not_terminal'
            WHEN ${settlements.error} IS NULL THEN COALESCE(${settlements.result},'unsupported') ELSE 'verification_error' END))`))
    .orderBy(asc(executions.dueAt)).limit(100);
  for (const row of rows) {
    const fill = (row.evidence as Execution["evidence"]).fill;
    if (!fill) continue;
    const prior = row.resolution as SettlementRecord | null;
    const result = !row.terminal ? "not_terminal" : row.error ? "verification_error" : row.result ?? "unsupported";
    const current = resolvePaper(fill, row.side, result, row.checkedAt.toISOString());
    const history = prior ? [...prior.history, { result: prior.result, checkedAt: prior.checkedAt,
      netProfitUsd: prior.netProfitUsd, payoutUsd: prior.payoutUsd }] : [];
    if (history.length > 200) throw new Error("Demasiadas correcciones de liquidación; se requiere revisar la evidencia.");
    await executor.update(executions).set({ resolution: { ...current, history } }).where(eq(executions.id, row.id));
  }
  return rows.length;
}

export async function pendingExecutions(now: Date, executor: PaperDb = db): Promise<Array<{ execution: Execution; candidate: Candidate }>> {
  const rows = await executor.select({ execution: executions, candidate: candidates }).from(executions)
    .innerJoin(candidates, eq(candidates.id, executions.candidateId))
    .where(and(eq(executions.status, "pending"), lte(executions.dueAt, new Date(now.getTime() + 1000))))
    .orderBy(asc(executions.dueAt), asc(executions.id)).limit(100);
  return rows as Array<{ execution: Execution; candidate: Candidate }>;
}
