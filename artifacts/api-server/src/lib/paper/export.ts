import { and, asc, eq, gt, inArray } from "drizzle-orm";
import { db, kalshiPaperRunsTable as runs, kalshiPaperCandidatesTable as candidates,
  kalshiPaperExecutionsTable as executions, kalshiPaperReportsTable as reports } from "@workspace/db";
import { toRun, toOpportunity, type Candidate, type Execution, type PaperDb } from "./repository";
import { hideHoldout, PaperError, PAPER_LIMITATIONS } from "./protocol";
import type { PaperDashboard } from "@workspace/api-zod";

export function csvCell(value: unknown) {
  let text = value == null ? "" : typeof value === "object" ? JSON.stringify(value) : String(value);
  // Formula injection protection for human names/tickers/evidence in spreadsheets.
  if (typeof value === "string" && /^[\s]*[=+\-@\t\r]/.test(text)) text = "'" + text;
  return `"${text.replace(/"/g, '""')}"`;
}
export async function writePaperExport(id: string, format: "json" | "csv", write: (chunk: string) => Promise<void>, now = new Date(),
  executor: PaperDb = db) {
  await executor.transaction(async tx => {
    const [raw] = await tx.select().from(runs).where(eq(runs.id, id)).limit(1);
    if (!raw) throw new PaperError("No se encontró la prueba.", 404);
    const run = toRun(raw), hidden = hideHoldout(run, now);
    const [saved] = await tx.select().from(reports).where(eq(reports.runId, id)).limit(1);
    const report = saved?.payload as Pick<PaperDashboard, "stats" | "comparisons"> | undefined;
    const meta = { exportedAt: now.toISOString(), run, holdoutHidden: hidden,
      summaryAt: saved?.generatedAt.toISOString() ?? null,
      stats: report?.stats.filter(s => !hidden || s.phase !== "holdout") ?? [],
      comparisons: report?.comparisons.filter(s => !hidden || s.phase !== "holdout") ?? [],
      limitations: PAPER_LIMITATIONS };
    if (format === "json") await write(JSON.stringify(meta).slice(0, -1) + ',"opportunities":[');
    else await write("\uFEFF" + ["row_type", "trade_id", "event", "market", "side", "observed_price",
      "decision_at", "confirmed_at", "phase", "eligible", "reason", "policy", "delay_seconds",
      "execution", "contracts", "cost_usd", "fee_usd", "settlement", "net_profit_usd", "evidence_json"].map(csvCell).join(",") +
      "\r\n" + ["protocol", ...Array(18).fill(""), meta].map(csvCell).join(",") + "\r\n");
    let cursor: string | undefined, separator = "";
    while (true) {
      const rows = await tx.select().from(candidates).where(and(eq(candidates.runId, id),
        cursor ? gt(candidates.id, cursor) : undefined)).orderBy(asc(candidates.id)).limit(100);
      if (!rows.length) break;
      const fills = await tx.select().from(executions).where(inArray(executions.candidateId, rows.map(c => c.id)));
      // A maximum of 10k candidates × 6 executions is enforced when recording.
      const byCandidate = new Map<string, Execution[]>();
      for (const fill of fills) {
        const list = byCandidate.get(fill.candidateId) ?? [];
        list.push(fill as Execution); byCandidate.set(fill.candidateId, list);
      }
      for (const c of rows) {
        const row = toOpportunity(c as Candidate, byCandidate.get(c.id) ?? [], hidden);
        if (format === "json") { await write(separator + JSON.stringify(row)); separator = ","; }
        else {
          const details = row.executions.length ? row.executions : [null];
          for (const x of details) await write([
            "opportunity", row.tradeId, row.eventTitle, row.marketTitle, row.side, row.price,
            row.decidedAt, row.confirmedAt, row.phase, row.eligible, row.reason, x?.policy, x?.delaySeconds,
            x?.status, x?.contracts, x?.costUsd, x?.feeUsd, x?.settlement, x?.netProfitUsd,
            { decision: row.evidence, execution: x?.evidence ?? null },
          ].map(csvCell).join(",") + "\r\n");
        }
      }
      cursor = rows.at(-1)!.id;
    }
    if (format === "json") await write("]}");
  }, { isolationLevel: "repeatable read", accessMode: "read only" });
}
