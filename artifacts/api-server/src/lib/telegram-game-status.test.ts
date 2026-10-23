import assert from "node:assert/strict";
import { test } from "node:test";
import sharp from "sharp";
import { writeFile } from "node:fs/promises";
import { GameStatusMonitor, gameBadge, monitoringStopped, providerGameState, type GameStatus } from "./kalshi-game-status";
import { KalshiGameStatusSource } from "./kalshi-game-status-source";
import { bandButtons, buildCatalog, catalogGameBadge, HOME, menuSvg, menuView as renderMenuView, type MarketSummary } from "./telegram-dashboard-view";
import { gameDateLabel } from "./telegram-game-date";
import { MarketHistory } from "./kalshi-market-history";
import { marketCardSvg } from "./telegram-market-card";

const now = new Date("2026-10-22T21:00:00Z");
const menuView: typeof renderMenuView = (s, c, e, t, clock = now) => renderMenuView(s, c, e, t, clock);
const base: GameStatus = {
  ticker: "KXNFLGAME-26OCT22TEST-CHI", eventTicker: "EVENT", milestoneId: "game-1",
  state: "live", source: "live", marketStatus: "active", marketTerminal: false,
  startsAt: new Date(now.getTime() - 3600000), delayed: false, checkedAt: now,
  nextCheckAt: new Date(now.getTime() + 60000), error: null,
};
function feed(options: { status?: string; market?: string; noLive?: boolean; noMilestone?: boolean; delayed?: boolean } = {}) {
  const calls: string[] = [];
  const request = async <T>(path: string): Promise<T> => {
    calls.push(path);
    if (path.startsWith("/markets/")) return { market: { event_ticker: "EVENT", status: options.market ?? "active",
      close_time: "2026-10-21T00:00:00Z" } } as T;
    if (path.startsWith("/milestones?")) return { milestones: options.noMilestone ? [] : [{
      id: "game-1", start_date: "2026-10-22T20:00:00Z", details: { status: "live" },
    }] } as T;
    if (options.noLive) throw new Error("Kalshi returned HTTP 404");
    return { live_data: { details: { status: options.status ?? "live", live_data_delayed: options.delayed ?? false } } } as T;
  };
  return { calls, source: new KalshiGameStatusSource(request) };
}

test("game status mapping includes halftime without guessing from a clock or market close time", () => {
  assert.equal(providerGameState("scheduled"), "scheduled");
  assert.equal(providerGameState("in-progress"), "live");
  assert.equal(providerGameState("started"), "live");
  assert.equal(providerGameState("halftime"), "live");
  assert.equal(providerGameState("final"), "finished");
  assert.equal(providerGameState("closed"), "finished");
  for (const status of ["postponed", "cancelled", "suspended", null]) {
    assert.equal(providerGameState(status), "unknown");
  }
  assert.equal(gameBadge("scheduled").color, "#F8FAFC");
  assert.equal(gameBadge("live").color, "#FACC15");
  assert.equal(gameBadge("finished", "live").color, "#F87171");
});

test("live scoreboard wins over stale milestone metadata and misleading market close times", async () => {
  const scheduled = await feed({ status: "scheduled" }).source.resolve(base.ticker, undefined, now);
  assert.equal(scheduled.state, "scheduled");
  assert.equal(monitoringStopped(scheduled), false);
  const finished = await feed({ status: "final" }).source.resolve(base.ticker, undefined, now);
  assert.equal(finished.state, "finished");
  assert.equal(finished.source, "live");
  assert.equal(monitoringStopped(finished), true);
  const tennisLive = await feed({ status: "started" }).source.resolve(base.ticker, undefined, now);
  assert.equal(tennisLive.state, "live");
  const tennisFinal = await feed({ status: "closed" }).source.resolve(base.ticker, undefined, now);
  assert.equal(tennisFinal.state, "finished");
});

test("a resolved bet during a live game is not a finished game", async () => {
  const status = await feed({ status: "live", market: "determined" }).source.resolve(base.ticker, undefined, now);
  assert.equal(status.state, "live");
  assert.equal(status.marketTerminal, true);
  assert.equal(gameBadge(status.state, status.source).label, "En juego");
  assert.equal(monitoringStopped(status), true, "Stop checking this closed bet, not the live game");
});

