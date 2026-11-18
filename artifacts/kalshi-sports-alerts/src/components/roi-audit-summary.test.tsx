import test from 'node:test';
import assert from 'node:assert/strict';
import { renderToStaticMarkup } from 'react-dom/server';
import { RoiAuditSummary } from './roi-audit-summary';

test('historical audit shows unavailable costs/uncertainty honestly and does not claim validation', () => {
  const html = renderToStaticMarkup(<RoiAuditSummary audit={{
    firstAt: '2026-10-01T10:00:00Z', lastAt: '2026-11-10T10:00:00Z',
    largestGameSharePct: 25, withoutBestGameRoiPct: -12,
    grossLower95Pct: null, grossUpper95Pct: null,
    earlierGames: 3, laterGames: 1, earlierRoiPct: 20, laterRoiPct: -100,
    chronologicalCutoff: '2026-11-01T10:00:00Z',
  }} />);
  for (const text of ['25.0%', '−12', 'al menos 10 partidos', '70/30', 'no una validación independiente']) {
    assert.ok(html.includes(text.replace('−', '-')), text);
  }
  assert.equal(renderToStaticMarkup(<RoiAuditSummary />), '');
});
