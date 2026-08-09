/**
 * `workspaceMcp` domain — `IWorkspaceMcpService` implementation.
 *
 * Owns the handler-wide `McpConnectionManager` (built at construction,
 * shared by every session of the workspace). This service drives the
 * initial connect from the config domain's snapshot — filtered to servers
 * with the default `scope: 'workspace'`; `scope: 'session'` entries never
 * touch the shared manager and are re-projected through
 * `sessionServersData()` for the `sessionMcp` domain — applies its reconciled
 * change events incrementally (serialized on a mutation tail, always after
 * the initial connect settles — removals tombstone the server via
 * `markRemoved` so live sessions keep the tool registrations but fail calls
 * with a removal notice, while new sessions never see them; an upsert whose
 * scope flipped to `'session'` is handed off to the per-session managers
 * instead), feeds the manager's global timeout defaults
 * from the config domain's tunables at each (re)connect, and reports
 * connection telemetry for the initial load. Every session handle it hands
 * out (`sessionHandle` / `sessionOverlay`) captures a server baseline — the
 * names present when the session materializes, open to additions until the
 * initial connect settles, then closed — so servers that appear mid-session
 * (a plugin install or a config edit, which always land after the initial
 * connect via the mutation tail) never reach the live sessions' tool
 * registries; the next session materialization (`/new`, `/reload`, resume)
 * captures a fresh baseline. It also builds per-session
 * overlays (`sessionOverlay`): a session-owned manager for a session's
 * ephemeral (caller-injected, never persisted) servers — baseline members
 * by construction — presented through a
 * `MergedMcpConnectionView` over the shared manager and shut down by the
 * session lifecycle when the session scope tears down. An overlay handle's
 * baseline still freezes on the workspace manager's initial load — never on
 * the overlay's own connect — so a slow ephemeral connect cannot reopen the
 * window for mid-session workspace additions.
 * An outright initial-load or change-apply failure is logged (per-server
 * failures are status entries). The manager (and its stdio child processes,
 * whose cwd is the handler root) lives as long as the handler — i.e. the
 * process — so a stateful stdio server is shared by concurrent sessions of
 * the workspace rather than owned by one session. Bound at Workspace scope.
 *
 * The client name announced to MCP servers — on initialize and on OAuth
 * dynamic registration — is the identity snapshot's slug. Every manager it
 * builds, the shared one and each session overlay, gates its connects on
 * `identity.resolved()`, so the callback handed to the managers always reads
 * the frozen snapshot: a connection (and the OAuth provider a remote server
 * materializes, cached on the shared service) can never carry a pre-config
 * name.
 */

import { Service } from '#/_base/di/service';
import { LifecycleScope } from '#/app/scopes';
import { ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { Emitter } from '#/_base/event';
import { ILogService } from '#/_base/log/log';

import { McpConnectionManager, type McpConnectionView } from '#/mcpCore/connection-manager';
import type { McpServerConfig } from '#/mcpCore/config-schema';
import { McpOAuthService } from '#/mcpCore/oauth/service';
import { IAgentIdentity } from '#/app/agentIdentity/agentIdentity';
import { IMcpOAuthStore } from '#/app/mcpConfig/oauthStore';
import { ITelemetryService } from '#/app/telemetry/telemetry';
import { MergedMcpConnectionView } from '#/session/mcp/mergedConnectionView';
import type { ISessionMcpHandle } from '#/session/mcp/sessionMcpHandle';
import type { ISessionMcpServers } from '#/session/sessionMcp/sessionMcpServers';
import { IWorkspaceContext } from '#/workspace/workspaceContext/workspaceContext';
import {
  IWorkspaceMcpConfigService,
  type McpServersChange,
} from '#/workspace/workspaceMcpConfig/workspaceMcpConfig';

import {
  IWorkspaceMcpService,
  type ISessionMcpOverlay,
  type SessionMcpOverlayOptions,
} from './workspaceMcp';

export class WorkspaceMcpService extends Service implements IWorkspaceMcpService {
  declare readonly _serviceBrand: undefined;

  private readonly manager: McpConnectionManager;
  private readonly oauthService: McpOAuthService;
  private readonly stdioCwd: string;
  readonly ready: Promise<void>;
  private mutationTail: Promise<void> = Promise.resolve();
  private readonly sessionServersEmitter = this._register(new Emitter<McpServersChange>());
  private readonly resolveClientName = (): string | undefined => this.identity.current().slug;

  constructor(
    @IWorkspaceContext workspace: IWorkspaceContext,
    @IWorkspaceMcpConfigService private readonly mcpConfig: IWorkspaceMcpConfigService,
    @IMcpOAuthStore oauthStore: IMcpOAuthStore,
    @ILogService private readonly log: ILogService,
    @ITelemetryService private readonly telemetry: ITelemetryService,
    @IAgentIdentity private readonly identity: IAgentIdentity,
  ) {
    super();
    this.stdioCwd = workspace.cwd;
    this.oauthService = new McpOAuthService({
      store: oauthStore,
      resolveClientName: this.resolveClientName,
    });
    this.manager = new McpConnectionManager({
      log: this.log,
      oauthService: this.oauthService,
      stdioCwd: this.stdioCwd,
      resolveDefaultTimeouts: () => this.mcpConfig.tunables(),
      resolveClientName: this.resolveClientName,
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
      isBaselineServer: this.sessionBaseline(this.manager, this.ready),
    };
  }

  sessionOverlay(
    servers: Readonly<Record<string, McpServerConfig>>,
    opts?: SessionMcpOverlayOptions,
  ): ISessionMcpOverlay {
    const sessionManager = new McpConnectionManager({
      log: this.log,
      oauthService: this.oauthService,
      stdioCwd: opts?.stdioCwd ?? this.stdioCwd,
      resolveDefaultTimeouts: () => this.mcpConfig.tunables(),
      resolveClientName: this.resolveClientName,
    });
    const connect = Promise.all([this.mcpConfig.ready, this.identity.resolved()])
      .then(() => sessionManager.connectAll({ ...servers }))
      .catch((error: unknown) => {
        this.log.error('session mcp overlay initial load failed', { error });
      });
    const view = new MergedMcpConnectionView(
      this.manager,
      sessionManager,
      new Set(Object.keys(servers)),
    );
    const ready = Promise.all([this.ready, connect]).then(() => undefined);
    return {
      handle: {
        _serviceBrand: undefined,
        ready,
        connectionManager: view,
        // The baseline's lazy window tracks only the workspace manager's
        // initial load: freezing on the combined `ready` would keep it open
        // while a slow ephemeral server connects, and a workspace server
        // added in that window (plugin install, config edit) would leak into
        // the live session through the merged view. Overlay names are known
        // at construction, so they need no window at all.
        isBaselineServer: this.sessionBaseline(this.manager, this.ready, Object.keys(servers)),
      },
      shutdown: () => sessionManager.shutdown(),
    };
  }

  private sessionBaseline(
    view: McpConnectionView,
    ready: Promise<void>,
    extra?: readonly string[],
  ): (name: string) => boolean {
    const baseline = new Set<string>(extra);
    for (const entry of view.list()) {
      baseline.add(entry.name);
    }
    let frozen = false;
    void ready.then(
      () => {
        frozen = true;
      },
      () => {
        frozen = true;
      },
    );
    return (name) => {
      if (baseline.has(name)) return true;
      if (frozen) return false;
      if (view.get(name) === undefined) return false;
      baseline.add(name);
      return true;
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
    await this.identity.resolved();
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
      await this.manager.markRemoved(name);
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
