export type TradeBand = "large" | "medium" | "small";
export const CAPTURE_MINIMUM = 1_000;
export type TradeRange = {
  minimum: number;
  minimumInclusive: boolean;
  maximum: number | null;
  maximumInclusive?: boolean;
};

export function tradeRange(band: TradeBand, primaryThreshold = 10_000): TradeRange {
  return band === "small"
    ? { minimum: CAPTURE_MINIMUM, minimumInclusive: true, maximum: 5_000, maximumInclusive: true }
    : band === "medium"
    ? { minimum: 5_000, minimumInclusive: false, maximum: 10_000 }
    : { minimum: Math.max(10_000, primaryThreshold), minimumInclusive: true, maximum: null };
}

export function inTradeRange(notional: number, range: TradeRange) {
  return Number.isFinite(notional) &&
    (range.minimumInclusive ? notional >= range.minimum : notional > range.minimum) &&
    (range.maximum === null || (range.maximumInclusive ? notional <= range.maximum : notional < range.maximum));
}

export function shouldCaptureTrade(notional: number) {
  return Number.isFinite(notional) && notional >= CAPTURE_MINIMUM;
}

export function rangeLabel(range: TradeRange) {
  const minimum = `$${range.minimum.toLocaleString("en-US")}`;
  return range.maximum === null
    ? `${minimum}+`
    : `${range.minimumInclusive ? "≥" : ">"}${minimum} and ${range.maximumInclusive ? "≤" : "<"}$${range.maximum.toLocaleString("en-US")}`;
}

export function rangeFooter(range: TradeRange) {
  return range.maximum === null
    ? `Trades ≥ $${range.minimum.toLocaleString("en-US")}`
    : `Trades ${range.minimumInclusive ? "≥" : ">"} $${range.minimum.toLocaleString("en-US")} and ${range.maximumInclusive ? "≤" : "<"} $${range.maximum.toLocaleString("en-US")}`;
}
