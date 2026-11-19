import assert from "node:assert/strict";
import { test } from "node:test";
import { KalshiReadPacer } from "./kalshi-read-scheduler";
import { KalshiHttpClient } from "./kalshi-http";
import { KalshiGameStatusSource, parseLiveDataBatch } from "./kalshi-game-status-source";
import { GameStatusMonitor, type GameStatus } from "./kalshi-game-status";
import { MarketHistory, HISTORY_AUDIT_VERSION, type HistoryJob } from "./kalshi-market-history";
import { decodeLifecycle, KalshiLifecycle } from "./kalshi-lifecycle";
import { KalshiMetadataWorker } from "./kalshi-metadata-worker";

const now = new Date("2026-10-30T17:00:00Z");
const game = (ticker: string, milestoneId = ticker): GameStatus => ({
  ticker, milestoneId, eventTicker: "EVENT", state: "live", source: "live", marketStatus: "active",
  marketTerminal: false, startsAt: new Date(now.getTime() - 3600_000),
  delayed: false, checkedAt: now, nextCheckAt: now, error: null,
});

test("quota discovery uses tokens, reserves half the account budget, and slows after 429", () => {
  const scheduler = new KalshiReadPacer();
  assert.equal(scheduler.stats.budgetTokensPerSecond, 40);
  scheduler.configure({ read: { refill_rate: 200, bucket_capacity: 600 } },
    { default_cost: 10, endpoint_costs: [] });
  assert.equal(scheduler.stats.budgetTokensPerSecond, 100);
  assert.equal(scheduler.stats.accountTokensPerSecond, 200);
  scheduler.limited();
  assert.equal(scheduler.stats.budgetTokensPerSecond, 50);
  assert.throws(() => scheduler.configure({ read: { refill_rate: -1 } }, {}), /invalid/);
  assert.equal(scheduler.stats.budgetTokensPerSecond, 50);
  scheduler.stop();
});

test("queued recovery and live requests run ahead of backfill, without starving history", async () => {
  const scheduler = new KalshiReadPacer();
  scheduler.configure({ read: { refill_rate: 2000, bucket_capacity: 6000 } },
    { default_cost: 10, endpoint_costs: [] });
  const order: string[] = [];
  await Promise.all([
    ...Array.from({ length: 8 }, (_, i) => scheduler.wait("/historical/trades", "history").then(() => order.push(`history${i}`))),
    scheduler.wait("/markets/trades", "recovery").then(() => order.push("recovery")),
    scheduler.wait("/live_data/batch", "live").then(() => order.push("live")),
  ]);
  assert.deepEqual(order.slice(0, 2), ["recovery", "live"]);
  assert.equal(order.length, 10);
  assert.equal(scheduler.stats.queued, 0);
  scheduler.stop();
});

test("route-specific costs pace the following request rather than allowing an idle burst", async () => {
  const scheduler = new KalshiReadPacer();
  scheduler.configure({ read: { refill_rate: 2000, bucket_capacity: 6000 } },
    { default_cost: 10, endpoint_costs: [{ method: "GET", path: "/markets/:ticker", cost: 50 }] });
  await scheduler.wait("/trade-api/v2/markets/TEST", "live");
  const began = Date.now();
  await scheduler.wait("/trade-api/v2/live_data/batch", "live");
  assert.ok(Date.now() - began >= 85);
  scheduler.stop();
});

test("metadata cache coalesces workers, supports invalidation and never caches trade pages or failures", async () => {
  let calls = 0, failing = false, clock = 0;
  const client = new KalshiHttpClient(async () => {
    calls++;
    if (failing) return new Response(null, { status: 503 });
    return Response.json({ market: { ticker: "X" } });
  }, () => clock);
  const market = "https://example.test/trade-api/v2/markets/X";
  await Promise.all([client.cachedJson(market, "live"), client.cachedJson(market, "metadata")]);
  assert.equal(calls, 1);
  client.invalidate("/trade-api/v2/markets/X");
  await client.cachedJson(market);
  assert.equal(calls, 2);
  await client.cachedJson("https://example.test/trade-api/v2/markets/trades");
  await client.cachedJson("https://example.test/trade-api/v2/markets/trades");
  assert.equal(calls, 4);
  client.invalidate("/trade-api/v2/markets/X");
  failing = true;
  await assert.rejects(client.cachedJson(market));
  failing = false;
  // Failed responses are not cached, but the existing transport cooldown
  // still applies. Advance an injected clock rather than bypassing protection.
  await assert.rejects(client.cachedJson(market), /pausa temporal/);
  assert.equal(calls, 5);
  clock += 2000;
  await client.cachedJson(market);
  assert.equal(calls, 6);
});

