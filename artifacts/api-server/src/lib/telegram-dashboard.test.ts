import assert from "node:assert/strict";
import { test } from "node:test";
import sharp from "sharp";
import {
  TelegramDashboard, type DashboardApi, type DashboardState,
  type DashboardStore, type DashboardTrade,
} from "./telegram-dashboard";
import {
  buildCatalog, HOME, menuSvg, menuView as renderMenuView, navigate as navigateAt,
  normalizeSelection, type MarketSummary,
} from "./telegram-dashboard-view";
import { inTradeRange, shouldCaptureTrade, tradeRange, type TradeRange } from "./kalshi-trade-bands";
import { marketCardSvg } from "./telegram-market-card";
import { bucketHistory, RECENT_WINDOW_MS } from "./telegram-history-plot";
import { MarketHistory, type HistoryJob, type HistoryRepository } from "./kalshi-market-history";
import { decodeScopeScreen, encodeScopeScreen } from "./telegram-game-scope";
const menuView: typeof renderMenuView = (s, c, e, t, now = new Date("2026-10-22T18:01:00Z")) => renderMenuView(s, c, e, t, now);
const navigate: typeof navigateAt = (s, a, c, now = new Date("2026-10-22T18:01:00Z")) => navigateAt(s, a, c, now);

const settings = { chatId: "test-chat", minimumNotional: 10000, enabled: true };
const moneyline = "KXNFLGAME-26OCT22NECHI-CHI";
const spread = "KXNFLSPREAD-26OCT22NECHI-CHI3";
const summary = (ticker = moneyline): MarketSummary => ({
  ticker, sport: "Football", eventTitle: ticker === spread ? "New England vs Chicago: Spread" : "New England vs Chicago",
  marketTitle: ticker === spread ? "Chicago wins by over 2.5 points?" : "Chicago wins",
  marketUrl: "https://kalshi.com/markets/kxnflgame/example",
  trades: 1, lastTradeAt: "2026-10-22T17:34:39.345Z",
});
const trade = (row: MarketSummary): DashboardTrade => ({
  eventTitle: row.eventTitle, marketTitle: row.marketTitle, marketUrl: row.marketUrl,
  outcomeSide: "yes", price: 0.6, count: 55140, notional: 33084,
  createdTime: new Date(row.lastTradeAt),
});

class MemoryStore implements DashboardStore {
  saved = new Map<string, DashboardState>();
  rows: MarketSummary[] = [summary(), summary(spread)];
  tradesByTicker = new Map(this.rows.map(row => [row.ticker, [trade(row)]]));
  cards = [{ ticker: "newest", messageId: 400 }, { ticker: "older", messageId: 300 }, { ticker: "oldest", messageId: 200 }];
  retired = new Set<string>();
  published: string[][] = [];
  graphRows: DashboardTrade[][] = [];
  async state(chatId: string) { const row = this.saved.get(chatId); return row ? { ...row } : undefined; }
  async save(state: DashboardState) { this.saved.set(state.chatId, { ...state }); }
  async markets(range: TradeRange) {
    return this.rows.flatMap(row => {
      const trades = (this.tradesByTicker.get(row.ticker) ?? []).filter(t => inTradeRange(t.notional, range));
      if (!trades.length) return [];
      return [{ ...row, trades: trades.length, lastTradeAt: new Date(Math.max(...trades.map(t => t.createdTime.getTime()))).toISOString() }];
    });
  }
  async trades(ticker: string, range: TradeRange) {
    const rows = (this.tradesByTicker.get(ticker) ?? []).filter(row => inTradeRange(row.notional, range));
    this.graphRows.push(rows);
    return rows;
  }
  async context(ticker: string, context: { eventTitle: string; marketTitle: string }) {
    this.rows = this.rows.map(row => row.ticker === ticker ? { ...row, ...context } : row);
  }
  async oldCards() { return this.cards.filter(card => !this.retired.has(card.ticker)); }
  async retire(ticker: string) { this.retired.add(ticker); }
  async publishedThrough(_cutoff: Date, tickers: string[]) { this.published.push(tickers); }
}
class FakeApi implements DashboardApi {
  calls: { method: string; body: Record<string, unknown> }[] = [];
  nextId = 900;
  failEdit: string | null = null;
  failDelete = false;
  clock = new Date("2026-10-22T18:01:00Z");
  contextCalls = 0;
  now() { return this.clock; }
  constructor(private store: MemoryStore) {}
  async request<T>(method: string, body: Record<string, unknown> = {}) {
    this.calls.push({ method, body });
    if (method === "deleteMessage" && this.failDelete) throw new Error("Message can't be deleted");
    return { result: true as T };
  }
  async photo<T>(method: "sendPhoto" | "editMessageMedia", body: Record<string, string>, png: Buffer) {
    assert.ok(png.length > 1000, "Real PNG must be rendered");
    this.calls.push({ method, body });
    await new Promise(resolve => setTimeout(resolve, 2));
    if (method === "editMessageMedia" && this.failEdit) {
      const error = this.failEdit; this.failEdit = null; throw new Error(error);
    }
    return { result: { message_id: ++this.nextId } as T };
  }
  async context(ticker: string) {
    this.contextCalls++;
    const row = this.store.rows.find(row => row.ticker === ticker)!;
    return { eventTitle: row.eventTitle!, marketTitle: row.marketTitle! };
  }
  photos() { return this.calls.filter(call => ["sendPhoto", "editMessageMedia"].includes(call.method)); }
}
function setup() {
  const store = new MemoryStore();
  const api = new FakeApi(store);
  return { store, api, dashboard: new TelegramDashboard(store, api) };
}
async function press(dashboard: TelegramDashboard, data: string, messageId = 400, chatId = settings.chatId) {
  await dashboard.callback({ id: `query-${data}`, data, message: { message_id: messageId, chat: { id: chatId } } }, settings);
}
async function openChart(dashboard: TelegramDashboard, store: MemoryStore, ticker = moneyline) {
  const market = buildCatalog(store.rows).find(row => row.ticker === ticker)!;
  await press(dashboard, `d:sport:${market.sportKey}`);
  await press(dashboard, `d:game:${market.gameKey}`);
  await press(dashboard, `d:market:${market.id}`);
}

