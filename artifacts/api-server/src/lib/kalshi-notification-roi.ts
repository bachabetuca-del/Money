import { getRoiSnapshot } from "./kalshi-roi-leaderboard";
import { buildNotificationRoiLookup, type RoiBasis } from "./telegram-notification-roi";
import type { NotificationJob } from "./telegram-trade-notifications";
import type { RoiRollup } from "./roi-ranking";

const lookups = new WeakMap<RoiRollup[], Map<RoiBasis, ReturnType<typeof buildNotificationRoiLookup>>>();

/** Read-only, shared 60-second history cache; no new Kalshi requests. Errors
 * propagate to the durable outbox retry instead of allowing an unchecked alert. */
export async function getTradeNotificationRoi(trade: NotificationJob, basis: RoiBasis = "gross", now = new Date()) {
  const { snapshot } = await getRoiSnapshot({
    groupBy: "segment", window: "all", band: "all", direction: "all",
    coverage: "verified", minGames: 1, page: 1,
  }, now);
  let choices = lookups.get(snapshot.rows);
  if (!choices) { choices = new Map(); lookups.set(snapshot.rows, choices); }
  let lookup = choices.get(basis);
  if (!lookup) {
    lookup = buildNotificationRoiLookup(snapshot.rows, basis);
    choices.set(basis, lookup);
  }
  return lookup(trade);
}
