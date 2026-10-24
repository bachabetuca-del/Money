/** Requests only reprioritize the existing production worker; never start a
 * second worker or perform a provider request in an HTTP/Telegram handler. */
export class ScoreQueue {
  private tickers = new Set<string>();
  request(ticker: string) {
    if (this.tickers.size >= 100) this.tickers.delete(this.tickers.values().next().value!);
    this.tickers.add(ticker);
  }
  take() {
    const ticker = this.tickers.values().next().value as string | undefined;
    if (ticker) this.tickers.delete(ticker);
    return ticker;
  }
}
export const scoreQueue = new ScoreQueue();

export function scoreRetryDelay(attempts: number) {
  return attempts <= 1 ? 5 * 60_000 : 30 * 60_000;
}

export function scoreCanRetry(row: {
  gameResult: string | null; attempts: number; checkedAt: Date | null; nextCheckAt: Date;
} | null, now: Date) {
  return !row || (!row.gameResult && row.attempts < 3 &&
    (row.nextCheckAt <= now || (row.checkedAt !== null &&
      row.checkedAt.getTime() + scoreRetryDelay(row.attempts) <= now.getTime())));
}

export function scoreDisplay(result: { gameResult: string | null; attempts: number; error: string | null } | undefined,
  sharedScore?: string | null) {
  if (result?.gameResult || sharedScore) return { scoreStatus: "confirmed" as const, scoreMessage: null };
  if (!result || result.attempts === 0) return { scoreStatus: "pending" as const, scoreMessage: "Marcador en cola de consulta" };
  const reason = result.error?.startsWith("score:") ? result.error.slice(6) : null;
  if (reason) {
    const messages: Record<string, string> = {
      no_milestone: "Kalshi no tiene una ficha de marcador vinculada a este partido",
      no_feed: "Kalshi no ofrece datos de marcador para este partido",
      not_final: "Kalshi todavía no confirma un marcador final para este partido",
      delayed: "El marcador de Kalshi está retrasado; no hay un resultado final confirmado",
      incomplete_score: "Kalshi devuelve un marcador incompleto; no se puede confirmar el resultado",
    };
    return { scoreStatus: "unavailable" as const,
      scoreMessage: messages[reason] ?? "La fuente no ofrece un marcador final confirmado" };
  }
  if (result.error) return {
    scoreStatus: "unavailable" as const,
    scoreMessage: result.attempts >= 3 ? "No se pudo consultar el marcador final tras varios intentos" :
      "No se pudo consultar el marcador; reintento automático programado",
  };
  return { scoreStatus: "unavailable" as const,
    scoreMessage: "La fuente todavía no ofrece un marcador final confirmado para este partido" };
}
