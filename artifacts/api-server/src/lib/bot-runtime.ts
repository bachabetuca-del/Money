import { pool, db, kalshiMonitorSettingsTable } from "@workspace/db";
import { logger } from "./logger";
import { ownerChatId } from "./owner-policy";
import { startKalshiMonitor } from "./kalshi-monitor";
import { activateSignalEvaluation } from "./kalshi-signal-store";
import { SIGNAL_RULE_VERSION } from "./signal-evaluation";
import { ROI_METHOD_VERSION } from "./roi-method";
import { observeSlowSavedReads } from "./saved-read-timing";

export function checkRuntimeConfiguration() {
  observeSlowSavedReads(timing => logger.warn({
    ...timing, databaseWaiting: pool.waitingCount,
    databaseConnections: pool.totalCount, databaseIdle: pool.idleCount,
  }, "Slow saved-data operation"));
  const required = ["OWNER_EMAIL", "CLERK_SECRET_KEY", "CLERK_PUBLISHABLE_KEY",
    "TELEGRAM_BOT_TOKEN", "TELEGRAM_OWNER_CHAT_ID"] as const;
  const missing = required.filter(key => !process.env[key]?.trim());
  if (missing.length) throw new Error(`Missing required settings: ${missing.join(", ")}`);
  if (!ownerChatId()) throw new Error("Invalid TELEGRAM_OWNER_CHAT_ID");
}

export async function startBotRuntime() {
  if (process.env.BOT_WORKERS_ENABLED === "false") {
    logger.info("Bot workers paused for this environment; dashboard remains available");
    return;
  }
  // A dedicated session lock prevents overlapping production revisions or
  // multiple processes on the same database from running duplicate bot workers.
  const client = await pool.connect();
  const lostLock = () => {
    logger.error("Bot worker database lock connection lost; exiting to avoid duplicate workers");
    process.exit(1);
  };
  client.on("error", lostLock);
  const acquired = await client.query<{ acquired: boolean }>(
    "SELECT pg_try_advisory_lock(748392105) AS acquired",
  );
  if (!acquired.rows[0]?.acquired) {
    client.removeListener("error", lostLock);
    client.release();
    logger.info("Another process owns the bot workers; retrying in 15 seconds");
    setTimeout(() => void startBotRuntime().catch(fatalStartup), 15_000);
    return;
  }
  // Fresh production databases get a working owner destination without copying
  // development user IDs or resetting any existing settings/trade history.
  await db.insert(kalshiMonitorSettingsTable).values({
    id: 1, enabled: true, minimumNotional: 10_000, chatId: ownerChatId(),
  }).onConflictDoNothing();
  // Durable cutoff begins only after this environment is enabled and owns the
  // existing production lock. Restarts never move it; development never creates it.
  await activateSignalEvaluation();
  logger.info({ signalRuleVersion: SIGNAL_RULE_VERSION, roiMethodVersion: ROI_METHOD_VERSION },
    "Bot alert rule activated");
  startKalshiMonitor();
}

export function fatalStartup(error: unknown) {
  logger.error({ error: error instanceof Error ? error.message : "Startup failed" }, "Bot startup failed");
  process.exit(1);
}
