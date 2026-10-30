import type { PublicTrade } from "./kalshi-monitor";
import type { HistoryJob } from "./kalshi-market-history";

/** Fail the whole page rather than certify partial, conflicting or malformed data. */
export function checkedHistoryRows(rows: PublicTrade[], job: Pick<HistoryJob, "ticker" | "snapshotAt">) {
  const unique = new Map<string, PublicTrade>();
  for (const row of rows) {
    const executionTime = Date.parse(row.createdTime);
    if (row.ticker !== job.ticker || !row.tradeId || !["yes", "no"].includes(row.outcomeSide) ||
      !Number.isFinite(row.price) || row.price <= 0 || row.price > 1 ||
      !Number.isFinite(row.count) || row.count <= 0 || !Number.isFinite(row.notional) ||
      Math.abs(row.notional - row.price * row.count) > 0.000001 ||
      !Number.isFinite(executionTime) || executionTime < 0 || executionTime > job.snapshotAt.getTime() + 1000) {
      throw new Error("Historical page failed execution integrity checks; coverage remains unverified.");
    }
    const prior = unique.get(row.tradeId);
    if (prior && (prior.price !== row.price || prior.count !== row.count || prior.outcomeSide !== row.outcomeSide ||
      Date.parse(prior.createdTime) !== executionTime || prior.notional !== row.notional)) {
      throw new Error("Historical page contains conflicting versions of the same trade.");
    }
    unique.set(row.tradeId, row);
  }
  return [...unique.values()];
}
