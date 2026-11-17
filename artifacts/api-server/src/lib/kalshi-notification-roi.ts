import { getRoiSnapshot } from "./kalshi-roi-leaderboard";
import { buildNotificationRoiLookup, type RoiBasis } from "./telegram-notification-roi";
import type { NotificationJob } from "./telegram-trade-notifications";
import type { RoiRollup } from "./roi-ranking";
import { db, kalshiGameStatusTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { estimateHypotheticalEntryFee, marketFeeRule } from "./kalshi-fees";
import { signalGameIdentity, SIGNAL_FEE_ASSUMPTIONS } from "./signal-evaluation";

const lookups = new WeakMap<RoiRollup[], Map<RoiBasis, ReturnType<typeof buildNotificationRoiLookup>>>();

/** Read-only, shared 60-second history cache; no new Kalshi requests. Errors
 * propagate to the durable outbox retry instead of allowing an unchecked alert. */
export async function getTradeNotificationRoi(trade: NotificationJob, basis: RoiBasis = "gross", now = new Date()) {
  const [{ snapshot, fees }, [game]] = await Promise.all([
    getRoiSnapshot({
      groupBy: "segment", window: "all", band: "all", direction: "all",
      coverage: "verified", minGames: 1, page: 1,
    }, now),
    db.select({ milestoneId: kalshiGameStatusTable.milestoneId, eventTicker: kalshiGameStatusTable.eventTicker,
      state: kalshiGameStatusTable.state, checkedAt: kalshiGameStatusTable.checkedAt,
      startsAt: kalshiGameStatusTable.startsAt, marketStatus: kalshiGameStatusTable.marketStatus,
      terminal: kalshiGameStatusTable.marketTerminal })
      .from(kalshiGameStatusTable).where(eq(kalshiGameStatusTable.ticker, trade.ticker)).limit(1),
  ]);
  let choices = lookups.get(snapshot.rows);
  if (!choices) { choices = new Map(); lookups.set(snapshot.rows, choices); }
  let lookup = choices.get(basis);
  if (!lookup) {
    lookup = buildNotificationRoiLookup(snapshot.rows, basis);
    choices.set(basis, lookup);
  }
  const identity = signalGameIdentity(trade.ticker, game);
  const roi = lookup(trade, identity.gameId);
  if (!roi) return null;
  const feeRule = marketFeeRule(fees, trade.ticker, game?.eventTicker ?? null, now);
  return {
    ...roi,
    research: roi.research ? { ...roi.research, phase: game?.state ?? "unknown",
      phaseAsOf: game?.checkedAt.toISOString() ?? null, startsAt: game?.startsAt?.toISOString() ?? null,
      marketStatus: game?.marketStatus ?? null, terminal: game?.terminal ?? false } : undefined,
    evidence: {
      historyAsOf: snapshot.generatedAt, ...identity,
      feeModel: snapshot.feeModel, feeAssumptions: SIGNAL_FEE_ASSUMPTIONS,
      feeType: feeRule?.feeType ?? null, feeMultiplier: feeRule?.multiplier ?? null,
      entryFeeUsd: estimateHypotheticalEntryFee(trade.price, feeRule),
    },
  };
}
