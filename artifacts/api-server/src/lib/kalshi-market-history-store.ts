import { db, kalshiAlertsTable, kalshiTradeHistoryTable, kalshiGameStatusTable } from "@workspace/db";
import { and, eq, isNotNull, ne } from "drizzle-orm";
import type { HistoryJob, HistoryRepository } from "./kalshi-market-history";
import type { PublicTrade } from "./kalshi-monitor";
import { readGameStatus } from "./kalshi-game-status-store";
import { monitoringStopped } from "./kalshi-game-status";

function job(row: typeof kalshiTradeHistoryTable.$inferSelect): HistoryJob {
  if (!["live", "archive", "complete"].includes(row.phase)) throw new Error("Invalid history import phase.");
  return { ...row, phase: row.phase as HistoryJob["phase"] };
}

export const marketHistoryStore: HistoryRepository<PublicTrade> = {
  async candidates() {
    const [markets, jobs] = await Promise.all([
      db.selectDistinct({ ticker: kalshiAlertsTable.ticker }).from(kalshiAlertsTable)
        .innerJoin(kalshiGameStatusTable, eq(kalshiGameStatusTable.ticker, kalshiAlertsTable.ticker))
        .where(and(ne(kalshiGameStatusTable.state, "finished"),
          eq(kalshiGameStatusTable.marketTerminal, false), isNotNull(kalshiGameStatusTable.marketStatus))),
      db.select().from(kalshiTradeHistoryTable),
    ]);
    const byTicker = new Map(jobs.map(row => [row.ticker, job(row)]));
    return markets.map(row => ({ ticker: row.ticker, job: byTicker.get(row.ticker) }));
  },
  async eligible(ticker) {
    const status = await readGameStatus(ticker);
    return Boolean(status?.marketStatus) && !monitoringStopped(status);
  },
  async job(ticker) {
    const [row] = await db.select().from(kalshiTradeHistoryTable)
      .where(eq(kalshiTradeHistoryTable.ticker, ticker)).limit(1);
    return row ? job(row) : undefined;
  },
  async commit(progress, rows) {
    await db.transaction(async tx => {
      if (rows.length) {
        await tx.insert(kalshiAlertsTable).values(rows.map(row => ({
          ...row, createdTime: new Date(row.createdTime),
        }))).onConflictDoNothing({ target: kalshiAlertsTable.tradeId });
      }
      await tx.insert(kalshiTradeHistoryTable).values(progress)
        .onConflictDoUpdate({ target: kalshiTradeHistoryTable.ticker, set: progress });
    });
  },
};
