import { createHash } from "node:crypto";
import { escapeHtml, readableBet } from "./telegram-market-card";
import { rangeLabel, tradeRange, type TradeBand } from "./kalshi-trade-bands";
import { gameBadge } from "./kalshi-game-status";
import { gameDateLabel } from "./telegram-game-date";
import { gameScope, scopedCatalog, type GameScope } from "./telegram-game-scope";

export type Screen = "sports" | "games" | "markets" | "chart";
export type Selection = {
  screen: Screen;
  scope?: GameScope;
  band: TradeBand;
  sportKey: string | null;
  gameKey: string | null;
  ticker: string | null;
  page: number;
};
export type MarketSummary = {
  ticker: string;
  sport: string;
  eventTitle: string | null;
  marketTitle: string | null;
  marketUrl: string;
  trades: number;
  lastTradeAt: string;
  gameState?: string | null;
  gameSource?: string | null;
  gameDelayed?: boolean;
  gameCheckedAt?: string;
  gameStartsAt?: string | null;
  marketTerminal?: boolean;
};
export type CatalogMarket = MarketSummary & {
  id: string;
  sportKey: string;
  gameKey: string;
  gameName: string;
  gameLabel: string;
  gameDateLabel: string;
  betLabel: string;
};
export type Button = { text: string; callback_data?: string; url?: string };
export type Keyboard = { inline_keyboard: Button[][] };
export const HOME: Selection = { screen: "sports", scope: "active", band: "large", sportKey: null, gameKey: null, ticker: null, page: 0 };
const PAGE_SIZE = 6;

export function keyFor(value: string) {
  return createHash("sha256").update(value).digest("hex").slice(0, 16);
}

function sportName(value: string, ticker: string) {
  const tag = value.trim();
  const known: [RegExp, string][] = [
    [/FOOTBALL|^KX(NFL|NCAAF|CFB)/i, "Football"],
    [/BASKETBALL|^KX(NBA|WNBA|NCAAB)/i, "Basketball"],
    [/BASEBALL|^KXMLB/i, "Baseball"],
    [/SOCCER|^KX(EPL|UCL|LALIGA|MLS|UEFA)/i, "Soccer"],
    [/HOCKEY|^KXNHL/i, "Hockey"],
    [/TENNIS|^KX(ATP|WTA)/i, "Tennis"],
    [/GOLF|^KX(PGA|GOLF)/i, "Golf"],
    [/MMA|BOXING|^KX(UFC|BOX)/i, "Combat sports"],
  ];
  return known.find(([pattern]) => pattern.test(tag) || pattern.test(ticker))?.[1] ||
    (tag && !tag.startsWith("KX") ? tag : "Other sports");
}

export function buildCatalog(rows: MarketSummary[]): CatalogMarket[] {
  const unique = new Map<string, CatalogMarket>();
  for (const row of rows) {
    if (!row.eventTitle || !row.marketTitle || row.marketTitle.includes(row.ticker) ||
        row.eventTitle.includes(row.ticker)) continue;
    const sport = sportName(row.sport, row.ticker);
    // Kalshi creates separate event titles for a game's spread and totals.
    // Keep those markets under the same actual matchup in the game menu.
    const gameName = row.eventTitle.replace(
      /\s*:\s*(?:spread|total points|total runs|total goals|total games|moneyline|game winner|winner)$/i, "",
    ).trim();
    const date = row.ticker.match(/-(\d{2}[A-Z]{3}\d{2})/)?.[1] ?? "";
    const dateLabel = gameDateLabel(row.ticker, row.gameStartsAt);
    const entry = {
      ...row, sport, id: keyFor(row.ticker), sportKey: keyFor(sport),
      gameKey: keyFor(`${sport}|${gameName.toLowerCase()}|${date}`),
      gameName,
      gameLabel: `${dateLabel} · ${gameName}`,
      gameDateLabel: dateLabel,
      betLabel: readableBet(row.marketTitle),
    };
    const prior = unique.get(row.ticker);
    if (!prior) unique.set(row.ticker, entry);
    else unique.set(row.ticker, {
      ...(entry.lastTradeAt > prior.lastTradeAt ? entry : prior),
      trades: prior.trades + entry.trades,
    });
  }
  return [...unique.values()].sort((a, b) => b.lastTradeAt.localeCompare(a.lastTradeAt) || a.ticker.localeCompare(b.ticker));
}

