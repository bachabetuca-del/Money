import { boolean, index, integer, pgTable, text, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

/** Official market settlement, deliberately separate from the game's scoreboard. */
export const kalshiSettlementsTable = pgTable("kalshi_market_settlements", {
  ticker: text("ticker").primaryKey(),
  result: text("result"),
  terminal: boolean("terminal").notNull().default(false),
  historical: boolean("historical").notNull().default(false),
  priority: integer("priority").notNull().default(0),
  checkedAt: timestamp("checked_at", { withTimezone: true }).notNull().defaultNow(),
  nextCheckAt: timestamp("next_check_at", { withTimezone: true }).notNull().defaultNow(),
  error: text("error"),
}, table => [index("kalshi_market_settlements_due_idx").on(table.terminal, table.historical, table.nextCheckAt)]);
export const insertKalshiSettlementSchema = createInsertSchema(kalshiSettlementsTable);
export type InsertKalshiSettlement = z.infer<typeof insertKalshiSettlementSchema>;
export type KalshiSettlement = typeof kalshiSettlementsTable.$inferSelect;
