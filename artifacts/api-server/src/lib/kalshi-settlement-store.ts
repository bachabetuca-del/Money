import { db, kalshiSettlementsTable as settlements, kalshiGameStatusTable as games } from "@workspace/db";
import { sql } from "drizzle-orm";
import type { SettlementStore, SettlementWrite } from "./kalshi-settlement-source";

async function saveMany(values: SettlementWrite[]) {
  if (!values.length) return;
  await db.transaction(async tx => {
    await tx.insert(settlements).values(values.map(({ marketStatus: _, ...row }) => ({ ...row, priority: 0 })))
      .onConflictDoUpdate({ target: settlements.ticker, set: {
        result: sql`excluded.result`, terminal: sql`excluded.terminal`, historical: sql`excluded.historical`,
        checkedAt: sql`excluded.checked_at`, nextCheckAt: sql`excluded.next_check_at`, error: sql`excluded.error`, priority: 0,
      }, setWhere: sql`${settlements.terminal} = false` });
    const states = values.filter(row => row.marketStatus && !row.error);
    if (states.length) await tx.insert(games).values(states.map(row => ({
      ticker: row.ticker, marketStatus: row.marketStatus!,
      marketTerminal: ["closed", "determined", "finalized", "settled"].includes(row.marketStatus!),
    }))).onConflictDoUpdate({ target: games.ticker, set: {
      marketStatus: sql`excluded.market_status`, marketTerminal: sql`excluded.market_terminal`,
    }, setWhere: sql`(${games.marketStatus} IS NULL OR ${games.marketStatus} NOT IN ('finalized', 'settled')
      OR excluded.market_status IN ('finalized', 'settled'))` });
  });
}

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
      GROUP BY a.ticker, s.next_check_at, s.priority
      ORDER BY coalesce(s.priority, 0) DESC, s.next_check_at ASC NULLS FIRST, max(a.created_time) DESC, a.ticker
      LIMIT ${limit}
    `);
    return result.rows.map(row => String(row.ticker));
  },
  save: value => saveMany([value]),
  saveMany,
};