test("100 known games use two bulk reads, match boards by identity and reuse them for each resolution", async () => {
  const candidates = Array.from({ length: 100 }, (_, i) => ({
    ticker: `M-${i}`, previous: game(`M-${i}`, `G-${i}`),
  }));
  const calls: string[] = [];
  const source = new KalshiGameStatusSource(async <T>(path: string) => {
    calls.push(path);
    if (path.startsWith("/markets?")) return { markets: candidates.map(c => ({
      ticker: c.ticker, event_ticker: "EVENT", status: "active",
    })) } as T;
    assert.ok(path.startsWith("/live_data/batch?"));
    assert.equal(new URLSearchParams(path.split("?")[1]).getAll("milestone_ids").length, 100);
    return { live_datas: candidates.map(c => ({ milestone_id: c.previous.milestoneId,
      details: { status: c.ticker === "M-5" ? "final" : "in_play" } })).reverse() } as T;
  });
  await source.prepare(candidates, now);
  const statuses = await Promise.all(candidates.map(c => source.resolve(c.ticker, c.previous, now)));
  assert.equal(calls.length, 2);
  assert.equal(statuses[5].state, "finished");
  assert.equal(statuses.filter(status => status.state === "live").length, 99);
});

test("batch omissions and ambiguous milestones never attach an unrelated scoreboard", async () => {
  const calls: string[] = [];
  const source = new KalshiGameStatusSource(async <T>(path: string) => {
    calls.push(path);
    if (path.startsWith("/markets?")) return { markets: [
      { ticker: "A", event_ticker: "EA", status: "active" },
      { ticker: "B", event_ticker: "EB", status: "active" },
    ] } as T;
    if (path.startsWith("/milestones?")) return { milestones: [
      { id: "wrong-1", start_date: now.toISOString() }, { id: "wrong-2", start_date: now.toISOString() },
    ] } as T;
    return { live_datas: [{ milestone_id: "unrelated", details: { status: "final" } }] } as T;
  });
  const candidates = [{ ticker: "A", previous: game("A") }, { ticker: "B" }];
  await source.prepare(candidates, now);
  const a = await source.resolve("A", candidates[0].previous, now);
  const b = await source.resolve("B", undefined, now);
  assert.equal(a.state, "unknown");
  assert.equal(a.delayed, true);
  assert.match(a.error!, /omitted/);
  assert.equal(b.milestoneId, null);
  assert.equal(b.state, "unknown");
  assert.equal(calls.length, 3);
});

test("the actual nullable empty batch is valid, while missing, malformed or duplicate boards remain errors", () => {
  assert.deepEqual(parseLiveDataBatch({ live_datas: null }), []);
  assert.deepEqual(parseLiveDataBatch({ live_datas: [] }), []);
  const board = { milestone_id: "A", details: { status: "live" } };
  assert.deepEqual(parseLiveDataBatch({ live_datas: [board] }), [board]);
  for (const response of [null, {}, { live_datas: undefined }, { live_datas: {} },
    { live_datas: [null] }, { live_datas: [{ milestone_id: "" }] },
    { live_datas: [{ milestone_id: "A", details: null }] }, { live_datas: [board, board] }]) {
    assert.throws(() => parseLiveDataBatch(response), /invalid live-data batch/);
  }
});

test("empty batch data preserves future schedules and unresolved games without a request flood or invented finish", async () => {
  const candidates = [
    { ticker: "UPCOMING", previous: { ...game("UPCOMING"), startsAt: new Date(now.getTime() + 3600_000), state: "scheduled" as const } },
    { ticker: "STARTED", previous: game("STARTED") },
    { ticker: "RESOLVED", previous: game("RESOLVED") },
  ];
  const calls: string[] = [], warnings: string[] = [], saved: GameStatus[] = [];
  const source = new KalshiGameStatusSource(async <T>(path: string) => {
    calls.push(path);
    if (path.startsWith("/markets?")) return { markets: candidates.map(c => ({
      ticker: c.ticker, event_ticker: "EVENT", status: c.ticker === "RESOLVED" ? "settled" : "active",
    })) } as T;
    assert.ok(path.startsWith("/live_data/batch?"));
    return { live_datas: null } as T;
  });
  const monitor = new GameStatusMonitor({
    next: async () => undefined, batch: async () => candidates, save: async value => { saved.push(value); },
  }, (ticker, previous, at) => source.resolve(ticker, previous, at), () => now,
  message => warnings.push(message), (batch, at) => source.prepare(batch, at));
  await monitor.tick();
  assert.equal(calls.length, 2, "No per-market fallback requests for an empty batch");
  assert.deepEqual(warnings, []);
  assert.equal(saved[0].state, "scheduled");
  assert.equal(saved[0].source, "schedule");
  assert.equal(saved[0].delayed, false);
  assert.equal(saved[0].error, null);
  assert.equal(saved[1].state, "unknown");
  assert.equal(saved[1].delayed, true);
  assert.match(saved[1].error!, /omitted/);
  assert.equal(saved[1].marketTerminal, false);
  assert.equal(saved[2].state, "finished");
  assert.equal(saved[2].source, "market", "A settled market is not presented as a verified game score");
});

