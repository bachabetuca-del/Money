import assert from 'node:assert/strict';
import test from 'node:test';
import { buildTradePdf, tradePdfFilename, type TradePdfInput } from './trade-pdf.ts';

function input(count = 1): TradePdfInput {
  return {
    market: {
      ticker: 'KXTEST-GAME-YES', sport: 'Soccer', gameKey: 'GAME',
      gameName: 'Madrid vs Barcelona', gameDateLabel: '24 oct 2026', gameTimeLabel: '3:00 PM ET',
      betLabel: 'Madrid gana', marketUrl: 'https://kalshi.com/markets/kxtest',
      trades: count, lastTradeAt: '2026-10-24T19:00:00Z', state: 'finished',
      gameResult: 'Madrid 2-1 Barcelona', marketResult: null,
    },
    trades: Array.from({ length: count }, (_, i) => ({
      tradeId: `trade-unique-${i}`, ticker: 'KXTEST-GAME-YES', direction: i === 0 ? 'no' : i === 1 ? 'unknown' : 'yes',
      price: 0.48, count: 2500, notional: 1200, createdTime: '2026-10-24T19:00:00Z',
    })),
    bandLabel: '$1,000 a $5,000 (incluidos)', windowLabel: 'Todo lo guardado',
    scopeLabel: 'Historial', directionLabel: 'Todas', search: '',
    loadedCount: count, totalCount: count, truncated: false,
    historyStatus: 'Solo operaciones guardadas', generatedAt: '2026-10-24T19:00:00Z',
  };
}

test('generates a real PDF with market, final score, amounts and equivalent YES price', () => {
  const doc = buildTradePdf(input(2));
  const pdf = doc.output();
  assert.ok(pdf.startsWith('%PDF-'));
  for (const text of ['Madrid vs Barcelona', 'Madrid gana', 'Madrid 2-1 Barcelona', '$2,400.00', '48.00', '52.00', 'Sin dato', 'trade-unique-0', 'trade-unique-1']) {
    assert.ok(pdf.includes(text), `missing PDF content: ${text}`);
  }
  assert.ok(pdf.includes('https://kalshi.com/markets/kxtest'));
  assert.equal(doc.getNumberOfPages(), 1);
});

test('exports beyond the 100 visible rows, repeats headers, and flags partial coverage', () => {
  const data = input(250);
  data.truncated = true;
  data.totalCount = 6000;
  const doc = buildTradePdf(data);
  const pdf = doc.output();
  assert.ok(doc.getNumberOfPages() > 1);
  assert.ok(pdf.includes('trade-unique-249'));
  assert.ok(pdf.includes('PARCIAL'));
  assert.ok(pdf.includes('6,000'));
  assert.ok(pdf.includes('$300,000.00'));
  assert.ok((pdf.match(/Importe USD/g) ?? []).length >= doc.getNumberOfPages());
});

test('only exports the supplied filtered snapshot and sanitizes the download filename', () => {
  const data = input(3);
  data.trades = [data.trades[2]];
  data.directionLabel = 'A favor (SÍ)';
  data.search = 'trade-unique-2';
  const pdf = buildTradePdf(data).output();
  assert.ok(pdf.includes('trade-unique-2'));
  assert.ok(!pdf.includes('trade-unique-0'));
  assert.ok(!pdf.includes('trade-unique-1'));
  assert.ok(pdf.includes('$1,200.00'));
  assert.equal(tradePdfFilename('../GAME/YES', data.generatedAt), 'operaciones-___GAME_YES-2026-10-24.pdf');
});
