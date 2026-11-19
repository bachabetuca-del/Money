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

test("a timed out send is attempted only once; delivery recovers independently of polling and edits", async () => {
  let calls = 0, now = 0;
  const client = new TelegramHttpClient(() => "fake-token", async () => {
    if (++calls === 1) throw new DOMException("private URL fake-token", "TimeoutError");
    return success();
  }, () => now);
  await assert.rejects(client.call("sendMessage", {}), /timeout.*retry after 5/);
  await assert.rejects(client.call("sendMessage", {}), /paused/);
  assert.equal(calls, 1);
  await client.call("getUpdates", {});
  await client.call("editMessageText", {});
  await assert.rejects(client.call("sendMessage", {}), /paused/);
  now = 5000;
  await client.call("sendMessage", {});
  assert.equal(calls, 4);
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

test("only one request per lane probes recovery; polling cannot monopolize delivery", async () => {
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
  await assert.rejects(client.call("getUpdates", {}), /paused/);
  await client.call("sendMessage", {});
  finish(new Response(null, { status: 503 }));
  await assert.rejects(probe, /retry after 10/);
  now += 10_000;
  await client.call("getUpdates");
  assert.equal(calls, 4);
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
  await assert.rejects(client.call("sendMessage", {}), /paused/);
});

test("graph upload and polling outages do not pause fresh alert delivery", async () => {
  let sends = 0;
  const client = new TelegramHttpClient(() => "fake", async url => {
    if (!String(url).endsWith("/sendMessage")) throw new DOMException("timeout", "TimeoutError");
    sends++;
    return success();
  }, () => 0);
  await assert.rejects(client.call("editMessageMedia", new FormData()), /timeout/);
  await assert.rejects(client.call("getUpdates", {}), /timeout/);
  await client.call("sendMessage", {});
  assert.equal(sends, 1);
  await assert.rejects(client.call("sendPhoto", new FormData()), /paused/);
});

test("short explicit retry_after is honored without imposing a 30-second minimum", async () => {
  let now = 0, calls = 0;
  const client = new TelegramHttpClient(() => "fake", async () => ++calls === 1
    ? Response.json({ ok: false, parameters: { retry_after: 2 } }, { status: 429 }) : success(), () => now);
  await assert.rejects(client.call("getUpdates", {}), /retry after 2/);
  now = 1999;
  await assert.rejects(client.call("sendMessage", {}), /paused/);
  now = 2000;
  await client.call("sendMessage", {});
  assert.equal(calls, 2);
});

test("a non-JSON 429 still enforces its shared Retry-After", async () => {
  let now = 0, calls = 0;
  const client = new TelegramHttpClient(() => "fake", async () => ++calls === 1
    ? new Response("Too many requests", { status: 429, headers: { "retry-after": "12" } }) : success(), () => now);
  await assert.rejects(client.call("getUpdates", {}), /retry after 12/);
  await assert.rejects(client.call("sendMessage", {}), /paused/);
  assert.equal(calls, 1);
  now = 12_000;
  await client.call("sendMessage", {});
});

test("a graph rate limit still blocks delivery even when a polling probe succeeds later", async () => {
  let finish!: (r: Response) => void;
  const client = new TelegramHttpClient(() => "fake", async url =>
    String(url).endsWith("/getUpdates") ? new Promise<Response>(r => { finish = r; }) :
      Response.json({ ok: false, parameters: { retry_after: 40 } }, { status: 429 }), () => 0);
  const poll = client.call("getUpdates", {});
  await assert.rejects(client.call("editMessageMedia", new FormData()), /retry after 40/);
  finish(success());
  await poll;
  await assert.rejects(client.call("sendMessage", {}), /paused/);
});
