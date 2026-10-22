import { providerGameState, type GameStatus } from "./kalshi-game-status";

type Market = { event_ticker: string; status: string };
type Milestone = { id: string; start_date: string; primary_event_tickers?: string[]; details?: { status?: string } };
type LiveData = { details: { status?: string; live_data_delayed?: boolean } };
type Request = <T>(path: string) => Promise<T>;

/** Cache live data by game, so winner/spread/total do not each poll the same scoreboard. */
export class KalshiGameStatusSource {
  private cache = new Map<string, { until: number; value: Promise<unknown> }>();
  constructor(private request: Request) {}
  private cached<T>(key: string, ttl: number, now: Date, read: () => Promise<T>): Promise<T> {
    const old = this.cache.get(key);
    if (old && old.until > now.getTime()) return old.value as Promise<T>;
    if (this.cache.size > 5000) this.cache.clear();
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
      const matches = response.milestones ?? [];
      const primary = matches.filter(m => m.primary_event_tickers?.includes(market.event_ticker));
      const choices = primary.length ? primary : matches;
      // Ambiguous milestones must not attach a different game's scoreboard.
      if (choices.length === 1) milestone = choices[0];
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
          this.request<{ live_data: LiveData }>(`/live_data/milestone/${encodeURIComponent(milestone!.id)}`));
        state = providerGameState(result.live_data?.details?.status);
        delayed = result.live_data?.details?.live_data_delayed === true;
        source = "live";
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
