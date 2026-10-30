import WebSocket from "ws";
import { KalshiAuth } from "./kalshi-auth";
import { decodeStreamTrade, KALSHI_WS_URL } from "./kalshi-trade-stream";

/** One-shot read-only connection check; NEVER starts workers, writes data or sends Telegram. */
async function probe() {
  const auth = new KalshiAuth(process.env.KALSHI_API_KEY_ID ?? "", process.env.KALSHI_PRIVATE_KEY ?? "");
  const socket = new WebSocket(KALSHI_WS_URL, {
    headers: auth.headers("/trade-api/ws/v2"), handshakeTimeout: 15_000,
  });
  await new Promise<void>((resolve, reject) => {
    const channels = ["trade", "market_lifecycle_v2", "multivariate_market_lifecycle"];
    const subscribed = new Set<string>();
    let gotTrade = false, done = false;
    const timeout = setTimeout(() => {
      socket.terminate();
      reject(new Error("WebSocket verification timed out before all channels and live trades were confirmed"));
    }, 20_000);
    const finish = (error?: Error) => {
      if (done) return;
      done = true;
      clearTimeout(timeout);
      socket.close();
      if (error) reject(error);
      else resolve();
    };
    socket.on("open", () => socket.send(JSON.stringify({
      id: 1, cmd: "subscribe", params: { channels },
    })));
    socket.on("message", raw => {
      if (done) return;
      try {
        const frame = JSON.parse(raw.toString());
        if (frame.type === "error") return finish(new Error(`Subscription rejected, code ${Number(frame.msg?.code) || 0}`));
        if (frame.type === "subscribed") subscribed.add(String(frame.msg?.channel));
        if (frame.type === "trade" && decodeStreamTrade(frame.msg ?? {})) gotTrade = true;
        if (gotTrade && channels.every(channel => subscribed.has(channel))) {
          process.stdout.write("PASS: trade, market_lifecycle_v2 and multivariate_market_lifecycle subscriptions accepted; live trade decoded. No Telegram workers or writes.\n");
          finish();
        }
      } catch { finish(new Error("Unreadable WebSocket response")); }
    });
    socket.on("error", () => finish(new Error("Kalshi WebSocket handshake failed; credentials not logged")));
  });
}
probe().catch(error => {
  process.stderr.write(`${error instanceof Error ? error.message : "Verification failed"}\n`);
  process.exitCode = 1;
});
