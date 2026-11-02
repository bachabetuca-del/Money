import { db, kalshiFeeSnapshotsTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { parseFeeSnapshot, type PublicFeeSeries } from "./kalshi-fees";
import { fetchFeeSnapshot, type FeeRead } from "./kalshi-fee-source";

let refresh: Promise<void> | undefined;
/** Called only by the existing production sports-catalog refresh. No extra bot,
 * no HTTP on ranking/explorer/notification reads, and no development polling. */
export async function refreshStoredFees(series: PublicFeeSeries[], read: FeeRead, asOf: Date) {
  if (process.env.BOT_WORKERS_ENABLED === "false") return;
  if (refresh) return refresh;
  refresh = (async () => {
    const snapshot = await fetchFeeSnapshot(series, read, asOf);
    await db.insert(kalshiFeeSnapshotsTable).values({ id: 1, snapshot, checkedAt: asOf })
      .onConflictDoUpdate({ target: kalshiFeeSnapshotsTable.id, set: { snapshot, checkedAt: asOf } });
  })().finally(() => { refresh = undefined; });
  return refresh;
}

export async function readStoredFees() {
  const [row] = await db.select({ snapshot: kalshiFeeSnapshotsTable.snapshot })
    .from(kalshiFeeSnapshotsTable).where(eq(kalshiFeeSnapshotsTable.id, 1)).limit(1);
  return parseFeeSnapshot(row?.snapshot);
}
