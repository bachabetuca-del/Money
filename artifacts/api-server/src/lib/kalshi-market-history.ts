import { CAPTURE_MINIMUM } from "./kalshi-trade-bands";

export type HistoryJob = {
  ticker: string;
  phase: "live" | "archive" | "complete";
  cursor: string | null;
  snapshotAt: Date;
  sinceAt: Date | null;
  scanned: number;
  captureMinimum?: number;
  error: string | null;
  updatedAt: Date;
};
export type HistoryStatus = {
  phase: HistoryJob["phase"] | "pending";
  scanned: number;
  error: boolean;
};
export interface HistoryRepository<T> {
  candidates(): Promise<{ ticker: string; job?: HistoryJob }[]>;
  job(ticker: string): Promise<HistoryJob | undefined>;
  eligible?(ticker: string): Promise<boolean>;
  // Page inserts and cursor advancement must be one atomic transaction.
  commit(job: HistoryJob, rows: T[]): Promise<void>;
}
export type HistoryPage<T> = { rows: T[]; scanned: number; cursor: string | null };

/** Resumable, one-page-at-a-time backfill. Live monitoring remains independent. */
export class MarketHistory<T> {
  private busy = false;
  private preferred: string | undefined;
  private startedAt: Date;

  constructor(
    private repository: HistoryRepository<T>,
    private page: (job: HistoryJob) => Promise<HistoryPage<T>>,
    private now: () => Date = () => new Date(),
    private onError: (ticker: string, error: string) => void = () => undefined,
  ) { this.startedAt = this.now(); }

  private stale(job: HistoryJob, now: Date) {
    return (job.captureMinimum ?? 5_000) > CAPTURE_MINIMUM ||
      job.snapshotAt < this.startedAt || now.getTime() - job.snapshotAt.getTime() >= 15 * 60_000;
  }

  async status(ticker: string): Promise<HistoryStatus> {
    this.preferred = ticker;
    const job = await this.repository.job(ticker);
    return { phase: job?.phase === "complete" && this.stale(job, this.now()) ? "pending" : job?.phase ?? "pending",
      scanned: job?.scanned ?? 0, error: Boolean(job?.error) };
  }

  async tick() {
    if (this.busy) return;
    this.busy = true;
    try {
      const now = this.now();
      const candidates = (await this.repository.candidates()).filter(({ job }) =>
        (!job || job.phase !== "complete" || this.stale(job, now)) &&
        (!job?.error || now.getTime() - job.updatedAt.getTime() >= 60_000));
      candidates.sort((a, b) =>
        Number(b.ticker === this.preferred) - Number(a.ticker === this.preferred) ||
        (a.job?.updatedAt.getTime() ?? 0) - (b.job?.updatedAt.getTime() ?? 0));
      const candidate = candidates[0];
      if (!candidate) return;
      // A lower capture floor needs a complete fresh pass, not just trades since
      // the last snapshot. Rows are deduplicated and finished games stay excluded.
      const needsExpandedCoverage = candidate.job && (candidate.job.captureMinimum ?? 5_000) > CAPTURE_MINIMUM;
      let job: HistoryJob = !candidate.job || needsExpandedCoverage ? {
        ticker: candidate.ticker, phase: "live", cursor: null,
        snapshotAt: now, sinceAt: null, scanned: 0, captureMinimum: CAPTURE_MINIMUM,
        error: null, updatedAt: now,
      } : candidate.job;
      if (job.phase === "complete") {
        job = { ...job, phase: "live", sinceAt: job.snapshotAt, snapshotAt: now, cursor: null };
      }
      // Recheck immediately before requesting a page; the game can finish while queued.
      if (this.repository.eligible && !await this.repository.eligible(job.ticker)) return;
      try {
        const result = await this.page(job);
        if (result.cursor && result.cursor === job.cursor) {
          throw new Error("Kalshi repeated a history cursor; waiting before retrying.");
        }
        await this.repository.commit({
          ...job,
          phase: result.cursor ? job.phase : job.phase === "live" ? "archive" : "complete",
          cursor: result.cursor,
          scanned: job.scanned + result.scanned,
          error: null, updatedAt: this.now(),
        }, result.rows);
      } catch (error) {
        const message = error instanceof Error ? error.message : "Historical data unavailable.";
        await this.repository.commit({ ...job, error: message, updatedAt: this.now() }, []);
        this.onError(job.ticker, message);
      }
    } finally {
      this.busy = false;
    }
  }
}
