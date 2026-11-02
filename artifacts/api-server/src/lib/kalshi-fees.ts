import type { RoiFeeModel } from "@workspace/api-zod";

export const FEE_MODEL_VERSION = "current-taker-direct-2026-11-02";
export const FEE_MAX_AGE_MS = 24 * 60 * 60 * 1000;
export const QUADRATIC_FEE_TYPES = ["quadratic", "quadratic_with_maker_fees", "quadratic_with_combo_maker_fees"] as const;
export const FEE_SOURCES = [
  "https://kalshi.com/docs/kalshi-fee-schedule.pdf",
  "https://kalshi.com/fee-schedule",
  "https://docs.kalshi.com/getting_started/fee_rounding",
  "https://docs.kalshi.com/api-reference/market/get-series",
  "https://docs.kalshi.com/api-reference/events/get-event-fee-changes",
  "https://docs.kalshi.com/api-reference/exchange/get-series-fee-changes",
];
export type FeeRule = { feeType: string; multiplier: number };
type EventRule = { feeType: string | null; multiplier: number | null };
export type PublicFeeSeries = { ticker: string; fee_type?: unknown; fee_multiplier?: unknown };
export type FeeSnapshot = {
  version: string; asOf: string; validUntil: string;
  series: Record<string, FeeRule>; events: Record<string, EventRule>;
};
const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const multiplier = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value) && value >= 0;
const timestamp = (value: unknown): value is string =>
  typeof value === "string" && Number.isFinite(Date.parse(value));

/** A complete current snapshot, not historical fees paid by any trader.
 * Unknown series/types stay unpriced. Invalid event overrides reject the whole
 * refresh: ignoring one could incorrectly fall back to a cheaper series fee. */
export function createFeeSnapshot(
  series: PublicFeeSeries[], eventChanges: unknown[], seriesChanges: unknown[], asOf: Date,
): FeeSnapshot {
  if (!Number.isFinite(asOf.getTime()) || !series.length) throw new Error("Fee catalog unavailable.");
  const rules: FeeSnapshot["series"] = Object.create(null);
  const events: FeeSnapshot["events"] = Object.create(null);
  const latest = new Map<string, number>();
  let validUntil = asOf.getTime() + FEE_MAX_AGE_MS;
  for (const row of series) {
    if (!row.ticker || typeof row.fee_type !== "string" || !multiplier(row.fee_multiplier)) continue;
    rules[row.ticker] = { feeType: row.fee_type, multiplier: row.fee_multiplier };
  }
  if (!Object.keys(rules).length) throw new Error("Fee catalog contains no valid rules.");
  for (const row of seriesChanges) {
    if (!object(row) || !timestamp(row.scheduled_ts)) throw new Error("Invalid scheduled series fee change.");
    const at = Date.parse(row.scheduled_ts);
    if (at > asOf.getTime()) validUntil = Math.min(validUntil, at);
  }
  for (const row of eventChanges) {
    if (!object(row) || typeof row.event_ticker !== "string" || !row.event_ticker ||
        !timestamp(row.scheduled_ts) ||
        !(row.fee_type_override === null || typeof row.fee_type_override === "string") ||
        !(row.fee_multiplier_override === null || multiplier(row.fee_multiplier_override))) {
      throw new Error("Invalid event fee override; snapshot not certified.");
    }
    const at = Date.parse(row.scheduled_ts);
    if (at > asOf.getTime()) { validUntil = Math.min(validUntil, at); continue; }
    const previous = latest.get(row.event_ticker);
    const rule = { feeType: row.fee_type_override, multiplier: row.fee_multiplier_override } as EventRule;
    if (previous === at && JSON.stringify(events[row.event_ticker]) !== JSON.stringify(rule)) {
      throw new Error("Conflicting event fee overrides.");
    }
    if (previous === undefined || previous < at) {
      events[row.event_ticker] = rule;
      latest.set(row.event_ticker, at);
    }
  }
  return { version: FEE_MODEL_VERSION, asOf: asOf.toISOString(),
    validUntil: new Date(validUntil).toISOString(), series: rules, events };
}

