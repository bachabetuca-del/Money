import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import { explorerDirection } from "./explorer-direction";
import type { RoiReferencePrice } from "./explorer-roi";
import type { TradeRange } from "./kalshi-trade-bands";

export async function loadRoiReferencePrices(
  tickers: string[], range: TradeRange, now: Date, executor: Pick<typeof db, "execute"> = db,
): Promise<RoiReferencePrice[]> {
  if (!tickers.length) return [];
  const side = explorerDirection(sql`outcome_side`, sql`book_side`);
  const result = await executor.execute(sql`
    SELECT DISTINCT ON (ticker, side) ticker, side, price, created_time AS "observedAt"
    FROM (
      SELECT ticker, ${side} AS side, price, created_time, trade_id
      FROM kalshi_alerts
      WHERE ticker = ANY(${sql.param(tickers)}::text[])
        AND ${range.minimumInclusive ? sql`notional >= ${range.minimum}` : sql`notional > ${range.minimum}`}
        ${range.maximum === null ? sql`` : range.maximumInclusive
          ? sql`AND notional <= ${range.maximum}` : sql`AND notional < ${range.maximum}`}
        AND created_time <= ${now} AND price > 0 AND price <= 1
        AND count > 0 AND count <> 'NaN'::numeric AND abs(notional - price * count) <= 0.010001
    ) observations
    WHERE side IN ('yes', 'no')
    ORDER BY ticker, side, created_time DESC, trade_id ASC
  `);
  return result.rows.map(row => ({
    ticker: String(row.ticker), side: row.side as "yes" | "no", price: Number(row.price),
    observedAt: new Date(row.observedAt as string | Date).toISOString(),
  }));
}
