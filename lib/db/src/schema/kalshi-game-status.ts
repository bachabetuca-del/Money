import { boolean, pgTable, text, timestamp } from "drizzle-orm/pg-core";

export const kalshiGameStatusTable = pgTable("kalshi_game_status", {
  ticker: text("ticker").primaryKey(),
  eventTicker: text("event_ticker"),
  milestoneId: text("milestone_id"),
  state: text("state").notNull().default("unknown"),
  source: text("source").notNull().default("unknown"),
  marketStatus: text("market_status"),
  marketTerminal: boolean("market_terminal").notNull().default(false),
  startsAt: timestamp("starts_at", { withTimezone: true }),
  delayed: boolean("delayed").notNull().default(false),
  checkedAt: timestamp("checked_at", { withTimezone: true }).notNull().defaultNow(),
  nextCheckAt: timestamp("next_check_at", { withTimezone: true }).notNull().defaultNow(),
  error: text("error"),
});
