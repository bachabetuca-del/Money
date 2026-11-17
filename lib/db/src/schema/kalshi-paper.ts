import { pgTable, uuid, text, timestamp, jsonb, integer, index, uniqueIndex } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

// No default activation and no cascade deletes: trial evidence survives pauses.
export const kalshiPaperRunsTable = pgTable("kalshi_paper_runs", {
  id: uuid("id").primaryKey(),
  status: text("status").notNull().default("draft"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  activatedAt: timestamp("activated_at", { withTimezone: true }),
  endsAt: timestamp("ends_at", { withTimezone: true }),
  holdoutAt: timestamp("holdout_at", { withTimezone: true }),
  pausedAt: timestamp("paused_at", { withTimezone: true }),
  protocol: jsonb("protocol").notNull(),
  dropped: integer("dropped").notNull().default(0),
  heartbeatAt: timestamp("heartbeat_at", { withTimezone: true }),
  workerError: text("worker_error"),
}, t => [uniqueIndex("kalshi_paper_one_active_idx").on(t.status).where(sql`${t.status} = 'active'`)]);

export const kalshiPaperCandidatesTable = pgTable("kalshi_paper_candidates", {
  id: uuid("id").primaryKey(),
  runId: uuid("run_id").notNull().references(() => kalshiPaperRunsTable.id),
  tradeId: text("trade_id").notNull(),
  ticker: text("ticker").notNull(),
  gameId: text("game_id").notNull(),
  decidedAt: timestamp("decided_at", { withTimezone: true }).notNull(),
  confirmedAt: timestamp("confirmed_at", { withTimezone: true }),
  eligible: integer("eligible").notNull(),
  phase: text("phase").notNull(),
  matchedId: uuid("matched_id"),
  evidence: jsonb("evidence").notNull(),
}, t => [uniqueIndex("kalshi_paper_candidate_unique_idx").on(t.runId, t.tradeId),
  index("kalshi_paper_candidate_page_idx").on(t.runId, t.decidedAt),
  index("kalshi_paper_candidate_game_idx").on(t.runId, t.gameId)]);

export const kalshiPaperExecutionsTable = pgTable("kalshi_paper_executions", {
  id: uuid("id").primaryKey(),
  runId: uuid("run_id").notNull().references(() => kalshiPaperRunsTable.id),
  candidateId: uuid("candidate_id").notNull().references(() => kalshiPaperCandidatesTable.id),
  delaySeconds: integer("delay_seconds").notNull(),
  policy: text("policy").notNull(),
  dueAt: timestamp("due_at", { withTimezone: true }).notNull(),
  capturedAt: timestamp("captured_at", { withTimezone: true }),
  status: text("status").notNull().default("pending"),
  evidence: jsonb("evidence").notNull(),
  resolution: jsonb("resolution"),
}, t => [uniqueIndex("kalshi_paper_execution_unique_idx").on(t.candidateId, t.delaySeconds, t.policy),
  index("kalshi_paper_execution_due_idx").on(t.status, t.dueAt),
  index("kalshi_paper_execution_run_idx").on(t.runId)]);

export const kalshiPaperReportsTable = pgTable("kalshi_paper_reports", {
  runId: uuid("run_id").primaryKey().references(() => kalshiPaperRunsTable.id),
  generatedAt: timestamp("generated_at", { withTimezone: true }).notNull(),
  payload: jsonb("payload").notNull(),
});
