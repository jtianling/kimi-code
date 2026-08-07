/**
 * `workspaceMcp` domain — `IWorkspaceMcpService` implementation.
 *
 * Owns the handler-wide `McpConnectionManager` (built at construction,
 * shared by every session of the workspace). This service drives the
 * initial connect from the config domain's snapshot — filtered to servers
 * with the default `scope: 'workspace'`; `scope: 'session'` entries never
 * touch the shared manager and are re-projected through
 * `sessionServersData()` for the `sessionMcp` domain — applies its
 * reconciled change events incrementally (serialized on a mutation tail,
 * always after the initial connect settles; an upsert whose scope flipped
 * to `'session'` is dropped from the shared manager), feeds the manager's
 * global timeout defaults from the config domain's tunables at each
 * (re)connect, and reports connection telemetry for the initial load.
 * An outright initial-load or change-apply failure is logged (per-server
 * failures are status entries). The manager (and its stdio child processes,
 * whose cwd is the handler root) lives as long as the handler — i.e. the
 * process — so a stateful stdio server is shared by concurrent sessions of
 * the workspace rather than owned by one session. Bound at Workspace scope.
 */

import { Disposable } from '#/_base/di/lifecycle';
import { LifecycleScope, ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { Emitter } from '#/_base/event';
import { ILogService } from '#/_base/log/log';

import { McpConnectionManager } from '#/mcpCore/connection-manager';
import type { McpServerConfig } from '#/mcpCore/config-schema';
import { McpOAuthService } from '#/mcpCore/oauth/service';
import { IMcpOAuthStore } from '#/app/mcpConfig/oauthStore';
import { ITelemetryService } from '#/app/telemetry/telemetry';
import type { ISessionMcpHandle } from '#/session/mcp/sessionMcpHandle';
import type { ISessionMcpServers } from '#/session/sessionMcp/sessionMcpServers';
import { IWorkspaceContext } from '#/workspace/workspaceContext/workspaceContext';
import {
  IWorkspaceMcpConfigService,
  type McpServersChange,
} from '#/workspace/workspaceMcpConfig/workspaceMcpConfig';

import { IWorkspaceMcpService } from './workspaceMcp';

export class WorkspaceMcpService extends Disposable implements IWorkspaceMcpService {
  declare readonly _serviceBrand: undefined;

  private readonly manager: McpConnectionManager;
  readonly ready: Promise<void>;
  private mutationTail: Promise<void> = Promise.resolve();
  private readonly sessionServersEmitter = this._register(new Emitter<McpServersChange>());

  constructor(
    @IWorkspaceContext workspace: IWorkspaceContext,
    @IWorkspaceMcpConfigService private readonly mcpConfig: IWorkspaceMcpConfigService,
    @IMcpOAuthStore oauthStore: IMcpOAuthStore,
    @ILogService private readonly log: ILogService,
    @ITelemetryService private readonly telemetry: ITelemetryService,
  ) {
    super();
    const oauthService = new McpOAuthService({ store: oauthStore });
    this.manager = new McpConnectionManager({
      log: this.log,
      oauthService,
      stdioCwd: workspace.cwd,
      resolveDefaultTimeouts: () => this.mcpConfig.tunables(),
    });
    this._register({ dispose: () => void this.manager.shutdown() });
    this._register(
      this.mcpConfig.onDidChange((change) => {
        this.scheduleApply(change);
        const sessionChange = toSessionServersChange(change);
        if (Object.keys(sessionChange.upsert).length > 0 || sessionChange.remove.length > 0) {
          this.sessionServersEmitter.fire(sessionChange);
        }
      }),
    );
    this.ready = this.initialize().catch((error: unknown) => {
      this.log.error('mcp initial load failed', { error });
    });
  }

  connectionManager(): McpConnectionManager {
    return this.manager;
  }

  sessionHandle(): ISessionMcpHandle {
    return {
      _serviceBrand: undefined,
      ready: this.ready,
      connectionManager: this.manager,
    };
  }

  sessionServersData(): ISessionMcpServers {
    return {
      _serviceBrand: undefined,
      ready: this.mcpConfig.ready,
      servers: () => sessionScopedServers(this.mcpConfig.servers()),
      tunables: () => this.mcpConfig.tunables(),
      onDidChange: this.sessionServersEmitter.event,
    };
  }

  private mutate(work: () => Promise<void>): Promise<void> {
    const tail = this.mutationTail.catch(() => undefined).then(work);
    this.mutationTail = tail;
    return tail;
  }

  private async initialize(): Promise<void> {
    await this.mcpConfig.ready;
    const servers = workspaceScopedServers(this.mcpConfig.servers());
    if (Object.keys(servers).length === 0) return;
    await this.manager.connectAll(servers);
    this.trackMcpInitialLoad();
  }

  private scheduleApply(change: McpServersChange): void {
    void this.ready
      .then(() => this.mutate(() => this.apply(change)))
      .catch((error) => {
        this.log.warn(`mcp server change apply failed: ${String(error)}`);
      });
  }

  private async apply(change: McpServersChange): Promise<void> {
    for (const name of change.remove) {
      await this.manager.remove(name);
    }
    for (const [name, config] of Object.entries(change.upsert)) {
      if (config.scope === 'session') {
        // Flipped to per-session scope: the shared manager drops it and the
        // per-session managers pick it up through `sessionServersData()`.
        await this.manager.remove(name);
      } else {
        await this.manager.connect(name, config);
      }
    }
  }

  private trackMcpInitialLoad(): void {
    const entries = this.manager.list().filter((entry) => entry.status !== 'disabled');
    const totalCount = entries.length;
    if (totalCount === 0) return;

    const connectedCount = entries.filter((entry) => entry.status === 'connected').length;
    if (connectedCount > 0) {
      this.telemetry.track2('mcp_connected', {
        server_count: connectedCount,
        total_count: totalCount,
      });
    }

    const failedCount = entries.filter((entry) => entry.status === 'failed').length;
    if (failedCount > 0) {
      this.telemetry.track2('mcp_failed', {
        failed_count: failedCount,
        total_count: totalCount,
      });
    }
  }
}

registerScopedService(
  LifecycleScope.Workspace,
  IWorkspaceMcpService,
  WorkspaceMcpService,
  ScopeActivation.OnScopeCreated,
  'workspaceMcp',
);

function workspaceScopedServers(
  servers: Readonly<Record<string, McpServerConfig>>,
): Record<string, McpServerConfig> {
  return Object.fromEntries(
    Object.entries(servers).filter(([, config]) => config.scope !== 'session'),
  );
}

function sessionScopedServers(
  servers: Readonly<Record<string, McpServerConfig>>,
): Record<string, McpServerConfig> {
  return Object.fromEntries(
    Object.entries(servers).filter(([, config]) => config.scope === 'session'),
  );
}

function toSessionServersChange(change: McpServersChange): McpServersChange {
  const upsert: Record<string, McpServerConfig> = {};
  // Removals of workspace-scoped names reach session managers as harmless
  // no-ops; without a tracked set there is no way to tell them apart.
  const remove = [...change.remove];
  for (const [name, config] of Object.entries(change.upsert)) {
    if (config.scope === 'session') {
      upsert[name] = config;
    } else {
      // Scope flipped away from 'session': session managers must drop it.
      remove.push(name);
    }
  }
  return { upsert, remove };
}
