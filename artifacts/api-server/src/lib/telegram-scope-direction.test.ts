import assert from "node:assert/strict";
import { test } from "node:test";
import { writeFile } from "node:fs/promises";
import sharp from "sharp";
import { gameCalendarDay, newYorkDay } from "./telegram-game-date";
import { gameScope, isWithinNext48Hours, scopedCatalog } from "./telegram-game-scope";
import { buildCatalog, HOME, menuSvg, menuView, navigate, type MarketSummary } from "./telegram-dashboard-view";
import { publicDirection } from "./telegram-trade-direction";
import { marketCardCaption, marketCardSvg } from "./telegram-market-card";
import { bucketHistory, historyPlotSvg } from "./telegram-history-plot";
import { notificationText } from "./telegram-trade-notifications";
import { liveNotificationTrades } from "./telegram-trade-notifications";
import { publicTradeExecution } from "./kalshi-trade-execution";
import { inTradeRange, tradeRange } from "./kalshi-trade-bands";
import { dashboardChartCaption } from "./telegram-dashboard-caption";
import { catalogGameBadge } from "./telegram-dashboard-view";
import { explorerSince, explorerState } from "./kalshi-explorer-view";

const now = new Date("2026-10-23T10:30:00Z");
function row(day: string, name: string, extra: Partial<MarketSummary> = {}): MarketSummary {
  return {
    ticker: `KXATPMATCH-26OCT${day}${name}-A`, sport: "Tennis", eventTitle: `${name} vs Opponent`,
    marketTitle: `${name} wins`, trades: 1, marketUrl: "https://kalshi.com/markets/test",
    lastTradeAt: "2026-10-23T10:00:00Z", ...extra,
  };
}
const scope = (value: MarketSummary) => gameScope(buildCatalog([value]), now);

test("history shows only the game score, never the position outcome, and distinguishes pending scores", () => {
  const catalog = buildCatalog([row("22", "Madrid", { gameState: "finished", gameSource: "live",
    gameResult: "Madrid 2–1 Barcelona", marketResult: "NO" })]);
  const games = menuView({ ...HOME, scope: "history", screen: "games", sportKey: catalog[0].sportKey },
    catalog, true, 10000, now);
  assert.match(games.items[0].detail, /Madrid 2–1 Barcelona/);
  const markets = menuView({ ...HOME, scope: "history", screen: "markets",
    sportKey: catalog[0].sportKey, gameKey: catalog[0].gameKey }, catalog, true, 10000, now);
  assert.match(markets.subtitle, /Madrid 2–1 Barcelona/);
  assert.doesNotMatch(markets.items[0].detail, /Resolución|NO|SÍ/);
  const missing = menuView({ ...HOME, scope: "history", screen: "games", sportKey: catalog[0].sportKey },
    buildCatalog([row("22", "Madrid", { gameState: "finished" })]), true, 10000, now);
  assert.equal(missing.items[0].detail, "Marcador pendiente de cargar");
  const unavailable = menuView({ ...HOME, scope: "history", screen: "games", sportKey: catalog[0].sportKey },
    buildCatalog([row("22", "Madrid", { gameState: "finished", scoreStatus: "unavailable" })]), true, 10000, now);
  assert.equal(unavailable.items[0].detail, "Marcador no disponible");
});

test("website time windows use execution time and preserve all-history selection", () => {
  assert.equal(explorerSince("all", now), undefined);
  assert.equal(explorerSince("1h", now)?.toISOString(), "2026-10-23T09:30:00.000Z");
  assert.equal(explorerSince("24h", now)?.toISOString(), "2026-10-22T10:30:00.000Z");
});

test("website lifecycle matches Telegram and never claims delayed games are live", () => {
  const market = row("23", "Live", { gameState: "live", gameSource: "live", gameCheckedAt: now.toISOString() });
  const state = (extra: Partial<MarketSummary> = {}) => explorerState(buildCatalog([{ ...market, ...extra }]), now);
  assert.equal(state(), "live");
  assert.equal(state({ gameDelayed: true }), "unknown");
  assert.equal(state({ gameCheckedAt: "2026-10-22T10:00:00Z" }), "unknown");
  assert.equal(state({ gameState: "scheduled" }), "upcoming");
  assert.equal(state({ gameState: "finished" }), "finished");
  assert.equal(state({ gameState: "finished", gameSource: "market" }), "finished");
});

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