test("one failed batch logs once while keeping every game's error and retry state", async () => {
  const candidates = Array.from({ length: 100 }, (_, i) => ({ ticker: `M${i}`, previous: game(`M${i}`) }));
  const saved: GameStatus[] = [], warnings: string[] = [];
  const monitor = new GameStatusMonitor({
    next: async () => undefined, batch: async () => candidates, save: async value => { saved.push(value); },
  }, async () => { throw new Error("Resolver must not run after failed preparation"); }, () => now,
  message => warnings.push(message), async () => { throw new Error("Upstream temporarily unavailable"); });
  await monitor.tick();
  assert.equal(saved.length, 100);
  assert.deepEqual(warnings, ["Upstream temporarily unavailable"]);
  assert.ok(saved.every(value => value.state === "live" && value.delayed &&
    value.error === warnings[0] && value.nextCheckAt.getTime() === now.getTime() + 60_000));
});

test("batch status errors back off without overwriting known states; finished games stay archived", async () => {
  const saved: GameStatus[] = [];
  let resolved = 0;
  const monitor = new GameStatusMonitor({
    next: async () => undefined,
    batch: async () => [{ ticker: "A", previous: game("A") },
      { ticker: "B", previous: { ...game("B"), state: "finished" } }],
    save: async value => { saved.push(value); },
  }, async () => { resolved++; return game("A"); }, () => now, () => {}, async () => { throw new Error("temporary pause"); });
  await monitor.tick();
  assert.equal(resolved, 0);
  assert.equal(saved.length, 1);
  assert.equal(saved[0].state, "live");
  assert.equal(saved[0].delayed, true);
  assert.equal(saved[0].nextCheckAt.getTime() - now.getTime(), 60_000);
});

test("historical imports run concurrently across markets but never race a ticker's cursor", async () => {
  const jobs = new Map<string, HistoryJob>();
  const active = new Set<string>();
  let maxActive = 0;
  let release!: () => void;
  const barrier = new Promise<void>(resolve => { release = resolve; });
  const history = new MarketHistory({
    candidates: async () => ["A", "B", "C", "D", "E"].map(ticker => ({ ticker, job: jobs.get(ticker) })),
    job: async ticker => jobs.get(ticker), eligible: async () => true,
    commit: async job => { jobs.set(job.ticker, job); },
  }, async job => {
    assert.ok(!active.has(job.ticker));
    active.add(job.ticker);
    maxActive = Math.max(maxActive, active.size);
    await barrier;
    active.delete(job.ticker);
    return { rows: [], scanned: 1000, cursor: "next-page" };
  }, () => now, () => {}, 4);
  const first = history.tick();
  await new Promise(resolve => setTimeout(resolve, 0));
  await history.tick();
  assert.equal(history.activeJobs, 4);
  release();
  await first;
  assert.equal(maxActive, 4);
  assert.equal(jobs.size, 4);
  assert.ok([...jobs.values()].every(job => job.cursor === "next-page" && job.auditVersion === HISTORY_AUDIT_VERSION));
});

test("lifecycle hints merge settlement and metadata work, retain changes during a write, and retry failures", async () => {
  assert.equal(decodeLifecycle("market_lifecycle_v2", { market_ticker: "A", event_type: "settled" })?.type, "settled");
  assert.equal(decodeLifecycle("event_lifecycle", { series_ticker: "SPORT" })?.series, "SPORT");
  assert.equal(decodeLifecycle("market_lifecycle_v2", { market_ticker: "A", event_type: "unknown" }), null);
  let attempts = 0;
  const worker = new KalshiLifecycle(async work => {
    attempts++;
    assert.deepEqual(work, [{ ticker: "A", metadata: true, settlement: true }]);
    if (attempts === 1) throw new Error("DB unavailable");
    if (attempts === 2) worker.enqueue({ ticker: "A", type: "metadata_updated" });
  });
  worker.enqueue({ ticker: "A", type: "settled" });
  worker.enqueue({ ticker: "A", type: "metadata_updated" });
  await assert.rejects(worker.tick());
  assert.equal(worker.queued, 1);
  await worker.tick();
  assert.equal(worker.queued, 1);
  await worker.tick();
  assert.equal(worker.queued, 0);
});

test("metadata failures cannot become fabricated descriptions and persist a retry", async () => {
  let failed = 0, completed = 0;
  const worker = new KalshiMetadataWorker({
    candidates: async () => [{ ticker: "A", attempts: 0 }],
    complete: async () => { completed++; },
    failed: async (_, error, retry) => {
      failed++;
      assert.match(error, /context/);
      assert.equal(retry.getTime() - now.getTime(), 15_000);
    },
  }, async () => ({ eventTitle: "Game", marketTitle: "A" }), () => now);
  await worker.tick();
  assert.equal(completed, 0);
  assert.equal(failed, 1);
});
