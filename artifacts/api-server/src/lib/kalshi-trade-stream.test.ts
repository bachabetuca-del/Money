import assert from "node:assert/strict";
import { test } from "node:test";
import { constants, generateKeyPairSync, verify } from "node:crypto";
import { WebSocketServer, type WebSocket } from "ws";
import { KalshiAuth, KalshiReadPacer } from "./kalshi-auth";
import { decodeStreamTrade, KalshiTradeStream } from "./kalshi-trade-stream";
import { KalshiLiveCoverage } from "./kalshi-live-coverage";
import { publicTradeExecution } from "./kalshi-trade-execution";
import { liveNotificationTrades } from "./telegram-trade-notifications";

const keys = generateKeyPairSync("ed25519");
const pem = keys.privateKey.export({ format: "pem", type: "pkcs8" }).toString();
const auth = new KalshiAuth("test-key-id", pem);
const rawTrade = {
  trade_id: "trade-1", market_ticker: "SPORTS-GAME-YES", ts: 1, ts_ms: 1_800_000_000_123,
  count_fp: "25000.00", yes_price_dollars: "0.60", no_price_dollars: "0.40",
  taker_outcome_side: "yes", taker_book_side: "bid", is_block_trade: false,
};
const waitFor = async (condition: () => boolean, timeout = 4000) => {
  const started = Date.now();
  while (!condition()) {
    if (Date.now() - started > timeout) throw new Error("Timed out waiting for stream");
    await new Promise(resolve => setTimeout(resolve, 10));
  }
};

for (const kind of ["ed25519", "rsa"] as const) {
  test(`${kind} signs GET path without query parameters`, () => {
    const pair = kind === "rsa" ? generateKeyPairSync("rsa", { modulusLength: 2048 }) : keys;
    const privatePem = pair.privateKey.export({ format: "pem", type: "pkcs8" }).toString();
    const signer = new KalshiAuth("public-test-id", privatePem.replace(/\n/g, "\\n"));
    const headers = signer.headers("/trade-api/v2/markets/trades?limit=1000", 123456);
    assert.equal(headers["KALSHI-ACCESS-TIMESTAMP"], "123456");
    assert.equal(headers["KALSHI-ACCESS-KEY"], "public-test-id");
    const message = Buffer.from("123456GET/trade-api/v2/markets/trades");
    assert.ok(verify(kind === "rsa" ? "sha256" : null, message,
      kind === "rsa" ? {
        key: pair.publicKey, padding: constants.RSA_PKCS1_PSS_PADDING,
        saltLength: constants.RSA_PSS_SALTLEN_DIGEST,
      } : pair.publicKey, Buffer.from(headers["KALSHI-ACCESS-SIGNATURE"], "base64")));
  });
}

test("missing and invalid credentials fail without exposing their input", () => {
  assert.throws(() => new KalshiAuth("", ""), /Faltan las credenciales/);
  assert.throws(() => new KalshiAuth("id", "NEVER_LOG_THIS"), error =>
    error instanceof Error && !error.message.includes("NEVER_LOG_THIS") && error.message.includes("PEM"));
  const ec = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  assert.throws(() => new KalshiAuth("id", ec.privateKey.export({ type: "pkcs8", format: "pem" }).toString()), /RSA o Ed25519/);
});

test("PEM formatting from secret forms preserves valid signatures without accepting damaged keys", () => {
  const flattened = pem.trim().replace(/\n/g, " ");
  const quotedWindowsEscapes = `"${pem.replace(/\n/g, "\\r\\n")}"`;
  for (const input of [flattened, quotedWindowsEscapes, `  ${pem}  `]) {
    const headers = new KalshiAuth("test-id", input).headers("/trade-api/ws/v2", 123);
    assert.ok(verify(null, Buffer.from("123GET/trade-api/ws/v2"), keys.publicKey,
      Buffer.from(headers["KALSHI-ACCESS-SIGNATURE"], "base64")));
  }
  for (const input of [pem.replace("-----END PRIVATE KEY-----", "-----END RSA PRIVATE KEY-----"),
    pem.replace("-----END PRIVATE KEY-----", ""), `${pem}unexpected trailing text`]) {
    assert.throws(() => new KalshiAuth("test-id", input), /PEM válido/);
  }
});

