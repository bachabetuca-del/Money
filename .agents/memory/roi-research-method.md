---
name: Historical ROI research method
description: Interpretation and data boundaries for the user's continuously updated ROI ranking.
---

Use equal hypothetical stakes per observed execution, held to official final binary market settlement, as the default research comparison—not volume-weighted trader profitability. The user delegated the choice to our recommendation to assess whether an approach could make money.

**Why:** Public activity does not reveal actual portfolios, opening versus closing transactions, attainable fills, or realized profits. Large operations and correlated executions from one game otherwise distort comparisons.

**How to apply:** Keep the stake and gross-of-fees assumption explicit. Resolve each bet from its official market settlement, never the game's score or its last traded price. Pending, provisional, unsupported payouts and invalid observations cannot become losses or fabricated returns. Show coverage, distinct-game estimates and recent performance with sample-size and hindsight warnings; none establishes future profitability. Use only saved monitor history, not a claim of complete exchange coverage. Keep enrichment inside the existing singleton production runtime, with development workers disabled and no new Telegram notifications.

Default to markets whose available execution history has been fully reconciled after official settlement. Keep an explicit opt-in for partial histories, with visible coverage and errors. A finished game's final reconciliation is a one-time audit, not renewed recurring game/trade polling.

**Why:** Stopping live checks at game end can leave gaps precisely in the resolved markets used for backtesting. Mixing those partial histories into the main ranking can bias it.

**How to apply:** Certify only after both available trade sources finish all pages successfully. Changing validation rules or the capture floor requires a new full pass, not just an incremental refresh. Canonical corrections must preserve notification/delivery timestamps and never replay old alerts. Keep sub-cent transaction values through ingestion and storage; round for display, not band eligibility. An audit proves retrieval of the provider's available data for known markets, not complete exchange-wide coverage.
