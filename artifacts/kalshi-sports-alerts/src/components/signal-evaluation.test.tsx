import assert from 'node:assert/strict';
import { test } from 'node:test';
import { renderToStaticMarkup } from 'react-dom/server';
import type { SignalEvaluation, SignalEvidence, SignalOutcome, SignalPerformance } from '@workspace/api-client-react';
import { Body, Row, EvidenceDetails } from './signal-evaluation';

const at = '2026-11-02T12:00:00.000Z';
const empty: SignalPerformance = {
  registered: 0, delivered: 0, awaitingDelivery: 0, skipped: 0, settled: 0, pending: 0, excluded: 0,
  games: 0, settledGames: 0, wins: 0, losses: 0, grossProfit: null, grossRoiPct: null, invested: 0,
  netProfit: null, netRoiPct: null, netOutlay: null, feeCovered: 0, feeMissing: 0,
};
const data: SignalEvaluation = {
  generatedAt: at, activatedAt: null, recording: 'not_started', firstSignalAt: null, lastSignalAt: null,
  lastSettlementCheckAt: null, summary: empty, cohorts: [], rows: [], page: 1, pageSize: 25, totalPages: 0,
  limitations: ['Precio observado no ejecutable garantizado. No prueba rentabilidad futura.'],
};
const evidence: SignalEvidence = {
  tradeId: 'frozen', ticker: 'TEST', gameId: 'shared-game', gameIdentity: 'milestone', eventTitle: 'Team A vs B',
  marketTitle: 'Team A wins', marketUrl: 'https://kalshi.com/markets/test', observedAt: at, queuedAt: at, capturedAt: at,
  price: .1234, notional: 5000.0001, contracts: 10000,
  rule: { version: 'rule-fixture', basis: 'gross', minimumRoiPct: 7, minimumGames: 10, minimumTrades: 30,
    coverage: 'verified', window: 'all', sport: 'Football', marketType: 'winner', side: 'no', moneyBand: 'medium',
    amountMin: 5000, amountMax: 10000, amountMinInclusive: false, amountMaxInclusive: false,
    oddsMin: .1, oddsMax: .2, stakeUsd: 100 },
  historyAsOf: at, historicalRoiPct: 15, historicalGrossRoiPct: 15, historicalNetRoiPct: null,
  historicalGames: 12, historicalTrades: 42,
  feeModel: { version: 'frozen-cost-model', documentationReviewedOn: '2026-11-02', scheduleAsOf: null,
    validUntil: null, status: 'unavailable', sources: [] },
  feeAssumptions: 'Supuestos originales', feeType: null, feeMultiplier: null, entryFeeUsd: null,
};
const row: SignalOutcome = {
  evidence, delivery: 'pending', sentAt: null, attempts: 1, status: 'not_sent', exclusionReason: null,
  officialResult: null, settlementCheckedAt: null, settlementError: null,
  grossProfit: null, grossRoiPct: null, netProfit: null, netRoiPct: null,
};
const render = (value: SignalEvaluation) => renderToStaticMarkup(<Body data={value} stale={false} setPage={() => {}} />);

test('not-started is honest, has no invented activation and exposes no action to enable development workers', () => {
  const html = render(data);
  for (const expected of ['Registro no iniciado', 'Aún no hay fecha de inicio', 'Sin liquidados',
    'No se importan avisos anteriores', 'Precio observado no ejecutable', 'no el tamaño de la operación observada']) {
    assert.ok(html.includes(expected), expected);
  }
  assert.doesNotMatch(html, /Registrando|Activar evaluación|0\.0%/);
});
test('paused state keeps the original evaluation period and reports fees, correlation and small sample', () => {
  const summary = { ...empty, registered: 4, delivered: 3, awaitingDelivery: 1, settled: 2, pending: 1,
    games: 1, settledGames: 1, wins: 1, losses: 1, grossProfit: 100, grossRoiPct: 50, invested: 200,
    feeCovered: 1, feeMissing: 1 };
  const html = render({ ...data, recording: 'paused', activatedAt: at, summary });
  for (const expected of ['Registro en pausa', 'Inicio de la evaluación', 'Desconocido', 'Faltan tarifas en 1',
    'Muestra pequeña', 'Avisos correlacionados', 'no son observaciones independientes', '+50.0%']) {
    assert.ok(html.includes(expected), expected);
  }
  assert.doesNotMatch(html, /No se están registrando señales nuevas aquí.*Aún no hay fecha de inicio/);
});
test('pending, skipped and excluded alerts never display simulated losses or pretend to be settled', () => {
  for (const candidate of [
    row, { ...row, status: 'pending' as const, delivery: 'sent' as const, sentAt: at },
    { ...row, delivery: 'skipped' as const },
    { ...row, status: 'excluded' as const, exclusionReason: 'unsupported_settlement' as const },
  ]) {
    const html = renderToStaticMarkup(<table><tbody><Row r={candidate} /></tbody></table>);
    assert.ok(html.includes('No es resultado'));
    assert.ok(html.includes('12.34¢'), 'Do not round away the original observed sub-cent price');
    assert.doesNotMatch(html, /-100|-$100|Liquidado<\/span>/);
  }
});
test('original evidence exposes rule, exact amount boundaries, historical sample and frozen fee assumptions', () => {
  const html = renderToStaticMarkup(<EvidenceDetails r={row} />);
  for (const expected of ['rule-fixture', 'ROI bruto ≥ +7.0%', '12 partidos · 42 operaciones', '12.34¢',
    '$5,000.0001', 'límite superior excluido', 'frozen-cost-model', 'Desconocida (no es cero)',
    'Supuestos originales', 'NO', 'Observada · en cola · capturada']) assert.ok(html.includes(expected), expected);
});
test('pagination and version groups use aggregate server totals, and unknown group net stays unknown', () => {
  const summary = { ...empty, registered: 30, delivered: 30, settled: 30, games: 10, settledGames: 10,
    grossRoiPct: 8, grossProfit: 240, invested: 3000, feeMissing: 30 };
  const value = { ...data, recording: 'active' as const, activatedAt: at, summary, rows: [row],
    totalPages: 2, cohorts: [{ ruleVersion: 'one', basis: 'gross' as const, feeModelVersion: 'fixed', performance: summary }] };
  const html = render(value);
  assert.match(html, /Página 1 de 2/);
  assert.match(html, /Grupos por regla/);
  assert.match(html, /Desconocido/);
  assert.match(html, /text-registered">30/);
  const stale = renderToStaticMarkup(<Body data={value} stale setPage={() => {}} />);
  assert.match(stale, /Cargando página/);
  assert.match(stale, /disabled=""[^>]*data-testid="button-signals-next"/);
});
