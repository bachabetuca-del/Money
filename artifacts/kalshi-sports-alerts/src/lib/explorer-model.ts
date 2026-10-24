import type { ExplorerTrade } from '@workspace/api-client-react';

export const MINUTE = 60_000;
export const RECENT_MS = 15 * MINUTE;
const BUCKET_WIDTHS = [1, 5, 15, 30, 60, 180, 360, 720, 1440, 10080, 43200].map((m) => m * MINUTE);
export type Dir = 'yes' | 'no' | 'unknown';
export type Bucket = {
  start: number; end: number; yes: number; no: number; unknown: number;
  yesR: number; noR: number; unknownR: number; total: number; n: number;
};

/** Stored price is the executed outcome price, not always the YES quote. */
export function yesQuote(trade: ExplorerTrade): number | null {
  if (trade.direction === 'yes') return trade.price;
  if (trade.direction === 'no') return 1 - trade.price;
  return null;
}

export function bubbleRadius(area = 40) {
  return Math.sqrt(area / Math.PI);
}

export function buildBuckets(trades: ExplorerTrade[], now: number, highlight: boolean) {
  if (!trades.length) return { buckets: [] as Bucket[], width: MINUTE, start: now, end: now, recentCount: 0, recentSum: 0 };
  let oldest = Infinity;
  let latest = -Infinity;
  for (const t of trades) {
    const ms = new Date(t.createdTime).getTime();
    oldest = Math.min(oldest, ms);
    latest = Math.max(latest, ms);
  }
  const end = latest + 1;
  const span = Math.max(MINUTE, end - oldest);
  const width = BUCKET_WIDTHS.find((w) => span / w <= 36) ?? Math.ceil(span / 36);
  const start = Math.floor(oldest / width) * width;
  const buckets: Bucket[] = Array.from({ length: Math.ceil((end - start) / width) }, (_, i) => ({
    start: start + i * width, end: start + (i + 1) * width,
    yes: 0, no: 0, unknown: 0, yesR: 0, noR: 0, unknownR: 0, total: 0, n: 0,
  }));
  let recentCount = 0;
  let recentSum = 0;
  for (const t of trades) {
    const ms = new Date(t.createdTime).getTime();
    const recent = highlight && ms >= now - RECENT_MS && ms <= now;
    const b = buckets[Math.floor((ms - start) / width)];
    const field: 'yes' | 'no' | 'unknown' | 'yesR' | 'noR' | 'unknownR' =
      recent ? `${t.direction}R` : t.direction;
    b[field] += t.notional;
    b.total += t.notional;
    b.n += 1;
    if (recent) { recentCount += 1; recentSum += t.notional; }
  }
  return { buckets, width, start, end: start + buckets.length * width, recentCount, recentSum };
}
