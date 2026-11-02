import type { TelegramNoticeGame } from "@workspace/api-zod";
import { catalogGameBadge } from "./telegram-dashboard-view";
import { gameDateLabel, gameTimeLabel } from "./telegram-game-date";

function validIso(value: unknown): string | null {
  if (value == null) return null;
  const date = new Date(value as string | Date);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

/** Current read-only game context is separate from the frozen signal evidence.
 * Reuses the catalog's confirmed-game / five-minute live freshness rules. */
export function notificationGameContext(
  ticker: string, saved: Record<string, unknown> | null | undefined,
  schedule: unknown, now: Date,
): TelegramNoticeGame {
  const startsAt = validIso(schedule);
  const checkedAt = validIso(saved?.checked_at);
  const badge = catalogGameBadge(saved ? [{
    gameState: typeof saved.state === "string" ? saved.state : "unknown",
    gameSource: typeof saved.source === "string" ? saved.source : "unknown",
    gameDelayed: saved.delayed === true || !!saved.error,
    gameCheckedAt: checkedAt ?? undefined,
  }] : [], now);
  let status: TelegramNoticeGame["status"] =
    badge.label.startsWith("En juego") ? "live" :
    badge.label.startsWith("Por empezar") ? "upcoming" :
    badge.label.startsWith("Terminado") ? "finished" :
    badge.label.startsWith("Mercado resuelto") ? "market_resolved" : "unknown";
  let delayed = status !== "finished" && status !== "market_resolved" &&
    (saved?.delayed === true || !!saved?.error || badge.label.includes("dato retrasado"));
  // Kickoff passing is not proof that play began (e.g. a delayed tennis match).
  if (status === "upcoming" && startsAt && Date.parse(startsAt) <= now.getTime()) delayed = true;
  if (delayed && status === "upcoming") status = "unknown";
  return {
    startsAt, dateLabel: gameDateLabel(ticker, startsAt), timeLabel: gameTimeLabel(startsAt),
    status, delayed, checkedAt,
  };
}
