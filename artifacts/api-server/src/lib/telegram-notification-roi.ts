import { ROI_COLOR_POLICY } from "./explorer-roi";
import { marketType } from "./market-type";
import { oddsBucket, ROI_STAKE, type RoiRollup } from "./roi-ranking";
import { publicDirection } from "./telegram-trade-direction";

export const NOTIFICATION_MIN_ROI_PCT = 7;
export type NotificationRoi = { roiPct: number; games: number; trades: number };
type TradeReference = {
  ticker: string; sport?: string; eventTitle: string | null; marketTitle: string | null;
  outcomeSide: string; bookSide?: string; price: number;
};

/** Never round a below-threshold ROI up into notification eligibility. */
export function qualifiesForNotificationRoi(roi: NotificationRoi | null): roi is NotificationRoi {
  return roi !== null && Number.isFinite(roi.roiPct) && roi.roiPct >= NOTIFICATION_MIN_ROI_PCT &&
    Number.isSafeInteger(roi.games) && roi.games >= ROI_COLOR_POLICY.minimumGames &&
    Number.isSafeInteger(roi.trades) && roi.trades >= ROI_COLOR_POLICY.minimumTrades;
}

/** Same exact comparison and equal-stake formula as the ranking, before display
 * rounding. Build once per historical snapshot, then look up each live execution.
 * Notifications always use the $10k+ cohort, independent of dashboard filters. */
export function buildNotificationRoiLookup(history: RoiRollup[]) {
  const groups = new Map<string, { profit: number; trades: number; games: Set<string> }>();
  for (const row of history) {
    if (row.category !== "settled" || row.historyVerified !== true || row.historyError ||
        row.moneyBand !== "large" || !["yes", "no"].includes(row.side) ||
        !Number.isInteger(row.bucket) || row.bucket < 0 || row.bucket > 9 ||
        !Number.isSafeInteger(row.trades) || row.trades <= 0 || !Number.isFinite(row.profit)) continue;
    const type = marketType(row);
    if (type === "other") continue;
    const key = JSON.stringify([row.sport, type, row.side, row.bucket]);
    const group = groups.get(key) ?? { profit: 0, trades: 0, games: new Set<string>() };
    group.profit += row.profit;
    group.trades += row.trades;
    group.games.add(row.gameId);
    groups.set(key, group);
  }
  return (trade: TradeReference): NotificationRoi | null => {
    const side = publicDirection(trade.outcomeSide, undefined, trade.bookSide);
    const bucket = oddsBucket(trade.price), type = marketType(trade);
    if (!trade.sport || side === "unknown" || bucket === null || type === "other") return null;
    const group = groups.get(JSON.stringify([trade.sport, type, side, bucket]));
    if (!group) return null;
    return {
      roiPct: 100 * group.profit / (group.trades * ROI_STAKE),
      games: group.games.size, trades: group.trades,
    };
  };
}