test("missing live data does not trust a stale milestone 'live' state or infer a finish from elapsed time", async () => {
  const status = await feed({ noLive: true }).source.resolve(base.ticker, undefined, now);
  assert.equal(status.state, "unknown");
  assert.equal(monitoringStopped(status), false);
  const closed = await feed({ noLive: true, market: "closed" }).source.resolve(base.ticker, undefined, now);
  assert.equal(closed.state, "unknown");
  assert.equal(monitoringStopped(closed), true);
});

test("settled markets without a usable scoreboard are honestly labeled resolved, not a proven game finish", async () => {
  const status = await feed({ noMilestone: true, market: "finalized" }).source.resolve(base.ticker, undefined, now);
  assert.equal(status.state, "finished");
  assert.equal(status.source, "market");
  assert.equal(gameBadge(status.state, status.source).label, "Mercado resuelto");
});

test("winner, spread and totals reuse a single live scoreboard fetch per game", async () => {
  const { source, calls } = feed();
  await source.resolve("WINNER", undefined, now);
  await source.resolve("SPREAD", undefined, now);
  await source.resolve("TOTAL", undefined, now);
  assert.equal(calls.filter(path => path.startsWith("/live_data/")).length, 1);
});

test("confirmed finished states survive restarts without another external request", async () => {
  const { source, calls } = feed();
  const finished = { ...base, state: "finished" as const };
  assert.equal(await source.resolve(base.ticker, finished, new Date(now.getTime() + 86400000)), finished);
  let resolved = 0;
  const monitor = new GameStatusMonitor({
    next: async () => ({ ticker: base.ticker, previous: finished }),
    save: async () => assert.fail("No writes or probes for an archived game"),
  }, async () => { resolved++; return finished; }, () => now);
  await monitor.tick();
  await monitor.tick();
  assert.equal(calls.length, 0);
  assert.equal(resolved, 0);
});

test("status failures preserve the last known state, visibly delay it and back off", async () => {
  let saved: GameStatus | undefined;
  const monitor = new GameStatusMonitor({
    next: async () => ({ ticker: base.ticker, previous: base }),
    save: async status => { saved = status; },
  }, async () => { throw new Error("Kalshi temporarily unavailable"); }, () => now);
  await monitor.tick();
  assert.equal(saved?.state, "live");
  assert.equal(saved?.delayed, true);
  assert.equal(saved?.nextCheckAt.getTime(), now.getTime() + 60000);
  assert.match(gameBadge(saved?.state, saved?.source, saved?.delayed).label, /retrasado/);
});

test("history rechecks eligibility before fetching and never modifies the saved cursor of a finished game", async () => {
  let requests = 0;
  let writes = 0;
  const history = new MarketHistory({
    candidates: async () => [{ ticker: base.ticker }],
    job: async () => undefined,
    eligible: async () => false,
    commit: async () => { writes++; },
  }, async () => { requests++; return { rows: [], scanned: 0, cursor: null }; }, () => now);
  await history.tick();
  await history.tick();
  assert.equal(requests, 0);
  assert.equal(writes, 0);
});

function menuRows(): MarketSummary[] {
  return ["finished", "scheduled", "live"].map((state, index) => ({
    ticker: `KXNFLGAME-26OCT2${index + 3}TEST-CHI`, sport: "Football",
    eventTitle: ["Chicago vs New England", "Buffalo vs Miami", "Baltimore vs Cincinnati"][index],
    marketTitle: "Chicago wins", marketUrl: "https://kalshi.com/markets/test",
    trades: 4, lastTradeAt: now.toISOString(), gameState: state, gameSource: "live",
    gameCheckedAt: now.toISOString(),
  }));
}
test("menus show active colors separately from red ended games in Historial", async () => {
  const catalog = buildCatalog(menuRows());
  const view = menuView({ ...HOME, screen: "games", sportKey: catalog[0].sportKey }, catalog, true, 10000);
  assert.deepEqual(view.items.map(item => item.badge?.label), ["En juego", "Por empezar"]);
  const archived = menuView({ ...HOME, scope: "history", screen: "games", sportKey: catalog[0].sportKey }, catalog, true, 10000);
  assert.deepEqual(archived.items.map(item => item.badge?.label), ["Terminado"]);
  const buttonText = JSON.stringify([view.keyboard, archived.keyboard]);
  for (const marker of ["🟡", "⚪", "🔴"]) assert.ok(buttonText.includes(marker));
  const svg = menuSvg(view);
  for (const color of ["#F8FAFC", "#FACC15", "#F87171"]) assert.ok((svg + menuSvg(archived)).includes(color));
  const png = await sharp(Buffer.from(svg)).resize({ width: 390 }).png().toBuffer();
  assert.equal((await sharp(png).metadata()).width, 390);
  await writeFile("/tmp/kalshi-game-status-preview.png", png);
});

