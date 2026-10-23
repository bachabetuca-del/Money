import type { MarketCardTrade } from "./telegram-market-card";
import { publicDirection } from "./telegram-trade-direction";
import { axisMoney, nyDay, nyTime } from "./telegram-card-format";

const MINUTE = 60_000;
export const RECENT_WINDOW_MS = 15 * MINUTE;
const widths = [MINUTE, 5 * MINUTE, 15 * MINUTE, 30 * MINUTE,
  60 * MINUTE, 180 * MINUTE, 360 * MINUTE, 720 * MINUTE,
  1440 * MINUTE, 10080 * MINUTE, 43200 * MINUTE];

export type HistoryBucket = {
  start: number;
  values: number[]; // older YES/NO/unknown, then recent YES/NO/unknown
  count: number;
  total: number;
};

export function bucketHistory(trades: MarketCardTrade[], now: Date, highlightRecent = true) {
  if (!trades.length) throw new Error("History requires at least one trade.");
  let oldest = Infinity;
  let latest = -Infinity;
  for (const trade of trades) {
    oldest = Math.min(oldest, trade.createdTime.getTime());
    latest = Math.max(latest, trade.createdTime.getTime());
  }
  // Plot the actual trading period. Quiet markets must not become mostly blank;
  // recency still uses wall-clock time below, never the chart's end timestamp.
  const end = latest + 1;
  const span = Math.max(MINUTE, end - oldest);
  const width = widths.find(value => span / value <= 36) ?? Math.ceil(span / 36);
  const start = Math.floor(oldest / width) * width;
  const buckets: HistoryBucket[] = Array.from({ length: Math.ceil((end - start) / width) }, (_, index) => ({
    start: start + index * width, values: [0, 0, 0, 0, 0, 0], count: 0, total: 0,
  }));
  let recentCount = 0;
  let total = 0;
  for (const trade of trades) {
    const time = trade.createdTime.getTime();
    const recent = highlightRecent && time >= now.getTime() - RECENT_WINDOW_MS && time <= now.getTime();
    const direction = publicDirection(trade.outcomeSide);
    const side = direction === "yes" ? 0 : direction === "no" ? 1 : 2;
    const bucket = buckets[Math.floor((time - start) / width)];
    bucket.values[side + (recent ? 3 : 0)] += trade.notional;
    bucket.total += trade.notional;
    bucket.count += 1;
    total += trade.notional;
    if (recent) recentCount += 1;
  }
  const widthLabel = width < 60 * MINUTE ? `${Math.round(width / MINUTE)} min` :
    width < 1440 * MINUTE ? `${Math.round(width / (60 * MINUTE))} hr` :
    `${Math.round(width / (1440 * MINUTE))} day`;
  return { buckets, start, end: start + buckets.length * width, width, widthLabel,
    recentCount, total, latestIndex: Math.floor((latest - start) / width) };
}

/** Spanish interval label for the chart title. */
export function intervalLabelEs(width: number) {
  if (width < 60 * MINUTE) return `${Math.round(width / MINUTE)} min`;
  if (width < 1440 * MINUTE) { const h = Math.round(width / (60 * MINUTE)); return h === 1 ? "1 hora" : `${h} horas`; }
  if (width === 10080 * MINUTE) return "1 semana";
  if (width === 43200 * MINUTE) return "30 días";
  const d = Math.round(width / (1440 * MINUTE)); return d === 1 ? "1 día" : `${d} días`;
}

// Direction is color; recency is texture (diagonal stripes), never a hue shift.
export const DIRECTION_COLORS = ["#3FC8D4", "#F2A43A", "#8E9995"];
const DIRECTION_FILLS = ["url(#dirYes)", "url(#dirNo)", "url(#dirUnknown)"];
const RECENT_FILLS = ["url(#recentYes)", "url(#recentNo)", "url(#recentUnknown)"];

export function chartDefs() {
  const hatch = (id: string, color: string) => `<pattern id="${id}" width="14" height="14" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
    <rect width="14" height="14" fill="${color}"/><rect width="5" height="14" fill="#F7F3E8" fill-opacity="0.85"/></pattern>`;
  // Unknown direction: gray with dots so it never reads as a muted YES/NO.
  return `<defs>
    <pattern id="dirYes" width="10" height="10" patternUnits="userSpaceOnUse"><rect width="10" height="10" fill="${DIRECTION_COLORS[0]}"/></pattern>
    <pattern id="dirNo" width="10" height="10" patternUnits="userSpaceOnUse"><rect width="10" height="10" fill="${DIRECTION_COLORS[1]}"/></pattern>
    <pattern id="dirUnknown" width="12" height="12" patternUnits="userSpaceOnUse"><rect width="12" height="12" fill="${DIRECTION_COLORS[2]}"/><circle cx="6" cy="6" r="2.2" fill="#0E1A17"/></pattern>
    ${hatch("recentYes", DIRECTION_COLORS[0])}${hatch("recentNo", DIRECTION_COLORS[1])}
    <pattern id="recentUnknown" width="14" height="14" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><rect width="14" height="14" fill="${DIRECTION_COLORS[2]}"/><rect width="5" height="14" fill="#F7F3E8" fill-opacity="0.85"/><circle cx="10" cy="7" r="2" fill="#0E1A17"/></pattern>
  </defs>`;
}

