import type { RoiPhase } from "@workspace/api-zod";
import { buildRoiRanking, type RoiGroup, type RoiRollup, type RoiSort } from "./roi-ranking";
import { selectRoiEntries, type RoiUnit } from "./roi-method";

type Filters = { band: "all" | "small" | "medium" | "large"; direction: "all" | "yes" | "no" };

/** Amount/side are already dimensions of each rollup. Share the costly SQL
 * across those views. A custom large-trade floor MUST still apply before SQL
 * aggregation, because its boundary can cut through a money-band rollup. */
export function roiSourceFilters(filters: Filters, threshold: number): Filters {
  return { band: filters.band === "large" && threshold > 10_000 ? "large" : "all", direction: "all" };
}

const views = new WeakMap<RoiRollup[], Map<string, RoiRollup[]>>();
export function roiFilteredRows(rows: RoiRollup[], filters: Filters) {
  if (filters.band === "all" && filters.direction === "all") return rows;
  let cached = views.get(rows);
  if (!cached) { cached = new Map(); views.set(rows, cached); }
  const key = JSON.stringify([filters.band, filters.direction]);
  let filtered = cached.get(key);
  if (!filtered) {
    filtered = rows.filter(row => (filters.band === "all" || row.moneyBand === filters.band) &&
      (filters.direction === "all" || row.side === filters.direction));
    cached.set(key, filtered);
  }
  return filtered;
}

type RankingOptions = {
  unit: RoiUnit; phase: RoiPhase; groupBy: RoiGroup; minGames: number;
  sortBy: RoiSort; now: Date; since: Date | null;
};
type Prepared = {
  selected: ReturnType<typeof selectRoiEntries>;
  ranking: ReturnType<typeof buildRoiRanking>;
};
const rankings = new WeakMap<RoiRollup[], Map<string, Prepared>>();

/** Snapshot-owned, bounded derived results: pagination cannot trigger another
 * selection, audit, weekly breakdown and full sort of the same history. */
export function preparedRoiRanking(rows: RoiRollup[], options: RankingOptions): Prepared {
  let cache = rankings.get(rows);
  if (!cache) { cache = new Map(); rankings.set(rows, cache); }
  const key = JSON.stringify([options.unit, options.phase, options.groupBy, options.minGames,
    options.sortBy, options.now.toISOString(), options.since?.toISOString()]);
  const old = cache.get(key);
  if (old) return old;
  const selected = selectRoiEntries(rows, options.unit, options.phase);
  const ranking = buildRoiRanking(selected.rows, options.groupBy, options.minGames, {
    sortBy: options.sortBy, now: options.now, since: options.since,
    separatePatterns: options.unit !== "execution",
  });
  const prepared = { selected, ranking };
  if (cache.size >= 24) cache.delete(cache.keys().next().value!);
  cache.set(key, prepared);
  return prepared;
}
