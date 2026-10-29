import { jsonb, pgTable, text, timestamp } from "drizzle-orm/pg-core";

/** One latest, manually requested report per selected bet; no bot-side AI loop. */
export const kalshiAnalysisTable = pgTable("kalshi_analysis", {
  ticker: text("ticker").primaryKey(),
  report: jsonb("report").notNull(),
  generatedAt: timestamp("generated_at", { withTimezone: true }).notNull().defaultNow(),
});