test("a single resolved prop cannot color an otherwise live game's navigation red", () => {
  const rows = menuRows();
  assert.equal(catalogGameBadge([
    { ...rows[0], gameState: "finished", gameSource: "market" },
    { ...rows[1], gameState: "live", gameSource: "live" },
  ]).label, "En juego");
});

test("finished charts are red, static across time and never present old trades as recent live activity", () => {
  const trades = [{
    eventTitle: "Chicago vs New England", marketTitle: "Chicago wins",
    price: 0.6, count: 25000, notional: 15000, outcomeSide: "yes", createdTime: now,
  }];
  const display = { ...gameBadge("finished", "live"), stopped: true };
  const first = marketCardSvg(trades, 10000, undefined, "large", now, display);
  const later = marketCardSvg(trades, 10000, undefined, "large", new Date(now.getTime() + 86400000), display);
  assert.equal(first, later);
  assert.match(first, /Terminado/);
  assert.match(first, /saved history/);
  assert.doesNotMatch(first, /1 in last 15m/);
});

test("game dates precede long team names on Telegram buttons, without a redundant trailing status", async () => {
  const rows = menuRows().slice(0, 2).map((row, index) => ({
    ...row, eventTitle: ["Denver vs Oklahoma City", "Cleveland vs Philadelphia"][index],
    sport: "Basketball", ticker: `KXNBAGAME-26OCT2${index + 3}TEST-CHI`, gameState: "scheduled",
  }));
  const catalog = buildCatalog(rows);
  const view = menuView({ ...HOME, screen: "games", sportKey: catalog[0].sportKey }, catalog, true, 10000);
  const buttons = view.keyboard.inline_keyboard.flat().filter(button => button.callback_data?.startsWith("d:game:"));
  assert.equal(buttons.length, 2);
  for (const button of buttons) {
    assert.match(button.text, /^⚪ 2[34] oct 2026 · /);
    assert.doesNotMatch(button.text, /Por empezar/);
    assert.ok(button.text.length < 52);
  }
  assert.match(view.items[0].label, /^2[34] oct 2026 · /);
  const png = await sharp(Buffer.from(menuSvg(view))).resize({ width: 320 }).png().toBuffer();
  await writeFile("/tmp/kalshi-date-first-preview.png", png);
});

test("official game dates use New York time and never change the callback/game identity", () => {
  const row = { ...menuRows()[0], ticker: "KXNBAGAME-26OCT23DENOKC-DEN" };
  assert.equal(gameDateLabel(row.ticker, "2026-10-24T00:30:00Z"), "23 oct 2026");
  const before = buildCatalog([row])[0];
  const after = buildCatalog([{ ...row, gameStartsAt: "2026-10-25T00:30:00Z" }])[0];
  assert.equal(after.gameDateLabel, "24 oct 2026");
  assert.equal(before.gameKey, after.gameKey);
  assert.equal(before.id, after.id);
});

test("missing/invalid schedule dates fall back safely; season titles are never assigned a made-up game date", () => {
  assert.equal(gameDateLabel("KXNBAGAME-26OCT23DENOKC-DEN", "invalid"), "23 oct 2026");
  assert.equal(gameDateLabel("KXNBA-27-TEAM"), "Sin fecha");
  assert.equal(gameDateLabel("KXNFLGAME-26FEB31AB-CD"), "Sin fecha");
  assert.equal(gameDateLabel("KXNFLGAME-26XYZ23AB-CD"), "Sin fecha");
  assert.equal(gameDateLabel("KXNBA-27-TEAM", "2027-06-12T19:00:00Z"), "12 jun 2027");
});

test("compact range labels preserve exact thresholds, selection and callback routing", () => {
  assert.deepEqual(bandButtons("large").map(button => button.text), ["• $10k+", "$5k–$10k"]);
  assert.deepEqual(bandButtons("medium").map(button => button.text), ["$10k+", "• $5k–$10k"]);
  assert.equal(bandButtons("large", 15050)[0].text, "• $15,050+");
  assert.equal(bandButtons("large", 15050)[0].callback_data, "d:band:large");
});
