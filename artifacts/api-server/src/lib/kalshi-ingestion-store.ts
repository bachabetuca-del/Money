import { db, kalshiAlertsTable as alerts, kalshiGameStatusTable as games, kalshiMetadataJobsTable as jobs } from "@workspace/db";
import { and, eq, inArray, isNotNull, lt, lte, sql } from "drizzle-orm";
import type { PublicTrade } from "./kalshi-monitor";
import type { MetadataStore } from "./kalshi-metadata-worker";
import { kalshiLiveEvents } from "./kalshi-live-events";

/** No upstream calls: save executions in bulk, reuse durable readable metadata,
 * and atomically register any follow-up work. Retries are idempotent. */
export async function persistTrades(trades: PublicTrade[]) {
  if (!trades.length) return [];
  const identities = new Map<string, string>();
  for (const trade of trades) {
    const prior = identities.get(trade.tradeId);
    if (prior && prior !== trade.ticker) throw new Error("Conflicting trade identities in live batch.");
    identities.set(trade.tradeId, trade.ticker);
  }
  const unique = [...new Map(trades.map(trade => [trade.tradeId, trade])).values()];
  const tickers = [...new Set(unique.map(trade => trade.ticker))];
  const descriptions = await db.selectDistinctOn([alerts.ticker], {
    ticker: alerts.ticker, eventTitle: alerts.eventTitle, marketTitle: alerts.marketTitle,
  }).from(alerts).where(and(inArray(alerts.ticker, tickers), isNotNull(alerts.eventTitle),
    isNotNull(alerts.marketTitle), sql`${alerts.marketTitle} <> ${alerts.ticker}`)).orderBy(alerts.ticker);
  const contexts = new Map(descriptions.filter(row => row.eventTitle && row.marketTitle && !row.marketTitle.includes(row.ticker))
    .map(row => [row.ticker, { eventTitle: row.eventTitle!, marketTitle: row.marketTitle! }]));
  const rows = unique.map(trade => {
    const context = contexts.get(trade.ticker);
    return context ? { ...trade, ...context, title: `${context.eventTitle} · ${context.marketTitle}` } : trade;
  });
  await db.transaction(async tx => {
    const existing = await tx.select({ tradeId: alerts.tradeId, ticker: alerts.ticker }).from(alerts)
      .where(inArray(alerts.tradeId, unique.map(row => row.tradeId)));
    if (existing.some(row => identities.get(row.tradeId) !== row.ticker)) {
      throw new Error("Saved trade identity conflict; batch not committed.");
    }
    await tx.insert(alerts).values(rows.map(row => ({ ...row, createdTime: new Date(row.createdTime) }))).onConflictDoNothing();
    await tx.insert(games).values(tickers.map(ticker => ({ ticker }))).onConflictDoNothing();
    const missing = tickers.filter(ticker => !contexts.has(ticker));
    if (missing.length) await tx.insert(jobs).values(missing.map(ticker => ({ ticker }))).onConflictDoNothing();
  });
  return rows;
}

export async function bootstrapMetadataJobs() {
  await db.execute(sql`INSERT INTO kalshi_metadata_jobs (ticker)
    SELECT DISTINCT ticker FROM kalshi_alerts
    WHERE event_title IS NULL OR market_title IS NULL OR market_title = ticker
    ON CONFLICT (ticker) DO NOTHING`);
}

export const metadataStore: MetadataStore = {
  async candidates(now) {
    return db.select().from(jobs).where(and(lte(jobs.nextCheckAt, now), lt(jobs.attempts, 6)))
      .orderBy(jobs.nextCheckAt, jobs.ticker).limit(4);
  },
  async complete(ticker, context) {
    await db.transaction(async tx => {
      await tx.update(alerts).set({ eventTitle: context.eventTitle, marketTitle: context.marketTitle,
        title: `${context.eventTitle} · ${context.marketTitle}` }).where(eq(alerts.ticker, ticker));
      if (context.eventTicker) await tx.update(games).set({ eventTicker: context.eventTicker })
        .where(eq(games.ticker, ticker));
      if (context.marketStatus) await tx.update(games).set({ marketStatus: context.marketStatus,
        marketTerminal: ["closed", "determined", "finalized", "settled"].includes(context.marketStatus) })
        .where(and(eq(games.ticker, ticker), sql`(${games.marketStatus} IS NULL
          OR ${games.marketStatus} NOT IN ('finalized', 'settled')
          OR ${context.marketStatus} IN ('finalized', 'settled'))`));
      await tx.delete(jobs).where(eq(jobs.ticker, ticker));
    });
    kalshiLiveEvents.publish([ticker]);
  },
  async failed(job, error, retryAt) {
    await db.update(jobs).set({ attempts: job.attempts + 1, error, nextCheckAt: retryAt }).where(eq(jobs.ticker, job.ticker));
  },
};
