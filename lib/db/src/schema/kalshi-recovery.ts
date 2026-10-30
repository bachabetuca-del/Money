import { bigint, integer, pgTable, text, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";

export const kalshiRecoveryTable = pgTable("kalshi_recovery", {
  id: integer("id").primaryKey().default(1),
  checkpointAt: timestamp("checkpoint_at", { withTimezone: true }).notNull(),
  targetAt: timestamp("target_at", { withTimezone: true }),
  windowStartAt: timestamp("window_start_at", { withTimezone: true }),
  windowEndAt: timestamp("window_end_at", { withTimezone: true }),
  phase: text("phase").notNull().default("live"),
  cursor: text("cursor"),
  scanned: bigint("scanned", { mode: "number" }).notNull().default(0),
  error: text("error"),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});
export const insertKalshiRecoverySchema = createInsertSchema(kalshiRecoveryTable);
export type KalshiRecoveryRow = typeof kalshiRecoveryTable.$inferSelect;
