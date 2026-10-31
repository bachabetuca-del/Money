import assert from 'node:assert/strict';
import { test } from 'node:test';
import { renderToStaticMarkup } from 'react-dom/server';
import type { RoiRankingRow } from '@workspace/api-client-react';
import { RoiCombinedTable } from './roi-combined-table';
import { RoiRowBreakdown } from './roi-row-breakdown';
import { RoiAmountCompare } from './roi-amount-compare';

const row: RoiRankingRow = {
  id: 'test-segment', rank: 1, label: 'Test segment', sport: 'Basketball', marketType: 'total',
  side: 'no', moneyBand: null, marketUrl: null, oddsMin: 0.5, oddsMax: 0.6,
  trades: 41, wins: 29, losses: 12, games: 12, markets: 15, winRatePct: 70.73,
  profit: 1435, invested: 4100, roiPct: 35, recentRoiPct: 20, recentTrades: 10, sampleWarning: false,
  weekly: [
    { weekStart: '2025-01-06', trades: 30, games: 9, wins: 20, profit: -120, roiPct: -4, winRatePct: 66.7, partial: false, sampleWarning: false },
    { weekStart: '2025-01-13', trades: 0, games: 0, wins: 0, profit: 0, roiPct: null, winRatePct: null, partial: false, sampleWarning: true },
    { weekStart: '2025-01-20', trades: 11, games: 4, wins: 9, profit: 1555, roiPct: 141.4, winRatePct: 81.8, partial: true, sampleWarning: true },
  ],
  moneyBands: [
    { band: 'small', trades: 30, games: 10, wins: 22, profit: 900, roiPct: 30, winRatePct: 73.3, sampleWarning: false, meetsMinimum: true },
    { band: 'large', trades: 11, games: 5, wins: 7, profit: 535, roiPct: 48.6, winRatePct: 63.6, sampleWarning: true, meetsMinimum: false },
  ],
};

