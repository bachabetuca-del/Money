import { db, pool, kalshiGameStatusTable as games, kalshiResultsTable as results } from "@workspace/db";
import { and, asc, eq, isNull, lt, lte, or, sql } from "drizzle-orm";
import type { FinalResult } from "./kalshi-results-source";

/** Additive, idempotent bootstrap also covers an existing published database. */
export async function ensureResultsSchema() {
  await pool.query(`CREATE TABLE IF NOT EXISTS kalshi_results (
    ticker text PRIMARY KEY, game_result text, market_result text,
    attempts integer NOT NULL DEFAULT 0, checked_at timestamptz,
    next_check_at timestamptz NOT NULL DEFAULT now(), error text
  )`);
}

/** Bounded final enrichment, NOT renewed trade/history polling for finished games.
 * One market per minute, at most 3 attempts (6h apart); successful results are permanent.
 */
export class FinalResultsWorker {
  private busy = false;
  constructor(private resolve: (ticker: string, milestone: string | null) => Promise<FinalResult>,
    private warn: (message: string) => void = () => undefined) {}
  async tick(now = new Date()) {
    if (this.busy) return;
    this.busy = true;
    try {
      const [candidate] = await db.select({ game: games, result: results }).from(games)
        .leftJoin(results, eq(results.ticker, games.ticker))
        .where(and(
          or(eq(games.state, "finished"), and(lte(games.startsAt, new Date(now.getTime() - 6 * 3_600_000)),
            sql`${games.state} <> 'live'`)),
          or(isNull(results.ticker), and(lt(results.attempts, 3), lte(results.nextCheckAt, now),
            or(isNull(results.gameResult), isNull(results.marketResult)))),
        )).orderBy(asc(results.nextCheckAt), asc(games.checkedAt)).limit(1);
      if (!candidate) return;
      let value: FinalResult = { gameResult: null, marketResult: null };
      let error: string | null = null;
      try { value = await this.resolve(candidate.game.ticker, candidate.game.milestoneId); }
      catch (failure) {
        error = failure instanceof Error ? failure.message : "Final result unavailable";
        this.warn(error);
      }
      const row = {
        ticker: candidate.game.ticker,
        gameResult: value.gameResult ?? candidate.result?.gameResult ?? null,
        marketResult: value.marketResult ?? candidate.result?.marketResult ?? null,
        attempts: (candidate.result?.attempts ?? 0) + 1, checkedAt: now,
        nextCheckAt: new Date(now.getTime() + 6 * 3_600_000), error,
      };
      await db.transaction(async tx => {
        await tx.insert(results).values(row).onConflictDoUpdate({ target: results.ticker, set: row });
        if (row.gameResult) {
          // A final scoreboard is evidence of a finish; a settled bet alone is not.
          await tx.update(games).set({ state: "finished", source: "live",
            delayed: false, checkedAt: now, error: null })
            .where(candidate.game.milestoneId ? eq(games.milestoneId, candidate.game.milestoneId) :
              eq(games.ticker, candidate.game.ticker));
        }
      });
    } finally { this.busy = false; }
  }
}
