import { and, asc, count, desc, eq, gt, gte, inArray, isNull, lt, lte, sql } from "drizzle-orm";
import {
  db, kalshiAlertsTable, kalshiTelegramChartsTable, telegramDashboardTable, kalshiGameStatusTable,
} from "@workspace/db";
import type { DashboardState, DashboardStore } from "./telegram-dashboard";
import { decodeScopeScreen, encodeScopeScreen } from "./telegram-game-scope";
import type { TradeRange } from "./kalshi-trade-bands";

function rangeCondition(range: TradeRange) {
  return and(
    range.minimumInclusive ? gte(kalshiAlertsTable.notional, range.minimum) : gt(kalshiAlertsTable.notional, range.minimum),
    range.maximum === null ? undefined : lt(kalshiAlertsTable.notional, range.maximum),
  );
}

export const telegramDashboardStore: DashboardStore = {
  async state(chatId) {
    const [state] = await db.select().from(telegramDashboardTable)
      .where(eq(telegramDashboardTable.chatId, chatId)).limit(1);
    if (!state) return undefined;
    return { ...state, ...decodeScopeScreen(state.screen), band: state.band === "medium" ? "medium" : "large" };
  },
  async save(state: DashboardState) {
    // Use the existing text screen field, preserving old rows without a schema migration.
    const { scope, ...rest } = state;
    const saved = { ...rest, screen: encodeScopeScreen(state.screen, scope), updatedAt: new Date() };
    await db.insert(telegramDashboardTable).values(saved)
      .onConflictDoUpdate({ target: telegramDashboardTable.chatId, set: saved });
  },
  async markets(range) {
    const rows = await db.select({
      ticker: kalshiAlertsTable.ticker, sport: kalshiAlertsTable.sport,
      eventTitle: kalshiAlertsTable.eventTitle, marketTitle: kalshiAlertsTable.marketTitle,
      marketUrl: kalshiAlertsTable.marketUrl, trades: count(),
      lastTradeAt: sql<string>`max(${kalshiAlertsTable.createdTime})::text`,
    }).from(kalshiAlertsTable).where(rangeCondition(range))
      .groupBy(kalshiAlertsTable.ticker, kalshiAlertsTable.sport, kalshiAlertsTable.eventTitle,
        kalshiAlertsTable.marketTitle, kalshiAlertsTable.marketUrl);
    const statuses = await db.select().from(kalshiGameStatusTable);
    const byTicker = new Map(statuses.map(row => [row.ticker, row]));
    return rows.map(row => {
      const status = byTicker.get(row.ticker);
      return { ...row, lastTradeAt: new Date(row.lastTradeAt).toISOString(),
        gameState: status?.state, gameSource: status?.source, gameDelayed: status?.delayed,
        gameStartsAt: status?.startsAt?.toISOString(),
        gameCheckedAt: status?.checkedAt.toISOString(), marketTerminal: status?.marketTerminal };
    });
  },
  async trades(ticker, range) {
    return db.select().from(kalshiAlertsTable)
      .where(and(eq(kalshiAlertsTable.ticker, ticker), rangeCondition(range)))
      .orderBy(asc(kalshiAlertsTable.createdTime), asc(kalshiAlertsTable.tradeId));
  },
  async context(ticker, context) {
    await db.update(kalshiAlertsTable)
      .set({ ...context, title: `${context.eventTitle} · ${context.marketTitle}` })
      .where(eq(kalshiAlertsTable.ticker, ticker));
  },
  async oldCards(chatId) {
    return db.select({ ticker: kalshiTelegramChartsTable.ticker, messageId: kalshiTelegramChartsTable.messageId })
      .from(kalshiTelegramChartsTable)
      .where(and(eq(kalshiTelegramChartsTable.chatId, chatId), isNull(kalshiTelegramChartsTable.retiredAt)))
      .orderBy(desc(kalshiTelegramChartsTable.updatedAt));
  },
  async retire(ticker) {
    await db.update(kalshiTelegramChartsTable).set({ retiredAt: new Date() })
      .where(eq(kalshiTelegramChartsTable.ticker, ticker));
  },
  async publishedThrough(cutoff, tickers, range) {
    if (!tickers.length) return;
    await db.update(kalshiAlertsTable).set({ alertedAt: new Date() })
      .where(and(isNull(kalshiAlertsTable.alertedAt), lte(kalshiAlertsTable.savedAt, cutoff),
        inArray(kalshiAlertsTable.ticker, tickers), rangeCondition(range)));
  },
};
