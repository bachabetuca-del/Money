import { catalogGameBadge, type CatalogMarket } from "./telegram-dashboard-view";

export type ExplorerWindow = "1h" | "24h" | "all";

/** Use Telegram's confirmed lifecycle; delayed status never asserts live. */
export function explorerState(markets: CatalogMarket[], now: Date) {
  const badge = catalogGameBadge(markets, now);
  if (badge.label === "En juego") return "live" as const;
  if (badge.label === "Terminado" || badge.label === "Mercado resuelto") return "finished" as const;
  if (badge.label === "Por empezar") return "upcoming" as const;
  return "unknown" as const;
}

export function explorerSince(window: ExplorerWindow, now: Date) {
  return window === "all" ? undefined :
    new Date(now.getTime() - (window === "1h" ? 60 * 60_000 : 24 * 60 * 60_000));
}
