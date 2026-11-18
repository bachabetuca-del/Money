import { randomUUID } from "node:crypto";
import { and, asc, count, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { db, kalshiMonitorSettingsTable, kalshiPaperRunsTable as runs,
  kalshiPaperCandidatesTable as candidates, kalshiPaperExecutionsTable as executions,
  kalshiPaperReportsTable as reports } from "@workspace/db";
import type { PaperProtocolInput, PaperRun, PaperDashboard, PaperOpportunity, PaperExecution } from "@workspace/api-zod";
import { makeProtocol, PaperError, PAPER_LIMITATIONS, PAPER_MAX_CANDIDATES, delays, hideHoldout } from "./protocol";
import { notificationRoiBasis } from "../telegram-notification-roi";
import type { PaperEvidence } from "./evidence";
import type { PaperFill, Resolution } from "./execution";

export type PaperDb = Pick<typeof db, "select" | "insert" | "update" | "execute" | "transaction">;
export type Candidate = Omit<typeof candidates.$inferSelect, "evidence"> & { evidence: PaperEvidence };
export type ExecutionEvidence = {
  fill?: PaperFill; deliveryBook?: unknown; timing?: Record<string, unknown>;
  cashBeforeUsd?: number; exposureBeforeUsd?: number; failure?: string;
};
export type SettlementRecord = Resolution & { history: Resolution[] };
export type Execution = Omit<typeof executions.$inferSelect, "evidence" | "resolution"> &
  { evidence: ExecutionEvidence; resolution: SettlementRecord | null };
export function toRun(row: typeof runs.$inferSelect): PaperRun {
  return { ...row, protocol: row.protocol as PaperRun["protocol"], status: row.status as PaperRun["status"],
    createdAt: row.createdAt.toISOString(), activatedAt: row.activatedAt?.toISOString() ?? null,
    endsAt: row.endsAt?.toISOString() ?? null, holdoutAt: row.holdoutAt?.toISOString() ?? null,
    pausedAt: row.pausedAt?.toISOString() ?? null, heartbeatAt: row.heartbeatAt?.toISOString() ?? null };
}
export async function readRun(id: string, executor: PaperDb = db): Promise<PaperRun> {
  const [row] = await executor.select().from(runs).where(eq(runs.id, id)).limit(1);
  if (!row) throw new PaperError("No se encontró la prueba.", 404);
  return toRun(row);
}
export async function createPaperProtocol(input: PaperProtocolInput, executor: PaperDb = db): Promise<PaperRun> {
  return executor.transaction(async tx => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(748392109)`);
    const [existing] = await tx.select().from(runs).where(eq(runs.id, input.requestId));
    if (existing) {
      const saved = existing.protocol as PaperRun["protocol"];
      if (Object.keys(input).some(k => (k === "name" ? input.name.trim() : input[k as keyof PaperProtocolInput]) !== saved[k as keyof PaperProtocolInput]))
        throw new PaperError("Ese intento ya guardó otro protocolo. Crea un borrador nuevo.");
      return toRun(existing);
    }
    const [{ value }] = await tx.select({ value: count() }).from(runs);
    if (value >= 100) throw new PaperError("Se alcanzó el límite de 100 protocolos conservados.");
    const [settings] = await tx.select().from(kalshiMonitorSettingsTable).limit(1);
    const protocol = makeProtocol(input, notificationRoiBasis(settings?.notificationRoiBasis));
    const [row] = await tx.insert(runs).values({ id: input.requestId, protocol }).returning();
    return toRun(row);
  });
}
export async function changePaperState(id: string, action: "start" | "pause",
  allowActivation: boolean, now = new Date(), executor: PaperDb = db): Promise<PaperRun> {
  return executor.transaction(async tx => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(748392109)`);
    const [row] = await tx.select().from(runs).where(eq(runs.id, id)).for("update");
    if (!row) throw new PaperError("No se encontró la prueba.", 404);
    if (action === "start") {
      if (!allowActivation) throw new PaperError("Solo el bot publicado puede iniciar la prueba. Desarrollo permanece desactivado.", 403);
      if (row.status === "active") return toRun(row); // idempotent; never reset the cutoff
      if (row.status !== "draft") throw new PaperError("Una prueba cerrada no se reanuda; crea otra cohorte.");
      const [active] = await tx.select({ id: runs.id }).from(runs).where(eq(runs.status, "active")).limit(1);
      if (active) throw new PaperError("Detén la prueba activa antes de iniciar otra.");
      const [settings] = await tx.select().from(kalshiMonitorSettingsTable).limit(1);
      const protocol = row.protocol as PaperRun["protocol"];
      if (!settings?.enabled) throw new PaperError("El monitor está pausado. No se puede iniciar una prueba sin avisos activos.");
      if (settings.notificationRoiBasis !== protocol.basis) throw new PaperError("Cambió la base del filtro. Crea y revisa un protocolo nuevo.");
      const endsAt = new Date(now.getTime() + protocol.runDays * 86400000);
      const [changed] = await tx.update(runs).set({ status: "active", activatedAt: now, endsAt,
        holdoutAt: new Date(endsAt.getTime() - protocol.holdoutDays * 86400000) })
        .where(eq(runs.id, id)).returning();
      return toRun(changed);
    }
    if (row.status === "paused" || row.status === "finished") return toRun(row);
    if (row.status !== "active") throw new PaperError("Ese borrador todavía no se ha iniciado.");
    const [changed] = await tx.update(runs).set({ status: "paused", pausedAt: now }).where(eq(runs.id, id)).returning();
    return toRun(changed);
  });
}

