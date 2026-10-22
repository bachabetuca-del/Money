import type { TradeBand } from "./kalshi-trade-bands";

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

export function marketCardSvg(trades: MarketCardTrade[], threshold: number, filterLabel?: string, band: TradeBand = "large") {
  if (!trades.length) throw new Error("A market card needs at least one trade.");
  const ordered = [...trades].sort((a, b) => a.createdTime.getTime() - b.createdTime.getTime());
  const latest = ordered[ordered.length - 1];
  const shown = ordered.slice(-6);
  const side = latest.outcomeSide.toLowerCase();
  const sideColor = side === "no" ? "#E98E2E" : side === "yes" ? "#61A9BD" : "#979797";
  const sideText = side === "yes" ? "YES  /  FOR THIS BET" : side === "no" ? "NO  /  AGAINST THIS BET" : "DIRECTION UNAVAILABLE";
  const game = wrappedText(latest.eventTitle ?? "Game details unavailable", 52, 117, 45, 29);
  const betY = 117 + game.height + 28;
  const bet = wrappedText(readableBet(latest.marketTitle ?? "Bet details unavailable"), 52, betY + 44, 39, 33, "#E2E8F0");
  const panelY = betY + 44 + bet.height + 24;
  const chartTitleY = panelY + 340;
  const chartTop = chartTitleY + 90;
  const chartBottom = chartTop + 255;
  const chartLeft = 120;
  const chartRight = 836;
  const height = chartBottom + 185;
  const maxValue = Math.max(...shown.map(trade => trade.notional));
  const unit = Math.pow(10, Math.floor(Math.log10(Math.max(maxValue, 1))));
  const ceiling = Math.ceil(maxValue / unit) * unit * 1.15;
  const columnWidth = (chartRight - chartLeft) / shown.length;
  const barWidth = Math.min(72, columnWidth * 0.58);
  const grid = [0, 0.5, 1].map(fraction => {
    const y = chartBottom - fraction * (chartBottom - chartTop);
    return `<line x1="${chartLeft}" y1="${y}" x2="${chartRight}" y2="${y}" stroke="#334155" stroke-width="2"/>
      <text x="${chartLeft - 18}" y="${y + 10}" text-anchor="end" font-size="27" fill="#94A3B8">${escapeHtml(money(ceiling * fraction, true))}</text>`;
  }).join("");
  const bars = shown.map((trade, index) => {
    const x = chartLeft + columnWidth * (index + 0.5);
    const barHeight = (trade.notional / ceiling) * (chartBottom - chartTop);
    const y = chartBottom - barHeight;
    const color = trade.outcomeSide === "yes" ? "#61A9BD" : trade.outcomeSide === "no" ? "#E98E2E" : "#979797";
    const time = trade.createdTime.toLocaleTimeString("en-US", {
      timeZone: "America/New_York", hour: "numeric", minute: "2-digit", hour12: false,
    });
    return `<rect x="${x - barWidth / 2}" y="${y}" width="${barWidth}" height="${barHeight}" rx="8" fill="${color}"/>
      <text x="${x}" y="${y - 16}" text-anchor="middle" font-size="26" font-weight="700" fill="#F8FAFC">${escapeHtml(money(trade.notional, true))}</text>
      <text x="${x}" y="${chartBottom + 40}" text-anchor="middle" font-size="25" fill="#CBD5E1">${time}</text>`;
  }).join("");
  const timestamp = latest.createdTime.toLocaleString("en-US", {
    timeZone: "America/New_York", month: "short", day: "numeric",
    hour: "numeric", minute: "2-digit", timeZoneName: "short",
  });
  const count = latest.count.toLocaleString("en-US", { maximumFractionDigits: 2 });
  const cents = (latest.price * 100).toLocaleString("en-US", { maximumFractionDigits: 2 });
  const shownLabel = ordered.length > shown.length ? `Last ${shown.length} of ${ordered.length} tracked trades` : `${ordered.length} tracked ${ordered.length === 1 ? "trade" : "trades"}`;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="900" height="${height}" viewBox="0 0 900 ${height}">
    <rect width="900" height="${height}" fill="#0B1220"/>
    <g font-family="DejaVu Sans, Arial, sans-serif">
      <rect x="52" y="37" width="8" height="23" rx="4" fill="#61A9BD"/>
      <text x="77" y="57" font-size="25" font-weight="700" letter-spacing="3" fill="#94A3B8">KALSHI · SPORTS</text>
      ${game.svg}
      <text x="52" y="${betY}" font-size="25" fill="#94A3B8" letter-spacing="2">THE BET</text>
      ${bet.svg}
      <rect x="36" y="${panelY}" width="828" height="286" rx="24" fill="#172337"/>
      <text x="64" y="${panelY + 48}" font-size="26" fill="#CBD5E1" letter-spacing="1">${band === "medium" ? "LATEST $5k–$10k TRADE" : "LATEST LARGE TRADE"}</text>
      <text x="64" y="${panelY + 131}" font-size="78" font-weight="700" fill="#FFFFFF">${escapeHtml(money(latest.notional))}</text>
      <text x="64" y="${panelY + 181}" font-size="31" font-weight="700" fill="${sideColor}">${sideText}</text>
      <text x="64" y="${panelY + 227}" font-size="29" fill="#E2E8F0">${count} contracts at ${cents}¢</text>
      <text x="64" y="${panelY + 264}" font-size="25" fill="#94A3B8">${escapeHtml(timestamp)}</text>
      <text x="52" y="${chartTitleY}" font-size="34" font-weight="700" fill="#F8FAFC">${band === "medium" ? "$5k–$10k trades over time" : "Large trades over time"}</text>
      <text x="52" y="${chartTitleY + 42}" font-size="27" fill="#94A3B8">${shownLabel} · trade value in USD</text>
      ${grid}${bars}
      <circle cx="68" cy="${chartBottom + 94}" r="9" fill="#61A9BD"/>
      <text x="89" y="${chartBottom + 103}" font-size="27" fill="#CBD5E1">YES / FOR</text>
      <circle cx="332" cy="${chartBottom + 94}" r="9" fill="#E98E2E"/>
      <text x="353" y="${chartBottom + 103}" font-size="27" fill="#CBD5E1">NO / AGAINST</text>
      <text x="52" y="${chartBottom + 155}" font-size="25" fill="#94A3B8">${escapeHtml(filterLabel ?? `Trades ≥ ${money(threshold)}`)} · New York time</text>
    </g>
  </svg>`;
}
