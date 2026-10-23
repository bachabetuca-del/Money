import { createHash } from "node:crypto";
import { escapeHtml, betLabelEs } from "./telegram-market-card";
import { tradeRange, type TradeBand } from "./kalshi-trade-bands";
import { gameBadge } from "./kalshi-game-status";
import { gameDateLabel } from "./telegram-game-date";
import { gameScope, scopedCatalog, type GameScope } from "./telegram-game-scope";
import { spanishRange } from "./telegram-dashboard-caption";

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
      betLabel: betLabelEs(row.marketTitle),
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
    [{ text: "Mercados", callback_data: "d:back" }, { text: "Deportes", callback_data: "d:home" }],
    [{ text: "Abrir en Kalshi", url: marketUrl }, { text: "Actualizar", callback_data: "d:refresh" }],
  ] };
}

export function scopeButtons(selection: Selection): Button[] {
  return [
    { text: `${selection.scope !== "history" ? "• " : ""}Vigentes · 48 h`, callback_data: "d:scope:active" },
    { text: `${selection.scope === "history" ? "• " : ""}Historial`, callback_data: "d:scope:history" },
  ];
}

export function catalogGameBadge(markets: MarketSummary[], now?: Date) {
  const confirmed = markets.filter(m => m.gameState && m.gameState !== "unknown" && m.gameSource !== "market")
    .sort((a, b) => (b.gameCheckedAt ?? "").localeCompare(a.gameCheckedAt ?? ""));
  const latest = confirmed[0];
  if (latest?.gameState === "live" && now) {
    const checked = latest.gameCheckedAt ? new Date(latest.gameCheckedAt).getTime() : NaN;
    if (latest.gameDelayed || !Number.isFinite(checked) || now.getTime() - checked > 5 * 60_000 || checked > now.getTime() + 60_000) {
      return gameBadge("unknown", latest.gameSource, true);
    }
  }
  if (latest) return gameBadge(latest.gameState, latest.gameSource, latest.gameDelayed);
  if (markets.length && markets.every(m => m.gameState === "finished")) return gameBadge("finished", "market");
  return gameBadge("unknown");
}

