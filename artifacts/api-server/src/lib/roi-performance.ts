import type { RoiMoneyPerformance, RoiWeekPerformance } from "@workspace/api-zod";

export const ROI_STAKE = 100;
export type RoiMoneyBand = RoiMoneyPerformance["band"];
export const ROI_MONEY_BANDS: RoiMoneyBand[] = ["small", "medium", "large"];
export const ROI_MONEY_LABELS: Record<RoiMoneyBand, string> = {
  small: "$1k–$5k inclusive", medium: "Más de $5k y menos de $10k", large: "$10k+",
};
export type PerformanceTotals = { trades: number; wins: number; profit: number; games: Set<string> };
type Observation = { trades: number; wins: number; profit: number; gameId: string };
const rounded = (value: number, decimals = 2) => Number(value.toFixed(decimals));
export const roiPct = (profit: number, trades: number) =>
  trades ? rounded(100 * profit / (trades * ROI_STAKE), 4) : null;

export function accumulatePerformance(groups: Map<string, PerformanceTotals>, key: string, row: Observation) {
  let total = groups.get(key);
  if (!total) {
    total = { trades: 0, wins: 0, profit: 0, games: new Set() };
    groups.set(key, total);
  }
  total.trades += row.trades; total.wins += row.wins; total.profit += row.profit;
  total.games.add(row.gameId);
}

function metrics(total?: PerformanceTotals) {
  const trades = total?.trades ?? 0, games = total?.games.size ?? 0, wins = total?.wins ?? 0;
  const profit = total?.profit ?? 0;
  return {
    trades, games, wins, profit: rounded(profit),
    roiPct: roiPct(profit, trades),
    winRatePct: trades ? rounded(100 * wins / trades) : null,
    sampleWarning: games < 10 || trades < 30,
  };
}

export function moneyPerformance(groups: Map<string, PerformanceTotals>, minGames: number): RoiMoneyPerformance[] {
  return ROI_MONEY_BANDS.map(band => {
    const data = metrics(groups.get(band));
    return { band, ...data, meetsMinimum: data.trades > 0 && data.games >= minGames };
  });
}

const calendar = new Intl.DateTimeFormat("en-CA", {
  timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit",
  hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
});
function localParts(date: Date) {
  return Object.fromEntries(calendar.formatToParts(date).map(part => [part.type, part.value]));
}
export function newYorkWeekKey(date: Date): string {
  const p = localParts(date);
  const day = new Date(Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day)));
  day.setUTCDate(day.getUTCDate() - (day.getUTCDay() + 6) % 7);
  return day.toISOString().slice(0, 10);
}
function weekDate(key: string) {
  const date = new Date(`${key}T00:00:00.000Z`);
  if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== key || date.getUTCDay() !== 1) {
    throw new Error("Invalid ROI calendar-week key.");
  }
  return date;
}

/** Civil Mondays, not 168-hour jumps in local instants: DST must not move a
 * transaction into another week. Only inner gaps are filled, with NULL rates. */
export function weeklyPerformance(
  groups: Map<string, PerformanceTotals>, now: Date, since: Date | null,
): RoiWeekPerformance[] {
  const keys = [...groups.keys()].sort();
  if (!keys.length) return [];
  keys.forEach(weekDate);
  const currentWeek = newYorkWeekKey(now), firstWindowWeek = since ? newYorkWeekKey(since) : null;
  const p = since ? localParts(since) : null;
  const clipped = !!(p && since && (
    `${p.year}-${p.month}-${p.day}` !== firstWindowWeek ||
    p.hour !== "00" || p.minute !== "00" || p.second !== "00" || since.getUTCMilliseconds() !== 0
  ));
  const weeks: RoiWeekPerformance[] = [];
  const cursor = weekDate(keys[0]), last = keys[keys.length - 1];
  while (cursor.toISOString().slice(0, 10) <= last) {
    const weekStart = cursor.toISOString().slice(0, 10);
    weeks.push({ weekStart, ...metrics(groups.get(weekStart)),
      partial: weekStart >= currentWeek || (weekStart === firstWindowWeek && clipped) });
    cursor.setUTCDate(cursor.getUTCDate() + 7);
  }
  return weeks;
}
