import type { RoiCoverage, RoiRankingRow, RoiLeaderboard } from "@workspace/api-zod";
import { marketType, type MarketType } from "./market-type";
import {
  accumulatePerformance, moneyPerformance, weeklyPerformance, roiPct, ROI_STAKE,
  ROI_MONEY_LABELS, type RoiMoneyBand, type PerformanceTotals,
} from "./roi-performance";

export { ROI_STAKE } from "./roi-performance";
export type RoiGroup = RoiLeaderboard["groupBy"];
export type RoiSort = RoiLeaderboard["sortBy"];
export const ROI_TYPE_LABELS: Record<MarketType, string> = {
  winner: "Ganador / Moneyline", spread: "Hándicap / Spread", total: "Totales",
  periodWinner: "Ganador por período", btts: "Ambos equipos marcan", correctScore: "Marcador exacto",
  qualification: "Clasificación / Avance", corners: "Saques de esquina",
  props: "Estadísticas de jugadores", futures: "Campeonatos / Futuros", other: "Otros / Sin clasificar",
};

/** One DB aggregate, not one observation per independent bettor or game. */
export type RoiRollup = {
  ticker: string; sport: string; eventTitle: string | null; marketTitle: string | null;
  gameId: string; marketUrl: string; bucket: number; side: "yes" | "no" | "unknown";
  moneyBand: RoiMoneyBand; weekStart: string;
  category: "settled" | "pending" | "excluded" | "incomplete";
  historyVerified?: boolean; historyError?: boolean;
  trades: number; wins: number; profit: number; recentTrades: number; recentProfit: number;
  firstAt: string; lastAt: string; checkedAt: string | null; error: boolean;
};
const rounded = (n: number, precision = 2) => Number(n.toFixed(precision));

export function oddsBucket(price: number) {
  if (!Number.isFinite(price) || price <= 0 || price > 1) return null;
  return Math.min(9, Math.floor(price * 10));
}
export function hypotheticalProfit(price: number, side: string, result: string) {
  if (oddsBucket(price) === null || !["yes", "no"].includes(side) || !["yes", "no"].includes(result)) return null;
  return side === result ? ROI_STAKE * (1 / price - 1) : -ROI_STAKE;
}
function bucketLabel(bucket: number) {
  return `${bucket * 10}–${(bucket + 1) * 10}¢${bucket === 9 ? " inclusive" : " · límite superior excluido"}`;
}

type Accumulator = {
  id: string; label: string; sport: string | null; marketType: string | null;
  side: "yes" | "no" | null;
  moneyBand: RoiMoneyBand | null;
  marketUrl: string | null; oddsMin: number | null; oddsMax: number | null;
  trades: number; wins: number; profit: number; recentTrades: number; recentProfit: number;
  games: Set<string>; markets: Set<string>;
  weeks: Map<string, PerformanceTotals>; amounts: Map<string, PerformanceTotals>;
};

