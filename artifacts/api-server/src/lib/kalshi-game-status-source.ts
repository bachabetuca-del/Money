import { providerGameState, type GameStatus, type GameCandidate } from "./kalshi-game-status";
import { mapConcurrent } from "./async-pool";

type Market = { ticker?: string; event_ticker: string; status: string };
type Milestone = { id: string; start_date: string; primary_event_tickers?: string[]; details?: { status?: string } };
type LiveData = { details: { status?: string; live_data_delayed?: boolean } };
type LiveDataBoard = LiveData & { milestone_id: string };
type Request = <T>(path: string) => Promise<T>;

/** Kalshi's actual empty response is {live_datas:null}, despite its array-only
 * schema. Only this explicit empty value is accepted; malformed payloads fail. */
export function parseLiveDataBatch(response: unknown): LiveDataBoard[] {
  if (!response || typeof response !== "object" || !("live_datas" in response)) {
    throw new Error("Kalshi returned an invalid live-data batch.");
  }
  const boards = response.live_datas;
  if (boards === null) return [];
  if (!Array.isArray(boards) || boards.some(board =>
    !board || typeof board.milestone_id !== "string" || !board.milestone_id.trim() ||
    !board.details || typeof board.details !== "object" || Array.isArray(board.details)) ||
    new Set(boards.map(board => board.milestone_id)).size !== boards.length) {
    throw new Error("Kalshi returned an invalid live-data batch.");
  }
  return boards as LiveDataBoard[];
}

/** Cache live data by game, so winner/spread/total do not each poll the same scoreboard. */
export class KalshiGameStatusSource {
  private cache = new Map<string, { until: number; value: Promise<unknown> }>();
  constructor(private request: Request) {}
  invalidate(ticker: string, eventTicker?: string | null, milestoneId?: string | null) {
    this.cache.delete(`market:${ticker}`);
    if (eventTicker) this.cache.delete(`event:${eventTicker}`);
    if (milestoneId) this.cache.delete(`live:${milestoneId}`);
  }
  private prime(key: string, value: unknown, now: Date) {
    if (this.cache.size >= 5000) this.cache.delete(this.cache.keys().next().value!);
    this.cache.set(key, { until: now.getTime() + 60_000, value: Promise.resolve(value) });
  }
  private chooseMilestone(matches: Milestone[], event: string) {
    const primary = matches.filter(m => m.primary_event_tickers?.includes(event));
    const choices = primary.length ? primary : matches;
    return choices.length === 1 ? choices[0] : undefined;
  }

