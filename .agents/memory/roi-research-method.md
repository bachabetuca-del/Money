---
name: ROI research and forward evaluation
description: Interpretation, historical coverage and prospective evidence boundaries for ROI research.
---

Use equal hypothetical stakes per observed execution, held to official final binary market settlement, as the default research comparison—not volume-weighted trader profitability. The user delegated the choice to our recommendation to assess whether an approach could make money.

Require at least 50 distinct verified settled games for the market explorer's comparable ROI eligibility and new Telegram ROI signals, rather than 10.

**Why:** The user asked to increase the sample to at least 50 games for a stronger historical basis.

**How to apply:** Count distinct games, not executions. Apply the minimum to ROI ordering/filtering, color eligibility and new alert qualification. Keep previously frozen alert evidence unchanged; a larger sample is not proof of profitability.

**Why:** Public activity does not reveal actual portfolios, opening versus closing transactions, attainable fills, or realized profits. Large operations and correlated executions from one game otherwise distort comparisons.

**How to apply:** Keep the stake and the distinction between gross and estimated net explicit. Resolve each bet from its official market settlement, never the game's score or its last traded price. Pending, provisional, unsupported payouts and invalid observations cannot become losses or fabricated returns. Show coverage, distinct-game estimates and recent performance with sample-size and hindsight warnings; none establishes future profitability. Use only saved monitor history, not a claim of complete exchange coverage. Keep enrichment inside the existing singleton production runtime, with development workers disabled and no new Telegram notifications.

Default to markets whose available execution history has been fully reconciled after official settlement. Keep an explicit opt-in for partial histories, with visible coverage and errors. A finished game's final reconciliation is a one-time audit, not renewed recurring game/trade polling.

**Why:** Stopping live checks at game end can leave gaps precisely in the resolved markets used for backtesting. Mixing those partial histories into the main ranking can bias it. Fast live ingestion and a large number of official results do not establish historical completeness; those are separate stages, not substitutes for final reconciliation.

**How to apply:** Certify only after both available trade sources finish all pages successfully. Changing validation rules or the capture floor requires a new full pass, not just an incremental refresh. Canonical corrections must preserve notification/delivery timestamps and never replay old alerts. Keep sub-cent transaction values through ingestion and storage; round for display, not band eligibility. An audit proves retrieval of the provider's available data for known markets, not complete exchange-wide coverage.

Finish resumable current-version final audits before starting more legacy imports, while preserving priority for a user-selected chart. Apply the same priorities before the database candidate limit and in the worker.

**Why:** Legacy in-progress flags and old timestamps can otherwise fill a bounded candidate window indefinitely, starting thousands of imports without completing verified markets.

Keep the primary comparison side-specific, following the user's compact table reference with American odds and wins/total. Aggregate sport or market views may combine directions, but must not be presented as one YES or NO strategy.

**Why:** The user wants to compare distinct sport, market, direction and odds combinations. Pooling opposite directions can hide their different returns or inflate the apparent sample supporting a single strategy. “Muestras” means observed executions, not independent games or traders.

**How to apply:** Keep the primary table compact without weakening verified-history eligibility or sample-size warnings. Treat changes in display format separately from changes in the underlying research method.

The user wants to compare historical accuracy by observed transaction size, alongside accuracy percentages, distinct-game counts and weekly ROI. Keep accuracy, return and consistency separate; trade amounts are not recommended personal stakes.

**Why:** The user asked whether the combined ranking identified the odds that win most consistently, although it ranks historical return. A profitable aggregate can have a low hit rate or depend on a small number of games.

**How to apply:** Use execution-week cohorts, Monday–Sunday in New York, rather than moving past observations into their later settlement weeks. Empty weeks have unknown returns, not zero returns. Show under-minimum monetary subgroups but do not label them as leaders. Calendar-week results remain historical observations, not forward validation or proof of future profitability.

Keep distinct soccer bet conditions separate when repairing market classification; do not relabel every unrecognized market as a match winner.

**Why:** Both-teams-to-score, exact score, advancement and period winners have different settlement conditions. Mixing them into moneyline would make ROI comparisons misleading. League names such as “Championship” can also describe ordinary fixtures rather than season futures.

**How to apply:** Prefer explicit market identity over broad title keywords. Reclassify saved observations on read, preserving their amounts and settlements. Truly ambiguous or non-match special events may remain in Other rather than receiving an invented match-bet category.

The user requested green/best, yellow/medium and red/bad ROI indicators in Análisis de mercados. For unfinished games, these describe historical comparable groups, not the current game's realized return or winning probability.

**Why:** An unresolved market has no final ROI. Borrowing a broad sport average, the opposite side's better return, or a different odds/amount band could make an unrelated history appear favorable.

**How to apply:** Keep SÍ/NO separate and require an exact comparison group. Use neutral gray for inadequate evidence or unavailable data, label the visual thresholds explicitly, and show the observed reference price's date rather than presenting it as a live quote. Website comparisons load independently so they cannot block live exploration. The user separately requested a Telegram ROI filter; follow the notification rules without changing the website's color thresholds.

The user also wants to filter ROI “en general” in market analysis so games with higher ROI appear first. Interpret this as a global game ordering, not separate sport blocks. A game's ordering reference is its best eligible visible market and side, explicitly identified—not an average or a claim that the game itself has earned that return.

**Why:** An unfinished game has no realized ROI, and averaging opposing bets or letting sport grouping override the order would obscure the comparison the user requested.

**How to apply:** Preserve the existing sport/time navigation as an alternative. Respect the selected money band, side, bet type and search when identifying the ordering reference. An ROI minimum excludes insufficient or unavailable evidence; without a minimum, those games remain available at the end.

Preserve the original equal entry notional when comparing gross and estimated net; treat fees as additional capital, not fewer hypothetical contracts. Current public fee rules applied to history are a scenario, not evidence of the fees actually paid then.

**Why:** The user wants to avoid confusing the existing historical +7% with after-cost profit while retaining the original research comparison. Changing position size or selecting only the observations with cheaper/known fees would make the comparison misleading. Public trades do not reveal actual maker/taker execution, account rounding, rebates or funding costs.

**How to apply:** Declare the execution and fee-time assumptions, distinguish direct-member precision from intermediary costs, and check current official exceptions rather than trusting an old illustrative fee table. Unknown costs remain unknown; never publish an all-history gross beside a net computed from a different covered subset.

Prospective evaluation is separate from retrospective ranking. Freeze qualifying evidence before the first delivery attempt, including the selected rule, observed execution, historical sample and cost assumptions. Retries must reuse it, even after rule changes or history repairs.

**Why:** Recomputing a failed delivery from later results could make the same alert qualify using information unavailable at its original decision. Saving only after successful delivery would also lose that decision when delivery fails.

**How to apply:** Admit only genuinely new live outbox entries after a durable activation boundary; never enroll legacy entries or replays later. Keep undelivered signals visible but outside post-alert returns. Evaluate confirmed deliveries using later official binary verification, not the scoreboard. Preserve the original fee estimate, including unknown costs, rather than repricing older signals with a newer model.
