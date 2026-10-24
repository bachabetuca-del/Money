import { providerGameState } from "./kalshi-game-status";

type Fields = Record<string, unknown>;
type Request = <T>(path: string) => Promise<T>;
export type FinalResult = { gameResult: string | null; marketResult: string | null };

const text = (value: unknown) => typeof value === "string" && value.trim() ? value.trim().slice(0, 100) : null;
const score = (value: unknown) => typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;

/** Never use prices, market settlement, or a passed start date to invent a score. */
export function finalScore(
  live: Fields, milestone: Fields, names: Record<string, string>,
): string | null {
  if (providerGameState(live.status) !== "finished" || live.live_data_delayed === true) return null;
  let firstId = text(live.competitor1_id);
  let secondId = text(live.competitor2_id);
  let first = score(live.competitor1_overall_score);
  let second = score(live.competitor2_overall_score);
  if (!firstId || !secondId || first === null || second === null) {
    firstId = text(milestone.home_team_id);
    secondId = text(milestone.away_team_id);
    first = score(live.home_points ?? live.home_score ?? live.home_runs ?? live.home_goals ?? live.home_overall_score);
    second = score(live.away_points ?? live.away_score ?? live.away_runs ?? live.away_goals ?? live.away_overall_score);
  }
  if (!firstId || !secondId || first === null || second === null || !names[firstId] || !names[secondId]) return null;
  const winner = text(live.winner);
  const winnerName = winner && names[winner];
  return `${names[firstId]} ${first}–${second} ${names[secondId]}` +
    (winnerName ? ` · Ganó ${winnerName}` : ["draw", "tie"].includes(winner ?? "") ? " · Empate" : "");
}

export function settledOutcome(market: Fields): string | null {
  if (!["determined", "finalized", "settled"].includes(String(market.status))) return null;
  if (market.result === "yes") return "SÍ";
  if (market.result === "no") return "NO";
  // A scalar/void payout is not a binary win or loss.
  if (market.result === "scalar") return "Liquidación no binaria";
  return null;
}

export class KalshiResultsSource {
  private cache = new Map<string, { until: number; value: Promise<unknown> }>();
  constructor(private request: Request) {}
  private cached<T>(path: string, ttl = 60_000): Promise<T> {
    const now = Date.now();
    const old = this.cache.get(path);
    if (old && old.until > now) return old.value as Promise<T>;
    if (this.cache.size > 5000) this.cache.clear();
    const value = this.request<T>(path);
    this.cache.set(path, { until: now + ttl, value });
    return value;
  }
  async resolve(ticker: string, milestoneId: string | null): Promise<FinalResult> {
    let market: Fields;
    try {
      market = (await this.cached<{ market: Fields }>(`/markets/${encodeURIComponent(ticker)}`)).market;
    } catch (error) {
      if (!(error instanceof Error) || !/HTTP 404/.test(error.message)) throw error;
      market = (await this.cached<{ market: Fields }>(`/historical/markets/${encodeURIComponent(ticker)}`)).market;
    }
    const marketResult = settledOutcome(market);
    // Older stored statuses may not have linked a milestone yet.
    if (!milestoneId && typeof market.event_ticker === "string") {
      const response = await this.cached<{ milestones: { id: string; primary_event_tickers?: string[] }[] }>(
        `/milestones?limit=100&related_event_ticker=${encodeURIComponent(market.event_ticker)}`);
      const all = response.milestones ?? [];
      const primary = all.filter(m => m.primary_event_tickers?.includes(String(market.event_ticker)));
      const choices = primary.length ? primary : all;
      if (choices.length === 1) milestoneId = choices[0].id;
    }
    if (!milestoneId) return { gameResult: null, marketResult };
    try {
      const [live, milestone] = await Promise.all([
        this.cached<{ live_data: { details: Fields } }>(`/live_data/milestone/${encodeURIComponent(milestoneId)}`),
        this.cached<{ milestone: { details: Fields } }>(`/milestones/${encodeURIComponent(milestoneId)}`),
      ]);
      const details = live.live_data.details;
      if (providerGameState(details.status) !== "finished" || details.live_data_delayed === true) {
        return { gameResult: null, marketResult };
      }
      const meta = milestone.milestone.details;
      const ids = [...new Set([details.competitor1_id, details.competitor2_id, meta.home_team_id, meta.away_team_id]
        .filter((id): id is string => typeof id === "string" && id.length > 0))];
      const names: Record<string, string> = {};
      await Promise.all(ids.map(async id => {
        const target = await this.cached<{ structured_target: { name: string } }>(
          `/structured_targets/${encodeURIComponent(id)}`, 86_400_000);
        const name = text(target.structured_target.name);
        if (name) names[id] = name;
      }));
      return { gameResult: finalScore(details, meta, names), marketResult };
    } catch (error) {
      // Preserve a confirmed market settlement even if its scoreboard is absent.
      if (error instanceof Error && /HTTP 404/.test(error.message)) return { gameResult: null, marketResult };
      if (marketResult) return { gameResult: null, marketResult };
      throw error;
    }
  }
}
