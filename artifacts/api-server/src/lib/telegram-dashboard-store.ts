import { and, asc, count, desc, eq, gte, inArray, isNull, lte, sql } from "drizzle-orm";
import {
  db, kalshiAlertsTable, kalshiTelegramChartsTable, telegramDashboardTable,
} from "@workspace/db";
import type { DashboardState, DashboardStore } from "./telegram-dashboard";
import type { Screen } from "./telegram-dashboard-view";

export const telegramDashboardStore: DashboardStore = {
  async state(chatId) {
    const [state] = await db.select().from(telegramDashboardTable)
      .where(eq(telegramDashboardTable.chatId, chatId)).limit(1);
    if (!state) return undefined;
    const screen: Screen = ["sports", "games", "markets", "chart"].includes(state.screen) ? state.screen as Screen : "sports";
    return { ...state, screen };
  },
  async save(state: DashboardState) {
    await db.insert(telegramDashboardTable).values({ ...state, updatedAt: new Date() })
      .onConflictDoUpdate({ target: telegramDashboardTable.chatId, set: { ...state, updatedAt: new Date() } });
  },
  async markets(threshold) {
    const rows = await db.select({
      ticker: kalshiAlertsTable.ticker, sport: kalshiAlertsTable.sport,
      eventTitle: kalshiAlertsTable.eventTitle, marketTitle: kalshiAlertsTable.marketTitle,
      marketUrl: kalshiAlertsTable.marketUrl, trades: count(),
      lastTradeAt: sql<string>`max(${kalshiAlertsTable.createdTime})::text`,
    }).from(kalshiAlertsTable).where(gte(kalshiAlertsTable.notional, threshold))
      .groupBy(kalshiAlertsTable.ticker, kalshiAlertsTable.sport, kalshiAlertsTable.eventTitle,
        kalshiAlertsTable.marketTitle, kalshiAlertsTable.marketUrl);
    return rows.map(row => ({ ...row, lastTradeAt: new Date(row.lastTradeAt).toISOString() }));
  },
  async trades(ticker, threshold) {
    return db.select().from(kalshiAlertsTable)
      .where(and(eq(kalshiAlertsTable.ticker, ticker), gte(kalshiAlertsTable.notional, threshold)))
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
  async publishedThrough(cutoff, tickers) {
    if (!tickers.length) return;
    await db.update(kalshiAlertsTable).set({ alertedAt: new Date() })
      .where(and(isNull(kalshiAlertsTable.alertedAt), lte(kalshiAlertsTable.savedAt, cutoff),
        inArray(kalshiAlertsTable.ticker, tickers)));
  },
};
