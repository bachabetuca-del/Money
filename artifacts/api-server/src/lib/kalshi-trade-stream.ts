import WebSocket from "ws";
import type { KalshiAuth } from "./kalshi-auth";
import { decodeLifecycle, type LifecycleEvent } from "./kalshi-lifecycle";

export const KALSHI_WS_URL = "wss://external-api-ws.kalshi.com/trade-api/ws/v2";
export type StreamTrade = {
  trade_id: string; ticker: string; created_time: string;
  count_fp?: string; count?: number;
  yes_price_dollars?: string; no_price_dollars?: string;
  taker_side?: string; taker_outcome_side?: string; taker_book_side?: string;
  is_block_trade?: boolean;
};

export function decodeStreamTrade(msg: Record<string, unknown>): StreamTrade | null {
  const timestamp = typeof msg.ts_ms === "number" ? msg.ts_ms
    : typeof msg.ts === "number" ? msg.ts * 1000 : NaN;
  if (typeof msg.trade_id !== "string" || !msg.trade_id ||
      typeof msg.market_ticker !== "string" || !msg.market_ticker ||
      !Number.isFinite(timestamp) || timestamp < 0 || timestamp > 8.64e15) return null;
  const text = (key: string) => typeof msg[key] === "string" ? msg[key] as string : undefined;
  return {
    trade_id: msg.trade_id, ticker: msg.market_ticker,
    created_time: new Date(timestamp).toISOString(),
    count_fp: text("count_fp"), count: typeof msg.count === "number" ? msg.count : undefined,
    yes_price_dollars: text("yes_price_dollars"), no_price_dollars: text("no_price_dollars"),
    taker_side: text("taker_side"), taker_outcome_side: text("taker_outcome_side"),
    taker_book_side: text("taker_book_side"), is_block_trade: msg.is_block_trade === true,
  };
}

type Options = {
  auth: KalshiAuth;
  accept: (trade: StreamTrade) => boolean;
  batch: (trades: StreamTrade[]) => Promise<void>;
  recovery: () => void;
  lifecycle?: (event: LifecycleEvent) => void;
  checkpoint?: (timestamp: number) => void;
  state: (live: boolean, message: string) => void;
  url?: string;
  retryMs?: number;
  heartbeatMs?: number;
  subscriptionTimeoutMs?: number;
};

/** Authenticated public feed. No orders, account fills, or trading permissions. */
export class KalshiTradeStream {
  private socket?: WebSocket;
  private stopped = true;
  private reconnect?: ReturnType<typeof setTimeout>;
  private heartbeat?: ReturnType<typeof setInterval>;
  private flushTimer?: ReturnType<typeof setInterval>;
  private queue = new Map<string, StreamTrade>();
  private flushing = false;
  private attempts = 0;
  private sequences = new Map<string, number>();
  private lastFrame = 0;
  private subscribed = false;
  private subscribedChannels = new Set<string>();
  private openedAt = 0;
  private acknowledgedAt = 0;
  private storageFailed = false;
  get live() { return this.subscribed; }
  constructor(private readonly options: Options) {}

  start() {
    if (!this.stopped) return;
    this.stopped = false;
    this.flushTimer = setInterval(() => void this.flush(), 1000);
    this.connect();
  }

  stop() {
    this.stopped = true;
    this.subscribed = false;
    this.subscribedChannels.clear();
    clearTimeout(this.reconnect);
    clearInterval(this.heartbeat);
    clearInterval(this.flushTimer);
    this.socket?.terminate();
  }