test("migration reuses the newest card and deletes only registered older graph messages", async () => {
  const { store, api, dashboard } = setup();
  const initialTradeCount = [...store.tradesByTicker.values()].flat().length;
  await dashboard.sync(settings);
  assert.equal(api.calls.filter(c => c.method === "sendPhoto").length, 0);
  assert.deepEqual(api.calls.filter(c => c.method === "deleteMessage").map(c => c.body.message_id), [300, 200]);
  assert.equal((await store.state(settings.chatId))?.messageId, 400);
  assert.equal((await store.state(settings.chatId))?.cleanupComplete, true);
  assert.equal((await store.state(settings.chatId))?.cleanupWarning, null);
  assert.equal([...store.tradesByTicker.values()].flat().length, initialTradeCount);
  assert.equal(store.retired.size, 3);
});

test("Sport → Game → Market, new trades, and back navigation all edit the same message", async () => {
  const { store, api, dashboard } = setup();
  await dashboard.sync(settings);
  await openChart(dashboard, store);
  assert.equal((await store.state(settings.chatId))?.screen, "chart");
  const rows = store.tradesByTicker.get(moneyline)!;
  rows.push({ ...rows[0], notional: 45000, count: 75000, createdTime: new Date("2026-10-22T18:00:00Z") });
  const before = api.photos().length;
  await dashboard.sync(settings);
  assert.equal(api.photos().length, before + 1);
  assert.ok(api.photos().every(call => call.method === "editMessageMedia" && call.body.message_id === "400"));
  assert.match(String(api.photos().at(-1)?.body.media), /Chicago gana/);
  assert.doesNotMatch(String(api.photos().at(-1)?.body.media), /KXNFLGAME/);
  await press(dashboard, "d:back");
  assert.equal((await store.state(settings.chatId))?.screen, "markets");
  await press(dashboard, "d:back");
  assert.equal((await store.state(settings.chatId))?.screen, "games");
  await press(dashboard, "d:home");
  assert.equal((await store.state(settings.chatId))?.screen, "sports");
});

test("new unrelated markets do not post new graph messages or replace the selected chart", async () => {
  const { store, api, dashboard } = setup();
  await dashboard.sync(settings);
  await openChart(dashboard, store);
  const before = api.photos().length;
  const newMarket = { ...summary("KXNBAGAME-26OCT22OTHER-TEAM"), sport: "Basketball", eventTitle: "Boston vs Miami" };
  store.rows.push(newMarket);
  store.tradesByTicker.set(newMarket.ticker, [trade(newMarket)]);
  await dashboard.sync(settings);
  assert.equal(api.photos().length, before);
  assert.equal((await store.state(settings.chatId))?.ticker, moneyline);
  assert.equal(store.published.at(-1)?.length, 3);
});

test("unchanged polling and a process restart reuse persisted navigation without extra edits", async () => {
  const { store, api, dashboard } = setup();
  await dashboard.sync(settings);
  await openChart(dashboard, store);
  const before = api.photos().length;
  await Promise.all(Array.from({ length: 8 }, () => dashboard.sync(settings)));
  const restarted = new TelegramDashboard(store, api);
  await restarted.sync(settings);
  assert.equal(api.photos().length, before);
  assert.equal((await store.state(settings.chatId))?.messageId, 400);
  assert.equal((await store.state(settings.chatId))?.screen, "chart");
});

