import { index, integer, jsonb, pgTable, primaryKey, text, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { kalshiAlertsTable } from "./kalshi-alerts";

/** Created once by the lock-owning bot runtime, never by a dashboard read/migration. */
export const kalshiSignalEvaluationTable = pgTable("kalshi_signal_evaluation", {
  id: integer("id").primaryKey().default(1),
  activatedAt: timestamp("activated_at", { withTimezone: true }).notNull().defaultNow(),
});
export const insertKalshiSignalEvaluationSchema = createInsertSchema(kalshiSignalEvaluationTable);
export type KalshiSignalEvaluation = typeof kalshiSignalEvaluationTable.$inferSelect;

/** Append-only evidence. Outcomes are a read-only join to the existing official
 * settlements and delivery outbox; history repair must never rewrite this JSON. */
export const kalshiSignalsTable = pgTable("kalshi_signals", {
  chatId: text("chat_id").notNull(),
  tradeId: text("trade_id").notNull().references(() => kalshiAlertsTable.tradeId),
  evaluationId: integer("evaluation_id").notNull().references(() => kalshiSignalEvaluationTable.id),
  ticker: text("ticker").notNull(),
  gameId: text("game_id").notNull(),
  capturedAt: timestamp("captured_at", { withTimezone: true }).notNull(),
  evidence: jsonb("evidence").notNull(),
}, table => [
  primaryKey({ columns: [table.chatId, table.tradeId] }),
  index("kalshi_signals_captured_idx").on(table.capturedAt.desc(), table.tradeId),
  index("kalshi_signals_ticker_idx").on(table.ticker),
]);
export const insertKalshiSignalSchema = createInsertSchema(kalshiSignalsTable);
export type InsertKalshiSignal = typeof kalshiSignalsTable.$inferInsert;
export type KalshiSignal = typeof kalshiSignalsTable.$inferSelect;
