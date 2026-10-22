import { db, kalshiAlertsTable, kalshiNotificationsTable as notifications } from "@workspace/db";
import { and, asc, desc, eq, gt, isNotNull, isNull, lte, ne, sql } from "drizzle-orm";
import { NOTIFICATION_THRESHOLD, type NotificationStore } from "./telegram-trade-notifications";

/** Called only with trades from the live polling window, never by the history importer. */
export async function enqueueLiveNotifications(chatId: string, tradeIds: string[]) {
  if (!tradeIds.length) return;
  await db.insert(notifications).values(tradeIds.map(tradeId => ({ chatId, tradeId })))
    .onConflictDoNothing({ target: [notifications.chatId, notifications.tradeId] });
}

export const tradeNotificationStore: NotificationStore = {
  async next(chatId, now) {
    const [row] = await db.select({ trade: kalshiAlertsTable, chatId: notifications.chatId,
      attempts: notifications.attempts }).from(notifications)
      .innerJoin(kalshiAlertsTable, eq(notifications.tradeId, kalshiAlertsTable.tradeId))
      .where(and(eq(notifications.chatId, chatId), isNull(notifications.sentAt), isNull(notifications.skippedAt),
        lte(notifications.retryAt, now), gt(kalshiAlertsTable.notional, NOTIFICATION_THRESHOLD)))
      .orderBy(asc(kalshiAlertsTable.createdTime), asc(notifications.queuedAt)).limit(1);
    return row ? { ...row.trade, chatId: row.chatId, attempts: row.attempts } : undefined;
  },
  async sent(job, messageId, now) {
    await db.update(notifications).set({ sentAt: now, messageId, lastError: null, retryAt: now })
      .where(and(eq(notifications.chatId, job.chatId), eq(notifications.tradeId, job.tradeId)));
  },
  async skipped(job, now) {
    await db.update(notifications).set({ skippedAt: now, lastError: null })
      .where(and(eq(notifications.chatId, job.chatId), eq(notifications.tradeId, job.tradeId)));
  },
  async failed(chatId, tradeId, lastError, retryAt) {
    await db.update(notifications).set({ lastError, retryAt, attempts: sql`${notifications.attempts} + 1` })
      .where(and(eq(notifications.chatId, chatId), eq(notifications.tradeId, tradeId)));
  },
  async latestMessageId(chatId) {
    const [row] = await db.select({ messageId: notifications.messageId }).from(notifications)
      .where(and(eq(notifications.chatId, chatId), isNotNull(notifications.sentAt), isNull(notifications.removedAt)))
      .orderBy(desc(notifications.sentAt), desc(notifications.messageId)).limit(1);
    return row?.messageId ?? undefined;
  },
  async cleanup(chatId, keep, now) {
    const rows = await db.select({ tradeId: notifications.tradeId, messageId: notifications.messageId })
      .from(notifications).where(and(eq(notifications.chatId, chatId), isNotNull(notifications.sentAt),
        isNotNull(notifications.messageId), ne(notifications.messageId, keep),
        isNull(notifications.removedAt), lte(notifications.retryAt, now)))
      .orderBy(asc(notifications.sentAt)).limit(5);
    return rows.map(row => ({ tradeId: row.tradeId, messageId: row.messageId! }));
  },
  async removed(chatId, tradeId, now) {
    await db.update(notifications).set({ removedAt: now, lastError: null })
      .where(and(eq(notifications.chatId, chatId), eq(notifications.tradeId, tradeId)));
  },
};
