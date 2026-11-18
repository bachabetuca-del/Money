import { randomUUID } from "node:crypto";
import type { PaperProtocolInput, PaperRun } from "@workspace/api-zod";
import type { NotificationJob } from "../telegram-trade-notifications";
import type { NotificationRoi } from "../telegram-notification-roi";
import { makeProtocol } from "./protocol";
import { PaperBook, type BookQuote } from "./book";
import { candidateEvidence } from "./evidence";

export const ZERO = Date.parse("2026-11-17T10:00:00Z");
export const at = (seconds: number) => new Date(ZERO + seconds * 1000);
export function input(overrides: Partial<PaperProtocolInput> = {}): PaperProtocolInput {
  return { requestId: randomUUID(), name: "Prueba aislada", stakeUsd: 100, capitalUsd: 10000,
    maxGameUsd: 110, delaySeconds: 30, limitCents: 1, runDays: 28, holdoutDays: 7,
    repetitions: "first", maxMarkets: 8, ...overrides };
}
export function run(): PaperRun {
  const p = input();
  return { id: p.requestId, status: "active", createdAt: at(-60).toISOString(), activatedAt: at(0).toISOString(),
    endsAt: at(86400 * 28).toISOString(), holdoutAt: at(86400 * 21).toISOString(),
    pausedAt: null, protocol: makeProtocol(p, "gross"), dropped: 0, heartbeatAt: null, workerError: null };
}
export function job(id = "trade-a"): NotificationJob {
  return { tradeId: id, ticker: "PAPER-GAME-A", eventTitle: "Equipo A vs Equipo B", marketTitle: "Equipo A gana",
    marketUrl: "https://kalshi.com/markets/fixture", sport: "Soccer", outcomeSide: "yes", bookSide: "bid",
    price: .5, notional: 1200, count: 2400, createdTime: at(1), queuedAt: at(2), chatId: "fixture", attempts: 0 };
}
export function roi(gameId = "game-a"): NotificationRoi {
  return { roiPct: 20, grossRoiPct: 20, netRoiPct: 16, games: 60, trades: 200, basis: "gross",
    evidence: { historyAsOf: at(-30).toISOString(), gameId, gameIdentity: "milestone",
      feeModel: { status: "current", version: "frozen-test", scheduleAsOf: at(-60).toISOString(),
        validUntil: at(86400).toISOString(), documentationReviewedOn: "2026-11-17", sources: [] },
      feeAssumptions: "Frozen test tariff", feeType: "quadratic", feeMultiplier: 1, entryFeeUsd: 3.5 },
    research: { includesCandidateGame: false, latestHistoricalCheck: at(-120).toISOString(),
      phase: "scheduled", phaseAsOf: at(2).toISOString(), startsAt: at(3600).toISOString(),
      terminal: false, marketStatus: "active" } };
}
export function quote(seconds = 34, ticker = "PAPER-GAME-A", depth = 1000): BookQuote {
  const b = new PaperBook(); b.connect("test-session", at(seconds).getTime());
  b.apply({ type: "orderbook_snapshot", sid: 1, seq: 1, sending_ts_ms: at(seconds).getTime(),
    msg: { market_ticker: ticker, yes_dollars_fp: [["0.4900", `${depth}.00`]],
      no_dollars_fp: [["0.5000", `${depth}.00`]], clock: 1 } }, at(seconds).getTime());
  return b.quote(ticker, at(seconds).getTime())!;
}
export const evidence = (r: PaperRun, id = "trade-a", game = "game-a", accepted = true) =>
  candidateEvidence(r, job(id), roi(game), accepted, "roi_or_sample", at(3), quote(3), {});
