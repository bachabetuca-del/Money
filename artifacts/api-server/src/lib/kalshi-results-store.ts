import { db, kalshiGameStatusTable as games, kalshiResultsTable as results } from "@workspace/db";
import { and, asc, eq, isNull, lt, lte, or, sql } from "drizzle-orm";
import type { FinalResult } from "./kalshi-results-source";

/** Bounded final enrichment, NOT renewed trade/history polling for finished games.
 * One game per 5 seconds, at most 3 attempts (6h apart); successful results are permanent.
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
            isNull(results.gameResult))),
        )).orderBy(asc(results.nextCheckAt), asc(games.checkedAt)).limit(1);
      if (!candidate) return;
      // Reuse an already saved scoreboard for any market of this exact milestone.
      const [saved] = candidate.game.milestoneId ? await db.select({ gameResult: results.gameResult })
        .from(games).innerJoin(results, eq(games.ticker, results.ticker))
        .where(and(eq(games.milestoneId, candidate.game.milestoneId), sql`${results.gameResult} IS NOT NULL`)).limit(1) : [];
      let value: FinalResult = { gameResult: saved?.gameResult ?? null, marketResult: null };
      let error: string | null = null;
      try { if (!value.gameResult) value = await this.resolve(candidate.game.ticker, candidate.game.milestoneId); }
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
        if (candidate.game.milestoneId) {
          const siblings = await tx.select({ ticker: games.ticker }).from(games)
            .where(eq(games.milestoneId, candidate.game.milestoneId));
          // Persist once for the whole game, including attempts, so even a missing
          // scoreboard does not cause the same API reads for every bet.
          const otherRows = siblings.filter(sibling => sibling.ticker !== row.ticker)
            .map(sibling => ({ ...row, ticker: sibling.ticker }));
          if (otherRows.length) {
            await tx.insert(results).values(otherRows)
              .onConflictDoUpdate({ target: results.ticker, set: {
                gameResult: sql`coalesce(${results.gameResult}, excluded.game_result)`,
                attempts: sql`greatest(${results.attempts}, excluded.attempts)`,
                checkedAt: now, nextCheckAt: row.nextCheckAt, error,
              } });
          }
        }
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
