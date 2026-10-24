import type { ExplorerMarket, ExplorerTrade } from '@workspace/api-client-react';

export function groupMarkets(markets: ExplorerMarket[], term: string) {
  const t = term.trim().toLowerCase();
  type Game = { name: string; date: string; startsAt: number; markets: ExplorerMarket[] };
  const sports = new Map<string, Map<string, Game>>();
  for (const m of markets) {
    if (t && !`${m.sport} ${m.gameName} ${m.betLabel} ${m.ticker}`.toLowerCase().includes(t)) continue;
    const games = sports.get(m.sport) ?? new Map<string, Game>();
    const timestamp = m.gameStartsAt ? Date.parse(m.gameStartsAt) : NaN;
    const startsAt = Number.isFinite(timestamp) ? timestamp : Infinity;
    const g = games.get(m.gameKey) ?? { name: m.gameName,
      date: `${m.gameDateLabel} · ${m.gameTimeLabel ?? 'Hora por confirmar'}`,
      startsAt, markets: [] };
    // Sibling markets share a game; a confirmed schedule takes precedence.
    if (startsAt < g.startsAt) {
      g.startsAt = startsAt;
      g.date = `${m.gameDateLabel} · ${m.gameTimeLabel ?? 'Hora por confirmar'}`;
    }
    g.markets.push(m);
    games.set(m.gameKey, g);
    sports.set(m.sport, games);
  }
  return [...sports.entries()].map(([sport, games]) => {
    const list = [...games.entries()].map(([key, g]) => ({ key, ...g,
      markets: g.markets.sort((a, b) => b.trades - a.trades),
      trades: g.markets.reduce((s, m) => s + m.trades, 0) }))
      .sort((a, b) => {
        if (a.startsAt !== b.startsAt) return a.startsAt < b.startsAt ? -1 : 1;
        return a.name.localeCompare(b.name) || a.key.localeCompare(b.key);
      });
    return { sport, games: list, trades: list.reduce((s, g) => s + g.trades, 0) };
  }).sort((a, b) => b.trades - a.trades);
}

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
