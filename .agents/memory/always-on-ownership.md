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
pause development workers before starting production. A PostgreSQL lock only
coordinates processes sharing a database; separate development and production
databases do not prevent competing Telegram polling consumers.
