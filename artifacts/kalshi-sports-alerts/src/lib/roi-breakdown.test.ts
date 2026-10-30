import assert from 'node:assert/strict';
import { test } from 'node:test';
import { bandLeaders, domId, ratePct, weekRange } from './roi-breakdown.ts';

test('null rates are Sin datos, never 0%', () => {
  assert.equal(ratePct(null), 'Sin datos');
  assert.equal(ratePct(Number.NaN), 'Sin datos');
  assert.equal(ratePct(0), '0.0%');
  assert.equal(ratePct(-3.25).startsWith('-'), true);
  assert.equal(ratePct(5, true).startsWith('+'), true);
});

test('weekRange spans Monday to Sunday across months/years', () => {
  assert.equal(weekRange('2024-12-30'), '30 dic 2024 – 05 ene 2025');
  assert.equal(weekRange('2025-01-06'), '06 ene 2025 – 12 ene 2025');
  assert.notEqual(weekRange('2024-01-01'), weekRange('2025-01-06'));
  assert.equal(weekRange('bad'), 'bad');
});

test('bandLeaders ignores empty bands and returns ties', () => {
  const l = bandLeaders([
    { band: 'small', roiPct: -5, winRatePct: 60, trades: 10 },
    { band: 'medium', roiPct: null, winRatePct: null, trades: 0 },
    { band: 'large', roiPct: -2, winRatePct: 60, trades: 4 },
  ]);
  assert.deepEqual(l.roi, { value: -2, bands: ['large'] });
  assert.deepEqual(l.winRate?.bands, ['small', 'large']);
  assert.deepEqual(bandLeaders([]), { roi: null, winRate: null });
});

test('under-minimum bands never outrank eligible ones; none eligible means no leader', () => {
  const l = bandLeaders([
    { band: 'small', roiPct: 90, winRatePct: 100, trades: 2, meetsMinimum: false },
    { band: 'large', roiPct: 12, winRatePct: 80, trades: 40, meetsMinimum: true },
  ]);
  assert.deepEqual(l.winRate, { value: 80, bands: ['large'] });
  assert.deepEqual(l.roi, { value: 12, bands: ['large'] });
  assert.deepEqual(bandLeaders([{ band: 'small', roiPct: 5, winRatePct: 100, trades: 3, meetsMinimum: false }]), { roi: null, winRate: null });
});

test('domId encodes whitespace and JSON characters', () => {
  const id = domId('lb-detail', '["Combat Sports","winner"]');
  assert.match(id, /^lb-detail-[0-9a-f]+$/);
  assert.notEqual(id, domId('lb-detail', '["Combat Sports","total"]'));
});
