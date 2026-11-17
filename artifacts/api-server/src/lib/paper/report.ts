import { and, asc, eq, sql } from "drizzle-orm";
import { setImmediate } from "node:timers/promises";
import { db, kalshiPaperRunsTable as runs, kalshiPaperCandidatesTable as candidates,
  kalshiPaperExecutionsTable as executions, kalshiPaperReportsTable as reports } from "@workspace/db";
import type { PaperComparison, PaperDashboard, PaperRun, PaperStats } from "@workspace/api-zod";
import { bootstrap, pairedInterval, ratio, type Observation, type PairedObservation } from "./statistics";
import { toRun } from "./repository";
import { delays, hideHoldout } from "./protocol";
import { estimateHypotheticalEntryFee } from "../kalshi-fees";

export type ReportCandidate = {
  id: string; game: string; gameIdentity: string; phase: string; eligible: number;
  decidedAt: Date; confirmedAt: Date | null; matchedId: string | null;
  price: number; feeType: string | null; feeMultiplier: number | null;
};
export type ReportExecution = {
  candidateId: string; delaySeconds: number; policy: string; status: string;
  cost: number | null; fee: number | null; net: number | null; payout: number | null; result: string | null;
};
const usd = (v: number) => Math.round(v * 1e6) / 1e6;
const netRow = (c: ReportCandidate, x: ReportExecution): Observation =>
  ({ game: c.game, date: c.decidedAt.toISOString().slice(0, 10), cost: (x.cost ?? 0) + (x.fee ?? 0), profit: x.net! });
const supported = (x: ReportExecution) => x.net !== null && ["yes", "no"].includes(x.result ?? "") && x.fee !== null;

