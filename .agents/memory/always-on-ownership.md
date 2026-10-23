---
name: Always-on deployment and ownership
description: User-approved hosting and access-control intent; development-to-production bot handoff.
---

Prepare Reserved VM hosting for continuous monitoring, but leave publishing
and hosting-cost approval to the user. Restrict dashboard administration to
the configured owner's verified email and Telegram navigation/delivery to
the existing owner chat.

**Why:** The user asked for 24/7 operation and approved preparing hosting plus
owner protections. They provided the owner email through a form; keep that
contact detail in environment configuration, not project memory.

**How to apply:** Never use first-visitor ownership or let `/start` replace the
destination. Preserve current monitoring while preparing deployment. At cutover,
run Telegram workers only in the published production instance; keep development
workers paused while leaving the development dashboard available. Publish code
changes to the existing production deployment when the user requests it. A
PostgreSQL lock only coordinates processes sharing a database; separate
development and production databases do not prevent competing Telegram polling
consumers.

**Why:** The user explicitly wants just one active Telegram bot instance and
wants improvements applied to the already-published bot, not a parallel
development bot.
