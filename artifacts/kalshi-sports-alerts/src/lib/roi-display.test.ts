import assert from 'node:assert/strict';
import { test } from 'node:test';
import { americanOdds, americanOddsRange, oddsBoundaryText, roiSportLabel } from './roi-display.ts';

test('American odds match the reference bins without changing the underlying prices', () => {
  assert.equal(americanOddsRange(0.5, 0.6), '+100 a −150');
  assert.equal(americanOddsRange(0.4, 0.5), '+150 a +100');
  assert.equal(americanOddsRange(0.6, 0.7), '−150 a −233');
  assert.equal(americanOddsRange(0.2, 0.3), '+400 a +233');
  assert.equal(americanOdds(0.25), '+300');
  assert.equal(americanOdds(0.8), '−400');
});

test('extreme odds and invalid ranges are explicit, with no fake finite odds', () => {
  assert.equal(americanOddsRange(0, 0.1), '+∞ a +900');
  assert.equal(americanOddsRange(0.9, 1), '−900 a −∞');
  for (const price of [-1, 1.01, NaN, Infinity]) assert.equal(americanOdds(price), 'n/d');
  assert.equal(americanOddsRange(null, null), 'n/d');
  assert.equal(americanOddsRange(0.6, 0.5), 'n/d');
});

test('price interval explanations preserve half-open bins and the terminal endpoint', () => {
  assert.equal(oddsBoundaryText(0.5, 0.6), '50¢ ≤ precio del lado operado < 60¢');
  assert.equal(oddsBoundaryText(0, 0.1), '0¢ < precio del lado operado < 10¢');
  assert.equal(oddsBoundaryText(0.9, 1), '90¢ ≤ precio del lado operado ≤ 100¢');
});

test('Spanish sport names do not confuse soccer with American football', () => {
  assert.equal(roiSportLabel('Basketball'), 'Baloncesto');
  assert.equal(roiSportLabel('Soccer'), 'Fútbol');
  assert.equal(roiSportLabel('Football'), 'Fútbol americano');
  assert.equal(roiSportLabel('Tennis'), 'Tenis');
  assert.equal(roiSportLabel('New sport'), 'New sport');
});
