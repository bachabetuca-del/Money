export type LifecycleEvent = { ticker?: string; series?: string; type: string };
const changes = new Set(["created", "activated", "deactivated", "close_date_updated",
  "determined", "settled", "metadata_updated", "price_level_structure_updated"]);
export function decodeLifecycle(type: unknown, msg: Record<string, unknown>): LifecycleEvent | null {
  if (type === "event_lifecycle" && typeof msg.series_ticker === "string" && msg.series_ticker) {
    return { type: "event_created", series: msg.series_ticker };
  }
  if (["market_lifecycle_v2", "multivariate_market_lifecycle"].includes(String(type)) &&
      typeof msg.market_ticker === "string" && msg.market_ticker && changes.has(String(msg.event_type))) {
    return { ticker: msg.market_ticker, type: String(msg.event_type) };
  }
  return null;
}
export type LifecycleWork = { ticker: string; metadata: boolean; settlement: boolean };
/** Events are hints for official REST verification, never a score or settlement
 * themselves. Coalesced work is bounded; periodic reconciliation remains active. */
export class KalshiLifecycle {
  private pending = new Map<string, LifecycleWork>();
  private busy = false;
  constructor(private apply: (work: LifecycleWork[]) => Promise<void>, private overflow: () => void = () => {}) {}
  enqueue(event: LifecycleEvent) {
    if (!event.ticker) return;
    if (!this.pending.has(event.ticker) && this.pending.size >= 5000) { this.overflow(); return; }
    const old = this.pending.get(event.ticker);
    this.pending.set(event.ticker, { ticker: event.ticker,
      metadata: !!old?.metadata || ["created", "metadata_updated"].includes(event.type),
      settlement: !!old?.settlement || ["determined", "settled"].includes(event.type) });
  }
  get queued() { return this.pending.size; }
  async tick() {
    if (this.busy || !this.pending.size) return;
    this.busy = true;
    const batch = [...this.pending.values()].slice(0, 100);
    try {
      await this.apply(batch);
      // A newer event received during the write must remain queued.
      for (const item of batch) if (this.pending.get(item.ticker) === item) this.pending.delete(item.ticker);
    } finally { this.busy = false; }
  }
}
