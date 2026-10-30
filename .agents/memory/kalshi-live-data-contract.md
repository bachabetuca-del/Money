---
name: Kalshi live-data empty responses
description: Undocumented nullable batch responses and repeated-parameter requirements.
---

Kalshi's live-data batch may return `{"live_datas": null}` when no boards are available, although its published schema describes an array. Treat that explicit value like an empty array, never as a final score. Missing fields, wrong types and conflicting board identities remain genuine errors.

**Why:** A production warning was caused by rejecting this real empty response; nonempty mocked responses did not catch the incompatibility. The provider behavior was confirmed with a read-only public request on 2026-10-30.

**How to apply:** Check both populated and empty real responses when changing this boundary. Use repeated `milestone_ids` parameters as documented. A comma-separated value was also observed to return null rather than a useful validation error, so an empty result does not prove that request encoding is correct. Preserve each game's ID association and distinguish a known future schedule from unavailable live status.
