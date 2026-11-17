import type { PaperRun } from "@workspace/api-zod";
import type { NotificationJob } from "../telegram-trade-notifications";
import type { NotificationRoi } from "../telegram-notification-roi";
import { signalGameIdentity } from "../signal-evaluation";
import { marketType } from "../market-type";
import { ROI_MONEY_BANDS } from "../roi-performance";
import { inTradeRange, tradeRange } from "../kalshi-trade-bands";
import { publicDirection } from "../telegram-trade-direction";
import type { BookQuote } from "./book";

export type PaperEvidence = {
  tradeId: string; ticker: string; eventTitle: string; marketTitle: string;
  sport: string; marketType: string; side: string; moneyBand: string | null;
  gameId: string; gameIdentity: string;
  observedAt: string; queuedAt: string | null; decidedAt: string;
  price: number; notional: number; publicContracts: number;
  accepted: boolean; reason: string; exclusions: string[];
  roi: NotificationRoi | null; timestamps: Record<string, string | number | null>;
  phase: string; phaseAsOf: string | null; startsAt: string | null;
  score: null; timeRemaining: null; decisionBook: BookQuote | null;
  matching?: { pairId: string; at: string; residuals: string[] };
};
export function candidateEvidence(run: PaperRun, job: NotificationJob, roi: NotificationRoi | null,
  accepted: boolean, reason: string, at: Date, book: BookQuote | null,
  timestamps: PaperEvidence["timestamps"]): PaperEvidence {
  const identity = roi?.evidence ?? (job.evidence ? { gameId: job.evidence.gameId, gameIdentity: job.evidence.gameIdentity }
    : signalGameIdentity(job.ticker));
  const ex: string[] = [];
  const cutoff = roi?.evidence?.historyAsOf;
  if (!run.activatedAt || job.createdTime < new Date(run.activatedAt) || !job.queuedAt || job.queuedAt < new Date(run.activatedAt))
    ex.push("before_activation");
  if (!cutoff || !roi?.research || !Number.isFinite(Date.parse(cutoff)) || Date.parse(cutoff) > at.getTime() ||
      !roi.research.latestHistoricalCheck || Date.parse(roi.research.latestHistoricalCheck) > Date.parse(cutoff))
    ex.push("history_cutoff_unverified");
  if (roi?.research?.includesCandidateGame) ex.push("candidate_game_in_reference");
  if (identity.gameIdentity !== "milestone") ex.push("approximate_game_identity");
  if (roi && roi.basis !== run.protocol.basis) ex.push("notification_rule_changed");
  if (roi?.research?.terminal || ["finished", "final"].includes(roi?.research?.phase ?? "")) ex.push("market_already_terminal");
  if (!roi?.evidence || roi.evidence.feeType === null || roi.evidence.feeMultiplier === null)
    ex.push("fee_unknown");
  if (roi?.games == null || roi.games < run.protocol.minimumGames || roi.trades < run.protocol.minimumTrades)
    ex.push("historical_sample_insufficient");
  if (job.createdTime > at || job.queuedAt && job.queuedAt > at) ex.push("timestamp_inconsistent");
  const side = publicDirection(job.outcomeSide, undefined, job.bookSide);
  if (side === "unknown") ex.push("unknown_side");
  return { tradeId: job.tradeId, ticker: job.ticker, eventTitle: job.eventTitle ?? "Partido sin confirmar",
    marketTitle: job.marketTitle ?? "Mercado sin confirmar", sport: job.sport, marketType: marketType(job),
    side, moneyBand: ROI_MONEY_BANDS.find(b => inTradeRange(job.notional, tradeRange(b))) ?? null,
    gameId: identity.gameId, gameIdentity: identity.gameIdentity, observedAt: job.createdTime.toISOString(),
    queuedAt: job.queuedAt?.toISOString() ?? null, decidedAt: at.toISOString(),
    price: job.price, notional: job.notional, publicContracts: job.count,
    accepted, reason: accepted ? "telegram_eligible" : reason, exclusions: ex,
    roi: roi ? structuredClone(roi) : null, timestamps: { ...timestamps },
    phase: roi?.research?.phase ?? "unknown", phaseAsOf: roi?.research?.phaseAsOf ?? null,
    startsAt: roi?.research?.startsAt ?? null, score: null, timeRemaining: null, decisionBook: book };
}
