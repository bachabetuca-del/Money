---
name: Market history and recency
description: Historical coverage, monetary scope, and recent-trade presentation in Telegram.
---

Include available public market history from before the bot was created, not merely the records collected live since startup. Keep historical operations within the chosen monetary section; do not add small trades as background context.

**Why:** The user wanted more historical context and explicitly chose “Solo las del rango elegido: $5k–$10k o $10k+”.

**How to apply:** Every qualifying historical trade should contribute to the graph, rather than truncating to the last six. Aggregate into clearly labeled time intervals when needed for phone readability. Explain that bar values are summed value per interval, not an individual purchase. Historical retrieval must not replay old transactions as new chat alerts or change the one-message dashboard.

Distinguish recent trades by their actual execution time relative to the current clock, never by import time or the time of the latest record in the dataset. The current presentation highlights the last 15 minutes and outlines the interval containing the latest trade; the top card retains that individual trade's exact amount and timestamp.

**Why:** The user specifically wanted to identify the most recent operations. Importing old data today must not make it appear recent. A quiet market's last trade may itself be old.

**How to apply:** Retain YES/NO direction colors while distinguishing older and recent activity. Use the trading period for the plot extent so idle time does not compress the history into a tiny portion of the image; compute recency against wall-clock time independently.

Only call the available historical import complete after all source pages succeed. Otherwise show loading or incomplete status and resume safely.

**Why:** A growing partial graph must not be represented as a complete market history.

**How to apply:** Preserve progress across restarts, deduplicate live/history overlap, and reconcile missed intervals without sending extra messages.
