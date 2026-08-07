/**
 * `sessionMcp` domain — `ISessionMcpService` implementation.
 *
 * Owns the per-session `McpConnectionManager` (built at construction, died at
 * session disposal): drives the initial connect from the seeded
 * `ISessionMcpServers` snapshot, applies its filtered change events
 * incrementally (serialized on a mutation tail, always after the initial
 * connect settles), and feeds the manager's global timeout defaults from the
 * same tunables the workspace side uses. OAuth rides the same App-scope
 * credential store as the workspace manager (`IMcpOAuthStore` → a
 * store-sharing `McpOAuthService`), so tokens are shared while connections
 * stay per-session. Remote header `${VAR}` templates resolve against the
 * per-session env overlay from `sessionProcessEnv` (overlay wins) layered
 * over `process.env`, so session-scoped connections can send identity
 * headers like `X-Kimi-Session-Id`. With no session-scoped servers
 * configured the service idles with zero connections, keeping the
 * Agent-scope injection always resolvable. Bound at Session scope.
 */

import { Disposable } from '#/_base/di/lifecycle';
import { LifecycleScope, ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { ILogService } from '#/_base/log/log';

import { IMcpOAuthStore } from '#/app/mcpConfig/oauthStore';
import { McpConnectionManager } from '#/mcpCore/connection-manager';
import { McpOAuthService } from '#/mcpCore/oauth/service';
import { sessionProcessEnv } from '#/session/process/sessionProcessEnv';
import { ISessionContext } from '#/session/sessionContext/sessionContext';
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
    @IMcpOAuthStore oauthStore: IMcpOAuthStore,
    @ILogService private readonly log: ILogService,
  ) {
    super();
    const oauthService = new McpOAuthService({ store: oauthStore });
    const sessionEnv = sessionProcessEnv(sessionContext.sessionId);
    this.connectionManager = new McpConnectionManager({
      log: this.log,
      oauthService,
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
    this.ready = this.initialize().catch((error: unknown) => {
      this.log.error('session mcp initial load failed', { error });
    });
  }

  private mutate(work: () => Promise<void>): Promise<void> {
    const tail = this.mutationTail.catch(() => undefined).then(work);
    this.mutationTail = tail;
    return tail;
  }

  private async initialize(): Promise<void> {
    await this.servers.ready;
    const configs = this.servers.servers();
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
      if (config.scope === 'session') {
        await this.connectionManager.connect(name, config);
      } else {
        // The seed projection forwards non-session upserts as removals (a
        // scope flip away from 'session'); defense in depth if one slips
        // through.
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
