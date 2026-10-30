import { and, count, desc, eq, gte, isNotNull } from "drizzle-orm";
import {
  db,
  kalshiAlertsTable,
  kalshiMonitorSettingsTable,
} from "@workspace/db";
import { logger } from "./logger";
import { MarketSettlementWorker } from "./kalshi-settlement-source";
import { settlementStore } from "./kalshi-settlement-store";
import { TelegramDashboard, type CallbackQuery } from "./telegram-dashboard";
import { telegramDashboardStore } from "./telegram-dashboard-store";
import { shouldCaptureTrade } from "./kalshi-trade-bands";
import { MarketHistory, type HistoryJob } from "./kalshi-market-history";
import { marketHistoryStore } from "./kalshi-market-history-store";
import { liveNotificationTrades, TelegramTradeNotifications } from "./telegram-trade-notifications";
import { enqueueLiveNotifications, tradeNotificationStore } from "./telegram-trade-notification-store";
import { GameStatusMonitor } from "./kalshi-game-status";
import { KalshiGameStatusSource } from "./kalshi-game-status-source";
import { KalshiResultsSource } from "./kalshi-results-source";
import { FinalResultsWorker } from "./kalshi-results-store";
import { canMonitorMarket, gameStatusRepository, readGameStatus } from "./kalshi-game-status-store";
import { isOwnerChat, ownerChatId } from "./owner-policy";
import { publicTradeExecution } from "./kalshi-trade-execution";
import { KalshiCooldownError, KalshiHttpClient } from "./kalshi-http";
import { KalshiAuth, KalshiReadPacer } from "./kalshi-auth";
import { KalshiTradeStream, type StreamTrade } from "./kalshi-trade-stream";
import { KalshiLiveCoverage } from "./kalshi-live-coverage";
import { kalshiLiveEvents } from "./kalshi-live-events";

const KALSHI_API = "https://external-api.kalshi.com/trade-api/v2";
const TELEGRAM_API = "https://api.telegram.org";
const DEFAULT_THRESHOLD = 10_000;
const POLL_INTERVAL_MS = 15_000;
const SERIES_CACHE_MS = 60 * 60 * 1000;

type KalshiSeries = {
  ticker: string;
  title: string;
  category?: string;
  categories?: string[] | null;
  tags?: string[] | null;
};

type KalshiTradeApi = {
  trade_id: string;
  ticker: string;
  count_fp?: string;
  count?: number;
  yes_price_dollars?: string;
  no_price_dollars?: string;
  yes_price?: number;
  no_price?: number;
  taker_outcome_side?: string;
  taker_side?: string;
  taker_book_side?: string;
  created_time: string;
  is_block_trade?: boolean;
};

type TradeFeedResponse = {
  trades: KalshiTradeApi[];
  cursor?: string;
};

type KalshiMarketMetadata = {
  event_ticker?: string;
  title?: string;
  yes_sub_title?: string;
  no_sub_title?: string;
};

type KalshiEventMetadata = {
  title?: string;
  sub_title?: string;
};

export type PublicTrade = {
  tradeId: string;
  ticker: string;
  title: string;
  eventTitle: string;
  marketTitle: string;
  sport: string;
  outcomeSide: string;
  bookSide: string;
  price: number;
  count: number;
  notional: number;
  createdTime: string;
  blockTrade: boolean;
  marketUrl: string;
};

type Settings = {
  enabled: boolean;
  minimumNotional: number;
  chatId: string | null;
  telegramUpdateOffset?: number | null;
};

type TelegramResponse<T> = {
  ok: boolean;
  result?: T;
  description?: string;
};

type TelegramUpdate = {
  update_id?: number;
  callback_query?: CallbackQuery;
  message?: {
    text?: string;
    chat?: {
      id: number | string;
      type?: string;
      title?: string;
      first_name?: string;
      last_name?: string;
      username?: string;
    };
  };
};

