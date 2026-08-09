/**
 * `mcp` domain — `IAgentMcpService` implementation.
 *
 * Mirrors TWO connection managers' server sets into the agent's tool
 * registry: the workspace-level shared manager (arriving through the seeded
 * `ISessionMcpHandle` — one manager per workspace handler, shared by every
 * session and agent) and the session-level per-session manager (the
 * `sessionMcp` domain's `ISessionMcpService`, holding the servers that
 * declared `scope: 'session'`; the two sets are name-disjoint by
 * configuration). Registers qualified tools for connected servers, keeps
 * them registered across reconnects, keeps them registered (with calls
 * short-circuited to a removal notice) when the server is tombstoned as
 * `removed`, swaps in the OAuth tool for
 * `needs-auth` servers, journals tool discoveries on the wire (queued until
 * restore finishes), and publishes `mcp.server.status` / `tool.list.updated`
 * events. Reads (`list` / `resolved` / `getRemoteServerUrl`) merge both
 * managers; `reconnect` routes to the manager that owns the server. From
 * the shared manager only the session's baseline servers take part
 * (`ISessionMcpHandle.isBaselineServer`, checked on every replayed and
 * live status change): a server that appears mid-session — a plugin
 * install or a config edit — is ignored here, so its tools, status events,
 * and discoveries never reach a live agent; it joins on the next session
 * materialization (`/new`, `/reload`, resume), while a tombstoned baseline
 * server reconnecting under the same name (a re-enabled plugin) registers
 * again. The session manager needs no such gate: its servers are
 * per-session by construction. Sessions and agents construct without
 * awaiting the managers' initial connect; each LLM step instead waits for
 * it through a `loop` onWillBeginStep hook (a no-op once settled), with the
 * per-execution `toolExecutor` onWillExecuteTool wait as the backstop. The
 * plain-data state (`mcpToolsByServer`, `discoveryWritesReady`) is
 * registered into `agentState` (`IAgentStateService`) and read/written
 * through it; `mcpTools` stays a plain instance field (its values hold
 * disposable resource handles, not plain data), as does `pendingDiscoveries`
 * (a closure queue of deferred discovery writes). Bound at Agent scope.
 */

