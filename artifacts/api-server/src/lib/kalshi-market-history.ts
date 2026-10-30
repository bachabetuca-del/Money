import { CAPTURE_MINIMUM } from "./kalshi-trade-bands";
export const HISTORY_AUDIT_VERSION = 1;

export type HistoryJob = {
  ticker: string;
  phase: "live" | "archive" | "complete";
  cursor: string | null;
  snapshotAt: Date;
  sinceAt: Date | null;
  scanned: number;
  captureMinimum?: number;
  auditVersion?: number;
  finalPass?: boolean;
  auditedAt?: Date | null;
  error: string | null;
  updatedAt: Date;
};
export type HistoryStatus = {
  phase: HistoryJob["phase"] | "pending";
  scanned: number;
  error: boolean;
};
export type HistoryCandidate = { ticker: string; job?: HistoryJob; closed?: boolean; closedAt?: Date | null };
function needsFinalAudit({ job, closed, closedAt }: HistoryCandidate) {
  return Boolean(closed && (!job?.finalPass || (job.phase === "complete" && !job.auditedAt) ||
    job.sinceAt !== null || (closedAt && job.snapshotAt < closedAt)));
}

/** Keep this order aligned with the bounded database selector. Old phase flags
 * do not mean an import can resume under the current validation rules. */
export function historyQueuePriority(candidate: HistoryCandidate, preferred?: string) {
  if (candidate.ticker === preferred) return -1;
  const { job, closed } = candidate;
  const resumable = job && job.phase !== "complete" &&
    (job.auditVersion ?? 0) >= HISTORY_AUDIT_VERSION &&
    (job.captureMinimum ?? 5000) <= CAPTURE_MINIMUM && !needsFinalAudit(candidate);
  const stage = resumable ? job.phase === "archive" ? 0 : 1 : 2;
  return (closed ? 0 : 3) + stage;
}
export interface HistoryRepository<T> {
  candidates(preferred?: string): Promise<HistoryCandidate[]>;
  job(ticker: string): Promise<HistoryJob | undefined>;
  eligible?(ticker: string, finalPass?: boolean): Promise<boolean>;
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
    if ((job.auditVersion ?? 0) < HISTORY_AUDIT_VERSION || (job.captureMinimum ?? 5_000) > CAPTURE_MINIMUM) return true;
    if (job.finalPass && job.auditedAt && job.phase === "complete" && job.sinceAt === null) return false;
    return job.snapshotAt < this.startedAt || now.getTime() - job.snapshotAt.getTime() >= 15 * 60_000;
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
      const candidates = (await this.repository.candidates(this.preferred)).filter(candidate => {
        const { job } = candidate;
        return (
        (!job || job.phase !== "complete" || this.stale(job, now) ||
          needsFinalAudit(candidate)) &&
        (!job?.error || now.getTime() - job.updatedAt.getTime() >= 60_000));
      });
      candidates.sort((a, b) =>
        historyQueuePriority(a, this.preferred) - historyQueuePriority(b, this.preferred) ||
        (a.job?.updatedAt.getTime() ?? 0) - (b.job?.updatedAt.getTime() ?? 0));
      const candidate = candidates[0];
      if (!candidate) return;
      // A new validation version, lower capture floor or official settlement needs
      // a fresh full pass. Final audits stop permanently after both sources finish.
      const needsExpandedCoverage = candidate.job && ((candidate.job.captureMinimum ?? 5_000) > CAPTURE_MINIMUM ||
        (candidate.job.auditVersion ?? 0) < HISTORY_AUDIT_VERSION ||
        needsFinalAudit(candidate));
      let job: HistoryJob = !candidate.job || needsExpandedCoverage ? {
        ticker: candidate.ticker, phase: "live", cursor: null,
        snapshotAt: now, sinceAt: null, scanned: 0, captureMinimum: CAPTURE_MINIMUM,
        auditVersion: HISTORY_AUDIT_VERSION, finalPass: Boolean(candidate.closed), auditedAt: null,
        error: null, updatedAt: now,
      } : candidate.job;
      if (job.phase === "complete") {
        job = { ...job, phase: "live", sinceAt: job.snapshotAt, snapshotAt: now, cursor: null };
      }
      // Recheck immediately before requesting a page; the game can finish while queued.
      if (this.repository.eligible && !await this.repository.eligible(job.ticker, job.finalPass)) return;
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
          auditedAt: job.finalPass && job.phase === "archive" && !result.cursor ? this.now() : null,
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
