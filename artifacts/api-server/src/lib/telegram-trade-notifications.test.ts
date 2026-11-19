import assert from "node:assert/strict";
import { test } from "node:test";
import {
  liveNotificationTrades, notificationText, TelegramTradeNotifications,
  type NotificationApi, type NotificationJob, type NotificationStore,
} from "./telegram-trade-notifications";
import { buildNotificationRoiLookup, type NotificationRoi, type RoiBasis } from "./telegram-notification-roi";
import type { RoiRollup } from "./roi-ranking";
import { shouldCaptureTrade } from "./kalshi-trade-bands";
import { buildSignalEvidence, SIGNAL_FEE_ASSUMPTIONS } from "./signal-evaluation";
import { feeModel } from "./kalshi-fees";
import { TelegramHttpClient, TelegramRetryError } from "./telegram-http";

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
  failCapture = false;
  add(job: NotificationJob) {
    const key = `${job.chatId}:${job.tradeId}`;
    if (!this.rows.has(key)) this.rows.set(key, { ...job, retryAt: clock });
  }
  row(chatId: string, tradeId: string) { return this.rows.get(`${chatId}:${tradeId}`)!; }
  async next(chatId: string, now: Date) {
    const row = [...this.rows.values()].filter(item => item.chatId === chatId &&
      !item.sentAt && !item.skippedAt && item.retryAt <= now && (item.evidence || shouldCaptureTrade(item.notional)))
      .sort((a, b) => a.createdTime.getTime() - b.createdTime.getTime())[0];
    return row ? { ...row } : undefined;
  }
  async capture(job: NotificationJob, roi: NotificationRoi, now: Date) {
    if (this.failCapture) throw new Error("Evidence database unavailable.");
    const row = this.row(job.chatId, job.tradeId);
    row.evidence ??= buildSignalEvidence(job, roi, now);
    return row.evidence;
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
  observe?: NotificationApi["observe"];
  calls: { method: string; body: Record<string, unknown> }[] = [];
  id = 900;
  failSend: string | null = null;
  failDelete = false;
  failContext = false;
  failRoi = false;
  roiResult: NotificationRoi | null = grossRoi({ roiPct: 15, games: 50, trades: 30 });
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
  async request<T>(method: string, body: Record<string, unknown>): Promise<{ result?: T }> {
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
  assert.match(String(body.text), /Apuesta:<\/b> Chicago gana/);
  assert.match(String(body.text), /Posición:<\/b> SÍ · a favor/);
  assert.match(String(body.text), /ROI histórico bruto: \+15,00%/);
  assert.match(String(body.text), /Neto estimado: no disponible/);
  assert.match(String(body.text), /50 partidos · 30 operaciones/);
  assert.match(String(body.text), /Neto con comisión taker actual/);
  assert.match(String(body.text), /<blockquote expandable>.*No son ganancias del trader/);
  assert.match(String(body.text), /Fútbol americano/);
  assert.ok(String(body.text).includes("\n\n"), "Sections stay separated on a phone");
  assert.doesNotMatch(String(body.text), /Filtro elegido|Compra de SÍ o venta de NO/);
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

test("a market waiting for metadata does not block an eligible alert behind it", async () => {
  const { store, api, worker } = setup();
  store.add({ ...sample("missing-details"), ticker: "MISSING" });
  store.add(sample("ready"));
  api.context = async (ticker?: string) => {
    if (ticker === "MISSING") throw new Error("Market metadata temporarily unavailable.");
    return { eventTitle: "New England & Chicago", marketTitle: "Chicago wins" };
  };
  await worker.tick(settings);
  assert.equal(store.row(settings.chatId, "missing-details").sentAt, undefined);
  assert.equal(store.row(settings.chatId, "missing-details").attempts, 1);
  assert.ok(store.row(settings.chatId, "ready").sentAt);
  assert.equal(api.calls.filter(call => call.method === "sendMessage").length, 1);
});

test("ROI lookup failure for one market retries it without blocking the next market", async () => {
  const { store, api, worker } = setup();
  store.add({ ...sample("no-roi-yet"), ticker: "RETRY" });
  store.add(sample("ready"));
  const lookup = api.roi.bind(api);
  api.roi = async (trade, basis) => {
    if (trade.ticker === "RETRY") throw new Error("Historical ROI temporarily unavailable.");
    return lookup(trade, basis);
  };
  await worker.tick(settings);
  assert.equal(store.row(settings.chatId, "no-roi-yet").skippedAt, undefined);
  assert.equal(store.row(settings.chatId, "no-roi-yet").attempts, 1);
  assert.ok(store.row(settings.chatId, "ready").sentAt);
});

test("decision diagnostics distinguish absent history from failed eligibility and eligible sends", async () => {
  const { store, api, worker } = setup();
  const reasons: string[] = [];
  api.observe = event => {
    if (event.stage === "decision" && event.reason) reasons.push(event.reason);
  };
  store.add(sample("no-history"));
  api.roiResult = null;
  await worker.tick(settings);
  store.add(sample("below-cutoff"));
  api.roiResult = grossRoi({ roiPct: 14.99, games: 100, trades: 100 });
  await worker.tick(settings);
  store.add(sample("good"));
  api.roiResult = grossRoi({ roiPct: 15, games: 50, trades: 50 });
  await worker.tick(settings);
  assert.deepEqual(reasons, ["no_comparable_history", "roi_or_sample", "eligible"]);
});

test("transport retry delay is not multiplied by prior queue failures", async () => {
  const { store, api, worker, advance } = setup();
  store.add({ ...sample(), attempts: 20 });
  const original = api.request.bind(api);
  let fail = true;
  api.request = async (method, body) => {
    if (fail) { fail = false; throw new TelegramRetryError("Telegram connection paused; retry after 5", 5000); }
    return original(method, body);
  };
  await worker.tick(settings);
  assert.equal(store.row(settings.chatId, "trade-1").retryAt.getTime(), clock.getTime() + 5000);
  advance(5000);
  await worker.tick(settings);
  assert.ok(store.row(settings.chatId, "trade-1").sentAt);
});

test("a graph timeout cannot suppress a real worker send; flood limits still preserve the old notice", async () => {
  const { store, api, worker, now, advance } = setup();
  let mode: "graph-fails" | "limited" | "healthy" = "graph-fails";
  let sends = 0;
  const transport = new TelegramHttpClient(() => "fake", async url => {
    if (String(url).endsWith("/editMessageMedia")) throw new DOMException("timeout", "TimeoutError");
    if (mode === "limited") return Response.json({ ok: false, parameters: { retry_after: 8 } }, { status: 429 });
    if (String(url).endsWith("/sendMessage")) sends++;
    return Response.json({ ok: true, result: { message_id: 900 + sends } });
  }, () => now().getTime());
  api.request = (method, body) => transport.call(method, body);
  await assert.rejects(transport.call("editMessageMedia", new FormData()), /timeout/);
  store.add(sample("first"));
  await worker.tick(settings);
  assert.ok(store.row(settings.chatId, "first").sentAt);
  store.add(sample("second"));
  mode = "limited";
  await worker.tick(settings);
  assert.equal(store.row(settings.chatId, "first").removedAt, undefined);
  assert.equal(store.row(settings.chatId, "second").sentAt, undefined);
  assert.equal(sends, 1);
  mode = "healthy";
  advance(8000);
  await worker.tick(settings);
  assert.ok(store.row(settings.chatId, "second").sentAt);
  assert.ok(store.row(settings.chatId, "first").removedAt);
  assert.equal(sends, 2);
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

test("all three amount bands can notify at +15%, including exact $1k, $5k and $10k boundaries", async () => {
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
  assert.match(notificationText(row), /Posición:<\/b> NO · en contra/);
  assert.match(notificationText({ ...row, outcomeSide: "unknown" }), /Dirección no disponible/);
  assert.match(notificationText(row), /No confirma una compra o venta/);
});

test("the phone alert keeps the screenshot's essentials above expandable methodology", () => {
  const text = notificationText({
    ...sample(), sport: "Soccer", eventTitle: "Wales vs Portugal", marketTitle: "Wales wins",
    notional: 1462.5, count: 9750, price: .15,
  }, { basis: "gross", roiPct: 61.42, grossRoiPct: 61.42, netRoiPct: 52.41, games: 100, trades: 379 });
  const summary = text.split("<blockquote")[0];
  assert.ok(text.startsWith("<b>Wales vs Portugal</b>\nFútbol\n\n"));
  assert.match(summary, /Apuesta:<\/b> Wales gana/);
  assert.match(summary, /Precio:<\/b> 15¢ por contrato/);
  assert.match(summary, /ROI histórico bruto: \+61,42%/);
  assert.match(summary, /Neto estimado: \+52,41%/);
  assert.match(summary, /100 partidos · 379 operaciones/);
  assert.match(summary, /Monto observado:<\/b> \$1,462\.50/);
  assert.match(summary, /Operación: .*Nueva York/);
  assert.ok(summary.replace(/<[^>]*>/g, "").length < 500);
  assert.doesNotMatch(summary, /Simulación|Filtro elegido|Compra de|venta de/);
  assert.match(text, /<blockquote expandable>Simulación: \$100/);
});

test("ROI +15% is inclusive; lower or unavailable ROI and insufficient samples never notify", async () => {
  const base = { games: 50, trades: 30 };
  for (const [roi, allowed] of [
    [{ ...base, roiPct: 6.99 }, false],
    [{ ...base, roiPct: 6.99999999 }, false],
    [{ ...base, roiPct: 7 }, false],
    [{ ...base, roiPct: 14.99999999 }, false],
    [{ ...base, roiPct: 15 }, true],
    [{ ...base, roiPct: 15.01 }, true],
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
  api.roiResult = grossRoi({ roiPct: 6.9, trades: 30, games: 50 });
  store.add(sample("filtered"));
  await worker.tick(settings);
  api.roiResult = grossRoi({ roiPct: 20, trades: 30, games: 50 });
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
  const history: RoiRollup[] = Array.from({ length: 50 }, (_, i) => ({
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
  assert.match(String(api.calls[0].body.text), /Posición:<\/b> SÍ · a favor/);
  assert.match(String(api.calls[0].body.text), /ROI histórico bruto: \+20,00%/);
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
  api.roiResult = grossRoi({ roiPct: 15, games: 50, trades: 30 });
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
  api.roiResult = { roiPct: 15, grossRoiPct: 20, netRoiPct: 15, basis: "net", games: 50, trades: 30 };
  store.add(sample("net-pass"));
  await worker.tick({ ...settings, notificationRoiBasis: "net" });
  assert.equal(api.calls.filter(c => c.method === "sendMessage").length, 1);
  assert.match(String(api.calls[0].body.text), /Bruto: \+20,00%/);
  assert.match(String(api.calls[0].body.text), /ROI histórico neto est.: \+15,00%/);
  assert.match(String(api.calls[0].body.text), /No son ganancias del trader/);
  await new TelegramTradeNotifications(store, api, now).tick(settings);
  assert.equal(api.calls.filter(c => c.method === "sendMessage").length, 1);
});

const prospectiveJob = (id = "prospective") => ({
  ...sample(id), evaluationId: 1,
  createdTime: new Date(clock.getTime() - 2000), queuedAt: new Date(clock.getTime() - 1000),
});
const prospectiveRoi = (): NotificationRoi => ({
  ...grossRoi({ roiPct: 15, games: 50, trades: 30 })!,
  evidence: {
    historyAsOf: new Date(clock.getTime() - 60000).toISOString(), gameId: "game", gameIdentity: "milestone",
    feeModel: feeModel(null, clock), feeAssumptions: SIGNAL_FEE_ASSUMPTIONS,
    feeType: null, feeMultiplier: null, entryFeeUsd: null,
  },
});

test("a new signal is frozen BEFORE sending; restarts/retries cannot replace its ROI, basis, price, side, amount or names", async () => {
  const { store, api, worker, advance, now } = setup();
  store.add(prospectiveJob());
  api.roiResult = prospectiveRoi();
  api.failSend = "Temporary Telegram failure";
  await worker.tick(settings);
  const row = store.row(settings.chatId, "prospective");
  assert.ok(row.evidence, "Evidence is durable even though delivery failed");
  assert.equal(row.sentAt, undefined);
  const frozen = JSON.stringify(row.evidence);
  Object.assign(row, { price: .2, outcomeSide: "no", notional: 10, eventTitle: "Corrected later" });
  api.roiResult = null;
  api.failRoi = true; api.failContext = true;
  advance(15000);
  await new TelegramTradeNotifications(store, api, now).tick({ ...settings, notificationRoiBasis: "net" });
  assert.ok(row.sentAt);
  assert.equal(JSON.stringify(row.evidence), frozen);
  assert.equal(api.roiTrades.length, 1, "Never recompute the original rule evidence on retry");
  const requests = api.calls.filter(call => call.method === "sendMessage");
  assert.equal(requests.length, 2);
  assert.equal(requests[0].body.text, requests[1].body.text);
  assert.match(String(requests[1].body.text), /ROI histórico bruto:/);
  assert.match(String(requests[1].body.text), /60¢/);
  await new TelegramTradeNotifications(store, api, now).tick(settings);
  assert.equal(api.calls.filter(call => call.method === "sendMessage").length, 2);
});

test("frozen retries below the new cutoff are skipped without rewriting their original evidence", async () => {
  const { store, api, worker, advance } = setup();
  store.add(prospectiveJob("old-rule"));
  api.roiResult = prospectiveRoi();
  api.failSend = "Temporary failure";
  await worker.tick(settings);
  const row = store.row(settings.chatId, "old-rule");
  assert.ok(row.evidence);
  row.evidence = {
    ...row.evidence,
    rule: { ...row.evidence.rule, minimumRoiPct: 7, version: "previous-rule" },
    historicalRoiPct: 14.999999,
    historicalGrossRoiPct: 14.999999,
  };
  const original = JSON.stringify(row.evidence);
  advance(15000);
  api.failRoi = true;
  await worker.tick(settings);
  assert.ok(row.skippedAt);
  assert.equal(row.sentAt, undefined);
  assert.equal(JSON.stringify(row.evidence), original);
  assert.equal(api.calls.filter(call => call.method === "sendMessage").length, 1);
  assert.equal(api.roiTrades.length, 1);
});

test("failed evidence persistence prevents sending and preserves the outbox retry", async () => {
  const { store, api, worker, advance } = setup();
  store.add(prospectiveJob());
  api.roiResult = prospectiveRoi(); store.failCapture = true;
  await worker.tick(settings);
  const row = store.row(settings.chatId, "prospective");
  assert.equal(row.evidence, undefined);
  assert.equal(row.skippedAt, undefined);
  assert.equal(api.calls.length, 0);
  assert.equal(row.attempts, 1);
  store.failCapture = false; advance(15000);
  await worker.tick(settings);
  assert.ok(row.evidence);
  assert.ok(row.sentAt);
  assert.equal(api.calls.filter(call => call.method === "sendMessage").length, 1);
});

test("legacy notifications still retry without being converted to new signals; rejected new candidates remain rejected", async () => {
  const { store, api, worker, advance } = setup();
  store.add(sample("legacy"));
  api.roiResult = prospectiveRoi(); api.failSend = "Retry legacy";
  await worker.tick(settings);
  advance(15000); await worker.tick(settings);
  assert.equal(store.row(settings.chatId, "legacy").evidence, undefined);
  assert.ok(store.row(settings.chatId, "legacy").sentAt);
  store.add(prospectiveJob("rejected")); api.roiResult = null;
  await worker.tick(settings);
  api.roiResult = prospectiveRoi();
  await worker.tick(settings);
  assert.equal(store.row(settings.chatId, "rejected").evidence, undefined);
  assert.ok(store.row(settings.chatId, "rejected").skippedAt);
});
