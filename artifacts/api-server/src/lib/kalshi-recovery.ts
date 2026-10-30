import type { KalshiLiveCoverage } from "./kalshi-live-coverage";

export type RecoveryState = {
  checkpointAt: Date; targetAt: Date | null; windowStartAt: Date | null; windowEndAt: Date | null;
  phase: "live" | "archive"; cursor: string | null; scanned: number; error: string | null; updatedAt: Date;
};
export interface RecoveryStore {
  load(): Promise<RecoveryState | undefined>;
  seed(): Promise<Date | null>;
  save(state: RecoveryState): Promise<void>;
}
type Page<T> = { rows: T[]; cursor: string | null };

/** Fixed five-minute windows and durable per-page cursors, without a trade-count
 * ceiling. Progress is saved AFTER executions/outbox, so crashes only replay
 * deduplicated data. Both available partitions are reconciled. */
export class KalshiRecovery<T> {
  private state?: RecoveryState;
  private cycle?: ReturnType<KalshiLiveCoverage["snapshot"]>;
  private busy = false;
  private retryAt = 0;
  constructor(private store: RecoveryStore, private coverage: KalshiLiveCoverage,
    private read: (state: RecoveryState) => Promise<Page<T>>,
    private ingest: (rows: T[], boundary: number) => Promise<void>,
    private now: () => number = Date.now) {}

  async initialize() {
    if (this.state) return;
    const saved = await this.store.load();
    const checkpointAt = saved?.checkpointAt ?? new Date(Math.min(this.now(), (await this.store.seed())?.getTime() ?? this.now()) - 60_000);
    const initial: RecoveryState = saved ?? { checkpointAt, targetAt: null, windowStartAt: null, windowEndAt: null,
      phase: "live", cursor: null, scanned: 0, error: null, updatedAt: new Date(this.now()) };
    await this.store.save(initial);
    this.state = initial;
    this.coverage.boundary = checkpointAt.getTime();
  }

  get stats() {
    return { checkpointAt: this.state?.checkpointAt.toISOString() ?? null,
      pending: !!this.state?.targetAt, phase: this.state?.phase ?? null,
      lagSeconds: this.state ? Math.max(0, Math.round((this.now() - this.state.checkpointAt.getTime()) / 1000)) : null,
      scanned: this.state?.scanned ?? 0, error: this.state?.error ?? null };
  }

  private async commit(state: RecoveryState) {
    await this.store.save(state);
    this.state = state;
  }

  async persistHealthy(live: boolean) {
    if (!this.state || this.busy || this.state.targetAt || this.coverage.needsRecovery(live) ||
        this.coverage.boundary === null || this.coverage.boundary <= this.state.checkpointAt.getTime()) return;
    this.busy = true;
    try { await this.commit({ ...this.state, checkpointAt: new Date(this.coverage.boundary), updatedAt: new Date(this.now()) }); }
    finally { this.busy = false; }
  }

  async tick() {
    if (this.busy || this.now() < this.retryAt) return;
    this.busy = true;
    try {
      await this.initialize();
      if (!this.cycle) {
        this.cycle = this.coverage.snapshot();
        let state = this.state!;
        if (this.cycle.boundary !== null && this.cycle.boundary < state.checkpointAt.getTime()) {
          state = { ...state, checkpointAt: new Date(this.cycle.boundary), windowStartAt: null,
            windowEndAt: null, cursor: null, phase: "live" };
        }
        await this.commit({ ...state, targetAt: new Date(Math.max(this.now(), state.targetAt?.getTime() ?? 0)) });
      }
      let state = this.state!;
      if (!state.windowEndAt) {
        state = { ...state, windowStartAt: new Date(Math.max(0, state.checkpointAt.getTime() - 60_000)),
          windowEndAt: new Date(Math.min(state.checkpointAt.getTime() + 300_000, state.targetAt!.getTime())),
          phase: "live", cursor: null };
        await this.commit(state);
      }
      const result = await this.read(state);
      if (result.cursor && result.cursor === state.cursor) throw new Error("Kalshi repeated a recovery cursor.");
      await this.ingest(result.rows, state.windowStartAt!.getTime() - 1);
      const next: RecoveryState = { ...state, scanned: state.scanned + result.rows.length,
        cursor: result.cursor, error: null, updatedAt: new Date(this.now()) };
      if (!result.cursor) {
        if (state.phase === "live") next.phase = "archive";
        else {
          next.checkpointAt = state.windowEndAt!;
          next.windowStartAt = next.windowEndAt = null;
          next.phase = "live";
          if (next.checkpointAt >= state.targetAt!) next.targetAt = null;
        }
      }
      await this.commit(next);
      if (!next.targetAt) {
        this.coverage.recoveredThrough(this.cycle!, next.checkpointAt.getTime());
        this.cycle = undefined;
      }
    } catch (error) {
      this.retryAt = this.now() + 15_000;
      if (this.state) {
        // Provider cursors may expire across a long restart. Re-read only this
        // fixed window/partition, never skip it or restart the entire outage.
        const expired = this.state.cursor && error instanceof Error && /HTTP 400/.test(error.message);
        await this.commit({ ...this.state, cursor: expired ? null : this.state.cursor,
          error: error instanceof Error ? error.message : "Recovery unavailable.", updatedAt: new Date(this.now()) });
      }
      throw error;
    } finally { this.busy = false; }
  }
}
