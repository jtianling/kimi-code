/**
 * `sessionMcp` domain — Session-scoped per-session MCP subsystem contract.
 *
 * Defines `ISessionMcpService`, the session-level owner of the session's OWN
 * `McpConnectionManager`: it connects exactly the servers that declared
 * `scope: 'session'` in configuration (the set arrives through the seeded
 * `ISessionMcpServers` projection), so servers that bind one connection to
 * one caller identity get an independent connection per session instead of
 * sharing the workspace handler's manager (the `workspaceMcp` domain, which
 * keeps every server with the default workspace scope). The manager — and
 * its stdio child processes, whose cwd is the session's cwd — dies with the
 * session. The exposed shape mirrors `ISessionMcpHandle` so the Agent scope
 * can consume both managers uniformly. Bound at Session scope.
 */

import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';
import type { McpConnectionManager } from '#/mcpCore/connection-manager';

export interface ISessionMcpService {
  readonly _serviceBrand: undefined;

  readonly ready: Promise<void>;

  readonly connectionManager: McpConnectionManager;
}

export const ISessionMcpService: ServiceIdentifier<ISessionMcpService> =
  createDecorator<ISessionMcpService>('sessionMcpService');
