---
name: Telegram push notifications
description: Push-alert eligibility and the low-clutter exception to the single-message dashboard.
---

Send push-enabled short notifications for newly observed individual public sports trades in any of the existing captured amount bands that meet the historical ROI rule below. Do not impose a separate $10k notification minimum or privilege large trades. Startup snapshots, historical imports, and graph/menu updates must not trigger push notifications. The selected dashboard section does not affect alert eligibility.

**Why:** The user superseded the earlier above-$10k-only request with “El monto no me importa tanto con tal que haga dinero”. They prioritize historical performance over transaction size. Telegram edits do not generate new-message notifications, so updating the graph alone cannot meet the notification requirement.

**How to apply:** Keep the graph as one independently updated message, plus a separate brief notification with readable game/bet names and the Kalshi link. Keep dashboard creations/replacements silent as well. Evaluate the value of an individual trade, never the sum of a graph interval or multiple small trades. Do not replay the saved history to populate the notification queue.

Polling and graph-refresh outages must not pause alert delivery. Only explicit Telegram flood limits should impose a shared pause.

**Why:** Production showed alert retries caused by polling/graph connection pauses, even when no alert send had failed. A working menu is not proof of working notifications, and a broken graph is not proof that messages cannot be delivered.

**How to apply:** Preserve failure isolation when revising transport or recovery. Respect Telegram's retry instructions across workers; never loosen ROI eligibility to compensate for delivery problems.

Keep only the latest notification. Confirm and save delivery of a new notice before deleting the previous notice. Never delete the dashboard or trade history.

**Why:** The user explicitly chose “Keep only the latest notification (recommended)” to restore phone alerts without restoring chat clutter.

**How to apply:** Track notification delivery separately from graph publication and trade ingestion. A trade appearing in history or a graph does not prove a notification was sent. Preserve delivery retries and notification message identities through restarts; retry old-notice cleanup separately without resending confirmed deliveries. Telegram/phone mute settings remain outside the bot's control.

The user selected “Solo ROI de +15% o más”: require comparable historical ROI of at least +15.0%, inclusive, in addition to the fresh-trade conditions. This supersedes the earlier +7.0% cutoff.

**Why:** The user asked to restrict push notifications by historical performance, not to remove lower-ROI executions from charts or saved history.

**How to apply:** Match the execution's own sport, bet type, YES/NO side, odds and amount band; never borrow a more profitable band's history. Require the same verified-history sample minimum as the website comparison. Compare before display rounding; the website's green color threshold is not the alert cutoff. Missing or inadequate evidence is silent; a lookup failure must not bypass the filter. Show gross versus estimated net and sample size without implying guaranteed or realized trader profits. Do not replay filtered trades later just because their group's ROI improved.

Keep the existing gross-based notification rule until the owner explicitly saves a net-based choice. Missing net-cost evidence must never silently fall back to gross.

**Why:** The user specifically requested an explicit choice of calculation rather than an automatic change when fee estimates become available. Sorting a ranking is a research action, not consent to change notification behavior.

**How to apply:** Preserve the saved basis on updates from older clients that omit the choice. Keep Telegram's basis independent of chart colors, selected display filters and sorting; changing the choice must not replay older filtered trades.

Use “a favor / en contra” as the public direction of an operation, not as a confirmed sale or closed position.

**Why:** The user clarified that buying SÍ/NO already works and specifically wants alerts and graphs for selling previously purchased positions. A prior acceptance of public-direction signals does not mean this closing-position requirement is satisfied. Public direction cannot identify the trader or distinguish buying NO from selling SÍ.

**How to apply:** Keep the bet name and direction explicit in notices and graph legends. Never imply the same previous large trader has exited or abandoned a prediction. Do not describe direction-label improvements as implementing confirmed exits; report the missing public data honestly.

The user does not need seller identity: their earlier sales request sought executions explicitly labeled as sales above $10k, their market, push notifications, and corresponding graph marks. The newer ROI-focused notification rules above supersede that amount restriction.

**Why:** They supplied a Kalshi screen showing Bought Yes and Sold No, explicitly said “no necesito saber quién la vendió”, and confirmed that it is public Kalshi activity rather than personal account history.

**How to apply:** Investigate the source of that activity screen rather than requiring account identity as a prerequisite. Distinguish public activity from personal account history. A verified sell-action field may support sale alerts without identifying the trader; directional exposure alone still does not establish a sale.

Keep purchase-amount calculations tied to a validated direction. Explicit YES/NO outcome is authoritative. If missing, canonical book direction may supply it: bid ≡ YES, ask ≡ NO; only then use a validated YES/NO legacy fallback.

**Why:** Kalshi's official order-direction documentation defines outcome and book side as the same directional bit, not separate buy/sell flags. Ignoring a valid canonical book side can discard trades; choosing the opposite outcome's quote can incorrectly cross an amount-band boundary and select the wrong ROI comparison.

**How to apply:** Calculate notional from the resolved outcome's quote and test both sides around the threshold. Do not invert an explicit outcome because book side conflicts. If execution cannot be priced reliably, do not invent a qualifying amount. See https://docs.kalshi.com/getting_started/order_direction.

Explain the public equivalence in alerts and graphs: a favor means compra de SÍ o venta de NO; en contra means compra de NO o venta de SÍ.

**Why:** The two actions share a public directional signal, but the user explicitly distinguishes closing a previous purchase from opening an opposite bet. This explanation is context, not a substitute for the requested exit detection.

**How to apply:** Show the equivalence next to the direction, with a clear warning that the public feed cannot distinguish a purchase from a sale closing an existing position.

Keep the website's Telegram view as a readable history of actual deliveries, not a new list of potential signals.

**Why:** The user asked to see the Telegram notifications on the website with the price, sport and ROI clearly presented. The chat deliberately retains only its latest notice, so removing an older chat message must not erase its useful website history.

**How to apply:** Show the original selected-side price and the historical ROI basis recorded for that notice. Never substitute today's ranking or a later settlement for its original ROI. Older notices without recorded ROI should say it was not recorded, rather than implying zero or reconstructing a profitable signal after the result.

Preserve the readable notification cards the user approved, and show the game's scheduled date/time and current status directly on each card.

**Why:** The user said “Me encanta lo que hicimos” and asked for the match's date, time and an “en vivo” indicator to understand its current status. This is current game context, not another fact to freeze at notification time.

**How to apply:** Refresh game context independently of original price/ROI. Keep New York time explicit and follow the existing lifecycle colors and freshness rules. A passed scheduled start alone does not confirm play, and a resolved individual market does not confirm the game finished.