test("concurrent first opens with no old cards create exactly one dashboard", async () => {
  const { store, api, dashboard } = setup();
  store.cards = [];
  await Promise.all(Array.from({ length: 8 }, () => dashboard.sync(settings)));
  assert.equal(api.calls.filter(c => c.method === "sendPhoto").length, 1);
  assert.equal(api.calls.find(call => call.method === "sendPhoto")?.body.disable_notification, "true");
  assert.equal(api.photos().length, 1);
});

test("an upload failure never creates a duplicate; only a confirmed missing message can be replaced", async () => {
  const { store, api, dashboard } = setup();
  await dashboard.sync(settings);
  api.failEdit = "Telegram upload timed out";
  const market = buildCatalog(store.rows)[0];
  await assert.rejects(press(dashboard, `d:sport:${market.sportKey}`), /timed out/);
  assert.equal(api.calls.filter(c => c.method === "sendPhoto").length, 0);
  assert.equal((await store.state(settings.chatId))?.screen, "sports");
  api.failEdit = "Bad Request: message to edit not found";
  await press(dashboard, `d:sport:${market.sportKey}`);
  assert.equal(api.calls.filter(c => c.method === "sendPhoto").length, 1);
  assert.notEqual((await store.state(settings.chatId))?.messageId, 400);
});

test("old-card and foreign-chat callbacks cannot change the live dashboard", async () => {
  const { api, dashboard } = setup();
  await dashboard.sync(settings);
  const before = api.photos().length;
  await press(dashboard, "d:home", 300);
  await press(dashboard, "d:home", 400, "other-chat");
  assert.equal(api.photos().length, before);
  const acknowledgements = api.calls.filter(c => c.method === "answerCallbackQuery");
  assert.equal(acknowledgements.length, 2);
  assert.ok(acknowledgements.every(c => String(c.body.text).includes("inactive")));
});

test("a cleanup permission failure is recorded without losing trade history or retrying endlessly", async () => {
  const { store, api, dashboard } = setup();
  api.failDelete = true;
  await dashboard.sync(settings);
  assert.match((await store.state(settings.chatId))?.cleanupWarning ?? "", /2 older cards/);
  const before = api.calls.filter(c => c.method === "deleteMessage").length;
  await dashboard.sync(settings);
  assert.equal(api.calls.filter(c => c.method === "deleteMessage").length, before);
  assert.equal(store.tradesByTicker.get(moneyline)?.length, 1);
});

test("game menu includes New York kickoff before matchup names and shares a sibling's schedule", () => {
  const catalog = buildCatalog([summary(), { ...summary(spread), gameStartsAt: "2026-10-22T23:30:00Z" }]);
  const selection = navigate(HOME, `d:sport:${catalog[0].sportKey}`, catalog);
  const view = menuView(selection, catalog, true, 10000);
  assert.equal(view.items.length, 1);
  assert.equal(view.items[0].label, "22 oct 2026 · 7:30 PM ET · New England vs Chicago");
  assert.match(view.keyboard.inline_keyboard.flat().find(b => b.callback_data?.startsWith("d:game:"))!.text, /7:30 PM ET/);
  assert.match(menuSvg(view), /7:30 PM ET/);
});

test("game menu never invents kickoff times from ticker dates or invalid schedules", () => {
  const catalog = buildCatalog([{ ...summary(), gameStartsAt: "invalid" }]);
  const view = menuView(navigate(HOME, `d:sport:${catalog[0].sportKey}`, catalog), catalog, true, 10000);
  assert.match(view.items[0].label, /22 oct 2026 · Hora por confirmar/);
});

test("game grouping combines Kalshi's separate moneyline, spread, and total events", () => {
  const rows = [summary(), summary(spread), {
    ...summary("KXNFLTOTAL-26OCT22NECHI-47"), eventTitle: "New England vs Chicago: Total Points",
    marketTitle: "Over 47 points",
  }];
  const catalog = buildCatalog(rows);
  assert.equal(catalog[0].gameKey, catalog[1].gameKey);
  assert.equal(catalog[1].gameKey, catalog[2].gameKey);
  const sportSelection = navigate(HOME, `d:sport:${catalog[0].sportKey}`, catalog);
  const games = menuView(sportSelection, catalog, true, 10000);
  assert.equal(games.items.length, 1);
  const markets = menuView(navigate(sportSelection, `d:game:${catalog[0].gameKey}`, catalog), catalog, true, 10000);
  assert.equal(markets.items.length, 3);
  assert.equal(markets.title, "Vigentes · 22 oct 2026 · New England vs Chicago");
  assert.ok(markets.items.some(m => m.label === "Chicago gana por más de 2.5 puntos"));
  assert.ok(markets.keyboard.inline_keyboard.flat().every(button =>
    !button.callback_data || Buffer.byteLength(button.callback_data) <= 64));
  assert.doesNotMatch(menuSvg(markets), /KXNFL/);
});

