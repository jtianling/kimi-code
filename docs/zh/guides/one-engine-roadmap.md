# 单引擎路线（方案 B）

本文是 Kimi Code CLI 终端界面（TUI）从「进程内引擎」迁移到「服务端单引擎」的工作地图，面向维护者与贡献者。文中所有数字均于 2026-08-02 在 `before-one-engine`（`286c14a50`）上逐项复核，而非估算。

::: info 说明
本文描述的是进行中的架构迁移路线，不是当前发布版本的行为。当前发布行为见[会话与上下文](./sessions.md)。
:::

**当前进度（2026-08-02）**：全部里程碑已完成。里程碑 1（IPC 挂载）、3（B 类契约）、4（D 类尾巴）、2（交互桥线上化）与 TUI 切流两阶段（SDK 全面 facade 化 + harness/CLI 远程模式）均已落地：TUI 可经 `KIMI_REMOTE=1`（或 `KIMI_REMOTE_SOCKET`）连到 kap-server 托管的同一个引擎，`ServerTurnObserver` 在远程模式下自动惰性。`reloadSession` 按停止规则从里程碑 3 跳过——v2 无任何可上线的 reload 语义（`core-api.ts:338` 是死声明，唯一移植是 sdk-rpc-client-v2 的进程内组合），重实现属新行为而非镜像；单引擎后 TUI 不再持有独立上下文，该概念随之消失。

## 背景：双引擎接缝

今天的 TUI 在自己的进程里内嵌一个引擎实例（`agent-core`，经 `@moonshot-ai/kimi-code-sdk` 的内存 RPC 访问）；kap-server（`kimi web`）进程里是另一个引擎实例（`agent-core-v2`）。两者可以加载同一条 session（同一份磁盘持久化），但各自持有独立的内存上下文，磁盘是唯一交汇点——这就是「双引擎接缝」。

接缝的直接后果：外部客户端经 REST `POST /api/v1/sessions/{id}/prompts` 注入的轮次由 server 端引擎执行，attach 同一 session 的 TUI 对此零感知。当前的缓解机制是实验 flag `tui-server-sync`（`ServerTurnObserver`，见 `apps/kimi-code/src/tui/controllers/server-turn-observer.ts`）：TUI 经 WebSocket 订阅 server 事件、显示外部轮次进度、轮次结束后 `reloadSession()` 从磁盘整体重放。它让接缝「可用」，但消除不了接缝本身——轮次期间没有流式输出、同步是清屏重放、Esc 放开输入门后两个引擎可能并发写同一条 session。

方案 B 是根治：TUI 取消进程内引擎，成为 kap-server 内同一个 `agent-core-v2` 引擎的纯客户端。

```text
今天(双引擎)                          目标(单引擎)
┌──────────────┐                     ┌──────────────┐
│ TUI 进程      │                     │ TUI 进程      │
│  内嵌引擎(v1) │  磁盘是唯一交汇点    │  纯客户端     │
└──────────────┘                     └──────┬───────┘
┌──────────────┐                            │ klient IPC(unix socket)
│ kap-server    │                     ┌─────▼───────┐
│  引擎(v2)     │                     │ kap-server   │
└──────▲───────┘                     │  引擎(v2)    │
       │ REST/WS                     └──────▲───────┘
       外部客户端注入                          │ REST/WS 与 IPC 落到同一引擎
```

## 当前状态

三面实测（2026-08-02）：

| 面 | 位置 | 数量 |
|---|---|---|
| TUI 实际使用的 v1 SDK session 方法 | `apps/kimi-code/src`（86 个文件 import SDK） | 52 个（SDK `Session` 共 59 个 public 方法，7 个零调用） |
| v2 引擎 RPC 方法 | `packages/agent-core-v2/src/agent/rpc/core-api.ts` | 41 个（`AgentAPI` 10 + `SessionAPI` 10 + `CoreAPI` 21） |
| klient 契约已暴露的方法 | `packages/klient/src/contract/` | 22 个端到端可用（agent rpc 5 + agent services 13 + global plugins 4） |

