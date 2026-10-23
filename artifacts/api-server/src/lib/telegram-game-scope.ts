import { gameCalendarDay, newYorkDay } from "./telegram-game-date";

export type GameScope = "active" | "history";
const SCREENS = ["sports", "games", "markets", "chart"] as const;
export function decodeScopeScreen(value: string) {
  const scope: GameScope = value.startsWith("history:") ? "history" : "active";
  const raw = scope === "history" ? value.slice(8) : value;
  const screen = SCREENS.find(screen => screen === raw) ?? "sports";
  return { scope, screen };
}
export function encodeScopeScreen(screen: string, scope?: GameScope) {
  return scope === "history" ? `history:${screen}` : screen;
}
type ScopeMarket = {
  ticker: string; gameKey: string; gameStartsAt?: string | null;
  gameState?: string | null; gameSource?: string | null;
  gameCheckedAt?: string; gameDelayed?: boolean; marketTerminal?: boolean;
};

export function gameScope(markets: ScopeMarket[], now: Date): GameScope {
  const confirmed = markets.filter(m => m.gameState && m.gameState !== "unknown" && m.gameSource !== "market")
    .sort((a, b) => (b.gameCheckedAt ?? "").localeCompare(a.gameCheckedAt ?? ""))[0];
  if (confirmed?.gameState === "finished") return "history";
  // All resolved props are archived, without claiming the entire game finished.
  if (!confirmed && markets.length && markets.every(m => m.gameState === "finished" || m.marketTerminal)) return "history";
  const checked = confirmed?.gameCheckedAt ? new Date(confirmed.gameCheckedAt).getTime() : NaN;
  const freshLive = confirmed?.gameState === "live" && confirmed.gameSource === "live" &&
    !confirmed.gameDelayed && now.getTime() - checked <= 5 * 60_000 && checked <= now.getTime() + 60_000;
  if (freshLive) return "active"; // An actually live game may span midnight.
  const official = [...markets].filter(m => m.gameStartsAt && Number.isFinite(new Date(m.gameStartsAt).getTime()))
    .sort((a, b) => (b.gameCheckedAt ?? "").localeCompare(a.gameCheckedAt ?? ""))[0];
  if (official?.gameStartsAt && new Date(official.gameStartsAt).getTime() < now.getTime()) return "history";
  const date = official ? gameCalendarDay(official.ticker, official.gameStartsAt) :
    gameCalendarDay(markets[0]?.ticker ?? "");
  return date && date < newYorkDay(now) ? "history" : "active";
}

/** Only keep confirmed live games or upcoming scheduled games within 48 hours. */
export function isWithinNext48Hours(markets: ScopeMarket[], now: Date) {
  if (gameScope(markets, now) === "history") return false;
  if (hasFreshLiveStatus(markets, now)) return true;

  const cutoff = now.getTime() + 48 * 60 * 60_000;
  const official = [...markets].filter(m => m.gameStartsAt && Number.isFinite(new Date(m.gameStartsAt).getTime()))
    .sort((a, b) => (b.gameCheckedAt ?? "").localeCompare(a.gameCheckedAt ?? ""))[0];
  if (official?.gameStartsAt) {
    const startsAt = new Date(official.gameStartsAt).getTime();
    return startsAt >= now.getTime() && startsAt <= cutoff;
  }

  // A ticker gives us the date but not the start time. Retain games dated
  // today or the last calendar date within the 48-hour New York window.
  const day = gameCalendarDay(markets[0]?.ticker ?? "");
  return day !== null && day >= newYorkDay(now) && day <= newYorkDay(new Date(cutoff));
}

function hasFreshLiveStatus(markets: ScopeMarket[], now: Date) {
  const confirmed = markets.filter(m => m.gameState && m.gameState !== "unknown" && m.gameSource !== "market")
    .sort((a, b) => (b.gameCheckedAt ?? "").localeCompare(a.gameCheckedAt ?? ""))[0];
  const checked = confirmed?.gameCheckedAt ? new Date(confirmed.gameCheckedAt).getTime() : NaN;
  return confirmed?.gameState === "live" && confirmed.gameSource === "live" &&
    !confirmed.gameDelayed && now.getTime() - checked <= 5 * 60_000 && checked <= now.getTime() + 60_000;
}

export function scopedCatalog<T extends ScopeMarket>(catalog: T[], scope: GameScope, now: Date): T[] {
  const games = new Map<string, T[]>();
  for (const market of catalog) games.set(market.gameKey, [...(games.get(market.gameKey) ?? []), market]);
  const included = new Set([...games].filter(([, markets]) => scope === "active"
    ? isWithinNext48Hours(markets, now)
    : gameScope(markets, now) === "history").map(([key]) => key));
  return catalog.filter(market => included.has(market.gameKey));
}
