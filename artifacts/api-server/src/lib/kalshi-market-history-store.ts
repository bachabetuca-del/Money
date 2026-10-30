import { db, kalshiAlertsTable, kalshiTradeHistoryTable, kalshiGameStatusTable, kalshiSettlementsTable } from "@workspace/db";
import { and, eq, inArray, sql } from "drizzle-orm";
import type { HistoryJob, HistoryRepository } from "./kalshi-market-history";
import { HISTORY_AUDIT_VERSION } from "./kalshi-market-history";
import type { PublicTrade } from "./kalshi-monitor";
import { readGameStatus } from "./kalshi-game-status-store";
import { monitoringStopped } from "./kalshi-game-status";
import { checkedHistoryRows } from "./history-page-integrity";
import { CAPTURE_MINIMUM, shouldCaptureTrade } from "./kalshi-trade-bands";

function job(row: typeof kalshiTradeHistoryTable.$inferSelect): HistoryJob {
  if (!["live", "archive", "complete"].includes(row.phase)) throw new Error("Invalid history import phase.");
  return { ...row, phase: row.phase as HistoryJob["phase"] };
}

type HistoryDatabase = Pick<typeof db, "select" | "transaction">;
export function createMarketHistoryStore(database: HistoryDatabase = db): HistoryRepository<PublicTrade> {
return {
  async candidates(preferred) {
    const g = kalshiGameStatusTable, h = kalshiTradeHistoryTable, s = kalshiSettlementsTable;
    const markets = await database.select({
      ticker: g.ticker, history: h, closed: sql<boolean>`coalesce(${s.terminal}, false)`, closedAt: s.checkedAt,
    }).from(g).leftJoin(h, eq(h.ticker, g.ticker)).leftJoin(s, eq(s.ticker, g.ticker))
      .where(sql`
        EXISTS (SELECT 1 FROM kalshi_alerts a WHERE a.ticker = ${g.ticker})
        AND (${h.error} IS NULL OR ${h.updatedAt} <= ${new Date(Date.now() - 60_000)})
        AND (
          (${s.terminal} = true AND (
            ${h.ticker} IS NULL OR ${h.phase} <> 'complete' OR ${h.finalPass} = false
            OR ${h.auditedAt} IS NULL OR ${h.auditVersion} < ${HISTORY_AUDIT_VERSION}
            OR ${h.captureMinimum} > ${CAPTURE_MINIMUM} OR ${h.sinceAt} IS NOT NULL
            OR ${h.snapshotAt} < ${s.checkedAt}))
          OR (coalesce(${s.terminal}, false) = false AND ${g.state} <> 'finished'
            AND ${g.marketTerminal} = false AND ${g.marketStatus} IS NOT NULL AND (
              ${h.ticker} IS NULL OR ${h.phase} <> 'complete'
              OR ${h.auditVersion} < ${HISTORY_AUDIT_VERSION} OR ${h.captureMinimum} > ${CAPTURE_MINIMUM}
              OR ${h.snapshotAt} <= ${new Date(Date.now() - 15 * 60_000)}))
        )`)
      .orderBy(sql`(${g.ticker} = ${preferred ?? ""}) DESC`,
        sql`(${h.phase} IS NOT NULL AND ${h.phase} <> 'complete') DESC`,
        sql`${h.updatedAt} ASC NULLS FIRST`, g.ticker)
      .limit(100);
    return markets.map(row => ({ ticker: row.ticker, job: row.history ? job(row.history) : undefined, closed: row.closed, closedAt: row.closedAt }));
  },
  async eligible(ticker, finalPass) {
    if (finalPass) {
      const [settlement] = await database.select({ terminal: kalshiSettlementsTable.terminal })
        .from(kalshiSettlementsTable).where(eq(kalshiSettlementsTable.ticker, ticker)).limit(1);
      return settlement?.terminal === true;
    }
    const status = await readGameStatus(ticker);
    return Boolean(status?.marketStatus) && !monitoringStopped(status);
  },
  async job(ticker) {
    const [row] = await database.select().from(kalshiTradeHistoryTable)
      .where(eq(kalshiTradeHistoryTable.ticker, ticker)).limit(1);
    return row ? job(row) : undefined;
  },
  async commit(progress, rows) {
    const checked = checkedHistoryRows(rows, progress);
    await database.transaction(async tx => {
      if (checked.length) {
        const existing = await tx.select({ id: kalshiAlertsTable.tradeId, ticker: kalshiAlertsTable.ticker })
          .from(kalshiAlertsTable).where(inArray(kalshiAlertsTable.tradeId, checked.map(r => r.tradeId)));
        if (existing.some(r => r.ticker !== progress.ticker)) throw new Error("Trade ID belongs to another market.");
        const saved = new Set(existing.map(r => r.id));
        // Repair existing records even if corrected value falls below the capture floor.
        const captured = checked.filter(r => shouldCaptureTrade(r.notional) || saved.has(r.tradeId));
        if (captured.length) {
          const written = await tx.insert(kalshiAlertsTable).values(captured.map(row => ({
          ...row, createdTime: new Date(row.createdTime),
        }))).onConflictDoUpdate({
          target: kalshiAlertsTable.tradeId,
          set: {
            price: sql`excluded.price`, count: sql`excluded.count`, notional: sql`excluded.notional`,
            outcomeSide: sql`excluded.outcome_side`, bookSide: sql`excluded.book_side`,
            createdTime: sql`excluded.created_time`, blockTrade: sql`excluded.block_trade`,
            sport: sql`excluded.sport`, title: sql`excluded.title`, eventTitle: sql`excluded.event_title`,
            marketTitle: sql`excluded.market_title`, marketUrl: sql`excluded.market_url`,
          },
          // Preserve savedAt and alertedAt; reconciliation must not replay notifications.
          setWhere: eq(kalshiAlertsTable.ticker, progress.ticker),
          }).returning({ id: kalshiAlertsTable.tradeId });
          if (written.length !== captured.length) throw new Error("Concurrent trade identity conflict; history page was not committed.");
        }
      }
      await tx.insert(kalshiTradeHistoryTable).values(progress)
        .onConflictDoUpdate({ target: kalshiTradeHistoryTable.ticker, set: progress });
    });
  },
};
}
export const marketHistoryStore = createMarketHistoryStore();