export function normalizeSelection(selection: Selection, catalog: CatalogMarket[], now = new Date()): Selection {
  let scope = selection.scope ?? "active";
  if (selection.screen === "chart" || selection.screen === "markets") {
    const game = catalog.filter(m => m.gameKey === selection.gameKey);
    if (game.length) scope = gameScope(game, now);
  }
  selection = { ...selection, scope };
  catalog = scopedCatalog(catalog, scope, now);
  if (selection.screen === "sports") return { ...HOME, scope, band: selection.band, page: selection.page };
  if (!catalog.some(market => market.sportKey === selection.sportKey)) return { ...HOME, scope, band: selection.band };
  if (selection.screen === "games") return selection;
  if (!catalog.some(market => market.sportKey === selection.sportKey && market.gameKey === selection.gameKey)) {
    return { ...selection, screen: "games", gameKey: null, ticker: null, page: 0 };
  }
  if (selection.screen === "chart" && !catalog.some(market => market.ticker === selection.ticker &&
      market.sportKey === selection.sportKey && market.gameKey === selection.gameKey)) {
    return { ...selection, screen: "markets", ticker: null, page: 0 };
  }
  return selection;
}

export function navigate(selection: Selection, action: string, catalog: CatalogMarket[], now = new Date()): Selection {
  const [prefix, type, value] = action.split(":");
  if (prefix !== "d") throw new Error("Unknown dashboard action.");
  const scope = selection.scope ?? "active";
  if (type === "main") return { ...HOME, band: selection.band };
  if (type === "home") return { ...HOME, scope, band: selection.band };
  if (type === "scope" && (value === "active" || value === "history")) {
    const available = scopedCatalog(catalog, value, now);
    const sportKey = available.some(m => m.sportKey === selection.sportKey) ? selection.sportKey : null;
    return { ...HOME, scope: value, band: selection.band, sportKey, screen: sportKey ? "games" : "sports" };
  }
  catalog = scopedCatalog(catalog, scope, now);
  if (type === "band" && (value === "large" || value === "medium")) {
    return { ...HOME, scope, band: value };
  }
  if (type === "refresh") return selection;
  if (type === "page" && /^\d+$/.test(value ?? "")) {
    return { ...selection, page: Math.min(Number(value), 100_000) };
  }
  if (type === "sport") {
    const market = catalog.find(m => m.sportKey === value);
    if (market) return { ...HOME, scope, band: selection.band, screen: "games", sportKey: market.sportKey };
  }
  if (type === "game") {
    const market = catalog.find(m => m.gameKey === value);
    if (market) return { screen: "markets", scope, band: selection.band, sportKey: market.sportKey, gameKey: market.gameKey, ticker: null, page: 0 };
  }
  if (type === "market") {
    const market = catalog.find(m => m.id === value);
    if (market) return { screen: "chart", scope, band: selection.band, sportKey: market.sportKey, gameKey: market.gameKey, ticker: market.ticker, page: 0 };
  }
  if (type === "back") {
    if (selection.screen === "chart") return { ...selection, screen: "markets", ticker: null, page: 0 };
    if (selection.screen === "markets") return { ...selection, screen: "games", gameKey: null, ticker: null, page: 0 };
    return { ...HOME, scope, band: selection.band };
  }
  throw new Error("This selection is no longer available. Tap Sports to refresh.");
}

export function bandButtons(band: TradeBand, threshold = 10_000): Button[] {
  const minimum = Math.max(10_000, threshold);
  const amount = minimum % 1000 === 0 ? `${minimum / 1000}k` : minimum.toLocaleString("en-US");
  return [
    { text: `${band === "large" ? "• " : ""}$${amount}+`, callback_data: "d:band:large" },
    { text: `${band === "medium" ? "• " : ""}$5k–$10k`, callback_data: "d:band:medium" },
  ];
}

export function chartKeyboard(selection: Selection, marketUrl: string, threshold = 10_000): Keyboard {
  return { inline_keyboard: [
    bandButtons(selection.band, threshold),
    scopeButtons(selection),
    [{ text: "Back to markets", callback_data: "d:back" }, { text: "Sports", callback_data: "d:home" }],
    [{ text: "Open market in Kalshi", url: marketUrl }, { text: "Refresh", callback_data: "d:refresh" }],
  ] };
}