function niceMax(value: number) {
  const raw = Math.max(1, value);
  const power = 10 ** Math.floor(Math.log10(raw));
  for (const step of [1, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10]) if (step * power >= raw) return step * power;
  return 10 * power;
}

/** Every qualifying trade contributes to a time bucket; no last-N truncation. */
export function historyPlotSvg(trades: MarketCardTrade[], now: Date, top: number, bottom: number, highlightRecent = true) {
  const history = bucketHistory(trades, now, highlightRecent);
  const left = 168;
  const right = 856;
  const column = (right - left) / history.buckets.length;
  const barWidth = Math.min(72, Math.max(5, column * 0.76));
  const maximum = niceMax(Math.max(...history.buckets.map(bucket => bucket.total)) * 1.08);
  const grid = [0, 0.5, 1].map(fraction => {
    const y = bottom - fraction * (bottom - top);
    return `<line x1="${left}" y1="${y}" x2="${right}" y2="${y}" stroke="${fraction === 0 ? "#6E7F79" : "#2C3D38"}" stroke-width="${fraction === 0 ? 3 : 2}" ${fraction === 0 ? "" : 'stroke-dasharray="4 10"'}/>
      <text x="${left - 14}" y="${y + 10}" text-anchor="end" font-size="27" font-weight="600" fill="#AEBDB7">${axisMoney(maximum * fraction)}</text>`;
  }).join("");
  let marker = "";
  const bars = history.buckets.map((bucket, index) => {
    const x = left + column * (index + 0.5) - barWidth / 2;
    let used = 0;
    const order = [0, 3, 1, 4, 2, 5]; // stack by direction so each color is one block
    const segments = order.map(segment => {
      const value = bucket.values[segment];
      if (!value) return "";
      const height = value / maximum * (bottom - top);
      const y = bottom - used - height;
      used += height;
      const fill = (segment >= 3 ? RECENT_FILLS : DIRECTION_FILLS)[segment % 3];
      return `<rect x="${x}" y="${y}" width="${barWidth}" height="${height}" fill="${fill}" stroke="#0E1A17" stroke-width="1.5"/>`;
    }).join("");
    if (index === history.latestIndex && bucket.count) {
      const cx = x + barWidth / 2;
      const ty = bottom - used - 14;
      marker = `<rect x="${x - 4}" y="${bottom - used - 4}" width="${barWidth + 8}" height="${used + 4}" fill="none" stroke="#F7F3E8" stroke-width="4" rx="4"/>
        <path d="M${cx - 11} ${ty - 14} L${cx + 11} ${ty - 14} L${cx} ${ty} Z" fill="#F7F3E8"/>`;
    }
    return segments;
  }).join("");
  const span = history.end - history.start;
  const multiDay = nyDay(new Date(history.start)) !== nyDay(new Date(history.end - 1));
  const ticks = span < 4 * MINUTE ? [0, 1] : [0, 0.5, 1];
  const labels = ticks.map(fraction => {
    const date = new Date(history.start + span * fraction - (fraction === 1 ? 1 : 0));
    const x = left + (right - left) * fraction;
    const anchor = fraction === 0 ? "start" : fraction === 1 ? "end" : "middle";
    const primary = span >= 2 * 1440 * MINUTE ? nyDay(date) : nyTime(date, span <= 2 * MINUTE);
    const secondary = span >= 2 * 1440 * MINUTE ? nyTime(date) : multiDay || fraction === 0 ? nyDay(date) : "";
    return `<line x1="${x}" y1="${bottom}" x2="${x}" y2="${bottom + 10}" stroke="#6E7F79" stroke-width="2"/>
      <text x="${x}" y="${bottom + 42}" text-anchor="${anchor}" font-size="27" font-weight="700" fill="#E9EEEA">${primary}</text>
      ${secondary ? `<text x="${x}" y="${bottom + 74}" text-anchor="${anchor}" font-size="24" fill="#AEBDB7">${secondary}</text>` : ""}`;
  }).join("");
  return { ...history, maximum, svg: grid + bars + marker + labels };
}
