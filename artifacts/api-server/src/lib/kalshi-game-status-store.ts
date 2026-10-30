import { db, kalshiAlertsTable, kalshiGameStatusTable as games } from "@workspace/db";
import { and, eq, inArray, isNull, lte, ne, or, sql } from "drizzle-orm";
import { monitoringStopped, type GameStatus, type GameStatusRepository } from "./kalshi-game-status";

function status(row: typeof games.$inferSelect): GameStatus {
  return { ...row, state: ["scheduled", "live", "finished"].includes(row.state) ? row.state as GameStatus["state"] : "unknown" };
}
export async function readGameStatus(ticker: string) {
  const [row] = await db.select().from(games).where(eq(games.ticker, ticker)).limit(1);
  return row ? status(row) : undefined;
}
export async function canMonitorMarket(ticker: string) {
  return !monitoringStopped(await readGameStatus(ticker));
}
/** One compatibility pass, then new executions register their markets atomically.
 * Normal status ticks query the compact market table, not the execution ledger. */
export async function bootstrapTrackedMarkets() {
  await db.execute(sql`INSERT INTO kalshi_game_status (ticker)
    SELECT DISTINCT ticker FROM kalshi_alerts ON CONFLICT (ticker) DO NOTHING`);
}
export const gameStatusRepository: GameStatusRepository = {
  async batch(now, preferred) {
    const result = await db.execute(sql`
      WITH representatives AS (
        SELECT DISTINCT ON (COALESCE(milestone_id, event_ticker, ticker))
          ticker, next_check_at, (ticker = ${preferred ?? ""}) AS preferred,
          CASE WHEN state = 'live' OR starts_at BETWEEN ${new Date(now.getTime() - 300_000)} AND ${new Date(now.getTime() + 300_000)}
            THEN 0 WHEN next_check_at < ${new Date(now.getTime() - 900_000)} THEN 1 ELSE 2 END AS urgency
        FROM kalshi_game_status
        WHERE state <> 'finished' AND next_check_at <= ${now}
        ORDER BY COALESCE(milestone_id, event_ticker, ticker),
          (ticker = ${preferred ?? ""}) DESC, urgency, next_check_at, ticker
      )
      SELECT ticker FROM representatives
      ORDER BY preferred DESC, urgency, next_check_at, ticker LIMIT 100
    `);
    const tickers = result.rows.map(row => String(row.ticker));
    if (!tickers.length) return [];
    const rows = await db.select().from(games).where(inArray(games.ticker, tickers));
    const indexed = new Map(rows.map(row => [row.ticker, status(row)]));
    return tickers.map(ticker => ({ ticker, previous: indexed.get(ticker) }));
  },
  async next(now, preferred) {
    const [row] = await db.select({ ticker: kalshiAlertsTable.ticker, previous: games })
      .from(kalshiAlertsTable).leftJoin(games, eq(games.ticker, kalshiAlertsTable.ticker))
      .where(or(isNull(games.ticker), and(ne(games.state, "finished"), lte(games.nextCheckAt, now))))
      .groupBy(kalshiAlertsTable.ticker, games.ticker)
      .orderBy(sql`${kalshiAlertsTable.ticker} = ${preferred ?? ""} desc`,
        sql`${games.nextCheckAt} asc nulls first`, kalshiAlertsTable.ticker).limit(1);
    return row ? { ticker: row.ticker, previous: row.previous ? status(row.previous) : undefined } : undefined;
  },
  async save(progress) {
    await db.transaction(async tx => {
      await tx.insert(games).values(progress).onConflictDoUpdate({ target: games.ticker, set: progress });
      if (progress.milestoneId && progress.source !== "market" && progress.state !== "unknown" && !progress.error) {
        // Only a sporting state is shared. A finalized prop never ends its game.
        await tx.update(games).set({ state: progress.state, source: progress.source,
          milestoneId: progress.milestoneId, ...(progress.startsAt ? { startsAt: progress.startsAt } : {}),
          delayed: progress.delayed, checkedAt: progress.checkedAt, error: progress.error,
          nextCheckAt: progress.nextCheckAt })
          .where(and(progress.state === "finished" ? sql`true` : ne(games.state, "finished"), or(eq(games.milestoneId, progress.milestoneId),
            and(isNull(games.milestoneId), eq(games.eventTicker, progress.eventTicker ?? "")))));
      }
    });
  },
};
