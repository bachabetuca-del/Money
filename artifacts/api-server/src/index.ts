import app from "./app";
import { logger } from "./lib/logger";
import { checkRuntimeConfiguration, startBotRuntime, fatalStartup } from "./lib/bot-runtime";

checkRuntimeConfiguration();

const rawPort = process.env["PORT"];

if (!rawPort) {
  throw new Error(
    "PORT environment variable is required but was not provided.",
  );
}

const port = Number(rawPort);

if (Number.isNaN(port) || port <= 0) {
  throw new Error(`Invalid PORT value: "${rawPort}"`);
}

const server = app.listen(port, (err) => {
  if (err) {
    logger.error({ err }, "Error listening on port");
    process.exit(1);
  }

  logger.info({ port }, "Server listening");
  void startBotRuntime().catch(fatalStartup);
});

for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.once(signal, () => {
    logger.info({ signal }, "Stopping API and bot workers");
    // Stop all timer-driven workers together; PostgreSQL releases the session
    // lock when this process exits. Persisted cursors survive the restart.
    server.close();
    process.exit(0);
  });
}
