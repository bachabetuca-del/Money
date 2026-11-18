import type { RoiAudit } from "@workspace/api-zod";
import type { RoiRollup } from "./roi-ranking";
import { ROI_STAKE } from "./roi-performance";

/** Cluster uncertainty is descriptive, normal-approximate, not a corrected
 * significance test. Chronological cohorts keep all of a game on one side. */
export function auditRoiRows(rows: RoiRollup[]): RoiAudit {
  const games = new Map<string, { n: number; profit: number; first: string }>();
  for (const r of rows) {
    const g = games.get(r.gameId) ?? { n: 0, profit: 0, first: r.firstAt };
    g.n += r.trades; g.profit += r.profit; g.first = g.first < r.firstAt ? g.first : r.firstAt;
    games.set(r.gameId, g);
  }
  const values = [...games].sort((a, b) => a[1].first.localeCompare(b[1].first) || a[0].localeCompare(b[0]));
  const n = values.reduce((s, [, g]) => s + g.n, 0), profit = values.reduce((s, [, g]) => s + g.profit, 0);
  const roi = n ? 100 * profit / (n * ROI_STAKE) : 0;
  const mean = n ? profit / n : 0;
  const se = games.size >= 10 ? 100 / ROI_STAKE *
    Math.sqrt(games.size / (games.size - 1) * values.reduce((s, [, g]) =>
      s + (g.profit - mean * g.n) ** 2, 0)) / n : null;
  const best = values.reduce<typeof values[number] | null>((a, b) => !a || b[1].profit > a[1].profit ? b : a, null);
  const cut = games.size >= 2 ? Math.max(1, Math.min(games.size - 1, Math.floor(games.size * .7))) : games.size;
  const earlier = values.slice(0, cut), later = values.slice(cut);
  const rate = (gs: typeof values) => {
    const count = gs.reduce((s, [, g]) => s + g.n, 0);
    return count ? 100 * gs.reduce((s, [, g]) => s + g.profit, 0) / (count * ROI_STAKE) : null;
  };
  const dates = rows.flatMap(r => [r.firstAt, r.lastAt]).sort();
  return {
    firstAt: dates[0] ?? "", lastAt: dates.at(-1) ?? "",
    largestGameSharePct: n ? 100 * values.reduce((max, [, g]) => Math.max(max, g.n), 0) / n : 0,
    withoutBestGameRoiPct: best && n > best[1].n ? 100 * (profit - best[1].profit) / ((n - best[1].n) * ROI_STAKE) : null,
    grossLower95Pct: se === null ? null : roi - 1.96 * se,
    grossUpper95Pct: se === null ? null : roi + 1.96 * se,
    earlierGames: earlier.length, laterGames: later.length,
    earlierRoiPct: rate(earlier), laterRoiPct: rate(later), chronologicalCutoff: later[0]?.[1].first ?? null,
  };
}
