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

type Circuit = { retryAt: number; failures: number; generation: number; probing: boolean };
const circuit = (): Circuit => ({ retryAt: 0, failures: 0, generation: 0, probing: false });

export class TelegramRetryError extends Error {
  constructor(message: string, readonly retryAfterMs: number) {
    super(message);
    this.name = "TelegramRetryError";
  }
}

/** Separate failure circuits for commands, dashboard and message delivery.
 * Telegram's explicit flood limits remain shared across all three.
 * Never retries a POST:
 * a timeout can happen after Telegram accepted a message. The durable outbox
 * owns notification retries, not this transport. */
export class TelegramHttpClient {
  private rateLimitUntil = 0;
  private readonly polling = circuit();
  private readonly dashboard = circuit();
  private readonly delivery = circuit();

  constructor(
    private readonly token: () => string,
    private readonly request: typeof fetch = fetch,
    private readonly now: () => number = Date.now,
  ) {}

  async call<T>(method: string, body?: Record<string, unknown> | FormData): Promise<TelegramResult<T>> {
    const token = this.token();
    if (!token) throw new Error("Telegram bot token is not configured.");
    const lane = method === "getUpdates" ? this.polling :
      method === "sendMessage" ? this.delivery : this.dashboard;
    const retryAt = Math.max(lane.retryAt, this.rateLimitUntil);
    if (this.now() < retryAt || lane.probing) {
      const delay = Math.max(1000, retryAt - this.now());
      throw new TelegramRetryError(`Telegram connection paused; retry after ${Math.ceil(delay / 1000)}`, delay);
    }
    const probe = lane.failures > 0;
    if (probe) lane.probing = true;
    const generation = lane.generation;
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
        try {
          result = await response.json() as TelegramResult<T>;
        } catch (error) {
          // Even a non-JSON flood response must pause every lane.
          if (response.status !== 429) throw error;
          result = { ok: false };
        }
      } catch (error) {
        lane.failures = Math.min(5, lane.failures + 1);
        lane.retryAt = Math.max(lane.retryAt, this.now() + Math.min(60_000, 5000 * 2 ** (lane.failures - 1)));
        lane.generation++;
        // Never propagate fetch URLs: they contain the bot token.
        const code = error instanceof Error && error.name === "TimeoutError" ? "timeout" : "connection or response failure";
        const delay = lane.retryAt - this.now();
        throw new TelegramRetryError(`Telegram ${code} (${method}); retry after ${Math.ceil(delay / 1000)}`, delay);
      }
      if (response.status === 429 || result.parameters?.retry_after) {
        const seconds = Number(result.parameters?.retry_after);
        const headerDelay = retryAfterMs(response.headers.get("retry-after"), this.now());
        const delay = Math.max(1000, Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 :
          headerDelay ?? 30_000, headerDelay ?? 0);
        this.rateLimitUntil = Math.max(this.rateLimitUntil, this.now() + delay);
        throw new TelegramRetryError(`Telegram rate limit; retry after ${Math.ceil(delay / 1000)}`, delay);
      }
      if (!response.ok || !result.ok) {
        // Description can include user-supplied content; log only status/code.
        // Preserve harmless error categories used for idempotent edits/cleanup.
        const known = ["message is not modified", "message to delete not found",
          "message to edit not found", "message can't be edited", "message can't be deleted"]
          .find(text => result.description?.toLowerCase().includes(text));
        throw new Error(known ?? `Telegram request rejected (HTTP ${response.status})`);
      }
      if (lane.generation === generation) {
        lane.failures = 0;
        lane.retryAt = 0;
      }
      return result;
    } finally {
      if (probe) lane.probing = false;
    }
  }
}
