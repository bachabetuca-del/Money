import type { TradeBand } from "./kalshi-trade-bands";
import { historyPlotSvg } from "./telegram-history-plot";

export const MARKET_CARD_VERSION = 2;

export type MarketCardTrade = {
  eventTitle: string | null;
  marketTitle: string | null;
  outcomeSide: string;
  price: number;
  count: number;
  notional: number;
  createdTime: Date;
};

export function escapeHtml(value: string) {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&apos;");
}

export function readableBet(title: string) {
  return title.trim().replace(/\?$/, "")
    .replace(/ wins by over /i, " to win by more than ")
    .replace(/ wins$/i, " to win");
}

function money(value: number, compact = false) {
  if (compact && value >= 1_000_000) return `$${(value / 1_000_000).toFixed(1)}m`;
  if (compact && value >= 1000) return `$${(value / 1000).toFixed(1)}k`;
  return value.toLocaleString("en-US", {
    style: "currency", currency: "USD",
    minimumFractionDigits: Number.isInteger(value) ? 0 : 2,
    maximumFractionDigits: 2,
  });
}

function wrappedText(
  text: string, x: number, y: number, fontSize: number,
  maxChars: number, color = "#F8FAFC", weight = 600,
) {
  const words = text.split(/\s+/);
  const lines: string[] = [];
  let line = "";
  for (const word of words) {
    if (line && `${line} ${word}`.length > maxChars) {
      lines.push(line);
      line = word;
    } else {
      line = line ? `${line} ${word}` : word;
    }
  }
  if (line) lines.push(line);
  const lineHeight = fontSize * 1.22;
  return {
    svg: lines.map((value, index) =>
      `<text x="${x}" y="${y + index * lineHeight}" font-size="${fontSize}" font-weight="${weight}" fill="${color}">${escapeHtml(value)}</text>`,
    ).join(""),
    height: lines.length * lineHeight,
  };
}

export function marketCardCaption(trade: MarketCardTrade) {
  const side = trade.outcomeSide.toLowerCase();
  const position = side === "yes" ? "YES · FOR" : side === "no" ? "NO · AGAINST" : "Direction unavailable";
  return [
    `<b>${escapeHtml(trade.eventTitle ?? "Game details unavailable")}</b>`,
    `${position}: ${escapeHtml(readableBet(trade.marketTitle ?? "Bet details unavailable"))}`,
    "<i>Public taker direction—not trader identity. Updates in place.</i>",
  ].join("\n");
}

export function marketCardSvg(trades: MarketCardTrade[], threshold: number, filterLabel?: string, band: TradeBand = "large", now = new Date()) {
  if (!trades.length) throw new Error("A market card needs at least one trade.");
  const ordered = [...trades].sort((a, b) => a.createdTime.getTime() - b.createdTime.getTime());
  const latest = ordered[ordered.length - 1];
  const side = latest.outcomeSide.toLowerCase();
  const sideColor = side === "no" ? "#FFB13B" : side === "yes" ? "#4FDDE8" : "#B4BDBA";
  const sideText = side === "yes" ? "YES  /  FOR THIS BET" : side === "no" ? "NO  /  AGAINST THIS BET" : "DIRECTION UNAVAILABLE";
  const game = wrappedText(latest.eventTitle ?? "Game details unavailable", 52, 125, 46, 28, "#F4F1E6", 700);
  const betY = 125 + game.height + 30;
  const bet = wrappedText(readableBet(latest.marketTitle ?? "Bet details unavailable"), 52, betY + 46, 39, 33, "#D9E2DC");
  const panelY = betY + 46 + bet.height + 22;
  const chartTitleY = panelY + 350;
  const chartTop = chartTitleY + 150;
  const chartBottom = chartTop + 360;
  const height = chartBottom + 270;
  const history = historyPlotSvg(ordered, now, chartTop, chartBottom);
  const timestamp = latest.createdTime.toLocaleString("en-US", {
    timeZone: "America/New_York", month: "short", day: "numeric",
    hour: "numeric", minute: "2-digit", timeZoneName: "short",
  });
  const count = latest.count.toLocaleString("en-US", { maximumFractionDigits: 2 });
  const cents = (latest.price * 100).toLocaleString("en-US", { maximumFractionDigits: 2 });
  const ly = chartBottom + 115;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="900" height="${height}" viewBox="0 0 900 ${height}">
    <rect width="900" height="${height}" fill="#0C1714"/>
    <rect width="900" height="14" fill="${sideColor}"/>
    <g font-family="DejaVu Sans, Arial, sans-serif">
      <text x="52" y="62" font-size="25" font-weight="700" letter-spacing="3" fill="#8FA39C">KALSHI · SPORTS ALERT</text>
      ${game.svg}
      <text x="52" y="${betY}" font-size="24" font-weight="700" fill="#8FA39C" letter-spacing="3">THE BET</text>
      ${bet.svg}
      <rect x="36" y="${panelY}" width="828" height="300" rx="24" fill="#15251F"/>
      <rect x="36" y="${panelY}" width="14" height="300" rx="7" fill="${sideColor}"/>
      <text x="76" y="${panelY + 50}" font-size="26" font-weight="700" fill="#A9B8B3" letter-spacing="1">${band === "medium" ? "LATEST $5k–$10k TRADE" : "LATEST LARGE TRADE"} · ONE TRADE</text>
      <text x="76" y="${panelY + 138}" font-size="84" font-weight="700" fill="#F4F1E6">${escapeHtml(money(latest.notional))}</text>
      <text x="76" y="${panelY + 190}" font-size="32" font-weight="700" fill="${sideColor}">${sideText}</text>
      <text x="76" y="${panelY + 238}" font-size="30" fill="#E8EDE9">${count} contracts at ${cents}¢</text>
      <text x="76" y="${panelY + 275}" font-size="25" fill="#A9B8B3">${escapeHtml(timestamp)}</text>
      <text x="52" y="${chartTitleY}" font-size="36" font-weight="700" fill="#F4F1E6">Money traded per ${history.widthLabel}</text>
      <text x="52" y="${chartTitleY + 42}" font-size="26" fill="#A9B8B3">Total value per interval · not individual trades.</text>
      <text x="52" y="${chartTitleY + 94}" font-size="28" font-weight="700" fill="#E8EDE9">${ordered.length.toLocaleString("en-US")} trades · ${history.recentCount.toLocaleString("en-US")} in last 15m · ${escapeHtml(money(history.total, true))} total</text>
      ${history.svg}
      <rect x="52" y="${ly - 22}" width="20" height="30" fill="#2F7F88"/><rect x="72" y="${ly - 22}" width="20" height="30" fill="#4FDDE8"/>
      <text x="106" y="${ly + 4}" font-size="27" font-weight="700" fill="#E8EDE9">YES / FOR</text>
      <rect x="330" y="${ly - 22}" width="20" height="30" fill="#9A6420"/><rect x="350" y="${ly - 22}" width="20" height="30" fill="#FFB13B"/>
      <text x="384" y="${ly + 4}" font-size="27" font-weight="700" fill="#E8EDE9">NO / AGAINST</text>
      <text x="52" y="${ly + 50}" font-size="25" fill="#E8EDE9">Dark = older · Bright = last 15 min</text>
      <text x="52" y="${ly + 88}" font-size="25" fill="#E8EDE9">Outlined bar = interval of the latest trade</text>
      <text x="52" y="${ly + 132}" font-size="24" fill="#8FA39C">${escapeHtml(filterLabel ?? `Trades ≥ ${money(threshold)}`)} · New York time</text>
    </g>
  </svg>`;
}
