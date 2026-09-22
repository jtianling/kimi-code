import type { McpServerConfig } from '#/mcpCore/config-schema';

import { Disposable } from '#/_base/di/lifecycle';
import { ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { ILogService } from '#/_base/log/log';
import { LifecycleScope } from '#/app/scopes';

import { IAgentIdentity } from '#/app/agentIdentity/agentIdentity';
import { IMcpOAuthService } from '#/app/mcpConfig/oauthService';
import {
  McpConnectionManager,
  type McpServerEntry,
} from '#/mcpCore/connection-manager';
import { type McpOAuthEvent, type McpOAuthService } from '#/mcpCore/oauth/service';
import { canonicalMcpOAuthResource } from '#/mcpCore/oauth/store';
import { ISessionEphemeralMcpServers } from '#/session/mcp/ephemeralMcpServers';
import { sessionProcessEnv } from '#/session/process/sessionProcessEnv';
import { ISessionContext } from '#/session/sessionContext/sessionContext';
import { IRuntimeResolver } from '#/workspace/workspaceInstance/workspaceInstanceManager';
import type { McpServersChange } from '#/workspace/workspaceMcpConfig/workspaceMcpConfig';

import { ISessionMcpService } from './sessionMcp';
import { ISessionMcpServers } from './sessionMcpServers';

export class SessionMcpService extends Disposable implements ISessionMcpService {
  declare readonly _serviceBrand: undefined;

  readonly connectionManager: McpConnectionManager;
  readonly ready: Promise<void>;
  private mutationTail: Promise<void> = Promise.resolve();

  constructor(
    @ISessionContext sessionContext: ISessionContext,
    @ISessionMcpServers private readonly servers: ISessionMcpServers,
    @IMcpOAuthService private readonly oauthService: McpOAuthService,
    @IAgentIdentity private readonly identity: IAgentIdentity,
    @IRuntimeResolver runtimeResolver: IRuntimeResolver,
    @ISessionEphemeralMcpServers
    private readonly ephemeralServers: Readonly<Record<string, McpServerConfig>>,
    @ILogService private readonly log: ILogService,
  ) {
    super();
    const sessionEnv = sessionProcessEnv(sessionContext.sessionId);
    this.connectionManager = new McpConnectionManager({
      log: this.log,
      oauthService: this.oauthService,
      runtimeResolver,
      workspaceId: sessionContext.workspaceId,
      runtimeId: 'local',
      resolveClientName: () => this.identity.current().slug,
      stdioCwd: sessionContext.cwd,
      envLookup: (name) => sessionEnv[name] ?? process.env[name],
      resolveDefaultTimeouts: () => this.servers.tunables(),
    });
    this._register({ dispose: () => void this.connectionManager.shutdown() });
    this._register(
      this.servers.onDidChange((change) => {
        this.scheduleApply(change);
      }),
    );
    this._register({
      dispose: this.oauthService.onEvent((event) => {
        void this.handleMcpOAuthEvent(this.connectionManager, event).catch((error) => {
          this.log.warn(`session mcp oauth event handling failed: ${String(error)}`);
        });
      }),
    });
    this.ready = this.initialize().catch((error: unknown) => {
      this.log.error('session mcp initial load failed', { error });
    });
  }

  private async handleMcpOAuthEvent(
    manager: McpConnectionManager,
    event: McpOAuthEvent,
  ): Promise<void> {
    if (
      event.type === 'tokens-invalidated' &&
      event.scope !== 'tokens' &&
      event.scope !== 'all'
    ) {
      return;
    }
    const entry = manager.get(event.serverName);
    if (entry === undefined) return;
    const serverUrl = manager.getRemoteServerUrl(event.serverName);
    if (
      serverUrl === undefined ||
      canonicalMcpOAuthResource(serverUrl) !== event.serverUrl
    )
      return;
    if (event.type === 'tokens-invalidated') {
      this.oauthService.forgetProvider(event.serverName, event.serverUrl);
      if (entry.status === 'needs-auth') return;
    }
    if (entry.status === 'disabled' || entry.status === 'removed') return;
    if (entry.status === 'pending') {
      await new Promise<void>((resolve, reject) => {
        let unsubscribe = (): void => {};
        let settled = false;
        const reconnect = (next: McpServerEntry | undefined): void => {
          if (settled) return;
          if (
            next !== undefined &&
            (next.name !== event.serverName || next.status === 'pending')
          ) {
            return;
          }
          settled = true;
          unsubscribe();
          if (
            next === undefined ||
            next.status === 'disabled' ||
            next.status === 'removed'
          ) {
            resolve();
            return;
          }
          void manager.reconnectAfterCurrent(event.serverName).then(resolve, reject);
        };
        unsubscribe = manager.onStatusChange(reconnect);
        if (settled) unsubscribe();
        else reconnect(manager.get(event.serverName));
      });
      return;
    }
    if (
      event.type === 'tokens-saved' &&
      entry.status !== 'needs-auth' &&
      entry.status !== 'failed'
    ) {
      return;
    }
    if (event.type === 'refresh-failed' && entry.status !== 'connected') return;
    await manager.reconnectAndJoin(event.serverName);
  }

  private mutate(work: () => Promise<void>): Promise<void> {
    const tail = this.mutationTail.catch(() => undefined).then(work);
    this.mutationTail = tail;
    return tail;
  }

  private async initialize(): Promise<void> {
    await Promise.all([this.servers.ready, this.identity.resolved()]);
    const configs = Object.fromEntries(
      Object.entries(this.servers.servers()).filter(
        ([name]) => !(name in this.ephemeralServers),
      ),
    );
    if (Object.keys(configs).length === 0) return;
    await this.connectionManager.connectAll({ ...configs });
  }

  private scheduleApply(change: McpServersChange): void {
    void this.ready
      .then(() => this.mutate(() => this.apply(change)))
      .catch((error) => {
        this.log.warn(`session mcp server change apply failed: ${String(error)}`);
      });
  }

  private async apply(change: McpServersChange): Promise<void> {
    for (const name of change.remove) {
      await this.connectionManager.remove(name);
    }
    for (const [name, config] of Object.entries(change.upsert)) {
      if (name in this.ephemeralServers) continue;
      if (config.scope === 'session') {
        await this.connectionManager.connect(name, config);
      } else {
        await this.connectionManager.remove(name);
      }
    }
  }
}

registerScopedService(
  LifecycleScope.Session,
  ISessionMcpService,
  SessionMcpService,
  ScopeActivation.OnScopeCreated,
  'sessionMcp',
);
