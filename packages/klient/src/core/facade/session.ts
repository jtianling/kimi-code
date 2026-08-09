/**
 * The session facade — one `klient.session(id)` handle aggregating the
 * session-scope services (metadata, activity, approvals, questions,
 * interactions, btw, warnings) plus the app-scope lifecycle service for
 * close/archive/restore/delete/fork/createChild and the workspace-scope
 * `workspaceDirs` for addAdditionalDir. The MCP reads and the AGENTS.md half
 * of the warnings ride the main agent's scope (resolution materializes it —
 * the same `ensureMainAgent` the server's routes perform). `agents()` reads
 * the metadata registry (agent handles are not serializable, so no
 * agent-lifecycle channel exists on the wire).
 */

import type { AgentActivityState } from '@moonshot-ai/agent-core-v2/agent/activityView/activityView';
import type { IAgentMcpService } from '@moonshot-ai/agent-core-v2/agent/mcp/mcp';
import { SECONDARY_MODEL_SECTION } from '@moonshot-ai/agent-core-v2/app/kosongConfig/configSection';
import type { SessionWarning } from '@moonshot-ai/agent-core-v2/app/sessionLegacy/sessionProtocol';
import type { SkillSummary } from '@moonshot-ai/agent-core-v2/app/skillCatalog/types';
import type { ISessionCronService } from '@moonshot-ai/agent-core-v2/session/cron/sessionCronService';
import type { SecondaryModelWarning } from '@moonshot-ai/agent-core-v2/session/subagent/secondaryModelWarning';
import type { IWorkspaceDirs } from '@moonshot-ai/agent-core-v2/workspace/workspaceDirs/workspaceDirs';
import type {
  ApprovalRequest,
  ApprovalResponse,
} from '@moonshot-ai/agent-core-v2/session/approval/approval';
import type {
  Interaction,
  InteractionKind,
} from '@moonshot-ai/agent-core-v2/session/interaction/interaction';
import type {
  QuestionRequest,
  QuestionResult,
} from '@moonshot-ai/agent-core-v2/session/question/question';
import type {
  AgentMeta,
  SessionMeta,
  SessionMetaPatch,
} from '@moonshot-ai/agent-core-v2/session/sessionMetadata/sessionMetadata';

import type { ScopeRef } from '../channel.js';
import type { McpServerConfig } from '../../contract/mcp.js';
import { RPCError } from '../errors.js';
import type { ScopedCaller } from './global.js';

const NOT_FOUND = 40404;
const REQUEST_INVALID = 40001;

export type { ScopedCaller } from './global.js';

/** What `sessionLifecycleService.create/fork/createChild` leaves on the wire. */
interface HandleWire {
  readonly id: string;
}

/**
 * Options for `SessionFacade.restore` — mirrors the engine's
 * `ResumeSessionOptions`. `mcpServers` injects ephemeral per-session MCP
 * servers when restore re-materializes a cold session (ignored when the
 * session is already live).
 */
export interface SessionRestoreOptions {
  readonly additionalDirs?: readonly string[];
  readonly mcpServers?: Readonly<Record<string, McpServerConfig>>;
}

export interface SessionApprovalsFacade {
  list(): Promise<readonly ApprovalRequest[]>;
  decide(id: string, response: ApprovalResponse): Promise<void>;
}

export interface SessionQuestionsFacade {
  list(): Promise<readonly QuestionRequest[]>;
  answer(id: string, result: QuestionResult): Promise<void>;
  dismiss(id: string): Promise<void>;
}

export interface SessionInteractionsFacade {
  list(kind?: InteractionKind): Promise<readonly Interaction[]>;
  respond(id: string, response: unknown): Promise<void>;
}

export interface SessionSkillsFacade {
  /**
   * Every skill in the session-merged catalog as a plain summary (the
   * catalog's readiness is resolved engine-side). Subscribe to
   * `session.events` `'skills.changed'` for updates.
   */
  list(): Promise<readonly SkillSummary[]>;
}

/**
 * Derived session lifecycle phase. The engine retired its `sessionActivity`
 * service (#1751) — busy is now derived from agent activity views — so the
 * facade composes the phase from the pending interaction lists and each
 * agent's `agentActivityView`, keeping the retired service's precedence.
 */
