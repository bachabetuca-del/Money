import { integer, jsonb, pgTable, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";

/** One atomic, public metadata snapshot. No account fills or private fee data. */
export const kalshiFeeSnapshotsTable = pgTable("kalshi_fee_snapshots", {
  id: integer("id").primaryKey().default(1),
  snapshot: jsonb("snapshot").notNull(),
  checkedAt: timestamp("checked_at", { withTimezone: true }).notNull(),
});
export const insertKalshiFeeSnapshotSchema = createInsertSchema(kalshiFeeSnapshotsTable);
export type KalshiFeeSnapshot = typeof kalshiFeeSnapshotsTable.$inferSelect;
