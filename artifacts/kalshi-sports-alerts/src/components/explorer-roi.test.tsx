import assert from 'node:assert/strict';
import { test } from 'node:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { MarketRoiBadges, MarketRoiDetail, RoiColorLegend, type RoiView } from './explorer-roi';

const net = { roiPct: null, fees: null, profit: null, cashOutlay: null, coveredTrades: 0, missingTrades: 42 };
const view: RoiView = {
  loading: false, error: false, historyAsOf: '2026-10-31T10:00:00Z',
  market: {
    ticker: 'TEST',
    signals: [
      { side: 'yes', level: 'good', reason: null, roiPct: 15.5, trades: 42, games: 12, price: .5, observedAt: '2026-10-31T10:00:00Z', oddsMin: .5, oddsMax: .6, net },
      { side: 'no', level: 'bad', reason: null, roiPct: -12.4, trades: 65, games: 15, price: .25, observedAt: '2026-10-31T10:01:00Z', oddsMin: .2, oddsMax: .3, net: { ...net, missingTrades: 65 } },
    ],
  },
};
test('market labels show distinct YES and NO colors, percentages and accessible context', () => {
  const html = renderToStaticMarkup(<MarketRoiBadges view={view} direction="all" />);
  assert.match(html, /mr-good/);
  assert.match(html, /mr-bad/);
  assert.match(html, /SÍ · ROI bruto \+15\.5%/);
  assert.match(html, /NO · ROI bruto -12\.4%/);
  assert.match(html, /12 partidos distintos · 42 operaciones/);
  assert.match(html, /no cotización en vivo/);
  assert.match(html, /data-roi-side="no" data-roi-level="bad"/);
});
test('a selected side never displays the opposite side or its color', () => {
  const html = renderToStaticMarkup(<MarketRoiBadges view={view} direction="no" />);
  assert.match(html, /mr-bad/);
  assert.doesNotMatch(html, /mr-good|SÍ · ROI/);
});
test('loading, empty and refresh failure stay gray; cached success is not passed off as current', () => {
  for (const [state, label] of [
    [{ ...view, loading: true }, 'Cargando'],
    [{ ...view, error: true }, 'Sin actualizar'],
    [{ loading: false, error: false }, 'Sin referencia'],
  ] as const) {
    const html = renderToStaticMarkup(<MarketRoiBadges view={state} direction="all" />);
    assert.match(html, /mr-insufficient/);
    assert.ok(html.includes(label));
    assert.doesNotMatch(html, /mr-(?:good|bad)\b|15\.5%/);
  }
});
test('a high ROI on a small sample remains gray and explicitly qualified', () => {
  const small: RoiView = { ...view, market: { ticker: 'TEST', signals: [{
    ...view.market!.signals[0], level: 'insufficient', reason: 'small_sample', games: 2, trades: 5,
  }] } };
  const html = renderToStaticMarkup(<MarketRoiBadges view={small} direction="yes" />);
  assert.match(html, /mr-insufficient/);
  assert.match(html, /\+15\.5% · muestra baja/);
  assert.doesNotMatch(html, /mr-good/);
});
test('legend explains exact thresholds, sample gate and the difference from predictions', () => {
  const html = renderToStaticMarkup(<RoiColorLegend />);
  for (const text of ['Verde', 'Amarillo', 'Rojo', 'Gris', '≥ +10%', '50 partidos distintos', '30 operaciones', 'resolución oficial', 'probabilidad de ganar']) {
    assert.ok(html.includes(text), text);
  }
  assert.match(html, /0% a &lt; \+10%/);
  assert.match(html, /Rojo · &lt; 0%/);
  assert.match(html, /1 h \/ 24 h afecta a la gráfica/);
});
test('detail is readable without hovering and reports observed odds, samples and freshness', () => {
  const html = renderToStaticMarkup(<MarketRoiDetail view={view} direction="no" />);
  for (const text of ['15 partidos · 65 operaciones', '+400 a +233', '25¢', 'ET', 'Histórico calculado', 'bruto antes de comisiones', 'Neto estimado', 'no es el ROI de este partido', '0/65 con tarifa', 'No disponible']) {
    assert.ok(html.includes(text), text);
  }
  assert.doesNotMatch(html, /12 partidos|SÍ · ROI/);
});