export type SessionStatus = 'running' | 'idle' | 'awaiting_approval' | 'awaiting_question';

export type { SessionWarning };

/**
 * One configured MCP server as the workspace handler's shared connection
 * manager reports it (`McpServerEntry` — field-identical with the v1
 * `McpServerInfo` wire shape).
 */
export type McpServerInfo = Awaited<ReturnType<IAgentMcpService['list']>>[number];

/** v1's `McpStartupMetrics` — the initial-connect wall-clock duration. */
export interface McpStartupMetrics {
  readonly durationMs: number;
}

/** What `IWorkspaceDirs.addDir` leaves on the wire. */
export type AddAdditionalDirResult = Awaited<ReturnType<IWorkspaceDirs['addDir']>>;

/** One cron task as `ISessionCronService.list` reports it. */
export type CronTask = Awaited<ReturnType<ISessionCronService['list']>>[number];

/** v1's `CronTaskSnapshot` — the task plus its post-jitter next fire time. */
export type CronTaskSnapshot = CronTask & { readonly nextFireAt: number | null };

export interface SessionFacade {
  get(): Promise<SessionMeta>;
  setTitle(title: string): Promise<void>;
  update(patch: SessionMetaPatch): Promise<void>;
  setArchived(archived: boolean): Promise<void>;
  status(): Promise<SessionStatus>;
  close(): Promise<void>;
  archive(): Promise<void>;
  /** Re-materialize a closed session; `false` when it no longer exists. */
  restore(opts?: SessionRestoreOptions): Promise<boolean>;
  /** Permanently delete the session and its persisted data; throws when missing. */
  delete(): Promise<void>;
  /**
   * Materialize a session (live → existing handle, closed → cold resume);
   * `false` when it no longer exists. Unlike `restore`, the archived flag is
   * left untouched (mirrors the v1 SDK `resumeSession`).
   */
  resume(options?: SessionRestoreOptions): Promise<boolean>;
  /** Whether the session is currently materialized (live) under its workspace handler. */
  isLive(): Promise<boolean>;
  fork(input?: {
    newSessionId?: string;
    title?: string;
    metadata?: Record<string, unknown>;
  }): Promise<SessionMeta>;
  createChild(input?: {
    title?: string;
    metadata?: Record<string, unknown>;
  }): Promise<SessionMeta>;
  /**
   * Fork the main agent into a side-question ("btw") child; resolves with the
   * child's agent id (mirrors the v1 SDK `Session.startBtw`).
   */
  startBtw(): Promise<string>;
  /**
   * Session-level notices in the v1 wire shape, composed from the profile's
   * cached AGENTS.md warning (main agent) and the secondary-model warning —
   * the same two sources kap-server's `GET /sessions/{id}/warnings` folds.
   */
  getSessionWarnings(): Promise<readonly SessionWarning[]>;
  /**
   * Configured MCP servers of the session's workspace handler (mirrors the v1
   * SDK `Session.listMcpServers`). The agent scope is only the access path —
   * the connection set is shared by the whole workspace.
   */
  listMcpServers(): Promise<readonly McpServerInfo[]>;
  /** Initial MCP connect wall-clock duration (v1 `getMcpStartupMetrics`). */
  getMcpStartupMetrics(): Promise<McpStartupMetrics>;
  /**
   * Add an additional working directory through the session's workspace
   * handler (`IWorkspaceDirs`, workspace scope — resolved like close/archive).
   * `persist` defaults to the engine default (`true` → `.kimi-code/local.toml`).
   */
  addAdditionalDir(path: string, options?: { persist?: boolean }): Promise<AddAdditionalDirResult>;
  /**
   * Cron tasks of this session with their post-jitter next fire times
   * (mirrors the v1 SDK `Session.getCronTasks`). The schedule expression is
   * returned raw — display formatting stays client-side.
   */
  getCronTasks(): Promise<{ readonly tasks: readonly CronTaskSnapshot[] }>;
  /**
   * Reload the global config, validate the persisted secondary-model recipe,
   * and refresh the session's secondary-model warning (mirrors the v1 SDK
   * `Session.applyPersistedSecondaryModel`). Throws when no secondary model
   * is persisted or its recipe is unknown.
   */
  applyPersistedSecondaryModel(): Promise<void>;
  /** Re-run the secondary-model warning check against the live config. */
  recheckSecondaryModelWarning(): Promise<void>;
  /** Merged skill view of the session (builtin + user + project + plugin). */
  listSkills(): Promise<readonly SkillSummary[]>;
  /** The session's path layout and workspace view (live sessions only). */
  context(): Promise<{
    cwd: string;
    sessionDir: string;
    additionalDirs: readonly string[];
  }>;
  /** Run the `/init` AGENTS.md generator (session scope; main agent must exist). */
  generateAgentsMd(): Promise<void>;
  /** Materialize (create-or-get, cold-restoring the persisted wire) an agent. */
  materializeAgent(agentId: string): Promise<void>;
  /** Ids of the session's live agents. */
  listLiveAgents(): Promise<readonly string[]>;
  /**
   * Reconnect one MCP server of the session's workspace handler (mirrors the
   * v1 SDK `Session.reconnectMcpServer`). Raises the engine's
   * `mcp.server_not_found` / `mcp.server_disabled` for a bad name.
   */
  reconnectMcpServer(name: string): Promise<void>;
  readonly approvals: SessionApprovalsFacade;
  readonly questions: SessionQuestionsFacade;
  readonly interactions: SessionInteractionsFacade;
  readonly skills: SessionSkillsFacade;
  /** Agent id → metadata for every agent registered in this session. */
  agents(): Promise<Readonly<Record<string, AgentMeta>>>;
}

