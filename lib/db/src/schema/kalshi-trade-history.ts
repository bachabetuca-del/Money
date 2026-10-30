import { boolean, integer, pgTable, text, timestamp } from "drizzle-orm/pg-core";

export const kalshiTradeHistoryTable = pgTable("kalshi_trade_history", {
  ticker: text("ticker").primaryKey(),
  phase: text("phase").notNull().default("live"),
  cursor: text("cursor"),
  snapshotAt: timestamp("snapshot_at", { withTimezone: true }).notNull(),
  sinceAt: timestamp("since_at", { withTimezone: true }),
  scanned: integer("scanned").notNull().default(0),
  // Existing imports used >$5k; keep their coverage distinct from new $1k imports.
  captureMinimum: integer("capture_minimum").notNull().default(5000),
  auditVersion: integer("audit_version").notNull().default(0),
  finalPass: boolean("final_pass").notNull().default(false),
  auditedAt: timestamp("audited_at", { withTimezone: true }),
  error: text("error"),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});
