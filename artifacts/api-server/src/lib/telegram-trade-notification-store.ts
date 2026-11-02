import { db, kalshiAlertsTable, kalshiNotificationsTable as notifications,
  kalshiSignalsTable as signals } from "@workspace/db";
import { and, asc, desc, eq, gte, isNotNull, isNull, lte, ne, or, sql } from "drizzle-orm";
import { CAPTURE_MINIMUM } from "./kalshi-trade-bands";
import type { NotificationStore } from "./telegram-trade-notifications";
import { buildSignalEvidence } from "./signal-evaluation";
import { signalEvidenceSchema } from "./signal-evidence-schema";

export type NotificationDatabase = Pick<typeof db, "select" | "insert" | "update" | "execute">;

/** Called only with trades from the live polling window, never by the history importer. */
export async function enqueueLiveNotifications(
  chatId: string, tradeIds: string[], executor: NotificationDatabase = db, now = new Date(),
) {
  if (!tradeIds.length) return;
  // Immutable membership is assigned ONLY on first live enqueue. A legacy job,
  // duplicate, restart or historical correction never receives it afterwards.
  await executor.execute(sql`
    INSERT INTO kalshi_notifications (chat_id, trade_id, queued_at, evaluation_id)
    SELECT ${chatId}, a.trade_id, ${now},
      CASE WHEN a.created_time > e.activated_at AND a.created_time <= ${now}
        AND e.activated_at < ${now} THEN e.id ELSE NULL END
    FROM kalshi_alerts a LEFT JOIN kalshi_signal_evaluation e ON e.id = 1
    WHERE a.trade_id IN (${sql.join(tradeIds.map(id => sql`${id}`), sql`, `)})
    ON CONFLICT (chat_id, trade_id) DO NOTHING
  `);
}

export function createTradeNotificationStore(executor: NotificationDatabase = db): NotificationStore {
  return {
  async next(chatId, now) {
    const [row] = await executor.select({ trade: kalshiAlertsTable, chatId: notifications.chatId,
      attempts: notifications.attempts, queuedAt: notifications.queuedAt, evaluationId: notifications.evaluationId,
      evidence: signals.evidence }).from(notifications)
      .innerJoin(kalshiAlertsTable, eq(notifications.tradeId, kalshiAlertsTable.tradeId))
      .leftJoin(signals, and(eq(signals.tradeId, notifications.tradeId), eq(signals.chatId, notifications.chatId)))
      .where(and(eq(notifications.chatId, chatId), isNull(notifications.sentAt), isNull(notifications.skippedAt),
        lte(notifications.retryAt, now), or(isNotNull(signals.evidence), gte(kalshiAlertsTable.notional, CAPTURE_MINIMUM))))
      .orderBy(asc(kalshiAlertsTable.createdTime), asc(notifications.queuedAt)).limit(1);
    return row ? { ...row.trade, chatId: row.chatId, attempts: row.attempts, queuedAt: row.queuedAt,
      evaluationId: row.evaluationId,
      ...(row.evidence ? { evidence: signalEvidenceSchema.parse(row.evidence) } : {}) } : undefined;
  },
  async capture(job, roi, now) {
    const existing = async () => {
      const [row] = await executor.select({ evidence: signals.evidence }).from(signals)
        .where(and(eq(signals.chatId, job.chatId), eq(signals.tradeId, job.tradeId))).limit(1);
      return row ? signalEvidenceSchema.parse(row.evidence) : null;
    };
    const saved = await existing();
    if (saved) return saved;
    if (job.evaluationId == null) return null;
    const evidence = signalEvidenceSchema.parse(buildSignalEvidence(job, roi, now));
    await executor.execute(sql`
      INSERT INTO kalshi_signals (chat_id, trade_id, evaluation_id, ticker, game_id, captured_at, evidence)
      SELECT n.chat_id, n.trade_id, n.evaluation_id, ${evidence.ticker}, ${evidence.gameId}, ${now},
        ${JSON.stringify(evidence)}::jsonb
      FROM kalshi_notifications n
      JOIN kalshi_signal_evaluation e ON e.id = n.evaluation_id
      WHERE n.chat_id = ${job.chatId} AND n.trade_id = ${job.tradeId}
        AND n.evaluation_id = ${job.evaluationId} AND n.sent_at IS NULL AND n.skipped_at IS NULL
        AND n.queued_at > e.activated_at AND ${job.createdTime} > e.activated_at
        AND ${job.createdTime} <= n.queued_at AND n.queued_at <= ${now}
        AND NOT EXISTS (SELECT 1 FROM kalshi_market_settlements s
          WHERE s.ticker = ${evidence.ticker} AND s.terminal = true)
      ON CONFLICT (chat_id, trade_id) DO NOTHING
    `);
    return existing();
  },
  async sent(job, messageId, now) {
    await executor.update(notifications).set({ sentAt: now, messageId, lastError: null, retryAt: now })
      .where(and(eq(notifications.chatId, job.chatId), eq(notifications.tradeId, job.tradeId), isNull(notifications.sentAt)));
  },
  async skipped(job, now) {
    await executor.update(notifications).set({ skippedAt: now, lastError: null })
      .where(and(eq(notifications.chatId, job.chatId), eq(notifications.tradeId, job.tradeId)));
  },
  async failed(chatId, tradeId, lastError, retryAt) {
    await executor.update(notifications).set({ lastError, retryAt, attempts: sql`${notifications.attempts} + 1` })
      .where(and(eq(notifications.chatId, chatId), eq(notifications.tradeId, tradeId)));
  },
  async latestMessageId(chatId) {
    const [row] = await executor.select({ messageId: notifications.messageId }).from(notifications)
      .where(and(eq(notifications.chatId, chatId), isNotNull(notifications.sentAt), isNull(notifications.removedAt)))
      .orderBy(desc(notifications.sentAt), desc(notifications.messageId)).limit(1);
    return row?.messageId ?? undefined;
  },
  async cleanup(chatId, keep, now) {
    const rows = await executor.select({ tradeId: notifications.tradeId, messageId: notifications.messageId })
      .from(notifications).where(and(eq(notifications.chatId, chatId), isNotNull(notifications.sentAt),
        isNotNull(notifications.messageId), ne(notifications.messageId, keep),
        isNull(notifications.removedAt), lte(notifications.retryAt, now)))
      .orderBy(asc(notifications.sentAt)).limit(5);
    return rows.map(row => ({ tradeId: row.tradeId, messageId: row.messageId! }));
  },
  async removed(chatId, tradeId, now) {
    await executor.update(notifications).set({ removedAt: now, lastError: null })
      .where(and(eq(notifications.chatId, chatId), eq(notifications.tradeId, tradeId)));
  },
  };
}
export const tradeNotificationStore = createTradeNotificationStore();
