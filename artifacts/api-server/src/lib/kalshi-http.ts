import type { ReadPriority } from "./kalshi-read-scheduler";

export class KalshiHttpError extends Error {
  constructor(public readonly status: number) {
    super(`Kalshi returned HTTP ${status}`);
  }
}

export class KalshiCooldownError extends Error {
  constructor(public readonly retryAt: number) {
    super(`Kalshi: pausa temporal por límite de consultas. Se reintentará automáticamente desde ${new Date(retryAt).toLocaleString("es-US", { timeZone: "America/New_York", hour12: false })} ET.`);
  }
}

export function retryAfterMs(value: string | null, now: number): number | null {
  if (!value?.trim()) return null;
  const text = value.trim();
  if (/^\d+(\.\d+)?$/.test(text)) {
    const ms = Number(text) * 1000;
    return Number.isFinite(ms) ? ms : null;
  }
  const date = Date.parse(text);
  return Number.isFinite(date) ? Math.max(0, date - now) : null;
}

/** One instance for ALL Kalshi callers. No sleeping requests or retry queues. */
export class KalshiHttpClient {
  private retryAt = 0;
  private failures = 0;
  private generation = 0;
  private probing = false;
  private cache = new Map<string, { until: number; value: Promise<unknown> }>();
  private requests = 0;
  private limited = 0;
  private cacheHits = 0;
  private routes = new Map<string, number>();

  constructor(
    private readonly request: typeof fetch = fetch,
    private readonly now: () => number = Date.now,
    private readonly onPause: (retryAt: number, delayMs: number) => void = () => {},
    private readonly prepare?: (url: string, priority: ReadPriority) => Promise<Record<string, string> | undefined>,
  ) {}

  get isPaused() {
    return this.now() < this.retryAt || this.probing;
  }

  get stats() {
    return { requests: this.requests, limited: this.limited, cacheHits: this.cacheHits,
      pausedUntil: this.retryAt || null, byRoute: Object.fromEntries(this.routes) };
  }

  invalidate(path: string) {
    for (const key of this.cache.keys()) if (new URL(key).pathname === path) this.cache.delete(key);
  }

  prime(url: string, value: unknown, ttl = 60_000) {
    if (this.cache.size >= 5000) this.cache.delete(this.cache.keys().next().value!);
    this.cache.set(url, { until: this.now() + ttl, value: Promise.resolve(value) });
  }

  /** Shared across trade descriptions, scores and game status. Trades and
   * settlement lists are never cached; a failed request cannot become saved data. */
  cachedJson<T>(url: string, priority: ReadPriority = "metadata"): Promise<T> {
    const path = new URL(url).pathname.replace(/^\/trade-api\/v2/, "");
    const ttl = /^\/(?:historical\/)?markets\/[^/]+$/.test(path) && !path.endsWith("/trades") ? 60_000
      : path.startsWith("/events/") ? 300_000
      : path.startsWith("/live_data/") && path !== "/live_data/batch" ? 60_000
      : path.startsWith("/milestones") ? 60_000 : 0;
    if (!ttl) return this.json<T>(url, priority);
    const old = this.cache.get(url);
    if (old && old.until > this.now()) { this.cacheHits++; return old.value as Promise<T>; }
    const value = this.json<T>(url, priority).catch(error => {
      if (this.cache.get(url)?.value === value) this.cache.delete(url);
      throw error;
    });
    if (this.cache.size >= 5000) this.cache.delete(this.cache.keys().next().value!);
    this.cache.set(url, { until: this.now() + ttl, value });
    return value;
  }

  async json<T>(url: string, priority: ReadPriority = "metadata"): Promise<T> {
    const start = this.now();
    if (start < this.retryAt || this.probing) {
      throw new KalshiCooldownError(Math.max(this.retryAt, start + 1000));
    }
    // After a pause, let just one caller probe recovery instead of a worker burst.
    const probe = this.failures > 0;
    if (probe) this.probing = true;
    const generation = this.generation;
    try {
      const headers = this.prepare ? await this.prepare(url, priority) : undefined;
      // A queued, paced request must not slip through a newly activated pause.
      if (this.now() < this.retryAt) throw new KalshiCooldownError(this.retryAt);
      this.requests++;
      const path = new URL(url).pathname.replace(/^\/trade-api\/v2/, "");
      const route = path.replace(/\/(markets|events)\/(?!trades(?:$|\/))[^/]+$/, "/$1/:id")
        .replace(/\/(milestone|milestones)\/[^/]+$/, "/$1/:id");
      this.routes.set(route, (this.routes.get(route) ?? 0) + 1);
      const response = await this.request(url, { headers, signal: AbortSignal.timeout(15_000) });
      if (response.status === 429) {
        this.limited++;
        const now = this.now();
        this.failures = Math.min(this.failures + 1, 5);
        this.generation++;
        const backoff = Math.min(30_000 * 2 ** (this.failures - 1), 300_000);
        const delay = Math.max(backoff, retryAfterMs(response.headers.get('retry-after'), now) ?? 0);
        this.retryAt = Math.max(this.retryAt, now + delay);
        await response.body?.cancel().catch(() => {});
        this.onPause(this.retryAt, this.retryAt - now);
        throw new KalshiCooldownError(this.retryAt);
      }
      if (!response.ok) {
        await response.body?.cancel().catch(() => {});
        throw new KalshiHttpError(response.status);
      }
      const result = await response.json() as T;
      // An older in-flight success must not clear a newer caller's 429 pause.
      if (this.generation === generation) {
        this.failures = 0;
        this.retryAt = 0;
      }
      return result;
    } finally {
      if (probe) this.probing = false;
    }
  }
}
