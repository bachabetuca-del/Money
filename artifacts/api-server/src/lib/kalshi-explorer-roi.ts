import type { ExplorerRoi } from "@workspace/api-zod";
import { AsyncTtlCache } from "./async-ttl-cache";
import { buildExplorerRoi, ROI_COLOR_POLICY } from "./explorer-roi";
import { getKalshiExplorer } from "./kalshi-explorer";
import { getRoiSnapshot } from "./kalshi-roi-leaderboard";
import { loadRoiReferencePrices } from "./kalshi-roi-reference-prices";
import { tradeRange, type TradeBand } from "./kalshi-trade-bands";

const colors = new AsyncTtlCache<ExplorerRoi>(60_000, 6);

/** Independent of chart loading: cached, bounded, read-only, no new Kalshi calls.
 * The band is applied to BOTH the historical comparison and reference trades. */
export async function getExplorerRoi(band: TradeBand, scope: "active" | "history", now = new Date()): Promise<ExplorerRoi> {
  const { snapshot, threshold } = await getRoiSnapshot({
    groupBy: "segment", window: "all", band, direction: "all",
    coverage: "verified", minGames: 1, page: 1,
  }, now);
  const key = JSON.stringify([band, scope, threshold, snapshot.generatedAt]);
  return colors.get(key, async () => {
    const catalog = await getKalshiExplorer({ band, scope, window: "all", direction: "all" }, now);
    const prices = await loadRoiReferencePrices(catalog.markets.map(m => m.ticker), tradeRange(band, threshold), now);
    return {
      generatedAt: now.toISOString(), historyAsOf: snapshot.generatedAt, band, scope,
      ...ROI_COLOR_POLICY,
      feeModel: snapshot.feeModel,
      markets: buildExplorerRoi(catalog.markets, prices, snapshot.rows, now),
    };
  });
}
