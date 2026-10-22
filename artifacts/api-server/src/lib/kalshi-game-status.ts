export type GameState = "scheduled" | "live" | "finished" | "unknown";
export type GameStatus = {
  ticker: string; eventTicker: string | null; milestoneId: string | null;
  state: GameState; source: string; marketStatus: string | null; marketTerminal: boolean;
  startsAt: Date | null; delayed: boolean; checkedAt: Date; nextCheckAt: Date; error: string | null;
};
export function providerGameState(value: unknown): GameState {
  // Game-feed statuses only. Never pass market.status here: a closed bet is not a finished game.
  const status = String(value ?? "").toLowerCase().replace(/[\s-]+/g, "_");
  if (["scheduled", "not_started", "notstarted", "pre", "pregame", "pre_game", "pre_match"].includes(status)) return "scheduled";
  if (["live", "started", "in_progress", "inprogress", "in_play", "halftime", "half_time", "intermission", "playing"].includes(status)) return "live";
  if (["finished", "final", "ended", "closed", "complete", "completed", "full_time", "fulltime", "post", "game_over"].includes(status)) return "finished";
  return "unknown";
}
export function monitoringStopped(status: Pick<GameStatus, "state" | "marketTerminal"> | undefined | null) {
  return status?.state === "finished" || status?.marketTerminal === true;
}
export function gameBadge(state: string | null | undefined, source?: string | null, delayed = false) {
  const badge = state === "live"
    ? { label: "En juego", marker: "🟡", color: "#FACC15", rank: 0 }
    : state === "scheduled"
      ? { label: "Por empezar", marker: "⚪", color: "#F8FAFC", rank: 1 }
      : state === "finished"
        ? { label: source === "market" ? "Mercado resuelto" : "Terminado", marker: "🔴", color: "#F87171", rank: 3 }
        : { label: "Sin confirmar", marker: "◌", color: "#94A3B8", rank: 2 };
  return { ...badge, label: badge.label + (delayed ? " · dato retrasado" : "") };
}

export interface GameStatusRepository {
  next(now: Date, preferred?: string): Promise<{ ticker: string; previous?: GameStatus } | undefined>;
  save(status: GameStatus): Promise<void>;
}
/** One bounded lookup at a time; confirmed finished games are never polled again. */
export class GameStatusMonitor {
  private busy = false;
  private preferred: string | undefined;
  constructor(private repository: GameStatusRepository,
    private resolve: (ticker: string, previous: GameStatus | undefined, now: Date) => Promise<GameStatus>,
    private now: () => Date = () => new Date(),
    private warn: (error: string) => void = () => undefined) {}
  prefer(ticker: string) { this.preferred = ticker; }
  async tick() {
    if (this.busy) return;
    this.busy = true;
    try {
      const now = this.now();
      const candidate = await this.repository.next(now, this.preferred);
      if (!candidate || candidate.previous?.state === "finished") return;
      try {
        await this.repository.save(await this.resolve(candidate.ticker, candidate.previous, now));
      } catch (error) {
        const message = error instanceof Error ? error.message : "Game status unavailable.";
        await this.repository.save({
          ticker: candidate.ticker, eventTicker: null, milestoneId: null,
          state: "unknown", source: "unknown", marketStatus: null, marketTerminal: false,
          startsAt: null, ...candidate.previous, delayed: true, error: message,
          checkedAt: now, nextCheckAt: new Date(now.getTime() + 60_000),
        });
        this.warn(message);
      }
    } finally { this.busy = false; }
  }
}
