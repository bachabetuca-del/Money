---
name: Kalshi credential formatting
description: Avoid unnecessary key replacement when secure input changes PEM line formatting.
---

Before asking the user to generate another Kalshi key pair after a PEM parse failure, distinguish invalid key material from altered whitespace or escaped line breaks. Never print the key to investigate.

**Why:** A user-supplied pair initially failed to parse but successfully authenticated to the public-trade WebSocket after its PEM line formatting was normalized. Asking for another pair would not have addressed that problem.

**How to apply:** Validate complete matching PEM markers and cryptographic parsing server-side, exposing only sanitized results. Keep connection checks read-only and separate from the development Telegram workers.