let sportsSeries = new Map<string, KalshiSeries>();
let seriesFetchedAt = 0;
let latestQualifyingTrades: PublicTrade[] = [];
let lastChecked: string | null = null;
let lastError: string | null = null;
let pollInProgress = false;
let monitorStarted = false;
let telegramPollInProgress = false;
let kalshiAuth: KalshiAuth | null = null;
let tradeStream: KalshiTradeStream | null = null;
let streamError: string | null = null;
let ingestionChain: Promise<void> = Promise.resolve();
const liveStartedAt = Date.now();
const liveCoverage = new KalshiLiveCoverage(liveStartedAt);
const restPacer = new KalshiReadPacer();
// Keep REST off the healthy live path. Reconnects/gaps request a catch-up.
function needsRestRecovery() {
  return liveCoverage.needsRecovery(tradeStream?.live ?? false);
}
const tradeContextCache = new Map<
  string,
  Promise<{ eventTitle: string; marketTitle: string }>
>();
const eventTitleCache = new Map<string, Promise<string>>();
const marketHistory = new MarketHistory(marketHistoryStore, readHistoryPage, () => new Date(),
  (ticker, error) => logger.warn({ ticker, error }, "Market history incomplete; retry scheduled"));
const gameStatusSource = new KalshiGameStatusSource(<T>(path: string) => fetchJson<T>(`${KALSHI_API}${path}`));
const resultsSource = new KalshiResultsSource(<T>(path: string) => fetchJson<T>(`${KALSHI_API}${path}`));
const finalResultsWorker = new FinalResultsWorker((ticker, milestone) => resultsSource.resolve(ticker, milestone),
  message => logger.warn({ message }, "Final result enrichment failed"));
const gameStatusMonitor = new GameStatusMonitor(gameStatusRepository,
  (ticker, previous, now) => gameStatusSource.resolve(ticker, previous, now),
  () => new Date(), error => logger.warn({ error }, "Game status lookup will retry"));
const telegramDashboard = new TelegramDashboard(telegramDashboardStore, {
  request: telegramRequest,
  photo: telegramPhotoRequest,
  context: getTradeContext,
  history: ticker => { gameStatusMonitor.prefer(ticker); return marketHistory.status(ticker); },
});
const tradeNotifications = new TelegramTradeNotifications(tradeNotificationStore, {
  request: telegramRequest, context: getTradeContext, active: canMonitorMarket,
}, () => new Date(), (event, detail) => {
  if (event === "sent") logger.info({ tradeId: detail }, "Telegram trade notification delivered");
  else logger.warn({ error: detail }, event === "failed" ? "Telegram notification will retry" : "Previous notification cleanup will retry");
});

const kalshiHttp = new KalshiHttpClient(fetch, Date.now, (retryAt, delayMs) => {
  lastError = new KalshiCooldownError(retryAt).message;
  logger.warn({ retryAt: new Date(retryAt).toISOString(), delayMs },
    "Kalshi rate limit: shared pause activated");
}, async url => {
  await restPacer.wait();
  return kalshiAuth?.headers(new URL(url).pathname);
});

function fetchJson<T>(url: string): Promise<T> {
  return kalshiHttp.json<T>(url);
}

const marketSettlementWorker = new MarketSettlementWorker(
  settlementStore, <T>(path: string) => fetchJson<T>(`${KALSHI_API}${path}`),
  () => kalshiHttp.isPaused,
);

async function getSportsSeries(): Promise<Map<string, KalshiSeries>> {
  if (sportsSeries.size > 0 && Date.now() - seriesFetchedAt < SERIES_CACHE_MS) {
    return sportsSeries;
  }

  const response = await fetchJson<{ series: KalshiSeries[] }>(
    `${KALSHI_API}/series?category=Sports`,
  );
  const nextSeries = new Map<string, KalshiSeries>();
  for (const series of response.series ?? []) {
    if (
      series.category === "Sports" ||
      series.categories?.includes("Sports")
    ) {
      nextSeries.set(series.ticker, series);
    }
  }
  sportsSeries = nextSeries;
  seriesFetchedAt = Date.now();
  return sportsSeries;
}

async function getTradesSince(boundary: number | null) {
  const trades: KalshiTradeApi[] = [];
  let cursor: string | undefined;
  const maxPages = boundary === null ? 1 : 50;

  for (let page = 0; page < maxPages; page += 1) {
    const query = new URLSearchParams({ limit: "1000" });
    if (boundary !== null) {
      query.set("min_ts", String(Math.max(0, Math.floor(boundary / 1000) - 1)));
    }
    if (cursor) query.set("cursor", cursor);

    const response = await fetchJson<TradeFeedResponse>(
      `${KALSHI_API}/markets/trades?${query.toString()}`,
    );
    trades.push(...(response.trades ?? []));
    cursor = response.cursor;
    if (!cursor) return trades;
  }

  // On startup, one page is enough to populate the dashboard and establish a
  // poll boundary; older pages must not be replayed as fresh notifications.
  if (boundary === null) return trades;
  if (cursor) {
    throw new Error(
      "Kalshi returned more than 50,000 trades for one polling window; the monitor will retry.",
    );
  }
  return trades;
}

