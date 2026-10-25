---
name: Kalshi shared rate-limit protection
description: Why all Kalshi workers share a pause and development stays off.
---

Keep rate-limit recovery shared across trade polling, historical imports, metadata, game status and final-score requests. A 429 from one worker must pause the others, respecting Retry-After and using bounded increasing backoff when absent. Telegram access to saved information must remain available.

**Why:** The production investigation on 2026-10-25 found at least 39 minutes of upstream 429 errors while the monitor retried every 15 seconds and other workers ran independently. A later log snapshot showed errors continuing; absence in an earlier query was not proof of recovery. The upstream limit's exact cause was not observable. The user explicitly approved adding automatic protection.

**How to apply:** Keep this distinct from API authentication or notification thresholds. Never enable development bot workers to test recovery, and never promise this prevents provider limits or guarantees no missed executions during an upstream outage.