type MenuItem = { label: string; detail: string; action: string; badge?: ReturnType<typeof gameBadge>; buttonLabel?: string };
function spanishSportName(sport: string) {
  const names: Record<string, string> = {
    Football: "Fútbol americano", Basketball: "Baloncesto", Baseball: "Béisbol",
    Soccer: "Fútbol", Hockey: "Hockey", Tennis: "Tenis", Golf: "Golf", Combat: "Combate",
  };
  return names[sport] ?? sport;
}
export function menuView(selection: Selection, catalog: CatalogMarket[], enabled: boolean, threshold: number, now = new Date()) {
  const historical = selection.scope === "history";
  catalog = scopedCatalog(catalog, historical ? "history" : "active", now);
  const activeRange = spanishRange(tradeRange(selection.band, threshold));
  let title = "Elige un deporte";
  let subtitle = `${activeRange} · toca un deporte`;
  let items: MenuItem[];
  const sportMarkets = catalog.filter(m => m.sportKey === selection.sportKey);
  if (selection.screen === "games") {
    title = spanishSportName(sportMarkets[0]?.sport ?? "Partidos");
    subtitle = `${activeRange} · elige un partido`;
    const grouped = new Map<string, CatalogMarket[]>();
    for (const market of sportMarkets) grouped.set(market.gameKey, [...(grouped.get(market.gameKey) ?? []), market]);
    items = [...grouped].map(([key, markets]) => ({
      label: markets[0].gameLabel,
      buttonLabel: markets[0].gameLabel,
      detail: `${markets.length} ${markets.length === 1 ? "mercado" : "mercados"} · ${markets.reduce((sum, m) => sum + m.trades, 0)} operaciones`,
      action: `d:game:${key}`,
      badge: catalogGameBadge(markets, now),
    })).sort((a, b) => a.badge.rank - b.badge.rank);
  } else if (selection.screen === "markets") {
    title = sportMarkets.find(m => m.gameKey === selection.gameKey)?.gameLabel ?? "Mercados";
    subtitle = `${activeRange} · elige una apuesta`;
    const badge = catalogGameBadge(sportMarkets.filter(m => m.gameKey === selection.gameKey), now);
    items = sportMarkets.filter(m => m.gameKey === selection.gameKey).map(m => ({
      label: m.betLabel, detail: `${m.trades} ${m.trades === 1 ? "operación" : "operaciones"}${m.marketTerminal ? " · mercado cerrado" : ""}`,
      action: `d:market:${m.id}`,
      badge,
    }));
  } else {
    const sports = [...new Set(catalog.map(m => m.sport))].sort();
    items = sports.map(sport => {
      const markets = catalog.filter(m => m.sport === sport);
      return {
        label: spanishSportName(sport),
        detail: `${new Set(markets.map(m => m.gameKey)).size} partidos · ${markets.length} mercados`,
        action: `d:sport:${markets[0].sportKey}`,
      };
    });
  }
  const pages = Math.max(1, Math.ceil(items.length / PAGE_SIZE));
  const page = Math.max(0, Math.min(selection.page, pages - 1));
  const visible = items.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);
  const keyboard: Keyboard = { inline_keyboard: [
    ...visible.map(item => [{ text: (item.badge
      ? item.buttonLabel ? `${item.badge.marker} ${item.buttonLabel.slice(0, 92)}` :
        `${item.badge.marker} ${item.label.slice(0, 67)} · ${item.badge.label}`
      : item.label).slice(0, 120), callback_data: item.action }]),
  ] };
  const paging: Button[] = [];
  if (page > 0) paging.push({ text: "Anterior", callback_data: `d:page:${page - 1}` });
  if (page < pages - 1) paging.push({ text: "Siguiente", callback_data: `d:page:${page + 1}` });
  if (paging.length) keyboard.inline_keyboard.push(paging);
  keyboard.inline_keyboard.push(bandButtons(selection.band, threshold), scopeButtons(selection));
  if (selection.screen !== "sports") keyboard.inline_keyboard.push([
    { text: "‹ Volver", callback_data: "d:back" }, { text: "Deportes", callback_data: "d:home" },
  ]);
  keyboard.inline_keyboard.push([{ text: "Actualizar", callback_data: "d:refresh" }]);
  title = `${historical ? "Historial" : "Vigentes"} · ${title}`;
  const status = historical ? "HISTORIAL · datos guardados" : enabled ? "ACTIVO · se actualiza cada 15 segundos" : "PAUSADO · datos guardados";
  const step = selection.screen === "games" ? 2 : selection.screen === "markets" ? 3 : 1;
  const steps = ["Deporte", "Partido", "Mercado"];
  const trail = steps.map((s, i) => i + 1 === step ? `<b>${i + 1} ${s}</b>` : `${i + 1} ${s}`).join(" › ");
  const caption = `<b>${escapeHtml(title)}</b>\n${trail}\n` +
    `Filtro: <b>${historical ? "Historial" : "Vigentes"}</b> · <b>${escapeHtml(activeRange)}</b>\n` +
    (historical ? "Partidos anteriores con operaciones guardadas.\n" :
      "Partidos en juego o programados en las próximas 48 h.\n") +
    "⚪ Por empezar · 🟡 En juego · 🔴 Terminado\n" +
    `<i>${status}</i>`;
  return { title, subtitle, items: visible, page, pages, keyboard, caption, status, historical, step, steps };
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
  y += 50;
  const stepperY = y;
  const stepper = view.steps.map((s, i) => {
    const on = i + 1 === view.step;
    return `<text x="${52 + i * 270}" y="${stepperY}" font-size="26" font-weight="${on ? 700 : 400}" fill="${on ? "#61A9BD" : "#64748B"}">${i + 1} ${s}${i < 2 ? "  ›" : ""}</text>`;
  }).join("");
  y += 45;
  const cards = view.items.map((item, index) => {
    const labels = lines(item.label);
    const cardHeight = (item.badge ? 110 : 65) + labels.length * 39;
    const top = y;
    y += cardHeight + 18;
    return `<rect x="40" y="${top}" width="820" height="${cardHeight}" rx="18" fill="#172337"/>
      ${item.badge ? `<circle cx="76" cy="${top + 35}" r="10" fill="${item.badge.color}"/>` :
        `<text x="65" y="${top + 46}" font-size="28" fill="#61A9BD">${index + 1}</text>`}
      ${labels.map((line, i) => `<text x="108" y="${top + 44 + i * 39}" font-size="32" font-weight="600" fill="#F8FAFC">${escapeHtml(line)}</text>`).join("")}
      ${item.badge ? `<text x="108" y="${top + 45 + labels.length * 39}" font-size="27" font-weight="600" fill="${item.badge.color}">${escapeHtml(item.badge.label)}</text>` : ""}
      <text x="108" y="${top + (item.badge ? 87 : 51) + labels.length * 39}" font-size="25" fill="#94A3B8">${escapeHtml(item.detail)}</text>`;
  }).join("");
  if (!view.items.length) y += 150;
  const height = Math.max(560, y + 145);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="900" height="${height}">
    <rect width="900" height="${height}" fill="#0B1220"/>
    <g font-family="DejaVu Sans, Arial, sans-serif">
    <text x="52" y="57" font-size="25" letter-spacing="3" fill="#94A3B8">KALSHI · ACTIVIDAD DEPORTIVA</text>
    ${heading.map((line, i) => `<text x="52" y="${126 + i * 53}" font-size="44" font-weight="700" fill="#F8FAFC">${escapeHtml(line)}</text>`).join("")}
    <text x="52" y="${subtitleY}" font-size="28" fill="#CBD5E1">${escapeHtml(view.subtitle)}</text>
    ${stepper}
    ${cards}
    ${view.items.length ? "" : lines(view.historical ? "Sin partidos en Historial para este rango." :
      "Sin partidos en juego o programados en las próximas 48 horas para este rango.", 48)
      .map((line, i) => `<text x="52" y="${subtitleY + 150 + i * 38}" font-size="28" fill="#CBD5E1">${escapeHtml(line)}</text>`).join("")}
    <text x="52" y="${height - 85}" font-size="25" fill="#61A9BD">${escapeHtml(view.status)}</text>
    <text x="52" y="${height - 42}" font-size="25" fill="#94A3B8">Toca una opción abajo · Página ${view.page + 1} de ${view.pages}</text>
    </g>
  </svg>`;
}