/** New decision data is insert-only. Delivery timestamps live beside it and
 * can be appended without repricing/reclassifying the original decision. */
export async function recordCandidate(run: PaperRun, evidence: PaperEvidence, executor: PaperDb = db): Promise<Candidate | null> {
  return executor.transaction(async tx => {
    const [actual] = await tx.select().from(runs).where(eq(runs.id, run.id)).for("update");
    if (!actual || !["active", "paused", "finished"].includes(actual.status) || !actual.activatedAt || !actual.endsAt ||
        actual.pausedAt && new Date(evidence.decidedAt) >= actual.pausedAt ||
        new Date(evidence.decidedAt) < actual.activatedAt || new Date(evidence.decidedAt) >= actual.endsAt) return null;
    const [saved] = await tx.select().from(candidates).where(and(eq(candidates.runId, run.id),
      eq(candidates.tradeId, evidence.tradeId))).limit(1);
    if (saved) return saved as Candidate;
    const [{ value }] = await tx.select({ value: count() }).from(candidates).where(eq(candidates.runId, run.id));
    if (value >= PAPER_MAX_CANDIDATES) {
      await tx.update(runs).set({ status: "paused", pausedAt: new Date(),
        workerError: "Se alcanzó el límite declarado de 10.000 candidatos. La evidencia se conserva." }).where(eq(runs.id, run.id));
      return null;
    }
    // A game never crosses calibration/holdout, regardless of number of markets.
    const [prior] = await tx.select({ phase: candidates.phase }).from(candidates)
      .where(and(eq(candidates.runId, run.id), eq(candidates.gameId, evidence.gameId)))
      .orderBy(asc(candidates.decidedAt), asc(candidates.id)).limit(1);
    const phase = prior?.phase ?? (new Date(evidence.decidedAt) >= actual.holdoutAt! ? "holdout" : "calibration");
    const [row] = await tx.insert(candidates).values({ id: randomUUID(), runId: run.id,
      tradeId: evidence.tradeId, ticker: evidence.ticker, gameId: evidence.gameId,
      decidedAt: new Date(evidence.decidedAt), eligible: evidence.accepted ? 1 : 0,
      phase, evidence }).onConflictDoNothing().returning();
    return row as Candidate;
  });
}
export async function scheduleCandidate(run: PaperRun, candidateId: string, confirmedAt: Date | null,
  timing: Record<string, unknown>, deliveryBook: unknown, executor: PaperDb = db) {
  await executor.transaction(async tx => {
    const [c] = await tx.select().from(candidates).where(eq(candidates.id, candidateId)).for("update");
    if (!c) return;
    const e = c.evidence as PaperEvidence;
    const reference = c.eligible ? confirmedAt : new Date(c.decidedAt.getTime() + 1000);
    if (!reference) return;
    // Confirmed time is first-write wins, not reinterpreted after retries/restarts.
    if (confirmedAt && !c.confirmedAt) await tx.update(candidates).set({ confirmedAt }).where(eq(candidates.id, c.id));
    const base = c.confirmedAt ?? reference;
    const rows = delays(run).flatMap(delaySeconds => (["first", "all"] as const).map(policy => ({
      id: randomUUID(), runId: run.id, candidateId: c.id, delaySeconds, policy,
      dueAt: new Date(base.getTime() + delaySeconds * 1000),
      evidence: { timing: { ...timing, reference: c.eligible ? "telegram_confirmation" : "synthetic_confirmation_1s",
        originalExclusions: e.exclusions }, deliveryBook },
    })));
    await tx.insert(executions).values(rows).onConflictDoNothing();
  });
}
export async function readCandidate(runId: string, tradeId: string): Promise<Candidate | null> {
  const [c] = await db.select().from(candidates).where(and(eq(candidates.runId, runId), eq(candidates.tradeId, tradeId))).limit(1);
  return c ? c as Candidate : null;
}
export function toOpportunity(c: Candidate, fills: Execution[], hidden: boolean): PaperOpportunity {
  const e = c.evidence;
  return {
    id: c.id, tradeId: c.tradeId, ticker: c.ticker, eventTitle: e.eventTitle, marketTitle: e.marketTitle,
    sport: e.sport, side: e.side, gameId: c.gameId, gameIdentity: e.gameIdentity,
    observedAt: e.observedAt, queuedAt: e.queuedAt, decidedAt: c.decidedAt.toISOString(),
    confirmedAt: c.confirmedAt?.toISOString() ?? null, phase: c.phase, eligible: c.eligible === 1,
    reason: e.exclusions.length ? e.exclusions.join(", ") : e.reason, price: e.price,
    historicalRoiPct: e.roi?.roiPct ?? null, historicalGames: e.roi?.games ?? 0, matchedId: c.matchedId,
    evidence: { ...e },
    executions: fills.map(x => {
      const fill = x.evidence.fill, mask = hidden && c.phase === "holdout";
      const publicEvidence: Record<string, unknown> = { ...x.evidence };
      if (mask) {
        delete publicEvidence.cashBeforeUsd;
        delete publicEvidence.exposureBeforeUsd;
      }
      return { delaySeconds: x.delaySeconds, policy: x.policy as "first" | "all",
        dueAt: x.dueAt.toISOString(), capturedAt: x.capturedAt?.toISOString() ?? null,
        status: x.status as PaperExecution["status"], reason: fill?.reason ?? "awaiting_capture",
        contracts: fill?.contracts ?? 0, costUsd: fill?.costUsd ?? 0, feeUsd: fill?.feeUsd ?? null,
        averagePrice: fill?.averagePrice ?? null, bestAsk: fill?.bestAsk ?? null,
        settlement: mask ? "Tramo final oculto" : x.resolution?.result ?? "Pendiente",
        netProfitUsd: mask ? null : x.resolution?.netProfitUsd ?? null,
        evidence: { ...publicEvidence, ...(mask ? {} : { resolution: x.resolution }) } };
    }),
  };
}
export async function paperDashboard(runId: string | undefined, page: number, activationAllowed: boolean,
  now = new Date(), executor: PaperDb = db): Promise<PaperDashboard> {
  const list = (await executor.select().from(runs).orderBy(desc(runs.createdAt)).limit(30)).map(toRun);
  const selected = runId ? list.find(r => r.id === runId) ?? await readRun(runId, executor) : list[0];
  if (selected && !list.some(r => r.id === selected.id)) list.unshift(selected);
  const empty: PaperDashboard = { generatedAt: now.toISOString(), activationAllowed, runs: list,
    selectedRunId: selected?.id ?? null, stats: [], comparisons: [], rows: [], page, totalPages: 1,
    recorded: 0, holdoutHidden: !!selected && hideHoldout(selected, now), limitations: PAPER_LIMITATIONS };
  if (!selected) return empty;
  const [[{ value }], [report], rows] = await Promise.all([
    executor.select({ value: count() }).from(candidates).where(eq(candidates.runId, selected.id)),
    executor.select().from(reports).where(eq(reports.runId, selected.id)).limit(1),
    executor.select().from(candidates).where(eq(candidates.runId, selected.id))
      .orderBy(desc(candidates.decidedAt), desc(candidates.id)).limit(25).offset((page - 1) * 25),
  ]);
  const fills = rows.length ? await executor.select().from(executions).where(inArray(executions.candidateId, rows.map(c => c.id)))
    .orderBy(asc(executions.delaySeconds), asc(executions.policy)) : [];
  const payload = report?.payload as Pick<PaperDashboard, "stats" | "comparisons"> | undefined;
  return { ...empty, generatedAt: report?.generatedAt.toISOString() ?? now.toISOString(),
    recorded: value, totalPages: Math.max(1, Math.ceil(value / 25)),
    stats: (payload?.stats ?? []).filter(s => !empty.holdoutHidden || s.phase !== "holdout"),
    comparisons: (payload?.comparisons ?? []).filter(s => !empty.holdoutHidden || s.phase !== "holdout"),
    rows: rows.map(c => toOpportunity(c as Candidate, fills.filter(e => e.candidateId === c.id) as Execution[], empty.holdoutHidden)),
    limitations: [...PAPER_LIMITATIONS,
      ...(value && !report ? ["Agregación pendiente: el trabajador publicado calcula las métricas fuera de las consultas del panel."] : []),
      ...(report && now.getTime() - report.generatedAt.getTime() > 180000 ?
        ["Las métricas tienen más de 3 minutos; se muestra la última instantánea guardada, no una actualización en vivo."] : []),
      "Sensibilidad: se supone que cada desconocida compra el presupuesto al precio límite con la tarifa congelada, y todas ganan o todas pierden. No son límites estadísticos ni resultados imputados."],
  };
}

export async function pendingCandidateIds(runId: string) {
  return db.select({ id: candidates.id, tradeId: candidates.tradeId, decidedAt: candidates.decidedAt,
    confirmedAt: candidates.confirmedAt, eligible: candidates.eligible, evidence: candidates.evidence })
    .from(candidates).where(and(eq(candidates.runId, runId),
      sql`NOT EXISTS (SELECT 1 FROM ${executions} e WHERE e.candidate_id = ${candidates.id})`))
    .orderBy(asc(candidates.decidedAt)).limit(100);
}