async function readHistoryPage(job: HistoryJob) {
  const query = new URLSearchParams({
    ticker: job.ticker, limit: "1000",
    max_ts: String(Math.floor(job.snapshotAt.getTime() / 1000)),
  });
  if (job.sinceAt) query.set("min_ts", String(Math.max(0, Math.floor(job.sinceAt.getTime() / 1000) - 1)));
  if (job.cursor) query.set("cursor", job.cursor);
  const endpoint = job.phase === "live" ? "markets/trades" : "historical/trades";
  const [response, saved] = await Promise.all([
    fetchJson<TradeFeedResponse>(`${KALSHI_API}/${endpoint}?${query}`),
    db.select().from(kalshiAlertsTable).where(eq(kalshiAlertsTable.ticker, job.ticker)).limit(1),
  ]);
  if (!saved[0] || !Array.isArray(response.trades)) throw new Error("Historical source or saved sports metadata unavailable.");
  // Retired series can disappear from today's sports catalog. Its already-saved
  // sports identity remains usable; do not block an old market on current discovery.
  const series = job.ticker.split("-")[0];
  const index = new Map(sportsSeries);
  if (!index.has(series)) index.set(series, { ticker: series, title: saved[0].sport, category: "Sports" });
  const context = saved[0].eventTitle && saved[0].marketTitle
    ? { eventTitle: saved[0].eventTitle, marketTitle: saved[0].marketTitle }
    : await getTradeContext(job.ticker);
  const rows: PublicTrade[] = [];
  for (const raw of response.trades) {
    if (raw.ticker !== job.ticker) throw new Error("Historical response contains a different market.");
    const trade = toPublicTrade(raw, index);
    if (!trade) throw new Error("Historical response contains an unreadable trade; page will be retried.");
    rows.push({ ...trade, ...context, title: `${context.eventTitle} · ${context.marketTitle}` });
  }
  return { rows, scanned: response.trades.length, cursor: response.cursor || null };
}

function resolveSeries(ticker: string, index: Map<string, KalshiSeries>) {
  const separator = ticker.indexOf("-");
  if (separator < 1) return undefined;
  return index.get(ticker.slice(0, separator));
}

function toPublicTrade(
  trade: KalshiTradeApi,
  index: Map<string, KalshiSeries>,
): PublicTrade | undefined {
  const series = resolveSeries(trade.ticker, index);
  if (!series || !trade.trade_id) return undefined;

  const execution = publicTradeExecution(trade);
  if (!execution) return undefined;
  const { outcomeSide, price, count, notional } = execution;
  const createdAt = new Date(trade.created_time);

  if (
    !Number.isFinite(price) ||
    !Number.isFinite(count) ||
    !Number.isFinite(notional) ||
    price <= 0 ||
    count <= 0 ||
    Number.isNaN(createdAt.getTime())
  ) {
    return undefined;
  }

  const title = `${series.title} · ${trade.ticker}`;
  return {
    tradeId: trade.trade_id,
    ticker: trade.ticker,
    title,
    eventTitle: series.title,
    marketTitle: trade.ticker,
    sport: series.tags?.[0] ?? series.title,
    outcomeSide,
    bookSide: (trade.taker_book_side ?? "unknown").toLowerCase(),
    price,
    count,
    notional,
    createdTime: createdAt.toISOString(),
    blockTrade: trade.is_block_trade ?? false,
    marketUrl: `https://kalshi.com/markets/${series.ticker}/${trade.ticker}`,
  };
}

