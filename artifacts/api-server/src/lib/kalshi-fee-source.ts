import { createFeeSnapshot, type PublicFeeSeries } from "./kalshi-fees";

export type FeeRead = <T>(path: string) => Promise<T>;

/** Walk every override page before committing anything. An incomplete response,
 * repeated cursor or exhausted bound is an explicit failure, never "no fees". */
export async function fetchFeeSnapshot(series: PublicFeeSeries[], read: FeeRead, asOf: Date) {
  const changes = await read<{ series_fee_change_arr?: unknown[] }>("/series/fee_changes");
  if (!Array.isArray(changes.series_fee_change_arr)) throw new Error("Series fee changes unavailable.");
  const events: unknown[] = [], seen = new Set<string>();
  let cursor = "";
  for (let page = 0; page < 100; page++) {
    const query = new URLSearchParams({ limit: "1000" });
    if (cursor) query.set("cursor", cursor);
    const response = await read<{ event_fee_changes?: unknown[]; cursor?: string }>(`/events/fee_changes?${query}`);
    if (!Array.isArray(response.event_fee_changes) || typeof response.cursor !== "string") {
      throw new Error("Event fee changes unavailable.");
    }
    events.push(...response.event_fee_changes);
    cursor = response.cursor;
    if (!cursor) return createFeeSnapshot(series, events, changes.series_fee_change_arr, asOf);
    if (seen.has(cursor)) throw new Error("Repeated event-fee cursor.");
    seen.add(cursor);
  }
  throw new Error("Event-fee pagination incomplete.");
}