test("Vigentes includes live matches and games starting within the next 48 hours only", () => {
  const current = new Date("2026-10-23T14:00:00Z");
  const inThreeHours = row("23", "Soon", { gameStartsAt: "2026-10-23T17:00:00Z" });
  const in24Hours = row("24", "Tomorrow", { gameStartsAt: "2026-10-24T14:00:00Z" });
  const cutoff = row("25", "AtLimit", { gameStartsAt: "2026-10-25T14:00:00Z" });
  const afterCutoff = row("25", "TooLate", { gameStartsAt: "2026-10-25T14:00:00.001Z" });
  const oldScheduled = row("23", "SchedulePassed", { gameStartsAt: "2026-10-23T13:59:00Z" });
  const liveYesterday = row("22", "OvernightLive", {
    gameState: "live", gameSource: "live", gameCheckedAt: current.toISOString(),
    gameStartsAt: "2026-10-22T20:00:00Z",
  });
  const dateOnlyTwoDaysAway = row("25", "DateFallback");
  const beyondDateWindow = row("26", "Beyond");
  const noDate = row("NO-DATE-SEASON", "Season");
  const finished = row("24", "Finished", { gameState: "finished", gameSource: "live" });

  for (const upcoming of [inThreeHours, in24Hours, cutoff, liveYesterday, dateOnlyTwoDaysAway]) {
    assert.equal(isWithinNext48Hours(buildCatalog([upcoming]), current), true, upcoming.eventTitle!);
  }
  for (const excluded of [afterCutoff, oldScheduled, beyondDateWindow, noDate, finished, row("22", "Yesterday")]) {
    assert.equal(isWithinNext48Hours(buildCatalog([excluded]), current), false, excluded.eventTitle!);
  }

  const catalog = buildCatalog([
    inThreeHours, in24Hours, cutoff, afterCutoff, liveYesterday, dateOnlyTwoDaysAway,
    beyondDateWindow, noDate, finished, row("22", "Yesterday"),
  ]);
  const active = scopedCatalog(catalog, "active", current);
  assert.deepEqual(new Set(active.map(m => m.eventTitle)), new Set([
    "Soon vs Opponent", "Tomorrow vs Opponent", "AtLimit vs Opponent",
    "OvernightLive vs Opponent", "DateFallback vs Opponent",
  ]));
  const archive = scopedCatalog(catalog, "history", current);
  assert.ok(archive.some(m => m.eventTitle === "Yesterday vs Opponent"));
  assert.ok(archive.some(m => m.eventTitle === "Finished vs Opponent"));
  assert.ok(!archive.some(m => m.eventTitle === "TooLate vs Opponent"), "Undated or distant-future events do not appear as past history");
  const sportKey = catalog[0].sportKey;
  const activeMenu = menuView({ ...HOME, screen: "games", sportKey }, catalog, true, 10000, current);
  assert.ok(activeMenu.items.some(item => item.label.includes("Soon vs Opponent")));
  assert.ok(!activeMenu.items.some(item => item.label.includes("Yesterday") || item.label.includes("TooLate")));
  const historyMenu = menuView({ ...HOME, scope: "history", screen: "games", sportKey }, catalog, true, 10000, current);
  assert.ok(historyMenu.items.some(item => item.label.includes("Yesterday vs Opponent")));
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
    const execution = publicTradeExecution({
      taker_book_side: book, count: 20000, yes_price: 75, no_price: 25,
    });
    assert.equal(execution?.outcomeSide, book === "bid" ? "yes" : "no");
    assert.equal(execution?.notional, book === "bid" ? 15000 : 5000);
  }
  assert.equal(publicTradeExecution({ taker_book_side: "sell", count: 20000, yes_price: 75 }), undefined);
  assert.equal(publicTradeExecution({ taker_outcome_side: "no", count: 20000, yes_price: 75 }), undefined);
  assert.equal(publicTradeExecution({ taker_outcome_side: "yes", count: 20000, yes_price_dollars: "NaN" }), undefined);
  assert.equal(publicTradeExecution({ taker_outcome_side: "no", count: 0, no_price: 60 }), undefined);
});

test("canonical book-only trades retain the exact alert threshold and direction in graphs", () => {
  for (const book of ["bid", "ask"]) {
    for (const [count, amount] of [["19999.98", 9999.99], ["20000.00", 10000], ["20000.02", 10000.01]] as const) {
      const execution = publicTradeExecution({
        taker_book_side: book, count_fp: count, yes_price_dollars: "0.5000", no_price_dollars: "0.5000",
      })!;
      assert.equal(execution.notional, amount);
      const trade = {
        ...execution, tradeId: "canonical", ticker: "TEST", eventTitle: "A vs B",
        marketTitle: "A wins", marketUrl: "https://kalshi.com/markets/test", createdTime: now, bookSide: book,
      };
      assert.equal(liveNotificationTrades([{ ...trade, createdTime: now.toISOString() }], now.getTime() - 1).length,
        amount > 10000 ? 1 : 0);
      assert.match(notificationText(trade), book === "ask" ? /Compra de NO o venta de SÍ/ : /Compra de SÍ o venta de NO/);
      const plot = bucketHistory([trade], now);
      assert.equal(plot.buckets[0].values[book === "ask" ? 4 : 3], amount);
    }
  }
});

