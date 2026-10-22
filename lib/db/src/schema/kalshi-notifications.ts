import { integer, pgTable, primaryKey, text, timestamp } from "drizzle-orm/pg-core";
import { kalshiAlertsTable } from "./kalshi-alerts";

// Separate from dashboard publication: editing a graph is not a push notification.
export const kalshiNotificationsTable = pgTable("kalshi_notifications", {
  chatId: text("chat_id").notNull(),
  tradeId: text("trade_id").notNull().references(() => kalshiAlertsTable.tradeId),
  queuedAt: timestamp("queued_at", { withTimezone: true }).notNull().defaultNow(),
  sentAt: timestamp("sent_at", { withTimezone: true }),
  skippedAt: timestamp("skipped_at", { withTimezone: true }),
  messageId: integer("message_id"),
  removedAt: timestamp("removed_at", { withTimezone: true }),
  attempts: integer("attempts").notNull().default(0),
  retryAt: timestamp("retry_at", { withTimezone: true }).notNull().defaultNow(),
  lastError: text("last_error"),
}, table => [primaryKey({ columns: [table.chatId, table.tradeId] })]);
