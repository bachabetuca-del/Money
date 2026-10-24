---
name: Single Telegram dashboard
description: The user's low-clutter Telegram navigation and persistent graph requirements.
---

Use one live dashboard message per linked chat, with sport → game → market buttons. Selecting a market replaces the content of that same message. Qualifying trades update the selected graph in place; new markets must collect data without posting additional graph messages.

**Why:** The user explicitly clarified that a graph per market still cluttered the chat and wanted categories plus one constantly updating graph, not a new graph whenever data changes.

**How to apply:** Preserve the selected market and message identity across background updates and restarts. Keep the approved phone-readable card appearance. Group a game's winner, spread, and totals markets under the actual matchup, rather than treating market-type suffixes as separate games. Removing a Telegram message must not remove saved public trade history.

The single-message rule applies to graphs. The user later authorized a separate latest-only short push notification for fresh individual trades over $10k; see [notification rules](telegram-push-notifications.md).

The website is also an analysis surface, not only a bot configuration page:
the user wants the information organized there with dynamic, understandable
graphs, especially for desktop use.

**Why:** The user explicitly requested organized website information and
dynamic graphs while using the computer.

**How to apply:** Keep web analysis consistent with Telegram's sport → game →
market grouping, independent value bands, historical context and honest
direction labels. Preserve owner access and production-only bot operation.
