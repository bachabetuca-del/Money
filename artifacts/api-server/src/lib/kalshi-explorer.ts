import { and, asc, count, desc, eq, gt, gte, lt, lte, sql } from "drizzle-orm";
import { db, kalshiAlertsTable, kalshiMonitorSettingsTable } from "@workspace/db";
import { telegramDashboardStore } from "./telegram-dashboard-store";
import { buildCatalog, type CatalogMarket } from "./telegram-dashboard-view";
import { scopedCatalog } from "./telegram-game-scope";
import { CAPTURE_MINIMUM, tradeRange, type TradeBand } from "./kalshi-trade-bands";
import { publicDirection } from "./telegram-trade-direction";
import { marketHistoryStore } from "./kalshi-market-history-store";
import { explorerState, explorerSince, type ExplorerWindow } from "./kalshi-explorer-view";
import { scoreQueue } from "./kalshi-score-queue";
import { gameDateLabel, gameTimeLabel } from "./telegram-game-date";
import { emptyFlow } from "./market-flow";
import { explorerDirection } from "./explorer-direction";

export type ExplorerFilters = {
  band: TradeBand;
  scope: "active" | "history";
  ticker?: string;
  window: ExplorerWindow;
  direction?: "all" | "yes" | "no";
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
  const directionCondition = filters.direction && filters.direction !== "all"
    ? eq(explorerDirection(kalshiAlertsTable.outcomeSide, kalshiAlertsTable.bookSide), filters.direction)
    : undefined;
  // Filter before aggregation/pagination, not just the newest 5,000 chart rows.
  const directionCounts = directionCondition ? await db.select({
    ticker: kalshiAlertsTable.ticker, total: count(),
    latest: sql<string>`max(${kalshiAlertsTable.createdTime})::text`,
  }).from(kalshiAlertsTable).where(and(
    directionCondition,
    range.minimumInclusive ? gte(kalshiAlertsTable.notional, range.minimum) : gt(kalshiAlertsTable.notional, range.minimum),
    range.maximum === null ? undefined : range.maximumInclusive
      ? lte(kalshiAlertsTable.notional, range.maximum) : lt(kalshiAlertsTable.notional, range.maximum),
  )).groupBy(kalshiAlertsTable.ticker) : null;
  const countsByTicker = new Map(directionCounts?.map(row => [row.ticker, row]));
  const markets = catalog.filter(m => !directionCounts || countsByTicker.has(m.ticker)).map(m => {
    const scheduled = games.get(m.gameKey)?.find(game =>
      game.gameStartsAt && Number.isFinite(new Date(game.gameStartsAt).getTime()));
    return {
    ticker: m.ticker, sport: m.sport, gameKey: m.gameKey, gameName: m.gameName,
    gameDateLabel: scheduled ? gameDateLabel(scheduled.ticker, scheduled.gameStartsAt) : m.gameDateLabel,
    gameTimeLabel: gameTimeLabel(scheduled?.gameStartsAt),
    gameStartsAt: scheduled?.gameStartsAt ? new Date(scheduled.gameStartsAt).toISOString() : null,
    betLabel: m.betLabel, marketUrl: m.marketUrl,
    trades: countsByTicker.get(m.ticker)?.total ?? m.trades,
    lastTradeAt: countsByTicker.has(m.ticker) ? new Date(countsByTicker.get(m.ticker)!.latest).toISOString() : m.lastTradeAt,
    state: explorerState(games.get(m.gameKey)!, now),
    gameResult: m.gameResult ?? games.get(m.gameKey)?.find(game => game.gameResult)?.gameResult ?? null,
    marketResult: m.marketResult ?? null,
    scoreStatus: m.scoreStatus ?? "pending",
    scoreMessage: m.scoreMessage ?? null,
  };
  }).sort((a, b) => b.lastTradeAt.localeCompare(a.lastTradeAt));
  const empty = {
    generatedAt: now.toISOString(), workersPaused: process.env.BOT_WORKERS_ENABLED === "false",
    markets, trades: [], totalTrades: 0, truncated: false, historyStatus: "Sin mercado seleccionado",
    flow: [5, 15, 60].map(emptyFlow),
  };
  // A hidden/old selection cannot leak trades from another band or scope.
  if (!filters.ticker || !markets.some(m => m.ticker === filters.ticker)) return empty;
  if (filters.scope === "history") scoreQueue.request(filters.ticker);

  const since = explorerSince(filters.window, now);
  const condition = and(
    directionCondition,
    eq(kalshiAlertsTable.ticker, filters.ticker),
    range.minimumInclusive ? gte(kalshiAlertsTable.notional, range.minimum) : gt(kalshiAlertsTable.notional, range.minimum),
    range.maximum === null ? undefined : range.maximumInclusive
      ? lte(kalshiAlertsTable.notional, range.maximum) : lt(kalshiAlertsTable.notional, range.maximum),
    since ? gte(kalshiAlertsTable.createdTime, since) : undefined,
    lte(kalshiAlertsTable.createdTime, now),
  );
  const [totals, rows, job, flow] = await Promise.all([
    db.select({ total: count() }).from(kalshiAlertsTable).where(condition),
    db.select().from(kalshiAlertsTable).where(condition)
      .orderBy(desc(kalshiAlertsTable.createdTime), asc(kalshiAlertsTable.tradeId)).limit(5000),
    marketHistoryStore.job(filters.ticker),
    // Aggregate all stored executions, not the 5,000-row chart/page limit.
    Promise.all([5, 15, 60].map(async minutes => {
      const result = emptyFlow(minutes);
      const groups = await db.select({
        outcome: kalshiAlertsTable.outcomeSide, book: kalshiAlertsTable.bookSide,
        amount: sql<number>`coalesce(sum(${kalshiAlertsTable.notional}), 0)`,
        n: count(),
        largeAmount: sql<number>`coalesce(sum(case when ${kalshiAlertsTable.notional} > 10000 then ${kalshiAlertsTable.notional} else 0 end), 0)`,
        largeN: sql<number>`count(*) filter (where ${kalshiAlertsTable.notional} > 10000)`,
      }).from(kalshiAlertsTable).where(and(condition,
        gte(kalshiAlertsTable.createdTime, new Date(now.getTime() - minutes * 60_000))))
        .groupBy(kalshiAlertsTable.outcomeSide, kalshiAlertsTable.bookSide);
      for (const group of groups) {
        const direction = publicDirection(group.outcome, undefined, group.book);
        result[`${direction}Usd`] += Number(group.amount);
        result[`${direction}Count`] += Number(group.n);
        if (direction !== "unknown") {
          const prefix = direction === "yes" ? "largeYes" : "largeNo";
          result[`${prefix}Usd`] += Number(group.largeAmount);
          result[`${prefix}Count`] += Number(group.largeN);
        }
      }
      for (const key of ["yesUsd", "noUsd", "unknownUsd", "largeYesUsd", "largeNoUsd"] as const) {
        result[key] = Math.round(result[key] * 100) / 100;
      }
      result.balanceUsd = Math.round((result.yesUsd - result.noUsd) * 100) / 100;
      return result;
    })),
  ]);
  const totalTrades = totals[0]?.total ?? 0;
  let historyStatus = "Histórico pendiente; solo operaciones guardadas";
  if (job?.error) historyStatus = "Histórico incompleto; reintento pendiente";
  else if (job && (job.captureMinimum ?? 5_000) > CAPTURE_MINIMUM && filters.band === "small") {
    historyStatus = "Histórico de $1k–$5k pendiente de ampliar; solo operaciones guardadas";
  } else if (job?.phase === "complete") {
    historyStatus = `Histórico importado hasta ${job.snapshotAt.toISOString()}; actividad posterior según monitor`;
  } else if (job) historyStatus = "Histórico en proceso; datos parciales";
  return {
    ...empty, totalTrades, truncated: totalTrades > rows.length, historyStatus, flow,
    trades: rows.reverse().map(t => ({
      tradeId: t.tradeId, ticker: t.ticker,
      direction: publicDirection(t.outcomeSide, undefined, t.bookSide),
      price: t.price, count: t.count, notional: t.notional,
      createdTime: t.createdTime.toISOString(),
    })),
  };
}