test("menus paginate and clamp out-of-range pages without hiding navigation", () => {
  const catalog = buildCatalog(Array.from({ length: 8 }, (_, i) => ({
    ...summary(`KXNFLGAME-26OCT22GAME${i}-CHI`), eventTitle: `Game number ${i}`,
  })));
  const selection = navigate(HOME, `d:sport:${catalog[0].sportKey}`, catalog);
  const first = menuView(selection, catalog, true, 10000);
  assert.equal(first.items.length, 6);
  assert.equal(first.pages, 2);
  assert.ok(first.keyboard.inline_keyboard.flat().some(b => b.text === "Siguiente"));
  const last = menuView({ ...selection, page: 99 }, catalog, true, 10000);
  assert.equal(last.page, 1);
  assert.equal(last.items.length, 2);
  assert.ok(last.keyboard.inline_keyboard.flat().some(b => b.text === "Anterior"));
});

test("an empty catalog still has one dashboard with clear waiting status", async () => {
  const { store, api, dashboard } = setup();
  store.rows = [];
  await dashboard.sync(settings);
  assert.equal(api.photos().length, 1);
  assert.equal((await store.state(settings.chatId))?.screen, "sports");
  assert.match(menuSvg(menuView(HOME, [], true, 10000)), /Sin partidos en juego o programados/);
});

test("the new section has strict $5k/$10k boundaries and never overlaps the existing section", () => {
  const medium = tradeRange("medium");
  const large = tradeRange("large");
  const small = tradeRange("small");
  for (const amount of [0, 999.99, 1000, 1000.01, 4999.99, 5000, 5000.01, 7500, 9999.99, 10000, 10000.01, 50000]) {
    assert.equal(inTradeRange(amount, small), amount >= 1000 && amount <= 5000);
    assert.equal(inTradeRange(amount, medium), amount > 5000 && amount < 10000);
    assert.equal(inTradeRange(amount, large), amount >= 10000);
    assert.equal(shouldCaptureTrade(amount), amount >= 1000);
    assert.ok(!(inTradeRange(amount, medium) && inTradeRange(amount, large)));
    assert.ok([small, medium, large].filter(range => inTradeRange(amount, range)).length <= 1);
  }
  assert.equal(inTradeRange(Number.NaN, medium), false);
  assert.equal(inTradeRange(Number.POSITIVE_INFINITY, large), false);
  assert.equal(tradeRange("large", 15000).minimum, 15000);
  assert.equal(tradeRange("large", 2000).minimum, 10000);
  assert.deepEqual(tradeRange("medium", 15000), medium);
  const card = marketCardSvg([{ ...trade(summary()), notional: 7500 }], 5000, undefined, "medium");
  assert.match(card, /Operaciones &gt; \$5,000 y &lt; \$10,000/);
  assert.doesNotMatch(card, /Operaciones ≥/);
});

test("switching sections filters a shared market's graph, preserves the message, and persists after restart", async () => {
  const { store, api, dashboard } = setup();
  const original = store.tradesByTicker.get(moneyline)![0];
  store.tradesByTicker.set(moneyline, [original, ...[999.99, 1000, 2500, 5000, 5000.01, 7500, 9999.99, 10000].map((notional, index) => ({
    ...original, notional, createdTime: new Date(original.createdTime.getTime() + index + 1),
  }))]);
  await dashboard.sync(settings);
  await openChart(dashboard, store);
  assert.deepEqual(store.graphRows.at(-1)?.map(row => row.notional), [33084, 10000]);
  await press(dashboard, "d:band:medium");
  assert.equal((await store.state(settings.chatId))?.band, "medium");
  assert.equal((await store.state(settings.chatId))?.screen, "sports");
  await openChart(dashboard, store);
  assert.deepEqual(store.graphRows.at(-1)?.map(row => row.notional), [5000.01, 7500, 9999.99]);
  assert.ok(String(api.photos().at(-1)?.body.media).includes("Rango: &gt; $5,000 y &lt; $10,000."));
  assert.ok(api.photos().every(call => call.method === "editMessageMedia" && call.body.message_id === "400"));
  const restarted = new TelegramDashboard(store, api);
  await restarted.sync(settings);
  assert.equal((await store.state(settings.chatId))?.band, "medium");
  assert.equal((await store.state(settings.chatId))?.screen, "chart");
  await press(restarted, "d:home");
  assert.equal((await store.state(settings.chatId))?.band, "medium");
  await press(restarted, "d:band:small");
  await openChart(restarted, store);
  assert.deepEqual(store.graphRows.at(-1)?.map(row => row.notional), [1000, 2500, 5000]);
  assert.match(String(api.photos().at(-1)?.body.media), /Rango: ≥ \$1,000 y ≤ \$5,000/);
  const again = new TelegramDashboard(store, api);
  await again.sync(settings);
  assert.equal((await store.state(settings.chatId))?.band, "small");
  assert.equal((await store.state(settings.chatId))?.screen, "chart");
  await press(again, "d:back");
  assert.equal((await store.state(settings.chatId))?.band, "small");
  await press(restarted, "d:band:large");
  assert.equal((await store.state(settings.chatId))?.band, "large");
  assert.equal(api.calls.filter(call => call.method === "sendPhoto").length, 0);
});

