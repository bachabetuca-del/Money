---
name: Game lifecycle
description: User's game-status colors and requirement to stop spending requests on completed games.
---

Mark games that have not started in white, games in progress in yellow, and finished games in red. Remove old and finished games from the main list and make their saved history available separately.

**Why:** The user disliked seeing completed games kept in the bot as if still active, and wanted to ensure no time was wasted checking games that had already ended. They later clarified that putting yesterday's finished games at the bottom still leaves unwanted games in the main list.

**How to apply:** Perform the initial classification, then stop automatic individual game/market/history requests for confirmed finished games, including after restarts. Preserve saved trades and the single dashboard message. A finished chart is a static historical view, not a live chart with changing recency highlights. New >$10k notification delivery must not revive a confirmed finished or closed market.

Distinguish a finished game from a settled individual bet. When only market settlement is known, label it “Mercado resuelto” rather than claiming the game ended. If the game status cannot be confirmed, show “Sin confirmar,” not an inferred status based solely on a date or a market's closing time.

**Why:** An individual bet can resolve before its game ends; accurate state labels must not silently stop monitoring games that are actually still in progress.

**How to apply:** Use actual game-status data where available, keep the status label alongside its color, and expose delayed data rather than presenting it as guaranteed current.

Calendar archival is a navigation decision, not evidence that a game ended. Use the New York calendar and official scheduled date when available. Keep an overnight game in the main list only when current, undelayed live data supports it.

**Why:** The user wants yesterday's games removed even when the provider has not confirmed a final. A stale cached “live” state must not keep an old game in the main list indefinitely, but crossing midnight must not hide a genuinely ongoing game.

**How to apply:** Preserve the original status and saved trades when archiving by date. Do not label an uncertain archived game red or “Terminado” merely because its date passed.

The Vigentes selector must show only games with fresh, confirmed live status and scheduled games within the next 48 hours. Keep older confirmed history in the separate Historial selector.

**Why:** The user saw too many future games in Vigentes and explicitly approved limiting that list while retaining prior games and their saved graphs in Historial.

**How to apply:** Use the real schedule timestamp in New York-aware time comparisons when available. A date-only ticker cannot provide kickoff time, so keep its existing validated date fallback; a genuinely live game remains visible beyond 48 hours.

Historical results in Telegram and the website must show only the game's final score (including tennis sets when available). Do not show position outcomes, SÍ/NO settlement, or whether a bet won or lost.

**Why:** The user clarified: “No quiero que me digas si la posición acertó o no solo quiero el resultado del partido me refiero al score.”

**How to apply:** A bounded final-result enrichment is an exception to stopping live monitoring: save finals once per game, share across its markets, and stop retrying unavailable data after limited attempts. Pending retrieval is not proof the score is unavailable. Do not resume trade/history polling or send new trade alerts for finished games.

An opened historical game must take priority over bulk score backfill. “Pending” means not attempted yet, not a failed/missing provider response waiting silently for hours.

**Why:** The user repeatedly saw “Marcador pendiente de cargar” without a result: the game was behind a bulk queue, and null provider responses kept that label throughout long retry waits.

**How to apply:** Reprioritize the existing production worker from validated historical selections, without creating workers or provider requests in web/Telegram handlers. Preserve the failure reason, use bounded retries, and expose missing, unconfirmed or failed provider data honestly after an attempt.
