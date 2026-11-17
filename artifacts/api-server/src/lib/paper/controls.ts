import { and, asc, eq, gte, isNull, lte, sql } from "drizzle-orm";
import { db, kalshiPaperCandidatesTable as candidates, kalshiPaperExecutionsTable as executions,
  kalshiSettlementsTable as settlements } from "@workspace/db";
import type { PaperRun } from "@workspace/api-zod";
import type { Candidate, Execution } from "./repository";
import { asks, type BookQuote, type Side } from "./book";

export function comparableControl(alert: Candidate, control: Candidate, aq: BookQuote | null,
  cq: BookQuote | null, stake: number): boolean {
  const a = alert.evidence, c = control.evidence;
  if (!alert.eligible || control.eligible || !alert.confirmedAt || a.exclusions.length || c.exclusions.length ||
      alert.gameId === control.gameId || alert.phase !== control.phase || !aq || !cq ||
      Math.abs(alert.decidedAt.getTime() - control.decidedAt.getTime()) > 300000 ||
      a.sport !== c.sport || a.marketType !== c.marketType || a.side !== c.side || a.moneyBand !== c.moneyBand ||
      a.gameIdentity !== "milestone" || c.gameIdentity !== "milestone" ||
      a.phase !== "scheduled" || c.phase !== "scheduled" ||
      Math.abs(a.price - c.price) > .010000001 || a.notional / c.notional > 2 || c.notional / a.notional > 2 ||
      !a.startsAt || !c.startsAt || Math.abs(Date.parse(a.startsAt) - Date.parse(c.startsAt)) > 900000 ||
      !a.phaseAsOf || !c.phaseAsOf ||
      alert.decidedAt.getTime() - Date.parse(a.phaseAsOf) > 300000 ||
      control.decidedAt.getTime() - Date.parse(c.phaseAsOf) > 300000) return false;
  const lag = alert.confirmedAt.getTime() - alert.decidedAt.getTime();
  if (lag < 0 || lag > 2000) return false;
  const depth = (q: BookQuote, side: Side) => asks(q, side).reduce((s, l) => s + l.price * l.contracts, 0);
  const da = depth(aq, a.side as Side), dc = depth(cq, c.side as Side);
  const bucket = (d: number) => d < stake ? 0 : d < 2 * stake ? 1 : 2;
  const spread = (q: BookQuote) => q.yesBids[0] && q.noBids[0] ?
    1 - q.yesBids[0].price - q.noBids[0].price : null;
  const sa = spread(aq), sc = spread(cq);
  return da > 0 && dc > 0 && da / dc <= 2 && dc / da <= 2 && bucket(da) === bucket(dc) &&
    sa !== null && sc !== null && Math.abs(sa - sc) <= .020000001;
}

/** Match on pre-result evidence only, never on a control's eventual return. */
export async function matchPaperControls(run: PaperRun, now = new Date()) {
  const unmatched = await db.select().from(candidates).where(and(eq(candidates.runId, run.id),
    eq(candidates.eligible, 1), isNull(candidates.matchedId),
    sql`${candidates.evidence}->>'phase' = 'scheduled' AND ${candidates.evidence}->'exclusions' = '[]'::jsonb`,
    gte(candidates.decidedAt, new Date(now.getTime() - 300000))))
    .orderBy(asc(candidates.decidedAt), asc(candidates.id)).limit(100);
  for (const rawAlert of unmatched) {
    const alert = rawAlert as Candidate;
    if (!alert.confirmedAt || alert.evidence.exclusions.length) continue;
    const controls = await db.select().from(candidates).where(and(eq(candidates.runId, run.id),
      eq(candidates.eligible, 0), isNull(candidates.matchedId), eq(candidates.phase, alert.phase),
      gte(candidates.decidedAt, new Date(alert.decidedAt.getTime() - 300000)),
      lte(candidates.decidedAt, new Date(alert.decidedAt.getTime() + 300000))))
      .orderBy(asc(candidates.decidedAt), asc(candidates.id)).limit(200);
    const ids = [alert.id, ...controls.map(c => c.id)];
    const captured = await db.select({ candidateId: executions.candidateId, evidence: executions.evidence })
      .from(executions).where(and(sql`${executions.candidateId} IN (${sql.join(ids.map(id => sql`${id}::uuid`), sql`,`)})`,
        eq(executions.delaySeconds, 0), eq(executions.policy, "first"))).limit(201);
    const quote = (c: Candidate): BookQuote | null => {
      const e = captured.find(x => x.candidateId === c.id)?.evidence as Execution["evidence"] | undefined;
      return c.evidence.decisionBook ?? (e?.deliveryBook as BookQuote | null) ?? e?.fill?.book ?? null;
    };
    const chosen = controls.find(c => comparableControl(alert, c as Candidate, quote(alert), quote(c as Candidate), run.protocol.stakeUsd));
    if (!chosen) continue;
    await db.transaction(async tx => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(748392110)`);
      const known = await tx.select({ ticker: settlements.ticker }).from(settlements)
        .where(and(sql`${settlements.ticker} IN (${alert.ticker}, ${chosen.ticker})`, eq(settlements.terminal, true))).limit(1);
      if (known.length) return;
      const locked = await tx.select().from(candidates)
        .where(sql`${candidates.id} IN (${alert.id}::uuid, ${chosen.id}::uuid)`).for("update");
      if (locked.length !== 2 || locked.some(c => c.matchedId)) return;
      for (const c of locked) {
        const paired = c.id === alert.id ? chosen.id : alert.id;
        const e = c.evidence as Candidate["evidence"];
        await tx.update(candidates).set({ matchedId: paired, evidence: { ...e, matching: {
          pairId: paired, at: now.toISOString(),
          residuals: ["Sin asignación aleatoria; controles solo de la cola observada.",
            "Hora de confirmación sintética de 1 s en controles; tolerancia de diferencia ±1 s.",
            "Precio ±1¢, monto hasta factor 2 y profundidad capturada hasta factor 2; no son idénticos.",
            "Solo partidos por empezar: faltan marcador y reloj contemporáneos para comparar en vivo."],
        } } }).where(eq(candidates.id, c.id));
      }
    });
  }
}
