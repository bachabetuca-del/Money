import assert from "node:assert/strict";
import { test } from "node:test";
import { AsyncTtlCache } from "./async-ttl-cache";

test("one expensive load stays single-flight across clock boundaries and starts its TTL on completion", async () => {
  let now = 9999, calls = 0;
  const cache = new AsyncTtlCache<number>(10_000, 4, () => now);
  let finish!: (value: number) => void;
  const load = () => {
    calls++;
    return new Promise<number>(resolve => { finish = resolve; });
  };
  const first = cache.get("band:small", load);
  await Promise.resolve();
  now = 40_000;
  const concurrent = cache.get("band:small", load);
  assert.equal(concurrent, first);
  assert.equal(calls, 1);
  finish(42);
  assert.equal(await first, 42);
  now = 49_999;
  assert.equal(await cache.get("band:small", async () => ++calls), 42);
  assert.equal(calls, 1);
  now = 50_000;
  assert.equal(await cache.get("band:small", async () => ++calls), 2);
});

test("filter identities stay isolated and failed loads are retried, never returned as stale success", async () => {
  const cache = new AsyncTtlCache<string>(10_000);
  assert.equal(await cache.get("small:active:yes", async () => "yes"), "yes");
  assert.equal(await cache.get("small:active:no", async () => "no"), "no");
  assert.equal(await cache.get("large:active:yes", async () => "large"), "large");
  await assert.rejects(cache.get("small:history:yes", async () => { throw new Error("database unavailable"); }));
  assert.equal(await cache.get("small:history:yes", async () => "recovered"), "recovered");
});
