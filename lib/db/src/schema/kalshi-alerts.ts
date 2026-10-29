import {
  boolean,
  bigint,
  integer,
  index,
  numeric,
  pgTable,
  text,
  timestamp,
} from "drizzle-orm/pg-core";

export const kalshiMonitorSettingsTable = pgTable("kalshi_monitor_settings", {
  id: integer("id").primaryKey().default(1),
  enabled: boolean("enabled").notNull().default(false),
  minimumNotional: numeric("minimum_notional", {
    precision: 14,
    scale: 2,
    mode: "number",
  })
    .notNull()
    .default(10000),
  chatId: text("chat_id"),
  telegramUpdateOffset: bigint("telegram_update_offset", { mode: "number" }),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const kalshiAlertsTable = pgTable("kalshi_alerts", {
  tradeId: text("trade_id").primaryKey(),
  ticker: text("ticker").notNull(),
  title: text("title").notNull(),
  eventTitle: text("event_title"),
  marketTitle: text("market_title"),
  sport: text("sport").notNull(),
  outcomeSide: text("outcome_side").notNull(),
  bookSide: text("book_side").notNull(),
  price: numeric("price", { precision: 10, scale: 4, mode: "number" }).notNull(),
  count: numeric("count", { precision: 14, scale: 2, mode: "number" }).notNull(),
  notional: numeric("notional", {
    precision: 14,
    scale: 2,
    mode: "number",
  }).notNull(),
  createdTime: timestamp("created_time", { withTimezone: true }).notNull(),
  blockTrade: boolean("block_trade").notNull().default(false),
  marketUrl: text("market_url").notNull(),
  alertedAt: timestamp("alerted_at", { withTimezone: true }),
  savedAt: timestamp("saved_at", { withTimezone: true }).notNull().defaultNow(),
}, table => [
  index("kalshi_alerts_ticker_time_trade_idx").on(table.ticker, table.createdTime.desc(), table.tradeId),
  index("kalshi_alerts_notional_idx").on(table.notional),
]);

export const kalshiTelegramChartsTable = pgTable("kalshi_telegram_charts", {
  ticker: text("ticker").primaryKey(),
  chatId: text("chat_id").notNull(),
  messageId: integer("message_id").notNull(),
  renderVersion: integer("render_version").notNull().default(0),
  retiredAt: timestamp("retired_at", { withTimezone: true }),
  marketUrl: text("market_url").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});
