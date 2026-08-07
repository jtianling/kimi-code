/**
 * `sessionMcp` domain — seeded session-scoped MCP server-set contract.
 *
 * Defines `ISessionMcpServers`, the pure-data injection contract carrying the
 * workspace's effective MCP server set filtered to the entries that declared
 * `scope: 'session'` — a live read view plus the already-filtered change
 * events and the global timeout tunables, all projected from the
 * `workspaceMcpConfig` domain's single source of truth (trust gating and
 * plugin contributions already applied upstream). The contract carries no IO
 * of its own. Session-scoped.
 */

import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';
import type { ScopeSeed } from '#/_base/di/scope';
import type { Event } from '#/_base/event';

import type { McpServerConfig } from '#/mcpCore/config-schema';
import type {
  McpServersChange,
  McpTunables,
} from '#/workspace/workspaceMcpConfig/workspaceMcpConfig';

export interface ISessionMcpServers {
  readonly _serviceBrand: undefined;

  readonly ready: Promise<void>;
  servers(): Readonly<Record<string, McpServerConfig>>;
  tunables(): McpTunables;
  readonly onDidChange: Event<McpServersChange>;
}

export const ISessionMcpServers: ServiceIdentifier<ISessionMcpServers> =
  createDecorator<ISessionMcpServers>('sessionMcpServers');

export function sessionMcpServersSeed(data: ISessionMcpServers): ScopeSeed {
  return [[ISessionMcpServers as ServiceIdentifier<unknown>, data]];
}
