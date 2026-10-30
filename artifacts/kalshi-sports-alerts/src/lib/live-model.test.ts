import assert from 'node:assert/strict';
import { test } from 'node:test';
import { backoffMs, concentration, diffFresh, eventTickers, eventFreshIds, lastExecution, parseSse, pickFlow, viewSnapshot } from './live-model.ts';
import type { MarketFlowWindow } from '@workspace/api-client-react';

const w = (c: Partial<MarketFlowWindow>): MarketFlowWindow => ({
  minutes: 15, yesUsd: 0, noUsd: 0, unknownUsd: 0, yesCount: 0, noCount: 0, unknownCount: 0, balanceUsd: 0,
  largeYesCount: 0, largeNoCount: 0, largeYesUsd: 0, largeNoUsd: 0, ...c,
});

test('only explicitly tagged live IDs may highlight; recovered/imported IDs stay silent', () => {
  assert.deepEqual(eventFreshIds('{"tickers":["M"],"freshTradeIds":["new",42]}'), ['new']);
  assert.deepEqual(eventFreshIds('{"tickers":["M"]}'), []);
  assert.deepEqual(eventFreshIds('bad-json'), []);
  const baseline = diffFresh(null, 'M', ['old'], false);
  const next = diffFresh(baseline.seen, 'M', ['old', 'imported', 'new'], true);
  const allowed = new Set(eventFreshIds('{"freshTradeIds":["new"]}'));
  assert.deepEqual(next.fresh.filter(id => allowed.has(id)), ['new']);
});

test('parseSse handles comments, partial chunks and CRLF', () => {
  const a = parseSse(': keepalive\n\nevent: ready\ndata: {"tickers":[]}\n\nevent: trades\ndata: {"tick');
  assert.deepEqual(a.events, [{ event: 'ready', data: '{"tickers":[]}' }]);
  const b = parseSse(a.rest + 'ers":["K1"]}\r\n\r\n');
  assert.equal(b.events[0].event, 'trades');
  assert.deepEqual(eventTickers(b.events[0].data), ['K1']);
  assert.equal(b.rest, '');
  assert.deepEqual(eventTickers('nope'), []);
});

test('diffFresh: baseline, selection switch and non-live refetch never highlight', () => {
  let r = diffFresh(null, 'a', ['1', '2'], true);
  assert.deepEqual(r.fresh, []);
  r = diffFresh(r.seen, 'a', ['1', '2', '3'], false);
  assert.deepEqual(r.fresh, []);
  r = diffFresh(r.seen, 'a', ['1', '2', '3', '4'], true);
  assert.deepEqual(r.fresh, ['4']);
  r = diffFresh(r.seen, 'b', ['9'], true);
  assert.deepEqual(r.fresh, []);
});

test('viewSnapshot freezes while paused', () => {
  assert.equal(viewSnapshot(true, 'old', 'new'), 'old');
  assert.equal(viewSnapshot(false, 'old', 'new'), 'new');
  assert.equal(viewSnapshot(true, null, 'new'), 'new');
});

test('pause retains market metadata and trades when catalog refreshes, but never carries across filter changes', () => {
  const frozen = { key: 'A:large', market: { ticker: 'A', state: 'live' }, data: [1, 2], now: 100 };
  const expired = { key: 'A:large', market: undefined, data: [3], now: 200 };
  assert.equal(viewSnapshot(true, frozen, expired), frozen);
  assert.equal(viewSnapshot(false, frozen, expired), expired);
  const changed = { ...expired, key: 'A:small' };
  assert.equal(viewSnapshot(true, frozen, changed), changed);
  const differentMarket = { ...expired, key: 'B:large' };
  assert.equal(viewSnapshot(true, frozen, differentMarket), differentMarket);
});

test('concentration requires three large same-direction trades in large band', () => {
  const win = w({ largeYesCount: 3, largeYesUsd: 41250.5, largeNoCount: 2, largeNoUsd: 30000 });
  assert.deepEqual(concentration(win, 'large'), [{ dir: 'yes', count: 3, usd: 41250.5 }]);
  assert.deepEqual(concentration(win, 'medium'), []);
  assert.deepEqual(concentration(null, 'large'), []);
});

test('pickFlow, lastExecution and backoff', () => {
  assert.equal(pickFlow([w({ minutes: 5 }), w({ minutes: 60 })], 60)?.minutes, 60);
  assert.equal(pickFlow(undefined, 5), null);
  assert.equal(lastExecution(['2026-01-01T00:00:00Z', '2026-01-01T00:05:00Z']), Date.parse('2026-01-01T00:05:00Z'));
  assert.equal(lastExecution([]), null);
  assert.equal(backoffMs(0), 1000);
  assert.equal(backoffMs(20), 30000);
});
