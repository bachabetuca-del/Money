import assert from 'node:assert/strict';
import { test } from 'node:test';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ExplorerMarket, ExplorerMarketRoi, ExplorerRoiSignal } from '@workspace/api-client-react';
import { ExplorerCatalog, ExplorerRoiControls } from './explorer-catalog';
import { buildExplorerList } from '../lib/explorer-roi-filter';

const market = (ticker: string, sport: string): ExplorerMarket => ({
  ticker, sport, gameKey: ticker, gameName: `Partido ${ticker}`, gameDateLabel: '3 nov 2026',
  gameTimeLabel: '2:00 PM ET', gameStartsAt: '2026-11-03T19:00:00Z', betLabel: `Apuesta ${ticker}`,
  trades: 1, lastTradeAt: '2026-11-03T12:00:00Z', marketUrl: '', state: 'upcoming',
  gameResult: null, marketResult: null,
});
const signal = (roiPct: number, side: 'yes' | 'no'): ExplorerRoiSignal => ({
  side, roiPct, level: 'good', reason: null, games: 50, trades: 60, price: .5,
  observedAt: '2026-11-03T12:00:00Z', oddsMin: .5, oddsMax: .6,
  net: { roiPct: null, fees: null, profit: null, cashOutlay: null, coveredTrades: 0, missingTrades: 40 },
});
const markets = [market('LOW', 'Tennis'), market('HIGH', 'Soccer'), market('UNKNOWN', 'Tennis')];
const roi = new Map<string, ExplorerMarketRoi>([
  ['LOW', { ticker: 'LOW', signals: [signal(12, 'yes')] }],
  ['HIGH', { ticker: 'HIGH', signals: [signal(30, 'no')] }],
]);
const list = buildExplorerList(markets, '', roi, { order: 'roi', minimum: null, direction: 'all', roiReady: true });
const props = {
  sports: list.sports, rankedGames: list.rankedGames, order: 'roi' as const, showRoi: true,
  ticker: 'HIGH', query: '', scope: 'active' as const, direction: 'all' as const,
  roiView: (ticker: string) => ({ market: roi.get(ticker), loading: false, error: false }),
  onSelect: () => undefined,
};

test('controls expose an accessible order selector and optional numeric minimum', () => {
  const html = renderToStaticMarkup(<ExplorerRoiControls order="roi" minRoi="7" onChange={() => undefined} />);
  for (const text of ['Ordenar partidos', 'Mayor ROI · todos los deportes', 'Por deporte y hora', 'ROI bruto mínimo (%)', 'Quitar mínimo']) {
    assert.ok(html.includes(text), text);
  }
  assert.match(html, /value="roi" selected=""/);
  assert.match(html, /type="number".*step="any".*value="7"/);
  const blank = renderToStaticMarkup(<ExplorerRoiControls order="time" minRoi="" onChange={() => undefined} />);
  assert.match(blank, /placeholder="Sin mínimo"/);
  assert.doesNotMatch(blank, /Quitar mínimo/);
});

test('global game list shows the ranking, sport, exact side and market without opening details', () => {
  const html = renderToStaticMarkup(<ExplorerCatalog {...props} />);
  assert.ok(html.indexOf('Partido HIGH') < html.indexOf('Partido LOW'));
  assert.ok(html.indexOf('Partido LOW') < html.indexOf('Partido UNKNOWN'));
  for (const text of ['1. Fútbol', '2. Tenis', 'Mayor ROI bruto · NO · +30%', 'Apuesta HIGH', '3 nov 2026 · 2:00 PM ET', 'Sin ROI con muestra suficiente']) {
    assert.ok(html.includes(text), text);
  }
  assert.match(html, /data-testid="button-market-HIGH"/, 'selected game stays expanded');
  assert.doesNotMatch(html, /data-testid="button-sport-/);
});

test('standard tree preserves sport navigation, selection, current state and history scores', () => {
  const historyMarkets = markets.map(m => ({ ...m, state: 'finished' as const, gameResult: 'Local 2–1 Visitante' }));
  const history = buildExplorerList(historyMarkets, '', roi, { order: 'time', minimum: null, direction: 'all', roiReady: true });
  const html = renderToStaticMarkup(<ExplorerCatalog {...props} sports={history.sports} rankedGames={history.rankedGames} order="time" showRoi={false} scope="history" />);
  assert.match(html, /data-testid="button-sport-Soccer"/);
  assert.match(html, /data-testid="button-market-HIGH"/);
  assert.match(html, /aria-current="true"/);
  assert.match(html, /Finalizado/);
  assert.match(html, /Local 2–1 Visitante/);
  assert.doesNotMatch(html, /Mayor ROI bruto/);
});

test('a YES-only minimum cannot display or rank a market qualifying only on NO', () => {
  const filtered = buildExplorerList(markets, '', roi, { order: 'roi', minimum: 10, direction: 'yes', roiReady: true });
  const html = renderToStaticMarkup(<ExplorerCatalog {...props} sports={filtered.sports} rankedGames={filtered.rankedGames}
    direction="yes" ticker="LOW" />);
  assert.match(html, /Mayor ROI bruto · SÍ · \+12%/);
  assert.doesNotMatch(html, /Partido HIGH|Partido UNKNOWN|ROI bruto · NO/);
});
