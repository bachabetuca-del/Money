import { db, kalshiAlertsTable, kalshiGameStatusTable as games } from "@workspace/db";
import { and, eq, isNull, lte, ne, or, sql } from "drizzle-orm";
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
export const gameStatusRepository: GameStatusRepository = {
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
      if (progress.state === "finished" && progress.milestoneId) {
        await tx.update(games).set({ state: "finished", source: progress.source,
          delayed: progress.delayed, checkedAt: progress.checkedAt, error: progress.error })
          .where(eq(games.milestoneId, progress.milestoneId));
      }
    });
  },
};
