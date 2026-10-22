import assert from "node:assert/strict";
import { test } from "node:test";
import {
  TelegramDashboard, type DashboardApi, type DashboardState,
  type DashboardStore, type DashboardTrade,
} from "./telegram-dashboard";
import {
  buildCatalog, HOME, menuSvg, menuView, navigate, type MarketSummary,
} from "./telegram-dashboard-view";
import { inTradeRange, shouldCaptureTrade, tradeRange, type TradeRange } from "./kalshi-trade-bands";
import { marketCardSvg } from "./telegram-market-card";

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
  assert.match(String(api.photos().at(-1)?.body.media), /Chicago to win/);
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
  assert.equal(markets.title, "New England vs Chicago");
  assert.ok(markets.items.some(m => m.label === "Chicago to win by more than 2.5 points"));
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
  assert.ok(first.keyboard.inline_keyboard.flat().some(b => b.text === "Next"));
  const last = menuView({ ...selection, page: 99 }, catalog, true, 10000);
  assert.equal(last.page, 1);
  assert.equal(last.items.length, 2);
  assert.ok(last.keyboard.inline_keyboard.flat().some(b => b.text === "Previous"));
});

test("an empty catalog still has one dashboard with clear waiting status", async () => {
  const { store, api, dashboard } = setup();
  store.rows = [];
  await dashboard.sync(settings);
  assert.equal(api.photos().length, 1);
  assert.equal((await store.state(settings.chatId))?.screen, "sports");
  assert.match(menuSvg(menuView(HOME, [], true, 10000)), /Waiting for a qualifying sports trade/);
});

test("the new section has strict $5k/$10k boundaries and never overlaps the existing section", () => {
  const medium = tradeRange("medium");
  const large = tradeRange("large");
  for (const amount of [0, 4999.99, 5000, 5000.01, 7500, 9999.99, 10000, 10000.01, 50000]) {
    assert.equal(inTradeRange(amount, medium), amount > 5000 && amount < 10000);
    assert.equal(inTradeRange(amount, large), amount >= 10000);
    assert.equal(shouldCaptureTrade(amount), amount > 5000);
    assert.ok(!(inTradeRange(amount, medium) && inTradeRange(amount, large)));
  }
  assert.equal(inTradeRange(Number.NaN, medium), false);
  assert.equal(inTradeRange(Number.POSITIVE_INFINITY, large), false);
  assert.equal(tradeRange("large", 15000).minimum, 15000);
  assert.equal(tradeRange("large", 2000).minimum, 10000);
  assert.deepEqual(tradeRange("medium", 15000), medium);
  const card = marketCardSvg([{ ...trade(summary()), notional: 7500 }], 5000, undefined, "medium");
  assert.match(card, /LATEST \$5k–\$10k TRADE/);
  assert.doesNotMatch(card, /LATEST LARGE TRADE/);
});

test("switching sections filters a shared market's graph, preserves the message, and persists after restart", async () => {
  const { store, api, dashboard } = setup();
  const original = store.tradesByTicker.get(moneyline)![0];
  store.tradesByTicker.set(moneyline, [original, ...[5000, 5000.01, 7500, 9999.99, 10000].map((notional, index) => ({
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
  assert.ok(String(api.photos().at(-1)?.body.media).includes("Section: &gt;$5,000 and &lt;$10,000 only."));
  assert.ok(api.photos().every(call => call.method === "editMessageMedia" && call.body.message_id === "400"));
  const restarted = new TelegramDashboard(store, api);
  await restarted.sync(settings);
  assert.equal((await store.state(settings.chatId))?.band, "medium");
  assert.equal((await store.state(settings.chatId))?.screen, "chart");
  await press(restarted, "d:home");
  assert.equal((await store.state(settings.chatId))?.band, "medium");
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
