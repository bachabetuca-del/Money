import assert from "node:assert/strict";
import { test } from "node:test";
import { writeFile } from "node:fs/promises";
import sharp from "sharp";
import { gameCalendarDay, newYorkDay } from "./telegram-game-date";
import { gameScope, scopedCatalog } from "./telegram-game-scope";
import { buildCatalog, HOME, menuSvg, menuView, navigate, type MarketSummary } from "./telegram-dashboard-view";
import { publicDirection } from "./telegram-trade-direction";
import { marketCardCaption, marketCardSvg } from "./telegram-market-card";
import { bucketHistory } from "./telegram-history-plot";
import { notificationText } from "./telegram-trade-notifications";
import { liveNotificationTrades } from "./telegram-trade-notifications";
import { publicTradeExecution } from "./kalshi-trade-execution";
import { inTradeRange, tradeRange } from "./kalshi-trade-bands";

const now = new Date("2026-10-23T10:30:00Z");
function row(day: string, name: string, extra: Partial<MarketSummary> = {}): MarketSummary {
  return {
    ticker: `KXATPMATCH-26OCT${day}${name}-A`, sport: "Tennis", eventTitle: `${name} vs Opponent`,
    marketTitle: `${name} wins`, trades: 1, marketUrl: "https://kalshi.com/markets/test",
    lastTradeAt: "2026-10-23T10:00:00Z", ...extra,
  };
}
const scope = (value: MarketSummary) => gameScope(buildCatalog([value]), now);

test("calendar keys validate dates and preserve New York day around midnight and DST", () => {
  assert.equal(gameCalendarDay("KXGAME-26OCT22A"), "2026-10-22");
  assert.equal(gameCalendarDay("KXGAME-26FEB31A"), null);
  assert.equal(gameCalendarDay("KXGAME-26XYZ22A"), null);
  assert.equal(gameCalendarDay("KXSEASON-27-A"), null);
  assert.equal(gameCalendarDay("KXGAME-26OCT22A", "2026-10-24T01:00:00Z"), "2026-10-23");
  assert.equal(gameCalendarDay("KXGAME-26OCT22A", "bad"), "2026-10-22");
  assert.equal(newYorkDay(new Date("2026-10-23T03:59:59Z")), "2026-10-22");
  assert.equal(newYorkDay(new Date("2026-10-23T04:00:00Z")), "2026-10-23");
  assert.equal(newYorkDay(new Date("2026-11-01T05:59:59Z")), "2026-11-01");
  assert.equal(newYorkDay(new Date("2026-11-01T06:00:00Z")), "2026-11-01");
});

test("yesterday is archived without inventing a final, while fresh overnight games remain active", () => {
  assert.equal(scope(row("22", "Unknown")), "history");
  assert.equal(scope(row("22", "Unstarted", { gameState: "scheduled" })), "history");
  const live = row("22", "Overnight", {
    gameState: "live", gameSource: "live", gameCheckedAt: now.toISOString(),
  });
  assert.equal(scope(live), "active");
  assert.equal(scope({ ...live, gameDelayed: true }), "history");
  assert.equal(scope({ ...live, gameCheckedAt: "2026-10-22T10:30:00Z" }), "history");
  assert.equal(scope(row("23", "Today")), "active");
  assert.equal(scope(row("24", "Tomorrow")), "active");
});

test("official reschedules and undated season events stay visible; confirmed finals do not", () => {
  assert.equal(scope(row("22", "Postponed", { gameStartsAt: "2026-10-25T01:00:00Z" })), "active");
  assert.equal(scope(row("25", "MovedEarlier", { gameStartsAt: "2026-10-22T01:00:00Z" })), "history");
  assert.equal(scope(row("25", "Done", { gameState: "finished", gameSource: "live" })), "history");
  assert.equal(scope(row("22", "Season", { ticker: "KXCHAMP-27-TEAM" })), "active");
  const rows = buildCatalog([
    row("24", "Same", { gameState: "finished", gameSource: "market", marketTerminal: true }),
    row("24", "Same", { ticker: "KXATPSPREAD-26OCT24Same-B", gameState: "scheduled", gameSource: "live" }),
  ]);
  assert.equal(rows[0].gameKey, rows[1].gameKey);
  assert.equal(gameScope(rows, now), "active", "One resolved prop is not a game final");
  assert.equal(scopedCatalog(rows, "active", now).length, 2);
});

test("Vigentes and Historial have correct game counts, no cross-list pagination and preserved context", () => {
  const catalog = buildCatalog([
    ...Array.from({ length: 8 }, (_, i) => row("22", `Past${i}`)),
    row("23", "Current"), row("24", "Next"),
  ]);
  const sport = catalog[0].sportKey;
  const first = menuView({ ...HOME, screen: "games", sportKey: sport, page: 99 }, catalog, true, 10000, now);
  assert.equal(first.items.length, 2);
  assert.equal(first.page, 0);
  assert.ok(first.items.every(item => !item.label.includes("Past")));
  const history = navigate({ ...HOME, screen: "games", sportKey: sport }, "d:scope:history", catalog, now);
  assert.equal(history.sportKey, sport);
  const old = menuView(history, catalog, true, 10000, now);
  assert.equal(old.pages, 2);
  assert.equal(old.items.length, 6);
  const changed = navigate(history, "d:band:medium", catalog, now);
  assert.equal(changed.scope, "history");
  assert.equal(changed.band, "medium");
  assert.ok(!menuView(changed, catalog, true, 10000, now).items.some(item => item.detail.includes("10 games")));
  for (const button of old.keyboard.inline_keyboard.flat()) {
    if (button.callback_data) assert.ok(Buffer.byteLength(button.callback_data) <= 64);
  }
});

