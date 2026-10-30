import { index, integer, pgTable, text, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";

/** Durable enrichment, separate from executions and the notification outbox. */
export const kalshiMetadataJobsTable = pgTable("kalshi_metadata_jobs", {
  ticker: text("ticker").primaryKey(),
  attempts: integer("attempts").notNull().default(0),
  nextCheckAt: timestamp("next_check_at", { withTimezone: true }).notNull().defaultNow(),
  error: text("error"),
}, table => [index("kalshi_metadata_jobs_due_idx").on(table.nextCheckAt, table.attempts)]);
export const insertKalshiMetadataJobSchema = createInsertSchema(kalshiMetadataJobsTable);
export type KalshiMetadataJob = typeof kalshiMetadataJobsTable.$inferSelect;
