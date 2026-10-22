export type TradeBand = "large" | "medium";
export type TradeRange = {
  minimum: number;
  minimumInclusive: boolean;
  maximum: number | null;
};

export function tradeRange(band: TradeBand, primaryThreshold = 10_000): TradeRange {
  return band === "medium"
    ? { minimum: 5_000, minimumInclusive: false, maximum: 10_000 }
    : { minimum: Math.max(10_000, primaryThreshold), minimumInclusive: true, maximum: null };
}

export function inTradeRange(notional: number, range: TradeRange) {
  return Number.isFinite(notional) &&
    (range.minimumInclusive ? notional >= range.minimum : notional > range.minimum) &&
    (range.maximum === null || notional < range.maximum);
}

export function shouldCaptureTrade(notional: number) {
  return Number.isFinite(notional) && notional > 5_000;
}

export function rangeLabel(range: TradeRange) {
  const minimum = `$${range.minimum.toLocaleString("en-US")}`;
  return range.maximum === null
    ? `${minimum}+`
    : `>${minimum} and <$${range.maximum.toLocaleString("en-US")}`;
}

export function rangeFooter(range: TradeRange) {
  return range.maximum === null
    ? `Trades ≥ $${range.minimum.toLocaleString("en-US")}`
    : `Trades > $${range.minimum.toLocaleString("en-US")} and < $${range.maximum.toLocaleString("en-US")}`;
}
