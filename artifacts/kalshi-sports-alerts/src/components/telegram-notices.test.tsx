import assert from 'node:assert/strict';
import { test } from 'node:test';
import { renderToStaticMarkup } from 'react-dom/server';
import type { TelegramNotice, TelegramNotices } from '@workspace/api-client-react';
import { NoticeCard, NoticesBody } from './telegram-notices';
import { priceCents, roiView, sportName, usd } from '../lib/notice-format';

const at = '2026-11-02T23:30:00.000Z';
const base: TelegramNotice = {
  tradeId: 't1', ticker: 'KXNFLGAME-26NOV02-NYG', sport: 'football', eventTitle: 'New York Giants vs Dallas Cowboys',
  marketTitle: 'Giants ganan', side: 'no', price: 0.23, contracts: 21739, notional: 5000, executedAt: at, sentAt: at,
  marketUrl: 'https://kalshi.com/markets/kxnflgame', removedFromTelegram: true, detailsSource: 'frozen',
  roi: { basis: 'gross', roiPct: 12.4, grossRoiPct: 12.4, netRoiPct: null, games: 14, trades: 37, historyAsOf: at, capturedAt: at },
};

test('NO price keeps original selected side price', () => {
  assert.equal(priceCents(0.23), '23¢');
  assert.equal(priceCents(0.5865), '58.65¢');
  assert.equal(usd(1250.87), '$1,250.87');
  const html = renderToStaticMarkup(<NoticeCard notice={base} />);
  assert.match(html, /NO<\/em> a 23¢/);
  assert.doesNotMatch(html, /77¢/);
  assert.match(html, /New York Giants vs Dallas Cowboys/);
  assert.match(html, /Fútbol americano/);
  assert.equal(sportName('Soccer'), 'Fútbol');
  assert.match(html, /ET/);
});

test('ROI gross / net / unknown labels', () => {
  const g = roiView(base.roi);
  assert.equal(g.label, 'ROI histórico bruto');
  assert.match(g.other ?? '', /desconocido/);
  const n = roiView({ ...base.roi!, basis: 'net', roiPct: 8, netRoiPct: 8 });
  assert.equal(n.label, 'ROI histórico neto estimado');
  assert.match(n.other ?? '', /Bruto: \+12,4%/);
  assert.equal(roiView(null).headline, 'ROI no registrado');
});

test('missing fields render honestly', () => {
  const html = renderToStaticMarkup(<NoticeCard notice={{ ...base, side: 'unknown', price: null, contracts: null, notional: null, executedAt: null, marketUrl: 'https://evil.example/x', roi: null, detailsSource: 'legacy' }} />);
  assert.match(html, /ROI no registrado/);
  assert.match(html, /Precio no registrado/);
  assert.match(html, /Sin enlace de mercado/);
  assert.doesNotMatch(html, /evil\.example/);
  assert.doesNotMatch(html, />\+?0[,.]0%</);
});

test('distinct empty states', () => {
  const d: TelegramNotices = { generatedAt: at, workersPaused: false, chatConfigured: false, page: 1, pageSize: 25, total: 0, totalPages: 0, totalDelivered: 0, availableSports: [], rows: [] };
  assert.match(renderToStaticMarkup(<NoticesBody data={d} filtered={false} onClear={() => {}} />), /no está vinculado/);
  assert.match(renderToStaticMarkup(<NoticesBody data={{ ...d, chatConfigured: true }} filtered={false} onClear={() => {}} />), /Aún no hay avisos/);
  assert.match(renderToStaticMarkup(<NoticesBody data={d} filtered onClear={() => {}} />), /Ningún aviso coincide/);
});
