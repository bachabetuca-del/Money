import type { MarketCardTrade } from "./telegram-market-card";
import { publicDirection } from "./telegram-trade-direction";

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

function compactMoney(value: number) {
  if (value >= 1_000_000) return `$${(value / 1_000_000).toFixed(1)}m`;
  return value >= 1000 ? `$${(value / 1000).toFixed(1)}k` : `$${Math.round(value)}`;
}

const OLD = ["#2F7F88", "#9A6420", "#5B6663"];
const NEW = ["#4FDDE8", "#FFB13B", "#B4BDBA"];

/** Every qualifying trade contributes to a time bucket; no last-N truncation. */
export function historyPlotSvg(trades: MarketCardTrade[], now: Date, top: number, bottom: number, highlightRecent = true) {
  const history = bucketHistory(trades, now, highlightRecent);
  const left = 176;
  const right = 856;
  const column = (right - left) / history.buckets.length;
  const barWidth = Math.min(80, Math.max(4, column * 0.78));
  const maximum = Math.max(1, ...history.buckets.map(bucket => bucket.total)) * 1.18;
  const grid = [0, 0.5, 1].map(fraction => {
    const y = bottom - fraction * (bottom - top);
    return `<line x1="${left}" y1="${y}" x2="${right}" y2="${y}" stroke="${fraction === 0 ? "#6B7C77" : "#2A3B36"}" stroke-width="${fraction === 0 ? 3 : 2}" ${fraction === 0 ? "" : 'stroke-dasharray="3 9"'}/>
      <text x="${left - 16}" y="${y + 10}" text-anchor="end" font-size="28" font-weight="600" fill="#A9B8B3">${compactMoney(maximum * fraction)}</text>`;
  }).join("");
  let latestBand = "";
  let latestLabel = "";
  const bars = history.buckets.map((bucket, index) => {
    const x = left + column * (index + 0.5) - barWidth / 2;
    let used = 0;
    const segments = bucket.values.map((value, segment) => {
      if (!value) return "";
      const height = value / maximum * (bottom - top);
      const y = bottom - used - height;
      used += height;
      const color = (segment >= 3 ? NEW : OLD)[segment % 3];
      return `<rect x="${x}" y="${y}" width="${barWidth}" height="${height}" fill="${color}" stroke="#0C1714" stroke-width="1.5"/>`;
    }).join("");
    if (index === history.latestIndex && bucket.count) {
      latestBand = `<rect x="${x - 8}" y="${top - 6}" width="${barWidth + 16}" height="${bottom - top + 6}" rx="8" fill="#F4F1E6" fill-opacity="0.09"/>`;
      latestLabel = `<rect x="${x - 4}" y="${bottom - used - 4}" width="${barWidth + 8}" height="${used + 4}" fill="none" stroke="#F4F1E6" stroke-width="4" rx="4"/>
        <text x="${right}" y="${top - 16}" text-anchor="end" font-size="25" font-weight="600" fill="#D9E2DC">Last interval total: ${compactMoney(bucket.total)}</text>`;
    }
    return segments;
  }).join("");
  const span = history.end - history.start;
  const longRange = span >= 2 * 24 * 60 * MINUTE;
  const ticks = longRange || span < 4 * MINUTE ? [0, 0.5, 1] : [0, 0.25, 0.5, 0.75, 1];
  const labels = ticks.map(fraction => {
    const date = new Date(history.start + (history.end - history.start) * fraction);
    const day = date.toLocaleDateString("en-US", { timeZone: "America/New_York", month: "short", day: "numeric" });
    const time = date.toLocaleTimeString("en-US", { timeZone: "America/New_York", hour: "numeric", minute: "2-digit",
      ...(span <= 2 * MINUTE ? { second: "2-digit" as const } : {}), hour12: false });
    const x = left + (right - left) * fraction;
    const anchor = fraction === 0 ? "start" : fraction === 1 ? "end" : "middle";
    const first = fraction === 0 || fraction === 0.5 || fraction === 1;
    return `<line x1="${x}" y1="${bottom}" x2="${x}" y2="${bottom + 10}" stroke="#6B7C77" stroke-width="2"/>
      <text x="${x}" y="${bottom + 42}" text-anchor="${anchor}" font-size="27" font-weight="700" fill="#E8EDE9">${longRange ? day : time}</text>
      ${first ? `<text x="${x}" y="${bottom + 74}" text-anchor="${anchor}" font-size="24" fill="#A9B8B3">${longRange ? time : day}</text>` : ""}`;
  }).join("");
  return { ...history, svg: grid + latestBand + bars + latestLabel + labels };
}