async function getTradeContext(ticker: string) {
  let contextPromise = tradeContextCache.get(ticker);
  if (!contextPromise) {
    contextPromise = (async () => {
      // An archived game needs no metadata refresh, including after a process restart.
      if ((await readGameStatus(ticker))?.state === "finished") {
        const [saved] = await db.select({ eventTitle: kalshiAlertsTable.eventTitle,
          marketTitle: kalshiAlertsTable.marketTitle }).from(kalshiAlertsTable)
          .where(eq(kalshiAlertsTable.ticker, ticker)).limit(1);
        if (saved?.eventTitle && saved.marketTitle && !saved.marketTitle.includes(ticker)) return {
          eventTitle: saved.eventTitle, marketTitle: saved.marketTitle,
        };
        throw new Error("Finished game has no saved readable metadata.");
      }
      let marketResponse: { market: KalshiMarketMetadata };
      try {
        marketResponse = await fetchJson(`${KALSHI_API}/markets/${encodeURIComponent(ticker)}`);
      } catch (error) {
        if (!(error instanceof Error) || !/HTTP 404/.test(error.message)) throw error;
        marketResponse = await fetchJson(`${KALSHI_API}/historical/markets/${encodeURIComponent(ticker)}`);
      }
      const market = marketResponse.market;
      const eventTicker = market.event_ticker;
      if (!eventTicker) throw new Error("Kalshi market has no game identifier.");
      let eventTitlePromise = eventTitleCache.get(eventTicker);
      if (!eventTitlePromise) {
        eventTitlePromise = fetchJson<{ event: KalshiEventMetadata }>(
          `${KALSHI_API}/events/${encodeURIComponent(eventTicker)}`,
        ).then(({ event }) => {
          const title = event.title?.trim() || event.sub_title?.trim();
          if (!title) throw new Error("Kalshi game title is unavailable.");
          return title;
        }).catch((error) => {
          eventTitleCache.delete(eventTicker);
          throw error;
        });
        if (eventTitleCache.size >= 5_000) eventTitleCache.clear();
        eventTitleCache.set(eventTicker, eventTitlePromise);
      }
      const eventTitle = await eventTitlePromise;
      const marketTitle = market.title?.trim() || market.yes_sub_title?.trim();
      if (!marketTitle || marketTitle.includes(ticker)) {
        throw new Error("Kalshi bet description is unavailable; will retry before sending.");
      }
      return { eventTitle, marketTitle };
    })();
    if (tradeContextCache.size >= 5_000) tradeContextCache.clear();
    tradeContextCache.set(ticker, contextPromise);
  }
  try {
    return await contextPromise;
  } catch (error) {
    tradeContextCache.delete(ticker);
    throw error;
  }
}

async function withTradeContext(trade: PublicTrade): Promise<PublicTrade> {
  try {
    const context = await getTradeContext(trade.ticker);
    return { ...trade, ...context, title: `${context.eventTitle} · ${context.marketTitle}` };
  } catch (error) {
    logger.debug({ ticker: trade.ticker }, "Game metadata unavailable; will retry");
    return trade;
  }
}

async function readSettings(): Promise<Settings> {
  const [saved] = await db
    .select()
    .from(kalshiMonitorSettingsTable)
    .where(eq(kalshiMonitorSettingsTable.id, 1))
    .limit(1);
  return {
    enabled: saved?.enabled ?? false,
    minimumNotional: saved?.minimumNotional ?? DEFAULT_THRESHOLD,
    chatId: ownerChatId(),
    telegramUpdateOffset: saved?.telegramUpdateOffset ?? null,
  };
}

function botToken() {
  return process.env.TELEGRAM_BOT_TOKEN?.trim() ?? "";
}

