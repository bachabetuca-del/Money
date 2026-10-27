import { publicDirection } from "./telegram-trade-direction";

export type FlowTrade = {
  tradeId?: string; notional: number; createdTime: Date | string;
  outcomeSide: string; bookSide?: string;
};
export function emptyFlow(minutes: number) {
  return { minutes, yesUsd: 0, noUsd: 0, unknownUsd: 0,
    yesCount: 0, noCount: 0, unknownCount: 0, balanceUsd: 0,
    largeYesCount: 0, largeNoCount: 0, largeYesUsd: 0, largeNoUsd: 0 };
}
export function summarizeFlow(trades: FlowTrade[], now: Date, minutes: number) {
  const result = emptyFlow(minutes);
  const seen = new Set<string>();
  for (const trade of trades) {
    const time = new Date(trade.createdTime).getTime();
    if (!Number.isFinite(time) || time < now.getTime() - minutes * 60_000 ||
        time > now.getTime() || !Number.isFinite(trade.notional) || trade.notional <= 0) continue;
    if (trade.tradeId) {
      if (seen.has(trade.tradeId)) continue;
      seen.add(trade.tradeId);
    }
    const direction = publicDirection(trade.outcomeSide, undefined, trade.bookSide);
    result[`${direction}Usd`] += trade.notional;
    result[`${direction}Count`]++;
    if (trade.notional > 10_000 && direction !== "unknown") {
      const prefix = direction === "yes" ? "largeYes" : "largeNo";
      result[`${prefix}Count`]++;
      result[`${prefix}Usd`] += trade.notional;
    }
  }
  for (const key of ["yesUsd", "noUsd", "unknownUsd", "largeYesUsd", "largeNoUsd"] as const) {
    result[key] = Math.round(result[key] * 100) / 100;
  }
  result.balanceUsd = Math.round((result.yesUsd - result.noUsd) * 100) / 100;
  return result;
}

/** A signal is multiple individual large trades, never a sum crossing $10k. */
export function flowConcentrations(windows: ReturnType<typeof emptyFlow>[]) {
  return (["yes", "no"] as const).flatMap(direction => {
    const prefix = direction === "yes" ? "largeYes" : "largeNo";
    const found = [...windows].sort((a, b) => a.minutes - b.minutes)
      .find(window => window[`${prefix}Count`] >= 3);
    return found ? [{ direction, minutes: found.minutes,
      count: found[`${prefix}Count`], usd: found[`${prefix}Usd`] }] : [];
  });
}
