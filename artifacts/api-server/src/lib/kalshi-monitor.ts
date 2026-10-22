import {
  and,
  asc,
  count,
  eq,
  gte,
  inArray,
  isNotNull,
  isNull,
} from "drizzle-orm";
import sharp from "sharp";
import {
  db,
  kalshiAlertsTable,
  kalshiMonitorSettingsTable,
  kalshiTelegramChartsTable,
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

type PublicTrade = {
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

type TelegramMessage = {
  message_id: number;
};

type TelegramUpdate = {
  update_id?: number;
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
let telegramPollInProgress = false;
const tradeContextCache = new Map<
  string,
  Promise<{ eventTitle: string; marketTitle: string }>
>();
const eventTitleCache = new Map<string, Promise<string>>();

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
    eventTitle: series.title,
    marketTitle: trade.ticker,
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

async function withTradeContext(trade: PublicTrade): Promise<PublicTrade> {
  let contextPromise = tradeContextCache.get(trade.ticker);
  if (!contextPromise) {
    contextPromise = (async () => {
      try {
        const marketResponse = await fetchJson<{ market: KalshiMarketMetadata }>(
          `${KALSHI_API}/markets/${encodeURIComponent(trade.ticker)}`,
        );
        const market = marketResponse.market;
        let eventTitle = trade.eventTitle;

        if (market.event_ticker) {
          let eventTitlePromise = eventTitleCache.get(market.event_ticker);
          if (!eventTitlePromise) {
            eventTitlePromise = fetchJson<{ event: KalshiEventMetadata }>(
              `${KALSHI_API}/events/${encodeURIComponent(market.event_ticker)}`,
            )
              .then(
                ({ event }) =>
                  event.title ?? event.sub_title ?? trade.eventTitle,
              )
              .catch(() => trade.eventTitle);
            if (eventTitleCache.size >= 5_000) eventTitleCache.clear();
            eventTitleCache.set(market.event_ticker, eventTitlePromise);
          }
          eventTitle = await eventTitlePromise;
        }

        return {
          eventTitle,
          marketTitle:
            market.title ??
            market.yes_sub_title ??
            market.no_sub_title ??
            trade.marketTitle,
        };
      } catch (error) {
        logger.debug(
          {
            ticker: trade.ticker,
            error: error instanceof Error ? error.message : "Metadata unavailable",
          },
          "Using ticker fallback for trade context",
        );
        return {
          eventTitle: trade.eventTitle,
          marketTitle: trade.marketTitle,
        };
      }
    })();
    if (tradeContextCache.size >= 5_000) tradeContextCache.clear();
    tradeContextCache.set(trade.ticker, contextPromise);
  }

  const context = await contextPromise;
  return {
    ...trade,
    ...context,
    title: `${context.eventTitle} · ${context.marketTitle}`,
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

function escapeTelegramHtml(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function escapeXml(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function tradeChartCaption(
  trades: (typeof kalshiAlertsTable.$inferSelect)[],
  minimumNotional: number,
) {
  const newest = trades[trades.length - 1];
  return [
    `🏈 <b>${escapeTelegramHtml(newest.eventTitle ?? newest.title)}</b>`,
    `<b>Market:</b> ${escapeTelegramHtml(newest.marketTitle ?? newest.ticker)}`,
    `<b>Qualifying trades:</b> ${trades.length.toLocaleString("en-US")} · threshold $${minimumNotional.toLocaleString("en-US")}`,
    `<a href="${escapeTelegramHtml(newest.marketUrl)}">Open this market in Kalshi</a>`,
    "<i>Each dot is a public trade; color shows taker position and size shows trade value. Public data does not identify buyers.</i>",
  ].join("\n");
}

function tradeChartSvg(
  trades: (typeof kalshiAlertsTable.$inferSelect)[],
) {
  const width = 1200;
  const height = 720;
  const left = 112;
  const right = 1148;
  const top = 208;
  const bottom = 590;
  const plotWidth = right - left;
  const plotHeight = bottom - top;
  const visibleTrades = trades.slice(-100);
  const times = visibleTrades.map((trade) => trade.createdTime.getTime());
  const minTime = Math.min(...times);
  const maxTime = Math.max(...times);
  const eventTitle = escapeXml(
    visibleTrades[visibleTrades.length - 1].eventTitle ??
      visibleTrades[visibleTrades.length - 1].title,
  );
  const marketTitle = escapeXml(
    visibleTrades[visibleTrades.length - 1].marketTitle ??
      visibleTrades[visibleTrades.length - 1].ticker,
  );
  const points = visibleTrades
    .map((trade) => {
      const time = trade.createdTime.getTime();
      const x =
        minTime === maxTime
          ? left + plotWidth / 2
          : left + ((time - minTime) / (maxTime - minTime)) * plotWidth;
      const priceCents = Math.max(0, Math.min(100, trade.price * 100));
      const y = bottom - (priceCents / 100) * plotHeight;
      const radius = Math.max(7, Math.min(19, 5 + Math.sqrt(trade.notional / 1000)));
      const color = trade.outcomeSide === "no" ? "#E98E2E" : "#1F74AD";
      const title = `${trade.outcomeSide.toUpperCase()} · ${priceCents.toFixed(1)}¢ · $${trade.notional.toLocaleString("en-US", { maximumFractionDigits: 0 })} · ${trade.createdTime.toISOString()}`;
      return `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="${radius.toFixed(1)}" fill="${color}" fill-opacity="0.82" stroke="#FFFFFF" stroke-width="2"><title>${escapeXml(title)}</title></circle>`;
    })
    .join("");
  const grid = [0, 25, 50, 75, 100]
    .map((value) => {
      const y = bottom - (value / 100) * plotHeight;
      return `<line x1="${left}" y1="${y}" x2="${right}" y2="${y}" stroke="#E2E8F0" stroke-width="2"/><text x="${left - 18}" y="${y + 7}" text-anchor="end" font-size="20" fill="#64748B">${value}¢</text>`;
    })
    .join("");
  const formatTime = (time: number) =>
    new Date(time).toLocaleString("en-US", {
      timeZone: "America/New_York",
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    });
  const periodLabel =
    minTime === maxTime
      ? formatTime(minTime)
      : `${formatTime(minTime)} — ${formatTime(maxTime)}`;
  const truncatedLabel =
    trades.length > visibleTrades.length
      ? `Latest ${visibleTrades.length} of ${trades.length.toLocaleString("en-US")} qualifying trades`
      : `${trades.length.toLocaleString("en-US")} qualifying trades`;

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
  <rect width="100%" height="100%" rx="28" fill="#FFFFFF"/>
  <text x="56" y="68" font-family="Arial, sans-serif" font-size="30" font-weight="700" fill="#0F172A">${eventTitle}</text>
  <text x="56" y="112" font-family="Arial, sans-serif" font-size="25" fill="#334155">${marketTitle}</text>
  <text x="56" y="158" font-family="Arial, sans-serif" font-size="19" fill="#64748B">${escapeXml(truncatedLabel)} · price and trade size</text>
  <circle cx="78" cy="186" r="9" fill="#1F74AD"/><text x="97" y="193" font-family="Arial, sans-serif" font-size="18" fill="#334155">YES</text>
  <circle cx="180" cy="186" r="9" fill="#E98E2E"/><text x="199" y="193" font-family="Arial, sans-serif" font-size="18" fill="#334155">NO</text>
  <text x="${right}" y="193" text-anchor="end" font-family="Arial, sans-serif" font-size="17" fill="#64748B">Larger dot = larger trade</text>
  ${grid}
  <line x1="${left}" y1="${top}" x2="${left}" y2="${bottom}" stroke="#94A3B8" stroke-width="2"/>
  <line x1="${left}" y1="${bottom}" x2="${right}" y2="${bottom}" stroke="#94A3B8" stroke-width="2"/>
  ${points}
  <text x="${left}" y="${bottom + 38}" font-family="Arial, sans-serif" font-size="17" fill="#64748B">${escapeXml(formatTime(minTime))}</text>
  <text x="${right}" y="${bottom + 38}" text-anchor="end" font-family="Arial, sans-serif" font-size="17" fill="#64748B">${escapeXml(formatTime(maxTime))}</text>
  <text x="${(left + right) / 2}" y="672" text-anchor="middle" font-family="Arial, sans-serif" font-size="18" fill="#475569">${escapeXml(periodLabel)} · New York time</text>
</svg>`;
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

async function deliverTradeChart(
  chatId: string,
  ticker: string,
  trades: (typeof kalshiAlertsTable.$inferSelect)[],
  minimumNotional: number,
) {
  if (trades.length === 0) throw new Error("Cannot render an empty trade chart.");
  const newest = trades[trades.length - 1];
  const png = await sharp(Buffer.from(tradeChartSvg(trades)))
    .png()
    .toBuffer();
  const savedChart = await db
    .select()
    .from(kalshiTelegramChartsTable)
    .where(eq(kalshiTelegramChartsTable.ticker, ticker))
    .limit(1);
  const existing = savedChart[0];
  const caption = tradeChartCaption(trades, minimumNotional);
  let messageId: number;

  if (existing && existing.chatId === chatId) {
    await telegramPhotoRequest("editMessageMedia", {
      chat_id: chatId,
      message_id: String(existing.messageId),
      media: JSON.stringify({
        type: "photo",
        media: "attach://photo",
        caption,
        parse_mode: "HTML",
      }),
    }, png);
    messageId = existing.messageId;
  } else {
    const sent = await telegramPhotoRequest<TelegramMessage>(
      "sendPhoto",
      {
        chat_id: chatId,
        caption,
        parse_mode: "HTML",
      },
      png,
    );
    if (!sent.result?.message_id) {
      throw new Error("Telegram did not return a message ID for the chart.");
    }
    messageId = sent.result.message_id;
  }

  await db
    .insert(kalshiTelegramChartsTable)
    .values({
      ticker,
      chatId,
      messageId,
      marketUrl: newest.marketUrl,
      updatedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: kalshiTelegramChartsTable.ticker,
      set: {
        chatId,
        messageId,
        marketUrl: newest.marketUrl,
        updatedAt: new Date(),
      },
    });
}

async function deliverPendingAlerts(settings: Settings) {
  if (!settings.enabled || !settings.chatId || !botToken()) return;

  const pending = await db
    .select()
    .from(kalshiAlertsTable)
    .where(isNull(kalshiAlertsTable.alertedAt))
    .orderBy(kalshiAlertsTable.createdTime)
    .limit(ALERTS_PER_CYCLE);

  const byMarket = new Map<string, typeof pending>();
  for (const alert of pending) {
    const marketAlerts = byMarket.get(alert.ticker) ?? [];
    marketAlerts.push(alert);
    byMarket.set(alert.ticker, marketAlerts);
  }

  for (const [ticker, marketAlerts] of byMarket) {
    try {
      const chartTrades = await db
        .select()
        .from(kalshiAlertsTable)
        .where(eq(kalshiAlertsTable.ticker, ticker))
        .orderBy(asc(kalshiAlertsTable.createdTime));
      await deliverTradeChart(
        settings.chatId,
        ticker,
        chartTrades,
        settings.minimumNotional,
      );
      await db
        .update(kalshiAlertsTable)
        .set({ alertedAt: new Date() })
        .where(
          inArray(
            kalshiAlertsTable.tradeId,
            marketAlerts.map((alert) => alert.tradeId),
          ),
        );
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Telegram delivery failed.";
      lastError = `Telegram delivery failed: ${message}`;
      logger.warn({ ticker, error: message }, "Trade chart delivery failed");
    }
  }
}

async function deliverRecentMarketCharts(settings: Settings) {
  if (!settings.enabled || !settings.chatId || !botToken()) return;

  const recentCutoff = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const recentDeliveredTrades = await db
    .select()
    .from(kalshiAlertsTable)
    .where(
      and(
        gte(kalshiAlertsTable.createdTime, recentCutoff),
        isNotNull(kalshiAlertsTable.alertedAt),
      ),
    )
    .orderBy(asc(kalshiAlertsTable.createdTime));
  const byMarket = new Map<string, typeof recentDeliveredTrades>();
  for (const trade of recentDeliveredTrades) {
    const marketTrades = byMarket.get(trade.ticker) ?? [];
    marketTrades.push(trade);
    byMarket.set(trade.ticker, marketTrades);
  }

  for (const [ticker] of byMarket) {
    const [savedChart] = await db
      .select()
      .from(kalshiTelegramChartsTable)
      .where(eq(kalshiTelegramChartsTable.ticker, ticker))
      .limit(1);
    if (savedChart?.chatId === settings.chatId) continue;

    try {
      const chartTrades = await db
        .select()
        .from(kalshiAlertsTable)
        .where(eq(kalshiAlertsTable.ticker, ticker))
        .orderBy(asc(kalshiAlertsTable.createdTime));
      await deliverTradeChart(
        settings.chatId,
        ticker,
        chartTrades,
        settings.minimumNotional,
      );
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Telegram chart delivery failed.";
      lastError = `Telegram chart delivery failed: ${message}`;
      logger.warn({ ticker, error: message }, "Recent market chart delivery failed");
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
    const newTrades =
      lastPollBoundary === null
        ? []
        : qualifyingTrades.filter(
            (trade) => new Date(trade.createdTime).getTime() > lastPollBoundary!,
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
    latestQualifyingTrades = qualifyingTrades
      .slice(0, 50)
      .map((trade) => enrichedByTradeId.get(trade.tradeId) ?? trade);

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
      await deliverPendingAlerts(settings);
      await deliverRecentMarketCharts(settings);
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

async function saveTelegramChatId(chatId: string) {
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
  const message = update.message;
  const text = message?.text?.trim();
  const chat = message?.chat;
  if (!text || !/^\/start(?:@\w+)?(?:\s|$)/i.test(text) || !chat) return;

  const chatId = String(chat.id);
  await saveTelegramChatId(chatId);
  await telegramRequest("sendMessage", {
    chat_id: chatId,
    text: [
      "Kalshi Sports Alerts is connected to this chat.",
      "",
      "Open the dashboard, enable the monitor, and save settings to start receiving alerts. The default threshold is $10,000 per trade.",
      "",
      "Alerts use public market trades and do not identify individual buyers.",
    ].join("\n"),
    disable_web_page_preview: true,
  });
}

async function pollTelegramUpdates(): Promise<boolean> {
  if (!botToken() || telegramPollInProgress) return false;
  telegramPollInProgress = true;

  try {
    const settings = await readSettings();
    const request: Record<string, unknown> = {
      limit: 100,
      timeout: 10,
      allowed_updates: ["message"],
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
  void pollOnce();
  setInterval(() => void pollOnce(), POLL_INTERVAL_MS);
  void telegramPollingLoop();
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
  await telegramRequest("sendMessage", {
    chat_id: chatId,
    text: "Kalshi Sports Alerts test message. Telegram delivery is connected.",
    disable_web_page_preview: true,
  });
}
