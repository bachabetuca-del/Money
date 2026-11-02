import { getRoiSnapshot } from "./kalshi-roi-leaderboard";
import { buildNotificationRoiLookup } from "./telegram-notification-roi";
import type { NotificationJob } from "./telegram-trade-notifications";
import type { RoiRollup } from "./roi-ranking";

const lookups = new WeakMap<RoiRollup[], ReturnType<typeof buildNotificationRoiLookup>>();

/** Read-only, shared 60-second history cache; no new Kalshi requests. Errors
 * propagate to the durable outbox retry instead of allowing an unchecked alert. */
export async function getTradeNotificationRoi(trade: NotificationJob, now = new Date()) {
  const { snapshot } = await getRoiSnapshot({
    groupBy: "segment", window: "all", band: "all", direction: "all",
    coverage: "verified", minGames: 1, page: 1,
  }, now);
  let lookup = lookups.get(snapshot.rows);
  if (!lookup) {
    lookup = buildNotificationRoiLookup(snapshot.rows);
    lookups.set(snapshot.rows, lookup);
  }
  return lookup(trade);
}
