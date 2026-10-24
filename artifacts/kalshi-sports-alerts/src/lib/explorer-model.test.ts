import assert from 'node:assert/strict';
import { test } from 'node:test';
import { bubbleRadius, buildBuckets, groupMarkets, MINUTE, yesQuote } from './explorer-model.ts';
import type { ExplorerMarket, ExplorerTrade } from '@workspace/api-client-react';

const market = (key: string, startsAt: string | null, changes: Partial<ExplorerMarket> = {}): ExplorerMarket => ({
  ticker: key, sport: 'Tennis', gameKey: key, gameName: key, gameDateLabel: '24 oct 2026',
  gameTimeLabel: 'Hora por confirmar', gameStartsAt: startsAt, betLabel: 'Gana',
  marketUrl: '', trades: 1, lastTradeAt: '2026-10-24T20:00:00Z', state: 'upcoming',
  gameResult: null, marketResult: null, ...changes,
});

test('games sort by actual kickoff across dates, not activity, volume or formatted AM/PM', () => {
  const result = groupMarkets([
    market('Tomorrow', '2026-10-25T12:00:00Z', { trades: 900 }),
    market('Evening', '2026-10-24T23:00:00Z', { gameTimeLabel: '7:00 PM ET' }),
    market('Noon', '2026-10-24T16:00:00Z', { lastTradeAt: '2026-10-24T19:59:00Z', gameTimeLabel: '12:00 PM ET' }),
    market('Morning', '2026-10-24T13:00:00Z', { lastTradeAt: '2026-10-24T10:00:00Z', gameTimeLabel: '9:00 AM ET' }),
  ], '');
  assert.deepEqual(result[0].games.map(g => g.key), ['Morning', 'Noon', 'Evening', 'Tomorrow']);
  assert.equal(result[0].trades, 903);
});

test('unknown kickoff comes last with stable ties and valid sibling schedule takes precedence', () => {
  const rows = [
    market('Unknown', null), market('Invalid', 'invalid'),
    market('B', '2026-10-24T14:00:00Z'), market('A', '2026-10-24T14:00:00Z'),
    market('Sibling', null),
    market('Sibling', '2026-10-24T13:00:00Z', { ticker: 'Sibling-NO', gameTimeLabel: '9:00 AM ET' }),
  ];
  const games = groupMarkets(rows, '')[0].games;
  assert.deepEqual(games.map(g => g.key), ['Sibling', 'A', 'B', 'Invalid', 'Unknown']);
  assert.ok(games[0].date.endsWith('9:00 AM ET'));
  assert.equal(games[0].markets.length, 2);
  assert.deepEqual(groupMarkets([...rows].reverse(), '')[0].games.map(g => g.key), games.map(g => g.key));
  assert.deepEqual(groupMarkets(rows, 'sibling')[0].games.map(g => g.key), ['Sibling']);
});

test('kickoff order respects timestamp offsets around daylight saving and preserves sport grouping', () => {
  const games = groupMarkets([
    market('Later', '2026-11-01T01:15:00-05:00'),
    market('Earlier', '2026-11-01T01:45:00-04:00'),
    market('Soccer game', '2026-10-24T13:00:00Z', { sport: 'Soccer', trades: 20 }),
  ], '');
  assert.equal(games[0].sport, 'Soccer');
  assert.deepEqual(games[1].games.map(g => g.key), ['Earlier', 'Later']);
  assert.deepEqual(groupMarkets([], ''), []);
});

const now = Date.parse('2026-10-23T15:00:00Z');
const trade = (age: number, direction: ExplorerTrade['direction'] = 'yes', notional = 12_500): ExplorerTrade => ({
  tradeId: `${age}-${direction}`, ticker: 'TEST', direction, price: 0.8,
  count: notional / 0.8, notional, createdTime: new Date(now - age * MINUTE).toISOString(),
});

test('price comparison normalizes NO to YES without inventing unknown outcomes', () => {
  assert.equal(yesQuote(trade(0, 'yes')), 0.8);
  assert.ok(Math.abs(yesQuote(trade(0, 'no'))! - 0.2) < 1e-10);
  assert.equal(yesQuote(trade(0, 'unknown')), null);
});

test('bucket totals include every outcome and retain elapsed-time gaps', () => {
  const data = [trade(20, 'yes', 10000), trade(0, 'no', 6000), trade(0, 'unknown', 7000)];
  const result = buildBuckets(data, now, true);
  assert.equal(result.buckets.reduce((n, b) => n + b.total, 0), 23000);
  assert.equal(result.buckets.reduce((n, b) => n + b.n, 0), 3);
  assert.equal(result.buckets.length, 21);
  assert.equal(result.buckets.filter(b => b.n === 0).length, 19);
  assert.equal(result.recentCount, 2);
  assert.equal(result.recentSum, 13000);
  assert.equal(data[0].notional, 10000);
});

test('recency is based on execution time, inclusive at 15 minutes, never future', () => {
  const data = [trade(15), trade(15.001), trade(-1)];
  assert.equal(buildBuckets(data, now, true).recentCount, 1);
  assert.equal(buildBuckets(data, now, false).recentCount, 0);
  assert.equal(buildBuckets([], now, true).buckets.length, 0);
});

test('bubble size represents trade size instead of recency', () => {
  assert.ok(Math.abs(bubbleRadius(360) / bubbleRadius(40) - 3) < 1e-10);
});
