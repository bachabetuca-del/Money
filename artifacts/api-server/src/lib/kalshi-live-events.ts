import type { Request, Response } from "express";

/** Invalidation-only stream: the authenticated explorer remains the source of truth. */
export class KalshiLiveEvents {
  private listeners = new Set<(tickers: string[], freshTradeIds: string[]) => void>();
  private pending = new Set<string>();
  private fresh = new Set<string>();
  private timer?: ReturnType<typeof setTimeout>;
  constructor(private readonly delayMs = 1000) {}
  publish(tickers: string[], freshTradeIds: string[] = []) {
    // Don't retain idle preview/history activity when nobody is watching.
    if (!this.listeners.size || !tickers.length) return;
    for (const ticker of tickers) this.pending.add(ticker);
    for (const id of freshTradeIds) this.fresh.add(id);
    if (!this.timer) this.timer = setTimeout(() => {
      this.timer = undefined;
      const changed = [...this.pending];
      const freshIds = [...this.fresh];
      this.pending.clear();
      this.fresh.clear();
      for (const listener of this.listeners) listener(changed, freshIds);
    }, this.delayMs);
  }
  subscribe(listener: (tickers: string[], freshTradeIds: string[]) => void) {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }
  serve(req: Request, res: Response) {
    res.status(200).set({
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      "Connection": "keep-alive", "X-Accel-Buffering": "no",
    });
    res.flushHeaders();
    const write = (event: string, tickers: string[], freshTradeIds: string[] = []) => {
      if (res.writableEnded || res.destroyed) return;
      if (!res.write(`event: ${event}\ndata: ${JSON.stringify({ tickers, freshTradeIds })}\n\n`)) {
        // A slow consumer reconnects and refreshes a snapshot, rather than
        // building an unbounded in-memory backlog.
        res.end();
      }
    };
    const unsubscribe = this.subscribe((tickers, ids) => write("trades", tickers, ids));
    write("ready", []);
    const heartbeat = setInterval(() => {
      if (!res.write(": keepalive\n\n")) res.end();
    }, 15_000);
    // Renew owner authorization and bearer tokens periodically.
    const renew = setTimeout(() => res.end(), 55_000);
    const cleanup = () => { unsubscribe(); clearInterval(heartbeat); clearTimeout(renew); };
    req.once("close", cleanup);
    res.once("close", cleanup);
  }
}
export const kalshiLiveEvents = new KalshiLiveEvents();
