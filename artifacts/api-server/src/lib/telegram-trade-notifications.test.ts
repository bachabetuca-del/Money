import assert from "node:assert/strict";
import { test } from "node:test";
import {
  liveNotificationTrades, notificationText, TelegramTradeNotifications,
  type NotificationApi, type NotificationJob, type NotificationStore,
} from "./telegram-trade-notifications";

const clock = new Date("2026-10-22T21:00:00Z");
const settings = { enabled: true, chatId: "notification-test" };
const sample = (tradeId = "trade-1", notional = 15000): NotificationJob => ({
  tradeId, chatId: settings.chatId, attempts: 0,
  ticker: "KXNFLGAME-TEST-CHI", eventTitle: "New England vs Chicago",
  marketTitle: "Chicago wins", marketUrl: "https://kalshi.com/markets/kxnflgame/example",
  notional, count: notional / 0.6, price: 0.6, outcomeSide: "yes",
  createdTime: clock,
});
type Row = NotificationJob & {
  sentAt?: Date; skippedAt?: Date; messageId?: number; removedAt?: Date; retryAt: Date; error?: string;
};

class MemoryNotifications implements NotificationStore {
  rows = new Map<string, Row>();
  add(job: NotificationJob) {
    const key = `${job.chatId}:${job.tradeId}`;
    if (!this.rows.has(key)) this.rows.set(key, { ...job, retryAt: clock });
  }
  row(chatId: string, tradeId: string) { return this.rows.get(`${chatId}:${tradeId}`)!; }
  async next(chatId: string, now: Date) {
    const row = [...this.rows.values()].filter(item => item.chatId === chatId &&
      !item.sentAt && !item.skippedAt && item.retryAt <= now && item.notional > 10000)
      .sort((a, b) => a.createdTime.getTime() - b.createdTime.getTime())[0];
    return row ? { ...row } : undefined;
  }
  async sent(job: NotificationJob, messageId: number, now: Date) {
    Object.assign(this.row(job.chatId, job.tradeId), { sentAt: now, messageId, error: undefined, retryAt: now });
  }
  async skipped(job: NotificationJob, now: Date) { this.row(job.chatId, job.tradeId).skippedAt = now; }
  async failed(chatId: string, tradeId: string, error: string, retryAt: Date) {
    const row = this.row(chatId, tradeId);
    Object.assign(row, { error, retryAt, attempts: row.attempts + 1 });
  }
  async latestMessageId(chatId: string) {
    return [...this.rows.values()].filter(row => row.chatId === chatId && row.sentAt && !row.removedAt)
      .sort((a, b) => b.messageId! - a.messageId!)[0]?.messageId;
  }
  async cleanup(chatId: string, keep: number, now: Date) {
    return [...this.rows.values()].filter(row => row.chatId === chatId && row.sentAt &&
      row.messageId !== keep && !row.removedAt && row.retryAt <= now)
      .map(row => ({ tradeId: row.tradeId, messageId: row.messageId! }));
  }
  async removed(chatId: string, tradeId: string, now: Date) {
    this.row(chatId, tradeId).removedAt = now;
  }
}
class FakeNotificationsApi implements NotificationApi {
  calls: { method: string; body: Record<string, unknown> }[] = [];
  id = 900;
  failSend: string | null = null;
  failDelete = false;
  failContext = false;
  async context() {
    if (this.failContext) throw new Error("Market metadata temporarily unavailable.");
    return { eventTitle: "New England & Chicago", marketTitle: "Chicago wins" };
  }
  async request<T>(method: string, body: Record<string, unknown>) {
    this.calls.push({ method, body });
    await new Promise(resolve => setTimeout(resolve, 1));
    if (method === "sendMessage") {
      if (this.failSend) { const error = this.failSend; this.failSend = null; throw new Error(error); }
      return { result: { message_id: ++this.id } as T };
    }
    if (method === "deleteMessage" && this.failDelete) throw new Error("Message can't be deleted");
    return { result: true as T };
  }
}
function setup() {
  const store = new MemoryNotifications();
  const api = new FakeNotificationsApi();
  let now = new Date(clock);
  return { store, api, advance: (milliseconds: number) => { now = new Date(now.getTime() + milliseconds); },
    worker: new TelegramTradeNotifications(store, api, () => now), now: () => now };
}

test("only fresh sports trades strictly over $10k qualify; snapshots, exact $10k and older history are silent", () => {
  const boundary = clock.getTime();
  const rows = [5000, 9999.99, 10000, 10000.01, 20000].map(notional => ({
    notional, createdTime: new Date(boundary + 1).toISOString(),
  }));
  rows.push({ notional: 80000, createdTime: new Date(boundary - 1).toISOString() });
  rows.push({ notional: 80000, createdTime: "invalid" });
  rows.push({ notional: Infinity, createdTime: new Date(boundary + 1).toISOString() });
  assert.deepEqual(liveNotificationTrades(rows, boundary).map(row => row.notional), [10000.01, 20000]);
  assert.deepEqual(liveNotificationTrades(rows, null), []);
  assert.deepEqual(liveNotificationTrades(rows, boundary + 1000), []);
});

test("a new qualifying trade sends a push-enabled text alert, not another graph", async () => {
  const { store, api, worker } = setup();
  store.add(sample());
  await worker.tick(settings);
  assert.deepEqual(api.calls.map(call => call.method), ["sendMessage"]);
  const body = api.calls[0].body;
  assert.equal(body.disable_notification, false);
  assert.equal(body.parse_mode, "HTML");
  assert.match(String(body.text), /\$15,000\.00/);
  assert.match(String(body.text), /New England &amp; Chicago/);
  assert.match(String(body.text), /FOR · Chicago to win/);
  assert.doesNotMatch(String(body.text), /KXNFLGAME/);
  assert.deepEqual(body.link_preview_options, { is_disabled: true });
  assert.match(JSON.stringify(body.reply_markup), /Open in Kalshi/);
  assert.ok(store.row(settings.chatId, "trade-1").sentAt);
});

