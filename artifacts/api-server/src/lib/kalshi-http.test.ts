import assert from "node:assert/strict";
import { test } from "node:test";
import { KalshiCooldownError, KalshiHttpClient, KalshiHttpError, retryAfterMs } from "./kalshi-http";

const origin = Date.parse("2026-10-25T20:00:00Z");
const url = "https://example.test/markets/trades";
const ok = () => Response.json({ trades: [] });
const limited = (retryAfter?: string) => new Response(null, {
  status: 429, headers: retryAfter ? { "Retry-After": retryAfter } : {},
});

test("Retry-After supports seconds and HTTP dates with safe invalid fallback", () => {
  assert.equal(retryAfterMs("120", origin), 120000);
  assert.equal(retryAfterMs("1.5", origin), 1500);
  assert.equal(retryAfterMs(new Date(origin + 60000).toUTCString(), origin), 60000);
  assert.equal(retryAfterMs(new Date(origin - 1000).toUTCString(), origin), 0);
  assert.equal(retryAfterMs("not-a-date", origin), null);
  assert.equal(retryAfterMs(null, origin), null);
  assert.equal(retryAfterMs(" ", origin), null);
});

test("all callers share the pause, no requests during it, then resume successfully", async () => {
  let now = origin;
  let calls = 0;
  const pauses: number[] = [];
  const client = new KalshiHttpClient(async () => ++calls === 1 ? limited("120") : ok(),
    () => now, (_, delay) => pauses.push(delay));
  await assert.rejects(client.json(url), KalshiCooldownError);
  assert.equal(client.isPaused, true);
  for (const path of ["markets/trades", "historical/trades", "milestones/score", "events/game"]) {
    await assert.rejects(client.json(`https://example.test/${path}`), KalshiCooldownError);
  }
  assert.equal(calls, 1);
  now += 119999;
  await assert.rejects(client.json(url), KalshiCooldownError);
  now++;
  assert.deepEqual(await client.json(url), { trades: [] });
  assert.equal(calls, 2);
  assert.equal(client.isPaused, false);
  assert.deepEqual(pauses, [120000]);
});

test("repeated 429s back off progressively with a five minute cap; success resets it", async () => {
  let now = origin;
  let success = false;
  const client = new KalshiHttpClient(async () => success ? ok() : limited("invalid"), () => now);
  for (const delay of [30000, 60000, 120000, 240000, 300000, 300000]) {
    await assert.rejects(client.json(url), (error: unknown) => {
      assert.ok(error instanceof KalshiCooldownError);
      assert.equal(error.retryAt, now + delay);
      return true;
    });
    now += delay;
  }
  success = true;
  await client.json(url);
  success = false;
  await assert.rejects(client.json(url), (error: unknown) => {
    assert.ok(error instanceof KalshiCooldownError);
    assert.equal(error.retryAt, now + 30000);
    return true;
  });
});

test("provider retry date is respected even beyond the fallback backoff cap", async () => {
  const client = new KalshiHttpClient(async () => limited(new Date(origin + 900000).toUTCString()), () => origin);
  await assert.rejects(client.json(url), (error: unknown) => {
    assert.ok(error instanceof KalshiCooldownError);
    assert.equal(error.retryAt, origin + 900000);
    return true;
  });
});

test("late in-flight success cannot clear another request's rate limit", async () => {
  let finish!: (response: Response) => void;
  const client = new KalshiHttpClient(async path => path === url
    ? new Promise<Response>(resolve => { finish = resolve; }) : limited(), () => origin);
  const pending = client.json(url);
  await assert.rejects(client.json(`${url}/second`), KalshiCooldownError);
  finish(ok());
  await pending;
  assert.equal(client.isPaused, true);
  await assert.rejects(client.json(url), KalshiCooldownError);
});

test("only one recovery probe runs and failed probes never leave a stuck lock", async () => {
  let now = origin;
  let calls = 0;
  let finish!: (response: Response) => void;
  const client = new KalshiHttpClient(async () => {
    calls++;
    return calls === 1 ? limited() : calls === 2
      ? new Promise<Response>(resolve => { finish = resolve; }) : ok();
  }, () => now);
  await assert.rejects(client.json(url), KalshiCooldownError);
  now += 30000;
  const probe = client.json(url);
  await assert.rejects(client.json(`${url}/other-worker`), KalshiCooldownError);
  assert.equal(calls, 2);
  finish(new Response(null, { status: 503 }));
  await assert.rejects(probe, KalshiHttpError);
  assert.equal(client.isPaused, true);
  now += 4000;
  await client.json(url);
  assert.equal(calls, 3);
});

test("network failures pause every worker, release recovery probes and preserve rate-limit statistics", async () => {
  let now = origin, calls = 0;
  const reasons: string[] = [];
  const client = new KalshiHttpClient(async () => {
    if (++calls <= 2) throw new DOMException("timeout", "TimeoutError");
    return ok();
  }, () => now, (_, __, reason) => reasons.push(reason));
  await assert.rejects(client.json(url), /connection/);
  await assert.rejects(client.json(`${url}/other`), KalshiCooldownError);
  assert.equal(calls, 1);
  now += 2000;
  await assert.rejects(client.json(url), /connection/);
  now += 4000;
  await client.json(url);
  assert.equal(client.isPaused, false);
  assert.equal(client.stats.limited, 0);
  assert.deepEqual(reasons, ["connection", "connection"]);
});

test("temporary server failure respects Retry-After and invalid response bodies are not cached", async () => {
  let now = origin, calls = 0;
  const client = new KalshiHttpClient(async () => {
    calls++;
    if (calls === 1) return new Response(null, { status: 503, headers: { "retry-after": "60" } });
    if (calls === 2) return new Response("broken json");
    return ok();
  }, () => now);
  const metadata = "https://example.test/trade-api/v2/markets/test";
  await assert.rejects(client.cachedJson(metadata), KalshiHttpError);
  now += 59_999;
  await assert.rejects(client.cachedJson(metadata), KalshiCooldownError);
  now++;
  await assert.rejects(client.cachedJson(metadata), /interrupted or invalid/);
  now += 4000;
  assert.deepEqual(await client.cachedJson(metadata), { trades: [] });
  assert.equal(calls, 3);
});

test("non-429 failures retain HTTP errors and do not activate rate-limit pauses", async () => {
  const client = new KalshiHttpClient(async () => new Response(null, { status: 404 }), () => origin);
  await assert.rejects(client.json(url), (error: unknown) => {
    assert.ok(error instanceof KalshiHttpError);
    assert.equal(error.status, 404);
    assert.match(error.message, /HTTP 404/);
    return true;
  });
  assert.equal(client.isPaused, false);
});
