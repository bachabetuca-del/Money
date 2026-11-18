import assert from "node:assert/strict";
import { test } from "node:test";
import { TelegramHttpClient, telegramTimeoutMs } from "./telegram-http";

const success = () => Response.json({ ok: true, result: { message_id: 1 } });

test("long polling has 20 seconds of response margin; uploads have a separate budget", () => {
  assert.equal(telegramTimeoutMs("getUpdates", { timeout: 10 }), 30_000);
  assert.equal(telegramTimeoutMs("getUpdates", { timeout: 50 }), 70_000);
  assert.equal(telegramTimeoutMs("sendMessage", {}), 30_000);
  assert.equal(telegramTimeoutMs("sendPhoto", new FormData()), 60_000);
});

test("a timed out send is attempted only once and the shared circuit then recovers", async () => {
  let calls = 0, now = 0;
  const client = new TelegramHttpClient(() => "fake-token", async () => {
    if (++calls === 1) throw new DOMException("private URL fake-token", "TimeoutError");
    return success();
  }, () => now);
  await assert.rejects(client.call("sendMessage", {}), /timeout.*retry after 5/);
  await assert.rejects(client.call("getUpdates", {}), /paused/);
  await assert.rejects(client.call("editMessageText", {}), /paused/);
  assert.equal(calls, 1);
  now = 5000;
  await client.call("getUpdates", {});
  await client.call("sendMessage", {});
  assert.equal(calls, 3);
});

test("rate limits from any Telegram method pause polling, uploads and notifications", async () => {
  let now = 0, calls = 0;
  const client = new TelegramHttpClient(() => "fake", async () => ++calls === 1
    ? Response.json({ ok: false, parameters: { retry_after: 90 } }, { status: 429 }) : success(), () => now);
  await assert.rejects(client.call("editMessageText", {}), /retry after 90/);
  now = 89_999;
  await assert.rejects(client.call("sendMessage", {}), /paused/);
  await assert.rejects(client.call("sendPhoto", new FormData()), /paused/);
  assert.equal(calls, 1);
  now = 90_000;
  await client.call("getUpdates", {});
});

test("an older in-flight success cannot clear a newer rate limit", async () => {
  let finish!: (r: Response) => void;
  let calls = 0;
  const client = new TelegramHttpClient(() => "fake", async () => ++calls === 1
    ? new Promise<Response>(r => { finish = r; })
    : Response.json({ ok: false }, { status: 429 }), () => 0);
  const first = client.call("sendMessage", {});
  await assert.rejects(client.call("getUpdates", {}), /rate limit/);
  finish(success());
  await first;
  await assert.rejects(client.call("getUpdates", {}), /paused/);
});

test("only one request probes recovery and server failures release the probe", async () => {
  let now = 0, calls = 0;
  let finish!: (r: Response) => void;
  const client = new TelegramHttpClient(() => "fake", async () => {
    calls++;
    if (calls === 1) throw new Error("connection failed");
    if (calls === 2) return new Promise<Response>(r => { finish = r; });
    return success();
  }, () => now);
  await assert.rejects(client.call("getUpdates"), /connection/);
  now = 5000;
  const probe = client.call("getUpdates");
  await assert.rejects(client.call("sendMessage", {}), /paused/);
  finish(new Response(null, { status: 503 }));
  await assert.rejects(probe, /retry after 10/);
  now += 10_000;
  await client.call("getUpdates");
  assert.equal(calls, 3);
});

test("known idempotent Telegram errors stay usable; errors never expose token URLs", async () => {
  const client = new TelegramHttpClient(() => "fake-token", async () =>
    Response.json({ ok: false, description: "Bad Request: message is not modified" }, { status: 400 }));
  await assert.rejects(client.call("editMessageText", {}), /message is not modified/);
  const broken = new TelegramHttpClient(() => "fake-token", async () => {
    throw new Error("https://api.telegram.org/botfake-token/sendMessage");
  });
  await assert.rejects(broken.call("sendMessage", {}), error => {
    assert.ok(error instanceof Error);
    assert.doesNotMatch(error.message, /fake-token|https:/);
    return true;
  });
});

test("invalid JSON responses pause without becoming successful sends", async () => {
  const client = new TelegramHttpClient(() => "fake", async () => new Response("not json"));
  await assert.rejects(client.call("sendMessage", {}), /response failure/);
  await assert.rejects(client.call("getUpdates", {}), /paused/);
});
