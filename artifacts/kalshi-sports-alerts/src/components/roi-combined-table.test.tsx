import assert from 'node:assert/strict';
import { test } from 'node:test';
import { renderToStaticMarkup } from 'react-dom/server';
import type { RoiRankingRow } from '@workspace/api-client-react';
import { RoiCombinedTable } from './roi-combined-table';

const row: RoiRankingRow = {
  id: 'test-segment', rank: 1, label: 'Test segment', sport: 'Basketball', marketType: 'total',
  side: 'no', marketUrl: null, oddsMin: 0.5, oddsMax: 0.6,
  trades: 41, wins: 29, losses: 12, games: 12, markets: 15, winRatePct: 70.73,
  profit: 1435, invested: 4100, roiPct: 35, recentRoiPct: 20, recentTrades: 10, sampleWarning: false,
};

test('the compact table has the seven reference columns and wins over total, not losses', () => {
  const html = renderToStaticMarkup(<RoiCombinedTable rows={[row]} />);
  assert.equal((html.match(/scope="col"/g) ?? []).length, 7);
  for (const name of ['Deporte', 'Mercado', 'Lado', 'Odds americanas', 'Aciertos', 'ROI', 'Muestras']) {
    assert.ok(html.includes(name));
  }
  assert.match(html, /Baloncesto/);
  assert.match(html, /Totales/);
  assert.match(html, />NO<\/span>/);
  assert.match(html, /\+100 a −150/);
  assert.match(html, />29<span class="lb-fraction">\/41<\/span>/);
  assert.match(html, /\+35\.0%/);
  assert.match(html, /aria-sort="descending"/);
  assert.match(html, /tabla desplazable/);
  assert.doesNotMatch(html, /data-testid="status-sample-/);
});

test('negative ROI, YES, sample caveats and unknown odds remain explicit', () => {
  const html = renderToStaticMarkup(<RoiCombinedTable rows={[{
    ...row, side: 'yes', wins: 0, losses: 41, roiPct: -100, sampleWarning: true,
    oddsMin: null, oddsMax: null,
  }]} />);
  assert.match(html, />YES<\/span>/);
  assert.match(html, /-100\.0%/);
  assert.match(html, /Muestra pequeña/);
  assert.match(html, />n\/d<\/td>/);
  assert.match(html, /no partidos independientes/);
});
