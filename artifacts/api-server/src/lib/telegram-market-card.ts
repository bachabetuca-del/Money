import type { TradeBand } from "./kalshi-trade-bands";
import { chartDefs, DIRECTION_COLORS, historyPlotSvg, intervalLabelEs, RECENT_WINDOW_MS } from "./telegram-history-plot";
import { elapsed, exactMoney, fitSize, nyDateTime, textBlock } from "./telegram-card-format";
import { publicDirection, directionLabel, directionMeaning, DIRECTION_NOTE } from "./telegram-trade-direction";

export const MARKET_CARD_VERSION = 5;

export type MarketCardTrade = {
  eventTitle: string | null;
  marketTitle: string | null;
  outcomeSide: string;
  bookSide?: string;
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

/** Translate only recognized bet phrases; preserve unfamiliar provider wording. */
export function betLabelEs(title: string) {
  return readableBet(title)
    .replace(/ to win by more than ([\d.,-]+) points$/i, " gana por más de $1 puntos")
    .replace(/ to win$/i, " gana")
    .replace(/^Over ([\d.,]+) points$/i, "Más de $1 puntos")
    .replace(/^Under ([\d.,]+) points$/i, "Menos de $1 puntos");
}

export function marketCardCaption(trade: MarketCardTrade, live = true) {
  const side = publicDirection(trade.outcomeSide, undefined, trade.bookSide);
  const position = directionLabel(side);
  return [
    `<b>${escapeHtml(trade.eventTitle ?? "Partido no disponible")}</b>`,
    `${position}${side === "unknown" ? " · " : " «"}${escapeHtml(betLabelEs(trade.marketTitle ?? "Apuesta no disponible"))}${side === "unknown" ? "" : "»"}`,
    side === "unknown" ? "" : directionMeaning(side),
    `<i>${DIRECTION_NOTE} ${live ? "Se actualiza aquí." : "Historial guardado."}</i>`,
  ].filter(Boolean).join("\n");
}

const BG = "#0E1A17";
const PANEL = "#16271F";
const INK = "#F7F3E8";
const SOFT = "#D7E0DA";
const MUTED = "#9FB0A9";
const W = 900;

export function marketCardSvg(trades: MarketCardTrade[], threshold: number, filterLabel?: string, band: TradeBand = "large", now = new Date(),
  gameStatus?: { label: string; color: string; stopped?: boolean }) {
  if (!trades.length) throw new Error("A market card needs at least one trade.");
  const ordered = [...trades].sort((a, b) => a.createdTime.getTime() - b.createdTime.getTime());
  const latest = ordered[ordered.length - 1];
  const first = ordered[0];
  const live = !gameStatus?.stopped;
  const side = publicDirection(latest.outcomeSide, undefined, latest.bookSide);
  const sideIndex = side === "yes" ? 0 : side === "no" ? 1 : 2;
  const sideColor = DIRECTION_COLORS[sideIndex];
  const sideText = side === "yes" ? "SÍ · A FAVOR DE LA APUESTA" : side === "no" ? "NO · EN CONTRA DE LA APUESTA" : "DIRECCIÓN NO DISPONIBLE";

  // Direction totals from actual input.
  const sums = [0, 0, 0];
  const counts = [0, 0, 0];
  let recentSum = 0;
  for (const trade of ordered) {
    const d = publicDirection(trade.outcomeSide, undefined, trade.bookSide);
    const i = d === "yes" ? 0 : d === "no" ? 1 : 2;
    sums[i] += trade.notional; counts[i] += 1;
    const t = trade.createdTime.getTime();
    if (live && t >= now.getTime() - RECENT_WINDOW_MS && t <= now.getTime()) recentSum += trade.notional;
  }

  const parts: string[] = [];
  let y = 64;
  parts.push(`<text x="52" y="${y}" font-size="25" font-weight="700" letter-spacing="3" fill="${MUTED}">KALSHI · OPERACIONES GRANDES</text>`);
  if (gameStatus) {
    y += 42;
    parts.push(`<text x="52" y="${y}" font-size="25" font-weight="700" fill="${gameStatus.color}">${escapeHtml(gameStatus.label)}</text>`);
  }
  y += 62;
  const game = textBlock(latest.eventTitle ?? "Partido no disponible", 52, y, 44, 796, INK, 700, Infinity);
  parts.push(game.svg); y += game.height + 14;
  parts.push(`<text x="52" y="${y}" font-size="24" font-weight="700" letter-spacing="3" fill="${MUTED}">LA APUESTA</text>`);
  y += 44;
  const bet = textBlock(betLabelEs(latest.marketTitle ?? "Apuesta no disponible"), 52, y, 36, 796, SOFT, 600, Infinity);
  parts.push(bet.svg); y += bet.height + 6;

  // Latest single trade panel.
  const panelY = y;
  const amount = exactMoney(latest.notional);
  const amountSize = fitSize(amount, 740, 80, 48);
  const count = latest.count.toLocaleString("en-US", { maximumFractionDigits: 2 });
  const cents = (latest.price * 100).toLocaleString("en-US", { maximumFractionDigits: 2 });
  const age = now.getTime() - latest.createdTime.getTime();
  const ageText = live ? (age < 0 ? "Hora futura; sin confirmar" : age <= RECENT_WINDOW_MS ? `${elapsed(age)} · reciente` : elapsed(age)) : "Historial guardado";
  const panelH = 370;
  parts.push(`<rect x="36" y="${panelY}" width="828" height="${panelH}" rx="22" fill="${PANEL}"/>
    <rect x="36" y="${panelY}" width="12" height="${panelH}" rx="6" fill="${sideColor}"/>
    <text x="74" y="${panelY + 48}" font-size="25" font-weight="700" letter-spacing="1" fill="${MUTED}">ÚLTIMA OPERACIÓN · INDIVIDUAL</text>
    <text x="74" y="${panelY + 58 + amountSize}" font-size="${amountSize}" font-weight="700" fill="${INK}">${escapeHtml(amount)}</text>
    <text x="74" y="${panelY + 186}" font-size="31" font-weight="700" fill="${sideColor}">${sideText}</text>
    <text x="74" y="${panelY + 224}" font-size="27" fill="${SOFT}">${escapeHtml(directionMeaning(side))}</text>
    <text x="74" y="${panelY + 270}" font-size="29" fill="${SOFT}">${count} contratos a ${cents}¢</text>
    <text x="74" y="${panelY + 310}" font-size="26" fill="${MUTED}">${escapeHtml(nyDateTime(latest.createdTime))} · Nueva York</text>
    <text x="74" y="${panelY + 346}" font-size="25" fill="${MUTED}">${ageText}</text>`);
  y = panelY + panelH + 58;

  // Totals for the selected range.
  parts.push(`<text x="52" y="${y}" font-size="34" font-weight="700" fill="${INK}">Total en el rango elegido</text>`);
  y += 40;
  parts.push(`<text x="52" y="${y}" font-size="26" fill="${MUTED}">${escapeHtml(filterLabel ??
    (band === "medium" ? "Operaciones > $5,000 y < $10,000" : `Operaciones ≥ ${exactMoney(threshold)}`))}</text>`);
  y += 30;
  const grand = sums[0] + sums[1] + sums[2];
  const totalLabel = `${ordered.length.toLocaleString("en-US")} ${ordered.length === 1 ? "operación" : "operaciones"} · total`;
  let bx = 52;
  const barW = 796;
  const fills = ["url(#dirYes)", "url(#dirNo)", "url(#dirUnknown)"];
  const share: string[] = [];
  for (let i = 0; i < 3; i++) {
    if (!sums[i]) continue;
    const w = grand ? sums[i] / grand * barW : 0;
    share.push(`<rect x="${bx}" y="${y}" width="${w}" height="22" fill="${fills[i]}"/>`);
    bx += w;
  }
  parts.push(`<rect x="52" y="${y}" width="${barW}" height="22" rx="4" fill="#24362F"/>${share.join("")}`);
  y += 66;
  const rows: [string, number][] = [["A favor (SÍ)", 0], ["En contra (NO)", 1]];
  if (counts[2]) rows.push(["Dirección sin dato", 2]);
  for (const [label, i] of rows) {
    const pct = grand ? Math.round(sums[i] / grand * 100) : 0;
    parts.push(`<rect x="52" y="${y - 24}" width="26" height="26" rx="4" fill="${fills[i]}"/>
      <text x="92" y="${y}" font-size="29" font-weight="700" fill="${SOFT}">${label}</text>
      <text x="848" y="${y}" text-anchor="end" font-size="29" font-weight="700" fill="${INK}">${escapeHtml(exactMoney(sums[i]))}</text>
      <text x="92" y="${y + 34}" font-size="24" fill="${MUTED}">${counts[i].toLocaleString("en-US")} ${counts[i] === 1 ? "operación" : "operaciones"} · ${pct}%</text>`);
    y += 82;
  }
  parts.push(`<line x1="52" y1="${y - 30}" x2="848" y2="${y - 30}" stroke="#2C3D38" stroke-width="2"/>
    <text x="52" y="${y + 6}" font-size="${fitSize(totalLabel, 390, 29, 22)}" font-weight="700" fill="${INK}">${totalLabel}</text>
    <text x="848" y="${y + 6}" text-anchor="end" font-size="${fitSize(exactMoney(grand), 360, 31, 22)}" font-weight="700" fill="${INK}">${escapeHtml(exactMoney(grand))}</text>`);
  y += 44;
  const coverage = textBlock(`Datos del ${nyDateTime(first.createdTime)} al ${nyDateTime(latest.createdTime)} (NY)`,
    52, y, 24, 796, MUTED, 400, Infinity);
  parts.push(coverage.svg);
  y += coverage.height + 48;

  // Chart.
  const chartTitleY = y;
  const chartTop = chartTitleY + 192;
  const chartBottom = chartTop + 330;
  const history = historyPlotSvg(ordered, now, chartTop, chartBottom, live);
  parts.push(`<text x="52" y="${chartTitleY}" font-size="34" font-weight="700" fill="${INK}">Dinero por cada ${intervalLabelEs(history.width)}</text>
    <text x="52" y="${chartTitleY + 40}" font-size="26" fill="${MUTED}">Cada barra suma USD de un intervalo.</text>
    <text x="52" y="${chartTitleY + 76}" font-size="26" fill="${MUTED}">El número indica el total de la última barra.</text>`);
  const recentLine = !live ? "Historial guardado · sin actividad en vivo"
    : history.recentCount ? `Últimos 15 min: ${history.recentCount.toLocaleString("en-US")} op. · ${exactMoney(recentSum)}`
    : "Sin operaciones en los últimos 15 min";
  parts.push(`<text x="52" y="${chartTitleY + 114}" font-size="26" font-weight="700" fill="${history.recentCount ? INK : SOFT}">${escapeHtml(recentLine)}</text>`);
  parts.push(history.svg);
  y = chartBottom + 128;

  // Legend: color = direction, stripes = recency, outline = latest trade.
  const legend = (x: number, fill: string, label: string) =>
    `<rect x="${x}" y="${y - 24}" width="28" height="28" rx="4" fill="${fill}"/><text x="${x + 40}" y="${y}" font-size="26" font-weight="700" fill="${SOFT}">${label}</text>`;
  parts.push(legend(52, "url(#dirYes)", "SÍ / a favor") + legend(330, "url(#dirNo)", "NO / en contra") + legend(642, "url(#dirUnknown)", "Sin dato"));
  y += 44;
  parts.push(`<text x="52" y="${y}" font-size="25" fill="${SOFT}">A favor: compra de SÍ o venta de NO</text>`);
  y += 36;
  parts.push(`<text x="52" y="${y}" font-size="25" fill="${SOFT}">En contra: compra de NO o venta de SÍ</text>`);
  y += 46;
  if (live) {
    parts.push(`<rect x="52" y="${y - 24}" width="28" height="28" rx="4" fill="url(#recentYes)"/>
      <text x="92" y="${y}" font-size="25" fill="${SOFT}">Rayado = últimos 15 min · liso = anterior</text>`);
    y += 42;
  }
  parts.push(`<path d="M55 ${y - 22} L77 ${y - 22} L66 ${y - 8} Z" fill="${INK}"/><rect x="54" y="${y - 4}" width="24" height="10" fill="none" stroke="${INK}" stroke-width="3"/>
    <text x="92" y="${y}" font-size="25" fill="${SOFT}">Barra marcada = intervalo de la última operación</text>`);
  y += 52;
  parts.push(`<text x="52" y="${y}" font-size="23" fill="${MUTED}">Dirección pública: no es venta ni cierre confirmado</text>
    <text x="52" y="${y + 32}" font-size="23" fill="${MUTED}">y no identifica al operador. Hora de Nueva York.</text>`);
  const height = y + 64;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${height}" viewBox="0 0 ${W} ${height}">
    ${chartDefs()}
    <rect width="${W}" height="${height}" fill="${BG}"/>
    <rect width="${W}" height="12" fill="${gameStatus?.color ?? sideColor}"/>
    <g font-family="DejaVu Sans, Arial, sans-serif">${parts.join("\n")}</g>
  </svg>`;
}
