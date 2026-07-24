---
"@moonshot-ai/kimi-code": minor
---

Add an experimental sync of server-driven turns into the attached TUI session: when another client drives the open session through the local kimi server, the TUI shows a notice with a live progress line (current step and running tool), queues typed input, and reloads the session view and context once the external turn finishes. Enable with KIMI_CODE_EXPERIMENTAL_TUI_SERVER_SYNC=1; press Esc to unlock input if an external turn stalls.