test('the compact table keeps seven columns and shows accuracy % and distinct games', () => {
  const html = renderToStaticMarkup(<RoiCombinedTable rows={[row]} />);
  assert.equal((html.match(/scope="col"/g) ?? []).length, 7);
  for (const name of ['Deporte', 'Mercado', 'Lado', 'Odds americanas', 'Aciertos', 'ROI', 'Muestras']) assert.ok(html.includes(name));
  assert.match(html, /Baloncesto/);
  assert.match(html, /Totales/);
  assert.match(html, />NO<\/span>/);
  assert.match(html, /\+100 a −150/);
  assert.match(html, />70\.7%</);
  assert.match(html, />29<span class="lb-fraction">\/41<\/span>/);
  assert.match(html, />12 partidos</);
  assert.match(html, /\+35\.0%/);
  assert.equal((html.match(/aria-sort="descending"/g) ?? []).length, 1);
  assert.match(html, /aria-expanded="false"/);
  assert.match(html, /aria-controls="lb-detail-[0-9a-f]+"/);
  assert.match(html, /tabla desplazable/);
  assert.doesNotMatch(html, /data-testid="status-sample-/);
});

test('winRate sort moves the sorted marker to Aciertos', () => {
  const html = renderToStaticMarkup(<RoiCombinedTable rows={[row]} sortBy="winRate" />);
  assert.match(html, /aria-sort="descending"><span class="lb-sort">Aciertos/);
  assert.match(html, /porcentaje de aciertos/);
});

test('soccer categories render readable names instead of the other bucket', () => {
  for (const [marketType, label] of [
    ['btts', 'Ambos equipos marcan'], ['correctScore', 'Marcador exacto'],
    ['qualification', 'Clasificación / Avance'], ['periodWinner', 'Ganador por período'],
    ['corners', 'Saques de esquina'], ['props', 'Estadísticas de jugadores'],
    ['futures', 'Campeonatos / Futuros'],
  ]) {
    const html = renderToStaticMarkup(<RoiCombinedTable rows={[{ ...row, sport: 'Soccer', marketType }]} />);
    assert.ok(html.includes(label), marketType);
    assert.ok(html.includes('Fútbol'));
    assert.doesNotMatch(html, /Otros \/ Sin clasificar/);
  }
});

test('negative ROI, YES, sample caveats and unknown odds remain explicit', () => {
  const html = renderToStaticMarkup(<RoiCombinedTable rows={[{
    ...row, side: 'yes', wins: 0, losses: 41, roiPct: -100, winRatePct: 0, sampleWarning: true, games: 1, oddsMin: null, oddsMax: null,
  }]} />);
  assert.match(html, />YES<\/span>/);
  assert.match(html, /-100\.0%/);
  assert.match(html, /Muestra pequeña/);
  assert.match(html, />n\/d<\/td>/);
  assert.match(html, />1 partido</);
  assert.match(html, /no partidos independientes/);
});

test('breakdown: newest week first, empty weeks say Sin datos, partial and negative preserved', () => {
  const html = renderToStaticMarkup(<RoiRowBreakdown row={row} minGames={10} />);
  assert.ok(html.indexOf('20 ene') < html.indexOf('06 ene'));
  assert.match(html, /20 ene 2025 – 26 ene 2025/);
  assert.match(html, /parcial · muestra pequeña/);
  assert.match(html, /-4\.0%/);
  assert.match(html, /-\$120/);
  assert.doesNotMatch(html, /13 ene 2025 – 19 ene 2025<small>/); // empty week: no sample flag
  assert.match(html, /row-week-test-segment-2025-01-13.*?Sin datos/);
  assert.doesNotMatch(html, />0\.0%</);
});

test('breakdown: medium band missing renders Sin datos, leaders and minimum flags shown', () => {
  const html = renderToStaticMarkup(<RoiRowBreakdown row={row} minGames={10} />);
  assert.match(html, /row-money-test-segment-medium.*?Sin datos/);
  assert.match(html, /mayor ROI observado/);
  assert.match(html, /mayor % observado/);
  assert.match(html, /bajo mínimo \(10\)/);
  // large (48.6% ROI) fails the minimum: it keeps its value and warning but gets no leader badge
  assert.match(html, /row-money-test-segment-large.*?48\.6%.*?bajo mínimo/);
  assert.doesNotMatch(html, /row-money-test-segment-large"[^]*?mayor ROI observado[^]*?<\/tr>/);
});

test('no leader badges when no band meets the minimum', () => {
  const html = renderToStaticMarkup(<RoiRowBreakdown row={{ ...row, moneyBands: row.moneyBands.map((m) => ({ ...m, meetsMinimum: false })) }} minGames={50} />);
  assert.doesNotMatch(html, /mayor (ROI|%) observado/);
  assert.match(html, /\+30\.0%/);
  assert.match(html, /no tamaño de apuesta sugerido/);
  assert.match(html, /no se suman/);
  assert.doesNotMatch(html, /rentable|fiable|segur/i);
});

test('amount compare names highest observed accuracy and ROI, missing bands are Sin datos', () => {
  const rows: RoiRankingRow[] = [
    { ...row, id: 'a-s', moneyBand: 'small', roiPct: -12.5, winRatePct: 58.2 },
    { ...row, id: 'a-l', moneyBand: 'large', roiPct: 8.1, winRatePct: 51 },
  ];
  const html = renderToStaticMarkup(<RoiAmountCompare data={{ rows, minGames: 10, band: 'all' }} />);
  assert.match(html, /aciertos observado: <b>\$1k–\$5k \(58\.2%\)/);
  assert.match(html, /ROI observado: <b class="pos">≥ \$10k \(\+8\.1%\)/);
  assert.match(html, /-12\.5%/);
  assert.match(html, /card-amount-medium.*?Sin datos/);
  const none = renderToStaticMarkup(<RoiAmountCompare data={{ rows: [], minGames: 1, band: 'large' }} />);
  assert.match(none, /excluido por el filtro de banda/);
});