import { createHash } from 'node:crypto';
import { LifecycleScope } from '#/app/scopes';
import { ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { defineState } from '#/_base/state/stateRegistry';
import type { Tool as KosongTool } from '#/kosong/contract/tool';

import { type IDisposable } from "#/_base/di/lifecycle";
import { Service } from "#/_base/di/service";
import type { KimiErrorPayload } from '#/_base/errors/serialize';
import { ErrorCodes, makeErrorPayload } from "#/errors";
import { abortable } from '#/_base/utils/abort';
import { IAgentStateService } from '#/agent/state/agentState';
import { IEventBus } from '#/app/event/eventBus';
import { ITelemetryService } from '#/app/telemetry/telemetry';
import { sessionMediaOriginalsDir } from '#/agent/media/image-originals';
import { IAgentToolExecutorService } from '#/agent/toolExecutor/toolExecutor';
import { IAgentToolRegistryService } from '#/agent/toolRegistry/toolRegistry';
import { IAgentLoopService } from '#/agent/loop/loop';
import { createMcpAuthTool } from '#/agent/mcp/tools/auth';
import { createMcpTool } from '#/agent/mcp/tools/mcp';
import { ISessionContext } from '#/session/sessionContext/sessionContext';
import { ISessionMcpHandle } from '#/session/mcp/sessionMcpHandle';
import { ISessionMcpService } from '#/session/sessionMcp/sessionMcp';
import type { McpConnectionView, McpServerEntry } from '#/mcpCore/connection-manager';
import { IAgentMcpService } from './mcp';
import { qualifyMcpToolName } from '#/mcpCore/tool-naming';
import type { MCPClient, MCPToolDefinition } from '#/mcpCore/types';
import { IWireService } from '#/wire/wire';
import {
  McpDiscoveryModel,
  mcpToolsDiscovered,
  type McpToolCollision,
} from './mcpDiscoveryOps';

export interface ErrorEvent extends KimiErrorPayload {
  readonly type: 'error';
}

export interface McpServerStatusPayload {
  readonly name: string;
  readonly transport: 'stdio' | 'http' | 'sse';
  readonly status: 'pending' | 'connected' | 'failed' | 'disabled' | 'needs-auth' | 'removed';
  readonly toolCount: number;
  readonly error?: string;
}

export interface McpServerStatusEvent {
  readonly type: 'mcp.server.status';
  readonly server: McpServerStatusPayload;
}

export type ToolListUpdatedReason = 'mcp.connected' | 'mcp.disconnected' | 'mcp.failed';

export interface ToolListUpdatedEvent {
  readonly type: 'tool.list.updated';
  readonly reason: ToolListUpdatedReason;
  readonly serverName: string;
}

declare module '#/app/event/eventBus' {
  interface DomainEventMap {
    'mcp.server.status': McpServerStatusEvent;
    'tool.list.updated': ToolListUpdatedEvent;
    error: ErrorEvent;
  }
}

interface McpToolRegistration {
  readonly disposable: IDisposable;
  readonly serverName: string;
}

export const mcpMcpToolsByServerKey = defineState<Map<string, string[]>>(
  'mcp.mcpToolsByServer',
  () => new Map(),
);
export const mcpDiscoveryWritesReadyKey = defineState<boolean>(
  'mcp.discoveryWritesReady',
  () => false,
);

export class AgentMcpService extends Service implements IAgentMcpService {
  declare readonly _serviceBrand: undefined;
  private readonly mcpTools = new Map<string, McpToolRegistration>();
  private readonly pendingDiscoveries: Array<() => void> = [];

  constructor(
    @ISessionMcpHandle private readonly mcpHandle: ISessionMcpHandle,
    @ISessionMcpService private readonly sessionMcp: ISessionMcpService,
    @ISessionContext private readonly sessionContext: ISessionContext,
    @IAgentToolRegistryService private readonly registry: IAgentToolRegistryService,
    @IEventBus private readonly eventBus: IEventBus,
    @IAgentToolExecutorService toolExecutor: IAgentToolExecutorService,
    @IAgentLoopService loop: IAgentLoopService,
    @IWireService private readonly wire: IWireService,
    @ITelemetryService private readonly telemetry: ITelemetryService,
    @IAgentStateService private readonly states: IAgentStateService,
  ) {
    super();
    this.states.register(mcpMcpToolsByServerKey);
    this.states.register(mcpDiscoveryWritesReadyKey);
    this.attachMcpTools();
    loop.hooks.onWillBeginStep.register('mcp', async (ctx, next) => {
      await this.waitForInitialLoad(ctx.signal);
      await next();
    });
    this._register(
      toolExecutor.onWillExecuteTool((event) => {
        event.waitUntil(this.waitForInitialLoad(event.signal));
      }),
    );
    this._register(
      this.wire.hooks.onDidRestore.register('mcp', async (_ctx, next) => {
        this.flushPendingDiscoveries();
        await next();
      }),
    );
  }

  private get mcpToolsByServer(): Map<string, string[]> {
    return this.states.get(mcpMcpToolsByServerKey);
  }

  private get discoveryWritesReady(): boolean {
    return this.states.get(mcpDiscoveryWritesReadyKey);
  }

  private set discoveryWritesReady(value: boolean) {
    this.states.set(mcpDiscoveryWritesReadyKey, value);
  }

  get oauthService() {
    return this.mcpHandle.connectionManager.oauthService;
  }

  private get workspaceManager(): McpConnectionView {
    return this.mcpHandle.connectionManager;
  }

  private get sessionManager(): McpConnectionView {
    return this.sessionMcp.connectionManager;
  }

  private managers(): readonly McpConnectionView[] {
    return [this.workspaceManager, this.sessionManager];
  }

  private owningManager(name: string): McpConnectionView {
    return this.sessionManager.get(name) !== undefined
      ? this.sessionManager
      : this.workspaceManager;
  }

  waitForInitialLoad(signal?: AbortSignal): Promise<void> {
    // The session manager's connectAll is only issued once the seeded server
    // set resolves, so its own readiness promise covers both phases.
    const ready = Promise.all([this.mcpHandle.ready, this.sessionMcp.ready]).then(() => undefined);
    return signal === undefined ? ready : abortable(ready, signal);
  }

  initialLoadDurationMs(): number {
    return Math.max(...this.managers().map((manager) => manager.initialLoadDurationMs()));
  }

  list() {
    return [...this.workspaceManager.list(), ...this.sessionManager.list()];
  }

  resolved(name: string) {
    return this.workspaceManager.resolved(name) ?? this.sessionManager.resolved(name);
  }

  getRemoteServerUrl(name: string) {
    return (
      this.workspaceManager.getRemoteServerUrl(name) ??
      this.sessionManager.getRemoteServerUrl(name)
    );
  }

  async reconnect(name: string, signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    await this.owningManager(name).reconnect(name);
    signal?.throwIfAborted();
  }

  private reconnectForToolCall(
    serverName: string,
    staleClient: MCPClient,
    signal?: AbortSignal,
  ): Promise<MCPClient | undefined> {
    const work = this.joinHealedOrReconnect(serverName, staleClient);
    return signal === undefined ? work : abortable(work, signal);
  }

  private async joinHealedOrReconnect(
    serverName: string,
    staleClient: MCPClient,
  ): Promise<MCPClient | undefined> {
    const healed = this.resolved(serverName)?.client;
    if (healed !== undefined && healed !== staleClient) return healed;
    await this.owningManager(serverName).reconnectAndJoin(serverName);
    const current = this.resolved(serverName)?.client;
    return current !== undefined && current !== staleClient ? current : undefined;
  }

  onStatusChange(listener: Parameters<IAgentMcpService['onStatusChange']>[0]) {
    const unsubscribes = this.managers().map((manager) => manager.onStatusChange(listener));
    return {
      dispose: () => {
        for (const unsubscribe of unsubscribes) unsubscribe();
      },
    };
  }

  private attachMcpTools(): void {
    for (const entry of this.list()) {
      this.handleMcpServerStatusChange(entry);
    }
    this._register(
      this.onStatusChange((entry) => {
        this.handleMcpServerStatusChange(entry);
      }),
    );
  }

  /**
   * Session-owned servers (`scope: 'session'`) are part of the session by
   * construction; shared-manager servers go through the handle's baseline so
   * one that appears mid-session never reaches a live agent.
   */
  private isSessionServer(name: string): boolean {
    return this.sessionManager.get(name) !== undefined || this.mcpHandle.isBaselineServer(name);
  }

  private handleMcpServerStatusChange(entry: McpServerEntry): void {
    if (!this.isSessionServer(entry.name)) return;
    this.eventBus.publish({
      type: 'mcp.server.status',
      server: {
        name: entry.name,
        transport: entry.transport,
        status: entry.status,
        toolCount: entry.toolCount,
        error: entry.error,
      },
    });
    if (entry.status === 'connected') {
      this.registerConnectedMcpServer(entry);
      return;
    }
    if (entry.status === 'needs-auth') {
      this.registerNeedsAuthMcpServer(entry);
      return;
    }
    if (entry.status === 'failed' || entry.status === 'pending' || entry.status === 'removed') {
      return;
    }
    if (entry.status === 'disabled') {
      const removed = this.unregisterMcpServer(entry.name);
      if (removed) {
        this.eventBus.publish({
          type: 'tool.list.updated',
          reason: 'mcp.disconnected',
          serverName: entry.name,
        });
      }
    }
  }

  private registerConnectedMcpServer(entry: McpServerEntry): void {
    const resolved = this.resolved(entry.name);
    if (resolved === undefined) return;
    const result = this.registerMcpServer(
      entry.name,
      resolved.client,
      resolved.tools,
      resolved.enabledNames,
    );
    this.emitMcpToolCollisions(entry.name, result.collisions);
    this.recordDiscovery(entry.name, resolved.rawTools, resolved.enabledNames, result.collisions);
    this.eventBus.publish({
      type: 'tool.list.updated',
      reason: 'mcp.connected',
      serverName: entry.name,
    });
  }

  private registerNeedsAuthMcpServer(entry: McpServerEntry): void {
    this.unregisterMcpServer(entry.name);
    const oauthService = this.oauthService;
    const serverUrl = this.getRemoteServerUrl(entry.name);
    if (oauthService === undefined || serverUrl === undefined) return;
    const tool = createMcpAuthTool({
      serverName: entry.name,
      serverUrl,
      oauthService,
      reconnect: (signal) => this.reconnect(entry.name, signal),
    });
    const disposable = this._register(this.registry.register(tool, { source: 'mcp' }));
    this.mcpTools.set(tool.name, { disposable, serverName: entry.name });
    this.mcpToolsByServer.set(entry.name, [tool.name]);
    this.eventBus.publish({
      type: 'tool.list.updated',
      reason: 'mcp.connected',
      serverName: entry.name,
    });
  }

  private registerMcpServer(
    serverName: string,
    client: MCPClient,
    tools: readonly KosongTool[],
    enabledTools: ReadonlySet<string>,
  ): {
    readonly registered: readonly string[];
    readonly collisions: readonly McpToolCollision[];
  } {
    this.unregisterMcpServer(serverName);
    const qualifiedNames: string[] = [];
    const collisions: McpToolCollision[] = [];
    const seenInThisCall = new Map<string, string>();
    for (const tool of tools) {
      if (!enabledTools.has(tool.name)) continue;
      const qualified = qualifyMcpToolName(serverName, tool.name);
      const firstInThisCall = seenInThisCall.get(qualified);
      if (firstInThisCall !== undefined) {
        collisions.push({
          qualified,
          toolName: tool.name,
          collidesWith: { kind: 'same_server', toolName: firstInThisCall },
        });
        continue;
      }
      const existingEntry = this.mcpTools.get(qualified);
      if (existingEntry !== undefined) {
        collisions.push({
          qualified,
          toolName: tool.name,
          collidesWith: { kind: 'other_server', serverName: existingEntry.serverName },
        });
        continue;
      }
      seenInThisCall.set(qualified, tool.name);
      const disposable = this._register(
        this.registry.register(
          createMcpTool(qualified, tool, client, {
            originalsDir: sessionMediaOriginalsDir(this.sessionContext.sessionDir),
            telemetry: this.telemetry,
            reconnect: (signal) => this.reconnectForToolCall(serverName, client, signal),
            isRemoved: () => this.owningManager(serverName).get(serverName)?.status === 'removed',
          }),
          { source: 'mcp' },
        ),
      );
      this.mcpTools.set(qualified, { disposable, serverName });
      qualifiedNames.push(qualified);
    }
    this.mcpToolsByServer.set(serverName, qualifiedNames);
    return { registered: qualifiedNames, collisions };
  }

  private unregisterMcpServer(serverName: string): boolean {
    const names = this.mcpToolsByServer.get(serverName);
    if (names === undefined) return false;
    for (const name of names) {
      const entry = this.mcpTools.get(name);
      entry?.disposable.dispose();
      this.mcpTools.delete(name);
    }
    this.mcpToolsByServer.delete(serverName);
    return true;
  }

  private recordDiscovery(
    serverName: string,
    rawTools: readonly MCPToolDefinition[],
    enabledNames: ReadonlySet<string>,
    collisions: readonly McpToolCollision[],
  ): void {
    const enabledNamesSnapshot = [...enabledNames].toSorted((a, b) => a.localeCompare(b));
    const work = (): void => {
      const hash = createHash('sha256')
        .update(JSON.stringify({ tools: rawTools, enabledNames: enabledNamesSnapshot, collisions }))
        .digest('hex');
      const key = `${serverName}\n${hash}`;
      if (this.wire.getModel(McpDiscoveryModel).seen.includes(key)) return;
      this.wire.dispatch(
        mcpToolsDiscovered({
          serverName,
          hash,
          tools: rawTools,
          enabledNames: enabledNamesSnapshot,
          collisions: collisions.length > 0 ? collisions : undefined,
        }),
      );
    };
    if (!this.discoveryWritesReady) {
      this.pendingDiscoveries.push(work);
      return;
    }
    work();
  }

  private flushPendingDiscoveries(): void {
    this.discoveryWritesReady = true;
    const pending = this.pendingDiscoveries.splice(0);
    for (const work of pending) {
      work();
    }
  }

  private emitMcpToolCollisions(
    serverName: string,
    collisions: readonly McpToolCollision[],
  ): void {
    if (collisions.length === 0) return;
    const summary = collisions
      .map((collision) =>
        collision.collidesWith.kind === 'same_server'
          ? `"${collision.toolName}" -> ${collision.qualified} (collides with "${collision.collidesWith.toolName}" from the same server)`
          : `"${collision.toolName}" -> ${collision.qualified} (collides with server "${collision.collidesWith.serverName}")`,
      )
      .join('; ');
    this.eventBus.publish({
      type: 'error',
      ...makeErrorPayload(
        ErrorCodes.MCP_TOOL_NAME_COLLISION,
        `MCP server "${serverName}" registered ${collisions.length} tool name` +
          `${collisions.length === 1 ? '' : 's'} ` +
          `that collide with existing qualified names; the losing tools were dropped: ${summary}`,
        { details: { serverName, collisions: collisions as readonly unknown[] } },
      ),
    });
  }
}

registerScopedService(
  LifecycleScope.Agent,
  IAgentMcpService,
  AgentMcpService,
  ScopeActivation.OnScopeCreated,
  'mcp',
);
