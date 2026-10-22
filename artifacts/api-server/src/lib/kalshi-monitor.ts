import { count, eq, isNotNull, isNull } from "drizzle-orm";
import {
  db,
  kalshiAlertsTable,
  kalshiMonitorSettingsTable,
} from "@workspace/db";
import { logger } from "./logger";

const KALSHI_API = "https://external-api.kalshi.com/trade-api/v2";
const TELEGRAM_API = "https://api.telegram.org";
const DEFAULT_THRESHOLD = 10_000;
const POLL_INTERVAL_MS = 15_000;
const SERIES_CACHE_MS = 60 * 60 * 1000;
const ALERTS_PER_CYCLE = 20;

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

type PublicTrade = {
  tradeId: string;
  ticker: string;
  title: string;
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
};

type TelegramResponse<T> = {
  ok: boolean;
  result?: T;
  description?: string;
};

type TelegramUpdate = {
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
let lastPollBoundary: number | null = null;
let pollInProgress = false;
let monitorStarted = false;

async function fetchJson<T>(url: string): Promise<T> {
  const response = await fetch(url, { signal: AbortSignal.timeout(15_000) });
  if (!response.ok) {
    throw new Error(`Kalshi returned HTTP ${response.status}`);
  }
  return (await response.json()) as T;
}

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

function dollars(rawDollars: string | undefined, cents: number | undefined) {
  if (rawDollars !== undefined) return Number(rawDollars);
  return typeof cents === "number" ? cents / 100 : Number.NaN;
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

  const outcomeSide = (
    trade.taker_outcome_side ??
    trade.taker_side ??
    "unknown"
  ).toLowerCase();
  const price =
    outcomeSide === "no"
      ? dollars(trade.no_price_dollars, trade.no_price)
      : dollars(trade.yes_price_dollars, trade.yes_price);
  const count = Number(trade.count_fp ?? trade.count);
  const notional = price * count;
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
    sport: series.tags?.[0] ?? series.title,
    outcomeSide,
    bookSide: (trade.taker_book_side ?? "unknown").toLowerCase(),
    price,
    count,
    notional: Math.round(notional * 100) / 100,
    createdTime: createdAt.toISOString(),
    blockTrade: trade.is_block_trade ?? false,
    marketUrl: `https://kalshi.com/markets/${series.ticker}/${trade.ticker}`,
  };
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
    chatId: saved?.chatId ?? null,
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

function alertText(trade: PublicTrade) {
  return [
    "Kalshi sports trade alert",
    "",
    trade.title,
    `Estimated trade value: $${trade.notional.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`,
    `${trade.count.toLocaleString("en-US")} contracts × $${trade.price.toFixed(4)}`,
    `Public taker details: ${trade.outcomeSide} outcome / ${trade.bookSide} book side`,
    `Time: ${new Date(trade.createdTime).toLocaleString("en-US", { timeZone: "UTC", timeZoneName: "short" })}`,
    "",
    "Public trade data does not identify an individual buyer or account.",
    trade.marketUrl,
  ].join("\n");
}

async function deliverPendingAlerts(settings: Settings) {
  if (!settings.enabled || !settings.chatId || !botToken()) return;

  const pending = await db
    .select()
    .from(kalshiAlertsTable)
    .where(isNull(kalshiAlertsTable.alertedAt))
    .orderBy(kalshiAlertsTable.createdTime)
    .limit(ALERTS_PER_CYCLE);

  for (const alert of pending) {
    try {
      await telegramRequest("sendMessage", {
        chat_id: settings.chatId,
        text: alertText({
          tradeId: alert.tradeId,
          ticker: alert.ticker,
          title: alert.title,
          sport: alert.sport,
          outcomeSide: alert.outcomeSide,
          bookSide: alert.bookSide,
          price: alert.price,
          count: alert.count,
          notional: alert.notional,
          createdTime: alert.createdTime.toISOString(),
          blockTrade: alert.blockTrade,
          marketUrl: alert.marketUrl,
        }),
        disable_web_page_preview: true,
      });
      await db
        .update(kalshiAlertsTable)
        .set({ alertedAt: new Date() })
        .where(eq(kalshiAlertsTable.tradeId, alert.tradeId));
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Telegram delivery failed.";
      lastError = `Telegram delivery failed: ${message}`;
      logger.warn({ tradeId: alert.tradeId, error: message }, "Alert delivery failed");
      break;
    }
  }
}

async function pollOnce() {
  if (pollInProgress) return;
  pollInProgress = true;
  const pollStartedAt = Date.now();

  try {
    const [seriesIndex, tradeFeed, settings] = await Promise.all([
      getSportsSeries(),
      getTradesSince(lastPollBoundary),
      readSettings(),
    ]);

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
    latestQualifyingTrades = qualifyingTrades.slice(0, 50);

    const newTrades =
      lastPollBoundary === null
        ? []
        : qualifyingTrades.filter(
            (trade) => new Date(trade.createdTime).getTime() > lastPollBoundary!,
          );

    if (settings.enabled && settings.chatId && botToken()) {
      for (const trade of newTrades) {
        await db
          .insert(kalshiAlertsTable)
          .values({
            tradeId: trade.tradeId,
            ticker: trade.ticker,
            title: trade.title,
            sport: trade.sport,
            outcomeSide: trade.outcomeSide,
            bookSide: trade.bookSide,
            price: trade.price,
            count: trade.count,
            notional: trade.notional,
            createdTime: new Date(trade.createdTime),
            blockTrade: trade.blockTrade,
            marketUrl: trade.marketUrl,
          })
          .onConflictDoNothing();
      }
      await deliverPendingAlerts(settings);
    }
    lastPollBoundary = pollStartedAt;
    lastChecked = new Date().toISOString();
    lastError = null;
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Unknown Kalshi monitor error.";
    lastError = message;
    logger.warn({ error: message }, "Kalshi monitor poll failed");
  } finally {
    pollInProgress = false;
  }
}

export function startKalshiMonitor() {
  if (monitorStarted) return;
  monitorStarted = true;
  void pollOnce();
  setInterval(() => void pollOnce(), POLL_INTERVAL_MS);
  logger.info({ intervalMs: POLL_INTERVAL_MS }, "Kalshi sports monitor started");
}

export async function getKalshiDashboard() {
  const settings = await readSettings();
  const [alertTotal] = await db
    .select({ value: count() })
    .from(kalshiAlertsTable);
  const recentTrades = latestQualifyingTrades.slice(0, 50);
  const status = !settings.enabled
    ? "paused"
    : !botToken() || !settings.chatId
      ? "setup_required"
      : lastError
        ? "error"
        : "running";

  // The alert log total is the count of qualifying trades that were queued;
  // the separate sent count tracks successful Telegram deliveries.
  const [actuallySent] = await db
    .select({ value: count() })
    .from(kalshiAlertsTable)
    .where(isNotNull(kalshiAlertsTable.alertedAt));

  return {
    enabled: settings.enabled,
    minimumNotional: settings.minimumNotional,
    chatId: settings.chatId,
    telegramConfigured: Boolean(botToken() && settings.chatId),
    status,
    lastChecked,
    lastError,
    qualifyingTrades: alertTotal?.value ?? 0,
    alertsSent: actuallySent?.value ?? 0,
    recentTrades,
  };
}

export async function saveKalshiSettings(settings: Settings) {
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
  const result = await telegramRequest<TelegramUpdate[]>("getUpdates", {
    limit: 100,
    allowed_updates: ["message"],
  });
  const updates = result.result ?? [];
  const startUpdate = [...updates]
    .reverse()
    .find((update) => update.message?.text?.trim().startsWith("/start"));
  const chat = startUpdate?.message?.chat;
  if (!chat) {
    return {
      found: false,
      chatId: null,
      displayName: null,
      message:
        "No recent /start message found. Open your bot in Telegram and send /start, then try again.",
    };
  }
  const displayName =
    chat.title ??
    [chat.first_name, chat.last_name].filter(Boolean).join(" ") ??
    chat.username ??
    null;
  return {
    found: true,
    chatId: String(chat.id),
    displayName: displayName || chat.username || null,
    message: "Telegram chat found. Save settings to use this destination.",
  };
}

export async function sendTelegramTest(chatId: string) {
  await telegramRequest("sendMessage", {
    chat_id: chatId,
    text: "Kalshi Sports Alerts test message. Telegram delivery is connected.",
    disable_web_page_preview: true,
  });
}