test("new medium-size trades cannot change the existing large-trade graph", async () => {
  const { store, api, dashboard } = setup();
  await dashboard.sync(settings);
  await openChart(dashboard, store);
  const before = api.photos().length;
  const rows = store.tradesByTicker.get(moneyline)!;
  rows.push({ ...rows[0], notional: 7200, createdTime: new Date("2026-10-22T19:00:00Z") });
  await dashboard.sync(settings);
  assert.equal(api.photos().length, before);
  assert.deepEqual(store.graphRows.at(-1)?.map(row => row.notional), [33084]);
  await press(dashboard, "d:band:medium");
  await openChart(dashboard, store);
  assert.deepEqual(store.graphRows.at(-1)?.map(row => row.notional), [7200]);
});

test("the history plot uses every trade, not just the latest six, with exact totals", () => {
  const now = new Date("2026-10-22T18:00:00Z");
  const rows = Array.from({ length: 120 }, (_, index) => ({
    ...trade(summary()), notional: 10000 + index,
    createdTime: new Date(now.getTime() - index * 60_000),
    outcomeSide: index % 2 ? "no" : "yes",
  }));
  const history = bucketHistory(rows, now);
  assert.equal(history.buckets.reduce((sum, bucket) => sum + bucket.count, 0), 120);
  assert.equal(history.total, rows.reduce((sum, row) => sum + row.notional, 0));
  assert.ok(history.buckets.length <= 38);
  assert.equal(history.recentCount, 16);
  assert.equal(history.buckets.reduce((sum, bucket) => sum + bucket.total, 0), history.total);
  assert.match(marketCardSvg(rows, 10000, undefined, "large", now), /120 operaciones/);
  assert.doesNotMatch(marketCardSvg(rows, 10000, undefined, "large", now), /Last 6 of/);
});

test("recency uses execution time, including the exact 15-minute boundary, never import time", () => {
  const now = new Date("2026-10-22T18:00:00Z");
  const rows = [RECENT_WINDOW_MS + 1, RECENT_WINDOW_MS, 60_000, 0].map(age => ({
    ...trade(summary()), createdTime: new Date(now.getTime() - age),
  }));
  const history = bucketHistory(rows, now);
  assert.equal(history.recentCount, 3);
  assert.equal(history.buckets.reduce((sum, bucket) => sum + bucket.values.slice(3).reduce((a, b) => a + b, 0), 0), 33084 * 3);
  const later = bucketHistory(rows, new Date(now.getTime() + RECENT_WINDOW_MS + 1));
  assert.equal(later.recentCount, 0);
  assert.equal(later.total, history.total);
  assert.equal(later.buckets.length, history.buckets.length, "Quiet time must not compress the historical activity");
});

class HistoryMemory implements HistoryRepository<string> {
  jobs = new Map<string, HistoryJob>();
  rows = new Set<string>();
  tickers = [moneyline, spread];
  async candidates() { return this.tickers.map(ticker => ({ ticker, job: this.jobs.get(ticker) })); }
  async job(ticker: string) { return this.jobs.get(ticker); }
  async commit(job: HistoryJob, rows: string[]) {
    rows.forEach(row => this.rows.add(row));
    this.jobs.set(job.ticker, { ...job });
  }
}

test("backfill pages through both public sources, deduplicates overlaps, and resumes the frozen snapshot after restart", async () => {
  const repo = new HistoryMemory();
  repo.tickers = [moneyline];
  const clock = new Date("2026-10-22T18:00:00Z");
  const calls: HistoryJob[] = [];
  const source = async (job: HistoryJob) => {
    calls.push({ ...job });
    return job.phase === "archive" ? { rows: ["old", "shared"], scanned: 2, cursor: null } :
      job.cursor ? { rows: ["second", "shared"], scanned: 2, cursor: null } :
      { rows: ["first", "shared"], scanned: 1000, cursor: "page2" };
  };
  const importer = new MarketHistory(repo, source, () => clock);
  await importer.tick();
  assert.equal(repo.jobs.get(moneyline)?.cursor, "page2");
  const restarted = new MarketHistory(repo, source, () => clock);
  await restarted.tick();
  assert.equal(repo.jobs.get(moneyline)?.phase, "archive");
  await restarted.tick();
  assert.equal(repo.jobs.get(moneyline)?.phase, "complete");
  assert.deepEqual([...repo.rows].sort(), ["first", "old", "second", "shared"]);
  assert.equal(repo.jobs.get(moneyline)?.scanned, 1004);
  assert.ok(calls.every(job => job.snapshotAt.getTime() === clock.getTime()));
  await restarted.tick();
  assert.equal(calls.length, 3);
});

