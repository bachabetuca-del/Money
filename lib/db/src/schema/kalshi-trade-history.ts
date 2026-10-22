import { integer, pgTable, text, timestamp } from "drizzle-orm/pg-core";

export const kalshiTradeHistoryTable = pgTable("kalshi_trade_history", {
  ticker: text("ticker").primaryKey(),
  phase: text("phase").notNull().default("live"),
  cursor: text("cursor"),
  snapshotAt: timestamp("snapshot_at", { withTimezone: true }).notNull(),
  sinceAt: timestamp("since_at", { withTimezone: true }),
  scanned: integer("scanned").notNull().default(0),
  error: text("error"),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});
