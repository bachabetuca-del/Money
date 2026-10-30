import assert from "node:assert/strict";
import { test } from "node:test";
import { KalshiRecovery, type RecoveryState, type RecoveryStore } from "./kalshi-recovery";
import { KalshiLiveCoverage } from "./kalshi-live-coverage";

const origin = Date.parse("2026-10-30T17:00:00Z");
function memoryStore(seed = origin - 60_000) {
  let state: RecoveryState | undefined;
  const store: RecoveryStore = {
    load: async () => state && structuredClone(state),
    seed: async () => new Date(seed),
    save: async value => { state = structuredClone(value); },
  };
  return { store, state: () => state! };
}

test("recovery crosses the old 50,000-trade ceiling with durable cursors and both partitions", async () => {
  const data = memoryStore();
  const coverage = new KalshiLiveCoverage(origin);
  let calls = 0, inserted = 0;
  const worker = new KalshiRecovery(data.store, coverage, async state => {
    calls++;
    assert.equal(state.windowEndAt!.getTime(), origin);
    if (state.phase === "archive") return { rows: [], cursor: null };
    const page = Number(state.cursor ?? 0);
    return { rows: Array.from({ length: 1000 }, (_, i) => `${page}:${i}`), cursor: page < 52 ? String(page + 1) : null };
  }, async rows => { inserted += rows.length; }, () => origin);
  for (let i = 0; i < 54; i++) await worker.tick();
  assert.equal(calls, 54);
  assert.equal(inserted, 53_000);
  assert.equal(data.state().checkpointAt.getTime(), origin);
  assert.equal(data.state().targetAt, null);
  assert.equal(coverage.needsRecovery(true), false);
});

test("a process restart resumes the saved cursor and extends catch-up to the new startup time", async () => {
  const data = memoryStore();
  const first = new KalshiRecovery(data.store, new KalshiLiveCoverage(origin),
    async () => ({ rows: ["saved-before-restart"], cursor: "page-2" }), async () => {}, () => origin);
  await first.tick();
  const secondNow = origin + 60_000;
  const calls: string[] = [];
  const coverage = new KalshiLiveCoverage(secondNow);
  const restarted = new KalshiRecovery(data.store, coverage, async state => {
    calls.push(`${state.phase}:${state.cursor}`);
    return { rows: [], cursor: null };
  }, async () => {}, () => secondNow);
  await restarted.tick();
  assert.equal(calls[0], "live:page-2");
  await restarted.tick(); // Complete the old, immutable window.
  assert.equal(coverage.needsRecovery(true), true);
  await restarted.tick();
  await restarted.tick();
  assert.equal(data.state().checkpointAt.getTime(), secondNow);
  assert.equal(coverage.needsRecovery(true), false);
});

test("storage failures leave the cursor unchanged; retries can only replay deduplicated rows", async () => {
  let now = origin, fails = true;
  const data = memoryStore();
  const stored = new Set<string>();
  const worker = new KalshiRecovery(data.store, new KalshiLiveCoverage(origin),
    async () => ({ rows: ["trade"], cursor: "next" }),
    async rows => {
      if (fails) throw new Error("database offline");
      for (const row of rows) stored.add(row);
    }, () => now);
  await assert.rejects(worker.tick(), /database offline/);
  assert.equal(data.state().cursor, null);
  assert.ok(data.state().checkpointAt.getTime() < origin);
  fails = false;
  now += 15_001;
  await worker.tick();
  assert.equal(data.state().cursor, "next");
  assert.equal(stored.size, 1);
});

test("a failure saving progress never skips a previously ingested page", async () => {
  let now = origin, failCheckpoint = true;
  const data = memoryStore();
  const save = data.store.save;
  data.store.save = async value => {
    if (value.cursor === "next" && failCheckpoint) { failCheckpoint = false; throw new Error("progress write failed"); }
    await save(value);
  };
  const seen: string[] = [];
  const worker = new KalshiRecovery(data.store, new KalshiLiveCoverage(origin),
    async state => { seen.push(state.cursor ?? "first"); return { rows: ["id"], cursor: "next" }; },
    async () => {}, () => now);
  await assert.rejects(worker.tick());
  now += 15_001;
  await worker.tick();
  assert.deepEqual(seen, ["first", "first"]);
  assert.equal(data.state().cursor, "next");
});

test("a gap or catalog rewind during recovery cannot be acknowledged by an older pass", async () => {
  const data = memoryStore();
  const coverage = new KalshiLiveCoverage(origin);
  const worker = new KalshiRecovery(data.store, coverage, async state => {
    if (state.phase === "archive") coverage.requestRecovery(origin - 600_000);
    return { rows: [], cursor: null };
  }, async () => {}, () => origin);
  await worker.tick();
  await worker.tick();
  assert.equal(coverage.needsRecovery(true), true);
  assert.equal(coverage.boundary, origin - 600_000);
  await worker.tick();
  assert.equal(data.state().checkpointAt.getTime(), origin - 600_000);
  assert.equal(data.state().windowEndAt!.getTime(), origin - 300_000);
});

test("healthy watermarks survive restarts but never advance through a pending gap", async () => {
  let now = origin;
  const data = memoryStore();
  const coverage = new KalshiLiveCoverage(origin);
  const worker = new KalshiRecovery(data.store, coverage,
    async () => ({ rows: [], cursor: null }), async () => {}, () => now);
  await worker.tick(); await worker.tick();
  now += 120_000;
  coverage.streamPersisted(now, true);
  await worker.persistHealthy(true);
  assert.equal(data.state().checkpointAt.getTime(), origin + 60_000);
  coverage.requestRecovery();
  now += 120_000;
  coverage.streamPersisted(now, true);
  await worker.persistHealthy(true);
  assert.equal(data.state().checkpointAt.getTime(), origin + 60_000);
});

test("expired provider cursors restart only their bounded partition, not the whole outage", async () => {
  let now = origin;
  const data = memoryStore();
  const worker = new KalshiRecovery(data.store, new KalshiLiveCoverage(origin),
    async state => {
      if (state.cursor) throw new Error("Kalshi returned HTTP 400");
      return { rows: [], cursor: "expired" };
    }, async () => {}, () => now);
  await worker.tick();
  const start = data.state().windowStartAt!.getTime();
  await assert.rejects(worker.tick(), /400/);
  assert.equal(data.state().cursor, null);
  assert.equal(data.state().windowStartAt!.getTime(), start);
  now += 15_001;
  await worker.tick();
  assert.equal(data.state().cursor, "expired");
});
