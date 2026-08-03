# One-engine roadmap (direction B)

This page is the work map for migrating the Kimi Code CLI terminal UI (TUI) from an in-process engine to a single server-side engine. It is written for maintainers and contributors. Every number here was re-verified against the codebase on 2026-08-02 at tag `before-one-engine` (`286c14a50`) — nothing is estimated.

::: info Note
This page describes an in-progress architecture migration, not the behavior of the current release. For current behavior, see [Sessions and context](./sessions.md).
:::

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
| `getCronTasks` | `session/cron/sessionCronService.ts` has a complete service plus agent tools, but no RPC at all. When adding one, expose only the methods that truly need to cross processes; pure computation (e.g. `computeDisplayNextFire`) stays client-side |
| `applyPersistedSecondaryModel` | no 1:1 counterpart in v2, only the `secondaryModel` config section (`app/kosongConfig/configSection.ts:314`); needs a new RPC or a config-based path |

### Class E — not migrating (4)

`init`, `handlePrintMainTurnCompleted` (print mode only), `getResumeState`, `getStatus`. The semantics of `getStatus` are already covered by the klient facade's `session.status`; `getResumeState` is v1 resume bookkeeping — with the server owning the session lifecycle, the concept disappears.

## Milestone map

Four milestones in dependency order, each independently verifiable.

### Milestone 1: mount klient IPC in kap-server (prerequisite, ~5-15 lines)

`serveKlientIpc({ scope, socketPath, token })` (`packages/klient/src/transports/ipc/host.ts:51`) serves an already-bootstrapped engine scope; it does not create an engine. Today `packages/kap-server/src` has zero references to klient. The attachment point is right after `bootstrap` produces `core: Scope` at `packages/kap-server/src/start.ts:242`: one import, `await serveKlientIpc(...)` holding the handle, and `await klientIpc.close()` inside `close()` (`start.ts:352-374`).

Only two decisions are needed: the socketPath convention (suggested `<home>/server/klient-<port>.sock`) and the token (the persistent token from `authTokenService` can be reused, `start.ts:216-227`).

**Acceptance**: with the TUI connected to kap-server over klient IPC, "can the TUI complete a full conversation on klient alone" turns from paper reasoning into a testable question. Everything after this depends on it.

### Milestone 2: class C reverse-rpc rewrite (the only design work)

Rewrite the `src/tui/reverse-rpc/` layer: approvals and questions change from "engine calls back into the TUI" to "the TUI polls/subscribes the pending list and responds"; events change from the `onEvent` callback to a klient `events.*` hub subscription. Track this as its own change, not mixed with the mechanical work.

**Acceptance**: with YOLO mode off, tool approvals and user questions work end-to-end on a klient-only TUI.

### Milestone 3: class B contract completion (the mechanical bulk)

For each of the ~20 items in the table above: add the zod schema (mirroring the domain service interface), wire the facade, extend the `contract-parity` assertions. Use call density as the ordering heuristic — top 5: `setPermission` (15 call sites), `setModel` (5), `getStatus` (5), `getGoal` (5), `cancel` (4).

**Acceptance**: of the 52 TUI methods, everything outside classes C/D/E is reachable through klient, and the TUI's SDK call sites switch to the klient facade in batches.

### Milestone 4: class D tail

Add the cron RPC (only the cross-process subset) and a wire path for `applyPersistedSecondaryModel`.

**Acceptance**: the TUI cron panel and secondary-model persistence work in klient-only mode.

## Payoff

Once one-engine lands, the entire direction-A `ServerTurnObserver` mechanism (WebSocket subscription, input gate, Esc hatch, disk replay) retires: turns injected by external clients over REST and TUI operations land on the same engine, and turn events stream directly to the TUI through the klient events hub — no seam, no replay, no concurrent writes.

## Known risks and open items

- Class C is the only part without compiler backup; the reverse-rpc rewrite needs per-dialog verification (approvals, questions, permission escalation).
- `reloadSession` likely becomes meaningless after one-engine (the TUI no longer holds a separate context), but during milestone 3 the TUI is still a hybrid — the contract is needed as a bridge.
- `core-api.ts:157-159` has leftover dead code (`EnterSwarmPayload`); clean it up while adding the swarm contract.
- `setPermission` is only partially exposed on production REST (as a prompt body field, no dedicated route); the klient contract is unaffected, but completing the REST surface is a separate topic.
