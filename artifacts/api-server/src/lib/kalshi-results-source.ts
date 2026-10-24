import { providerGameState } from "./kalshi-game-status";

type Fields = Record<string, unknown>;
type Request = <T>(path: string) => Promise<T>;
export type FinalResult = {
  gameResult: string | null; marketResult: string | null;
  unavailableReason?: "no_milestone" | "no_feed" | "not_final" | "delayed" | "incomplete_score";
};

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
  let sets = "";
  if (Array.isArray(live.competitor1_round_scores) && Array.isArray(live.competitor2_round_scores) &&
      live.competitor1_round_scores.length === live.competitor2_round_scores.length) {
    const rounds = live.competitor1_round_scores.map((round, i) => {
      const a = score((round as Fields)?.score);
      const b = score((live.competitor2_round_scores as Fields[])[i]?.score);
      return a !== null && b !== null ? `${a}–${b}` : null;
    });
    if (rounds.length && rounds.every(Boolean)) sets = ` · Sets: ${rounds.join(", ")}`;
  }
  return `${names[firstId]} ${first}–${second} ${names[secondId]}${sets}` +
    (["draw", "tie"].includes(winner ?? "") ? " · Empate" : "");
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
    // Known games do not need an individual market/settlement request.
    // Keep the legacy nullable field for database compatibility only.
    const marketResult = null;
    if (!milestoneId) {
      let market: Fields;
      try {
        market = (await this.cached<{ market: Fields }>(`/markets/${encodeURIComponent(ticker)}`)).market;
      } catch (error) {
        if (!(error instanceof Error) || !/HTTP 404/.test(error.message)) throw error;
        market = (await this.cached<{ market: Fields }>(`/historical/markets/${encodeURIComponent(ticker)}`)).market;
      }
      // Older stored statuses may not have linked a milestone yet.
      if (typeof market.event_ticker === "string") {
        const response = await this.cached<{ milestones: { id: string; primary_event_tickers?: string[] }[] }>(
          `/milestones?limit=100&related_event_ticker=${encodeURIComponent(market.event_ticker)}`);
        const all = response.milestones ?? [];
        const primary = all.filter(m => m.primary_event_tickers?.includes(String(market.event_ticker)));
        const choices = primary.length ? primary : all;
        if (choices.length === 1) milestoneId = choices[0].id;
      }
    }
    if (!milestoneId) return { gameResult: null, marketResult, unavailableReason: "no_milestone" };
    try {
      const [live, milestone] = await Promise.all([
        this.cached<{ live_data: { details: Fields } }>(`/live_data/milestone/${encodeURIComponent(milestoneId)}`),
        this.cached<{ milestone: { details: Fields } }>(`/milestones/${encodeURIComponent(milestoneId)}`),
      ]);
      const details = live.live_data.details;
      if (details.live_data_delayed === true) {
        return { gameResult: null, marketResult, unavailableReason: "delayed" };
      }
      if (providerGameState(details.status) !== "finished") {
        return { gameResult: null, marketResult, unavailableReason: "not_final" };
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
      const gameResult = finalScore(details, meta, names);
      return gameResult ? { gameResult, marketResult } :
        { gameResult: null, marketResult, unavailableReason: "incomplete_score" };
    } catch (error) {
      if (error instanceof Error && /HTTP 404/.test(error.message)) {
        return { gameResult: null, marketResult, unavailableReason: "no_feed" };
      }
      throw error;
    }
  }
}
