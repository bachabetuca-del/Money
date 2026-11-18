/** Public orderbook data only. A YES ask is 1 minus a NO bid (and vice versa). */
export type Side = "yes" | "no";
export type Level = { price: number; contracts: number };
export type BookQuote = {
  ticker: string; session: string; sid: number; seq: number; clock: number | null;
  capturedAt: string; receivedAt: string; exchangeAt: string | null;
  yesBids: Level[]; noBids: Level[]; truncated: boolean;
};
type Book = {
  yes: Map<number, number>; no: Map<number, number>; receivedAt: number;
  exchangeAt: number | null; clock: number | null; valid: boolean;
};
type Message = {
  type?: string; sid?: number; seq?: number; sending_ts_ms?: number;
  msg?: Record<string, unknown>;
};
const fixed = (x: unknown, digits: number): number | null => {
  if (typeof x !== "string" || !new RegExp(`^-?\\d+(?:\\.\\d{1,${digits}})?$`).test(x)) return null;
  const value = Math.round(Number(x) * 10 ** digits);
  return Number.isSafeInteger(value) ? value : null;
};
function levels(raw: unknown): Map<number, number> {
  if (!Array.isArray(raw) || raw.length > 10000) throw new Error("invalid_book");
  const out = new Map<number, number>();
  for (const pair of raw) {
    if (!Array.isArray(pair) || pair.length !== 2) throw new Error("invalid_book");
    const p = fixed(pair[0], 4), n = fixed(pair[1], 2);
    if (p === null || n === null || p <= 0 || p >= 10000 || n < 0 || out.has(p)) throw new Error("invalid_book");
    if (n) out.set(p, n);
  }
  return out;
}
const top = (map: Map<number, number>) => [...map].sort((a, b) => b[0] - a[0]).slice(0, 20)
  .map(([p, n]) => ({ price: p / 10000, contracts: n / 100 }));

export class PaperBook {
  private books = new Map<string, Book>();
  private sid: number | null = null;
  private sequence: number | null = null;
  private session = "";
  private heartbeatAt = 0;
  connect(session: string, now: number) {
    this.books.clear(); this.session = session; this.sid = null; this.sequence = null; this.heartbeatAt = now;
  }
  pong(now: number) { this.heartbeatAt = now; }
  invalidate() { for (const book of this.books.values()) book.valid = false; }
  remove(ticker: string) { this.books.delete(ticker); }
  /** False means reconnect/resubscribe. Never repair a gap with a later delta. */
  apply(message: Message, now: number): boolean {
    const isBook = ["orderbook_snapshot", "orderbook_delta"].includes(message.type ?? "");
    // Subscription acknowledgements can themselves consume a sequence number.
    if (!isBook && !(["ok", "subscribed"].includes(message.type ?? "") &&
        Number.isSafeInteger(message.sid) && Number.isSafeInteger(message.seq))) return true;
    if (!Number.isSafeInteger(message.seq) || !Number.isSafeInteger(message.sid) || !message.msg) {
      this.invalidate(); return false;
    }
    if (this.sid !== null && (message.sid !== this.sid || message.seq !== this.sequence! + 1)) {
      this.invalidate(); return false;
    }
    this.sid = message.sid!; this.sequence = message.seq!;
    if (!isBook) return true;
    const msg = message.msg, ticker = msg.market_ticker;
    if (typeof ticker !== "string") { this.invalidate(); return false; }
    const exchange = typeof message.sending_ts_ms === "number" ? message.sending_ts_ms :
      typeof msg.ts_ms === "number" ? msg.ts_ms : null;
    if (exchange !== null && (!Number.isSafeInteger(exchange) || exchange > now + 5000 || exchange < now - 15000)) {
      this.invalidate(); return false;
    }
    try {
      if (message.type === "orderbook_snapshot") {
        if (!this.books.has(ticker) && this.books.size >= 20) throw new Error("book_cap");
        this.books.set(ticker, {
          yes: levels(msg.yes_dollars_fp), no: levels(msg.no_dollars_fp),
          valid: true, receivedAt: now, exchangeAt: exchange,
          clock: typeof msg.clock === "number" ? msg.clock : null,
        });
      } else {
        const book = this.books.get(ticker), side = msg.side;
        const p = fixed(msg.price_dollars, 4), delta = fixed(msg.delta_fp, 2);
        if (!book?.valid || (side !== "yes" && side !== "no") || p === null || p <= 0 || p >= 10000 || delta === null)
          throw new Error("delta_without_snapshot");
        const next = (book[side].get(p) ?? 0) + delta;
        if (next < 0 || !Number.isSafeInteger(next)) throw new Error("negative_book");
        if (next) book[side].set(p, next); else book[side].delete(p);
        if (book[side].size > 10000) throw new Error("book_cap");
        book.receivedAt = now; book.exchangeAt = exchange;
        book.clock = typeof msg.clock === "number" ? msg.clock : null;
      }
      this.heartbeatAt = now;
      return true;
    } catch { this.invalidate(); return false; }
  }
  quote(ticker: string, now: number): BookQuote | null {
    const book = this.books.get(ticker);
    if (!book?.valid || this.sid === null || this.sequence === null ||
        now - book.receivedAt > 15000 || now - this.heartbeatAt > 15000 || now < book.receivedAt) return null;
    const yes = top(book.yes), no = top(book.no);
    if (yes[0] && no[0] && yes[0].price + no[0].price >= 1 - 1e-10) return null;
    return { ticker, session: this.session, sid: this.sid, seq: this.sequence, clock: book.clock,
      capturedAt: new Date(now).toISOString(), receivedAt: new Date(book.receivedAt).toISOString(),
      exchangeAt: book.exchangeAt === null ? null : new Date(book.exchangeAt).toISOString(),
      yesBids: yes, noBids: no,
      truncated: book.yes.size > 20 || book.no.size > 20 };
  }
}

export function asks(quote: BookQuote, side: Side): Level[] {
  return (side === "yes" ? quote.noBids : quote.yesBids)
    .map(l => ({ price: (10000 - Math.round(l.price * 10000)) / 10000, contracts: l.contracts }))
    .sort((a, b) => a.price - b.price);
}
