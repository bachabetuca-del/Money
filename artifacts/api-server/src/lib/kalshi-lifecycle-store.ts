import { db, kalshiGameStatusTable as games, kalshiMetadataJobsTable as metadata,
  kalshiSettlementsTable as settlements } from "@workspace/db";
import { and, eq, inArray, ne, sql } from "drizzle-orm";
import type { LifecycleWork } from "./kalshi-lifecycle";

/** Only touch markets already observed by this bot. A global lifecycle feed must
 * not expand into polling every market on the exchange. */
export async function applyLifecycle(work: LifecycleWork[]) {
  const rows = await db.select().from(games).where(inArray(games.ticker, work.map(item => item.ticker)));
  if (!rows.length) return [];
  const known = new Set(rows.map(row => row.ticker));
  const tracked = work.filter(item => known.has(item.ticker));
  await db.transaction(async tx => {
    await tx.update(games).set({ nextCheckAt: new Date() })
      .where(and(inArray(games.ticker, [...known]), ne(games.state, "finished")));
    const descriptions = tracked.filter(item => item.metadata).map(({ ticker }) => ({ ticker }));
    if (descriptions.length) await tx.insert(metadata).values(descriptions).onConflictDoUpdate({
      target: metadata.ticker, set: { attempts: 0, error: null, nextCheckAt: new Date() },
    });
    const verify = tracked.filter(item => item.settlement).map(({ ticker }) => ({ ticker, priority: 1 }));
    if (verify.length) await tx.insert(settlements).values(verify).onConflictDoUpdate({
      target: settlements.ticker, set: { priority: 1, nextCheckAt: new Date(), error: null },
      setWhere: eq(settlements.terminal, false),
    });
  });
  return rows;
}
