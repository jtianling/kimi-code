---
"@moonshot-ai/agent-core-v2": minor
"@moonshot-ai/kimi-code": patch
---

Add a "scope" field to MCP server entries so each session can open its own connection to a server instead of sharing one per workspace. Set "scope": "session" on a server entry to use it.