test("stream mapping uses milliseconds, preserves public direction and notional", () => {
  const trade = decodeStreamTrade(rawTrade)!;
  assert.equal(trade.created_time, new Date(rawTrade.ts_ms).toISOString());
  assert.equal(trade.ticker, rawTrade.market_ticker);
  assert.equal(publicTradeExecution(trade)?.notional, 15000);
  const no = decodeStreamTrade({ ...rawTrade, taker_outcome_side: "no", taker_book_side: "ask" })!;
  assert.equal(publicTradeExecution(no)?.notional, 10000);
  assert.equal(publicTradeExecution(no)?.outcomeSide, "no");
  assert.equal(decodeStreamTrade({ ...rawTrade, ts_ms: undefined })?.created_time, "1970-01-01T00:00:01.000Z");
  for (const bad of [{}, { ...rawTrade, trade_id: "" }, { ...rawTrade, ts_ms: Infinity },
    { ...rawTrade, ts_ms: NaN }, { ...rawTrade, market_ticker: null }]) {
    assert.equal(decodeStreamTrade(bad), null);
  }
});

test("healthy stream suppresses REST; gaps freeze checkpoints until successful recovery", () => {
  const coverage = new KalshiLiveCoverage(100_000);
  assert.equal(coverage.needsRecovery(true), true);
  const seed = coverage.snapshot();
  coverage.recoveredThrough(seed, 100_000);
  assert.equal(coverage.needsRecovery(true), false);
  coverage.streamPersisted(200_000, true);
  assert.equal(coverage.boundary, 140_000);
  coverage.requestRecovery();
  coverage.streamPersisted(400_000, true);
  assert.equal(coverage.boundary, 140_000); // Don't skip the gap!
  const catchup = coverage.snapshot();
  coverage.requestRecovery(); // A second gap while catch-up is in flight.
  coverage.recoveredThrough(catchup, 300_000);
  assert.equal(coverage.needsRecovery(true), true);
  coverage.recoveredThrough(coverage.snapshot(), 400_000);
  assert.equal(coverage.needsRecovery(true), false);
  assert.equal(coverage.needsRecovery(false), true);
  coverage.streamPersisted(900_000, false);
  assert.equal(coverage.boundary, 340_000);
});

test("startup snapshots and exact $10k never become notifications after REST overlap", () => {
  const coverage = new KalshiLiveCoverage(100_000);
  const rows = [
    { createdTime: new Date(99_999).toISOString(), notional: 20_000 },
    { createdTime: new Date(100_001).toISOString(), notional: 10_000 },
    { createdTime: new Date(100_001).toISOString(), notional: 9_999 },
    { createdTime: new Date(100_001).toISOString(), notional: 10_001 },
  ];
  assert.deepEqual(liveNotificationTrades(rows, coverage.notificationBoundary(null)), []);
  assert.deepEqual(liveNotificationTrades(rows, coverage.notificationBoundary(40_000)), [rows[3]]);
  coverage.establishStartupBoundary();
  assert.equal(coverage.boundary, 100_000);
});

test("all REST callers share conservative pacing without an idle-time burst", async () => {
  const pacer = new KalshiReadPacer();
  const times: number[] = [];
  await Promise.all(Array.from({ length: 3 }, async () => {
    await pacer.wait();
    times.push(Date.now());
  }));
  assert.ok(times[2] - times[0] >= 450);
});