  /** Prime the same readers used by resolve: at most 100 games per batch.
   * Missing/ambiguous boards are never replaced by another game's data. */
  async prepare(candidates: GameCandidate[], now: Date) {
    if (!candidates.length) return;
    if (candidates.length > 100) throw new Error("Game status batch exceeds 100 markets.");
    const wanted = new Set(candidates.map(row => row.ticker));
    const response = await this.request<{ markets: Market[] }>(
      `/markets?tickers=${encodeURIComponent([...wanted].join(","))}&limit=1000`);
    if (!Array.isArray(response.markets)) throw new Error("Kalshi returned an invalid market batch.");
    const markets = new Map<string, Market>();
    for (const market of response.markets) if (market.ticker && wanted.has(market.ticker)) {
      markets.set(market.ticker, market);
      this.prime(`market:${market.ticker}`, market, now);
    }
    const milestones = new Set<string>();
    await mapConcurrent(candidates, 4, async candidate => {
      if (candidate.previous?.milestoneId) { milestones.add(candidate.previous.milestoneId); return; }
      const event = markets.get(candidate.ticker)?.event_ticker;
      if (!event) return;
      try {
        const data = await this.cached(`event:${event}`, 60_000, now, () =>
          this.request<{ milestones: Milestone[] }>(`/milestones?limit=100&related_event_ticker=${encodeURIComponent(event)}`));
        const milestone = this.chooseMilestone(data.milestones ?? [], event);
        if (milestone) milestones.add(milestone.id);
      } catch { /* resolve reports each cached error without issuing another request. */ }
    });
    if (!milestones.size) return;
    const query = new URLSearchParams();
    for (const id of milestones) query.append("milestone_ids", id);
    const boards = parseLiveDataBatch(await this.request<unknown>(`/live_data/batch?${query}`));
    for (const board of boards) if (milestones.has(board.milestone_id)) {
      this.prime(`live:${board.milestone_id}`, { live_data: board }, now);
    }
    // An omitted board is unavailable, not a final score. Cache its absence so
    // it doesn't trigger one fallback request per market during this batch.
    for (const id of milestones) if (!boards.some(board => board.milestone_id === id)) {
      this.prime(`live:${id}`, { live_data: null }, now);
    }
  }
  private cached<T>(key: string, ttl: number, now: Date, read: () => Promise<T>): Promise<T> {
    const old = this.cache.get(key);
    if (old && old.until > now.getTime()) return old.value as Promise<T>;
    if (this.cache.size >= 5000) this.cache.delete(this.cache.keys().next().value!);
    const value = read();
    // Keep short-lived failed reads too; otherwise a shared outage becomes a request flood.
    this.cache.set(key, { until: now.getTime() + ttl, value });
    return value;
  }
  async resolve(ticker: string, previous: GameStatus | undefined, now: Date): Promise<GameStatus> {
    if (previous?.state === "finished") return previous;
    const market = previous?.eventTicker && ["finalized", "settled"].includes(previous.marketStatus ?? "")
      ? { event_ticker: previous.eventTicker, status: previous.marketStatus ?? "" }
      : await this.cached(`market:${ticker}`, 60_000, now, async () => {
        try {
          return (await this.request<{ market: Market }>(`/markets/${encodeURIComponent(ticker)}`)).market;
        } catch (error) {
          if (!(error instanceof Error) || !/HTTP 404/.test(error.message)) throw error;
          return (await this.request<{ market: Market }>(`/historical/markets/${encodeURIComponent(ticker)}`)).market;
        }
      });
    if (!market.event_ticker || !market.status) throw new Error("Kalshi returned incomplete market status.");
    const marketTerminal = ["closed", "determined", "finalized", "settled"].includes(market.status);
    let milestone: Milestone | undefined;
    if (previous?.milestoneId) {
      milestone = { id: previous.milestoneId, start_date: previous.startsAt?.toISOString() ?? "" };
    } else {
      const response = await this.cached(`event:${market.event_ticker}`, 60_000, now, () =>
        this.request<{ milestones: Milestone[] }>(
          `/milestones?limit=100&related_event_ticker=${encodeURIComponent(market.event_ticker)}`));
      // Ambiguous milestones must not attach a different game's scoreboard.
      milestone = this.chooseMilestone(response.milestones ?? [], market.event_ticker);
    }
    let state: GameStatus["state"] = "unknown";
    let source = "unknown";
    let delayed = false;
    let error: string | null = null;
    const start = milestone?.start_date ? new Date(milestone.start_date) : null;
    const startsAt = start && Number.isFinite(start.getTime()) ? start : null;
    if (milestone) {
      try {
        const result = await this.cached(`live:${milestone.id}`, 60_000, now, () =>
          this.request<{ live_data: LiveData | null }>(`/live_data/milestone/${encodeURIComponent(milestone!.id)}`));
        if (result.live_data === null && startsAt && startsAt > now) {
          // A valid empty board before the scheduled start isn't a live-feed error.
          state = "scheduled"; source = "schedule";
        } else {
          if (!result.live_data) throw new Error("Kalshi omitted this scoreboard; game status is unconfirmed.");
          state = providerGameState(result.live_data.details?.status);
          delayed = result.live_data.details?.live_data_delayed === true;
          source = "live";
        }
      } catch (failure) {
        if (!(failure instanceof Error) || !/HTTP 404/.test(failure.message)) {
          error = failure instanceof Error ? failure.message : "Live game data unavailable.";
          delayed = true;
        }
        // Milestone 'live' can stay stale after the game ends. Never trust it as live.
        if (providerGameState(milestone.details?.status) === "finished") {
          state = "finished"; source = "milestone";
        } else if (startsAt && startsAt > now && !delayed) {
          state = "scheduled"; source = "schedule";
        }
      }
    }
    if (state === "unknown" && ["finalized", "settled"].includes(market.status)) {
      // A settled bet does not prove when a game ended. Label it as a resolved market.
      state = "finished"; source = "market";
    }
    const delay = state === "live" || (startsAt && startsAt.getTime() - now.getTime() < 300_000)
      ? 60_000 : 300_000;
    return { ticker, eventTicker: market.event_ticker, milestoneId: milestone?.id ?? null,
      state, source, marketStatus: market.status, marketTerminal, startsAt, delayed, error,
      checkedAt: now, nextCheckAt: new Date(now.getTime() + (error ? 60_000 : delay)) };
  }
}