export function createSessionFacade(call: ScopedCaller, sessionId: string): SessionFacade {
  const scope: ScopeRef = { sessionId };
  const read = (): Promise<SessionMeta> =>
    call(scope, 'sessionMetadata', 'read', []) as Promise<SessionMeta>;
  // Session lifecycle methods live on the session's workspace handler
  // (Workspace scope) — the index supplies the handler's workspaceId.
  const resolveWorkspaceId = async (): Promise<string | undefined> => {
    const summary = (await call({}, 'sessionIndex', 'get', [sessionId])) as
      | { workspaceId: string }
      | undefined;
    return summary?.workspaceId;
  };
  const spawn = async (
    method: 'fork' | 'createChild',
    input: { newSessionId?: string; title?: string; metadata?: Record<string, unknown> } = {},
  ): Promise<SessionMeta> => {
    const workspaceId = await resolveWorkspaceId();
    if (workspaceId === undefined) {
      throw new RPCError(NOT_FOUND, `session not found: ${sessionId}`);
    }
    const handle = (await call({ workspaceId }, 'sessionLifecycleService', method, [
      {
        sourceSessionId: sessionId,
        newSessionId: input.newSessionId,
        title: input.title,
        metadata: input.metadata,
      },
    ])) as HandleWire;
    return call({ sessionId: handle.id }, 'sessionMetadata', 'read', []) as Promise<SessionMeta>;
  };

  return {
    get: read,
    setTitle: (title) => call(scope, 'sessionMetadata', 'setTitle', [title]) as Promise<void>,
    update: (patch) => call(scope, 'sessionMetadata', 'update', [patch]) as Promise<void>,
    setArchived: (archived) =>
      call(scope, 'sessionMetadata', 'setArchived', [archived]) as Promise<void>,
    status: async () => {
      const pending = (kind: 'approval' | 'question') =>
        call(scope, 'sessionInteractionService', 'listPending', [kind]) as Promise<
          readonly unknown[]
        >;
      if ((await pending('approval')).length > 0) return 'awaiting_approval';
      if ((await pending('question')).length > 0) return 'awaiting_question';
      const meta = await read();
      for (const agentId of Object.keys(meta.agents ?? {})) {
        try {
          const state = (await call(
            { sessionId, agentId },
            'agentActivityView',
            'state',
            [],
          )) as AgentActivityState;
          if (state.turn !== undefined || state.background.length > 0) return 'running';
        } catch {
          // Agents stay registered after their live handle is gone; the scope
          // probe fails for a dead agent, so treat it as not active — the same
          // view the retired service had from iterating live handles only.
        }
      }
      return 'idle';
    },
    close: async () => {
      const workspaceId = await resolveWorkspaceId();
      if (workspaceId === undefined) return;
      await call({ workspaceId }, 'sessionLifecycleService', 'close', [sessionId]);
    },
    archive: async () => {
      const workspaceId = await resolveWorkspaceId();
      if (workspaceId === undefined) return;
      await call({ workspaceId }, 'sessionLifecycleService', 'archive', [sessionId]);
    },
    restore: async (opts) => {
      const workspaceId = await resolveWorkspaceId();
      if (workspaceId === undefined) return false;
      const handle = (await call({ workspaceId }, 'sessionLifecycleService', 'restore', [
        sessionId,
        opts,
      ])) as HandleWire | null | undefined;
      // The engine reports "not found" with `undefined`, which JSON transports
      // may surface as `null` — reject both.
      return handle !== null && handle !== undefined;
    },
    delete: async () => {
      const workspaceId = await resolveWorkspaceId();
      if (workspaceId === undefined) {
        throw new RPCError(NOT_FOUND, `session not found: ${sessionId}`);
      }
      await call({ workspaceId }, 'sessionLifecycleService', 'delete', [sessionId]);
    },
    resume: async (options) => {
      const workspaceId = await resolveWorkspaceId();
      if (workspaceId === undefined) return false;
      const handle = (await call({ workspaceId }, 'sessionLifecycleService', 'resume', [
        sessionId,
        options,
      ])) as HandleWire | null | undefined;
      return handle !== null && handle !== undefined;
    },
    isLive: async () => {
      const workspaceId = await resolveWorkspaceId();
      if (workspaceId === undefined) return false;
      const handle = (await call({ workspaceId }, 'sessionLifecycleService', 'get', [
        sessionId,
      ])) as HandleWire | null | undefined;
      return handle !== null && handle !== undefined;
    },
    fork: (input) => spawn('fork', input),
    createChild: (input) => spawn('createChild', input),

    startBtw: async () => {
      // `fork('main')` throws on a missing source, and `create` (unlike
      // `resume`) does not eagerly materialize the main agent — force
      // materialization through a main-agent-scope call first, mirroring the
      // SDK's `materializeMainAgent` before `ISessionBtwService.start`. The
      // trigger is `data` (not `getModel`): it also succeeds on an unbound
      // (model-less) agent.
      await call({ sessionId, agentId: 'main' }, 'agentProfileService', 'data', []);
      return call(scope, 'sessionBtwService', 'start', []) as Promise<string>;
    },
    getSessionWarnings: async () => {
      // `agentId: 'main'` scope resolution materializes the main agent — the
      // same `ensureMainAgent` the server's warnings route performs.
      const [agentsMdWarning, secondary] = await Promise.all([
        call({ sessionId, agentId: 'main' }, 'agentProfileService', 'getAgentsMdWarning', []) as
          Promise<string | undefined>,
        call(scope, 'sessionSecondaryModelWarningService', 'getSecondaryModelWarning', []) as
          Promise<SecondaryModelWarning | undefined>,
      ]);
      const warnings: SessionWarning[] = [];
      if (agentsMdWarning !== undefined) {
        warnings.push({ code: 'agents-md-oversized', message: agentsMdWarning, severity: 'warning' });
      }
      if (secondary !== undefined) {
        warnings.push({ code: secondary.code, message: secondary.message, severity: 'warning' });
      }
      return warnings;
    },
    listMcpServers: () =>
      call({ sessionId, agentId: 'main' }, 'agentMcpService', 'list', []) as Promise<
        readonly McpServerInfo[]
      >,
    getMcpStartupMetrics: async () => {
      const mcpScope: ScopeRef = { sessionId, agentId: 'main' };
      await call(mcpScope, 'agentMcpService', 'waitForInitialLoad', []);
      const durationMs = (await call(mcpScope, 'agentMcpService', 'initialLoadDurationMs', [])) as
        number;
      return { durationMs };
    },
    addAdditionalDir: async (path, options) => {
      const workspaceId = await resolveWorkspaceId();
      if (workspaceId === undefined) {
        throw new RPCError(NOT_FOUND, `session not found: ${sessionId}`);
      }
      return call({ workspaceId }, 'workspaceDirs', 'addDir', [
        { path, persist: options?.persist },
      ]) as Promise<AddAdditionalDirResult>;
    },
    getCronTasks: async () => {
      const tasks = (await call(scope, 'sessionCronService', 'list', [])) as readonly CronTask[];
      const snapshots = await Promise.all(
        tasks.map(async (task) => ({
          ...task,
          nextFireAt: (await call(scope, 'sessionCronService', 'getNextFireForTask', [
            task.id,
          ])) as number | null,
        })),
      );
      return { tasks: snapshots };
    },
    applyPersistedSecondaryModel: async () => {
      await call({}, 'configService', 'reload', []);
      const secondary = (await call({}, 'configService', 'get', [SECONDARY_MODEL_SECTION])) as
        | { model?: string }
        | undefined;
      if (secondary?.model === undefined) {
        throw new RPCError(
          REQUEST_INVALID,
          'Cannot apply the secondary model: persist its recipe before applying it to a session.',
        );
      }
      // Recipe-level validation; deeper resolution problems surface through
      // the rechecked warning below (readable via getSessionWarnings).
      const recipe = (await call({}, 'modelService', 'get', [secondary.model])) as
        | Record<string, unknown>
        | null
        | undefined;
      if (recipe === undefined || recipe === null) {
        throw new RPCError(NOT_FOUND, `secondary model not configured: ${secondary.model}`);
      }
      await call(scope, 'sessionSecondaryModelWarningService', 'recheckSecondaryModelWarning', []);
    },
    recheckSecondaryModelWarning: async () => {
      await call(scope, 'sessionSecondaryModelWarningService', 'recheckSecondaryModelWarning', []);
    },
    listSkills: () =>
      call(scope, 'sessionSkillCatalog', 'list', []) as Promise<readonly SkillSummary[]>,
    context: async () => {
      const [cwd, sessionDir, additionalDirs] = await Promise.all([
        call(scope, 'sessionContext', 'cwd', []) as Promise<string>,
        call(scope, 'sessionContext', 'sessionDir', []) as Promise<string>,
        call(scope, 'sessionWorkspaceContext', 'additionalDirs', []) as Promise<readonly string[]>,
      ]);
      return { cwd, sessionDir, additionalDirs };
    },
    generateAgentsMd: () =>
      call(scope, 'sessionInitService', 'generateAgentsMd', []) as Promise<void>,
    materializeAgent: async (agentId) => {
      await call(scope, 'agentLifecycleService', 'create', [{ agentId }]);
    },
    listLiveAgents: async () => {
      const handles = (await call(scope, 'agentLifecycleService', 'list', [])) as readonly {
        id: string;
      }[];
      return handles.map((handle) => handle.id);
    },
    reconnectMcpServer: async (name) => {
      await call({ sessionId, agentId: 'main' }, 'agentMcpService', 'reconnect', [name]);
    },

    approvals: {
      list: () =>
        call(scope, 'sessionApprovalService', 'listPending', []) as Promise<
          readonly ApprovalRequest[]
        >,
      decide: (id, response) =>
        call(scope, 'sessionApprovalService', 'decide', [id, response]) as Promise<void>,
    },

    questions: {
      list: () =>
        call(scope, 'sessionQuestionService', 'listPending', []) as Promise<
          readonly QuestionRequest[]
        >,
      answer: (id, result) =>
        call(scope, 'sessionQuestionService', 'answer', [id, result]) as Promise<void>,
      dismiss: (id) => call(scope, 'sessionQuestionService', 'dismiss', [id]) as Promise<void>,
    },

    interactions: {
      list: (kind) =>
        call(scope, 'sessionInteractionService', 'listPending', [kind]) as Promise<
          readonly Interaction[]
        >,
      respond: (id, response) =>
        call(scope, 'sessionInteractionService', 'respond', [id, response]) as Promise<void>,
    },

    skills: {
      list: () =>
        call(scope, 'sessionSkillCatalog', 'list', []) as Promise<readonly SkillSummary[]>,
    },

    agents: async () => {
      const meta = await read();
      return meta.agents ?? {};
    },
  };
}
