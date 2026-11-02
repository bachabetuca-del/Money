import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import type { GetKalshiNotificationsQueryParams, TelegramNotice, TelegramNotices } from "@workspace/api-zod";
import { ownerChatId } from "./owner-policy";
import { signalEvidenceSchema } from "./signal-evidence-schema";
import { publicDirection } from "./telegram-trade-direction";
import { notificationGameContext } from "./notification-game-context";

type Reader = Pick<typeof db, "execute">;
type Filters = Partial<ReturnType<typeof GetKalshiNotificationsQueryParams.parse>>;
const PAGE_SIZE = 25;
const iso = (value: unknown) => value == null ? null : new Date(value as string | Date).toISOString();
const finite = (value: unknown, minimum: number, maximum = Infinity) => {
  if (value == null) return null;
  const n = Number(value);
  return Number.isFinite(n) && n > minimum && n <= maximum ? n : null;
};

function kalshiUrl(value: string | null): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && ["kalshi.com", "www.kalshi.com"].includes(url.hostname) &&
      !url.username && !url.password ? url.href : null;
  } catch { return null; }
}

/** Sent deliveries only; old removed messages remain readable on the website.
 * The same immutable names/sport drive both filters and the displayed result.
 * There is deliberately no current ROI, fee or settlement join. */
function deliveries(chatId: string, now: Date) {
  return sql`WITH delivered AS (
    SELECT n.trade_id, n.sent_at, n.removed_at, s.evidence,
      coalesce(s.evidence->>'ticker', a.ticker) AS ticker,
      coalesce(s.evidence->'rule'->>'sport', a.sport, 'Deporte no disponible') AS sport,
      coalesce(s.evidence->>'eventTitle', a.event_title, 'Partido no disponible') AS event_title,
      coalesce(s.evidence->>'marketTitle', a.market_title, 'Apuesta no disponible') AS market_title,
      a.market_url, a.outcome_side, a.book_side, a.price, a.count AS contracts, a.notional, a.created_time
    FROM kalshi_notifications n
    LEFT JOIN kalshi_alerts a ON a.trade_id = n.trade_id
    LEFT JOIN kalshi_signals s ON s.trade_id = n.trade_id AND s.chat_id = n.chat_id
    WHERE n.chat_id = ${chatId} AND n.sent_at IS NOT NULL
      AND n.message_id IS NOT NULL AND n.sent_at <= ${now}
  )`;
}

export function notificationFeedRow(row: Record<string, unknown>, now = new Date()): TelegramNotice {
  // Missing old evidence is expected; corrupt evidence is not a license to
  // substitute today's ROI or mutable trade details for an original message.
  const frozen = row.evidence == null ? null : signalEvidenceSchema.parse(row.evidence);
  const sentAt = iso(row.sent_at);
  if (!sentAt) throw new Error("A notification feed row has no confirmed delivery.");
  if (frozen && Date.parse(frozen.capturedAt) > Date.parse(sentAt)) {
    throw new Error("Notification evidence was recorded after delivery.");
  }
  return {
    tradeId: String(row.trade_id), ticker: frozen?.ticker ?? String(row.ticker ?? ""),
    sport: frozen?.rule.sport ?? String(row.sport),
    eventTitle: frozen?.eventTitle ?? String(row.event_title),
    marketTitle: frozen?.marketTitle ?? String(row.market_title),
    side: frozen?.rule.side ?? publicDirection(row.outcome_side as string | null, undefined, row.book_side as string | null),
    price: frozen?.price ?? finite(row.price, 0, 1),
    contracts: frozen?.contracts ?? finite(row.contracts, 0),
    notional: frozen?.notional ?? finite(row.notional, 0),
    executedAt: frozen?.observedAt ?? iso(row.created_time), sentAt,
    marketUrl: kalshiUrl(frozen?.marketUrl ?? row.market_url as string | null),
    removedFromTelegram: row.removed_at != null,
    detailsSource: frozen ? "frozen" : "legacy",
    game: notificationGameContext(
      frozen?.ticker ?? String(row.ticker ?? ""),
      row.game_status as Record<string, unknown> | null,
      row.game_starts_at, now,
    ),
    roi: frozen ? {
      basis: frozen.rule.basis, roiPct: frozen.historicalRoiPct,
      grossRoiPct: frozen.historicalGrossRoiPct, netRoiPct: frozen.historicalNetRoiPct,
      games: frozen.historicalGames, trades: frozen.historicalTrades,
      historyAsOf: frozen.historyAsOf, capturedAt: frozen.capturedAt,
    } : null,
  };
}