两个容易误判的事实：

- v2 的 RPC 面在 upstream `430cd382a`（2026-07-22）从 72 个方法削减到 41 个，被砍的方法迁往**域服务**（`goalService`、`fullCompactionService`、`btwService`、`taskService`、`profileService`、`swarm`、`workspaceDirs` 等）。所以「补覆盖」的镜像对象是域服务接口，不再是 `core-api.ts`。
- kap-server 的生产 REST 面已覆盖 41 个 RPC 中的约 26 个（63%），但**没有任何 `/plugins` 路由**（7 个 plugin 方法只在 `--debug-endpoints` 反射面可用），`cancelCompaction`、`reloadSession` 也未上 REST。

## 工作分类

52 个 TUI 方法按迁移性质分五类。B 类是工作量主体但风险低（编译器兜底），C 类是唯一需要重新设计的部分。

### A 类 — 已端到端打通（22）

`prompt`、`steer`、`cancel`、`runShellCommand`、`cancelShellCommand`、`getContext`、`getPlan`、`clearPlan`、`setPlanMode`、`setModel`、`setPermission`、`listBackgroundTasks`、`stopBackgroundTask`、`getBackgroundTaskOutput`、`installPlugin`、`listPlugins`、`listPluginCommands`、`getPluginInfo`、`setPluginEnabled`、`setPluginMcpServerEnabled`、`removePlugin`、`reloadPlugins`。

### B 类 — 仅缺 klient 覆盖（约 20）

能力在 v2 域服务中已存在，补 zod schema + facade 即可。`packages/klient/AGENTS.md` 说明契约由 `test/contract-parity.ts` 的编译期断言钉住，引擎类型一变 tsc 先报错，这类工作有编译器兜底。

| TUI 方法 | v2 落点 | 备注 |
|---|---|---|
| `activateSkill` / `listSkills` | `agent/skill/skillService.ts` | |
| `createGoal` / `getGoal` / `pauseGoal` / `resumeGoal` / `cancelGoal` | `agent/goal/goalService.ts:487-620` | |
| `compact` / `cancelCompaction` | `agent/fullCompaction/fullCompactionService.ts:327` | 改名 `beginCompaction`；已确认 TUI 不依赖 `onWillCompact` hook 拦截（全仓 0 匹配），只用触发/取消 |
| `startBtw` | `session/btw/btw.ts:33` | |
| `undoHistory` | rpc 层 | 生产 REST 已有 `POST :undo` |
| `setThinking` | `agent/profile/profileService.ts:410` | |
| `getSessionWarnings` / `getMcpStartupMetrics` | 同名服务 | |
| `listMcpServers` | 同名服务 | |
| `addAdditionalDir` | `workspace/workspaceDirs/workspaceDirs.ts:39` | 已升为 workspace scope |
| `detachBackgroundTask` | `agent/task/taskService.ts:643` | 改名 `detach` |
| `reloadSession` | 同名服务 | 单引擎后大概率不再需要，见下文 |
| `getTools` / `setActiveTools` | `agent/profile/profileOps.ts:161` | TUI 当前未直接调，迁移时可能需要 |
| `setSwarmMode` | `agent/swarm/swarm.ts:9-10` | `enter` / `exit` |

### C 类 — 编程模型变更（3）

能力存在，但形态从回调改为拉取/应答，`apps/kimi-code/src/tui/reverse-rpc/` 那一层要按新模型重写。这是方案 B 里唯一需要设计而非机械平移的部分。

| TUI 方法 | klient 侧形态 |
|---|---|
| `setApprovalHandler` | `sessionApprovalContract.listPending` / `decide`（`contract/session/approval.ts:32-34`） |
| `setQuestionHandler` | `sessionQuestionContract.listPending` / `answer` / `dismiss`（`contract/session/question.ts:52-55`） |
| `onEvent` | klient `events.*` hub |

`SessionStatus` 已定义 `'running' | 'idle' | 'awaiting_approval' | 'awaiting_question'`（`packages/klient/src/core/facade/session.ts:61`），「等待人工介入」状态本身可上线，弹窗能力不会丢失。