test("only the previous notification is removed, after the new one is confirmed; history and graph stay intact", async () => {
  const { store, api, worker } = setup();
  store.add(sample());
  await worker.tick(settings);
  store.add(sample("trade-2", 25000));
  await worker.tick(settings);
  assert.deepEqual(api.calls.map(call => call.method), ["sendMessage", "sendMessage", "deleteMessage"]);
  assert.equal(api.calls[2].body.message_id, 901);
  assert.ok(store.row(settings.chatId, "trade-1").removedAt);
  assert.equal(store.row(settings.chatId, "trade-2").removedAt, undefined);
  assert.equal(store.rows.size, 2, "Retiring a notification must retain its trade record");
  assert.ok(api.calls.every(call => call.body.message_id !== 400), "Never delete the dashboard");
});

test("repeated polling, duplicate enqueue and restarts do not resend delivered notifications", async () => {
  const { store, api, worker, now } = setup();
  store.add(sample());
  await worker.tick(settings);
  store.add(sample());
  await worker.tick(settings);
  await new TelegramTradeNotifications(store, api, now).tick(settings);
  assert.equal(api.calls.filter(call => call.method === "sendMessage").length, 1);
});

test("delivery failure preserves the previous notice and persists a retry", async () => {
  const { store, api, worker, advance } = setup();
  store.add(sample());
  await worker.tick(settings);
  store.add(sample("trade-2"));
  api.failSend = "Temporary Telegram error";
  await worker.tick(settings);
  assert.equal(store.row(settings.chatId, "trade-1").removedAt, undefined);
  assert.equal(store.row(settings.chatId, "trade-2").sentAt, undefined);
  const attempts = api.calls.length;
  await worker.tick(settings);
  assert.equal(api.calls.length, attempts);
  advance(15000);
  await worker.tick(settings);
  assert.ok(store.row(settings.chatId, "trade-2").sentAt);
  assert.ok(store.row(settings.chatId, "trade-1").removedAt);
});

test("cleanup errors retry deletion without resending a delivered alert", async () => {
  const { store, api, worker, advance } = setup();
  store.add(sample());
  await worker.tick(settings);
  store.add(sample("trade-2"));
  api.failDelete = true;
  await worker.tick(settings);
  assert.ok(store.row(settings.chatId, "trade-2").sentAt);
  assert.equal(store.row(settings.chatId, "trade-1").removedAt, undefined);
  api.failDelete = false;
  advance(60000);
  await worker.tick(settings);
  assert.ok(store.row(settings.chatId, "trade-1").removedAt);
  assert.equal(api.calls.filter(call => call.method === "sendMessage").length, 2);
});

test("paused monitoring, missing destinations, foreign chats and $10k-or-smaller trades cannot notify", async () => {
  const { store, api, worker } = setup();
  store.add(sample());
  await worker.tick({ ...settings, enabled: false });
  await worker.tick({ ...settings, chatId: null });
  await worker.tick({ ...settings, chatId: "another-chat" });
  assert.equal(api.calls.length, 0);
  const other = setup();
  other.store.add(sample("exact", 10000));
  other.store.add(sample("medium", 7500));
  await other.worker.tick(settings);
  assert.equal(other.api.calls.length, 0);
});

test("missing readable metadata is retried rather than sending ticker codes", async () => {
  const { store, api, worker, advance } = setup();
  store.add(sample());
  api.failContext = true;
  await worker.tick(settings);
  assert.equal(api.calls.length, 0);
  advance(15000);
  api.failContext = false;
  await worker.tick(settings);
  assert.equal(api.calls[0].method, "sendMessage");
});

test("concurrent ticks cannot create duplicate notification sends", async () => {
  const { store, api, worker } = setup();
  store.add(sample());
  await Promise.all([worker.tick(settings), worker.tick(settings), worker.tick(settings)]);
  assert.equal(api.calls.filter(call => call.method === "sendMessage").length, 1);
});

test("Telegram rate-limit delays are respected", async () => {
  const { store, api, worker } = setup();
  store.add(sample());
  api.failSend = "Too Many Requests: retry after 120";
  await worker.tick(settings);
  assert.equal(store.row(settings.chatId, "trade-1").retryAt.getTime(), clock.getTime() + 120000);
});

test("a queued trade from a now-finished game is retired without notification or repeated retries", async () => {
  const { store, api, now } = setup();
  store.add(sample());
  const worker = new TelegramTradeNotifications(store, {
    request: api.request.bind(api), context: api.context.bind(api), active: async () => false,
  }, now);
  await worker.tick(settings);
  await worker.tick(settings);
  assert.equal(api.calls.length, 0);
  assert.ok(store.row(settings.chatId, "trade-1").skippedAt);
  assert.equal(store.row(settings.chatId, "trade-1").sentAt, undefined);
});

test("notification wording escapes names and distinguishes against/unknown direction", () => {
  const row = { ...sample(), eventTitle: "Chicago <final> & New England", outcomeSide: "no" };
  assert.match(notificationText(row), /Chicago &lt;final&gt; &amp; New England/);
  assert.match(notificationText(row), /AGAINST · Chicago to win/);
  assert.match(notificationText({ ...row, outcomeSide: "unknown" }), /Direction unavailable/);
});
