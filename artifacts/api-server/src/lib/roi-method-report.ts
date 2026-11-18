/** Offline diagnostic: never imported by routes or workers.
 * Run only on development; all DB work is read-only and bounded in time. */
import { db, pool } from "@workspace/db";
import { sql } from "drizzle-orm";
import { loadRoiRollups } from "./kalshi-roi-leaderboard";
import { buildRoiRanking } from "./roi-ranking";
import { ROI_METHOD_VERSION, selectRoiEntries } from "./roi-method";
import { readStoredFees } from "./kalshi-fee-store";
import type { RoiPhase } from "@workspace/api-zod";

async function main() {
  if (process.env.BOT_WORKERS_ENABLED !== "false") throw new Error("Audit requires development workers disabled.");
  const now = new Date(), fees = await readStoredFees();
  const options = { groupBy: "segment" as const, window: "all" as const, band: "all" as const,
    direction: "all" as const, minGames: 1, page: 1, coverage: "verified" as const };
  const began = performance.now();
  const snapshot = await db.transaction(async tx => {
    await tx.execute(sql`SET LOCAL statement_timeout = '30000'`);
    return loadRoiRollups(options, 10000, now, tx, fees);
  }, { accessMode: "read only", isolationLevel: "repeatable read" });
  const queryMs = Math.round(performance.now() - began);
  const comparisons = (["prematch", "nearStart", "live", "unknown"] as RoiPhase[]).map(phase => {
    return (["game", "execution"] as const).map(unit => {
      const selected = selectRoiEntries(snapshot.rows, unit, phase);
      const ranking = buildRoiRanking(selected.rows, "segment", 1, { now, separatePatterns: unit === "game" });
      return { methodology: selected.methodology, summary: ranking.summary,
        patterns: ranking.rows, firstSelections: unit === "game" ? selected.rows.slice(0, 25).map(r => ({
          gameId: r.gameId, ticker: r.ticker, tradeId: r.firstTradeId, time: r.firstAt,
          price: r.firstPrice, side: r.side, officialResult: r.officialResult, category: r.category,
          profit: r.profit, fee: r.firstFee,
        })) : [] };
    });
  }).flat();
  process.stdout.write(JSON.stringify({ methodVersion: ROI_METHOD_VERSION, generatedAt: now.toISOString(),
    environment: "development", queryMs, rollupRows: snapshot.rows.length,
    note: "Retrospective saved data only. No production reads, writes, messages or active cohort changes.",
    externalCsvComparison: "Not numerically reconciled: uploaded CSVs are summaries inferred from scores, without per-entry IDs or official settlements. Do not force agreement.",
    comparisons }, null, 2) + "\n");
}
main().catch(error => { process.stderr.write(String(error) + "\n"); process.exitCode = 1; }).finally(() => pool.end());