test("authenticated subscription, deduplication, gap recovery, batch retry and reconnect", async () => {
  const server = new WebSocketServer({ port: 0 });
  await new Promise<void>(resolve => server.once("listening", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  let connections = 0, recoveries = 0, attempts = 0, saved = 0;
  let peer: WebSocket | undefined;
  server.on("connection", (socket, req) => {
    connections++;
    peer = socket;
    const time = req.headers["kalshi-access-timestamp"];
    assert.ok(verify(null, Buffer.from(`${time}GET/trade-api/ws/v2`), keys.publicKey,
      Buffer.from(String(req.headers["kalshi-access-signature"]), "base64")));
    socket.on("message", data => {
      assert.deepEqual(JSON.parse(data.toString()), { id: 1, cmd: "subscribe", params: { channels: ["trade"] } });
      socket.send(JSON.stringify({ type: "subscribed", msg: { channel: "trade", sid: 1 } }));
      if (connections === 1) {
        socket.send(JSON.stringify({ type: "trade", seq: 1, msg: rawTrade }));
        socket.send(JSON.stringify({ type: "trade", seq: 2, msg: rawTrade }));
        socket.send(JSON.stringify({ type: "trade", seq: 4, msg: { ...rawTrade, trade_id: "ignore" } }));
      }
    });
  });
  const stream = new KalshiTradeStream({
    auth, url: `ws://127.0.0.1:${address.port}`, retryMs: 20,
    accept: trade => trade.trade_id !== "ignore",
    batch: async trades => {
      attempts++;
      if (attempts === 1) throw new Error("Temporary storage failure");
      assert.equal(trades.length, 1);
      saved += trades.length;
    },
    recovery: () => { recoveries++; }, state: () => {},
  });
  try {
    stream.start();
    stream.start(); // Idempotent start: only one socket.
    await waitFor(() => stream.live && recoveries >= 2);
    assert.equal(connections, 1);
    await waitFor(() => saved === 1);
    assert.equal(attempts, 2); // Queue retained until successful persistence.
    peer!.terminate();
    await waitFor(() => connections === 2 && stream.live);
    assert.ok(recoveries >= 4);
  } finally {
    stream.stop();
    for (const client of server.clients) client.terminate();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});

test("subscription errors trigger reconnection rather than reporting a live feed", async () => {
  const server = new WebSocketServer({ port: 0 });
  await new Promise<void>(resolve => server.once("listening", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  let connections = 0, failures = 0;
  server.on("connection", socket => {
    connections++;
    socket.on("message", () => socket.send(JSON.stringify({ type: "error", msg: { code: 9 } })));
  });
  const stream = new KalshiTradeStream({
    auth, url: `ws://127.0.0.1:${address.port}`, retryMs: 20,
    accept: () => true, batch: async () => {}, recovery: () => {},
    state: (_, message) => { if (message.includes("código 9")) failures++; },
  });
  try {
    stream.start();
    await waitFor(() => connections >= 2 && failures >= 2);
    assert.equal(stream.live, false);
  } finally {
    stream.stop();
    for (const client of server.clients) client.terminate();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});

test("trade and lifecycle subscriptions share one socket with independent per-SID sequences", async () => {
  const server = new WebSocketServer({ port: 0 });
  await new Promise<void>(resolve => server.once("listening", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  let recovered = 0, saved = 0, connections = 0;
  const events: string[] = [];
  let peer: WebSocket | undefined;
  server.on("connection", socket => {
    connections++;
    peer = socket;
    socket.on("message", raw => {
      assert.deepEqual(JSON.parse(raw.toString()).params.channels,
        ["trade", "market_lifecycle_v2", "multivariate_market_lifecycle"]);
      for (const [index, channel] of ["trade", "market_lifecycle_v2", "multivariate_market_lifecycle"].entries()) {
        socket.send(JSON.stringify({ type: "subscribed", msg: { channel, sid: index + 1 } }));
      }
      socket.send(JSON.stringify({ type: "trade", sid: 1, seq: 1, msg: rawTrade }));
      socket.send(JSON.stringify({ type: "market_lifecycle_v2", sid: 2, seq: 1,
        msg: { market_ticker: rawTrade.market_ticker, event_type: "settled" } }));
      socket.send(JSON.stringify({ type: "event_lifecycle", sid: 2, seq: 2,
        msg: { series_ticker: "SPORTS" } }));
      socket.send(JSON.stringify({ type: "trade", sid: 1, seq: 2, msg: { ...rawTrade, trade_id: "trade-2" } }));
    });
  });
  const stream = new KalshiTradeStream({
    auth, url: `ws://127.0.0.1:${address.port}`, retryMs: 20,
    accept: () => true, batch: async rows => { saved += rows.length; },
    lifecycle: event => { events.push(event.type); },
    recovery: () => { recovered++; }, state: () => {},
  });
  try {
    stream.start();
    await waitFor(() => saved === 2 && events.length === 2);
    assert.equal(connections, 1);
    assert.equal(recovered, 1);
    assert.deepEqual(events, ["settled", "event_created"]);
    peer!.send(JSON.stringify({ type: "market_lifecycle_v2", sid: 2, seq: 4,
      msg: { market_ticker: rawTrade.market_ticker, event_type: "metadata_updated" } }));
    await waitFor(() => recovered === 2);
  } finally {
    stream.stop();
    for (const client of server.clients) client.terminate();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});

test("a silent half-open connection is terminated and resubscribed", async () => {
  const server = new WebSocketServer({ port: 0, autoPong: false });
  await new Promise<void>(resolve => server.once("listening", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  let connections = 0;
  server.on("connection", socket => {
    connections++;
    socket.on("message", () => socket.send(JSON.stringify({ type: "subscribed", msg: { channel: "trade" } })));
  });
  const stream = new KalshiTradeStream({
    auth, url: `ws://127.0.0.1:${address.port}`, retryMs: 20, heartbeatMs: 100,
    accept: () => true, batch: async () => {}, recovery: () => {}, state: () => {},
  });
  try {
    stream.start();
    await waitFor(() => connections >= 2);
  } finally {
    stream.stop();
    for (const client of server.clients) client.terminate();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});

test("reconnections must acknowledge lifecycle channels again, not reuse an earlier subscription", async () => {
  const server = new WebSocketServer({ port: 0 });
  await new Promise<void>(resolve => server.once("listening", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  let connections = 0;
  server.on("connection", socket => {
    const connection = ++connections;
    socket.on("message", () => {
      const channels = connection === 1 ? ["trade", "market_lifecycle_v2", "multivariate_market_lifecycle"] : ["trade"];
      for (const channel of channels) socket.send(JSON.stringify({ type: "subscribed", msg: { channel } }));
      if (connection === 1) setTimeout(() => socket.terminate(), 30);
    });
  });
  const stream = new KalshiTradeStream({
    auth, url: `ws://127.0.0.1:${address.port}`, retryMs: 20, heartbeatMs: 100, subscriptionTimeoutMs: 70,
    accept: () => true, batch: async () => {}, lifecycle: () => {}, recovery: () => {}, state: () => {},
  });
  try {
    stream.start();
    await waitFor(() => connections >= 3);
  } finally {
    stream.stop();
    for (const client of server.clients) client.terminate();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});

test("queue overflow requests REST recovery and disconnects without unbounded buffering", async () => {
  const server = new WebSocketServer({ port: 0 });
  await new Promise<void>(resolve => server.once("listening", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  let recoveries = 0, disconnected = false, checkpoints = 0;
  server.on("connection", socket => {
    socket.on("message", () => {
      socket.send(JSON.stringify({ type: "subscribed", msg: { channel: "trade" } }));
      for (let i = 0; i < 10_001; i++) {
        socket.send(JSON.stringify({ type: "trade", seq: i, msg: { ...rawTrade, trade_id: `id-${i}` } }));
      }
    });
  });
  const stream = new KalshiTradeStream({
    auth, url: `ws://127.0.0.1:${address.port}`, retryMs: 60_000,
    accept: () => true, batch: async () => { throw new Error("storage temporarily down"); },
    recovery: () => { recoveries++; },
    checkpoint: () => { checkpoints++; },
    state: (_, message) => { if (message.includes("desconectado")) disconnected = true; },
  });
  try {
    stream.start();
    await waitFor(() => disconnected);
    assert.ok(recoveries >= 3);
    assert.equal(checkpoints, 0);
  } finally {
    stream.stop();
    for (const client of server.clients) client.terminate();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});
