import type { SignalEvidence, SignalOutcome } from "@workspace/api-zod";
import { ROI_COLOR_POLICY } from "./explorer-roi";
import { marketType } from "./market-type";
import { oddsBucket, ROI_STAKE } from "./roi-ranking";
import { ROI_MONEY_BANDS } from "./roi-performance";
import { inTradeRange, tradeRange } from "./kalshi-trade-bands";
import { publicDirection } from "./telegram-trade-direction";
import { NOTIFICATION_MIN_ROI_PCT, qualifiesForNotificationRoi, type NotificationRoi } from "./telegram-notification-roi";
import type { NotificationJob } from "./telegram-trade-notifications";

export const SIGNAL_RULE_VERSION = "first-game-phase-roi-15pct-50-games-v4";
export const SIGNAL_FEE_ASSUMPTIONS = "Una entrada taker hipotética de $100, cantidad teórica 100/precio, " +
  "comisión cuadrática 0,07 × multiplicador × contratos × precio × (1−precio). " +
  "Precisión de comisión 6 decimales y débito directo redondeado hacia arriba a $0,0001. " +
  "Tarifa disponible al registrar la señal; mantenida hasta liquidación, sin salida, " +
  "deslizamiento, financiación, impuestos, costes de intermediario ni rebates.";

export function signalGameIdentity(ticker: string, game?: { milestoneId: string | null; eventTicker: string | null }) {
  if (game?.milestoneId) return { gameId: game.milestoneId, gameIdentity: "milestone" as const };
  if (game?.eventTicker) return { gameId: game.eventTicker, gameIdentity: "event" as const };
  return { gameId: ticker.split("-").slice(0, 2).join("-"), gameIdentity: "ticker" as const };
}

/** Called exactly once per eligible outbox entry, BEFORE the first Telegram
 * request. Later fee changes, repairs and ROI snapshots cannot mutate it. */
export function buildSignalEvidence(job: NotificationJob, roi: NotificationRoi, now: Date): SignalEvidence {
  const side = publicDirection(job.outcomeSide, undefined, job.bookSide);
  const bucket = oddsBucket(job.price), type = marketType(job);
  const band = ROI_MONEY_BANDS.find(b => inTradeRange(job.notional, tradeRange(b)));
  if (!qualifiesForNotificationRoi(roi) || !roi.evidence || !band || side === "unknown" ||
      bucket === null || type === "other" || !job.eventTitle || !job.marketTitle || !job.queuedAt ||
      !Number.isFinite(job.count) || job.count <= 0 || Math.abs(job.notional - job.price * job.count) > .010001 ||
      !Number.isFinite(Date.parse(roi.evidence.historyAsOf)) ||
      Date.parse(roi.evidence.historyAsOf) > now.getTime() ||
      job.createdTime > job.queuedAt || job.queuedAt > now) {
    throw new Error("Cannot freeze incomplete or inconsistent prospective signal evidence.");
  }
  const range = tradeRange(band);
  return {
    ...roi.evidence, tradeId: job.tradeId, ticker: job.ticker,
    eventTitle: job.eventTitle, marketTitle: job.marketTitle, marketUrl: job.marketUrl,
    observedAt: job.createdTime.toISOString(), queuedAt: job.queuedAt.toISOString(), capturedAt: now.toISOString(),
    price: job.price, notional: job.notional, contracts: job.count,
    rule: {
      ...(roi.methodVersion ? { roiMethodVersion: roi.methodVersion, historicalPhase: roi.phase } : {}),
      version: SIGNAL_RULE_VERSION, basis: roi.basis, minimumRoiPct: NOTIFICATION_MIN_ROI_PCT,
      minimumGames: ROI_COLOR_POLICY.minimumGames, minimumTrades: ROI_COLOR_POLICY.minimumTrades,
      coverage: "verified", window: "all", sport: job.sport, marketType: type, side, moneyBand: band,
      amountMin: range.minimum, amountMax: range.maximum,
      amountMinInclusive: range.minimumInclusive, amountMaxInclusive: range.maximumInclusive ?? false,
      oddsMin: bucket / 10, oddsMax: (bucket + 1) / 10, stakeUsd: ROI_STAKE,
    },
    historicalRoiPct: roi.roiPct, historicalGrossRoiPct: roi.grossRoiPct, historicalNetRoiPct: roi.netRoiPct,
    historicalGames: roi.games, historicalTrades: roi.trades,
  };
}

/** Reconstitute the SAME message evidence on retries, even if the owner changes
 * basis or the history importer corrects the source execution in the meantime. */
export function frozenNotification(evidence: SignalEvidence, job: NotificationJob) {
  const trade: NotificationJob = {
    ...job, ticker: evidence.ticker, eventTitle: evidence.eventTitle, marketTitle: evidence.marketTitle,
    marketUrl: evidence.marketUrl, sport: evidence.rule.sport, price: evidence.price, count: evidence.contracts,
    notional: evidence.notional, outcomeSide: evidence.rule.side, createdTime: new Date(evidence.observedAt),
  };
  const roi: NotificationRoi = {
    ...(evidence.rule.roiMethodVersion ? {
      methodVersion: evidence.rule.roiMethodVersion, phase: evidence.rule.historicalPhase,
    } : {}),
    basis: evidence.rule.basis, roiPct: evidence.historicalRoiPct,
    grossRoiPct: evidence.historicalGrossRoiPct, netRoiPct: evidence.historicalNetRoiPct,
    games: evidence.historicalGames, trades: evidence.historicalTrades,
  };
  return { trade, roi };
}

export type SignalResolution = {
  sentAt: Date | null; skippedAt: Date | null; attempts: number;
  result: string | null; terminal: boolean | null; checkedAt: Date | null; error: string | null;
};

/** No current prices/history/fee lookup here. checkedAt is when the existing
 * resolver verified the official final result, NOT the exchange settlement time. */
export function signalOutcome(evidence: SignalEvidence, row: SignalResolution): SignalOutcome {
  const delivery = row.sentAt ? "sent" : row.skippedAt ? "skipped" : "pending";
  let status: SignalOutcome["status"] = row.sentAt ? "pending" : "not_sent";
  let exclusionReason: SignalOutcome["exclusionReason"] = null;
  if (row.sentAt && row.terminal && row.checkedAt && !row.error) {
    if (row.checkedAt <= row.sentAt) {
      status = "excluded"; exclusionReason = "settled_before_alert";
    } else if (!["yes", "no"].includes(row.result ?? "")) {
      status = "excluded"; exclusionReason = "unsupported_settlement";
    } else status = "settled";
  }
  const stake = evidence.rule.stakeUsd;
  const grossProfit = status === "settled" ?
    (evidence.rule.side === row.result ? stake / evidence.price - stake : -stake) : null;
  const netProfit = grossProfit === null || evidence.entryFeeUsd === null ? null : grossProfit - evidence.entryFeeUsd;
  return {
    evidence, delivery, sentAt: row.sentAt?.toISOString() ?? null, attempts: row.attempts, status, exclusionReason,
    officialResult: row.terminal && !row.error ? row.result : null,
    settlementCheckedAt: row.checkedAt?.toISOString() ?? null, settlementError: row.error,
    grossProfit, grossRoiPct: grossProfit === null ? null : 100 * grossProfit / stake,
    netProfit, netRoiPct: netProfit === null ? null : 100 * netProfit / (stake + evidence.entryFeeUsd!),
  };
}
