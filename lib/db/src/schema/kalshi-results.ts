import { integer, pgTable, text, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

/** Final-result enrichment is separate from stopped live-game monitoring. */
export const kalshiResultsTable = pgTable("kalshi_results", {
  ticker: text("ticker").primaryKey(),
  gameResult: text("game_result"),
  marketResult: text("market_result"),
  attempts: integer("attempts").notNull().default(0),
  checkedAt: timestamp("checked_at", { withTimezone: true }),
  nextCheckAt: timestamp("next_check_at", { withTimezone: true }).notNull().defaultNow(),
  error: text("error"),
});
export const insertKalshiResultSchema = createInsertSchema(kalshiResultsTable);
export type InsertKalshiResult = z.infer<typeof insertKalshiResultSchema>;
export type KalshiResult = typeof kalshiResultsTable.$inferSelect;
