---
name: Explorer performance boundary
description: Performance tradeoffs that must preserve live execution freshness and filter isolation.
---

Reuse short-lived catalog snapshots across market selections, but keep execution queries fresh and validate selections against every active filter even when omitting the catalog from a detail response. A failed refresh must not silently become a successful response carrying indefinitely old data.

**Why:** Repeated whole-catalog work competes with live workers as history grows; caching executions or weakening selection checks would change the user's analysis rather than merely make it faster.

**How to apply:** Keep filters and configured band thresholds isolated in cache identity, preserve visible snapshot timestamps, bound cache memory and deduplicate concurrent loads. Website refresh throttling must not pause ingestion or change Telegram alerts. Development benchmarks do not establish production latency; measure production separately after publishing.
