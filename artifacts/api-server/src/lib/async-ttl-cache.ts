/** Small, bounded single-flight cache. Failures never become successful/stale responses. */
export class AsyncTtlCache<T> {
  private entries = new Map<string, { promise: Promise<T>; expires: number; pending: boolean }>();
  constructor(private ttlMs: number, private limit = 8, private clock = Date.now) {}

  get(key: string, load: () => Promise<T>): Promise<T> {
    const now = this.clock();
    for (const [k, value] of this.entries) {
      if (!value.pending && value.expires <= now) this.entries.delete(k);
    }
    const existing = this.entries.get(key);
    if (existing) {
      this.entries.delete(key);
      this.entries.set(key, existing);
      return existing.promise;
    }
    // Do not evict in-flight work and create duplicate queries under pressure.
    if (this.entries.size >= this.limit) {
      const oldest = [...this.entries].find(([, value]) => !value.pending);
      if (oldest) this.entries.delete(oldest[0]);
      else return Promise.resolve().then(load);
    }
    const entry = { promise: undefined as unknown as Promise<T>, expires: 0, pending: true };
    entry.promise = Promise.resolve().then(load).then(value => {
      entry.expires = this.clock() + this.ttlMs;
      entry.pending = false;
      return value;
    }, error => {
      if (this.entries.get(key) === entry) this.entries.delete(key);
      throw error;
    });
    this.entries.set(key, entry);
    return entry.promise;
  }
}