async function telegramRequest<T>(
  method: string,
  body?: Record<string, unknown>,
): Promise<TelegramResponse<T>> {
  const token = botToken();
  if (!token) throw new Error("Telegram bot token is not configured.");

  const response = await fetch(`${TELEGRAM_API}/bot${token}/${method}`, {
    method: body ? "POST" : "GET",
    headers: body ? { "content-type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(15_000),
  });
  const result = (await response.json()) as TelegramResponse<T>;
  if (!response.ok || !result.ok) {
    throw new Error(result.description ?? `Telegram returned HTTP ${response.status}`);
  }
  return result;
}

async function telegramPhotoRequest<T>(
  method: "sendPhoto" | "editMessageMedia",
  fields: Record<string, string>,
  png: Buffer,
): Promise<TelegramResponse<T>> {
  const token = botToken();
  if (!token) throw new Error("Telegram bot token is not configured.");

  const form = new FormData();
  for (const [key, value] of Object.entries(fields)) form.set(key, value);
  form.set(
    "photo",
    new Blob([new Uint8Array(png)], { type: "image/png" }),
    "kalshi-market-chart.png",
  );
  const response = await fetch(`${TELEGRAM_API}/bot${token}/${method}`, {
    method: "POST",
    body: form,
    signal: AbortSignal.timeout(30_000),
  });
  const result = (await response.json()) as TelegramResponse<T>;
  if (!response.ok || !result.ok) {
    throw new Error(result.description ?? `Telegram returned HTTP ${response.status}`);
  }
  return result;
}

async function pollOnce() {
  if (pollInProgress || kalshiHttp.isPaused || !needsRestRecovery()) return;
  pollInProgress = true;
  const pollStartedAt = Date.now();
  const snapshot = liveCoverage.snapshot();
  const { boundary } = snapshot;

  try {
    const tradeFeed = await getTradesSince(boundary);
    await ingestTrades(tradeFeed, boundary);
    // Leave an overlap for delayed executions and second-resolution REST filters.
    liveCoverage.recoveredThrough(snapshot, pollStartedAt);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown Kalshi monitor error.";
    lastError = message;
    logger.warn({ error: message }, "Kalshi REST recovery failed");
  } finally {
    pollInProgress = false;
  }
}

/** Serialize REST recovery and stream batches; storage/outbox each deduplicate by trade ID. */
function ingestTrades(feed: KalshiTradeApi[], boundary: number | null, fromStream = false): Promise<void> {
  const next = ingestionChain.then(() => processTrades(feed, boundary, fromStream));
  ingestionChain = next.catch(() => {});
  return next;
}

async function processTrades(tradeFeed: KalshiTradeApi[], boundary: number | null, fromStream: boolean) {
    const [seriesIndex, settings] = await Promise.all([getSportsSeries(), readSettings()]);
    const allSportsTrades = tradeFeed
      .map((trade) => toPublicTrade(trade, seriesIndex))
      .filter((trade): trade is PublicTrade => trade !== undefined)
      .sort(
        (a, b) =>
          new Date(b.createdTime).getTime() -
          new Date(a.createdTime).getTime(),
      );

    const qualifyingTrades = allSportsTrades.filter(
      (trade) => trade.notional >= settings.minimumNotional,
    );
    const capturedTrades = allSportsTrades.filter(trade => shouldCaptureTrade(trade.notional));
    const newTrades =
      boundary === null
        ? []
        : capturedTrades.filter(
            (trade) => new Date(trade.createdTime).getTime() > boundary,
          );

    const contextCandidates = [
      ...qualifyingTrades.slice(0, 50),
      ...newTrades,
    ];
    const uniqueContextCandidates = Array.from(
      new Map(contextCandidates.map((trade) => [trade.tradeId, trade])).values(),
    );
    const enrichedCandidates = await Promise.all(
      uniqueContextCandidates.map(async (trade) => [
        trade.tradeId,
        await withTradeContext(trade),
      ] as const),
    );
    const enrichedByTradeId = new Map(enrichedCandidates);
    latestQualifyingTrades = [...new Map([...qualifyingTrades
      .slice(0, 50)
      .map((trade) => enrichedByTradeId.get(trade.tradeId) ?? trade),
      ...latestQualifyingTrades].map(trade => [trade.tradeId, trade])).values()]
      .sort((a, b) => Date.parse(b.createdTime) - Date.parse(a.createdTime)).slice(0, 50);

    if (settings.enabled && settings.chatId && botToken()) {
      for (const trade of newTrades) {
        const enrichedTrade = enrichedByTradeId.get(trade.tradeId) ?? trade;
        await db
          .insert(kalshiAlertsTable)
          .values({
            tradeId: enrichedTrade.tradeId,
            ticker: enrichedTrade.ticker,
            title: enrichedTrade.title,
            eventTitle: enrichedTrade.eventTitle,
            marketTitle: enrichedTrade.marketTitle,
            sport: enrichedTrade.sport,
            outcomeSide: enrichedTrade.outcomeSide,
            bookSide: enrichedTrade.bookSide,
            price: enrichedTrade.price,
            count: enrichedTrade.count,
            notional: enrichedTrade.notional,
            createdTime: new Date(enrichedTrade.createdTime),
            blockTrade: enrichedTrade.blockTrade,
            marketUrl: enrichedTrade.marketUrl,
          })
          .onConflictDoNothing();
      }
      // Historical imports can already have inserted the same trade. The separate
      // outbox deduplicates notifications independently of graph/history storage.
      await enqueueLiveNotifications(settings.chatId,
        liveNotificationTrades(newTrades, liveCoverage.notificationBoundary(boundary))
          .map(trade => trade.tradeId));
      kalshiLiveEvents.publish([...new Set(newTrades.map(trade => trade.ticker))],
        fromStream ? newTrades.filter(trade => Date.parse(trade.createdTime) >= Date.now() - 60_000)
          .map(trade => trade.tradeId) : []);
    }
    lastChecked = new Date().toISOString();
    // A concurrent metadata/status request may have activated a shared pause.
    if (!kalshiHttp.isPaused) lastError = null;
}

async function startTradeStream() {
  try {
    kalshiAuth = new KalshiAuth(process.env.KALSHI_API_KEY_ID ?? "", process.env.KALSHI_PRIVATE_KEY ?? "");
    // Seed metadata and establish the startup boundary without sending historical alerts.
    await getSportsSeries().catch(() => {
      logger.warn("Sports metadata temporarily unavailable; stream batches will retry enrichment");
    });
    await pollOnce();
    // Even if REST is temporarily unavailable, start WebSocket and retry catch-up later.
    liveCoverage.establishStartupBoundary();
    tradeStream = new KalshiTradeStream({
      auth: kalshiAuth,
      accept: trade => {
        // If REST metadata is temporarily unavailable, retain candidates rather
        // than lose them. Ingestion will validate sports before saving anything.
        if (!sportsSeries.size) {
          const execution = publicTradeExecution(trade);
          return !!execution && shouldCaptureTrade(execution.notional);
        }
        const parsed = toPublicTrade(trade, sportsSeries);
        return !!parsed && shouldCaptureTrade(parsed.notional);
      },
      batch: async (trades: StreamTrade[]) => {
        await ingestTrades(trades, liveStartedAt - 1, true);
        const oldest = Math.min(...trades.map(trade => Date.parse(trade.created_time)));
        // Never advance past a disconnected/sequence-gap window before REST
        // has covered it successfully.
        liveCoverage.streamPersisted(oldest, tradeStream?.live ?? false);
      },
      recovery: () => { liveCoverage.requestRecovery(); },
      checkpoint: timestamp => liveCoverage.streamPersisted(timestamp, tradeStream?.live ?? false),
      state: (live, message) => {
        streamError = live && message === "WebSocket conectado" ? null : message;
        if (live && !streamError && !kalshiHttp.isPaused) lastError = null;
        logger.info({ live, message }, "Kalshi live transport");
      },
    });
    tradeStream.start();
  } catch (error) {
    // Auth errors are deliberately sanitized in KalshiAuth; never log private keys.
    streamError = error instanceof Error ? error.message : "No se pudo iniciar Kalshi WebSocket.";
    logger.warn({ message: streamError }, "Kalshi WebSocket setup failed; REST recovery remains available");
  }
}

async function saveTelegramChatId(chatId: string) {
  if (!isOwnerChat(chatId)) return;
  await db
    .insert(kalshiMonitorSettingsTable)
    .values({
      id: 1,
      enabled: false,
      minimumNotional: DEFAULT_THRESHOLD,
      chatId,
    })
    .onConflictDoUpdate({
      target: kalshiMonitorSettingsTable.id,
      set: { chatId, updatedAt: new Date() },
    });
}

async function saveTelegramUpdateOffset(offset: number) {
  await db
    .insert(kalshiMonitorSettingsTable)
    .values({
      id: 1,
      enabled: false,
      minimumNotional: DEFAULT_THRESHOLD,
      chatId: null,
      telegramUpdateOffset: offset,
    })
    .onConflictDoUpdate({
      target: kalshiMonitorSettingsTable.id,
      set: { telegramUpdateOffset: offset },
    });
}

async function respondToTelegramUpdate(update: TelegramUpdate) {
  const incomingChat = update.callback_query?.message?.chat.id ?? update.message?.chat?.id;
  if (incomingChat == null || !isOwnerChat(String(incomingChat))) return;
  if (update.callback_query) {
    await telegramDashboard.callback(update.callback_query, await readSettings());
    return;
  }
  const message = update.message;
  const text = message?.text?.trim();
  const chat = message?.chat;
  if (!text || !/^\/(?:start|menu|sports)(?:@\w+)?(?:\s|$)/i.test(text) || !chat) return;

  const chatId = String(chat.id);
  if (/^\/start(?:@\w+)?(?:\s|$)/i.test(text)) await saveTelegramChatId(chatId);
  const settings = await readSettings();
  if (settings.chatId === chatId) await telegramDashboard.sync(settings, true);
}

async function pollTelegramUpdates(): Promise<boolean> {
  if (!botToken() || telegramPollInProgress) return false;
  telegramPollInProgress = true;

  try {
    const settings = await readSettings();
    const request: Record<string, unknown> = {
      limit: 100,
      timeout: 10,
      allowed_updates: ["message", "callback_query"],
    };
    if (settings.telegramUpdateOffset != null) {
      request.offset = settings.telegramUpdateOffset;
    }
    const result = await telegramRequest<TelegramUpdate[]>("getUpdates", request);

    for (const update of result.result ?? []) {
      try {
        await respondToTelegramUpdate(update);
      } catch (error) {
        const message =
          error instanceof Error ? error.message : "Telegram command handling failed.";
        logger.warn({ error: message }, "Telegram command handling failed");
      }

      if (typeof update.update_id === "number") {
        await saveTelegramUpdateOffset(update.update_id + 1);
      }
    }
    return true;
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Telegram update polling failed.";
    logger.warn({ error: message }, "Telegram update polling failed");
    return false;
  } finally {
    telegramPollInProgress = false;
  }
}

async function telegramPollingLoop() {
  const successful = await pollTelegramUpdates();
  setTimeout(
    () => void telegramPollingLoop(),
    successful ? 1_000 : 15_000,
  );
}

export function startKalshiMonitor() {
  if (monitorStarted) return;
  monitorStarted = true;
  // Calendar rollover and game completion refresh even when the trade feed fails
  // or there is no new execution. Telegram's serialized edits keep one message.
  let dashboardRefreshInProgress = false;
  const refreshDashboard = () => {
    if (dashboardRefreshInProgress) return;
    dashboardRefreshInProgress = true;
    void readSettings().then(async settings => {
      if (settings.chatId && botToken()) await telegramDashboard.sync(settings);
    }).catch(error => logger.warn({ error: error instanceof Error ? error.message : "Dashboard refresh failed" },
      "Telegram dashboard refresh failed")).finally(() => { dashboardRefreshInProgress = false; });
  };
  refreshDashboard();
  setInterval(refreshDashboard, POLL_INTERVAL_MS);
  void startTradeStream();
  setInterval(() => void pollOnce(), POLL_INTERVAL_MS);
  // Refresh sports metadata independently; the trade stream never needs REST per execution.
  setInterval(() => {
    if (!kalshiHttp.isPaused) void getSportsSeries().catch(() => {});
  }, SERIES_CACHE_MS);
  setInterval(() => {
    if (kalshiHttp.isPaused) return;
    void readSettings().then(async settings => {
      if (settings.enabled) await finalResultsWorker.tick();
    }).catch(error => logger.warn({ error: String(error) }, "Final result worker failed"));
  }, 5_000);
  // Official per-market resolutions for the ROI leaderboard. Same paced HTTP client,
  // shared 429 cooldown and production worker lock; never starts a second bot.
  setInterval(() => {
    if (kalshiHttp.isPaused) return;
    void readSettings().then(async settings => {
      if (settings.enabled) await marketSettlementWorker.tick();
    }).catch(error => logger.warn({ error: String(error) }, "Market settlement enrichment failed"));
  }, 30_000);
  setInterval(() => {
    if (kalshiHttp.isPaused) return;
    void readSettings().then(async settings => {
      if (settings.enabled) await gameStatusMonitor.tick();
    }).catch(error => logger.warn({ error: error instanceof Error ? error.message : "Game status worker failed" },
      "Game status worker failed"));
  }, 2000);
  // Independent of live polling: a large backfill must not block live trades or navigation.
  setInterval(() => {
    if (kalshiHttp.isPaused) return;
    void readSettings().then(async settings => {
      if (settings.enabled) await marketHistory.tick();
    }).catch(error => logger.warn({ error: error instanceof Error ? error.message : "History worker failed" },
      "Market history worker failed"));
  }, 2000);
  setInterval(() => {
    if (kalshiHttp.isPaused) return;
    void readSettings().then(async settings => {
      if (botToken()) await tradeNotifications.tick(settings);
    }).catch(error => logger.warn({ error: error instanceof Error ? error.message : "Notification worker failed" },
      "Telegram notification worker failed"));
  }, 3000);
  void telegramPollingLoop();
  logger.info({ intervalMs: POLL_INTERVAL_MS }, "Kalshi sports monitor started");
}

export async function getKalshiDashboard() {
  const settings = await readSettings();
  const [alertTotal] = await db
    .select({ value: count() })
    .from(kalshiAlertsTable)
    .where(gte(kalshiAlertsTable.notional, settings.minimumNotional));
  // Use durable executions rather than only the latest polling batch, which
  // may be empty after a restart or when no qualifying trade just occurred.
  const savedRecent = await db.select().from(kalshiAlertsTable)
    .where(gte(kalshiAlertsTable.notional, settings.minimumNotional))
    .orderBy(desc(kalshiAlertsTable.createdTime))
    .limit(50);
  const recentTrades: PublicTrade[] = savedRecent.map(trade => ({
    tradeId: trade.tradeId, ticker: trade.ticker, title: trade.title,
    eventTitle: trade.eventTitle ?? trade.title,
    marketTitle: trade.marketTitle ?? trade.title,
    sport: trade.sport, outcomeSide: trade.outcomeSide, bookSide: trade.bookSide,
    price: trade.price, count: trade.count, notional: trade.notional,
    createdTime: trade.createdTime.toISOString(), blockTrade: trade.blockTrade,
    marketUrl: trade.marketUrl,
  }));
  const status = !settings.enabled
    ? "paused"
    : !botToken() || !settings.chatId
      ? "setup_required"
      : lastError || streamError
        ? "error"
        : "running";

  // The published count represents trades made available in the one live
  // Telegram dashboard, not the number of separate messages.
  const [actuallySent] = await db
    .select({ value: count() })
    .from(kalshiAlertsTable)
    .where(and(
      isNotNull(kalshiAlertsTable.alertedAt),
      gte(kalshiAlertsTable.notional, settings.minimumNotional),
    ));

  return {
    enabled: settings.enabled,
    minimumNotional: settings.minimumNotional,
    chatId: settings.chatId,
    telegramConfigured: Boolean(botToken() && settings.chatId),
    status,
    lastChecked,
    lastError: lastError ?? streamError,
    qualifyingTrades: alertTotal?.value ?? 0,
    alertsSent: actuallySent?.value ?? 0,
    recentTrades,
  };
}

export async function saveKalshiSettings(settings: Settings) {
  if (!isOwnerChat(settings.chatId)) throw new Error("Telegram destination is owner-locked.");
  await db
    .insert(kalshiMonitorSettingsTable)
    .values({
      id: 1,
      enabled: settings.enabled,
      minimumNotional: settings.minimumNotional,
      chatId: settings.chatId,
    })
    .onConflictDoUpdate({
      target: kalshiMonitorSettingsTable.id,
      set: {
        enabled: settings.enabled,
        minimumNotional: settings.minimumNotional,
        chatId: settings.chatId,
        updatedAt: new Date(),
      },
    });
}

export async function findTelegramChat() {
  const settings = await readSettings();
  if (!settings.chatId) {
    return {
      found: false,
      chatId: null,
      displayName: null,
      message: "No chat is linked yet. Send /start to the bot and wait a moment for its reply.",
    };
  }
  return {
    found: true,
    chatId: settings.chatId,
    displayName: null,
    message: "Telegram chat linked. Save settings to use this destination.",
  };
}

export async function sendTelegramTest(chatId: string) {
  if (!isOwnerChat(chatId)) throw new Error("Telegram destination is owner-locked.");
  const settings = await readSettings();
  await telegramDashboard.sync({ ...settings, chatId }, true);
}