test("failed historical pages retain the cursor and retry only after backoff, without claiming completeness", async () => {
  const repo = new HistoryMemory();
  repo.tickers = [moneyline];
  let clock = new Date("2026-10-22T18:00:00Z");
  let fail = true;
  let attempts = 0;
  const importer = new MarketHistory(repo, async () => {
    attempts += 1;
    if (fail) throw new Error("HTTP 429");
    return { rows: ["saved"], scanned: 1, cursor: "next" };
  }, () => clock);
  await importer.tick();
  assert.equal((await importer.status(moneyline)).error, true);
  assert.equal(repo.jobs.get(moneyline)?.cursor, null);
  assert.equal(repo.jobs.get(moneyline)?.scanned, 0);
  await importer.tick();
  assert.equal(attempts, 1);
  fail = false;
  clock = new Date(clock.getTime() + 60_000);
  await importer.tick();
  assert.equal(attempts, 2);
  assert.equal(repo.jobs.get(moneyline)?.cursor, "next");
  assert.equal((await importer.status(moneyline)).error, false);
});

test("lower capture floor reimports old history once and resumes its new cursor without duplicates", async () => {
  const repo = new HistoryMemory();
  repo.tickers = [moneyline];
  const now = new Date("2026-10-22T18:00:00Z");
  repo.rows.add("saved-large-trade");
  repo.jobs.set(moneyline, {
    ticker: moneyline, phase: "complete", cursor: null, snapshotAt: now,
    sinceAt: now, scanned: 100, captureMinimum: 5000, error: null, updatedAt: now,
  });
  const calls: HistoryJob[] = [];
  const source = async (job: HistoryJob) => {
    calls.push({ ...job });
    return { rows: ["saved-large-trade", "small-trade"],
      scanned: 2, cursor: calls.length === 1 ? "expanded-page-2" : null };
  };
  const importer = new MarketHistory(repo, source, () => now);
  assert.equal((await importer.status(moneyline)).phase, "pending");
  await importer.tick();
  assert.equal(calls[0].sinceAt, null, "old incremental boundary cannot hide smaller historical trades");
  assert.equal(calls[0].cursor, null);
  assert.equal(calls[0].captureMinimum, 1000);
  const restarted = new MarketHistory(repo, source, () => now);
  await restarted.tick();
  assert.equal(calls[1].cursor, "expanded-page-2", "restart must not reset the expanded import");
  await restarted.tick();
  assert.equal(repo.jobs.get(moneyline)?.phase, "complete");
  assert.equal(repo.rows.size, 2);
  await restarted.tick();
  assert.equal(calls.length, 3, "complete coverage must not reimport repeatedly");
});

test("the selected market gets backfill priority, without concurrent workers", async () => {
  const repo = new HistoryMemory();
  const calls: string[] = [];
  const importer = new MarketHistory(repo, async job => {
    calls.push(job.ticker);
    await new Promise(resolve => setTimeout(resolve, 5));
    return { rows: [], scanned: 0, cursor: null };
  });
  await importer.status(spread);
  await Promise.all([importer.tick(), importer.tick(), importer.tick()]);
  assert.deepEqual(calls, [spread]);
});

test("completed history reconciles downtime using an overlapping incremental time window", async () => {
  const repo = new HistoryMemory();
  repo.tickers = [moneyline];
  const old = new Date("2026-10-22T17:00:00Z");
  repo.jobs.set(moneyline, { ticker: moneyline, phase: "complete", cursor: null,
    snapshotAt: old, sinceAt: null, scanned: 1000, captureMinimum: 1000, auditVersion: 1, error: null, updatedAt: old });
  const now = new Date("2026-10-22T18:00:00Z");
  let requested: HistoryJob | undefined;
  const importer = new MarketHistory(repo, async job => {
    requested = job;
    return { rows: ["missed"], scanned: 1, cursor: null };
  }, () => now);
  assert.equal((await importer.status(moneyline)).phase, "pending");
  await importer.tick();
  assert.equal(requested?.sinceAt?.getTime(), old.getTime());
  assert.equal(requested?.snapshotAt.getTime(), now.getTime());
  assert.equal(requested?.phase, "live");
  assert.ok(repo.rows.has("missed"));
});

test("loading and incomplete-history status edits the existing dashboard rather than posting alerts", async () => {
  const { store, api, dashboard } = setup();
  let error = false;
  const withHistory = api as FakeApi & { history: () => Promise<{ phase: "live"; scanned: number; error: boolean }> };
  withHistory.history = async () => ({ phase: "live", scanned: 2000, error });
  await dashboard.sync(settings);
  await openChart(dashboard, store);
  assert.match(String(api.photos().at(-1)?.body.media), /Cargando histórico/);
  assert.match(String(api.photos().at(-1)?.body.media), /gráfica aún es parcial/);
  error = true;
  await dashboard.sync(settings);
  assert.match(String(api.photos().at(-1)?.body.media), /Historial incompleto/);
  assert.ok(api.photos().every(call => call.method === "editMessageMedia"));
  assert.equal((await store.state(settings.chatId))?.messageId, 400);
});

