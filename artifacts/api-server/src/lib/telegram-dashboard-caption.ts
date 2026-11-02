import { CAPTURE_MINIMUM, type TradeRange } from "./kalshi-trade-bands";
import { escapeHtml, marketCardCaption, type MarketCardTrade } from "./telegram-market-card";
import { NOTIFICATION_MIN_ROI_PCT, type RoiBasis } from "./telegram-notification-roi";

export function spanishRange(range: TradeRange) {
  const amount = (value: number) => `$${value.toLocaleString("en-US")}`;
  return range.maximum === null ? `≥ ${amount(range.minimum)}` :
    `${range.minimumInclusive ? "≥" : ">"} ${amount(range.minimum)} y ${range.maximumInclusive ? "≤" : "<"} ${amount(range.maximum)}`;
}

function shortName(value: string | null, limit: number) {
  if (value === null) return null;
  const characters = Array.from(value);
  return characters.length <= limit ? value : `${characters.slice(0, limit - 1).join("")}…`;
}

type CaptionOptions = {
  trade: MarketCardTrade;
  historical: boolean;
  stopped: boolean;
  confirmedClosed: boolean;
  enabled: boolean;
  gameDate: string;
  statusLabel: string;
  checkedAt?: string;
  gameResult?: string | null;
  scoreStatus?: string;
  scoreMessage?: string | null;
  range: TradeRange;
  history?: { phase: string; error: boolean; scanned: number };
  notificationRoiBasis?: RoiBasis;
};

/** Bound user/provider names before HTML escaping; never cut an HTML tag/entity.
 * The full names remain visible in the rendered image. Telegram allows 1024
 * characters after entity parsing in a photo caption.
 */
export function dashboardChartCaption(options: CaptionOptions) {
  const { trade, historical, stopped, enabled, range, history } = options;
  const checked = options.checkedAt ? new Date(options.checkedAt) : null;
  const statusTime = checked && Number.isFinite(checked.getTime()) ? checked.toLocaleString("es-ES", {
    timeZone: "America/New_York", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit",
  }) : null;
  const lines = [
    marketCardCaption({ ...trade, eventTitle: shortName(trade.eventTitle, 96), marketTitle: shortName(trade.marketTitle, 160) },
      !stopped && enabled),
    `<b>${historical ? "Historial · datos guardados" : enabled ? "Vigentes" : "Vigentes · seguimiento pausado"}</b>`,
    `Partido: ${escapeHtml(options.gameDate)} · ${escapeHtml(options.statusLabel)}`,
    ...(historical ? [
      `Marcador final: ${escapeHtml(shortName(options.gameResult ??
        options.scoreMessage ??
        (options.scoreStatus === "unavailable" ? "No disponible en la fuente" : "Pendiente de cargar"), 240)!)}`,
    ] : []),
    ...(statusTime ? [`Estado consultado: ${statusTime} · Nueva York`] : []),
    `Rango: ${escapeHtml(spanishRange(range))}.`,
  ];
  if (stopped) {
    lines.push(options.confirmedClosed ? "Mercado cerrado o partido terminado; sin consultas automáticas." :
      "Archivado por fecha; no confirma que haya terminado.");
    lines.push("Historial guardado, sin indicadores de actividad en vivo.");
  } else {
    if (history) lines.push(history.error ? "Historial incompleto; se reintentará automáticamente." :
      history.phase === "complete" ? "Histórico público disponible cargado." :
      !enabled ? "Carga del histórico pausada." : "Cargando histórico; la gráfica aún es parcial.");
    lines.push("Barras: suma por intervalo, no una sola operación.");
    lines.push("Recientes: ejecutadas en los últimos 15 minutos.");
    lines.push(enabled ? "Se actualiza aquí cada 15 segundos." : "Seguimiento pausado; se muestran datos guardados.");
  }
  lines.push(`Avisos: nuevas desde $${CAPTURE_MINIMUM.toLocaleString("en-US")} y ROI ${options.notificationRoiBasis === "net" ? "neto estimado" : "bruto"} histórico ≥ +${NOTIFICATION_MIN_ROI_PCT.toFixed(1).replace(".", ",")}%; solo el último.`);
  return lines.join("\n");
}
