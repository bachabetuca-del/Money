import { and, asc, count, desc, eq, gt, gte, lt, lte } from "drizzle-orm";
import { db, kalshiAlertsTable, kalshiMonitorSettingsTable } from "@workspace/db";
import { telegramDashboardStore } from "./telegram-dashboard-store";
import { buildCatalog, type CatalogMarket } from "./telegram-dashboard-view";
import { scopedCatalog } from "./telegram-game-scope";
import { tradeRange, type TradeBand } from "./kalshi-trade-bands";
import { publicDirection } from "./telegram-trade-direction";
import { marketHistoryStore } from "./kalshi-market-history-store";
import { explorerState, explorerSince, type ExplorerWindow } from "./kalshi-explorer-view";

export type ExplorerFilters = {
  band: TradeBand;
  scope: "active" | "history";
  ticker?: string;
  window: ExplorerWindow;
};

/** Read-only: visiting the preview never polls Kalshi or sends Telegram messages. */
export async function getKalshiExplorer(filters: ExplorerFilters, now = new Date()) {
  const [settings] = await db.select({ minimumNotional: kalshiMonitorSettingsTable.minimumNotional })
    .from(kalshiMonitorSettingsTable).where(eq(kalshiMonitorSettingsTable.id, 1)).limit(1);
  const range = tradeRange(filters.band, settings?.minimumNotional ?? 10_000);
  const catalog = scopedCatalog(buildCatalog(await telegramDashboardStore.markets(range)), filters.scope, now);
  const games = new Map<string, CatalogMarket[]>();
  for (const market of catalog) {
    const group = games.get(market.gameKey) ?? [];
    group.push(market);
    games.set(market.gameKey, group);
  }
  const markets = catalog.map(m => ({
    ticker: m.ticker, sport: m.sport, gameKey: m.gameKey, gameName: m.gameName,
    gameDateLabel: m.gameDateLabel, betLabel: m.betLabel, marketUrl: m.marketUrl,
    trades: m.trades, lastTradeAt: m.lastTradeAt,
    state: explorerState(games.get(m.gameKey)!, now),
  })).sort((a, b) => b.lastTradeAt.localeCompare(a.lastTradeAt));
  const empty = {
    generatedAt: now.toISOString(), workersPaused: process.env.BOT_WORKERS_ENABLED === "false",
    markets, trades: [], totalTrades: 0, truncated: false, historyStatus: "Sin mercado seleccionado",
  };
  // A hidden/old selection cannot leak trades from another band or scope.
  if (!filters.ticker || !catalog.some(m => m.ticker === filters.ticker)) return empty;

  const since = explorerSince(filters.window, now);
  const condition = and(
    eq(kalshiAlertsTable.ticker, filters.ticker),
    range.minimumInclusive ? gte(kalshiAlertsTable.notional, range.minimum) : gt(kalshiAlertsTable.notional, range.minimum),
    range.maximum === null ? undefined : lt(kalshiAlertsTable.notional, range.maximum),
    since ? gte(kalshiAlertsTable.createdTime, since) : undefined,
    lte(kalshiAlertsTable.createdTime, now),
  );
  const [totals, rows, job] = await Promise.all([
    db.select({ total: count() }).from(kalshiAlertsTable).where(condition),
    db.select().from(kalshiAlertsTable).where(condition)
      .orderBy(desc(kalshiAlertsTable.createdTime), asc(kalshiAlertsTable.tradeId)).limit(5000),
    marketHistoryStore.job(filters.ticker),
  ]);
  const totalTrades = totals[0]?.total ?? 0;
  let historyStatus = "Histórico pendiente; solo operaciones guardadas";
  if (job?.error) historyStatus = "Histórico incompleto; reintento pendiente";
  else if (job?.phase === "complete") {
    historyStatus = `Histórico importado hasta ${job.snapshotAt.toISOString()}; actividad posterior según monitor`;
  } else if (job) historyStatus = "Histórico en proceso; datos parciales";
  return {
    ...empty, totalTrades, truncated: totalTrades > rows.length, historyStatus,
    trades: rows.reverse().map(t => ({
      tradeId: t.tradeId, ticker: t.ticker,
      direction: publicDirection(t.outcomeSide, undefined, t.bookSide),
      price: t.price, count: t.count, notional: t.notional,
      createdTime: t.createdTime.toISOString(),
    })),
  };
}
