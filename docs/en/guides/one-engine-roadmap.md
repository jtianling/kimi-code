# One-engine roadmap (direction B)

This page is the work map for migrating the Kimi Code CLI terminal UI (TUI) from an in-process engine to a single server-side engine. It is written for maintainers and contributors. Every number here was re-verified against the codebase on 2026-08-02 at tag `before-one-engine` (`286c14a50`) — nothing is estimated.

::: info Note
This page describes an in-progress architecture migration, not the behavior of the current release. For current behavior, see [Sessions and context](./sessions.md).
:::

**Current progress (2026-08-02)**: all milestones are done. Milestones 1 (IPC mount), 3 (class-B contracts), 4 (class-D tail), 2 (interaction bridge over the wire), and both TUI-cutover phases (full SDK facade migration + harness/CLI remote mode) have landed: the TUI can attach to a kap-server-hosted engine via `KIMI_REMOTE=1` (or `KIMI_REMOTE_SOCKET`), and the `ServerTurnObserver` goes inert automatically in remote mode. `reloadSession` was skipped under the stop rule — v2 has no wire-exposable reload semantics (`core-api.ts:338` is a dead declaration; the only port is sdk-rpc-client-v2's in-process composition), and reimplementing it would be new behavior rather than mirroring. With one engine the TUI no longer holds a separate context, so the concept disappears.

## Background: the dual-engine seam

Today the TUI embeds an engine instance in its own process (`agent-core`, reached through in-memory RPC in `@moonshot-ai/kimi-code-sdk`); the kap-server process (`kimi web`) hosts another engine instance (`agent-core-v2`). Both can load the same session (the same on-disk persistence), but each holds its own in-memory context — the disk is the only rendezvous point. This is the "dual-engine seam".

The direct consequence: turns injected by external clients via REST `POST /api/v1/sessions/{id}/prompts` are executed by the server-side engine, while a TUI attached to the same session is completely unaware of them. The current mitigation is the experimental flag `tui-server-sync` (`ServerTurnObserver`, see `apps/kimi-code/src/tui/controllers/server-turn-observer.ts`): the TUI subscribes to server events over WebSocket, shows progress for external turns, and replays the session from disk via `reloadSession()` when a turn ends. It makes the seam usable, but does not remove it — no streaming during external turns, sync is a full-screen replay, and after the Esc input-gate release the two engines can write the same session concurrently.

Direction B is the cure: the TUI drops its in-process engine and becomes a pure client of the same `agent-core-v2` engine inside kap-server.

```text
Today (dual engine)                     Target (single engine)
┌──────────────┐                     ┌──────────────┐
│ TUI process   │                     │ TUI process   │
│  in-process   │  disk is the only  │  pure client  │
│  engine (v1)  │  rendezvous        └──────┬───────┘
└──────────────┘                            │ klient IPC (unix socket)
┌──────────────┐                     ┌─────▼───────┐
│ kap-server    │                     │ kap-server   │
│  engine (v2)  │                     │  engine (v2) │
└──────▲───────┘                     └──────▲───────┘
       │ REST/WS                            │ REST/WS and IPC land
       external clients inject              │ on the same engine
```

## Current state

Three-way measurement (2026-08-02):

| Face | Location | Count |
|---|---|---|
| v1 SDK session methods actually used by the TUI | `apps/kimi-code/src` (86 files import the SDK) | 52 (SDK `Session` has 59 public methods, 7 with zero call sites) |
| v2 engine RPC methods | `packages/agent-core-v2/src/agent/rpc/core-api.ts` | 41 (`AgentAPI` 10 + `SessionAPI` 10 + `CoreAPI` 21) |
| Methods exposed through klient contracts | `packages/klient/src/contract/` | 22 end-to-end (agent rpc 5 + agent services 13 + global plugins 4) |

Two facts that are easy to get wrong:

- Upstream `430cd382a` (2026-07-22) cut the v2 RPC surface from 72 methods to 41, moving the removed methods into **domain services** (`goalService`, `fullCompactionService`, `btwService`, `taskService`, `profileService`, `swarm`, `workspaceDirs`, etc.). So the mirror target for "closing coverage" is the domain service interfaces, no longer `core-api.ts`.
- kap-server's production REST surface covers about 26 of the 41 RPCs (63%), but there are **no `/plugins` routes at all** (7 plugin methods are only reachable via the `--debug-endpoints` reflection surface); `cancelCompaction` and `reloadSession` are not on REST either.

## Work classification

The 52 TUI methods fall into five classes by migration nature. Class B is the bulk of the work but low-risk (compiler-backed); class C is the only part that needs redesign.

### Class A — already end-to-end (22)

`prompt`, `steer`, `cancel`, `runShellCommand`, `cancelShellCommand`, `getContext`, `getPlan`, `clearPlan`, `setPlanMode`, `setModel`, `setPermission`, `listBackgroundTasks`, `stopBackgroundTask`, `getBackgroundTaskOutput`, `installPlugin`, `listPlugins`, `listPluginCommands`, `getPluginInfo`, `setPluginEnabled`, `setPluginMcpServerEnabled`, `removePlugin`, `reloadPlugins`.

### Class B — only klient coverage missing (~20)

The capability already exists in v2 domain services; adding a zod schema plus facade wiring is enough. Per `packages/klient/AGENTS.md`, contracts are pinned by compile-time assertions in `test/contract-parity.ts` — when an engine type changes, tsc fails first. This class has compiler backup.

| TUI method | v2 location | Notes |
|---|---|---|
| `activateSkill` / `listSkills` | `agent/skill/skillService.ts` | |
| `createGoal` / `getGoal` / `pauseGoal` / `resumeGoal` / `cancelGoal` | `agent/goal/goalService.ts:487-620` | |
| `compact` / `cancelCompaction` | `agent/fullCompaction/fullCompactionService.ts:327` | renamed `beginCompaction`; confirmed the TUI does not depend on the `onWillCompact` hook (0 matches repo-wide), only begin/cancel |
| `startBtw` | `session/btw/btw.ts:33` | |
| `undoHistory` | rpc layer | production REST already has `POST :undo` |
| `setThinking` | `agent/profile/profileService.ts:410` | |
| `getSessionWarnings` / `getMcpStartupMetrics` | same-name services | |
| `listMcpServers` | same-name service | |
| `addAdditionalDir` | `workspace/workspaceDirs/workspaceDirs.ts:39` | promoted to workspace scope |
| `detachBackgroundTask` | `agent/task/taskService.ts:643` | renamed `detach` |
| `reloadSession` | same-name service | likely unnecessary after one-engine, see below |
| `getTools` / `setActiveTools` | `agent/profile/profileOps.ts:161` | not called by the TUI today; may be needed during migration |
| `setSwarmMode` | `agent/swarm/swarm.ts:9-10` | `enter` / `exit` |

### Class C — programming-model changes (3)

The capability exists, but the shape changes from callbacks to pull/respond, and the `apps/kimi-code/src/tui/reverse-rpc/` layer must be rewritten for the new model. This is the only part of direction B that requires design rather than mechanical translation.

| TUI method | klient-side shape |
|---|---|
| `setApprovalHandler` | `sessionApprovalContract.listPending` / `decide` (`contract/session/approval.ts:32-34`) |
| `setQuestionHandler` | `sessionQuestionContract.listPending` / `answer` / `dismiss` (`contract/session/question.ts:52-55`) |
| `onEvent` | klient `events.*` hub |

`SessionStatus` already defines `'running' | 'idle' | 'awaiting_approval' | 'awaiting_question'` (`packages/klient/src/core/facade/session.ts:61`), so the "waiting for human input" state itself is wire-ready — the dialog capability is not lost.

### Class D — genuinely missing in v2 (2)

| TUI method | Status |
|---|---|
| `getCronTasks` | **Wired (2026-08-02)**. Served by direct domain-service access on `sessionCronService` (`list` + `getNextFireForTask`) — no core-api RPC needed; the facade composes the v1 `nextFireAt` snapshot and pure computation (`computeDisplayNextFire`) stays client-side |
| `applyPersistedSecondaryModel` | **Wired (2026-08-02)**. The facade composes existing services: config reload → read the `secondaryModel` section → validate the recipe via `modelService.get` → refresh the warning via `sessionSecondaryModelWarningService.recheck`; no new engine capability |

### Class E — not migrating (4)

`init`, `handlePrintMainTurnCompleted` (print mode only), `getResumeState`, `getStatus`. The semantics of `getStatus` are already covered by the klient facade's `session.status`; `getResumeState` is v1 resume bookkeeping — with the server owning the session lifecycle, the concept disappears.

## Milestone map

Four milestones in dependency order, each independently verifiable.

### Milestone 1: mount klient IPC in kap-server (prerequisite, ~5-15 lines) — done

`serveKlientIpc({ scope, socketPath, token })` (`packages/klient/src/transports/ipc/host.ts:51`) serves an already-bootstrapped engine scope; it does not create an engine. The attachment point is right after `bootstrap` produces `core: Scope` in `packages/kap-server/src/start.ts`; the socket is `<home>/server/klient-<boundPort>.sock`, the token reuses the persistent `authTokenService` token, and `close()` stops the IPC host before the engine is disposed. A mount failure logs a warning and never fails boot. An automated test (`packages/kap-server/test/klientIpc.test.ts`) proves a klient over the unix socket completes a full turn that is then readable through the same session's REST transcript — IPC and REST share one engine.

### Milestone 2: class C reverse-rpc rewrite (the only design work)

Design finalized (2026-08-02, corrected after code verification). The core shift: approvals and questions move from "engine calls back into the TUI" (v1's `setApprovalHandler` / `setQuestionHandler` reverse RPC) to "the engine's pending-interaction list is the single source of truth; the client subscribes, renders, and responds".

**Key fact: the bridge already exists, in-process.** `SessionEventWiring` in `packages/node-sdk/src/v2/session-wiring.ts` is exactly this design implemented in-process — it subscribes `ISessionInteractionService.onDidChangePending`, feeds pending interactions (approval / question / **user_tool** — all three kinds are bridged) to the TUI's v1 callbacks, and writes outcomes back via `ISessionApprovalService.decide` / `ISessionQuestionService.answer|dismiss` / the kernel's `respond`. The TUI's reverse-rpc panel layer (`types.ts` / `adapter.ts` / `modal-coordinator.ts` / controllers) **survives untouched**, because the SDK v2 client preserves the v1 API shape. `user_tool` is not a gap: `bridgeUserTool` already routes it to the client's `toolCall` callback.

M2's real work is therefore re-expressing this bridge **over the klient facade (transport-agnostic)**, not building a new watcher in the TUI:

1. **Wire the interaction bridge.** The klient session events hub already has `interactions.changed` (full pending-list pushes) + a `listPending()` baseline + `decide` / `answer` / `dismiss` / `respond` — the wiring's bridge logic maps line-for-line onto facade calls, with the dedup set and write-back semantics unchanged. The memory and ipc transports are byte-identical by construction, so going through the facade yields remote capability for free.
2. **Wire the event stream (the bulk of the work).** The in-process wiring subscribes every agent's raw `IEventBus` stream (including subagents appearing mid-turn); the klient hub currently registers only 13 curated event types. But the klient dispatcher's agent `events` stream already forwards the full raw bus (the 13 types are facade-level curation) — add a raw, full-fidelity agent event subscription to klient (a stream registration without a `type` filter), and keep `translateDomainEvent` (dropping v2-only types, renaming `task.*` → `background.task.*`, stamping sessionId/agentId) client-side. Subagent discovery: `metadata.changed` (a session hub event carrying the agents table) with the raw stream as backstop.
3. **The `withStatusSnapshot` trade-off.** The in-process version folds a usage/contextTokens/model snapshot into `agent.status.updated` at the edge, using `IAgentUsageService` / `IAgentProfileService` (already wired) plus `IAgentContextSizeService` / `IWireService` / `IModelCatalog` (not wired). Prefer wiring those read-only contracts following the class-B pattern; where mirroring fails, accept a degraded snapshot and record it.

Lifecycle and race semantics inherit the properties already proven in-process: full-list pushes are naturally idempotent; mid-attach catch-up comes from the `listPending()` baseline; a late answer is a safe no-op against the kernel's `respond`; switching sessions unsubscribes without cancelling.

**Acceptance**: the interaction bridge and event stream behave identically on both transports — no regression in memory mode (the current TUI v2 path), plus an integration test over the ipc transport proving approvals, questions, and events work end-to-end through a unix socket (with YOLO off).

### Milestone 3: class B contract completion (the mechanical bulk) — done

Every item in the table above is wired except `reloadSession` (skipped under the stop rule, see the progress note up top): zod schemas mirroring the domain service interfaces, facade wiring, and `contract-parity` assertions. A few landings deviate from the initial guesses, verified and recorded: `activateSkill` goes through `agentRPCService` (the domain service returns a non-serializable `Turn`); `listSkills` is synthesized in the dispatcher following the `modelResolver.generate` precedent; `cancelCompaction` goes through the RPC layer (the domain service has no cancel); `setActiveTools` goes through `IAgentProfileService.update`; the MCP read side lives on the agent-scoped `IAgentMcpService`. Switching the TUI's SDK call sites over is the later cutover work.

### Milestone 4: class D tail — done

Cron is wired via direct `sessionCronService` access (read-only `list` + `getNextFireForTask`), and `applyPersistedSecondaryModel` is wired as a facade composition over existing services (config reload → section read → recipe validation → warning refresh) — neither needed a new engine RPC. The contract map is now 100% complete.

## Payoff

Once one-engine lands, the entire direction-A `ServerTurnObserver` mechanism (WebSocket subscription, input gate, Esc hatch, disk replay) retires: turns injected by external clients over REST and TUI operations land on the same engine, and turn events stream directly to the TUI through the klient events hub — no seam, no replay, no concurrent writes.

**Landing status (2026-08-02)**: remote mode ships as opt-in (`KIMI_REMOTE=1` / `KIMI_REMOTE=auto` / `KIMI_REMOTE_SOCKET`, see `apps/kimi-code/src/cli/remote.ts`), with the observer automatically inert in remote mode. The in-process engine remains the default and the observer code is kept for it, to be removed once remote mode becomes the default. Under xats, `KIMI_REMOTE=auto` picks the launcher-named server through `KIMI_XATS_BASE_URL` / `KIMI_XATS_SESSION_ID`.

## Known risks and open items

- Class C is the only part without compiler backup; the reverse-rpc rewrite needs per-dialog verification (approvals, questions, permission escalation).
- `reloadSession` was skipped under the stop rule (no wire-exposable v2 equivalent; the concept disappears with one engine) and no longer blocks later work.
- `core-api.ts:157-159` has leftover dead code (`EnterSwarmPayload`); milestone 3 did not touch it — clean it up when adding the swarm contract's follow-ups.
- `setPermission` is only partially exposed on production REST (as a prompt body field, no dedicated route); the klient contract is unaffected, but completing the REST surface is a separate topic.
