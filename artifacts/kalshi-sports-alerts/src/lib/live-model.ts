import type { MarketFlowWindow } from '@workspace/api-client-react';

export const FRESH_MS = 8000;
export const FALLBACK_MS = 30_000;
export const FLOW_WINDOWS = [5, 15, 60] as const;
export type FlowMinutes = (typeof FLOW_WINDOWS)[number];
export const LARGE_USD = 10_000;
export const MIN_CLUSTER = 3;

export type SseEvent = { event: string; data: string };

/** Incremental SSE parser: returns complete events and the unconsumed remainder. Comments are dropped. */
export function parseSse(buffer: string): { events: SseEvent[]; rest: string } {
  const normalized = buffer.replace(/\r\n?/g, '\n');
  const blocks = normalized.split('\n\n');
  const rest = blocks.pop() ?? '';
  const events: SseEvent[] = [];
  for (const block of blocks) {
    let event = 'message';
    const data: string[] = [];
    let hasField = false;
    for (const line of block.split('\n')) {
      if (!line || line.startsWith(':')) continue;
      const i = line.indexOf(':');
      const field = i === -1 ? line : line.slice(0, i);
      let value = i === -1 ? '' : line.slice(i + 1);
      if (value.startsWith(' ')) value = value.slice(1);
      if (field === 'event') { event = value; hasField = true; }
      else if (field === 'data') { data.push(value); hasField = true; }
    }
    if (hasField) events.push({ event, data: data.join('\n') });
  }
  return { events, rest };
}

export function eventTickers(data: string): string[] {
  try {
    const parsed = JSON.parse(data) as { tickers?: unknown };
    return Array.isArray(parsed.tickers) ? parsed.tickers.filter((t): t is string => typeof t === 'string') : [];
  } catch {
    return [];
  }
}

/** Only server-confirmed live execution IDs may flash; REST/imports are silent. */
export function eventFreshIds(data: string): string[] {
  try {
    const parsed = JSON.parse(data) as { freshTradeIds?: unknown };
    return Array.isArray(parsed.freshTradeIds)
      ? parsed.freshTradeIds.filter((id): id is string => typeof id === 'string') : [];
  } catch { return []; }
}

export function backoffMs(attempt: number) {
  return Math.min(30_000, 1000 * 2 ** Math.max(0, attempt));
}

export type SeenState = { key: string; ids: Set<string> } | null;

/**
 * Decide which trade IDs are genuinely fresh. A new selection key or the first
 * snapshot only establishes the baseline. IDs are fresh only when the update was
 * caused by a live stored-trade event (`fromLiveEvent`).
 */
export function diffFresh(prev: SeenState, key: string, ids: string[], fromLiveEvent: boolean): { seen: SeenState; fresh: string[] } {
  if (!prev || prev.key !== key) return { seen: { key, ids: new Set(ids) }, fresh: [] };
  const fresh = fromLiveEvent ? ids.filter((id) => !prev.ids.has(id)) : [];
  const next = new Set(prev.ids);
  for (const id of ids) next.add(id);
  return { seen: { key, ids: next }, fresh };
}

/** Frozen snapshot: when paused the previous snapshot is kept regardless of live data. */
export function viewSnapshot<T>(paused: boolean, frozen: T | null, live: T): T {
  // Never render the previous market's snapshot under a newly selected market.
  if (frozen && typeof frozen === 'object' && live && typeof live === 'object' &&
    'key' in frozen && 'key' in live && frozen.key !== live.key) return live;
  return paused && frozen !== null ? frozen : live;
}

export function pickFlow(flow: MarketFlowWindow[] | undefined, minutes: number): MarketFlowWindow | null {
  return flow?.find((f) => f.minutes === minutes) ?? null;
}

export type Cluster = { dir: 'yes' | 'no'; count: number; usd: number };

/** Visual-only concentration signal: >=3 individual trades strictly above $10k, same public direction. Large band only. */
export function concentration(w: MarketFlowWindow | null, band: string): Cluster[] {
  if (!w || band !== 'large') return [];
  const out: Cluster[] = [];
  if (w.largeYesCount >= MIN_CLUSTER) out.push({ dir: 'yes', count: w.largeYesCount, usd: w.largeYesUsd });
  if (w.largeNoCount >= MIN_CLUSTER) out.push({ dir: 'no', count: w.largeNoCount, usd: w.largeNoUsd });
  return out;
}

export function lastExecution(times: string[]): number | null {
  let max = -Infinity;
  for (const t of times) { const ms = Date.parse(t); if (ms > max) max = ms; }
  return Number.isFinite(max) ? max : null;
}
