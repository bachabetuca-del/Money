---
name: Kalshi shared rate-limit protection
description: Why all Kalshi workers share a pause and development stays off.
---

Keep rate-limit recovery shared across trade polling, historical imports, metadata, game status and final-score requests. A 429 from one worker must pause the others, respecting Retry-After and using bounded increasing backoff when absent. Telegram access to saved information must remain available.

**Why:** The production investigation on 2026-10-25 found at least 39 minutes of upstream 429 errors while the monitor retried every 15 seconds and other workers ran independently. A later log snapshot showed errors continuing; absence in an earlier query was not proof of recovery. The upstream limit's exact cause was not observable. The user explicitly approved adding automatic protection.

**How to apply:** Keep this distinct from API authentication or notification thresholds. Never enable development bot workers to test recovery, and never promise this prevents provider limits or guarantees no missed executions during an upstream outage.

Use authenticated public-trade WebSocket as the primary live source, with REST for historical data, metadata and recovery after disconnects or missing stream messages. Do not keep regular trade-feed polling running alongside a healthy stream. Pace REST reads across workers in addition to reacting to 429.

**Why:** The user explicitly approved this hybrid approach to reduce the repeated REST requests behind the rate-limit discussion. WebSocket does not remove REST quotas or expose confirmed exits from previously held positions.

**How to apply:** Keep production as the sole active bot. Validate the connection separately without Telegram or database writes before suggesting publication. Startup snapshots and recovery overlap must not generate historical push alerts; notification deduplication remains independent of graph storage.