export function scopeButtons(selection: Selection): Button[] {
  return [
    { text: `${selection.scope !== "history" ? "• " : ""}Vigentes`, callback_data: "d:scope:active" },
    { text: `${selection.scope === "history" ? "• " : ""}Historial`, callback_data: "d:scope:history" },
  ];
}

export function catalogGameBadge(markets: MarketSummary[]) {
  const confirmed = markets.filter(m => m.gameState && m.gameState !== "unknown" && m.gameSource !== "market")
    .sort((a, b) => (b.gameCheckedAt ?? "").localeCompare(a.gameCheckedAt ?? ""));
  const latest = confirmed[0];
  if (latest) return gameBadge(latest.gameState, latest.gameSource, latest.gameDelayed);
  if (markets.length && markets.every(m => m.gameState === "finished")) return gameBadge("finished", "market");
  return gameBadge("unknown");
}

type MenuItem = { label: string; detail: string; action: string; badge?: ReturnType<typeof gameBadge>; buttonLabel?: string };
export function menuView(selection: Selection, catalog: CatalogMarket[], enabled: boolean, threshold: number, now = new Date()) {
  const historical = selection.scope === "history";
  catalog = scopedCatalog(catalog, historical ? "history" : "active", now);
  const activeRange = rangeLabel(tradeRange(selection.band, threshold));
  let title = "Choose a sport";
  let subtitle = `${activeRange} only · separate trade section`;
  let items: MenuItem[];
  const sportMarkets = catalog.filter(m => m.sportKey === selection.sportKey);
  if (selection.screen === "games") {
    title = sportMarkets[0]?.sport ?? "Games";
    subtitle = `${activeRange} only · choose a game`;
    const grouped = new Map<string, CatalogMarket[]>();
    for (const market of sportMarkets) grouped.set(market.gameKey, [...(grouped.get(market.gameKey) ?? []), market]);
    items = [...grouped].map(([key, markets]) => ({
      label: markets[0].gameLabel,
      buttonLabel: markets[0].gameLabel,
      detail: `${markets.length} ${markets.length === 1 ? "market" : "markets"} · ${markets.reduce((sum, m) => sum + m.trades, 0)} trades`,
      action: `d:game:${key}`,
      badge: catalogGameBadge(markets),
    })).sort((a, b) => a.badge.rank - b.badge.rank);
  } else if (selection.screen === "markets") {
    title = sportMarkets.find(m => m.gameKey === selection.gameKey)?.gameLabel ?? "Markets";
    subtitle = `${activeRange} only · choose a bet`;
    const badge = catalogGameBadge(sportMarkets.filter(m => m.gameKey === selection.gameKey));
    items = sportMarkets.filter(m => m.gameKey === selection.gameKey).map(m => ({
      label: m.betLabel, detail: `${m.trades} ${m.trades === 1 ? "trade" : "trades"}${m.marketTerminal ? " · mercado cerrado" : ""}`,
      action: `d:market:${m.id}`,
      badge,
    }));
  } else {
    const sports = [...new Set(catalog.map(m => m.sport))].sort();
    items = sports.map(sport => {
      const markets = catalog.filter(m => m.sport === sport);
      return {
        label: sport,
        detail: `${new Set(markets.map(m => m.gameKey)).size} games · ${markets.length} markets`,
        action: `d:sport:${markets[0].sportKey}`,
      };
    });
  }
  const pages = Math.max(1, Math.ceil(items.length / PAGE_SIZE));
  const page = Math.max(0, Math.min(selection.page, pages - 1));
  const visible = items.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);
  const keyboard: Keyboard = { inline_keyboard: [
    bandButtons(selection.band, threshold),
    scopeButtons(selection),
    ...visible.map(item => [{ text: (item.badge
      ? item.buttonLabel ? `${item.badge.marker} ${item.buttonLabel.slice(0, 92)}` :
        `${item.badge.marker} ${item.label.slice(0, 67)} · ${item.badge.label}`
      : item.label).slice(0, 120), callback_data: item.action }]),
  ] };
  const paging: Button[] = [];
  if (page > 0) paging.push({ text: "Previous", callback_data: `d:page:${page - 1}` });
  if (page < pages - 1) paging.push({ text: "Next", callback_data: `d:page:${page + 1}` });
  if (paging.length) keyboard.inline_keyboard.push(paging);
  if (selection.screen !== "sports") keyboard.inline_keyboard.push([
    { text: "Back", callback_data: "d:back" }, { text: "Sports", callback_data: "d:home" },
  ]);
  keyboard.inline_keyboard.push([{ text: "Refresh", callback_data: "d:refresh" }]);
  title = `${historical ? "Historial" : "Vigentes"} · ${title}`;
  const status = historical ? "HISTORIAL · datos guardados" : enabled ? "LIVE · checks every 15 seconds" : "PAUSED · saved trade history";
  const caption = `<b>${escapeHtml(title)}</b>\nDeporte → Partido → Mercado.\n` +
    "⚪ Por empezar · 🟡 En juego · 🔴 Terminado\nAntiguos y terminados: en Historial. ◌ Sin confirmar: no se adivina el estado.\n" +
    `<i>${status}. Captured trades ${escapeHtml(activeRange)} only; sections never mix.</i>\n` +
    "Notifications: new trades over $10,000 only. Only the latest notice is kept.";
  return { title, subtitle, items: visible, page, pages, keyboard, caption, status, historical };
}

