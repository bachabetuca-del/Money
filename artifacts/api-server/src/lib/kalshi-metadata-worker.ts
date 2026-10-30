import { mapConcurrent } from "./async-pool";

export type MarketContext = { eventTitle: string; marketTitle: string; eventTicker?: string; marketStatus?: string };
export type MetadataJob = { ticker: string; attempts: number };
export interface MetadataStore {
  candidates(now: Date): Promise<MetadataJob[]>;
  complete(ticker: string, context: MarketContext): Promise<void>;
  failed(job: MetadataJob, error: string, retryAt: Date): Promise<void>;
}
export class KalshiMetadataWorker {
  private busy = false;
  constructor(private store: MetadataStore, private context: (ticker: string) => Promise<MarketContext>,
    private now: () => Date = () => new Date(), private warn: (message: string) => void = () => {}) {}
  async tick() {
    if (this.busy) return;
    this.busy = true;
    try {
      const jobs = await this.store.candidates(this.now());
      await mapConcurrent(jobs, 4, async job => {
        try {
          const context = await this.context(job.ticker);
          if (!context.eventTitle || !context.marketTitle || context.marketTitle.includes(job.ticker)) {
            throw new Error("Readable market context unavailable.");
          }
          await this.store.complete(job.ticker, context);
        } catch (error) {
          const message = error instanceof Error ? error.message : "Market metadata unavailable.";
          await this.store.failed(job, message, new Date(this.now().getTime() + Math.min(3600_000, 15_000 * 2 ** job.attempts)));
          this.warn(message);
        }
      });
    } finally { this.busy = false; }
  }
}