/** Ranking operates on all saved aggregates, never the graph's 5,000-row sample. */
export function buildRoiRanking(
  rollups: RoiRollup[], groupBy: RoiGroup, minGames: number,
  options: { sortBy?: RoiSort; now?: Date; since?: Date | null } = {},
) {
  const now = options.now ?? new Date();
  const groups = new Map<string, Accumulator>();
  const settledMarkets = new Set<string>(), pendingMarkets = new Set<string>();
  const games = new Set<string>(), errorMarkets = new Set<string>();
  const verifiedHistory = new Set<string>(), incompleteHistory = new Set<string>(), historyErrors = new Set<string>();
  let historyExcludedTrades = 0;
  let savedTrades = 0, settledTrades = 0, pendingTrades = 0, excludedTrades = 0;
  let profit = 0, recentTrades = 0, recentProfit = 0;
  let firstTradeAt: string | null = null, lastTradeAt: string | null = null, lastSettlementCheckAt: string | null = null;
  for (const r of rollups) {
    savedTrades += r.trades;
    (r.historyVerified ? verifiedHistory : incompleteHistory).add(r.ticker);
    if (r.historyError) historyErrors.add(r.ticker);
    if (!firstTradeAt || r.firstAt < firstTradeAt) firstTradeAt = r.firstAt;
    if (!lastTradeAt || r.lastAt > lastTradeAt) lastTradeAt = r.lastAt;
    if (r.checkedAt && (!lastSettlementCheckAt || r.checkedAt > lastSettlementCheckAt)) lastSettlementCheckAt = r.checkedAt;
    if (r.category === "excluded") { excludedTrades += r.trades; continue; }
    if (r.category === "incomplete") {
      excludedTrades += r.trades; historyExcludedTrades += r.trades; continue;
    }
    if (r.category === "pending") {
      pendingTrades += r.trades; pendingMarkets.add(r.ticker);
      if (r.error) errorMarkets.add(r.ticker);
      continue;
    }
    settledTrades += r.trades; profit += r.profit;
    recentTrades += r.recentTrades; recentProfit += r.recentProfit;
    settledMarkets.add(r.ticker); games.add(r.gameId);
    const type = marketType(r);
    const id = groupBy === "sport" ? r.sport : groupBy === "marketType" ? type :
      groupBy === "odds" ? String(r.bucket) : groupBy === "market" ? r.ticker :
      groupBy === "amount" ? r.moneyBand :
      JSON.stringify([r.sport, type, r.side, r.bucket]);
    let group = groups.get(id);
    if (!group) {
      group = {
        id, label: groupBy === "sport" ? r.sport :
          groupBy === "marketType" ? ROI_TYPE_LABELS[type] :
          groupBy === "odds" ? bucketLabel(r.bucket) :
          groupBy === "market" ? `${r.eventTitle ?? r.ticker} · ${r.marketTitle ?? r.ticker}` :
          groupBy === "amount" ? ROI_MONEY_LABELS[r.moneyBand] :
          `${r.sport} · ${ROI_TYPE_LABELS[type]} · ${r.side.toUpperCase()} · ${bucketLabel(r.bucket)}`,
        sport: ["sport", "segment", "market"].includes(groupBy) ? r.sport : null,
        marketType: ["marketType", "segment", "market"].includes(groupBy) ? type : null,
        side: r.side === "yes" || r.side === "no" ? r.side : null,
        moneyBand: r.moneyBand,
        marketUrl: groupBy === "market" ? r.marketUrl : null,
        oddsMin: ["odds", "segment"].includes(groupBy) ? r.bucket / 10 : null,
        oddsMax: ["odds", "segment"].includes(groupBy) ? (r.bucket + 1) / 10 : null,
        trades: 0, wins: 0, profit: 0, recentTrades: 0, recentProfit: 0,
        games: new Set(), markets: new Set(),
        weeks: new Map(), amounts: new Map(),
      };
      groups.set(id, group);
    }
    if (group.side !== r.side) group.side = null;
    if (group.moneyBand !== r.moneyBand) group.moneyBand = null;
    group.trades += r.trades; group.wins += r.wins; group.profit += r.profit;
    group.recentTrades += r.recentTrades; group.recentProfit += r.recentProfit;
    group.games.add(r.gameId); group.markets.add(r.ticker);
    accumulatePerformance(group.weeks, r.weekStart, r);
    accumulatePerformance(group.amounts, r.moneyBand, r);
  }
  const rows: RoiRankingRow[] = [...groups.values()].filter(g => g.games.size >= minGames)
    .sort((a, b) => (options.sortBy === "winRate" ? b.wins / b.trades - a.wins / a.trades : 0) ||
      b.profit / b.trades - a.profit / a.trades ||
      b.games.size - a.games.size || b.trades - a.trades || a.id.localeCompare(b.id))
    .map((g, i) => ({
      id: g.id, rank: i + 1, label: g.label, sport: g.sport, marketType: g.marketType, side: g.side, moneyBand: g.moneyBand,
      marketUrl: g.marketUrl, oddsMin: g.oddsMin, oddsMax: g.oddsMax,
      trades: g.trades, games: g.games.size, markets: g.markets.size,
      wins: g.wins, losses: g.trades - g.wins, winRatePct: rounded(100 * g.wins / g.trades),
      roiPct: roiPct(g.profit, g.trades)!, profit: rounded(g.profit), invested: g.trades * ROI_STAKE,
      recentRoiPct: roiPct(g.recentProfit, g.recentTrades), recentTrades: g.recentTrades,
      sampleWarning: g.games.size < 10 || g.trades < 30,
      weekly: weeklyPerformance(g.weeks, now, options.since ?? null),
      moneyBands: moneyPerformance(g.amounts, minGames),
    }));
  const summary: RoiCoverage = {
    savedTrades, settledTrades, pendingTrades, excludedTrades, settledMarkets: settledMarkets.size,
    pendingMarkets: pendingMarkets.size, games: games.size, roiPct: roiPct(profit, settledTrades),
    profit: rounded(profit), recentRoiPct: roiPct(recentProfit, recentTrades), recentTrades,
    firstTradeAt: firstTradeAt ? new Date(firstTradeAt) : null,
    lastTradeAt: lastTradeAt ? new Date(lastTradeAt) : null,
    lastSettlementCheckAt: lastSettlementCheckAt ? new Date(lastSettlementCheckAt) : null,
    settlementErrors: errorMarkets.size,
    verifiedHistoryMarkets: verifiedHistory.size, incompleteHistoryMarkets: incompleteHistory.size,
    historyErrorMarkets: historyErrors.size, historyExcludedTrades,
  };
  return { rows, summary };
}
