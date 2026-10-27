import assert from "node:assert/strict";
import { test } from "node:test";
import express from "express";
import { emptyFlow, flowConcentrations, summarizeFlow } from "./market-flow";
import { KalshiLiveEvents } from "./kalshi-live-events";
import { marketCardSvg } from "./telegram-market-card";
import { tradeRange } from "./kalshi-trade-bands";

const now = new Date("2026-10-27T15:00:00Z");
const trade = (id: string, ageMinutes: number, notional: number, side = "yes") => ({
  tradeId: id, outcomeSide: side, bookSide: "unknown", notional,
  createdTime: new Date(now.getTime() - ageMinutes * 60_000),
});

test("flow windows use execution time, exact dollars, known direction and deduplicated IDs", () => {
  const rows = [trade("a", 5, 10001), trade("a", 5, 10001),
    trade("b", 4, 10000, "no"), trade("c", 6, 5000),
    trade("d", 1, 1200, "unknown"), trade("e", -1, 50000),
    trade("f", 1, NaN), { ...trade("g", 1, 1000), createdTime: new Date("invalid") }];
  assert.deepEqual(summarizeFlow(rows, now, 5), {
    minutes: 5, yesUsd: 10001, noUsd: 10000, unknownUsd: 1200,
    yesCount: 1, noCount: 1, unknownCount: 1, balanceUsd: 1,
    largeYesCount: 1, largeNoCount: 0, largeYesUsd: 10001, largeNoUsd: 0,
  });
  assert.equal(summarizeFlow(rows, now, 15).yesUsd, 15001);
});

test("concentrations require three >$10k individual trades in the same direction and window", () => {
  const rows = [trade("1", 1, 15000), trade("2", 2, 20000), trade("3", 3, 30000),
    trade("4", 10, 14000, "no"), trade("5", 12, 17000, "no"), trade("6", 14, 19000, "no")];
  const windows = [5, 15, 60].map(minutes => summarizeFlow(rows, now, minutes));
  assert.deepEqual(flowConcentrations(windows), [
    { direction: "yes", minutes: 5, count: 3, usd: 65000 },
    { direction: "no", minutes: 15, count: 3, usd: 50000 },
  ]);
  assert.deepEqual(flowConcentrations([summarizeFlow([
    trade("a", 1, 10000), trade("b", 1, 10000), trade("c", 1, 10000),
    trade("d", 1, 9000), trade("e", 1, 9000), trade("f", 1, 9000),
  ], now, 5)]), []);
  assert.deepEqual(flowConcentrations([emptyFlow(5)]), []);
});

test("value-band inputs never produce large-trade signals from smaller accumulated trades", () => {
  const rows = Array.from({ length: 20 }, (_, i) => trade(String(i), 1, i % 2 ? 5000 : 7000));
  for (const band of ["small", "medium"] as const) {
    const range = tradeRange(band, 10000);
    const filtered = rows.filter(t => t.notional >= range.minimum && t.notional <= (range.maximum ?? Infinity));
    assert.deepEqual(flowConcentrations([summarizeFlow(filtered, now, 5)]), []);
  }
});

test("SSE publisher coalesces ticker IDs once and stops delivering after unsubscribe", async () => {
  const events = new KalshiLiveEvents(5);
  const messages: string[][] = [];
  const fresh: string[][] = [];
  events.publish(["before-subscribe"]);
  const unsubscribe = events.subscribe((tickers, ids) => { messages.push(tickers); fresh.push(ids); });
  events.publish(["A", "A"], ["live-1"]);
  events.publish(["B"], ["live-1"]);
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.deepEqual(messages, [["A", "B"]]);
  assert.deepEqual(fresh, [["live-1"]]);
  unsubscribe();
  events.publish(["C"]);
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(messages.length, 1);
});

test("SSE wire starts with ready, emits invalidations after publish, and closes cleanly", async () => {
  const events = new KalshiLiveEvents(5);
  const app = express();
  app.get("/live", (req, res) => events.serve(req, res));
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>(resolve => server.once("listening", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const abort = new AbortController();
  try {
    const response = await fetch(`http://127.0.0.1:${address.port}/live`, { signal: abort.signal });
    assert.match(response.headers.get("content-type")!, /text\/event-stream/);
    const reader = response.body!.getReader();
    assert.match(new TextDecoder().decode((await reader.read()).value), /event: ready/);
    events.publish(["SPORT-GAME"]);
    assert.match(new TextDecoder().decode((await reader.read()).value), /"tickers":\["SPORT-GAME"\]/);
    await reader.cancel();
  } finally {
    abort.abort();
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});

test("Telegram single graph includes range-specific windows and visual-only concentrations", () => {
  const rows = [1, 2, 3].map((i) => ({
    ...trade(`t${i}`, i, 15000), ticker: "SPORT-GAME", eventTitle: "Madrid vs Barcelona",
    marketTitle: "Madrid gana", title: "Madrid gana", sport: "Soccer", price: .6, count: 25000,
    marketUrl: "https://kalshi.com", blockTrade: false,
  }));
  const active = marketCardSvg(rows, 10000, undefined, "large", now);
  assert.match(active, /Flujo reciente/);
  assert.match(active, /5 min/);
  assert.match(active, /60 min/);
  assert.match(active, /Concentración: 3 operaciones individuales/);
  assert.match(active.replace(/<[^>]+>/g, " "), /mismo operador ni ventas\s+confirmadas/);
  const history = marketCardSvg(rows, 10000, undefined, "large", now, {
    label: "Finalizado", color: "#ff0000", stopped: true,
  });
  assert.doesNotMatch(history, /Flujo reciente|Concentración:/);
});
