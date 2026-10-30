/** REST checkpoints must not cross a known gap until recovery succeeds. */
export class KalshiLiveCoverage {
  boundary: number | null = null;
  private generation = 0;
  private recovered = -1;
  constructor(readonly startedAt: number) {}
  requestRecovery(since?: number) {
    this.generation++;
    if (since !== undefined && Number.isFinite(since)) this.boundary = Math.min(this.boundary ?? since, since);
  }
  needsRecovery(live: boolean) { return !live || this.generation !== this.recovered; }
  snapshot() { return { boundary: this.boundary, generation: this.generation }; }
  recoveredThrough(snapshot: ReturnType<KalshiLiveCoverage["snapshot"]>, startedAt: number) {
    if (snapshot.generation === this.generation) this.boundary = Math.max(this.boundary ?? 0, startedAt - 60_000);
    this.recovered = snapshot.generation;
  }
  streamPersisted(oldestTimestamp: number, live: boolean) {
    if (live && !this.needsRecovery(live)) {
      this.boundary = Math.max(this.boundary ?? 0, oldestTimestamp - 60_000);
    }
  }
  establishStartupBoundary() {
    if (this.boundary === null) this.boundary = this.startedAt;
  }
  notificationBoundary(boundary: number | null) {
    return boundary === null ? null : Math.max(boundary, this.startedAt);
  }
}
