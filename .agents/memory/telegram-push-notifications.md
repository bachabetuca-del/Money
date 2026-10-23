---
name: Telegram push notifications
description: Push-alert eligibility and the low-clutter exception to the single-message dashboard.
---

Send push-enabled short notifications only for newly observed individual public sports trades strictly over $10,000. Exactly $10,000 remains eligible for the upper dashboard section but is silent for push alerts. Smaller trades, startup snapshots, historical imports, and graph/menu updates must not trigger push notifications. The selected dashboard section does not affect alert eligibility.

**Why:** After the single-message dashboard was introduced, the user noticed notifications stopped and asked to restore notifications only for bets above $10k. Telegram edits do not generate new-message notifications, so updating the graph alone cannot meet that request.

**How to apply:** Keep the graph as one independently updated message, plus a separate brief notification with readable game/bet names and the Kalshi link. Keep dashboard creations/replacements silent as well. Evaluate the value of an individual trade, never the sum of a graph interval or multiple small trades. Do not replay the saved history to populate the notification queue.

Keep only the latest notification. Confirm and save delivery of a new notice before deleting the previous notice. Never delete the dashboard or trade history.

**Why:** The user explicitly chose “Keep only the latest notification (recommended)” to restore phone alerts without restoring chat clutter.

**How to apply:** Track notification delivery separately from graph publication and trade ingestion. A trade appearing in history or a graph does not prove a notification was sent. Preserve delivery retries and notification message identities through restarts; retry old-notice cleanup separately without resending confirmed deliveries. Telegram/phone mute settings remain outside the bot's control.

Use “a favor / en contra” as the public direction of an operation, not as a confirmed sale or closed position.

**Why:** The user wanted to know when large traders sell their positions, then explicitly accepted public direction as the alternative after the limitations were explained. Public direction cannot identify the trader or distinguish buying NO from selling SÍ.

**How to apply:** Keep the bet name and direction explicit in notices and graph legends. Never imply the same previous large trader has exited or abandoned a prediction.
