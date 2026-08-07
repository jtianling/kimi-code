/**
 * `workspaceMcp` domain — Workspace-scoped MCP subsystem contract.
 *
 * Defines `IWorkspaceMcpService`, the handler-level owner of the workspace's
 * shared `McpConnectionManager`: connected at handler materialization from
 * the `workspaceMcpConfig` domain's effective server snapshot and
 * incrementally reconciled as its change events arrive. Sessions cannot
 * contribute MCP servers: there is no caller-supplied server channel on
 * session create/resume. The shared manager only ever carries servers with
 * the default `scope: 'workspace'`; every session of the handler receives it
 * through the `ISessionMcpHandle` seed (`sessionHandle()`). Servers that
 * declare `scope: 'session'` are excluded from the shared manager and are
 * instead projected through `sessionServersData()` — the seed source for the
 * `sessionMcp` domain's per-session connections. Bound at Workspace scope.
 */

import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';
import type { McpConnectionManager } from '#/mcpCore/connection-manager';
import type { ISessionMcpHandle } from '#/session/mcp/sessionMcpHandle';
import type { ISessionMcpServers } from '#/session/sessionMcp/sessionMcpServers';

export interface IWorkspaceMcpService {
  readonly _serviceBrand: undefined;

  readonly ready: Promise<void>;

  connectionManager(): McpConnectionManager;

  sessionHandle(): ISessionMcpHandle;

  sessionServersData(): ISessionMcpServers;
}

export const IWorkspaceMcpService: ServiceIdentifier<IWorkspaceMcpService> =
  createDecorator<IWorkspaceMcpService>('workspaceMcpService');
