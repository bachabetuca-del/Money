import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ExplorerMarket, ExplorerMarketRoi, ExplorerRoiSignal } from '@workspace/api-client-react';
import { buildExplorerList, explorerSelection, minimumRoi, readExplorerRoiOptions } from './explorer-roi-filter.ts';

const market = (ticker: string, changes: Partial<ExplorerMarket> = {}): ExplorerMarket => ({
  ticker, gameKey: ticker, sport: 'Tennis', gameName: `Partido ${ticker}`, gameDateLabel: '3 nov 2026',
  gameStartsAt: '2026-11-03T19:00:00Z', gameTimeLabel: '2:00 PM ET', betLabel: 'Gana el local',
  trades: 1, lastTradeAt: '2026-11-03T12:00:00Z', marketUrl: '', state: 'upcoming',
  gameResult: null, marketResult: null, marketType: 'winner', ...changes,
});
const signal = (roiPct: number | null, changes: Partial<ExplorerRoiSignal> = {}): ExplorerRoiSignal => ({
  side: 'yes', level: roiPct === null ? 'insufficient' : roiPct < 0 ? 'bad' : roiPct < 10 ? 'medium' : 'good',
  reason: roiPct === null ? 'no_history' : null, roiPct, trades: 60, games: 50,
  price: 0.5, observedAt: '2026-11-03T12:00:00Z', oddsMin: 0.5, oddsMax: 0.6,
  net: { roiPct: null, fees: null, profit: null, cashOutlay: null, coveredTrades: 0, missingTrades: 40 },
  ...changes,
});
const references = (...entries: [string, ExplorerRoiSignal[]][]) =>
  new Map<string, ExplorerMarketRoi>(entries.map(([ticker, signals]) => [ticker, { ticker, signals }]));
const options = { order: 'roi' as const, minimum: null, direction: 'all' as const, roiReady: true };

test('ROI order is global across sports and markets, not activity or sport blocks', () => {
  const markets = [market('A', { trades: 100 }), market('B', { sport: 'Soccer' }), market('C', { trades: 1000 })];
  const roi = references(['A', [signal(30)]], ['B', [signal(20)]], ['C', [signal(10)]]);
  const list = buildExplorerList(markets, '', roi, options);
  assert.deepEqual(list.rankedGames.map(g => g.key), ['A', 'B', 'C']);
  assert.deepEqual(list.markets.map(m => m.ticker), ['A', 'B', 'C']);
  assert.equal(list.games, 3);
  assert.deepEqual(markets.map(m => m.ticker), ['A', 'B', 'C'], 'input catalog was not mutated');
});

test('the exact best market and side are retained; YES and NO never average together', () => {
  const markets = [market('WIN'), market('TOTAL', { gameKey: 'WIN', betLabel: 'Más de 22.5 juegos', marketType: 'total' })];
  const roi = references(['WIN', [signal(12), signal(-30, { side: 'no' })]],
    ['TOTAL', [signal(8), signal(25, { side: 'no', price: .4, oddsMin: .4, oddsMax: .5 })]]);
  const all = buildExplorerList(markets, '', roi, options);
  assert.equal(all.games, 1);
  assert.equal(all.rankedGames[0].bestRoi?.signal.roiPct, 25);
  assert.equal(all.rankedGames[0].bestRoi?.signal.side, 'no');
  assert.equal(all.rankedGames[0].bestRoi?.market.ticker, 'TOTAL');
  assert.deepEqual(all.markets.map(m => m.ticker), ['TOTAL', 'WIN']);
  const yes = buildExplorerList(markets, '', roi, { ...options, direction: 'yes' });
  assert.equal(yes.rankedGames[0].bestRoi?.market.ticker, 'WIN');
  assert.equal(yes.rankedGames[0].bestRoi?.signal.roiPct, 12);
  const no = buildExplorerList(markets, '', roi, { ...options, direction: 'no', minimum: 7 });
  assert.deepEqual(no.markets.map(m => m.ticker), ['TOTAL'], 'a YES return must not qualify a NO-filtered market');
  assert.equal(no.rankedGames[0].bestRoi?.signal.price, .4, 'NO price is not complemented');
});

test('minimum is inclusive, can be zero or negative, and removes nonqualifying sibling markets', () => {
  const markets = ['A', 'B', 'C', 'D'].map(t => market(t, { gameKey: 'SAME' }));
  const roi = references(['A', [signal(7)]], ['B', [signal(6.999)]], ['C', [signal(0)]], ['D', [signal(-2)]]);
  assert.deepEqual(buildExplorerList(markets, '', roi, { ...options, minimum: 7 }).markets.map(m => m.ticker), ['A']);
  assert.equal(buildExplorerList(markets, '', roi, { ...options, minimum: 0 }).markets.length, 3);
  assert.equal(buildExplorerList(markets, '', roi, { ...options, minimum: -2 }).markets.length, 4);
  assert.equal(buildExplorerList(markets, '', roi, { ...options, minimum: 50 }).games, 0);
});

