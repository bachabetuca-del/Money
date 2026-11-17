import { estimateHypotheticalEntryFee, type FeeRule } from "../kalshi-fees";
import { asks, type BookQuote, type Level, type Side } from "./book";

export type Fill = Level & { costUsd: number; feeUsd: number };
export type PaperFill = {
  status: "full" | "partial" | "none" | "unknown"; reason: string;
  contracts: number; costUsd: number; feeUsd: number | null;
  averagePrice: number | null; bestAsk: number | null; fills: Fill[];
  book: BookQuote | null; limitPrice: number; budgetUsd: number;
};
export function emptyFill(reason: string, status: PaperFill["status"] = "unknown"): PaperFill {
  return { status, reason, contracts: 0, costUsd: 0, feeUsd: null, averagePrice: null,
    bestAsk: null, fills: [], book: null, limitPrice: 0, budgetUsd: 0 };
}

/** Whole contracts are deliberately conservative, valid even where fractional
 * trading is disabled. Prices use integer ten-thousandths; cash uses micros.
 * Fees are rounded for each consumed level; no rebates or fictitious fills. */
export function executePaper(input: {
  book: BookQuote | null; dueAt: number; side: Side; observedPrice: number; limitCents: number;
  stakeUsd: number; availableUsd: number; fee: FeeRule | null;
  consumed?: Record<string, number>;
}): PaperFill {
  const { book, fee } = input;
  if (!book) return emptyFill("book_unavailable");
  const captured = Date.parse(book.capturedAt);
  if (captured < input.dueAt || captured - input.dueAt > 1500) return emptyFill("capture_outside_window");
  if (!Number.isFinite(input.observedPrice) || input.observedPrice <= 0 || input.observedPrice >= 1 ||
      !Number.isFinite(input.stakeUsd) || input.stakeUsd <= 0 ||
      !Number.isFinite(input.availableUsd) || input.availableUsd < 0 ||
      !Number.isFinite(input.limitCents) || input.limitCents < 0) return emptyFill("invalid_inputs");
  if (estimateHypotheticalEntryFee(.5, fee, 1) === null) return emptyFill("fee_unknown");
  const limit = Math.min(9999, Math.floor((input.observedPrice + input.limitCents / 100) * 10000 + 1e-7));
  const offers = asks(book, input.side);
  let budget = Math.floor(input.stakeUsd * 1e6 + 1e-5), cash = Math.floor(input.availableUsd * 1e6 + 1e-5);
  const result: PaperFill = { ...emptyFill("no_asks", "none"), book, feeUsd: 0,
    limitPrice: limit / 10000, budgetUsd: input.stakeUsd, bestAsk: offers[0]?.price ?? null };
  if (!offers.length) return result;
  if (cash === 0) { result.reason = "capital_or_exposure_limit"; return result; }
  let sizePrevented = false, limitPrevented = false, cashPrevented = false;
  for (const level of offers) {
    const p = Math.round(level.price * 10000);
    if (p > limit) { limitPrevented = true; break; }
    const available = Math.max(0, Math.floor(level.contracts - (input.consumed?.[String(p)] ?? 0) + 1e-9));
    const wanted = Math.floor(budget / (p * 100));
    let high = Math.min(wanted, available);
    if (high < wanted) sizePrevented = true;
    let low = 0;
    // Monotone integer search respects rounded fees AND spendable capital.
    while (low < high) {
      const q = Math.ceil((low + high) / 2);
      const amount = q * p / 10000, charge = estimateHypotheticalEntryFee(level.price, fee, amount)!;
      if (Math.round((amount + charge) * 1e6) <= cash) low = q; else { high = q - 1; cashPrevented = true; }
    }
    if (!low) continue;
    const costUsd = low * p / 10000, feeUsd = estimateHypotheticalEntryFee(level.price, fee, costUsd)!;
    result.fills.push({ ...level, contracts: low, costUsd, feeUsd });
    budget -= Math.round(costUsd * 1e6); cash -= Math.round((costUsd + feeUsd) * 1e6);
    result.contracts += low;
    result.costUsd = Math.round((result.costUsd + costUsd) * 1e6) / 1e6;
    result.feeUsd = Math.round((result.feeUsd! + feeUsd) * 1e6) / 1e6;
    if (budget < p * 100) break;
  }
  if (result.contracts > 0) {
    result.averagePrice = result.costUsd / result.contracts;
    const budgetFilled = budget < (Math.round(result.fills.at(-1)!.price * 10000) * 100);
    result.status = budgetFilled ? "full" : "partial";
    result.reason = budgetFilled ? "whole_contract_budget_filled" : cashPrevented ? "capital_or_exposure_limit" :
      limitPrevented ? "price_limit" : book.truncated ? "captured_depth_limit" : "insufficient_depth";
  } else result.reason = cashPrevented ? "capital_or_exposure_limit" : limitPrevented ? "price_limit" :
    sizePrevented ? "insufficient_unconsumed_depth" : "below_one_contract";
  return result;
}

export type Resolution = { result: string; checkedAt: string; netProfitUsd: number | null; payoutUsd: number | null };
export function resolvePaper(fill: PaperFill, side: string, result: string, checkedAt: string): Resolution {
  if (!["yes", "no"].includes(result) || !["yes", "no"].includes(side) || fill.feeUsd === null ||
      !["full", "partial"].includes(fill.status))
    return { result, checkedAt, netProfitUsd: null, payoutUsd: null };
  const payoutUsd = side === result ? fill.contracts : 0;
  return { result, checkedAt, payoutUsd,
    netProfitUsd: Math.round((payoutUsd - fill.costUsd - fill.feeUsd) * 1e6) / 1e6 };
}
