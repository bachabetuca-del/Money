import { publicDirection } from "./telegram-trade-direction";

type ExecutionFields = {
  count_fp?: string; count?: number;
  yes_price_dollars?: string; no_price_dollars?: string;
  yes_price?: number; no_price?: number;
  taker_outcome_side?: string; taker_side?: string; taker_book_side?: string;
};

/** Resolve documented canonical direction before selecting that outcome's quote. */
export function publicTradeExecution(trade: ExecutionFields) {
  const outcomeSide = publicDirection(trade.taker_outcome_side, trade.taker_side, trade.taker_book_side);
  if (outcomeSide === "unknown") return undefined;
  const raw = outcomeSide === "no" ? trade.no_price_dollars : trade.yes_price_dollars;
  const cents = outcomeSide === "no" ? trade.no_price : trade.yes_price;
  const price = raw !== undefined ? Number(raw) : typeof cents === "number" ? cents / 100 : NaN;
  const count = Number(trade.count_fp ?? trade.count);
  // Four-decimal dollar quotes × two-decimal fractional contracts require
  // six decimals. Round only binary floating-point noise, never to cents.
  const notional = Number((price * count).toFixed(6));
  if (!Number.isFinite(price) || price <= 0 || price > 1 || !Number.isFinite(count) || count <= 0 ||
      !Number.isFinite(notional)) return undefined;
  return { outcomeSide, price, count, notional };
}
