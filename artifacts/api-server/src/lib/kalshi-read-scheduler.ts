export type ReadPriority = "recovery" | "live" | "metadata" | "history" | "control";
type Waiting = { url: string; priority: ReadPriority; queuedAt: number; resolve(): void; reject(error: Error): void };
type Cost = { method: string; path: string; cost: number };
const turnOrder: ReadPriority[] = ["recovery", "live", "control", "recovery", "metadata", "live", "history"];

/** A single account-wide, cost-aware queue. Half the advertised quota is reserved
 * for other clients/bursts. Weighted turns prevent backfills starving forever. */
export class KalshiReadPacer {
  private queue: Waiting[] = [];
  private timer?: ReturnType<typeof setTimeout>;
  private nextAt = 0;
  private turn = 0;
  private tokensPerSecond = 40; // Safe four-read/s fallback until discovery succeeds.
  private defaultCost = 10;
  private costs: Cost[] = [];
  private factor = 1;
  private lastRecovery = 0;
  private verifiedAt: number | null = null;
  private accountRate: number | null = null;
  private dispatched = 0;
  private stopped = false;

  constructor(private now: () => number = Date.now) {}

  configure(limits: unknown, costs: unknown) {
    const l = limits as { read?: { refill_rate?: number; bucket_capacity?: number } };
    const c = costs as { default_cost?: number; endpoint_costs?: Cost[] };
    const rate = l?.read?.refill_rate;
    const capacity = l?.read?.bucket_capacity;
    if (!Number.isFinite(rate) || rate! <= 0 || !Number.isFinite(capacity) || capacity! <= 0 ||
        !Number.isFinite(c?.default_cost) || c.default_cost! <= 0 || !Array.isArray(c.endpoint_costs) ||
        c.endpoint_costs.some(row => !row || typeof row.path !== "string" || typeof row.method !== "string" ||
          !Number.isFinite(row.cost) || row.cost <= 0)) {
      throw new Error("Kalshi returned invalid account quota information.");
    }
    this.accountRate = rate!;
    this.defaultCost = c.default_cost!;
    this.costs = c.endpoint_costs.filter(row => row.method === "GET");
    this.tokensPerSecond = Math.min(rate! * 0.5, this.defaultCost * 50);
    this.verifiedAt = this.now();
  }

  limited() {
    this.factor = Math.max(0.1, this.factor * 0.5);
    this.lastRecovery = this.now();
  }

  private cost(url: string) {
    const path = new URL(url, "https://kalshi.invalid").pathname.replace(/^\/trade-api\/v2/, "");
    const matches = this.costs.filter(row => {
      const expression = row.path.replace(/[.+?^${}()|[\]\\]/g, "\\$&")
        .replace(/:[^/]+/g, "[^/]+").replace(/\*[^/]+/g, ".*");
      return new RegExp(`^${expression}$`).test(path);
    });
    return matches.length ? Math.max(...matches.map(row => row.cost)) : this.defaultCost;
  }

  get stats() {
    return { verifiedAt: this.verifiedAt, accountTokensPerSecond: this.accountRate,
      budgetTokensPerSecond: this.tokensPerSecond * this.factor, defaultCost: this.defaultCost,
      queued: this.queue.length, oldestWaitMs: this.queue.length ? this.now() - this.queue[0].queuedAt : 0,
      dispatched: this.dispatched };
  }

  wait(url = "/markets/trades", priority: ReadPriority = "metadata"): Promise<void> {
    if (this.stopped || this.queue.length >= 500) return Promise.reject(new Error("Kalshi REST ocupado; se reintentará."));
    return new Promise((resolve, reject) => {
      this.queue.push({ url, priority, queuedAt: this.now(), resolve, reject });
      this.schedule();
    });
  }

  private schedule() {
    if (this.timer || !this.queue.length || this.stopped) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      const now = this.now();
      if (now < this.nextAt) { this.schedule(); return; }
      if (now - this.lastRecovery > 60_000 && this.factor < 1) {
        this.factor = Math.min(1, this.factor + 0.1);
        this.lastRecovery = now;
      }
      let index = this.queue.findIndex(row => now - row.queuedAt >= 30_000);
      if (index < 0) {
        for (let i = 0; i < turnOrder.length; i++) {
          const priority = turnOrder[this.turn++ % turnOrder.length];
          index = this.queue.findIndex(row => row.priority === priority);
          if (index >= 0) break;
        }
      }
      const [row] = this.queue.splice(Math.max(0, index), 1);
      this.nextAt = now + this.cost(row.url) / (this.tokensPerSecond * this.factor) * 1000;
      this.dispatched++;
      row.resolve();
      this.schedule();
    }, Math.max(0, this.nextAt - this.now()));
  }

  stop() {
    this.stopped = true;
    clearTimeout(this.timer);
    for (const row of this.queue.splice(0)) row.reject(new Error("Kalshi REST scheduler stopped."));
  }
}
