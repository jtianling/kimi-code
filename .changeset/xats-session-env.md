---
"@moonshot-ai/kimi-code": patch
---

Fix tool processes on a server-hosted engine inheriting a stale KIMI_XATS_SESSION_ID from the server process, so every xats agent registers and receives pokes on its own session.