### D 类 — v2 确实没有（2）

| TUI 方法 | 现状 |
|---|---|
| `getCronTasks` | **已上线（2026-08-02）**。经 `sessionCronService` 域服务直连（`list` + `getNextFireForTask`），无需 core-api RPC；facade 组合出 v1 的 `nextFireAt` 快照，纯计算（`computeDisplayNextFire`）留在客户端 |
| `applyPersistedSecondaryModel` | **已上线（2026-08-02）**。facade 组合现有服务：config reload → 读 `secondaryModel` 配置段 → `modelService.get` 校验配方 → `sessionSecondaryModelWarningService.recheck` 刷新警告，未新增引擎能力 |

### E 类 — 不迁移（4）

`init`、`handlePrintMainTurnCompleted`（仅 print 模式）、`getResumeState`、`getStatus`。`getStatus` 的语义已被 klient facade 的 `session.status` 覆盖；`getResumeState` 属 v1 的 resume 记账，单引擎后由 server 持有会话生命周期，该概念消失。

## 里程碑地图

按依赖顺序切四个里程碑，各自独立可验证。

### 里程碑 1：kap-server 挂载 klient IPC（前置，约 5-15 行）—— 已完成

`serveKlientIpc({ scope, socketPath, token })`（`packages/klient/src/transports/ipc/host.ts:51`）服务一个已 bootstrap 的引擎 scope，自己不创建引擎。接入点就在 `packages/kap-server/src/start.ts` bootstrap 出 `core: Scope` 之后，socket 为 `<home>/server/klient-<实际绑定端口>.sock`，token 复用 `authTokenService` 的持久 token，`close()` 在引擎 dispose 前关闭；挂载失败只告警不阻断启动。自动化测试（`packages/kap-server/test/klientIpc.test.ts`）证明：klient 经 unix socket 完成一轮完整对话，且该轮次经同一 session 的 REST transcript 可读——IPC 与 REST 同引擎。

### 里程碑 2：C 类 reverse-rpc 重写（唯一的设计工作）

设计已定稿（2026-08-02，经代码核对修正）。核心转变：审批/提问从「引擎回调 TUI」（v1 的 `setApprovalHandler` / `setQuestionHandler` 反向 RPC）改为「引擎 pending 交互列表为唯一真源，客户端订阅渲染并应答」。

**关键事实：这座桥已经存在，但是进程内的。** `packages/node-sdk/src/v2/session-wiring.ts` 的 `SessionEventWiring` 正是本设计的进程内实现——它订阅 `ISessionInteractionService.onDidChangePending`，把 pending 交互（approval / question / **user_tool**，三类都已桥接）喂给 TUI 的 v1 回调，经 `ISessionApprovalService.decide` / `ISessionQuestionService.answer|dismiss` / 内核 `respond` 写回。TUI 的 reverse-rpc 面板层（`types.ts` / `adapter.ts` / `modal-coordinator.ts` / controllers）**全部保留不动**，因为 SDK v2 客户端维持了 v1 的 API 形状。`user_tool` 不是缺口：`bridgeUserTool` 已把它路由给客户端的 `toolCall` 回调。

因此 M2 的真实工作是把这座桥**改写为走 klient facade（传输无关）**，而不是在 TUI 里新建 watcher：