export function parseFeeSnapshot(value: unknown): FeeSnapshot | null {
  if (!object(value) || value.version !== FEE_MODEL_VERSION || !timestamp(value.asOf) ||
      !timestamp(value.validUntil) || !object(value.series) || !object(value.events) ||
      Date.parse(value.validUntil) <= Date.parse(value.asOf) ||
      Date.parse(value.validUntil) - Date.parse(value.asOf) > FEE_MAX_AGE_MS) return null;
  if (!Object.values(value.series).every(r => object(r) && typeof r.feeType === "string" && multiplier(r.multiplier)) ||
      !Object.values(value.events).every(r => object(r) && (r.feeType === null || typeof r.feeType === "string") &&
        (r.multiplier === null || multiplier(r.multiplier)))) return null;
  return value as FeeSnapshot;
}

export function feeSnapshotIsCurrent(snapshot: FeeSnapshot | null, now: Date) {
  return !!snapshot && snapshot.version === FEE_MODEL_VERSION &&
    Date.parse(snapshot.asOf) <= now.getTime() && Date.parse(snapshot.validUntil) > now.getTime();
}

export function feeModel(snapshot: FeeSnapshot | null, now: Date): RoiFeeModel {
  return {
    version: FEE_MODEL_VERSION, documentationReviewedOn: "2026-11-02",
    scheduleAsOf: snapshot?.asOf ?? null, validUntil: snapshot?.validUntil ?? null,
    status: !snapshot ? "unavailable" : feeSnapshotIsCurrent(snapshot, now) ? "current" : "stale",
    sources: FEE_SOURCES,
  };
}

export function marketFeeRule(snapshot: FeeSnapshot | null, ticker: string, eventTicker: string | null, now: Date): FeeRule | null {
  if (!feeSnapshotIsCurrent(snapshot, now) || !snapshot || !eventTicker) return null;
  const series = snapshot.series[ticker.split("-")[0]];
  if (!series) return null;
  const event = snapshot.events[eventTicker];
  return { feeType: event?.feeType ?? series.feeType, multiplier: event?.multiplier ?? series.multiplier };
}

/** Exact decimal fractions avoid charging an extra rounding unit because of
 * binary floating point. Includes exponent notation from a numeric multiplier. */
function fraction(value: number): [bigint, bigint] {
  const [mantissa, power = "0"] = value.toString().toLowerCase().split("e");
  const [whole, decimal = ""] = mantissa.split(".");
  const exponent = Number(power) - decimal.length;
  const digits = BigInt(whole + decimal);
  return exponent >= 0 ? [digits * 10n ** BigInt(exponent), 1n] : [digits, 10n ** BigInt(-exponent)];
}
const ceilDivide = (n: bigint, d: bigint) => (n + d - 1n) / d;

/** One hypothetical purchase with notional S and theoretical C=S/P contracts.
 * Current direct-member model: fee ceil at 6dp, debit aligned upward to $0.0001.
 * No order splitting/rebate or historical account-fee reconstruction. */
export function estimateHypotheticalEntryFee(
  price: number, rule: FeeRule | null, stake = 100, execution: "taker" | "maker" = "taker",
): number | null {
  if (!Number.isFinite(price) || price <= 0 || price > 1 || !Number.isFinite(stake) || stake <= 0 ||
      !rule || !multiplier(rule.multiplier) || !QUADRATIC_FEE_TYPES.some(type => type === rule.feeType)) return null;
  const makerFactor = rule.feeType === "quadratic" ? 0 :
    rule.feeType === "quadratic_with_combo_maker_fees" ? 2 : 1;
  const [p, pd] = fraction(price), [s, sd] = fraction(stake), [m, md] = fraction(rule.multiplier);
  // Taker 0.07; ordinary maker 0.0175; combo maker 0.035.
  const coefficient = execution === "taker" ? 28n : BigInt(7 * makerFactor);
  const feeMicros = ceilDivide(s * coefficient * m * (pd - p) * 1_000_000n, sd * 400n * md * pd);
  const debitUnits = ceilDivide((s * 1_000_000n + feeMicros * sd) * 10_000n, sd * 1_000_000n);
  return Number(debitUnits * sd - s * 10_000n) / Number(sd * 10_000n);
}