test("officially settled markets get one full final audit, survive restart, then never poll again", async () => {
  const repo = new HistoryMemory();
  repo.tickers = [moneyline];
  let now = new Date("2026-10-30T12:00:00Z");
  const closedAt = now;
  repo.jobs.set(moneyline, { ticker: moneyline, phase: "complete", cursor: null,
    snapshotAt: new Date(now.getTime() - 3600_000), sinceAt: new Date(now.getTime() - 7200_000),
    scanned: 100, captureMinimum: 1000, auditVersion: 1, error: null, updatedAt: now });
  repo.candidates = async () => [{ ticker: moneyline, job: repo.jobs.get(moneyline), closed: true, closedAt }];
  const calls: HistoryJob[] = [];
  const source = async (job: HistoryJob) => {
    calls.push({ ...job });
    return { rows: ["overlap"], scanned: 1, cursor: null };
  };
  await new MarketHistory(repo, source, () => now).tick();
  assert.equal(calls[0].sinceAt, null, "a final audit must not reuse an incremental lower boundary");
  assert.equal(calls[0].finalPass, true);
  assert.equal(repo.jobs.get(moneyline)?.auditedAt, null);
  now = new Date(now.getTime() + 1000);
  const restarted = new MarketHistory(repo, source, () => now);
  await restarted.tick();
  assert.equal(calls[1].phase, "archive");
  assert.equal(repo.jobs.get(moneyline)?.phase, "complete");
  assert(repo.jobs.get(moneyline)?.auditedAt);
  now = new Date(now.getTime() + 30 * 86400_000);
  const later = new MarketHistory(repo, source, () => now);
  await later.tick();
  assert.equal((await later.status(moneyline)).phase, "complete");
  assert.equal(calls.length, 2, "finished-game history is not a recurring poll");
  assert.equal(repo.rows.size, 1);
});

test("failed final audit cannot claim coverage and resumes the same frozen archive cursor", async () => {
  const repo = new HistoryMemory();
  let now = new Date("2026-10-30T12:00:00Z");
  const closedAt = now;
  repo.candidates = async () => [{ ticker: moneyline, job: repo.jobs.get(moneyline), closed: true, closedAt }];
  let fail = true;
  const calls: HistoryJob[] = [];
  const importer = new MarketHistory(repo, async job => {
    calls.push({ ...job });
    if (job.phase === "archive" && fail) throw new Error("Archive unavailable");
    return { rows: ["saved"], scanned: 1, cursor: null };
  }, () => now);
  await importer.tick();
  await importer.tick();
  assert.equal(repo.jobs.get(moneyline)?.phase, "archive");
  assert.equal(repo.jobs.get(moneyline)?.auditedAt, null);
  await importer.tick();
  assert.equal(calls.length, 2);
  now = new Date(now.getTime() + 60_000);
  fail = false;
  await importer.tick();
  assert.equal(calls[2].snapshotAt.getTime(), closedAt.getTime());
  assert.equal(calls[2].sinceAt, null);
  assert.equal(repo.jobs.get(moneyline)?.phase, "complete");
  assert(repo.jobs.get(moneyline)?.auditedAt);
});

test("legacy or malformed audit flags force a complete refresh rather than certifying an incremental import", async () => {
  for (const version of [0, 1]) {
    const repo = new HistoryMemory();
    const now = new Date("2026-10-30T12:00:00Z");
    repo.jobs.set(moneyline, { ticker: moneyline, phase: "complete", cursor: null,
      snapshotAt: now, sinceAt: now, scanned: 100, captureMinimum: 1000,
      auditVersion: version, finalPass: true, auditedAt: now, error: null, updatedAt: now });
    repo.candidates = async () => [{ ticker: moneyline, job: repo.jobs.get(moneyline), closed: true, closedAt: now }];
    let seen: HistoryJob | undefined;
    const importer = new MarketHistory(repo, async job => { seen = job; return { rows: [], scanned: 0, cursor: null }; }, () => now);
    await importer.tick();
    assert.equal(seen?.sinceAt, null);
    assert.equal(seen?.auditVersion, 1);
    assert.equal(repo.jobs.get(moneyline)?.auditedAt, null);
  }
});

test("phone cards render safely for sparse history, long names, large amounts and both value sections", async () => {
  const now = new Date("2026-10-22T18:00:00Z");
  const cases = [
    { band: "large" as const, amount: 1250000, game: "New England & Chicago <Overtime>", bet: "Chicago wins" },
    { band: "medium" as const, amount: 9999.99, game: "New England vs Chicago: Total Points",
      bet: "New England and Chicago combine for more than 48.5 total points?" },
  ];
  for (const item of cases) {
    const rows = [{ ...trade(summary()), eventTitle: item.game, marketTitle: item.bet,
      notional: item.amount, price: 0.5, count: item.amount * 2,
      createdTime: new Date(now.getTime() - 30 * 24 * 60 * 60_000) }];
    const before = JSON.stringify(rows);
    const svg = marketCardSvg(rows, item.band === "large" ? 10000 : 5000, undefined, item.band, now);
    assert.doesNotMatch(svg, /\b(?:NaN|Infinity|undefined)\b/);
    if (item.game.includes("<")) assert.ok(svg.includes("&lt;Overtime&gt;"));
    const phone = await sharp(Buffer.from(svg)).resize({ width: 390 }).png().toBuffer();
    assert.equal((await sharp(phone).metadata()).width, 390);
    assert.equal(JSON.stringify(rows), before, "Presentation must not mutate the actual trade history");
  }
});

