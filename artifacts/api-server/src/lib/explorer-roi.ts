import type { ExplorerMarketRoi, ExplorerRoiSignal } from "@workspace/api-zod";
import { buildRoiRanking, oddsBucket, type RoiRollup } from "./roi-ranking";
import { netEstimate } from "./roi-performance";
import { ROI_METHOD_VERSION, selectRoiEntries } from "./roi-method";
import type { RoiPhase } from "@workspace/api-zod";

export const ROI_COLOR_POLICY = {
  minimumGames: 50,
  minimumTrades: 30,
  greenMinRoiPct: 10,
} as const;

export type RoiReferenceMarket = { ticker: string; sport: string; marketType: string };
export type RoiReferencePrice = {
  ticker: string; side: "yes" | "no"; price: number; observedAt: string;
  phase?: RoiPhase;
};

/** Match the actual observed side price, not its complement or a winning-only
 * ranking page. No broad sport/type fallback when the exact odds group is absent. */
export function buildExplorerRoi(
  markets: RoiReferenceMarket[], prices: RoiReferencePrice[], history: RoiRollup[], now: Date, audited = false,
): ExplorerMarketRoi[] {
  const { rows } = buildRoiRanking(
    audited ? [] : history.filter(r => r.category === "settled" && r.historyVerified === true),
    "segment", 1, { now },
  );
  const groups = new Map(rows.map(row => [row.id, row]));
  const phaseGroups = new Map<string, Map<string, typeof rows[number]>>();
  if (audited) for (const phase of ["prematch", "nearStart", "live"] as const) {
    const selected = selectRoiEntries(history, "game", phase);
    const ranked = buildRoiRanking(selected.rows, "segment", 1, { now });
    phaseGroups.set(phase, new Map(ranked.rows.map(row => [row.id, row])));
  }
  const references = new Map<string, RoiReferencePrice>();
  for (const price of prices) {
    const observedAt = Date.parse(price.observedAt);
    if (!["yes", "no"].includes(price.side) || oddsBucket(price.price) === null ||
        !Number.isFinite(observedAt) || observedAt > now.getTime()) continue;
    const key = JSON.stringify([price.ticker, price.side]);
    if (observedAt > Date.parse(references.get(key)?.observedAt ?? "") || !references.has(key)) {
      references.set(key, price);
    }
  }
  return markets.map(market => ({
    ticker: market.ticker,
    signals: (["yes", "no"] as const).map(side => {
      const ref = references.get(JSON.stringify([market.ticker, side]));
      const bucket = ref ? oddsBucket(ref.price) : null;
      const value: ExplorerRoiSignal = {
        ...(audited ? { methodVersion: ROI_METHOD_VERSION, phase: ref?.phase ?? "unknown" } : {}),
        side, level: "insufficient", reason: "no_price",
        roiPct: null, trades: 0, games: 0,
        net: netEstimate(0, 0, {}),
        price: ref?.price ?? null, observedAt: ref?.observedAt ?? null,
        oddsMin: bucket === null ? null : bucket / 10,
        oddsMax: bucket === null ? null : (bucket + 1) / 10,
      };
      if (!market.marketType || market.marketType === "other") {
        return { ...value, reason: "unclassified" as const };
      }
      if (bucket === null) return value;
      const row = (audited ? phaseGroups.get(ref?.phase ?? "unknown") : groups)
        ?.get(JSON.stringify([market.sport, market.marketType, side, bucket]));
      if (!row || !Number.isFinite(row.roiPct)) return { ...value, reason: "no_history" as const };
      value.roiPct = row.roiPct;
      value.net = row.net;
      value.trades = row.trades;
      value.games = row.games;
      if (row.games < ROI_COLOR_POLICY.minimumGames || row.trades < ROI_COLOR_POLICY.minimumTrades) {
        return { ...value, reason: "small_sample" as const };
      }
      return {
        ...value, reason: null,
        level: row.roiPct < 0 ? "bad" as const :
          row.roiPct >= ROI_COLOR_POLICY.greenMinRoiPct ? "good" as const : "medium" as const,
      };
    }),
  }));
}
