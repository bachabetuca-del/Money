import type { MarketCardTrade } from "./telegram-market-card";

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

export function bucketHistory(trades: MarketCardTrade[], now: Date) {
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
    const recent = time >= now.getTime() - RECENT_WINDOW_MS && time <= now.getTime();
    const side = trade.outcomeSide.toLowerCase() === "yes" ? 0 : trade.outcomeSide.toLowerCase() === "no" ? 1 : 2;
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

/** Every qualifying trade contributes to a time bucket; no last-N truncation. */
export function historyPlotSvg(trades: MarketCardTrade[], now: Date, top: number, bottom: number) {
  const history = bucketHistory(trades, now);
  const left = 152;
  const right = 836;
  const column = (right - left) / history.buckets.length;
  const barWidth = Math.min(72, column * 0.72);
  const maximum = Math.max(1, ...history.buckets.map(bucket => bucket.total)) * 1.15;
  const grid = [0, 0.5, 1].map(fraction => {
    const y = bottom - fraction * (bottom - top);
    return `<line x1="${left}" y1="${y}" x2="${right}" y2="${y}" stroke="#334155" stroke-width="2"/>
      <text x="${left - 18}" y="${y + 10}" text-anchor="end" font-size="27" fill="#94A3B8">${compactMoney(maximum * fraction)}</text>`;
  }).join("");
  const bars = history.buckets.map((bucket, index) => {
    const x = left + column * (index + 0.5) - barWidth / 2;
    let used = 0;
    const segments = bucket.values.map((value, segment) => {
      if (!value) return "";
      const height = value / maximum * (bottom - top);
      const y = bottom - used - height;
      used += height;
      return `<rect x="${x}" y="${y}" width="${barWidth}" height="${height}"
        fill="${["#61A9BD", "#E98E2E", "#979797"][segment % 3]}" opacity="${segment >= 3 ? 1 : 0.35}"/>`;
    }).join("");
    const outline = index === history.latestIndex && bucket.count
      ? `<rect x="${x - 3}" y="${bottom - used - 3}" width="${barWidth + 6}" height="${used + 6}"
          fill="none" stroke="#FFFFFF" stroke-width="3" rx="3"/>` : "";
    return segments + outline;
  }).join("");
  const labels = [0, 0.5, 1].map(fraction => {
    const date = new Date(history.start + (history.end - history.start) * fraction);
    const day = date.toLocaleDateString("en-US", { timeZone: "America/New_York", month: "short", day: "numeric" });
    const time = date.toLocaleTimeString("en-US", { timeZone: "America/New_York", hour: "numeric", minute: "2-digit", hour12: false });
    return `<text x="${left + (right - left) * fraction}" y="${bottom + 36}"
        text-anchor="${fraction === 0 ? "start" : fraction === 1 ? "end" : "middle"}" font-size="24" fill="#CBD5E1">${day}</text>
      <text x="${left + (right - left) * fraction}" y="${bottom + 65}"
        text-anchor="${fraction === 0 ? "start" : fraction === 1 ? "end" : "middle"}" font-size="23" fill="#94A3B8">${time}</text>`;
  }).join("");
  return { ...history, svg: grid + bars + labels };
}