/** Purely reads the existing outbox/evidence. Filtering and pagination cover
 * the entire saved owner history, not just a recent graph-sized sample. */
export async function loadTelegramNotifications(
  filters: Filters, chatId: string | null, now: Date,
  executor: Reader = db, workersPaused = process.env.BOT_WORKERS_ENABLED === "false",
): Promise<TelegramNotices> {
  const common = {
    generatedAt: now.toISOString(), workersPaused, chatConfigured: chatId !== null, pageSize: PAGE_SIZE,
  };
  if (!chatId) return {
    ...common, page: 1, total: 0, totalPages: 0, totalDelivered: 0, availableSports: [], rows: [],
  };
  const query = filters.q?.trim() ?? "", sport = filters.sport?.trim() || "all";
  // Treat user '%' and '_' as literal characters, not arbitrary LIKE matches.
  const pattern = `%${query.replace(/[\\%_]/g, "\\$&")}%`;
  const predicate = sql`${sport === "all" ? sql`true` : sql`sport = ${sport}`}
    AND ${query ? sql`concat_ws(' ', sport, event_title, market_title, ticker, trade_id) ILIKE ${pattern}` : sql`true`}`;
  const totals = await executor.execute(sql`${deliveries(chatId, now)}
    SELECT count(*)::int AS total_delivered,
      count(*) FILTER (WHERE ${predicate})::int AS total,
      coalesce(array_agg(DISTINCT sport ORDER BY sport), ARRAY[]::text[]) AS sports
    FROM delivered`);
  const summary = totals.rows[0];
  const total = Number(summary?.total ?? 0), totalPages = Math.ceil(total / PAGE_SIZE);
  const page = Math.max(1, Math.min(filters.page ?? 1, totalPages || 1));
  const records = await executor.execute(sql`${deliveries(chatId, now)}, selected AS (
      SELECT * FROM delivered WHERE ${predicate}
      ORDER BY sent_at DESC, trade_id ASC
      LIMIT ${PAGE_SIZE} OFFSET ${(page - 1) * PAGE_SIZE}
    )
    SELECT d.*, context.game_status, context.game_starts_at
    FROM selected d
    LEFT JOIN kalshi_game_status own ON own.ticker = d.ticker
    LEFT JOIN LATERAL (
      WITH candidates AS (
        SELECT g.* FROM kalshi_game_status g
        WHERE g.ticker = d.ticker
          OR g.milestone_id = coalesce(own.milestone_id,
            CASE WHEN d.evidence->>'gameIdentity' = 'milestone' THEN d.evidence->>'gameId' END)
          OR g.event_ticker = coalesce(own.event_ticker,
            CASE WHEN d.evidence->>'gameIdentity' IN ('event', 'ticker') THEN d.evidence->>'gameId' END,
            split_part(d.ticker, '-', 1) || '-' || nullif(split_part(d.ticker, '-', 2), ''))
      )
      SELECT
        (SELECT to_jsonb(c) FROM candidates c
          ORDER BY (c.state <> 'unknown' AND c.source <> 'market') DESC,
            c.checked_at DESC, c.ticker ASC LIMIT 1) AS game_status,
        (SELECT c.starts_at FROM candidates c WHERE c.starts_at IS NOT NULL
          ORDER BY c.checked_at DESC, c.ticker ASC LIMIT 1) AS game_starts_at
    ) context ON true
    ORDER BY d.sent_at DESC, d.trade_id ASC`);
  return {
    ...common, page, totalPages, total, totalDelivered: Number(summary?.total_delivered ?? 0),
    availableSports: (summary?.sports ?? []) as string[],
    rows: records.rows.map(row => notificationFeedRow(row, now)),
  };
}

export function getTelegramNotifications(filters: Filters, now = new Date()) {
  const chatId = ownerChatId();
  return db.transaction(tx => loadTelegramNotifications(filters, chatId, now, tx), {
    isolationLevel: "repeatable read", accessMode: "read only",
  });
}
