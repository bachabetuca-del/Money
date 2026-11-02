import assert from "node:assert/strict";
import { test } from "node:test";
import {
  liveNotificationTrades, notificationText, TelegramTradeNotifications,
  type NotificationApi, type NotificationJob, type NotificationStore,
} from "./telegram-trade-notifications";
import { buildNotificationRoiLookup, type NotificationRoi, type RoiBasis } from "./telegram-notification-roi";
import type { RoiRollup } from "./roi-ranking";
import { shouldCaptureTrade } from "./kalshi-trade-bands";

const clock = new Date("2026-10-22T21:00:00Z");
const settings = { enabled: true, chatId: "notification-test" };
const grossRoi = (row: { roiPct: number; games: number; trades: number } | null): NotificationRoi | null =>
  row ? { ...row, basis: "gross", grossRoiPct: row.roiPct, netRoiPct: null } : null;
const sample = (tradeId = "trade-1", notional = 15000): NotificationJob => ({
  tradeId, chatId: settings.chatId, attempts: 0,
  ticker: "KXNFLGAME-TEST-CHI", sport: "Football", eventTitle: "New England vs Chicago",
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
      !item.sentAt && !item.skippedAt && item.retryAt <= now && shouldCaptureTrade(item.notional))
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
  failRoi = false;
  roiResult: NotificationRoi | null = grossRoi({ roiPct: 7, games: 10, trades: 30 });
  roiTrades: NotificationJob[] = [];
  roiBases: RoiBasis[] = [];
  async roi(trade: NotificationJob, basis: RoiBasis) {
    this.roiTrades.push(trade);
    this.roiBases.push(basis);
    if (this.failRoi) throw new Error("Historical ROI temporarily unavailable.");
    return this.roiResult;
  }
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

test("fresh trades from all captured amounts reach the ROI gate; snapshots and older history are silent", () => {
  const boundary = clock.getTime();
  const rows = [999.99, 1000, 2500, 5000, 9999.99, 10000, 10000.01, 20000].map(notional => ({
    notional, createdTime: new Date(boundary + 1).toISOString(),
  }));
  rows.push({ notional: 80000, createdTime: new Date(boundary - 1).toISOString() });
  rows.push({ notional: 80000, createdTime: "invalid" });
  rows.push({ notional: Infinity, createdTime: new Date(boundary + 1).toISOString() });
  assert.deepEqual(liveNotificationTrades(rows, boundary).map(row => row.notional),
    [1000, 2500, 5000, 9999.99, 10000, 10000.01, 20000]);
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
  assert.match(String(body.text), /A favor de «Chicago gana»/);
  assert.match(String(body.text), /ROI histórico comparable \(SÍ\)/);
  assert.match(String(body.text), /Bruto: \+7,00% · Neto estimado: no disponible/);
  assert.match(String(body.text), /10 partidos · 30 operaciones verificadas/);
  assert.match(String(body.text), /neto con comisión taker actual/);
  assert.match(String(body.text), /No son ganancias del trader ni una garantía/);
  assert.doesNotMatch(String(body.text), /KXNFLGAME/);
  assert.deepEqual(body.link_preview_options, { is_disabled: true });
  assert.match(JSON.stringify(body.reply_markup), /Abrir en Kalshi/);
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

test("paused monitoring, missing destinations, foreign chats and trades below the capture floor cannot notify", async () => {
  const { store, api, worker } = setup();
  store.add(sample());
  await worker.tick({ ...settings, enabled: false });
  await worker.tick({ ...settings, chatId: null });
  await worker.tick({ ...settings, chatId: "another-chat" });
  assert.equal(api.calls.length, 0);
  const other = setup();
  other.store.add(sample("below-floor", 999.99));
  other.store.add(sample("invalid", NaN));
  await other.worker.tick(settings);
  assert.equal(other.api.calls.length, 0);
});

test("all three amount bands can notify at +7%, including exact $1k, $5k and $10k boundaries", async () => {
  for (const notional of [1000, 2500, 5000, 5000.01, 7500, 9999.99, 10000, 10000.01, 25000]) {
    const { store, api, worker } = setup();
    store.add(sample("all-bands", notional));
    await worker.tick(settings);
    assert.equal(api.calls.filter(call => call.method === "sendMessage").length, 1, String(notional));
    assert.equal(api.roiTrades[0].notional, notional);
  }
});

test("a larger trade cannot bypass a poor ROI, and smaller bands require the same ROI and sample", async () => {
  for (const notional of [1000, 5000, 7500, 10000, 1000000]) {
    for (const roi of [{ roiPct: 6.99, games: 10, trades: 30 }, { roiPct: 100, games: 9, trades: 100 }]) {
      const { store, api, worker } = setup();
      api.roiResult = grossRoi(roi);
      store.add(sample("blocked", notional));
      await worker.tick(settings);
      assert.equal(api.calls.length, 0);
      assert.ok(store.row(settings.chatId, "blocked").skippedAt);
    }
  }
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
    roi: api.roi.bind(api),
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
  assert.match(notificationText(row), /En contra de «Chicago gana»/);
  assert.match(notificationText({ ...row, outcomeSide: "unknown" }), /Dirección no disponible/);
  assert.match(notificationText(row), /no identifica al operador ni confirma una venta o cierre/);
});

test("ROI +7% is inclusive; lower or unavailable ROI and insufficient samples never notify", async () => {
  const base = { games: 10, trades: 30 };
  for (const [roi, allowed] of [
    [{ ...base, roiPct: 6.99 }, false],
    [{ ...base, roiPct: 6.99999999 }, false],
    [{ ...base, roiPct: 7 }, true],
    [{ ...base, roiPct: 7.01 }, true],
    [{ ...base, roiPct: -10 }, false],
    [{ ...base, roiPct: 0 }, false],
    [{ ...base, roiPct: NaN }, false],
    [{ ...base, roiPct: Infinity }, false],
    [{ ...base, roiPct: 80, games: 9 }, false],
    [{ ...base, roiPct: 80, trades: 29 }, false],
    [null, false],
  ] as const) {
    const { store, api, worker } = setup();
    api.roiResult = grossRoi(roi);
    store.add(sample());
    await worker.tick(settings);
    assert.equal(api.calls.some(call => call.method === "sendMessage"), allowed, JSON.stringify(roi));
    assert.equal(Boolean(store.row(settings.chatId, "trade-1").skippedAt), !allowed);
  }
});

test("filtered trades keep the last notice and are not replayed when ROI later improves or the worker restarts", async () => {
  const { store, api, worker, now } = setup();
  store.add(sample());
  await worker.tick(settings);
  api.roiResult = grossRoi({ roiPct: 6.9, trades: 30, games: 10 });
  store.add(sample("filtered"));
  await worker.tick(settings);
  api.roiResult = grossRoi({ roiPct: 20, trades: 30, games: 10 });
  await new TelegramTradeNotifications(store, api, now).tick(settings);
  assert.deepEqual(api.calls.map(call => call.method), ["sendMessage"]);
  assert.equal(store.row(settings.chatId, "trade-1").removedAt, undefined);
  assert.ok(store.row(settings.chatId, "filtered").skippedAt);
  assert.equal(store.rows.size, 2, "Filtering must not delete saved trades or the previous notice");
});

test("ROI lookup errors fail closed and retry without removing the last notice", async () => {
  const { store, api, worker, advance } = setup();
  store.add(sample());
  await worker.tick(settings);
  store.add(sample("retry"));
  api.failRoi = true;
  await worker.tick(settings);
  assert.deepEqual(api.calls.map(call => call.method), ["sendMessage"]);
  assert.equal(store.row(settings.chatId, "retry").skippedAt, undefined);
  assert.equal(store.row(settings.chatId, "retry").sentAt, undefined);
  assert.equal(store.row(settings.chatId, "trade-1").removedAt, undefined);
  assert.match(store.row(settings.chatId, "retry").error!, /ROI/);
  api.failRoi = false;
  advance(15000);
  await worker.tick(settings);
  assert.deepEqual(api.calls.map(call => call.method), ["sendMessage", "sendMessage", "deleteMessage"]);
});

test("checks the actual NO execution and enriched market, never the opposite side's better ROI", async () => {
  const { store, api, worker } = setup();
  const history: RoiRollup[] = Array.from({ length: 10 }, (_, i) => ({
    ticker: `KXNFLGAME-HIST${i}-CHI`, sport: "Football", eventTitle: "A vs B", marketTitle: "A wins",
    gameId: `game-${i}`, marketUrl: "", bucket: 6, side: "yes", moneyBand: "large",
    weekStart: "2026-10-19", category: "settled", historyVerified: true, trades: 3, wins: 2,
    profit: 60, recentProfit: 60, recentTrades: 3,
    firstAt: clock.toISOString(), lastAt: clock.toISOString(), checkedAt: clock.toISOString(), error: false,
  }));
  const lookup = buildNotificationRoiLookup(history);
  api.roi = async trade => { api.roiTrades.push(trade); return lookup(trade); };
  store.add({ ...sample("no"), outcomeSide: "no", price: .4, count: 37500 });
  store.add(sample("yes"));
  await worker.tick(settings);
  assert.ok(store.row(settings.chatId, "no").skippedAt);
  assert.ok(store.row(settings.chatId, "yes").sentAt, "Filtered jobs do not block eligible jobs behind them");
  assert.equal(api.calls.filter(call => call.method === "sendMessage").length, 1);
  assert.equal(api.roiTrades[0].price, .4);
  assert.equal(api.roiTrades[0].outcomeSide, "no");
  assert.equal(api.roiTrades[0].eventTitle, "New England & Chicago");
  assert.match(String(api.calls[0].body.text), /ROI histórico comparable \(SÍ\)/);
  assert.match(String(api.calls[0].body.text), /Bruto: \+20,00%/);
});

test("filter draining is bounded and still sends at most one notice per tick", async () => {
  const { store, api, worker } = setup();
  api.roiResult = null;
  for (let i = 0; i < 12; i++) store.add(sample(`filtered-${i}`));
  await worker.tick(settings);
  assert.equal(api.roiTrades.length, 10);
  assert.equal(api.calls.length, 0);
  await worker.tick(settings);
  assert.equal(api.roiTrades.length, 12);
  api.roiResult = grossRoi({ roiPct: 7, games: 10, trades: 30 });
  store.add(sample("eligible-1"));
  store.add(sample("eligible-2"));
  await worker.tick(settings);
  assert.equal(api.calls.filter(call => call.method === "sendMessage").length, 1);
});

test("selected basis reaches the worker, cannot silently revert, and filtered trades are never replayed", async () => {
  const { store, api, worker, now } = setup();
  store.add(sample("gross-only"));
  await worker.tick({ ...settings, notificationRoiBasis: "net" });
  assert.equal(api.roiBases[0], "net");
  assert.equal(api.calls.length, 0, "A gross-only lookup cannot satisfy a net request");
  assert.ok(store.row(settings.chatId, "gross-only").skippedAt);
  api.roiResult = { roiPct: 7, grossRoiPct: 11, netRoiPct: 7, basis: "net", games: 10, trades: 30 };
  store.add(sample("net-pass"));
  await worker.tick({ ...settings, notificationRoiBasis: "net" });
  assert.equal(api.calls.filter(c => c.method === "sendMessage").length, 1);
  assert.match(String(api.calls[0].body.text), /Bruto: \+11,00% · Neto estimado: \+7,00%/);
  assert.match(String(api.calls[0].body.text), /Filtro elegido: neto estimado/);
  assert.match(String(api.calls[0].body.text), /No son ganancias del trader/);
  await new TelegramTradeNotifications(store, api, now).tick(settings);
  assert.equal(api.calls.filter(c => c.method === "sendMessage").length, 1);
});