test('missing, invalid, low-sample and failed ROI cannot lead or qualify as zero', () => {
  const markets = ['UNKNOWN', 'NEGATIVE', 'LOW', 'INVALID', 'FEW_GAMES', 'FEW_TRADES'].map(t => market(t));
  const roi = references(['NEGATIVE', [signal(-5)]],
    ['LOW', [signal(200, { level: 'insufficient', reason: 'small_sample', games: 2, trades: 5 })]],
    ['INVALID', [signal(Infinity)]], ['FEW_GAMES', [signal(500, { games: 9 })]],
    ['FEW_TRADES', [signal(500, { trades: 29 })]]);
  const list = buildExplorerList(markets, '', roi, options);
  assert.equal(list.rankedGames[0].key, 'NEGATIVE');
  assert.equal(list.rankedGames.filter(g => g.bestRoi).length, 1);
  assert.equal(buildExplorerList(markets, '', roi, { ...options, minimum: 0 }).games, 0);
  assert.equal(buildExplorerList(markets, '', roi, { ...options, minimum: -100, roiReady: false }).games, 0);
  assert.ok(buildExplorerList(markets, '', roi, { ...options, roiReady: false }).rankedGames.every(g => g.bestRoi === null));
});

test('search and server-filtered catalog restrict the best match; another type or band cannot leak in', () => {
  const low = market('WIN', { gameKey: 'SAME', betLabel: 'Gana el local' });
  const high = market('TOTAL', { gameKey: 'SAME', betLabel: 'Más de 22.5 juegos', marketType: 'total' });
  const roi = references(['WIN', [signal(7)]], ['TOTAL', [signal(60)]]);
  assert.equal(buildExplorerList([low], '', roi, options).rankedGames[0].bestRoi?.signal.roiPct, 7);
  const searched = buildExplorerList([low, high], 'GANA', roi, options);
  assert.equal(searched.rankedGames[0].bestRoi?.signal.roiPct, 7);
  assert.equal(buildExplorerList([low, high], 'GANA', roi, { ...options, minimum: 10 }).games, 0);
  assert.equal(buildExplorerList([low], '', new Map(), { ...options, minimum: 7 }).games, 0, 'no fallback to another money band');
});

test('ROI ties use actual kickoff then stable identity; the previous time order is unchanged', () => {
  const markets = [market('LATE', { gameStartsAt: '2026-11-03T23:00:00Z', trades: 100 }),
    market('EARLY', { gameStartsAt: '2026-11-03T15:00:00Z' }),
    market('UNKNOWN', { gameStartsAt: null })];
  const roi = references(...markets.map(m => [m.ticker, [signal(10)]] as [string, ExplorerRoiSignal[]]));
  assert.deepEqual(buildExplorerList(markets, '', roi, options).rankedGames.map(g => g.key), ['EARLY', 'LATE', 'UNKNOWN']);
  assert.deepEqual(buildExplorerList([...markets].reverse(), '', roi, options).rankedGames.map(g => g.key), ['EARLY', 'LATE', 'UNKNOWN']);
  assert.deepEqual(buildExplorerList(markets, '', roi, { ...options, order: 'time' }).sports[0].games.map(g => g.key), ['EARLY', 'LATE', 'UNKNOWN']);
});

test('refreshed ROI reorders current markets and applies the server sample policy', () => {
  const markets = [market('A'), market('B')];
  const first = references(['A', [signal(7)]], ['B', [signal(10)]]);
  const next = references(['A', [signal(15)]], ['B', [signal(10)]]);
  assert.equal(buildExplorerList(markets, '', first, options).markets[0].ticker, 'B');
  assert.equal(buildExplorerList(markets, '', next, options).markets[0].ticker, 'A');
  assert.equal(buildExplorerList(markets, '', next, { ...options, minimum: 7, minimumGames: 51 }).games, 0);
  assert.equal(buildExplorerList(markets, '', next, { ...options, minimum: 7, minimumTrades: 61 }).games, 0);
});

test('49 distinct games cannot qualify by default even with thousands of executions', () => {
  const roi = references(['A', [signal(40, { games: 49, trades: 5000 })]]);
  assert.equal(buildExplorerList([market('A')], '', roi, { ...options, minimum: 7 }).games, 0);
});

test('selection stays visible and stable across sorting, filters, empty results, reload and pause', () => {
  const all = [market('A'), market('B')];
  assert.equal(explorerSelection('A', all, [all[1], all[0]], false, false), 'A');
  assert.equal(explorerSelection('A', all, [all[1]], false, false), 'B');
  assert.equal(explorerSelection('A', all, [], false, false), '');
  assert.equal(explorerSelection('', all, [all[1]], false, false), 'B');
  assert.equal(explorerSelection('A', all, [], true, false), 'A', 'pause freezes the selected view');
  assert.equal(explorerSelection('A', all, [], false, true), 'A', 'loading ROI cannot block a current chart');
  assert.equal(explorerSelection('OUTSIDE', all, [], false, true), '', 'wrong-band selections are cleared while loading');
});

test('URL options survive remount/reload, preserve zero, and reject malformed numbers', () => {
  assert.deepEqual(readExplorerRoiOptions(new URLSearchParams('explorerOrder=roi&minRoi=7&lbSort=netRoi')), { order: 'roi', minRoi: '7' });
  assert.deepEqual(readExplorerRoiOptions(new URLSearchParams('explorerOrder=roi&minRoi=0')), { order: 'roi', minRoi: '0' });
  assert.deepEqual(readExplorerRoiOptions(new URLSearchParams('explorerOrder=bad&minRoi=Infinity')), { order: 'time', minRoi: '' });
  for (const value of ['', ' ', 'not-a-number', 'Infinity', 'NaN']) assert.equal(minimumRoi(value), null);
  assert.equal(minimumRoi('7.05'), 7.05);
  assert.equal(minimumRoi('-5'), -5);
});
