# Always-on Kalshi sports bot

## Publishing

The project is configured for **Reserved VM**, not Autoscale. Publish the project
with both its API service and web frontend. The API's production entry point is
the compiled Node server, not the development server. Its startup health check
is `/api/healthz`. The dashboard is a static Vite build.

Review Reserved VM capacity, region, and cost in Publishing before confirming.
Publishing is a user action; configuring this project does not publish it.

## Required configuration

- Managed PostgreSQL `DATABASE_URL` (provided by Replit).
- `TELEGRAM_BOT_TOKEN` in Secrets.
- Managed Clerk keys; Replit supplies separate production keys when publishing.
- `OWNER_EMAIL`: the owner's sign-in email.
- `TELEGRAM_OWNER_CHAT_ID`: the existing owner's Telegram destination.
- Optional `BOT_WORKERS_ENABLED=false` pauses all automatic bot workers while
  leaving the website running. Any other value enables them.

Never commit tokens, connection strings, or owner contact details into docs.
Sign in or create an account with the configured owner email and verify it.
Development and production have separate Clerk users; using the same email
works without copying Clerk user IDs. Other accounts cannot read or change
settings, even if they can register.

Telegram `/start`, `/menu`, `/sports`, and callbacks are accepted only from
the configured chat. Changing the destination requires changing
`TELEGRAM_OWNER_CHAT_ID` through environment settings and restarting; a Telegram
message or website request cannot replace it.

## Cutover: do not run two copies of the same Telegram bot

1. Keep development monitoring active while reviewing the publishing setup.
2. Immediately before publishing, set `BOT_WORKERS_ENABLED=false` in the
   **development** environment and restart the development API. Do not set this
   shared or production-wide. This briefly pauses monitoring during cutover.
3. For the **first publication**, enable **“Set up your production database with
   your current development data”** in publishing settings. This preserves the
   saved trades, selected graph message, import cursors, and notification
   delivery records. Publish to Reserved VM, leaving production workers enabled.
4. Confirm `/api/healthz` is healthy and production logs show
   `Kalshi sports monitor started`. Send `/menu` from the linked owner chat.
5. Sign in with the owner email on the published dashboard, confirm monitoring
   is enabled and the last-checked time advances. Check an existing game graph.

The PostgreSQL session lock prevents multiple workers using the **same
database**, including overlapping production revisions. It cannot coordinate
development and production when they use separate databases. Always perform
the development pause above; Telegram only permits one polling consumer.

## Persistence and restarts

Use Publishing's database setup to apply the development schema. Do not
manually migrate the managed production database from the workspace.
Verify saved trades and Telegram dashboard state on first publication; data is
copied only when that initial-data option is enabled. Do not overwrite an
existing production database with a development snapshot on later publishes.
On an empty database, startup creates owner
settings with monitoring enabled and a $10,000 large-trade threshold, without
overwriting existing settings. Historical imports refill available market
history, but do not substitute for transferring saved navigation state.

All captured trades, history cursors, navigation, and notification delivery
records are stored in PostgreSQL, not in server memory or local files. The
startup trade snapshot and historical imports do not generate push notices.
Only new individual executions strictly above $10,000 notify.

If the database lock connection is lost, the process exits instead of
continuing as an uncoordinated worker. Check Publishing logs if the process
restarts repeatedly. Hosting does not eliminate Telegram/Kalshi outages.

## Monitoring

`/api/healthz` confirms HTTP availability, not recent successful Kalshi polling.
Use the owner dashboard's last-checked time and last error for feed health.
If updates stop, check deployment logs for Kalshi limits, Telegram conflicts,
missing configuration, or database errors. Do not solve a Telegram conflict by
starting more copies of the bot.
