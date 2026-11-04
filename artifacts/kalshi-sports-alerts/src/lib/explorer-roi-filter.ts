import type { ExplorerMarket, ExplorerMarketRoi, ExplorerRoiSignal } from '@workspace/api-client-react';
import { groupMarkets } from './explorer-model.ts';

export type ExplorerOrder = 'time' | 'roi';
export type ExplorerDirection = 'all' | 'yes' | 'no';
export type RoiMatch = { market: ExplorerMarket; signal: ExplorerRoiSignal };
export type RankedExplorerGame = ReturnType<typeof groupMarkets>[number]['games'][number] & {
  sport: string;
  bestRoi: RoiMatch | null;
};
export type ExplorerSportGroup = { sport: string; games: RankedExplorerGame[]; trades: number };

export function minimumRoi(value: string): number | null {
  if (!value.trim()) return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

export function readExplorerRoiOptions(params: URLSearchParams): { order: ExplorerOrder; minRoi: string } {
  const min = minimumRoi(params.get('minRoi') ?? '');
  return { order: params.get('explorerOrder') === 'roi' ? 'roi' : 'time', minRoi: min === null ? '' : String(min) };
}

/** Unknown and insufficient evidence stay below even negative, verified returns. */
function compareMatches(a: RoiMatch | null, b: RoiMatch | null): number {
  if (!a || !b) return a ? -1 : b ? 1 : 0;
  return b.signal.roiPct! - a.signal.roiPct! ||
    b.signal.games - a.signal.games || b.signal.trades - a.signal.trades ||
    a.market.ticker.localeCompare(b.market.ticker) || a.signal.side.localeCompare(b.signal.side);
}

function bestMatch(matches: (RoiMatch | null)[]): RoiMatch | null {
  let best: RoiMatch | null = null;
  for (const match of matches) if (compareMatches(match, best) < 0) best = match;
  return best;
}

type Options = {
  order: ExplorerOrder;
  minimum: number | null;
  direction: ExplorerDirection;
  roiReady: boolean;
  minimumGames?: number;
  minimumTrades?: number;
};

/**
 * Operates only on the already band/scope/type/direction-filtered catalog.
 * Reuses exact comparable ROI groups; never averages sides, fills missing ROI
 * with zero, or makes a low-sample return a leaderboard candidate.
 */
export function buildExplorerList(
  markets: ExplorerMarket[], term: string, roi: ReadonlyMap<string, ExplorerMarketRoi>, options: Options,
) {
  const bestByTicker = new Map<string, RoiMatch | null>();
  for (const market of markets) {
    const signals = options.roiReady ? roi.get(market.ticker)?.signals ?? [] : [];
    const candidates = signals.filter(signal =>
      (options.direction === 'all' || signal.side === options.direction) &&
      signal.level !== 'insufficient' && signal.reason === null &&
      signal.roiPct !== null && Number.isFinite(signal.roiPct) &&
      signal.games >= (options.minimumGames ?? 50) && signal.trades >= (options.minimumTrades ?? 30),
    ).map(signal => ({ market, signal }));
    bestByTicker.set(market.ticker, bestMatch(candidates));
  }
  const filtered = options.minimum === null ? markets : markets.filter(market => {
    const match = bestByTicker.get(market.ticker);
    return match !== null && match !== undefined && match.signal.roiPct! >= options.minimum!;
  });
  const sports: ExplorerSportGroup[] = groupMarkets(filtered, term).map(sport => ({
    ...sport,
    games: sport.games.map(game => {
      const orderedMarkets = options.order === 'roi' ? [...game.markets].sort((a, b) =>
        compareMatches(bestByTicker.get(a.ticker) ?? null, bestByTicker.get(b.ticker) ?? null) ||
        b.trades - a.trades || a.ticker.localeCompare(b.ticker),
      ) : game.markets;
      return { ...game, markets: orderedMarkets, sport: sport.sport,
        bestRoi: bestMatch(orderedMarkets.map(market => bestByTicker.get(market.ticker) ?? null)) };
    }),
  }));
  // A single global game list, not sport blocks that could hide a better game.
  const rankedGames = sports.flatMap(sport => sport.games).sort((a, b) => {
    const aRoi = a.bestRoi?.signal.roiPct ?? null;
    const bRoi = b.bestRoi?.signal.roiPct ?? null;
    if (aRoi !== bRoi) return aRoi === null ? 1 : bRoi === null ? -1 : bRoi - aRoi;
    if (a.startsAt !== b.startsAt) return a.startsAt < b.startsAt ? -1 : 1;
    return a.name.localeCompare(b.name) || a.sport.localeCompare(b.sport) || a.key.localeCompare(b.key);
  });
  const games = options.order === 'roi' ? rankedGames : sports.flatMap(sport => sport.games);
  return { sports, rankedGames, markets: games.flatMap(game => game.markets), games: games.length };
}

/** Do not keep a hidden chart selected, or switch a paused chart during refresh. */
export function explorerSelection(
  ticker: string, catalog: ExplorerMarket[], visible: ExplorerMarket[], paused: boolean, waitingForRoi: boolean,
): string {
  if (paused) return ticker;
  if (waitingForRoi) return catalog.some(m => m.ticker === ticker) ? ticker : '';
  return visible.some(m => m.ticker === ticker) ? ticker : visible[0]?.ticker ?? '';
}