export function menuSvg(view: ReturnType<typeof menuView>) {
  const lines = (text: string, max = 32) => {
    const result: string[] = [];
    let current = "";
    for (const word of text.split(/\s+/)) {
      if (current && `${current} ${word}`.length > max) { result.push(current); current = word; }
      else current = current ? `${current} ${word}` : word;
    }
    if (current) result.push(current);
    return result;
  };
  const heading = lines(view.title, 28);
  let y = 138 + heading.length * 53;
  const subtitleY = y;
  y += 55;
  const cards = view.items.map((item, index) => {
    const labels = lines(item.label);
    const cardHeight = (item.badge ? 110 : 65) + labels.length * 39;
    const top = y;
    y += cardHeight + 18;
    return `<rect x="40" y="${top}" width="820" height="${cardHeight}" rx="18" fill="#172337"/>
      ${item.badge ? `<circle cx="76" cy="${top + 35}" r="10" fill="${item.badge.color}"/>` :
        `<text x="65" y="${top + 46}" font-size="28" fill="#61A9BD">${index + 1}</text>`}
      ${labels.map((line, i) => `<text x="108" y="${top + 44 + i * 39}" font-size="32" font-weight="600" fill="${item.badge?.color ?? "#F8FAFC"}">${escapeHtml(line)}</text>`).join("")}
      ${item.badge ? `<text x="108" y="${top + 45 + labels.length * 39}" font-size="27" font-weight="600" fill="${item.badge.color}">${escapeHtml(item.badge.label)}</text>` : ""}
      <text x="108" y="${top + (item.badge ? 87 : 51) + labels.length * 39}" font-size="25" fill="#94A3B8">${escapeHtml(item.detail)}</text>`;
  }).join("");
  if (!view.items.length) y += 150;
  const height = Math.max(560, y + 145);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="900" height="${height}">
    <rect width="900" height="${height}" fill="#0B1220"/>
    <g font-family="DejaVu Sans, Arial, sans-serif">
    <text x="52" y="57" font-size="25" letter-spacing="3" fill="#94A3B8">KALSHI · LIVE DASHBOARD</text>
    ${heading.map((line, i) => `<text x="52" y="${126 + i * 53}" font-size="44" font-weight="700" fill="#F8FAFC">${escapeHtml(line)}</text>`).join("")}
    <text x="52" y="${subtitleY}" font-size="28" fill="#CBD5E1">${escapeHtml(view.subtitle)}</text>
    ${cards}
    ${view.items.length ? "" : `<text x="52" y="${subtitleY + 100}" font-size="28" fill="#CBD5E1">${view.historical ? "Sin partidos en Historial para este rango." : "Sin partidos vigentes para este rango."}</text>`}
    <text x="52" y="${height - 85}" font-size="25" fill="#61A9BD">${escapeHtml(view.status)}</text>
    <text x="52" y="${height - 42}" font-size="25" fill="#94A3B8">Use the buttons below · Page ${view.page + 1} of ${view.pages}</text>
    </g>
  </svg>`;
}
