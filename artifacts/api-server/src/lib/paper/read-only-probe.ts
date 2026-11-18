import { KalshiAuth } from "../kalshi-auth";
import { PaperBookStream } from "./book-stream";

// Manual, bounded compatibility check. Never starts the monitor or touches DB,
// Telegram, orders or a portfolio; credentials never enter output.
if (process.env.BOT_WORKERS_ENABLED !== "false") throw new Error("Run this probe only in the paused development environment.");
const ticker = process.argv[2];
if (!ticker || !/^[A-Z0-9._-]{1,150}$/.test(ticker)) throw new Error("Supply one public market ticker.");
const stream = new PaperBookStream(new KalshiAuth(process.env.KALSHI_API_KEY_ID ?? "", process.env.KALSHI_PRIVATE_KEY ?? ""));
stream.setEnabled(true); stream.watch(ticker, Date.now() + 16000, 1);
let valid = 0, firstSeq: number | null = null, lastSeq: number | null = null, lastSession: string | null = null;
let reconnects = 0;
const timer = setInterval(() => {
  stream.tick(Date.now());
  const quote = stream.quote(ticker, Date.now());
  if (quote) {
    valid++; firstSeq ??= quote.seq; lastSeq = quote.seq;
    if (lastSession && lastSession !== quote.session) reconnects++;
    lastSession = quote.session;
  }
}, 250);
setTimeout(() => {
  clearInterval(timer); stream.stop();
  process.stdout.write(JSON.stringify({ ticker, validQuoteReads: valid, firstSeq, lastSeq,
    reconnects, error: stream.error, onlyPublicBookSubscriptions: true }) + "\n");
  if (!valid || reconnects) process.exitCode = 1;
}, 15000);
