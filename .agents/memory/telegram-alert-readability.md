---
name: Telegram alert readability
description: Plain-language bet descriptions and phone-readable Telegram cards are required, including historical alerts.
---

Telegram alerts must describe the game and bet in plain language, not raw Kalshi tickers. The description and major trade details must be readable in the phone chat without opening or zooming the image.

**Why:** The user twice objected that the bet description was not easy to read; a graph containing technical identifiers and tiny text did not meet the request.

**How to apply:** Verify the actual image at phone width. Preserve the distinction between public taker direction and a literal identifiable buyer. When changing alert presentation, refresh existing saved messages as well as future messages. Historical metadata can contain old fallback identifiers even when live metadata lookup is now working; retry missing metadata rather than permanently caching lookup failures or sending raw identifiers.

The user approved an earlier phone-readable card appearance: “Ok great I like it now.” They later explicitly requested a prettier, easier-to-read graph: “algo más bonito y fácil de leer.” Earlier approval is not a freeze on the layout when visual improvement is requested.

**Why:** The user values readable game/bet descriptions and clear trade details, but explicitly asked for stronger visual design after historical graphs were added.

**How to apply:** Preserve the plain-language content and one-message behavior, not necessarily the old layout or palette. Check the real rendered graph at 320–390px, with large currency amounts, long bet descriptions, sparse and multi-day history, and both monetary sections. Keep chart labels from colliding or getting clipped.

Prioritize the complete calendar date before team names on Telegram's single-line game buttons. Keep full names available on the rendered card and show dates in the selected game's context too.

**Why:** The user could not tell which day several games were scheduled for because Telegram truncated long team names before the date. Date visibility is more important than preserving the full team name in a single button.

**How to apply:** Use the authoritative scheduled date in New York time when available, otherwise the validated ticker date. Do not substitute trade/import dates or invent a day for season-long championship markets without a confirmed schedule.
