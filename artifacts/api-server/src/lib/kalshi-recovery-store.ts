import { db, kalshiRecoveryTable as recovery } from "@workspace/db";
import { eq, sql } from "drizzle-orm";
import type { RecoveryStore } from "./kalshi-recovery";

export const recoveryStore: RecoveryStore = {
  async load() {
    const [row] = await db.select().from(recovery).where(eq(recovery.id, 1));
    if (!row) return undefined;
    if (!["live", "archive"].includes(row.phase)) throw new Error("Invalid saved recovery phase.");
    return { ...row, phase: row.phase as "live" | "archive" };
  },
  async seed() {
    const result = await db.execute(sql`SELECT max(created_time) AS latest FROM kalshi_alerts`);
    const value = result.rows[0]?.latest;
    return value ? new Date(String(value)) : null;
  },
  async save(state) {
    await db.insert(recovery).values({ id: 1, ...state })
      .onConflictDoUpdate({ target: recovery.id, set: state });
  },
};