test("notifications, captions and plot totals share direction and explicit limitations", () => {
  const base = {
    tradeId: "test", ticker: "TEST", marketUrl: "https://kalshi.com/markets/test",
    eventTitle: "Team A vs Team B", marketTitle: "Team A wins", outcomeSide: "no",
    bookSide: "bid", notional: 15000, price: 0.6, count: 25000, createdTime: now,
  };
  const message = notificationText(base);
  assert.match(message, /En contra de «Team A gana»/);
  assert.match(message, /\$15,000.00/);
  assert.match(message, /25,000 contratos a 60¢/);
  assert.match(message, /no identifica al operador ni confirma una venta o cierre/);
  assert.match(marketCardCaption(base), /En contra de/);
  const plot = bucketHistory([base], now);
  assert.equal(plot.buckets.reduce((n, bucket) => n + bucket.values[4], 0), 15000);
  assert.match(message, /Compra de NO o venta de SÍ/);
  assert.match(marketCardSvg([base], 10000), /Compra de NO o venta de SÍ/);
  const canonicalOnly = { ...base, outcomeSide: "unknown", bookSide: "ask" };
  assert.match(notificationText(canonicalOnly), /En contra de/);
  assert.equal(bucketHistory([canonicalOnly], now).buckets[0].values[4], 15000);
  const unknown = { ...base, outcomeSide: "unknown", bookSide: "unknown" };
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
  assert.equal(active.step, 2);
  assert.match(active.keyboard.inline_keyboard[0][0].callback_data!, /^d:game:/);
  assert.ok(active.keyboard.inline_keyboard.some(row => row.some(button => button.callback_data === "d:scope:history")));
  assert.ok(active.caption.length < 600, "Menu instructions stay concise");
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

test("a stale live label is shown as unconfirmed, not as a current game or an invented final", () => {
  const live = row("23", "Current", { gameState: "live", gameSource: "live", gameCheckedAt: now.toISOString() });
  assert.equal(catalogGameBadge([live], now).rank, 0);
  assert.equal(catalogGameBadge([{ ...live, gameCheckedAt: "2026-10-22T12:00:00Z" }], now).rank, 2);
  assert.equal(catalogGameBadge([{ ...live, gameDelayed: true }], now).rank, 2);
  assert.equal(catalogGameBadge([{ ...live, gameCheckedAt: undefined }], now).rank, 2);
  assert.equal(catalogGameBadge([{ ...live, gameState: "finished" }], now).rank, 3);
});

test("photo captions remain within Telegram limits and explain partial, paused and saved history in Spanish", () => {
  const options = {
    trade: {
      eventTitle: 'Equipo & <A> "largo" '.repeat(60), marketTitle: "Una apuesta con descripción muy larga ".repeat(60),
      outcomeSide: "no", notional: 12000, count: 20000, price: 0.6, createdTime: now,
    },
    historical: false, stopped: false, confirmedClosed: false, enabled: true,
    gameDate: "23 oct 2026", statusLabel: "Sin confirmar", checkedAt: now.toISOString(),
    range: tradeRange("medium"), history: { phase: "recent", error: false, scanned: 100000 },
  };
  for (const variant of [
    options, { ...options, enabled: false },
    { ...options, history: { ...options.history, error: true } },
    { ...options, historical: true, stopped: true },
    { ...options, historical: true, stopped: true,
      gameResult: "Un nombre de equipo muy largo & <otro> ".repeat(20),
      marketResult: "Liquidación no binaria" },
  ]) {
    const caption = dashboardChartCaption(variant);
    const parsed = caption.replace(/<[^>]*>/g, "").replace(/&(?:amp|lt|gt|quot|apos);/g, "x");
    assert.ok(parsed.length <= 1024, `Caption has ${parsed.length} characters`);
    assert.match(caption, /Rango: &gt; \$5,000 y &lt; \$10,000/);
    assert.doesNotMatch(caption, /Loading|Notifications:|Section:|Bright|Dark/);
  }
  assert.match(dashboardChartCaption(options), /Cargando histórico; la gráfica aún es parcial/);
  const paused = dashboardChartCaption({ ...options, enabled: false });
  assert.match(paused, /pausad/);
  assert.doesNotMatch(paused, /Se actualiza aquí cada 15/);
  const saved = dashboardChartCaption({ ...options, stopped: true, historical: true });
  assert.match(saved, /Archivado por fecha; no confirma que haya terminado/);
  assert.doesNotMatch(saved, /Cargando histórico/);
});

test("redesigned charts preserve proportional geometry, exact sums and execution-time recency", () => {
  const base = { eventTitle: "Boston vs Chicago", marketTitle: "Chicago wins",
    price: 0.5, count: 60000, outcomeSide: "yes", notional: 30000, createdTime: new Date(now.getTime() - 3600000) };
  const rows = [base,
    { ...base, outcomeSide: "no", notional: 12000, count: 24000, createdTime: new Date(now.getTime() - 120000) },
    { ...base, outcomeSide: "unknown", notional: 18000, count: 36000, createdTime: new Date(now.getTime() - 60000) }];
  const svg = marketCardSvg(rows, 10000, undefined, "large", now);
  assert.match(svg, /Chicago gana/);
  assert.match(svg, /\$60,000/);
  assert.match(svg, /Últimos 15 min: 2 op. · \$30,000/);
  assert.match(svg, /Dirección sin dato/);
  assert.match(svg, /Rayado = últimos 15 min/);
  assert.match(svg, /2026/);
  assert.doesNotMatch(svg, /Partido detenido|LATEST|trades · total/);
  const stale = marketCardSvg(rows, 10000, undefined, "large", new Date(now.getTime() + 3600000));
  assert.match(stale, /Sin operaciones en los últimos 15 min/);
  const future = marketCardSvg([{ ...base, createdTime: new Date(now.getTime() + 60000) }], 10000, undefined, "large", now);
  assert.match(future, /Hora futura; sin confirmar/);
  const extreme = historyPlotSvg([base, { ...base, outcomeSide: "unknown", notional: 0.01 }], now, 100, 400);
  const heights = [...extreme.svg.matchAll(/height="([\d.e+-]+)" fill="url\(#(?:dir|recent)/g)].map(match => Number(match[1]));
  assert.ok(Math.abs(heights.reduce((n, h) => n + h, 0) - extreme.total / extreme.maximum * 300) < 1e-8,
    "Tiny segments are not artificially enlarged");
});

test("phone previews cover real long latest names, dense history, huge amounts and stopped graphs", async () => {
  const base = {
    eventTitle: "Los Angeles Lakers vs Boston Celtics", marketTitle: "Boston Celtics wins by over 7.5 points",
    price: 0.5, count: 30000, notional: 15000, outcomeSide: "yes", createdTime: now,
  };
  const dense = Array.from({ length: 120 }, (_, i) => ({
    ...base, outcomeSide: ["yes", "no", "unknown"][i % 3], notional: 10000 + i * 1400, count: (10000 + i * 1400) / 0.5,
    createdTime: new Date(now.getTime() - (119 - i) * 40 * 60000),
  }));
  const long = { ...base,
    eventTitle: "Northwestern State University International Basketball Team vs Southeastern Metropolitan University Basketball Team",
    marketTitle: "Southeastern Metropolitan University Basketball Team wins by over 17.5 points",
    notional: 123456789.12, count: 246913578.24,
  };
  const cases = [
    ["dense", marketCardSvg(dense, 10000, undefined, "large", now, { label: "Sin confirmar · datos retrasados", color: "#94A3B8" })],
    ["long", marketCardSvg([long], 10000, undefined, "large", now)],
    ["medium", marketCardSvg([{ ...base, notional: 7500, count: 15000 }], 5000, undefined, "medium", now)],
    ["stopped", marketCardSvg(dense, 10000, undefined, "large", now, { label: "Historial", color: "#F87171", stopped: true })],
  ];
  assert.ok(cases[1][1].replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").includes("17.5 puntos"),
    "Do not cut the actual bet condition off long names");
  for (const [name, svg] of cases) {
    for (const width of [320, 390]) {
      const png = await sharp(Buffer.from(svg)).resize({ width }).png().toBuffer();
      await writeFile(`/tmp/kalshi-review-${name}-${width}.png`, png);
      assert.equal((await sharp(png).metadata()).width, width);
    }
    assert.doesNotMatch(svg, /\b(?:NaN|undefined|Infinity)\b/);
  }
});
