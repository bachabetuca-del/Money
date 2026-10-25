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

  constructor(
    private readonly request: typeof fetch = fetch,
    private readonly now: () => number = Date.now,
    private readonly onPause: (retryAt: number, delayMs: number) => void = () => {},
  ) {}

  get isPaused() {
    return this.now() < this.retryAt || this.probing;
  }

  async json<T>(url: string): Promise<T> {
    const start = this.now();
    if (start < this.retryAt || this.probing) {
      throw new KalshiCooldownError(Math.max(this.retryAt, start + 1000));
    }
    // After a pause, let just one caller probe recovery instead of a worker burst.
    const probe = this.failures > 0;
    if (probe) this.probing = true;
    const generation = this.generation;
    try {
      const response = await this.request(url, { signal: AbortSignal.timeout(15_000) });
      if (response.status === 429) {
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
