/**
 * `mcp` domain — seeded MCP shared-handle contract.
 *
 * Defines `ISessionMcpHandle`, the pure-data injection contract carrying the
 * workspace handler's one shared `McpConnectionManager` (servers with the
 * default `scope: 'workspace'` — all sessions of the workspace connect
 * through the same manager) plus the initial-connect readiness promise.
 * Servers that declare `scope: 'session'` are NOT in this manager: they get
 * per-session connections from the `sessionMcp` domain's
 * `ISessionMcpService`, seeded alongside via `ISessionMcpServers`. The
 * contract carries no IO of its own. Session-scoped.
 */

import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';
import type { ScopeSeed } from '#/_base/di/scope';
import type { McpConnectionManager } from '#/mcpCore/connection-manager';

export interface ISessionMcpHandle {
  readonly _serviceBrand: undefined;

  readonly ready: Promise<void>;
  readonly connectionManager: McpConnectionManager;
}

export const ISessionMcpHandle: ServiceIdentifier<ISessionMcpHandle> =
  createDecorator<ISessionMcpHandle>('sessionMcpHandle');

export function sessionMcpHandleSeed(handle: ISessionMcpHandle): ScopeSeed {
  return [[ISessionMcpHandle as ServiceIdentifier<unknown>, handle]];
}
