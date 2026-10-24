import assert from "node:assert/strict";
import { test } from "node:test";
import { ScoreQueue, scoreCanRetry, scoreDisplay, scoreRetryDelay } from "./kalshi-score-queue";

test("parser upgrade recovers exhausted incomplete scores once, without unlimited retries", () => {
  const now = new Date();
  const row = { gameResult: null, attempts: 3, checkedAt: now,
    nextCheckAt: new Date(now.getTime() + 86_400_000), error: "score:incomplete_score" };
  assert.equal(scoreCanRetry(row, now), true);
  assert.equal(scoreCanRetry({ ...row, error: "score:incomplete_score:v2" }, now), false);
  assert.equal(scoreCanRetry({ ...row, gameResult: "Home 1–0 Away" }, now), false);
  assert.equal(scoreCanRetry({ ...row, error: "score:no_feed" }, now), false);
  assert.equal(scoreDisplay({ ...row, error: "score:incomplete_score:v2" }).scoreMessage,
    "Kalshi devuelve un marcador incompleto; no se puede confirmar el resultado");
});

test("selected historical games have bounded, deduplicated priority", () => {
  const queue = new ScoreQueue();
  queue.request("SELECTED"); queue.request("SELECTED"); queue.request("OTHER");
  assert.equal(queue.take(), "SELECTED");
  assert.equal(queue.take(), "OTHER");
  assert.equal(queue.take(), undefined);
  for (let i = 0; i < 110; i++) queue.request(String(i));
  let count = 0;
  while (queue.take()) count++;
  assert.equal(count, 100);
});

test("retry eligibility repairs legacy six-hour waits while respecting budgets and saved results", () => {
  const now = new Date("2026-10-24T12:00:00Z");
  const old = { gameResult: null, attempts: 1, checkedAt: new Date(now.getTime() - 300_000),
    nextCheckAt: new Date(now.getTime() + 6 * 3_600_000) };
  assert.equal(scoreCanRetry(old, now), true);
  assert.equal(scoreCanRetry({ ...old, checkedAt: new Date(now.getTime() - 299_999) }, now), false);
  assert.equal(scoreCanRetry({ ...old, attempts: 3 }, now), false);
  assert.equal(scoreCanRetry({ ...old, gameResult: "Home 2–1 Away" }, now), false);
  assert.equal(scoreCanRetry({ ...old, attempts: 2 }, now), false);
  assert.equal(scoreCanRetry({ ...old, attempts: 2, checkedAt: new Date(now.getTime() - 1_800_000) }, now), true);
  assert.equal(scoreCanRetry(null, now), true);
  assert.equal(scoreRetryDelay(1), 300_000);
  assert.equal(scoreRetryDelay(2), 1_800_000);
});

test("pending means unattempted, never an attempted null feed or a six-hour wait", () => {
  assert.equal(scoreDisplay(undefined).scoreStatus, "pending");
  assert.equal(scoreDisplay({ gameResult: null, attempts: 1, error: null }).scoreStatus, "unavailable");
  assert.match(scoreDisplay({ gameResult: null, attempts: 1, error: "HTTP 503" }).scoreMessage!, /reintento/);
  assert.match(scoreDisplay({ gameResult: null, attempts: 1, error: "score:no_feed" }).scoreMessage!, /no ofrece/);
  assert.match(scoreDisplay({ gameResult: null, attempts: 1, error: "score:not_final" }).scoreMessage!, /no confirma/);
  assert.match(scoreDisplay({ gameResult: null, attempts: 3, error: "HTTP 503" }).scoreMessage!, /varios intentos/);
  assert.equal(scoreDisplay(undefined, "Madrid 2–1 Barcelona").scoreStatus, "confirmed");
});
