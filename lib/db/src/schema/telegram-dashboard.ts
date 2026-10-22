import { boolean, integer, pgTable, text, timestamp } from "drizzle-orm/pg-core";

export const telegramDashboardTable = pgTable("telegram_dashboard", {
  chatId: text("chat_id").primaryKey(),
  messageId: integer("message_id"),
  screen: text("screen").notNull().default("sports"),
  band: text("band").notNull().default("large"),
  sportKey: text("sport_key"),
  gameKey: text("game_key"),
  ticker: text("ticker"),
  page: integer("page").notNull().default(0),
  contentHash: text("content_hash"),
  cleanupComplete: boolean("cleanup_complete").notNull().default(false),
  cleanupWarning: text("cleanup_warning"),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});
