import WebSocket from "ws";
import { randomUUID } from "node:crypto";
import type { KalshiAuth } from "../kalshi-auth";
import { KALSHI_WS_URL } from "../kalshi-trade-stream";
import { PaperBook, type BookQuote } from "./book";

/** One bounded auxiliary public-market socket INSIDE the existing singleton.
 * Only subscribe/update_subscription are sent: never an order/account command. */
export class PaperBookStream {
  private socket?: WebSocket;
  private book = new PaperBook();
  private wanted = new Map<string, number>();
  private subscribed = new Set<string>();
  private sid: number | null = null;
  private command = 0;
  private connectionAt = 0;
  private lastPong = 0;
  private lastRefresh = 0;
  private retryAt = 0;
  private attempts = 0;
  private enabled = false;
  error: string | null = null;
  constructor(private readonly auth: KalshiAuth, private readonly url = KALSHI_WS_URL) {}
  setEnabled(on: boolean) { this.enabled = on; if (!on) this.stop(); }
  watch(ticker: string, until: number, maximum: number): boolean {
    if (!this.enabled) return false;
    if (!this.wanted.has(ticker) && this.wanted.size >= maximum) return false;
    this.wanted.set(ticker, Math.max(until, this.wanted.get(ticker) ?? 0));
    return true;
  }
  quote(ticker: string, now: number): BookQuote | null { return this.book.quote(ticker, now); }
  stop() {
    this.wanted.clear(); this.subscribed.clear(); this.sid = null; this.book.invalidate();
    this.socket?.terminate(); this.socket = undefined;
  }
  tick(now: number) {
    for (const [ticker, expiry] of this.wanted) if (expiry < now) { this.wanted.delete(ticker); this.book.remove(ticker); }
    if (!this.enabled || !this.wanted.size) { if (this.socket) this.stop(); return; }
    if (!this.socket) {
      if (now < this.retryAt) return;
      this.connect(now); return;
    }
    if (now - this.lastPong > 15000 || !this.sid && now - this.connectionAt > 15000) {
      this.fail("Libro sin confirmación o sin latido reciente."); return;
    }
    if (this.socket.readyState !== WebSocket.OPEN || this.sid === null) return;
    const additions = [...this.wanted.keys()].filter(t => !this.subscribed.has(t));
    const removed = [...this.subscribed].filter(t => !this.wanted.has(t));
    if (additions.length) {
      this.send("update_subscription", { sid: this.sid, action: "add_markets", market_tickers: additions });
      for (const t of additions) this.subscribed.add(t);
    }
    if (removed.length) {
      this.send("update_subscription", { sid: this.sid, action: "delete_markets", market_tickers: removed });
      for (const t of removed) this.subscribed.delete(t);
    }
    if (now - this.lastRefresh >= 5000) {
      this.socket.ping();
      this.send("update_subscription", { sid: this.sid, action: "get_snapshot", market_tickers: [...this.wanted.keys()] });
      this.lastRefresh = now;
    }
  }
  private send(cmd: "subscribe" | "update_subscription", params: Record<string, unknown>) {
    if (this.socket?.readyState === WebSocket.OPEN)
      this.socket.send(JSON.stringify({ id: ++this.command, cmd, params }));
  }
  private fail(reason: string) {
    this.error = reason; this.book.invalidate(); this.socket?.terminate();
  }
  private connect(now: number) {
    this.book.connect(randomUUID(), now); this.subscribed.clear(); this.sid = null;
    this.connectionAt = this.lastPong = now; this.lastRefresh = now;
    const socket = new WebSocket(this.url, { headers: this.auth.headers("/trade-api/ws/v2"),
      handshakeTimeout: 10000, maxPayload: 4 * 1024 * 1024 });
    this.socket = socket;
    socket.on("open", () => {
      if (socket !== this.socket) return;
      this.send("subscribe", { channels: ["orderbook_delta"], market_tickers: [...this.wanted.keys()] });
      this.subscribed = new Set(this.wanted.keys());
    });
    socket.on("pong", () => { this.lastPong = Date.now(); this.book.pong(this.lastPong); });
    socket.on("message", data => {
      if (socket !== this.socket) return;
      const received = Date.now();
      try {
        const msg = JSON.parse(data.toString());
        if (msg.type === "error") { this.fail("Kalshi rechazó una suscripción al libro."); return; }
        if (msg.type === "subscribed" && msg.msg?.channel === "orderbook_delta") {
          this.sid = msg.msg.sid; this.attempts = 0;
        }
        if (typeof msg.sid === "number" && this.sid === null) this.sid = msg.sid;
        if (!this.book.apply(msg, received)) { this.fail("Libro inválido: secuencia incompleta o datos inconsistentes."); return; }
        this.lastPong = received;
        if (msg.type === "orderbook_snapshot") this.error = null;
      } catch { this.fail("Mensaje de libro no válido."); }
    });
    socket.on("error", () => { this.error = "No se pudo conectar el libro público de Kalshi."; this.book.invalidate(); });
    socket.on("close", () => {
      if (this.socket !== socket) return;
      this.book.invalidate(); this.socket = undefined; this.sid = null; this.subscribed.clear();
      this.retryAt = Date.now() + Math.min(60000, 1000 * 2 ** Math.min(this.attempts++, 6));
    });
  }
}