test("explicit outcome takes precedence over a validated legacy fallback, never book-side vocabulary", () => {
  assert.equal(publicDirection("yes", "no"), "yes");
  assert.equal(publicDirection("no", "yes"), "no");
  assert.equal(publicDirection(undefined, "ask"), "unknown");
  assert.equal(publicDirection(undefined, "bid"), "unknown");
  assert.equal(publicDirection(undefined, "no"), "no");
  assert.equal(publicDirection(" YES "), "yes");
  assert.equal(publicDirection("invalid", "NO"), "no");
  assert.equal(publicDirection("unknown"), "unknown");
});

test("both outcomes with both book sides retain the correct price and exact $10k thresholds", () => {
  for (const outcome of ["yes", "no"]) {
    for (const book of ["bid", "ask"]) {
      for (const amount of [9999, 10000, 10001]) {
        const price = outcome === "yes" ? 0.2 : 0.8;
        const execution = publicTradeExecution({
          taker_outcome_side: outcome, taker_book_side: book,
          taker_side: outcome === "yes" ? "no" : "yes",
          count_fp: String(amount / price), yes_price_dollars: "0.2", no_price_dollars: "0.8",
        })!;
        assert.equal(execution.outcomeSide, outcome);
        assert.equal(execution.price, price);
        assert.equal(execution.notional, amount);
        assert.equal(inTradeRange(execution.notional, tradeRange("large", 10000)), amount >= 10000);
        const notification = {
          ...execution, tradeId: `${outcome}-${book}-${amount}`, ticker: "TEST",
          eventTitle: "A vs B", marketTitle: "A wins", marketUrl: "https://kalshi.com/markets/test",
          bookSide: book, createdTime: now,
        };
        assert.equal(liveNotificationTrades([{ ...notification, createdTime: now.toISOString() }],
          now.getTime() - 1).length, amount > 10000 ? 1 : 0);
        assert.match(notificationText(notification), outcome === "yes" ? /A favor de/ : /En contra de/);
        assert.match(marketCardCaption(notification), outcome === "yes" ? /A favor de/ : /En contra de/);
      }
    }
  }
});

test("legacy outcome price selection and malformed execution data fail safely", () => {
  assert.equal(publicTradeExecution({ taker_side: "no", count: 20000, yes_price: 75, no_price: 25 })?.notional, 5000);
  for (const book of ["bid", "ask"]) {
    assert.equal(publicTradeExecution({
      taker_book_side: book, count: 20000, yes_price: 75, no_price: 25,
    }), undefined, "No explicit or legacy outcome: cannot assign either quote to an unknown direction");
  }
  assert.equal(publicTradeExecution({ taker_outcome_side: "no", count: 20000, yes_price: 75 }), undefined);
  assert.equal(publicTradeExecution({ taker_outcome_side: "yes", count: 20000, yes_price_dollars: "NaN" }), undefined);
  assert.equal(publicTradeExecution({ taker_outcome_side: "no", count: 0, no_price: 60 }), undefined);
});

test("notifications, captions and plot totals share direction and explicit limitations", () => {
  const base = {
    tradeId: "test", ticker: "TEST", marketUrl: "https://kalshi.com/markets/test",
    eventTitle: "Team A vs Team B", marketTitle: "Team A wins", outcomeSide: "no",
    bookSide: "bid", notional: 15000, price: 0.6, count: 25000, createdTime: now,
  };
  const message = notificationText(base);
  assert.match(message, /En contra de Team A to win/);
  assert.match(message, /\$15,000.00/);
  assert.match(message, /25,000 contratos a 60¢/);
  assert.match(message, /no identifica al operador ni confirma una venta o cierre/);
  assert.match(marketCardCaption(base), /En contra de/);
  const plot = bucketHistory([base], now);
  assert.equal(plot.buckets.reduce((n, bucket) => n + bucket.values[4], 0), 15000);
  const unknown = { ...base, outcomeSide: "unknown" };
  assert.match(notificationText(unknown), /Dirección no disponible/);
  assert.match(marketCardSvg([unknown], 10000), /DIRECCIÓN NO DISPONIBLE/);
  assert.equal(bucketHistory([unknown], now).buckets[0].values[5], 15000);
});

test("new menus and direction cards render at phone width with saved history unchanged", async () => {
  const catalog = buildCatalog([row("22", "Cobolli vs Wawrinka"), row("23", "Current")]);
  const active = menuView({ ...HOME, screen: "games", sportKey: catalog[0].sportKey }, catalog, true, 10000, now);
  const historical = menuView({ ...HOME, scope: "history", screen: "games", sportKey: catalog[0].sportKey }, catalog, true, 10000, now);
  const trade = {
    eventTitle: "New England vs Chicago", marketTitle: "Chicago wins by over 2.5 points?",
    outcomeSide: "no", bookSide: "ask", price: 0.6, count: 25000, notional: 15000, createdTime: now,
  };
  const original = JSON.stringify(trade);
  for (const [name, svg] of [
    ["vigentes", menuSvg(active)], ["historial", menuSvg(historical)],
    ["direction", marketCardSvg([trade], 10000, undefined, "large", now)],
  ]) {
    const png = await sharp(Buffer.from(svg)).resize({ width: 390 }).png().toBuffer();
    await writeFile(`/tmp/kalshi-${name}-preview.png`, png);
    assert.equal((await sharp(png).metadata()).width, 390);
    assert.doesNotMatch(svg, /\b(?:NaN|undefined|Infinity)\b/);
  }
  assert.equal(JSON.stringify(trade), original);
});