1. **交互桥线上化。** klient session 事件 hub 已有 `interactions.changed`（全量 pending 列表推送）+ `listPending()` 基线 + `decide` / `answer` / `dismiss` / `respond`——`SessionEventWiring` 的桥接逻辑可以逐句映射到 facade 调用，dedup 集合与写回语义不变。memory 与 ipc 传输按构造字节一致，facade 化即自动获得远程能力。
2. **事件流线上化（主要工作量）。** 进程内 wiring 直接订阅每个 agent 的 `IEventBus` 原始流（含中途出现的子 agent），klient hub 目前只注册 13 种事件类型。但 klient dispatcher 的 agent `events` 流本就转发全量原始总线（hub 的 13 种只是 facade 层策展）——在 klient 增加一个原始全保真 agent 事件订阅（不过滤 `type` 的流注册），`translateDomainEvent`（丢弃 v2-only 类型、`task.*` → `background.task.*` 改名、补 sessionId/agentId 戳）继续留在客户端。子 agent 发现：`metadata.changed`（session hub 事件，携带 agents 表）+ 原始流兜底。
3. **`withStatusSnapshot` 增强的取舍。** 进程内版在 `agent.status.updated` 事件边缘融合 usage/contextTokens/model 快照，用到 `IAgentUsageService` / `IAgentProfileService`（已上线）与 `IAgentContextSizeService` / `IWireService` / `IModelCatalog`（未上线）。优先按 B 类模式补这几个只读契约；若某项镜像不通，接受降级快照并记录。

生命周期与竞态语义沿用进程内版已证明的性质：pending 全量推送天然幂等；中途 attach 经 `listPending()` 基线接住存量；迟到的应答对内核 `respond` 是安全 no-op；切 session 只退订不取消。

**验收**：交互桥与事件流在 memory 与 ipc 双传输下行为一致——memory 模式（现有 TUI v2 路径）无回归，且有 ipc 传输的集成测试证明审批/提问/事件经 unix socket 端到端可用（YOLO 关闭时）。

### 里程碑 3：B 类契约补全（机械主体）—— 已完成

上表条目除 `reloadSession`（按停止规则跳过，见文首进度说明）外全部上线：zod schema 镜像域服务接口 + facade 接线 + `contract-parity` 断言。几处落点与假设不同，已验证并记录：`activateSkill` 走 `agentRPCService`（域服务返回不可序列化的 `Turn`）；`listSkills` 由 dispatcher 按 `modelResolver.generate` 先例合成；`cancelCompaction` 走 RPC 层（域服务无 cancel）；`setActiveTools` 走 `IAgentProfileService.update`；MCP 读面在 agent scope 的 `IAgentMcpService`。TUI 的 SDK 调用点切换是后续切流工作。

### 里程碑 4：D 类尾巴 —— 已完成

cron 经 `sessionCronService` 域服务直连上线（只读 `list` + `getNextFireForTask`），`applyPersistedSecondaryModel` 经 facade 组合现有服务上线（config reload → 配置段读取 → 配方校验 → 警告刷新），均未新增引擎 RPC。契约地图至此 100% 完整。

## 完成后的收益

单引擎落地后，方案 A 的 `ServerTurnObserver` 整套机制（WebSocket 订阅、input gate、Esc hatch、磁盘重放）整体退役：外部客户端经 REST 注入的轮次与 TUI 操作落在同一个引擎上，轮次事件经 klient events hub 直接流式到 TUI，无接缝、无重放、无并发写风险。

**落地状态（2026-08-02）**：远程模式已实现为 opt-in（`KIMI_REMOTE=1` / `KIMI_REMOTE=auto` / `KIMI_REMOTE_SOCKET`，见 `apps/kimi-code/src/cli/remote.ts`），observer 在远程模式下自动惰性；进程内引擎仍是默认，observer 代码为进程内模式保留，待远程模式成为默认后统一清理。xats 场景下 `KIMI_REMOTE=auto` 会经 `KIMI_XATS_BASE_URL` / `KIMI_XATS_SESSION_ID` 自动选中 launcher 命名的 server。

## 已知风险与未决项

- C 类是唯一没有编译器兜底的部分，重写 reverse-rpc 层时需要逐弹窗场景核对（审批、提问、权限升级）。
- `reloadSession` 已按停止规则从里程碑 3 跳过（v2 无可上线等价物；单引擎后该概念消失），不再占用后续工作。
- v2 `core-api.ts:157-159` 残留死代码 `EnterSwarmPayload`，补 swarm 契约时可顺手清理（里程碑 3 未触及）。
- `setPermission` 在生产 REST 仅作为 prompt body 字段部分暴露，无独立路由；klient 契约已有，不受影响，但 REST 面补齐是另一个独立话题。
