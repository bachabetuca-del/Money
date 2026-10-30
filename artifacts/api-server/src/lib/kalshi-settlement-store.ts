import { db, kalshiSettlementsTable as settlements } from "@workspace/db";
import { sql } from "drizzle-orm";
import type { SettlementStore } from "./kalshi-settlement-source";

export const settlementStore: SettlementStore = {
  async candidates(historical, limit, now) {
    const result = await db.execute(sql`
      SELECT a.ticker
      FROM kalshi_alerts a
      LEFT JOIN kalshi_market_settlements s ON s.ticker = a.ticker
      LEFT JOIN kalshi_game_status g ON g.ticker = a.ticker
      WHERE (s.ticker IS NULL OR (s.terminal = false AND s.next_check_at <= ${now}))
        AND ${historical ? sql`s.historical = true` : sql`(s.historical = false OR s.ticker IS NULL)`}
        AND (g.ticker IS NULL OR g.market_terminal = true OR g.state = 'finished'
          OR g.starts_at <= ${now} OR (g.starts_at IS NULL AND a.created_time < ${new Date(now.getTime() - 86400_000)}))
      GROUP BY a.ticker, s.next_check_at
      ORDER BY s.next_check_at ASC NULLS FIRST, max(a.created_time) DESC, a.ticker
      LIMIT ${limit}
    `);
    return result.rows.map(row => String(row.ticker));
  },
  async save(value) {
    await db.insert(settlements).values(value).onConflictDoUpdate({
      target: settlements.ticker, set: value,
      // An overlapping refresh must never replace an already final settlement with pending.
      setWhere: sql`${settlements.terminal} = false`,
    });
  },
};