  private connect() {
    if (this.stopped) return;
    this.sequences.clear();
    this.subscribedChannels.clear();
    this.subscribed = false;
    this.openedAt = 0;
    this.acknowledgedAt = 0;
    this.options.state(false, "Conectando con Kalshi WebSocket…");
    const socket = new WebSocket(this.options.url ?? KALSHI_WS_URL, {
      headers: this.options.auth.headers("/trade-api/ws/v2"),
      handshakeTimeout: 15_000, maxPayload: 1024 * 1024,
    });
    this.socket = socket;
    socket.on("open", () => {
      this.lastFrame = this.openedAt = Date.now();
      const channels = this.options.lifecycle ? ["trade", "market_lifecycle_v2", "multivariate_market_lifecycle"] : ["trade"];
      socket.send(JSON.stringify({ id: 1, cmd: "subscribe", params: {
        channels,
      } }));
      this.heartbeat = setInterval(() => {
        // ws automatically answers server pings. Our ping verifies a quiet socket.
        if (Date.now() - this.lastFrame > (this.options.heartbeatMs ?? 60_000) ||
            (!channels.every(channel => this.subscribedChannels.has(channel)) &&
              Date.now() - this.openedAt > (this.options.subscriptionTimeoutMs ?? 15_000))) socket.terminate();
        else if (socket.readyState === WebSocket.OPEN) socket.ping();
      }, this.options.heartbeatMs ? Math.max(50, this.options.heartbeatMs / 2) : 15_000);
    });
    socket.on("pong", () => { this.lastFrame = Date.now(); });
    socket.on("ping", () => { this.lastFrame = Date.now(); });
    socket.on("message", data => {
      this.lastFrame = Date.now();
      try {
        const frame = JSON.parse(data.toString());
        if (typeof frame.seq === "number" && frame.type !== "subscribed") {
          // Sequence numbers belong to a subscription, not the entire socket.
          const key = String(frame.sid ?? frame.type);
          const previous = this.sequences.get(key);
          if (previous !== undefined && frame.seq !== previous + 1) this.options.recovery();
          this.sequences.set(key, frame.seq);
        }
        if (frame.type === "error") {
          this.options.state(false, `Kalshi rechazó la suscripción (código ${Number(frame.msg?.code) || 0}).`);
          socket.terminate();
        } else if (frame.type === "subscribed") {
          this.subscribedChannels.add(String(frame.msg?.channel));
          if (frame.msg?.channel === "trade") {
            this.subscribed = true;
            this.acknowledgedAt = Date.now();
            this.options.state(true, "WebSocket conectado");
            this.options.recovery(); // REST overlap covers the connection/reconnection gap.
          }
        } else if (frame.type === "trade") {
          const trade = decodeStreamTrade(frame.msg ?? {});
          if (!trade) { this.options.recovery(); return; }
          if (!this.options.accept(trade)) return;
          if (this.queue.size >= 10_000) {
            this.options.recovery();
            socket.terminate(); // Never grow memory indefinitely or silently drop executions.
            return;
          }
          this.queue.set(trade.trade_id, trade);
        } else if (this.options.lifecycle) {
          const event = decodeLifecycle(frame.type, frame.msg ?? {});
          if (event) this.options.lifecycle(event);
        }
      } catch {
        this.options.recovery();
        socket.terminate();
      }
    });
    // Do not log the ws error object: it can carry handshake request headers.
    socket.on("error", () => this.options.state(false, "WebSocket no disponible; reconexión automática."));
    socket.on("close", () => {
      clearInterval(this.heartbeat);
      this.subscribed = false;
      if (this.stopped) return;
      this.options.state(false, "WebSocket desconectado; recuperando con REST.");
      this.options.recovery();
      // Only a stable connection resets backoff, not a short-lived successful handshake.
      if (this.acknowledgedAt && Date.now() - this.acknowledgedAt > 60_000) this.attempts = 0;
      const delay = Math.min((this.options.retryMs ?? 1000) * 2 ** Math.min(this.attempts++, 8), 60_000);
      this.reconnect = setTimeout(() => this.connect(), delay + Math.random() * delay * 0.2);
    });
  }

  private async flush() {
    if (this.flushing || this.stopped) return;
    if (!this.queue.size) {
      // Pings/frames prove a quiet, subscribed connection is still healthy.
      // Keep recovery windows bounded even when no sports trade clears $1k.
      if (this.live) this.options.checkpoint?.(this.lastFrame);
      return;
    }
    this.flushing = true;
    const batch = [...this.queue.values()].slice(0, 100);
    try {
      await this.options.batch(batch);
      for (const trade of batch) this.queue.delete(trade.trade_id);
      if (this.storageFailed && this.live) this.options.state(true, "WebSocket conectado");
      this.storageFailed = false;
    } catch {
      this.storageFailed = true;
      this.options.state(this.live, "Error guardando operaciones; se reintentará sin descartar la cola.");
      this.options.recovery();
    } finally {
      this.flushing = false;
    }
  }
}