export function summarizePaper(run: PaperRun, cs: ReportCandidate[], xs: ReportExecution[], policy: "first" | "all",
  delaySeconds: number, phase: "calibration" | "holdout", cohort: "alerts" | "controls"): PaperStats {
  const filtered = cs.filter(c => c.phase === phase && (cohort === "alerts" ? !!c.eligible && !!c.confirmedAt : !c.eligible));
  const ids = new Set(filtered.map(c => c.id)), map = new Map(filtered.map(c => [c.id, c]));
  const fills = xs.filter(x => ids.has(x.candidateId) && x.policy === policy && x.delaySeconds === delaySeconds);
  const num = (status: string) => fills.filter(x => x.status === status).length;
  const executed = fills.filter(x => ["full", "partial"].includes(x.status));
  const settled = executed.filter(supported), data = settled.map(x => netRow(map.get(x.candidateId)!, x));
  const cost = data.reduce((s, r) => s + r.cost, 0), pnl = data.reduce((s, r) => s + r.profit, 0);
  const allSpend = executed.reduce((s, x) => s + (x.cost ?? 0) + (x.fee ?? 0), 0);
  const allPayout = settled.reduce((s, x) => s + (x.payout ?? 0), 0);
  const games = new Map<string, number>();
  for (const r of data) games.set(r.game, (games.get(r.game) ?? 0) + r.profit);
  const best = [...games].sort((a, b) => b[1] - a[1])[0];
  const pending = num("pending") + Math.max(0, filtered.length - fills.length);
  const unknowns = fills.filter(x => x.status === "unknown").map(x => map.get(x.candidateId)!);
  let sensitivityCost = 0, sensitivityGain = 0, sensitivityKnown = true;
  for (const c of unknowns) {
    const limit = Math.min(.9999, c.price + run.protocol.limitCents / 100);
    const contracts = Math.floor(run.protocol.stakeUsd / limit), notional = contracts * limit;
    const fee = estimateHypotheticalEntryFee(limit, c.feeType && c.feeMultiplier !== null ?
      { feeType: c.feeType, multiplier: c.feeMultiplier } : null, notional);
    if (fee === null) { sensitivityKnown = false; break; }
    sensitivityCost += notional + fee; sensitivityGain += contracts - notional - fee;
  }
  const complete = num("unknown") === 0 && pending === 0 && executed.length === settled.length;
  return {
    policy, delaySeconds, cohort, phase, opportunities: filtered.length, full: num("full"), partial: num("partial"),
    none: num("none"), unknown: num("unknown"), pending, settled: settled.length,
    games: games.size, approximateGames: new Set(filtered.filter(c => c.gameIdentity !== "milestone").map(c => c.game)).size,
    deployedUsd: usd(executed.reduce((s, x) => s + (x.cost ?? 0), 0)),
    feesUsd: usd(executed.reduce((s, x) => s + (x.fee ?? 0), 0)),
    committedUsd: usd(allSpend - cost), freeCapitalUsd: usd(run.protocol.capitalUsd - allSpend + allPayout),
    netProfitUsd: settled.length ? usd(pnl) : null, netRoiPct: ratio(data),
    profitPerAlertUsd: complete && filtered.length ? usd(pnl / filtered.length) : null,
    coveragePct: filtered.length ? 100 * (num("full") + num("partial") + num("none")) / filtered.length : 0,
    withoutBestGameRoiPct: best ? ratio(data.filter(r => r.game !== best[0])) : null,
    bestGameProfitUsd: best?.[1] ?? null, bestGameSharePct: best && pnl > 0 ? 100 * best[1] / pnl : null,
    unresolvedExecutions: executed.length - settled.length,
    settledCoveragePct: executed.length ? 100 * settled.length / executed.length : 0,
    unknownLossScenarioRoiPct: unknowns.length && sensitivityKnown && cost + sensitivityCost > 0 ?
      100 * (pnl - sensitivityCost) / (cost + sensitivityCost) : null,
    unknownWinScenarioRoiPct: unknowns.length && sensitivityKnown && cost + sensitivityCost > 0 ?
      100 * (pnl + sensitivityGain) / (cost + sensitivityCost) : null,
    interval: bootstrap(data), dateInterval: bootstrap(data, "date"),
  };
}
function compare(run: PaperRun, cs: ReportCandidate[], xs: ReportExecution[], phase: string, now: Date): PaperComparison {
  const pool = cs.filter(c => c.phase === phase), cMap = new Map(pool.map(c => [c.id, c]));
  const executions = new Map(xs.filter(x => x.delaySeconds === run.protocol.delaySeconds && x.policy === run.protocol.repetitions)
    .map(x => [x.candidateId, x]));
  const emitted = pool.filter(c => c.eligible && c.confirmedAt), paired: PairedObservation[] = [];
  let matched = 0;
  for (const c of emitted) {
    const control = c.matchedId ? cMap.get(c.matchedId) : null;
    if (!control) continue;
    matched++;
    const a = executions.get(c.id), b = executions.get(control.id);
    if (!a || !b || !supported(a) || !supported(b)) continue;
    paired.push({ ...netRow(c, a), controlGame: control.game, controlCost: (b.cost ?? 0) + (b.fee ?? 0),
      controlProfit: b.net! });
  }
  const aRoi = ratio(paired), bRoi = ratio(paired.map(p => ({ cost: p.controlCost, profit: p.controlProfit })));
  const interval = pairedInterval(paired);
  return { phase, pairs: paired.length, coveragePct: emitted.length ? 100 * paired.length / emitted.length : 0,
    deltaNetRoiPct: aRoi !== null && bRoi !== null ? aRoi - bRoi : null, interval,
    conclusion: emitted.length === 0 ? "Sin alertas confirmadas: no hay evidencia todavía." :
      !paired.length ? "Inconcluso: faltan pares comparables ejecutados y liquidados." :
      hideHoldout(run, now) ? "Provisional: la prueba sigue abierta. No ajustar ni detener por un resultado favorable." :
      !interval || paired.length < 50 || paired.length < emitted.length * .9 || run.dropped > 0 ?
        "Inconcluso: pocos pares, cobertura incompleta o registros perdidos. No se ha demostrado una ventaja." :
      interval.lower <= 0 ? "No hay evidencia clara de ventaja frente a estos controles; el intervalo incluye diferencias no positivas." :
        "Diferencial positivo en los pares observados. No prueba causalidad ni garantiza rentabilidad futura.",
    residuals: [
      `${matched} pares fijados antes del resultado; ${paired.length} con ambas entradas ejecutadas y liquidadas.`,
      `${emitted.length - matched} alertas sin control comparable. Los pares sin ambas ejecuciones quedan fuera del diferencial, no se convierten en pérdidas.`,
      "No aleatorio; solo prepartido. Faltan marcador/reloj en vivo. Precio ±1¢, tamaño y profundidad hasta factor 2, inicio ±15 min.",
      "Controles con confirmación sintética de 1 s; solo avisos con demora decisión-confirmación de 0–2 s.",
      "IC del diferencial: bloques conectados por partido; no se divide un mismo partido entre observaciones independientes.",
    ] };
}
export async function computePaperReport(run: PaperRun, cs: ReportCandidate[], xs: ReportExecution[], now: Date) {
  const stats: PaperStats[] = [];
  for (const phase of ["calibration", "holdout"] as const) {
    if (phase === "holdout" && hideHoldout(run, now)) continue;
    for (const cohort of ["alerts", "controls"] as const) for (const delay of delays(run))
      for (const policy of ["first", "all"] as const) {
        if (!cs.some(c => c.phase === phase && (cohort === "alerts" ? c.eligible && c.confirmedAt : !c.eligible))) continue;
        stats.push(summarizePaper(run, cs, xs, policy, delay, phase, cohort));
        await setImmediate(); // allow delivery/capture timers between scenarios
      }
  }
  return { stats, comparisons: (["calibration", "holdout"] as const)
    .filter(p => p !== "holdout" || !hideHoldout(run, now)).map(p => compare(run, cs, xs, p, now)) };
}
export async function refreshPaperReports(now = new Date()) {
  const list = await db.select({ run: runs }).from(runs).leftJoin(reports, eq(reports.runId, runs.id))
    .where(and(sql`${runs.status} <> 'draft'`,
      sql`(${reports.generatedAt} IS NULL OR ${reports.generatedAt} < ${new Date(now.getTime() - 60000)})`))
    .orderBy(sql`CASE WHEN ${runs.status} = 'active' THEN 0 ELSE 1 END`,
      sql`${reports.generatedAt} ASC NULLS FIRST`, asc(runs.createdAt)).limit(2);
  for (const { run: raw } of list) {
    const run = toRun(raw);
    const [cs, xs] = await Promise.all([
      db.select({ id: candidates.id, game: candidates.gameId, phase: candidates.phase,
        eligible: candidates.eligible, decidedAt: candidates.decidedAt, confirmedAt: candidates.confirmedAt, matchedId: candidates.matchedId,
        gameIdentity: sql<string>`${candidates.evidence}->>'gameIdentity'`,
        price: sql<number>`(${candidates.evidence}->>'price')::double precision`,
        feeType: sql<string | null>`${candidates.evidence}->'roi'->'evidence'->>'feeType'`,
        feeMultiplier: sql<number | null>`(${candidates.evidence}->'roi'->'evidence'->>'feeMultiplier')::double precision`,
      }).from(candidates).where(eq(candidates.runId, run.id)).limit(10000),
      db.select({ candidateId: executions.candidateId, delaySeconds: executions.delaySeconds,
        policy: executions.policy, status: executions.status,
        cost: sql<number | null>`(${executions.evidence}->'fill'->>'costUsd')::double precision`,
        fee: sql<number | null>`(${executions.evidence}->'fill'->>'feeUsd')::double precision`,
        net: sql<number | null>`(${executions.resolution}->>'netProfitUsd')::double precision`,
        payout: sql<number | null>`(${executions.resolution}->>'payoutUsd')::double precision`,
        result: sql<string | null>`${executions.resolution}->>'result'`,
      }).from(executions).where(eq(executions.runId, run.id)).limit(60000),
    ]);
    const payload: Pick<PaperDashboard, "stats" | "comparisons"> = await computePaperReport(run, cs, xs, now);
    await db.insert(reports).values({ runId: run.id, generatedAt: now, payload }).onConflictDoUpdate({
      target: reports.runId, set: { generatedAt: now, payload } });
  }
}
