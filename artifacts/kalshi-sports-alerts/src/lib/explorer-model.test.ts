import assert from 'node:assert/strict';
import { test } from 'node:test';
import { bubbleRadius, buildBuckets, MINUTE, yesQuote } from './explorer-model.ts';
import type { ExplorerTrade } from '@workspace/api-client-react';

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