test("calendar rollover archives yesterday without a new trade or new graph message", async () => {
  const { store, api, dashboard } = setup();
  await dashboard.sync(settings);
  const market = buildCatalog(store.rows)[0];
  await press(dashboard, `d:sport:${market.sportKey}`);
  assert.equal((await store.state(settings.chatId))?.screen, "games");
  const beforeRows = JSON.stringify([...store.tradesByTicker]);
  api.clock = new Date("2026-10-23T04:01:00Z");
  await dashboard.sync(settings);
  const keyboard = JSON.parse(String(api.photos().at(-1)?.body.reply_markup));
  assert.ok(!keyboard.inline_keyboard.flat().some((b: { callback_data?: string }) => b.callback_data?.startsWith("d:game:")));
  await press(dashboard, "d:scope:history");
  await openChart(dashboard, store);
  assert.equal((await store.state(settings.chatId))?.scope, "history");
  assert.equal((await store.state(settings.chatId))?.ticker, moneyline);
  assert.equal(api.contextCalls, 0, "Archived charts use saved names, not external requests");
  assert.match(String(api.photos().at(-1)?.body.media), /Archivado por fecha/);
  assert.doesNotMatch(String(api.photos().at(-1)?.body.media), /Terminado\/cerrado/);
  const restarted = new TelegramDashboard(store, api);
  await restarted.sync(settings);
  assert.equal((await store.state(settings.chatId))?.scope, "history");
  await press(restarted, "d:home");
  assert.equal((await store.state(settings.chatId))?.scope, "history");
  await press(restarted, "d:scope:active");
  assert.equal((await store.state(settings.chatId))?.scope, "active");
  assert.ok(api.photos().every(call => call.method === "editMessageMedia" && call.body.message_id === "400"));
  assert.equal(JSON.stringify([...store.tradesByTicker]), beforeRows);
});

test("a selected game finishing moves to historical context without metadata or history probes", async () => {
  const { store, api, dashboard } = setup();
  await dashboard.sync(settings);
  await openChart(dashboard, store);
  const before = api.contextCalls;
  store.rows = store.rows.map(row => ({ ...row, gameState: "finished", gameSource: "live" }));
  await dashboard.sync(settings);
  assert.equal((await store.state(settings.chatId))?.scope, "history");
  assert.equal((await store.state(settings.chatId))?.ticker, moneyline);
  assert.equal(api.contextCalls, before);
  assert.match(String(api.photos().at(-1)?.body.media), /Historial/);
  await press(dashboard, "d:band:medium");
  assert.equal((await store.state(settings.chatId))?.scope, "history");
  assert.equal((await store.state(settings.chatId))?.band, "medium");
  assert.equal((await store.state(settings.chatId))?.messageId, 400);
  await dashboard.sync(settings, true);
  assert.equal((await store.state(settings.chatId))?.scope, "active", "/menu opens the main list");
});

test("stored history navigation is backward compatible without changing the database schema", () => {
  for (const screen of ["sports", "games", "markets", "chart"] as const) {
    assert.deepEqual(decodeScopeScreen(screen), { screen, scope: "active" });
    assert.deepEqual(decodeScopeScreen(encodeScopeScreen(screen, "history")), { screen, scope: "history" });
  }
  assert.equal(decodeScopeScreen("history:invalid").screen, "sports");
});

test("stale archived game callbacks cannot reopen it from Vigentes", () => {
  const catalog = buildCatalog([summary()]);
  const later = new Date("2026-10-23T12:00:00Z");
  const selected = normalizeSelection({ ...HOME, screen: "games", sportKey: catalog[0].sportKey, page: 99 }, catalog, later);
  assert.equal(selected.screen, "sports");
  assert.throws(() => navigate(selected, `d:game:${catalog[0].gameKey}`, catalog, later), /no longer available/);
  const history = navigate(selected, "d:scope:history", catalog, later);
  const historySports = menuView(history, catalog, true, 10000, later);
  assert.match(historySports.items[0].detail, /1 partidos · 1 mercados/);
  const gameMenu = menuView({ ...history, screen: "games", sportKey: catalog[0].sportKey, page: 99 }, catalog, true, 10000, later);
  assert.equal(gameMenu.page, 0);
  assert.equal(gameMenu.items.length, 1);
});
