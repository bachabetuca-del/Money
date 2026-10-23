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
  const date = official ? gameCalendarDay(official.ticker, official.gameStartsAt) :
    gameCalendarDay(markets[0]?.ticker ?? "");
  return date && date < newYorkDay(now) ? "history" : "active";
}

export function scopedCatalog<T extends ScopeMarket>(catalog: T[], scope: GameScope, now: Date): T[] {
  const games = new Map<string, T[]>();
  for (const market of catalog) games.set(market.gameKey, [...(games.get(market.gameKey) ?? []), market]);
  const included = new Set([...games].filter(([, markets]) => gameScope(markets, now) === scope).map(([key]) => key));
  return catalog.filter(market => included.has(market.gameKey));
}
