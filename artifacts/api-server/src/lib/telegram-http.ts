import { retryAfterMs } from "./kalshi-http";

type TelegramResult<T> = {
  ok: boolean; result?: T; description?: string;
  parameters?: { retry_after?: number };
};

export function telegramTimeoutMs(method: string, body?: Record<string, unknown> | FormData) {
  if (body instanceof FormData) return 60_000;
  if (method !== "getUpdates") return 30_000;
  const seconds = Number(body?.timeout ?? 0);
  return Math.max(30_000, (Math.min(50, Math.max(0, seconds || 0)) + 20) * 1000);
}

/** Shared transport for polling, dashboard and alerts. Never retries a POST:
 * a timeout can happen after Telegram accepted a message. The durable outbox
 * owns notification retries, not this transport. */
export class TelegramHttpClient {
  private retryAt = 0;
  private failures = 0;
  private generation = 0;
  private probing = false;

  constructor(
    private readonly token: () => string,
    private readonly request: typeof fetch = fetch,
    private readonly now: () => number = Date.now,
  ) {}

  async call<T>(method: string, body?: Record<string, unknown> | FormData): Promise<TelegramResult<T>> {
    const token = this.token();
    if (!token) throw new Error("Telegram bot token is not configured.");
    if (this.now() < this.retryAt || this.probing) {
      const seconds = Math.max(1, Math.ceil((this.retryAt - this.now()) / 1000));
      throw new Error(`Telegram connection paused; retry after ${seconds}`);
    }
    const probe = this.failures > 0;
    if (probe) this.probing = true;
    const generation = this.generation;
    const multipart = body instanceof FormData;
    try {
      let response: Response;
      let result: TelegramResult<T>;
      try {
        response = await this.request(`https://api.telegram.org/bot${token}/${method}`, {
          method: body ? "POST" : "GET",
          headers: body && !multipart ? { "content-type": "application/json" } : undefined,
          body: multipart ? body : body ? JSON.stringify(body) : undefined,
          signal: AbortSignal.timeout(telegramTimeoutMs(method, body)),
        });
        if (response.status >= 500) {
          await response.body?.cancel().catch(() => {});
          throw new Error("Telegram temporary server failure");
        }
        result = await response.json() as TelegramResult<T>;
      } catch (error) {
        this.failures = Math.min(5, this.failures + 1);
        this.retryAt = Math.max(this.retryAt, this.now() + Math.min(60_000, 5000 * 2 ** (this.failures - 1)));
        this.generation++;
        // Never propagate fetch URLs: they contain the bot token.
        const code = error instanceof Error && error.name === "TimeoutError" ? "timeout" : "connection or response failure";
        throw new Error(`Telegram ${code} (${method}); retry after ${Math.ceil((this.retryAt - this.now()) / 1000)}`);
      }
      if (response.status === 429 || result.parameters?.retry_after) {
        const seconds = Number(result.parameters?.retry_after);
        const delay = Math.max(1000, Number.isFinite(seconds) ? seconds * 1000 : 0,
          retryAfterMs(response.headers.get("retry-after"), this.now()) ?? 30_000);
        this.retryAt = Math.max(this.retryAt, this.now() + delay);
        this.failures = Math.min(5, this.failures + 1);
        this.generation++;
        throw new Error(`Telegram rate limit; retry after ${Math.ceil(delay / 1000)}`);
      }
      if (!response.ok || !result.ok) {
        // Description can include user-supplied content; log only status/code.
        // Preserve harmless error categories used for idempotent edits/cleanup.
        const known = ["message is not modified", "message to delete not found",
          "message to edit not found", "message can't be edited", "message can't be deleted"]
          .find(text => result.description?.toLowerCase().includes(text));
        throw new Error(known ?? `Telegram request rejected (HTTP ${response.status})`);
      }
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
